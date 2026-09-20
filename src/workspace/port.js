import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { AdeError } from '../journal/errors.js'

/** Bloco lido do disco por vez: a leitura nunca materializa o arquivo inteiro. */
const CHUNK_BYTES = 64 * 1024

/**
 * Sinaliza recusa de caminho que escapa da raiz do workspace (lexical ou via symlink).
 */
export class WorkspacePathError extends AdeError {
  /**
   * @param {string} relPath
   * @param {string} reason
   */
  constructor(relPath, reason) {
    super('workspace_path_invalid', `caminho fora do workspace ou invalid: ${relPath} (${reason})`, 4, {
      path: relPath,
      reason,
    })
  }
}

/**
 * Sinaliza configuração obrigatória ausente ao abrir um workspace.
 */
export class WorkspaceConfigError extends AdeError {
  /**
   * @param {string} field
   */
  constructor(field) {
    super('workspace_config_missing', `configuração de workspace ausente ou inválida: ${field}`, 4, {
      field,
    })
  }
}

/**
 * Sinaliza método de porta não implementado pela subclasse.
 */
export class WorkspaceNotImplementedError extends AdeError {
  /**
   * @param {string} method
   */
  constructor(method) {
    super('workspace_not_implemented', `${method}() deve ser implementado pela subclasse`, 4, { method })
  }
}

/**
 * Sinaliza falha operacional ao ler um arquivo contido no workspace.
 */
export class WorkspaceReadError extends AdeError {
  /**
   * @param {string} relPath
   * @param {string} reason
   */
  constructor(relPath, reason) {
    super('workspace_read_failed', `falha ao ler ${relPath}: ${reason}`, 2, { path: relPath, reason })
  }
}

/**
 * Converte falha nativa de fs em WorkspaceReadError, preservando a causa.
 *
 * @template T
 * @param {() => T} op
 * @param {string} relPath
 * @returns {T}
 */
function fsOrFail(op, relPath) {
  try {
    return op()
  } catch (err) {
    const cause = /** @type {NodeJS.ErrnoException} */ (err)
    throw new WorkspaceReadError(relPath, cause.code ? `${cause.code}: ${cause.message}` : cause.message)
  }
}

/**
 * @param {string} resolved
 * @param {string} relPath
 * @returns {fs.Stats}
 */
function statOrFail(resolved, relPath) {
  return fsOrFail(() => fs.statSync(resolved), relPath)
}

/**
 * @param {string} resolved
 * @param {string} relPath
 * @returns {string}
 */
function readFileOrFail(resolved, relPath) {
  return fsOrFail(() => fs.readFileSync(resolved, 'utf8'), relPath)
}

/**
 * Lista as entradas de um diretório, convertendo falha nativa em WorkspaceReadError.
 *
 * @param {string} dir
 * @param {string} relPath
 * @returns {fs.Dirent[]}
 */
export function readDirOrFail(dir, relPath) {
  return fsOrFail(() => fs.readdirSync(dir, { withFileTypes: true }), relPath)
}

export { readFileOrFail }

/**
 * Resolve um caminho relativo contido na raiz, recusando travessia lexical e por symlink.
 *
 * @param {string} rootDir
 * @param {string} relPath
 * @returns {string}
 */
export function resolveContained(rootDir, relPath) {
  if (!relPath || typeof relPath !== 'string' || path.isAbsolute(relPath)) {
    throw new WorkspacePathError(String(relPath), 'caminho relativo obrigatório')
  }
  const resolved = path.resolve(rootDir, relPath)
  const rel = path.relative(rootDir, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspacePathError(relPath, 'escapa da raiz')
  }

  const realRoot = fsOrFail(() => fs.realpathSync(rootDir), relPath)
  const realPath = fsOrFail(() => fs.realpathSync(resolved), relPath)
  const realRel = path.relative(realRoot, realPath)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new WorkspacePathError(relPath, 'alvo real fora da raiz (symlink)')
  }
  return realPath
}

/**
 * Lê somente as linhas [offset, offset+limit) de um arquivo, em blocos de CHUNK_BYTES.
 *
 * Para de ler assim que a janela fecha e uma linha além é vista (basta ela para saber
 * que há continuação): o arquivo inteiro nunca é carregado em memória.
 *
 * @param {string} resolved
 * @param {string} relPath
 * @param {number} offset
 * @param {number} limit
 * @returns {{ items: string[], hasMore: boolean }}
 */
function readLineWindow(resolved, relPath, offset, limit) {
  const fd = fsOrFail(() => fs.openSync(resolved, 'r'), relPath)
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  /** @type {string[]} */
  const items = []
  let pending = ''
  let index = 0
  let hasMore = false

  try {
    scan: for (;;) {
      const bytes = fsOrFail(() => fs.readSync(fd, buf, 0, CHUNK_BYTES, null), relPath)
      if (bytes === 0) {
        // Última linha: split('\n') sempre devolve o resto, mesmo vazio.
        pending += decoder.end()
        if (index >= offset) {
          if (items.length < limit) {
            items.push(pending)
          } else {
            hasMore = true
          }
        }
        break
      }
      pending += decoder.write(buf.subarray(0, bytes))
      for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (index >= offset) {
          if (items.length >= limit) {
            hasMore = true
            break scan
          }
          items.push(line)
        }
        index++
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  return { items, hasMore }
}

/**
 * Lê um trecho paginado de um arquivo contido na raiz do workspace.
 *
 * @param {string} rootDir
 * @param {string} relPath
 * @param {{ offset?: number, limit?: number }} [range]
 * @returns {{ summary: string, items: string[], next_cursor: number | null, raw_ref: string }}
 */
export function readContained(rootDir, relPath, range) {
  const resolved = resolveContained(rootDir, relPath)
  const stat = statOrFail(resolved, relPath)
  if (!stat.isFile()) {
    throw new WorkspaceReadError(relPath, 'não é um arquivo')
  }
  const offset = range?.offset ?? 0
  const limit = range?.limit ?? Number.POSITIVE_INFINITY
  const limitInvalid = limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)
  if (!Number.isInteger(offset) || offset < 0 || limitInvalid) {
    throw new WorkspacePathError(relPath, 'offset ou limit inválido')
  }
  const { items, hasMore } = readLineWindow(resolved, relPath, offset, limit)
  const next_cursor = hasMore ? offset + items.length : null
  const normalizedRel = relPath.replace(/\\/g, '/')

  return {
    summary: `Lido ${items.length} linhas de ${normalizedRel}`,
    items,
    next_cursor,
    raw_ref: `file:${normalizedRel}`,
  }
}

/**
 * Interface base para portas de workspace.
 */
export class WorkspacePort {
  /**
   * Obtém o snapshot determinístico da árvore do workspace.
   * @returns {Promise<{ revision: string, digest: string, paths: string[] }>}
   */
  async snapshot() {
    throw new WorkspaceNotImplementedError('snapshot')
  }

  /**
   * Lê um trecho limitado de um arquivo do workspace.
   * @param {string} _relPath
   * @param {{ offset?: number, limit?: number }} [_range]
   * @returns {Promise<{ summary: string, items: string[], next_cursor: number | null, raw_ref: string }>}
   */
  async read(_relPath, _range) {
    throw new WorkspaceNotImplementedError('read')
  }
}
