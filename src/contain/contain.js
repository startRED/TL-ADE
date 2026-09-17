import { AdeError } from '../journal/errors.js'

/**
 * Precedência fixa das violações do contain.
 * @type {readonly ['secret', 'sensitive_path', 'scope', 'no_changes']}
 */
export const PRECEDENCE = /** @type {const} */ ([
  'secret',
  'sensitive_path',
  'scope',
  'no_changes',
])

/**
 * Caminhos padrão considerados sensíveis na árvore.
 * @type {readonly string[]}
 */
export const DEFAULT_SENSITIVE_PATHS = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/id_rsa',
  '**/.ssh/**',
  '**/.aws/**',
  '**/secrets/**',
])

/**
 * Compara um caminho relativo contra um padrão glob.
 *
 * @param {string} pattern
 * @param {string} relPath
 * @returns {boolean}
 */
export function matchesGlob(pattern, relPath) {
  if (typeof pattern !== 'string' || typeof relPath !== 'string') {
    return false
  }
  const normPattern = pattern.replace(/\\/g, '/')
  const normPath = relPath.replace(/\\/g, '/')
  const escaped = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?|\*/g, (m) => {
      if (m === '**/') return '(?:.*/)?'
      if (m === '**') return '.*'
      return '[^/]*'
    })
  const re = new RegExp(`^${escaped}$`)
  return re.test(normPath)
}

/**
 * @typedef {Object} ContainViolation
 * @property {'secret' | 'sensitive_path' | 'scope' | 'no_changes'} kind
 * @property {string} path
 * @property {string | null} pattern
 * @property {'diff' | 'bytes' | null} source
 */

/**
 * @typedef {Object} ContainResult
 * @property {boolean} ok
 * @property {'secret' | 'sensitive_path' | 'scope' | 'no_changes' | null} reason
 * @property {'security' | 'scope' | 'semantic' | null} failureClass
 * @property {'stop_batch' | 'restore' | 'park' | 'rework' | 'continue'} action
 * @property {ContainViolation[]} violations
 * @property {string[]} changedPaths
 * @property {string | null} quarantineRef
 * @property {string | null} restoredTree
 */

/**
 * Executa a contenção pós-fato sobre a árvore e o diff.
 *
 * @param {Record<string, unknown>} _input
 * @returns {Promise<ContainResult>}
 */
export async function contain(_input) {
  throw new AdeError('not_implemented', 'contain chega na story s2', 2)
}
