import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'

export const ARGV_MAX_CHARS = 30000

/**
 * Valida se o comprimento total da linha de comando não excede o limite estipulado.
 *
 */
export function assertArgvLimit(exe: string, args: string[], limit: number = ARGV_MAX_CHARS): void {
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
 */
export function buildArgv(resolved: { prefixArgs: string[] }, args: string[]): string[] {
  return [...resolved.prefixArgs, ...args]
}

export type BinaryMode = 'native' | 'npm_shim' | 'cmd_fallback'

export type BinaryVia = 'direct' | 'shim' | 'cmd'

export type ResolvedBinary = {
  exe: string
  prefixArgs: string[]
  via: BinaryVia
  mode: BinaryMode
  shim: string | null
}

export type ResolveBinaryDeps = {
  platform?: string
  pathEnv?: string
  comspec?: string
  existsSync?: (p: string) => boolean
  readFileSync?: (p: string) => string
}

/**
 * Resolve o executável real de um comando, tratando shims .cmd do npm e fallbacks de shell.
 *
 */
export function resolveBinary(command: string, deps: ResolveBinaryDeps = {}): ResolvedBinary {
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('command inválido')
  }

  const platform = deps.platform ?? process.platform
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'))

  const candidates: string[] = []

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
      let prefixArgs: string[] = []
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
