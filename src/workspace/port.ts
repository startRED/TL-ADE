import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { AdeError } from '../journal/errors.ts'

/** Bloco lido do disco por vez: a leitura nunca materializa o arquivo inteiro. */
const CHUNK_BYTES = 64 * 1024

/**
 * Sinaliza recusa de caminho que escapa da raiz do workspace (lexical ou via symlink).
 */
export class WorkspacePathError extends AdeError {
  constructor(relPath: string, reason: string) {
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
  constructor(field: string) {
    super('workspace_config_missing', `configuração de workspace ausente ou inválida: ${field}`, 4, {
      field,
    })
  }
}

/**
 * Sinaliza método de porta não implementado pela subclasse.
 */
export class WorkspaceNotImplementedError extends AdeError {
  constructor(method: string) {
    super('workspace_not_implemented', `${method}() deve ser implementado pela subclasse`, 4, { method })
  }
}

/**
 * Sinaliza falha operacional ao ler um arquivo contido no workspace.
 */
export class WorkspaceReadError extends AdeError {
  constructor(relPath: string, reason: string) {
    super('workspace_read_failed', `falha ao ler ${relPath}: ${reason}`, 2, { path: relPath, reason })
  }
}

/**
 * Converte falha nativa de fs em WorkspaceReadError, preservando a causa.
 *
 * @template T
 */
function fsOrFail<T>(op: () => T, relPath: string): T {
  try {
    return op()
  } catch (err) {
    const cause = (err as NodeJS.ErrnoException)
    throw new WorkspaceReadError(relPath, cause.code ? `${cause.code}: ${cause.message}` : cause.message)
  }
}

function statOrFail(resolved: string, relPath: string): fs.Stats {
  return fsOrFail(() => fs.statSync(resolved), relPath)
}

function readFileOrFail(resolved: string, relPath: string): string {
  return fsOrFail(() => fs.readFileSync(resolved, 'utf8'), relPath)
}

/**
 * Lista as entradas de um diretório, convertendo falha nativa em WorkspaceReadError.
 *
 */
export function readDirOrFail(dir: string, relPath: string): fs.Dirent[] {
  return fsOrFail(() => fs.readdirSync(dir, { withFileTypes: true }), relPath)
}

export { readFileOrFail }

/**
 * Resolve um caminho relativo contido na raiz, recusando travessia lexical e por symlink.
 *
 */
export function resolveContained(rootDir: string, relPath: string): string {
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
 */
function readLineWindow(resolved: string, relPath: string, offset: number, limit: number): { items: string[]; hasMore: boolean } {
  const fd = fsOrFail(() => fs.openSync(resolved, 'r'), relPath)
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  const items: string[] = []
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
 */
export function readContained(rootDir: string, relPath: string, range?: { offset?: number; limit?: number }): { summary: string; items: string[]; next_cursor: number|null; raw_ref: string } {
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
   */
  async snapshot(): Promise<{ revision: string; digest: string; paths: string[] }> {
    throw new WorkspaceNotImplementedError('snapshot')
  }

  /**
   * Lê um trecho limitado de um arquivo do workspace.
   */
  async read(_relPath: string, _range?: { offset?: number; limit?: number }): Promise<{ summary: string; items: string[]; next_cursor: number|null; raw_ref: string }> {
    throw new WorkspaceNotImplementedError('read')
  }
}
