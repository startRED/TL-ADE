// Pasta do Codex só do motor (ADR 0045). O Codex lê $CODEX_HOME/AGENTS.md, as instruções globais do usuário, mesmo com
// `--ignore-user-config`, e não tem chave que desligue isso; `project_doc_max_bytes` só vale para o AGENTS.md do projeto.
// Medido em 2026-09-26: o revisor da missão recebia as preferências pessoais do operador. A pasta do motor tem só o
// login, ligado por hardlink ao do usuário: o Codex renova o token gravando no próprio arquivo (truncate + write, sem
// rename), então os dois lados veem a renovação e nenhum fica com o refresh token velho.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type HomeOpts = { realHome?: string; engineHome?: string }

function defaults(opts: HomeOpts): { realHome: string; engineHome: string } {
  return {
    realHome: opts.realHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
    engineHome: opts.engineHome ?? path.join(process.env.ADE_HOME ?? os.homedir(), '.ade', 'codex-home'),
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a, { bigint: true })
    const y = fs.statSync(b, { bigint: true })
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/**
 * Devolve a pasta do motor com o login ligado ao do usuário, ou null quando não há `auth.json` para ligar (login no
 * keyring) ou o link falha (pastas em volumes diferentes). Com null a chamada usa a pasta do usuário e o doctor avisa.
 */
export function isolatedCodexHome(opts: HomeOpts = {}): string | null {
  const { realHome, engineHome } = defaults(opts)
  const real = path.join(realHome, 'auth.json')
  const link = path.join(engineHome, 'auth.json')
  if (!fs.existsSync(real)) return null
  if (sameFile(real, link)) return engineHome
  fs.mkdirSync(engineHome, { recursive: true })
  // link de um login que o usuário trocou (logout e login criam arquivo novo)
  fs.rmSync(link, { force: true })
  try {
    fs.linkSync(real, link)
  } catch {
    // outro trilho ligou no mesmo instante: vale se for o mesmo arquivo
  }
  return sameFile(real, link) ? engineHome : null
}

/** Variável para o ambiente das chamadas ao Codex; vazio quando não há pasta do motor. */
export function codexEnvExtras(opts: HomeOpts = {}): Record<string, string> {
  const home = isolatedCodexHome(opts)
  return home ? { CODEX_HOME: home } : {}
}
