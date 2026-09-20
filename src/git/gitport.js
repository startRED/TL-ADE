import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AdeError, GitError, UnexpectedTreeStateError } from '../journal/errors.js'

/**
 * Sinaliza entrada inválida em operações da porta Git.
 */
export class GitInvalidInputError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('invalid_input', message, 4, details)
  }
}

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
 * @typedef {Object} CheckpointResult
 * @property {string} ref
 * @property {string} commit
 * @property {string} tree
 * @property {number} n
 */

/**
 * @typedef {Object} RestoreTreeResult
 * @property {string} tree
 * @property {string} discardedRef
 */

/**
 * @typedef {Object} GitPort
 * @property {string} worktreeDir
 * @property {(args: string[], options?: RunOptions) => Promise<RunResult>} run
 * @property {() => Promise<HeadInfoResult>} headInfo
 * @property {(name: string) => Promise<string>} gitPath
 * @property {(options: { message: string }) => Promise<CommitResult>} commit
 * @property {() => Promise<string>} worktreeTree
 * @property {() => Promise<string[]>} dirtyPaths
 * @property {(label: string) => Promise<CheckpointResult>} checkpoint
 * @property {(tree: string, options: { label: string }) => Promise<RestoreTreeResult>} restoreTree
 * @property {(tree: string, options: { label: string }) => Promise<RestoreTreeResult>} restore
 * @property {(ref: string) => Promise<string | null>} readLocalRef
 * @property {(remote: string, ref: string) => Promise<string | null>} readRemoteRef
 * @property {(remote: string, ref: string) => Promise<string | null>} readRef
 * @property {(baseRef: string, reviewedCommit: string) => Promise<{ commit: string }>} fastForward
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

  /**
   * Obtém a árvore do worktree com suporte a timestamp racy via índice isolado.
   *
   * @returns {Promise<string>}
   */
  async function worktreeTree() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-idx-'))
    const idx = path.join(tmp, 'index')
    const realIndex = await gitPath('index')
    try {
      if (fs.existsSync(realIndex)) {
        fs.copyFileSync(realIndex, idx)
        fs.utimesSync(idx, 1, 1)
      }
      await run(['add', '-A'], { maxBuffer: 1 << 26, env: { GIT_INDEX_FILE: idx } })
      const tree = (await run(['write-tree'], { maxBuffer: 1 << 20, env: { GIT_INDEX_FILE: idx } })).text
      return tree
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /**
   * Lista os caminhos com alterações no worktree, incluindo untracked e ambos os lados de rename/cópia.
   *
   * @returns {Promise<string[]>}
   */
  async function dirtyPaths() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-idx-'))
    const idx = path.join(tmp, 'index')
    const realIndex = await gitPath('index')
    try {
      if (fs.existsSync(realIndex)) {
        fs.copyFileSync(realIndex, idx)
        fs.utimesSync(idx, 1, 1)
      }
      await run(['add', '-A'], { maxBuffer: 1 << 26, env: { GIT_INDEX_FILE: idx } })

      const set = new Set()

      // Consulta status com saída NUL
      const { stdout: statusOut } = await run(
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        {
          maxBuffer: 1 << 30,
          env: { GIT_INDEX_FILE: idx },
        },
      )
      const fields = statusOut.toString('utf8').split('\0')
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (!field) {
          continue
        }
        const status = field.slice(0, 2)
        const target = field.slice(3)
        set.add(target)
        if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
          i += 1
          if (i < fields.length && fields[i]) {
            set.add(fields[i])
          }
        }
      }

      // Consulta diff com saída NUL contra HEAD se houver commit
      const head = await headInfo()
      if (head.commit) {
        const { stdout: diffOut } = await run(
          ['diff-index', '--cached', '-z', '-M', 'HEAD'],
          {
            maxBuffer: 1 << 30,
            env: { GIT_INDEX_FILE: idx },
            okCodes: [0, 1],
          },
        )
        const diffTokens = diffOut.toString('utf8').split('\0')
        for (let i = 0; i < diffTokens.length; i++) {
          const token = diffTokens[i]
          if (!token) continue
          if (token.startsWith(':')) {
            const parts = token.split(' ')
            const rawStatus = parts[parts.length - 1] ?? ''
            const isRename = rawStatus.startsWith('R') || rawStatus.startsWith('C')
            i += 1
            if (i < diffTokens.length && diffTokens[i]) {
              set.add(diffTokens[i])
            }
            if (isRename) {
              i += 1
              if (i < diffTokens.length && diffTokens[i]) {
                set.add(diffTokens[i])
              }
            }
          }
        }
      }

      return Array.from(set).sort()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /**
   * Valida o rótulo contra as regras de formato de ref do Git.
   *
   * @param {unknown} [label]
   * @returns {Promise<void>}
   */
  async function assertLabel(label) {
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError('label inválido')
    }
    const fmt = await run(['check-ref-format', `refs/ade/checkpoints/${label}/1`], {
      maxBuffer: 1 << 20,
      okCodes: [0, 1, 128],
    })
    if (fmt.code !== 0) {
      throw new TypeError('label inválido')
    }
  }

  /**
   * Obtém o próximo número sequencial de ref sob o prefixo informado.
   *
   * @param {string} prefix
   * @returns {Promise<number>}
   */
  async function nextRefNumber(prefix) {
    const { text } = await run(['for-each-ref', '--format=%(refname)', prefix], {
      maxBuffer: 1 << 24,
    })
    return text === '' ? 1 : text.split('\n').length + 1
  }

  /**
   * Cria um commit apontando para a árvore especificada e atualiza a ref sequencialmente.
   *
   * @param {string} prefix
   * @param {string} tree
   * @param {string} message
   * @returns {Promise<{ ref: string, commit: string, n: number }>}
   */
  async function writeTreeRef(prefix, tree, message) {
    const head = await headInfo()
    const parents = head.commit ? ['-p', head.commit] : []
    const commit = (
      await run(['commit-tree', tree, ...parents, '-m', message], {
        maxBuffer: 1 << 20,
      })
    ).text
    const n = await nextRefNumber(prefix)
    const ref = `${prefix}/${n}`
    await run(['update-ref', ref, commit], { maxBuffer: 1 << 20 })
    return { ref, commit, n }
  }

  /**
   * Cria um checkpoint durável da árvore do worktree sob refs/ade/checkpoints/<label>/<n>.
   *
   * @param {string} label
   * @returns {Promise<CheckpointResult>}
   */
  async function checkpoint(label) {
    await assertLabel(label)
    const tree = await worktreeTree()
    const { ref, commit, n } = await writeTreeRef(
      `refs/ade/checkpoints/${label}`,
      tree,
      `ade checkpoint ${label}`,
    )
    return { ref, commit, tree, n }
  }

  /**
   * Restaura o worktree para a árvore especificada, salvando a árvore atual em refs/ade/discarded/<label>/<n>.
   *
   * ATENÇÃO (I20): A ordem de execução é obrigatoriamente `git clean -fd` e depois `git read-tree --reset -u`.
   * Inverter essa ordem apaga arquivo do operador; o arquivo ignorado apenas pela regra que está sendo descartada
   * tem de continuar no disco.
   *
   * @param {string} tree
   * @param {{ label: string }} options
   * @returns {Promise<RestoreTreeResult>}
   */
  async function restoreTree(tree, options) {
    if (typeof tree !== 'string' || !/^[0-9a-f]{40}$/.test(tree)) {
      throw new TypeError('tree inválida')
    }
    const label = options && typeof options === 'object' ? options.label : undefined
    await assertLabel(label)

    const probe = await run(['cat-file', '-t', tree], {
      maxBuffer: 1 << 20,
      okCodes: [0, 128],
    })
    if (probe.code !== 0 || probe.stdout.toString('utf8').trim() !== 'tree') {
      throw new GitError('not_a_tree', 'objeto não é uma árvore', { tree })
    }

    const current = await worktreeTree()
    const { ref: discardedRef } = await writeTreeRef(
      `refs/ade/discarded/${label}`,
      current,
      `ade discarded ${label}`,
    )

    await run(['clean', '-fd'], { maxBuffer: 1 << 26 })
    await run(['read-tree', '--reset', '-u', tree], { maxBuffer: 1 << 26 })

    return { tree, discardedRef }
  }

  /**
   * Lê uma ref local via git rev-parse.
   *
   * @param {string} ref
   * @returns {Promise<string | null>}
   */
  async function readLocalRef(ref) {
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new GitInvalidInputError('ref inválida')
    }
    const res = await run(['rev-parse', '--verify', ref], {
      maxBuffer: 1 << 20,
      okCodes: [0, 1, 128],
    })
    if (res.code === 0 && res.text) {
      return res.text
    }
    return null
  }

  /**
   * Lê uma ref remota via git ls-remote.
   *
   * @param {string} remote
   * @param {string} ref
   * @returns {Promise<string | null>}
   */
  async function readRemoteRef(remote, ref) {
    if (typeof remote !== 'string' || !remote.trim()) {
      throw new GitInvalidInputError('remote inválido')
    }
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new GitInvalidInputError('ref inválida')
    }
    const res = await run(['ls-remote', remote, ref], {
      maxBuffer: 1 << 20,
      okCodes: [0],
    })
    const text = res.text.trim()
    if (!text) {
      return null
    }
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      const [hash, name] = line.split(/\s+/)
      if (name === ref || name === `refs/heads/${ref}`) {
        return hash
      }
    }
    const [fallbackHash] = lines[0].split(/\s+/)
    return fallbackHash || null
  }

  /**
   * Executa fast-forward da branch base para o commit revisado.
   *
   * @param {string} baseRef
   * @param {string} reviewedCommit
   * @returns {Promise<{ commit: string }>}
   */
  async function fastForward(baseRef, reviewedCommit) {
    if (typeof baseRef !== 'string' || !baseRef.trim()) {
      throw new GitInvalidInputError('baseRef inválido')
    }
    if (typeof reviewedCommit !== 'string' || !reviewedCommit.trim()) {
      throw new GitInvalidInputError('reviewedCommit inválido')
    }
    const current = await headInfo()
    if (current.branch !== baseRef) {
      await run(['checkout', baseRef], { maxBuffer: 1 << 20 })
    }
    await run(['merge', '--ff-only', reviewedCommit], { maxBuffer: 1 << 20 })
    const commit = (await run(['rev-parse', 'HEAD'], { maxBuffer: 1 << 20 })).text
    return { commit }
  }

  return {
    worktreeDir,
    run,
    headInfo,
    gitPath,
    commit,
    worktreeTree,
    dirtyPaths,
    checkpoint,
    restoreTree,
    restore: restoreTree,
    readLocalRef,
    readRemoteRef,
    readRef: readRemoteRef,
    fastForward,
  }
}
