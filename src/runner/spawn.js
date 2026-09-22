import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { getProcessStartTime } from '../lease/process-info.js'
import {
  chargeOf,
  receiptPath,
  startingReceipt,
  withRunning,
  withTerminal,
  writeReceipt,
} from './receipt.js'
import { assertArgvLimit } from './resolve-binary.js'

/**
 * Allowlist fechada de variáveis de ambiente do worker.
 */
export const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
]

const BLOCKED_ENV_PREFIXES =
  /^(ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AWS_|GH_|GITHUB_|NPM_TOKEN|CLAUDE_CODE_OAUTH)/

/**
 * Monta as variáveis de ambiente do worker a partir da allowlist e de extras filtrados.
 *
 * @param {Record<string, string>} [extras]
 * @returns {Record<string, string>}
 */
export function buildWorkerEnv(extras = {}) {
  /** @type {Record<string, string>} */
  const env = {}

  for (const key of WORKER_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }

  if (extras && typeof extras === 'object') {
    for (const [key, value] of Object.entries(extras)) {
      if (!BLOCKED_ENV_PREFIXES.test(key) && value !== undefined) {
        env[key] = String(value)
      }
    }
  }

  env.DO_NOT_TRACK = '1'
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

  return env
}

/**
 * Encerra forçadamente a árvore de processos do worker.
 *
 * @param {number} pid
 * @param {{
 *   platform?: string,
 *   execFileSync?: Function,
 *   child?: { kill?: Function }
 * }} [deps]
 * @returns {{ terminated_by: 'taskkill' | 'job_fallback' | 'already_exited' | 'sigkill' }}
 */
export function killTree(
  pid,
  { platform = process.platform, execFileSync: exec = execFileSync, child } = {},
) {
  if (platform === 'win32') {
    try {
      exec('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        maxBuffer: 1 << 26,
        stdio: 'ignore',
      })
      return { terminated_by: 'taskkill' }
    } catch (err) {
      const errorObj = /** @type {any} */ (err)
      if (errorObj?.code === 'EPERM') {
        if (typeof child?.kill === 'function') {
          child.kill('SIGKILL')
          return { terminated_by: 'job_fallback' }
        }
        throw err
      }
      const msg = `${errorObj?.message ?? ''} ${errorObj?.stderr ?? ''}`
      const isNotExist =
        errorObj?.status === 128 ||
        /not found|não encontrado|não foi encontrado|nenhum processo|não existe/i.test(msg)
      if (isNotExist) {
        return { terminated_by: 'already_exited' }
      }
      throw err
    }
  } else {
    if (child) {
      child?.kill?.('SIGKILL')
      return { terminated_by: 'sigkill' }
    }
    return { terminated_by: 'already_exited' }
  }
}

/** PIDs dos workers vivos deste processo, para o encerramento por sinal alcançar a árvore. */
const ACTIVE_WORKER_PIDS = new Set()

/** @returns {number[]} */
export function activeWorkerPids() {
  return [...ACTIVE_WORKER_PIDS]
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM'
  }
}

/**
 * Espera o processo sair sozinho até `timeoutMs`; vencido o prazo, encerra a árvore por
 * `killTree` (taskkill /T /F no Windows). Falha do encerramento volta no resultado para ser
 * registrada, nunca decidida por pty.kill().
 *
 * @param {{
 *   pid: number,
 *   platform?: string,
 *   timeoutMs: number,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   execFileSync?: Function,
 *   kill?: (pid: number, signal: string) => void,
 * }} input
 * @returns {Promise<{ pid: number, platform: string, cooperative: boolean, terminated_by: string, waited_ms: number, error?: string }>}
 */
export async function terminateProcessTree({
  pid,
  platform = process.platform,
  timeoutMs,
  isAlive = processAlive,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  execFileSync: exec = execFileSync,
  kill = (target, signal) => process.kill(target, signal),
}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid inválido')
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs inválido')
  }
  const start = now()
  while (isAlive(pid)) {
    const waited = now() - start
    if (waited >= timeoutMs) {
      try {
        const { terminated_by } = killTree(pid, {
          platform,
          execFileSync: exec,
          // No Windows só taskkill decide; o fallback por sinal fica para as demais plataformas.
          child: platform === 'win32' ? undefined : { kill: (/** @type {string} */ signal) => kill(pid, signal) },
        })
        return { pid, platform, cooperative: false, terminated_by, waited_ms: waited }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        return { pid, platform, cooperative: false, terminated_by: 'failed', waited_ms: waited, error }
      }
    }
    await sleep(Math.min(100, timeoutMs - waited))
  }
  return { pid, platform, cooperative: true, terminated_by: 'cooperative_exit', waited_ms: now() - start }
}

