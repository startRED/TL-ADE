import { runContained } from '../gates/command.js'
import { buildExtract, safeId, writeRawArtifact } from '../gates/output.js'
import { AdeError } from '../journal/errors.js'

/**
 * @typedef {Object} FirewallRunOptions
 * @property {string} missionDir
 * @property {string} id
 * @property {string} cwd
 * @property {string} [kind]
 * @property {number} [timeoutS]
 * @property {number} [expectExit]
 * @property {Record<string, string>} [env]
 */

/**
 * @typedef {Object} FirewallExtract
 * @property {'success'|'warning'|'error'} status
 * @property {string} summary
 * @property {string[]} next_actions
 * @property {string[]} artifacts
 * @property {string} raw_ref
 */

/**
 * @typedef {Object} FirewallRunResult
 * @property {string} rawPath
 * @property {FirewallExtract} extract
 */

/**
 * Recusa `opts` ausente ou com campo fora do contrato antes de qualquer spawn ou escrita.
 *
 * @param {unknown} opts
 * @returns {asserts opts is FirewallRunOptions}
 */
function assertOpts(opts) {
  const bad = () => new AdeError('invalid_argument', 'opts inválido', 2)
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw bad()
  const o = /** @type {Record<string, unknown>} */ (opts)
  for (const key of ['missionDir', 'id', 'cwd']) {
    if (typeof o[key] !== 'string' || !o[key]) throw bad()
  }
  if (o.kind !== undefined && (typeof o.kind !== 'string' || !o.kind)) throw bad()
  if (o.timeoutS !== undefined && (typeof o.timeoutS !== 'number' || !Number.isFinite(o.timeoutS) || o.timeoutS <= 0)) {
    throw bad()
  }
  if (o.expectExit !== undefined && !Number.isSafeInteger(o.expectExit)) throw bad()
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== 'object' || Array.isArray(o.env)) throw bad()
    if (Object.values(o.env).some((v) => typeof v !== 'string')) throw bad()
  }
}

/**
 * Executa um comando de forma contida, grava a saída bruta como artefato e devolve
 * um extrato pequeno e seguro para o modelo, nunca a saída bruta inteira.
 *
 * @param {string[]} argv
 * @param {FirewallRunOptions} opts
 * @returns {Promise<FirewallRunResult>}
 */
export async function run(argv, opts) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
    throw new AdeError('invalid_argument', 'argv inválido', 2)
  }

  assertOpts(opts)
  const { missionDir, id, cwd, kind = 'test', timeoutS = 120, expectExit = 0, env } = opts

  const { exitCode, stdout, stderr } = await runContained({ argv, cwd, timeoutS, env })

  const rawText = stdout + (stderr ? '\n' + stderr : '')
  const bytesRaw = Buffer.byteLength(rawText, 'utf8')

  const { rawPath } = writeRawArtifact({ missionDir, ref: `fw/${safeId(id)}`, text: rawText })

  const rawRef = `art:fw/${safeId(id)}`
  const e = buildExtract({ kind, exitCode, expectExit, stdout, stderr, rawRef, bytesRaw })

  return {
    rawPath,
    extract: {
      status: e.status,
      summary: e.summary + '\n' + e.excerpt,
      next_actions: e.next_actions,
      artifacts: e.artifacts,
      raw_ref: e.raw_ref,
    },
  }
}
