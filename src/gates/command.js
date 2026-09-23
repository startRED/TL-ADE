import { execFile } from 'node:child_process'
import path from 'node:path'
import { buildWorkerEnv } from '../runner/spawn.ts'

/**
 * @typedef {Object} GateSpec
 * @property {string} id
 * @property {string} [kind]
 * @property {string[]} [argv]
 * @property {string} [script]
 */

/**
 * @typedef {Object} PackageJsonSpec
 * @property {Record<string, string>} [scripts]
 */

/**
 * @typedef {Object} GateVars
 * @property {string} worktree
 * @property {string} tree
 * @property {string[]} changedFiles
 */

/**
 * @typedef {Object} RunContainedResult
 * @property {number|null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {boolean} timedOut
 */

/**
 * Valida se o comando inicial é permitido (`node`, caminho absoluto `.exe` ou o binário node).
 *
 * @param {unknown} cmd0
 * @returns {void}
 */
function validateCmd0(cmd0) {
  // 'node' literal, caminho absoluto `.exe`, ou o próprio binário (`process.execPath`), que no
  // Linux/macOS é `/…/bin/node` sem extensão. `win32.isAbsolute` aceita `C:\…` e `/…` em qualquer SO:
  // a regra de paridade vale igual nos dois (o CI Linux recusava os dois casos).
  const isValid =
    cmd0 === 'node' ||
    (typeof cmd0 === 'string' &&
      path.win32.isAbsolute(cmd0) &&
      (cmd0.toLowerCase().endsWith('.exe') || path.basename(cmd0) === 'node'))

  if (!isValid) {
    throw new TypeError('argv inválido: cmd[0] precisa ser node')
  }
}

/**
 * Resolve o argv final do gate a partir de gate.argv ou gate.script e expande placeholders.
 *
 * @param {{ gate: GateSpec, packageJson: PackageJsonSpec, vars: GateVars }} options
 * @returns {string[]}
 */
export function resolveGateArgv({ gate, packageJson, vars }) {
  const hasArgv = gate && gate.argv !== undefined
  const hasScript = gate && gate.script !== undefined

  if ((hasArgv && hasScript) || (!hasArgv && !hasScript)) {
    throw new TypeError('gate precisa de argv ou script, nunca os dois')
  }

  /** @type {string[]} */
  let rawTokens = []

  if (hasScript) {
    if (typeof gate.script !== 'string') {
      throw new TypeError('script de gate precisa ser uma string')
    }
    const script = packageJson?.scripts?.[gate.script]
    if (typeof script !== 'string') {
      throw new TypeError('script de gate inexistente: ' + gate.script)
    }
    if (script.includes('"') || script.includes("'")) {
      throw new TypeError('script de gate com aspas não é suportado: ' + gate.script)
    }
    const trimmed = script.trim()
    rawTokens = trimmed.length > 0 ? trimmed.split(/\s+/) : []
  } else {
    if (!Array.isArray(gate.argv)) {
      throw new TypeError('argv de gate precisa ser um array')
    }
    rawTokens = [...gate.argv]
  }

  /** @type {string[]} */
  const expanded = []

  for (const token of rawTokens) {
    if (token === '{changed_files}') {
      const files = vars?.changedFiles ?? []
      for (const file of files) {
        expanded.push(file)
      }
    } else {
      let t = String(token)

      // Identifica qualquer placeholder desconhecido ({worktree} e {tree} são os únicos conhecidos fora de {changed_files})
      for (const match of t.matchAll(/\{[^{}]+\}/g)) {
        if (match[0] !== '{worktree}' && match[0] !== '{tree}') {
          throw new TypeError(`placeholder desconhecido: ${match[0]}`)
        }
      }

      if (vars?.worktree !== undefined) {
        t = t.replaceAll('{worktree}', vars.worktree)
      }
      if (vars?.tree !== undefined) {
        t = t.replaceAll('{tree}', vars.tree)
      }

      const leftover = t.match(/\{[^{}]+\}/)
      if (leftover) {
        throw new TypeError(`placeholder desconhecido: ${leftover[0]}`)
      }

      expanded.push(t)
    }
  }

  validateCmd0(expanded[0])

  return expanded
}

/**
 * Executa um processo de forma contida e monitorada.
 *
 * @param {{ argv: string[], cwd: string, timeoutS: number, env?: Record<string, string> }} options
 * @returns {Promise<RunContainedResult>}
 */
export async function runContained({ argv, cwd, timeoutS, env }) {
  validateCmd0(argv?.[0])

  return new Promise((resolve) => {
    const startTime = Date.now()
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 2 ** 31,
        timeout: timeoutS * 1000,
        killSignal: 'SIGKILL',
        env: {
          ...buildWorkerEnv(),
          ...env,
        },
      },
      (error, stdoutBuf, stderrBuf) => {
        const durationMs = Date.now() - startTime
        const timedOut = Boolean(error && error.killed === true)
        const exitCode = timedOut
          ? null
          : typeof error?.code === 'number'
            ? error.code
            : error
              ? null
              : 0
        const stdout = stdoutBuf ? stdoutBuf.toString('utf8') : ''
        let stderr = stderrBuf ? stderrBuf.toString('utf8') : ''

        if (error && typeof error.code !== 'number' && !timedOut) {
          stderr = stderr.length > 0 ? `${stderr}\n${error.message}` : error.message
        }

        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs,
          timedOut,
        })
      }
    )
  })
}