/**
 * @typedef {Object} RunWorkerResult
 * @property {'exited' | 'timeout' | 'crashed' | 'start_failed'} state
 * @property {'exit' | 'timeout' | 'dead_man' | 'spawn_error'} reason
 * @property {number | null} exitCode
 * @property {number | null} exit_code
 * @property {number | null} pid
 * @property {'released' | 'charged'} charge
 * @property {'environment' | null} failureClass
 * @property {string} receiptFile
 * @property {string} receipt_path
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 */

/**
 * @typedef {Object} RunWorkerOptions
 * @property {{ exe: string, prefixArgs: string[], mode?: string, via?: string }} resolved
 * @property {string[]} [args]
 * @property {string} cwd
 * @property {string} missionDir
 * @property {string} missionId
 * @property {string} stepId
 * @property {import('./receipt.js').SpawnRequest} request
 * @property {number} [timeoutS]
 * @property {string} [heartbeatPath]
 * @property {number} [heartbeatTimeoutS]
 * @property {Record<string, string>} [env]
 * @property {string} [stdinData] conteúdo entregue ao processo pela entrada padrão (prompt/pack)
 * @property {() => string} [now]
 * @property {Function} [spawnImpl]
 * @property {(pid: number) => Promise<string | null>} [getStartTime]
 */

/**
 * Executa um worker contido com env filtrado, recibo durável e vigias de timeout/heartbeat.
 *
 * @param {RunWorkerOptions} options
 * @returns {Promise<RunWorkerResult>}
 */
