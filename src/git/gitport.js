import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitError, UnexpectedTreeStateError } from '../journal/errors.js'

const DEFAULT_MAX_BUFFER = 1 << 26

const ENV_ALLOWLIST = [
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

/**
 * Constrói o ambiente isolado para comandos Git.
 *
 * @param {string} hooksDir
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
function buildEnv(hooksDir, extra = {}) {
  /** @type {Record<string, string>} */
  const copied = {}
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key]
    if (val !== undefined) {
      copied[key] = val
    }
  }
  return {
    ...copied,
    ...extra,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/**
 * @typedef {Object} RunResult
 * @property {number} code
 * @property {Buffer} stdout
 * @property {string} stderr
 * @property {string} text
 */

/**
 * @typedef {Object} RunOptions
 * @property {number} [maxBuffer]
 * @property {number[]} [okCodes]
 * @property {Record<string, string | undefined>} [env]
 */

/**
 * @typedef {Object} HeadInfoResult
 * @property {string | null} commit
 * @property {string | null} branch
 * @property {boolean} detached
 */

/**
 * @typedef {Object} CommitResult
 * @property {string} commit
 * @property {string} tree
 */

/**
 * @typedef {Object} GitPort
 * @property {string} worktreeDir
 * @property {(args: string[], options?: RunOptions) => Promise<RunResult>} run
 * @property {() => Promise<HeadInfoResult>} headInfo
 * @property {(name: string) => Promise<string>} gitPath
 * @property {(options: { message: string }) => Promise<CommitResult>} commit
 */

/**
 * Cria uma porta Git isolada para o worktree informado.
 *
 * NOTA DE CICLO DE VIDA: Cada instância aloca um diretório temporário de hooks vazio
 * para isolamento de execução (`core.hooksPath`). O ciclo de vida explícito (ex: método de descarte/close)
 * está planejado para story posterior do engine de worktree para evitar alterar o contrato da interface v1.
 *
 * @param {{ worktreeDir: string }} options
 * @returns {GitPort}
 */
export function createGitPort(options) {
  const worktreeDir = options && options.worktreeDir
  if (typeof worktreeDir !== 'string' || worktreeDir.length === 0) {
    throw new TypeError('worktreeDir inválido')
  }

  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-hooks-'))

  /**
   * @param {string[]} args
   * @param {RunOptions} [options]
   * @returns {Promise<RunResult>}
   */
  function run(args, options = {}) {
    const { maxBuffer = DEFAULT_MAX_BUFFER, okCodes = [0], env: extraEnv = {} } = options
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', worktreeDir, ...args],
        {
          maxBuffer,
          shell: false,
          windowsHide: true,
          encoding: 'buffer',
          env: buildEnv(hooksDir, extraEnv),
        },
        (error, stdout, stderr) => {
          if (error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new UnexpectedTreeStateError('saída de git truncada', { args }))
            return
          }
          if (error && 'code' in error && error.code === 'ENOENT') {
            reject(new GitError('missing', 'binário git não encontrado', { args }))
            return
          }
          const code = error && typeof error.code === 'number' ? error.code : 0
          const stderrStr = stderr ? stderr.toString('utf8') : ''
          const stdoutBuf = stdout ?? Buffer.alloc(0)
          if (!okCodes.includes(code)) {
            reject(
              new GitError('exit_nonzero', `git ${args[0]} saiu com ${code}`, {
                args,
                code,
                stderr: stderrStr,
              }),
            )
            return
          }
          resolve({
            code,
            stdout: stdoutBuf,
            stderr: stderrStr,
            text: stdoutBuf.toString('utf8').trim(),
          })
        },
      )
    })
  }

  /**
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function gitPath(name) {
    const result = await run(['rev-parse', '--git-path', name], { maxBuffer: 1 << 20 })
    return path.resolve(worktreeDir, result.text)
  }

  /**
   * @returns {Promise<HeadInfoResult>}
   */
  async function headInfo() {
    const headResult = await run(['rev-parse', 'HEAD'], {
      maxBuffer: 1 << 20,
      okCodes: [0, 128],
    })
    const commit = headResult.code === 0 && headResult.text ? headResult.text : null

    const branchResult = await run(['symbolic-ref', '--short', '-q', 'HEAD'], {
      maxBuffer: 1 << 20,
      okCodes: [0, 1],
    })
    const detached = branchResult.code !== 0 || !branchResult.text
    const branch = detached ? null : branchResult.text

    return { commit, branch, detached }
  }

  /**
   * @param {{ message: string }} options
   * @returns {Promise<CommitResult>}
   */
  async function commit({ message }) {
    await run(['add', '-A'], { maxBuffer: 1 << 26 })
    await run(['commit', '-m', message], { maxBuffer: 1 << 24 })
    const commit = (await run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    const tree = (await run(['rev-parse', 'HEAD^{tree}'], { maxBuffer: 1 << 20 })).text
    return { commit, tree }
  }

  return {
    worktreeDir,
    run,
    headInfo,
    gitPath,
    commit,
  }
}
