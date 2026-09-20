import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.js'

export const ARGV_MAX_CHARS = 30000

/**
 * Valida se o comprimento total da linha de comando não excede o limite estipulado.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {number} [limit]
 * @returns {void}
 */
export function assertArgvLimit(exe, args, limit = ARGV_MAX_CHARS) {
  const total = [exe, ...args].join(' ').length
  if (total > limit) {
    throw new AdeError('argv_too_long', 'argv excede ' + limit + ' chars: ' + total, 2, {
      total,
      limit,
    })
  }
}

/**
 * Monta o array final de argumentos combinando os prefixArgs do binário resolvido com os argumentos extras.
 *
 * @param {{prefixArgs: string[]}} resolved
 * @param {string[]} args
 * @returns {string[]}
 */
export function buildArgv(resolved, args) {
  return [...resolved.prefixArgs, ...args]
}

/**
 * @typedef {'native' | 'npm_shim' | 'cmd_fallback'} BinaryMode
 */

/**
 * @typedef {'direct' | 'shim' | 'cmd'} BinaryVia
 */

/**
 * @typedef {Object} ResolvedBinary
 * @property {string} exe
 * @property {string[]} prefixArgs
 * @property {BinaryVia} via
 * @property {BinaryMode} mode
 * @property {string | null} shim
 */

/**
 * @typedef {Object} ResolveBinaryDeps
 * @property {string} [platform]
 * @property {string} [pathEnv]
 * @property {string} [comspec]
 * @property {(p: string) => boolean} [existsSync]
 * @property {(p: string) => string} [readFileSync]
 */

/**
 * Resolve o executável real de um comando, tratando shims .cmd do npm e fallbacks de shell.
 *
 * @param {string} command
 * @param {ResolveBinaryDeps} [deps]
 * @returns {ResolvedBinary}
 */
export function resolveBinary(command, deps = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('command inválido')
  }

  const platform = deps.platform ?? process.platform
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'))

  /** @type {string[]} */
  const candidates = []

  if (command.includes('/') || command.includes('\\')) {
    if (platform === 'win32') {
      candidates.push(command, command + '.exe', command + '.cmd')
    } else {
      candidates.push(command)
    }
  } else {
    const defaultPath =
      platform === 'win32'
        ? (process.env.PATH ?? process.env.Path ?? '')
        : (process.env.PATH ?? '')
    const pathEnv = deps.pathEnv ?? defaultPath
    const delimiter = platform === 'win32' && pathEnv.includes(';') ? ';' : path.delimiter
    const dirs = pathEnv.split(delimiter).filter(Boolean)

    for (const dir of dirs) {
      if (platform === 'win32') {
        candidates.push(
          path.join(dir, command + '.exe'),
          path.join(dir, command + '.cmd'),
          path.join(dir, command),
        )
      } else {
        candidates.push(path.join(dir, command))
      }
    }
  }

  const found = candidates.find((c) => existsSync(c))
  if (!found) {
    throw new AdeError('binary_not_found', 'binário não encontrado no PATH: ' + command, 2, {
      command,
    })
  }

  if (platform !== 'win32' || /\.exe$/i.test(found)) {
    const mode = 'native'
    return {
      exe: found,
      prefixArgs: [],
      via: 'direct',
      mode,
      shim: null,
    }
  }

  // Ramo .cmd (ou outro formato no Windows que não termina em .exe)
  const raw = readFileSync(found)
  const texto = typeof raw === 'string' ? raw : String(raw)
  const progMatch =
    texto.match(/IF\s+EXIST\s+"%~?dp0%?\\([^"\r\n]+\.exe)"/i) ??
    texto.match(/"%~?dp0%?\\([^"\r\n]+\.exe)"/i)
  const scriptMatch = texto.match(/"%~?dp0%?\\([^"\r\n]+\.(?:js|mjs|cjs))"/i)

  if (progMatch) {
    const progRel = progMatch[1].replace(/\\/g, path.sep)
    const exeResolved = path.resolve(path.dirname(found), progRel)

    if (existsSync(exeResolved)) {
      /** @type {string[]} */
      let prefixArgs = []
      if (scriptMatch) {
        const scriptRel = scriptMatch[1].replace(/\\/g, path.sep)
        const scriptResolved = path.resolve(path.dirname(found), scriptRel)
        if (existsSync(scriptResolved)) {
          prefixArgs = [scriptResolved]
        }
      }

      const mode = 'npm_shim'
      return {
        exe: exeResolved,
        prefixArgs,
        via: 'shim',
        mode,
        shim: found,
      }
    }
  }

  const comspec = deps.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
  const mode = 'cmd_fallback'
  return {
    exe: comspec,
    prefixArgs: ['/d', '/s', '/c', found],
    via: 'cmd',
    mode,
    shim: found,
  }
}
