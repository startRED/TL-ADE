import { execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { AdeError } from '../journal/errors.js'

/** @type {(path: string) => Promise<string>} */
const defaultReadFile = (p) => fs.promises.readFile(p, 'utf8')

/** @type {(file: string, args: string[]) => Promise<string>} */
const defaultExecFile = async (file, args) =>
  String(
    (
      await promisify(execFileCb)(file, args, {
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  )

/**
 * Valida se o pid é um número inteiro estritamente positivo.
 * @param {number} pid
 */
function assertPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('pid inválido: ' + pid)
  }
}

/**
 * Obtém a data/hora de início do processo para fingerprinting anti-reúso de PID (s5).
 * @param {number} pid
 * @param {{
 *   platform?: string,
 *   readFile?: (path: string) => Promise<string>,
 *   execFile?: (file: string, args: string[]) => Promise<string>
 * }} [deps]
 * @returns {Promise<string | null>}
 */
export async function getProcessStartTime(pid, deps = {}) {
  assertPid(pid)
  const {
    platform = process.platform,
    readFile = defaultReadFile,
    execFile = defaultExecFile,
  } = deps

  if (platform === 'linux') {
    /** @type {string} */
    let stat
    try {
      stat = await readFile('/proc/' + pid + '/stat')
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      if (code === 'ENOENT' || code === 'ESRCH') {
        return null
      }
      throw err
    }

    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    if (!ticks || !/^[0-9]+$/.test(ticks)) {
      throw new AdeError('process_info_unavailable', 'stat ilegível para pid ' + pid, 3)
    }

    const bootId = (await readFile('/proc/sys/kernel/random/boot_id')).trim()
    return bootId + ':' + ticks
  }

  if (platform === 'win32') {
    const script =
      "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" +
      pid +
      "'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }"
    const out = await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ])
    const text = out.trim()
    return text === '' ? null : text
  }

  throw new AdeError('unsupported_platform', 'plataforma sem leitura de start_time: ' + platform, 2)
}

/**
 * Verifica se um processo ainda está vivo no sistema operacional (s5).
 * @param {number} pid
 * @param {(pid: number, signal: number) => unknown} [killImpl]
 * @returns {boolean}
 */
export function isProcessAlive(pid, killImpl = process.kill.bind(process)) {
  assertPid(pid)
  try {
    killImpl(pid, 0)
    return true
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw err
  }
}
