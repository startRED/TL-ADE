// Isolamento das chamadas ao `claude` sem `--safe-mode` (ADR 0044, emenda os ADRs 0009 e 0011). O `--safe-mode`
// desligava também o que o projeto traz: skills em `.claude/skills`, CLAUDE.md/AGENTS.md, hooks do projeto e as skills
// nativas de receita (`run`, `verify`). Aqui só a configuração do operador fica de fora: plugins, hooks, MCP e
// instruções do usuário, auto memory e qualquer CLAUDE.md das pastas acima da cópia.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorkerEnv } from '../../runner/spawn.ts'

/** Arquivos de instrução que o Claude Code lê subindo as pastas acima do cwd, mesmo passando da raiz do repositório. */
const ANCESTOR_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md', '.claude/rules/**']

/**
 * A auto memory é uma por repositório e as worktrees a compartilham: sem isto o maker lia a memória do operador. Os
 * conectores do claude.ai já ficam fora pelo `--strict-mcp-config`; a variável é a segunda trava.
 */
export const CLAUDE_ISOLATION_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } as const

/** Extras do ambiente fechado do worker para o `claude`: as travas e a pasta de configuração (onde fica o login). */
export function claudeEnvExtras(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return { ...CLAUDE_ISOLATION_ENV, ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}) }
}

/** Ambiente completo para quem abre o `claude` sem `runWorker` (juiz, chat, sonda de cota): o mesmo do motor. */
export function claudeWorkerEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return buildWorkerEnv(claudeEnvExtras(env))
}

const DRIVE = /^([a-z]):\//i

/**
 * Configuração da chamada: nenhuma instrução de pasta acima do cwd (a cópia de trilho, sob ~/.ade/lanes, carregava o
 * ~/.claude/CLAUDE.md do operador) e auto memory desligada. As instruções da própria cópia continuam valendo.
 */
export function isolationSettings(cwd: string): { claudeMdExcludes: string[]; autoMemoryEnabled: false } {
  const excludes: string[] = []
  const start = path.resolve(cwd)
  let dir = path.dirname(start)
  if (dir !== start) {
    for (;;) {
      for (const f of ANCESTOR_FILES) {
        const p = path.join(dir, f).split(path.sep).join('/')
        excludes.push(p)
        // o glob casa por texto e a letra da unidade chega em maiúscula ou minúscula conforme quem abriu o processo
        const m = DRIVE.exec(p)
        if (m) {
          const other = (m[1] === m[1].toUpperCase() ? m[1].toLowerCase() : m[1].toUpperCase()) + p.slice(1)
          excludes.push(other)
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return { claudeMdExcludes: excludes, autoMemoryEnabled: false }
}

/**
 * Grava a configuração num arquivo por cwd e devolve o caminho. Arquivo, não JSON no argv: com uma lista por pasta
 * ancestral o argv chegaria perto do teto de 32.767 caracteres do Windows (a mesma razão do pack em arquivo, ADR 0011).
 */
// ponytail: um arquivo pequeno por cópia fica no tmp do sistema; limpar no `ade gc` se a pasta crescer
export function writeIsolationSettings(cwd: string, dir: string = path.join(os.tmpdir(), 'ade-claude')): string {
  const body = JSON.stringify(isolationSettings(cwd))
  const file = path.join(dir, `${crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`)
  try {
    if (fs.readFileSync(file, 'utf8') === body) return file
  } catch {
    // ainda não existe
  }
  fs.mkdirSync(dir, { recursive: true })
  // gravação atômica: trilhos paralelos podem pedir o mesmo arquivo enquanto uma CLI já o lê
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    if (fs.readFileSync(file, 'utf8') !== body) throw err
  }
  return file
}

/**
 * Flags da chamada. `project` carrega a configuração do repositório (skills, hooks, CLAUDE.md/AGENTS.md); `none` não
 * carrega nenhuma, para chamadas que não trabalham no projeto (juiz visual, leitura de cota). O MCP fica só o que o
 * motor passar em `--mcp-config`, e as seções que mudam por máquina saem do prompt de sistema para o cache valer entre
 * cópias.
 */
export function isolationArgs(settingsPath: string, sources: 'project' | 'none' = 'project'): string[] {
  return ['--setting-sources', sources === 'project' ? 'project' : '', '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections', '--settings', settingsPath]
}

type InitEvent = { plugins?: Array<{ name?: string; source?: string }>; mcp_servers?: Array<{ name?: string } | string>; skills?: string[]; agents?: string[]; slash_commands?: string[] } | null | undefined

function ownNames(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).map((n) => n.replace(/\.md$/i, '')))
  } catch {
    return new Set()
  }
}

/**
 * O que é do operador e apareceu no `system/init` de uma chamada isolada: plugins que não são embutidos, qualquer MCP
 * (a sonda não passa nenhum), skills sincronizadas da conta e skills, agentes e comandos da pasta de configuração do
 * usuário. Instruções e memória não aparecem no init; elas ficam cobertas pelas flags e pelos testes deste módulo.
 */
// ponytail: skill do usuário com o nome de uma nativa (run, verify) acusa falso vazamento; renomear a do usuário
export function isolationLeaks(init: InitEvent, configDir: string): string[] {
  if (!init) return ['sem evento system/init na sonda']
  const leaks: string[] = []
  for (const p of init.plugins ?? []) if (!String(p.source ?? '').endsWith('@builtin')) leaks.push(`plugin ${p.source ?? p.name}`)
  for (const m of init.mcp_servers ?? []) leaks.push(`MCP ${typeof m === 'string' ? m : m.name}`)
  const skills = ownNames(path.join(configDir, 'skills'))
  for (const s of init.skills ?? []) if (skills.has(s) || s.startsWith('anthropic-skills:')) leaks.push(`skill ${s}`)
  const agents = ownNames(path.join(configDir, 'agents'))
  for (const a of init.agents ?? []) if (agents.has(a)) leaks.push(`agente ${a}`)
  const commands = ownNames(path.join(configDir, 'commands'))
  for (const c of init.slash_commands ?? []) if (commands.has(c) && !skills.has(c)) leaks.push(`comando ${c}`)
  return leaks
}
