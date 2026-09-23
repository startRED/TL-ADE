import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGitPort } from '../git/gitport.ts'
import type { GitPort } from '../git/gitport.ts'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { safeId } from '../gates/output.ts'
import { isModelCallTelemetry } from '../telemetry/telemetry.ts'
import { provenanceOfCommit } from '../telemetry/cost.ts'

/**
 * Resolve uma ref `art:<rel>` para o caminho absoluto de `<missionDir>/artifacts/<rel>.log`,
 * recusando qualquer ref que não case o formato esperado ou que tente escapar de artifacts.
 */
export function resolveRef(missionDir: string, ref: string): string {
  if (typeof missionDir !== 'string' || !missionDir) {
    throw new AdeError('invalid_argument', 'missão inválida', 2)
  }
  if (typeof ref !== 'string' || !/^art:[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new AdeError('invalid_argument', `ref inválida: ${ref}`, 2)
  }

  const rel = ref.slice('art:'.length)
  const segments = rel.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new AdeError('invalid_argument', `ref inválida: ${ref}`, 2)
  }

  const artifactsDir = path.resolve(missionDir, 'artifacts')
  const filePath = path.join(artifactsDir, ...segments) + '.log'

  const relCheck = path.relative(artifactsDir, filePath)
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new AdeError('invalid_argument', `ref inválida: ${ref}`, 2)
  }

  return filePath
}

function parseArgs(argv: string[]): { ref: string | null; open: boolean; missionArg: string | null; commit: string | null } {
  let ref = null
  let open = false
  let missionArg = null
  let commit = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') {
      open = true
    } else if (a === '--mission') {
      i++
      missionArg = argv[i] ?? null
    } else if (a === '--commit') {
      i++
      commit = argv[i] ?? ''
    } else if (ref === null) {
      ref = a
    }
  }

  return { ref, open, missionArg, commit }
}

/**
 * Pack enviado a uma chamada do maker. A rodada 1 (e as tentativas dela) usa o pack montado com o
 * passo `<parte>:r1:maker`; a correção monta o próprio pack como `<parte>:<tag>:pack` (src/engine.ts).
 */
function makerPackPath(missionDir: string, stepId: string): string {
  const tag = stepId.split(':').at(-2) ?? ''
  const packStep = /^r1(t\d+)?$/.test(tag) ? stepId.replace(/:[^:]+:maker$/, ':r1:maker') : stepId.replace(/:maker$/, ':pack')
  return path.join(missionDir, 'artifacts', 'packs', safeId(packStep), 'pack.md')
}

/**
 * Conversa de um commit do motor: os trailers ADE apontam a missão e a chamada do maker no journal;
 * mostra o cabeçalho, o pack enviado e a resposta gravada, e diz qual artefato falta.
 */
async function showCommit(sha: string, repoDir: string, git: Pick<GitPort, 'run'>): Promise<string> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new AdeError('invalid_argument', `sha inválido: ${sha}`, 2)
  const log = await git.run(['show', '-s', '--format=%B', sha], { maxBuffer: 1 << 20, okCodes: [0, 128] })
  if (log.code !== 0) throw new AdeError('commit_not_found', `commit não encontrado: ${sha}`, 1)
  const origin = provenanceOfCommit(log.text)
  if (!origin) throw new AdeError('not_engine_commit', `o commit ${sha} não foi feito pelo motor (sem rodapé ADE-Missao)`, 1)

  const missionDir = path.join(repoDir, '.ade', 'missions', origin.mission)
  const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
  const lines = [`missão: ${origin.mission}`, `parte: ${origin.story}`, `rodada: ${origin.round}`, `modelo: ${origin.model}`, `chamada: ${origin.callSeq}`]
  const call = events.find((e) => e.seq === origin.callSeq)
  if (!call || !isModelCallTelemetry(call) || call.data.role !== 'maker') {
    lines.push(`pacote enviado: ausente (chamada ${origin.callSeq} do maker não está no journal)`, 'resposta gravada: ausente (sem a chamada, não há resposta a ler)')
    return lines.join('\n') + '\n'
  }
  const stepId = String(call.data.step_id)
  const packPath = makerPackPath(missionDir, stepId)
  if (existsSync(packPath)) lines.push(`--- pacote enviado (${packPath}) ---`, readFileSync(packPath, 'utf8').trimEnd())
  else lines.push(`pacote enviado: ausente (${packPath})`)
  const response = events.filter((e) => e.kind === 'step_result' && e.step_id === stepId && e.status === 'ok' && Number(e.seq) < origin.callSeq).at(-1)
  // o journal guarda o que não é campo do envelope dentro de `data`
  if (response) lines.push(`--- resposta gravada (${stepId}) ---`, JSON.stringify(response.data?.result, null, 2))
  else lines.push(`resposta gravada: ausente (sem step_result ok de ${stepId} no journal)`)
  return lines.join('\n') + '\n'
}

/**
 * Comando do abridor do sistema para o arquivo apontado. No Windows usa `explorer.exe` direto,
 * sem passar pelo `cmd`, para que metacaracteres do caminho (&, |, ^, %) nunca virem comando.
 */
export function openerCommand(platform: NodeJS.Platform, p: string): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'explorer.exe', args: [p] }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [p] }
  }
  return { command: 'xdg-open', args: [p] }
}

/**
 * Abridor padrão do sistema operacional para o arquivo apontado.
 */
function defaultOpener(p: string): void {
  const { command, args } = openerCommand(process.platform, p)
  const child = spawn(command, args, { stdio: 'ignore', shell: false, detached: true, windowsHide: true })
  child.on('error', (err) => {
    process.stderr.write(`falha ao abrir ${p}: ${err.message}\n`)
  })
  child.unref()
}

export async function main(argv: string[], deps: { env?: Record<string, string | undefined>; stdout?: { write: (s: string) => void }; stderr?: { write: (s: string) => void }; opener?: (p: string) => void; cwd?: string; gitPortFor?: (dir: string) => Pick<GitPort, 'run'> } = {}): Promise<number> {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const opener = deps.opener ?? defaultOpener

  const { ref, open, missionArg, commit } = parseArgs(argv)
  if (commit !== null) {
    const repoDir = deps.cwd ?? process.cwd()
    try {
      stdout.write(await showCommit(commit, repoDir, (deps.gitPortFor ?? ((dir) => createGitPort({ worktreeDir: dir })))(repoDir)))
      return 0
    } catch (err) {
      if (err instanceof AdeError) {
        stderr.write(err.message + '\n')
        return err.exitCode
      }
      throw err
    }
  }
  const missionDir = missionArg ?? env.ADE_MISSION_DIR

  if (!missionDir) {
    stderr.write('missão ausente: use --mission\n')
    return 2
  }

  let filePath
  try {
    filePath = resolveRef(missionDir, (ref as string))
  } catch (err) {
    if (err instanceof AdeError) {
      stderr.write(err.message + '\n')
      return err.exitCode
    }
    throw err
  }

  if (!existsSync(filePath)) {
    stderr.write(`ref não encontrada: ${ref}\n`)
    return 1
  }

  const content = readFileSync(filePath, 'utf8')
  stdout.write(content)

  if (open) {
    opener(filePath)
  }

  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
