import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdeError } from '../journal/errors.ts'

/**
 * Resolve uma ref `art:<rel>` para o caminho absoluto de `<missionDir>/artifacts/<rel>.log`,
 * recusando qualquer ref que não case o formato esperado ou que tente escapar de artifacts.
 *
 * @param {string} missionDir
 * @param {string} ref
 * @returns {string}
 */
export function resolveRef(missionDir, ref) {
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

/**
 * @param {string[]} argv
 * @returns {{ ref: string|null, open: boolean, missionArg: string|null }}
 */
function parseArgs(argv) {
  let ref = null
  let open = false
  let missionArg = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') {
      open = true
    } else if (a === '--mission') {
      i++
      missionArg = argv[i] ?? null
    } else if (ref === null) {
      ref = a
    }
  }

  return { ref, open, missionArg }
}

/**
 * Comando do abridor do sistema para o arquivo apontado. No Windows usa `explorer.exe` direto,
 * sem passar pelo `cmd`, para que metacaracteres do caminho (&, |, ^, %) nunca virem comando.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} p
 * @returns {{ command: string, args: string[] }}
 */
export function openerCommand(platform, p) {
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
 *
 * @param {string} p
 * @returns {void}
 */
function defaultOpener(p) {
  const { command, args } = openerCommand(process.platform, p)
  const child = spawn(command, args, { stdio: 'ignore', shell: false, detached: true, windowsHide: true })
  child.on('error', (err) => {
    process.stderr.write(`falha ao abrir ${p}: ${err.message}\n`)
  })
  child.unref()
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string,string|undefined>, stdout?: {write: (s: string) => void}, stderr?: {write: (s: string) => void}, opener?: (p: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const opener = deps.opener ?? defaultOpener

  const { ref, open, missionArg } = parseArgs(argv)
  const missionDir = missionArg ?? env.ADE_MISSION_DIR

  if (!missionDir) {
    stderr.write('missão ausente: use --mission\n')
    return 2
  }

  let filePath
  try {
    filePath = resolveRef(missionDir, /** @type {string} */ (ref))
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