export async function runWorker(options) {
  const {
    resolved,
    args = [],
    cwd,
    missionDir,
    missionId,
    stepId,
    request,
    timeoutS,
    heartbeatPath,
    heartbeatTimeoutS,
    env = {},
    stdinData,
    now = () => new Date().toISOString(),
    spawnImpl = spawn,
    getStartTime = getProcessStartTime,
  } = options

  if (timeoutS !== undefined) {
    if (typeof timeoutS !== 'number' || !Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new TypeError('timeoutS inválido')
    }
  }

  if (stdinData !== undefined && typeof stdinData !== 'string') {
    throw new TypeError('stdinData inválido')
  }

  if (heartbeatTimeoutS !== undefined) {
    if (
      typeof heartbeatTimeoutS !== 'number' ||
      !Number.isFinite(heartbeatTimeoutS) ||
      heartbeatTimeoutS <= 0
    ) {
      throw new TypeError('heartbeatTimeoutS inválido')
    }
  }

  const launchArgs = [...resolved.prefixArgs, ...(args ?? [])]
  assertArgvLimit(resolved.exe, launchArgs)

  const file = receiptPath(missionDir, stepId)
  const base = startingReceipt({ missionId, stepId, request, now })
  writeReceipt(file, base)

  const childEnv = buildWorkerEnv(env)

  return new Promise((resolve) => {
    const startMs = Date.now()
    /** @type {import('./receipt.js').Receipt} */
    let currentReceipt = base
    let finalizado = false
    /** @type {NodeJS.Timeout | null} */
    let timeoutTimer = null
    /** @type {NodeJS.Timeout | null} */
    let heartbeatTimer = null
    /** @type {'timeout' | 'dead_man' | null} */
    let triggeredReason = null
    /** @type {string[]} */
    const stdoutChunks = []
    /** @type {string[]} */
    const stderrChunks = []
    /** @type {Promise<import('./receipt.js').Receipt> | null} */
    let runningReceiptPromise = null

    /**
     * @param {'exited' | 'timeout' | 'crashed' | 'start_failed'} state
     * @param {'exit' | 'timeout' | 'dead_man' | 'spawn_error'} reason
     * @param {number | null} exitCode
     * @param {'environment' | null} failureClass
     * @param {number | null} pid
     */
    async function finalize(state, reason, exitCode, failureClass, pid) {
      if (finalizado) return
      finalizado = true
      if (pid !== null) ACTIVE_WORKER_PIDS.delete(pid)

      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }

      if (runningReceiptPromise !== null && state !== 'start_failed') {
        try {
          await runningReceiptPromise
        } catch {
          // ignora erro ao esperar transição running
        }
      }

      const nowIso = now()
      currentReceipt = withTerminal(currentReceipt, state, {
        exitCode,
        reason,
        nowIso,
      })
      writeReceipt(file, currentReceipt)

      const durationMs = Math.max(0, Date.now() - startMs)
      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')

      resolve({
        state,
        reason,
        exitCode,
        exit_code: exitCode,
        pid,
        charge: chargeOf(state),
        failureClass,
        receiptFile: file,
        receipt_path: file,
        stdout,
        stderr,
        durationMs,
      })
    }

    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      let spawnArgs = launchArgs
      /** @type {import('node:child_process').SpawnOptions & { maxBuffer: number }} */
      const spawnOptions = {
        cwd,
        env: childEnv,
        maxBuffer: 1 << 26,
        shell: false,
        detached: false,
        windowsHide: true,
        // CLIs que leem o prompt pela entrada padrão (`codex exec -`) precisam de um cano aberto;
        // sem `stdinData` a entrada continua fechada, para o worker nunca ficar esperando o operador.
        stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }

      const isCmd =
        resolved.mode === 'cmd_fallback' ||
        resolved.via === 'cmd' ||
        /[\\/]cmd(?:\.exe)?$/i.test(resolved.exe) ||
        resolved.exe.toLowerCase() === 'cmd.exe'

      if (
        isCmd &&
        launchArgs.length >= 4 &&
        launchArgs[0] === '/d' &&
        launchArgs[1] === '/s' &&
        launchArgs[2] === '/c'
      ) {
        const shim = launchArgs[3]
        const extraArgs = launchArgs.slice(4)
        /** @param {string} value */
        const escapeMeta = (value) => value.replace(/([()%!^"<>&| ])/g, '^$1')
        /** @param {string} arg */
        const escapeArg = (arg) => {
          const quoted = '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
          // O cmd interpreta a chamada e depois a expansão de %* no shim.
          return escapeMeta(escapeMeta(quoted))
        }
        const inner = [escapeMeta(shim), ...extraArgs.map(escapeArg)].join(' ')
        spawnArgs = ['/d', '/s', '/v:off', '/c', `"${inner}"`]
        assertArgvLimit(resolved.exe, spawnArgs)
        spawnOptions.windowsVerbatimArguments = true
      }

      child = spawnImpl(resolved.exe, spawnArgs, spawnOptions)
    } catch {
      finalize('start_failed', 'spawn_error', null, 'environment', null)
      return
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(String(chunk))
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrChunks.push(String(chunk))
      })
    }

    if (stdinData !== undefined) {
      if (!child.stdin) {
        finalize('start_failed', 'spawn_error', null, 'environment', child.pid ?? null)
        return
      }
      // Se o processo morrer antes de ler o prompt, a escrita quebra o cano; o motivo fica no
      // stderr do recibo e o desfecho continua sendo o do processo (`close`).
      child.stdin.on('error', (err) => {
        stderrChunks.push(`\n[ade] falha ao entregar stdin: ${err instanceof Error ? err.message : String(err)}\n`)
      })
      child.stdin.end(stdinData, 'utf8')
    }

    child.once('error', () => {
      if (!child.pid) {
        finalize('start_failed', 'spawn_error', null, 'environment', null)
      }
    })

    child.once('close', (code) => {
      const exitCode = typeof code === 'number' ? code : null
      /** @type {'exited' | 'timeout' | 'crashed'} */
      let state
      /** @type {'exit' | 'timeout' | 'dead_man'} */
      let reason
      if (triggeredReason === 'timeout') {
        state = 'timeout'
        reason = 'timeout'
      } else if (triggeredReason === 'dead_man') {
        state = 'timeout'
        reason = 'dead_man'
      } else if (exitCode === 0) {
        state = 'exited'
        reason = 'exit'
      } else {
        state = 'crashed'
        reason = 'exit'
      }
      finalize(state, reason, exitCode, null, child.pid ?? null)
    })

    if (child.pid) {
      const childPid = child.pid
      ACTIVE_WORKER_PIDS.add(childPid)

      if (timeoutS !== undefined) {
        timeoutTimer = setTimeout(() => {
          triggeredReason = 'timeout'
          killTree(childPid, { child })
        }, timeoutS * 1000)
      }

      if (heartbeatPath !== undefined && heartbeatTimeoutS !== undefined) {
        const spawnMs = Date.now()
        const intervalMs = Math.min(1000, Math.max(100, (heartbeatTimeoutS * 1000) / 4))
        heartbeatTimer = setInterval(() => {
          let lastHbMs = spawnMs
          if (fs.existsSync(heartbeatPath)) {
            try {
              lastHbMs = fs.statSync(heartbeatPath).mtimeMs
            } catch {
              // fallback
            }
          }
          if (Date.now() - lastHbMs >= heartbeatTimeoutS * 1000 - 10) {
            triggeredReason = 'dead_man'
            killTree(childPid, { child })
          }
        }, intervalMs)
      }

      runningReceiptPromise = (async () => {
        let startTime = null
        try {
          startTime = await getStartTime(childPid)
        } catch {
          // ignora
        }
        currentReceipt = withRunning(
          base,
          {
            pid: childPid,
            start_time: startTime,
            host: os.hostname(),
          },
          now(),
        )
        writeReceipt(file, currentReceipt)
        return currentReceipt
      })()
    }
  })
}
