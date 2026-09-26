import { spawn } from 'node:child_process'
import { assertArgvLimit, buildArgv, resolveBinary } from '../../runner/resolve-binary.ts'
import type { ChatAgent, ChatAgentInput } from './chat.ts'
import { claudeWorkerEnv, isolationArgs, writeIsolationSettings } from '../../adapters/claude/isolation.ts'
import { codexEnvExtras } from '../../adapters/codex/home.ts'
import { agyEnvExtras } from '../../adapters/agy/home.ts'

const MAX_OUTPUT = 16 * 1024 * 1024
const TIMEOUT_MS = 15 * 60 * 1000

function intro({ cwd, history, prompt, context }: ChatAgentInput): string {
  const past = history.slice(-8).map((t) => `${t.role === 'user' ? 'Usuário' : 'Assistente'}: ${t.text.slice(0, 1500)}`).join('\n')
  return [
    'Você é o assistente de conversa da TL-ADE. Responda em português, direto e curto.',
    `Você está numa cópia isolada do projeto (${cwd}); pode criar e alterar arquivos dela, e suas mudanças viram uma proposta que a pessoa aprova ou recusa.`,
    'Não rode comandos que alterem o projeto (instalar pacote, git) e não faça commit. Ao mudar arquivos, comece a resposta com uma linha curta dizendo o que mudou.',
    context,
    past && `Conversa até aqui:\n${past}`,
    `Pergunta: ${prompt}`,
  ].filter(Boolean).join('\n\n')
}

/** Comando de cada empresa com o prompt pela entrada padrão (o agy só aceita por argumento). */
function command(input: ChatAgentInput, prompt: string): { cmd: string; args: string[]; stdin?: string } {
  const model = input.model ? ['--model', input.model] : []
  if (input.family === 'codex') {
    const effort = input.effort ? ['-c', `model_reasoning_effort=${input.effort}`] : []
    return { cmd: 'codex', args: ['exec', '-', '--color', 'never', '--sandbox', 'workspace-write', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', ...effort, ...model], stdin: prompt }
  }
  if (input.family === 'agy') return { cmd: 'agy', args: [`--print=${prompt.replace(/\r?\n/g, ' ')}`, ...model, '--dangerously-skip-permissions'] }
  const effort = input.effort ? ['--effort', input.effort] : []
  return {
    cmd: 'claude',
    // sem isolamento o chat carregava plugins, hooks e instruções pessoais do operador (modos de estilo, MCP)
    args: ['-p', '--output-format', 'text', ...isolationArgs(writeIsolationSettings(input.cwd)), '--no-session-persistence', '--max-turns', '20', '--permission-mode', 'acceptEdits', '--tools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', ...effort, ...model],
    stdin: prompt,
  }
}

/** Agente padrão do chat: a CLI da empresa escolhida, sem shell, na cópia do projeto. */
export const defaultChatAgent: ChatAgent = (input) => {
  const { cmd, args, stdin } = command(input, intro(input))
  const resolved = resolveBinary(cmd)
  const argv = buildArgv(resolved, args)
  assertArgvLimit(resolved.exe, argv)
  return new Promise((resolve, reject) => {
    const env = cmd === 'claude' ? claudeWorkerEnv() : cmd === 'codex' ? { ...process.env, ...codexEnvExtras() } : { ...process.env, ...agyEnvExtras() }
    const child = spawn(resolved.exe, argv, { cwd: input.cwd, shell: false, windowsHide: true, timeout: TIMEOUT_MS, env })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      out += c
      if (out.length > MAX_OUTPUT) child.kill()
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err = (err + c).slice(-4000) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && out.length <= MAX_OUTPUT) resolve({ text: out.trim() })
      else reject(new Error(`${cmd} saiu com ${code}: ${err.trim().split(/\r?\n/).at(-1) ?? ''}`))
    })
    child.stdin.end(stdin ?? '')
  })
}
