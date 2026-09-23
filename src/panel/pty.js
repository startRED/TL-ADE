// @ts-check
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { AdeError } from '../journal/errors.ts'
import { terminateProcessTree } from '../runner/spawn.ts'

/** Maior pedaço de saída entregue de uma vez ao navegador. */
export const MAX_TERMINAL_CHUNK = 64 * 1024

// OSC (título, área de transferência, hiperlink) e DCS/SOS/PM/APC saem, nas formas ESC e C1;
// CSI de cor e cursor fica.
const ESC = '\x1b'
const STRING_INTRO = new Set([']', 'P', 'X', '^', '_'])
const C1_STRING = new Set(['\x9d', '\x90', '\x98', '\x9e', '\x9f'])

/**
 * Carrega o node-pty sob demanda: só o takeover depende da biblioteca nativa.
 *
 * @returns {Promise<{ spawn: Function }>}
 */
export async function loadPtyAdapter() {
  const mod = await import('node-pty')
  return { spawn: (mod.default ?? mod).spawn }
}

/**
 * Filtro com estado entre pedaços: uma sequência dividida entre dois `onData` também sai, e uma
 * não terminada segue descartada até o terminador (BEL, ESC \ ou ST C1).
 *
 * @returns {(text: string) => string}
 */
export function createTerminalOutputFilter() {
  /** @type {'text' | 'esc' | 'string' | 'string_esc'} */
  let state = 'text'
  return (text) => {
    let out = ''
    for (const ch of text) {
      if (state === 'string_esc') {
        // ESC que não fecha a string a aborta e inicia outra sequência, como faz o xterm.
        state = ch === '\\' ? 'text' : 'esc'
        if (state === 'text') continue
      }
      if (state === 'string') {
        if (ch === ESC) state = 'string_esc'
        else if (ch === '\x07' || ch === '\x9c') state = 'text'
        continue
      }
      if (state === 'esc') {
        if (STRING_INTRO.has(ch)) state = 'string'
        else if (ch === ESC) out += ESC
        else {
          out += ESC + ch
          state = 'text'
        }
        continue
      }
      if (ch === ESC) state = 'esc'
      else if (C1_STRING.has(ch)) state = 'string'
      else out += ch
    }
    return out
  }
}

/**
 * Abre a sessão do Maker da story no seu worktree, sob controle humano. O encerramento passa
 * sempre por `terminateProcessTree` (taskkill /T /F /PID no Windows), nunca por `pty.kill()`.
 *
 * @param {{
 *   mission: string,
 *   story: string,
 *   sessionRef: string,
 *   worktree: string,
 *   ptyAdapter: { spawn: Function },
 *   command: { exe: string, prefixArgs: string[] },
 *   platform?: string,
 *   execFileSync?: Function,
 *   isAlive?: (pid: number) => boolean,
 * }} input
 */
export function createTakeoverSession({
  mission,
  story,
  sessionRef,
  worktree,
  ptyAdapter,
  command,
  platform = process.platform,
  execFileSync: exec = execFileSync,
  isAlive,
}) {
  for (const [name, value] of Object.entries({ mission, story, sessionRef, worktree })) {
    if (typeof value !== 'string' || value.length === 0) throw new AdeError('takeover_invalid', `${name} obrigatório`, 4)
  }
  if (typeof ptyAdapter?.spawn !== 'function') throw new AdeError('takeover_pty_missing', 'adapter de PTY ausente', 4)
  const cmd = command
  if (typeof cmd?.exe !== 'string' || !Array.isArray(cmd.prefixArgs)) throw new AdeError('takeover_command_missing', 'comando da sessão não resolvido', 4)

  const pty = ptyAdapter.spawn(cmd.exe, [...cmd.prefixArgs, '--resume', sessionRef], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: worktree,
  })
  const token = randomBytes(24).toString('hex')
  /** @type {Set<(chunk: Buffer) => void>} */
  const listeners = new Set()
  let exited = false
  const confine = createTerminalOutputFilter()
  pty.onData((/** @type {string} */ data) => {
    const bytes = Buffer.from(confine(data), 'utf8')
    // O xterm decodifica UTF-8 em fluxo, então cortar no meio de um caractere é seguro.
    for (let i = 0; i < bytes.length; i += MAX_TERMINAL_CHUNK) {
      const chunk = bytes.subarray(i, i + MAX_TERMINAL_CHUNK)
      for (const cb of listeners) cb(chunk)
    }
  })
  pty.onExit(() => {
    exited = true
  })

  return {
    token,
    mission,
    story,
    sessionRef,
    worktree,
    pid: /** @type {number} */ (pty.pid),
    /** @param {(chunk: Buffer) => void} cb */
    onOutput(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    /** @param {string} data */
    write(data) {
      if (!exited) pty.write(data)
    },
    close() {
      listeners.clear()
      return terminateProcessTree({
        pid: pty.pid,
        platform,
        timeoutMs: 0,
        isAlive: isAlive ?? (() => !exited),
        execFileSync: exec,
      })
    },
  }
}
