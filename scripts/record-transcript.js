import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AdeError } from '../src/journal/errors.js'
import { buildArgv, resolveBinary } from '../src/runner/resolve-binary.js'
import { buildClaudeArgs } from '../src/adapters/claude/argv.js'

const NAME_RE = /^[a-z0-9_]+$/

const TEMP_PACK_INSTRUCTION =
  'Preencha o unit-result com format_version 1, story_id "rec-ok", state "done", phase "make", ' +
  'round 1, tree_before "0", tree_after "0", eval_records [], gate_records [], passes true, ' +
  'reason "gravacao", sources []'

/**
 * Roda o executável resolvido com `--version` e devolve a saída aparada. Falha ao iniciar, sinal,
 * código != 0 ou saída vazia é falha de ambiente.
 *
 * @param {{exe: string, prefixArgs: string[]}} resolved
 * @returns {string}
 */
function defaultVersionImpl(resolved) {
  const res = spawnSync(resolved.exe, [...resolved.prefixArgs, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 1 << 20,
  })
  const version = (res.stdout ?? '').trim()
  if (res.error || res.signal !== null || res.status !== 0 || version === '') {
    const detail = res.error ? res.error.message : 'status ' + res.status + ', sinal ' + res.signal
    throw new AdeError('binary_not_found', resolved.exe + ' --version falhou: ' + detail, 1)
  }
  return version
}

/**
 * Executa o binário resolvido com os args do pack de gravação, capturando stdout/stderr como Buffer.
 *
 * @param {{exe: string, prefixArgs: string[]}} resolved
 * @param {string[]} claudeArgs
 * @returns {Promise<{ argv: string[], stdout: Buffer, stderr: Buffer, exitCode: number }>}
 */
function spawnRecording(resolved, claudeArgs) {
  const argv = buildArgv(resolved, claudeArgs)

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.exe, argv, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    /** @type {Buffer[]} */
    const stdoutChunks = []
    /** @type {Buffer[]} */
    const stderrChunks = []

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    child.once('error', (err) => {
      reject(new AdeError('binary_not_found', 'falha ao iniciar ' + resolved.exe + ': ' + err.message, 1))
    })
    child.once('close', (code) => {
      resolve({
        argv,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: typeof code === 'number' ? code : 1,
      })
    })
    child.stdin.end()
  })
}

/**
 * Grava um transcript real do `claude` em `<outDir>/<name>/` com os seis arquivos exigidos.
 *
 * @param {{
 *   name: string,
 *   outDir: string,
 *   maxBudgetUsd: number,
 *   model: string,
 *   resolved?: {exe: string, prefixArgs: string[]},
 *   versionImpl?: () => string,
 *   now?: () => string,
 * }} opts
 * @returns {Promise<{ dir: string, exitCode: number }>}
 */
export async function recordTranscript(opts) {
  const { name, outDir, maxBudgetUsd, model, resolved: resolvedOpt, versionImpl, now } = opts ?? {}

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new AdeError('invalid_argument', 'name inválido', 2)
  }
  if (typeof outDir !== 'string' || outDir === '') {
    throw new AdeError('invalid_argument', 'outDir inválido', 2)
  }
  if (typeof model !== 'string' || model === '') {
    throw new AdeError('invalid_claude_args', 'model inválido', 2)
  }

  const dir = path.join(outDir, name)
  if (existsSync(dir)) {
    throw new AdeError('transcript_exists', 'transcript já existe: ' + dir, 2)
  }

  const resolved = resolvedOpt ?? resolveBinary('claude')
  const version = versionImpl ?? (() => defaultVersionImpl(resolved))
  const nowImpl = now ?? (() => new Date().toISOString())

  const cliVersion = version()

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ade-record-transcript-'))
  const sessionId = randomUUID()
  /** @type {{ argv: string[], stdout: Buffer, stderr: Buffer, exitCode: number }} */
  let run
  try {
    const packPath = path.join(tmpDir, 'pack.md')
    writeFileSync(packPath, TEMP_PACK_INSTRUCTION, 'utf8')
    const claudeArgs = buildClaudeArgs({ sessionId, packPath, maxBudgetUsd, model })
    run = await spawnRecording(resolved, claudeArgs)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  const { argv, stdout, stderr, exitCode } = run

  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(argv, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(dir, 'stdin.txt'), '', 'utf8')
  writeFileSync(path.join(dir, 'stdout.json'), stdout)
  writeFileSync(path.join(dir, 'stderr.txt'), stderr)
  writeFileSync(path.join(dir, 'exit.txt'), exitCode + '\n', 'utf8')
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      { name, cli_version: cliVersion, model, recorded_at: nowImpl(), session_id: sessionId },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  return { dir, exitCode }
}

/**
 * @param {string[]} argv
 * @returns {{ name: string|null, maxBudgetUsd: string|null, model: string|null }}
 */
function parseArgs(argv) {
  let name = null
  let maxBudgetUsd = null
  let model = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') {
      name = argv[++i] ?? null
    } else if (a === '--max-budget-usd') {
      maxBudgetUsd = argv[++i] ?? null
    } else if (a === '--model') {
      model = argv[++i] ?? null
    }
  }

  return { name, maxBudgetUsd, model }
}

/**
 * @param {string[]} argv
 * @param {{ stderr?: {write: (s: string) => void}, outDir?: string }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr
  const { name, maxBudgetUsd, model } = parseArgs(argv)

  if (!name || !maxBudgetUsd || !model) {
    stderr.write('uso: record-transcript --name <n> --max-budget-usd <v> --model <m>\n')
    return 2
  }

  const outDir = deps.outDir ?? fileURLToPath(new URL('../fixtures/transcripts/claude/', import.meta.url))

  try {
    const result = await recordTranscript({
      name,
      outDir,
      maxBudgetUsd: Number(maxBudgetUsd),
      model,
    })
    if (result.exitCode !== 0) {
      stderr.write('claude saiu com código ' + result.exitCode + '\n')
      return 1
    }
    return 0
  } catch (err) {
    if (err instanceof AdeError) {
      stderr.write(err.message + '\n')
      return err.exitCode
    }
    throw err
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
