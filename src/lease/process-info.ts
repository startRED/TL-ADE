import { execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { AdeError } from '../journal/errors.ts'

const defaultReadFile: (path: string) => Promise<string> = (p): Promise<string> => fs.promises.readFile(p, 'utf8')

const defaultExecFile: (file: string,args: string[]) => Promise<string> = async (file, args): Promise<string> =>
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
 */
function assertPid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('pid inválido: ' + pid)
  }
}

/**
 * Obtém a data/hora de início do processo para fingerprinting anti-reúso de PID (s5).
 */
export async function getProcessStartTime(pid: number, deps: {
platform?: string
readFile?: (path: string) => Promise<string>
execFile?: (file: string,args: string[]) => Promise<string>
} = {}): Promise<string|null> {
  assertPid(pid)
  const {
    platform = process.platform,
    readFile = defaultReadFile,
    execFile = defaultExecFile,
  } = deps

  if (platform === 'linux') {
    let stat: string
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
 */
export function isProcessAlive(pid: number, killImpl: (pid: number,signal: number) => unknown = process.kill.bind(process)): boolean {
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
