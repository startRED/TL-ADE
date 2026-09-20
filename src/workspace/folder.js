import path from 'node:path'
import { WorkspacePort, WorkspaceConfigError, readContained, readDirOrFail, readFileOrFail } from './port.js'
import { digest16 } from '../journal/canonical.js'

/**
 * @param {string} dir
 * @param {string} baseDir
 * @param {string[]} [results]
 * @returns {string[]}
 */
function walkDir(dir, baseDir, results = []) {
  const entries = readDirOrFail(dir, path.relative(baseDir, dir).replace(/\\/g, '/') || '.')
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.ade') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      // Symlink não entra no snapshot: seu alvo pode estar fora da raiz.
      continue
    }
    if (entry.isDirectory()) {
      walkDir(full, baseDir, results)
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, full).replace(/\\/g, '/')
      results.push(rel)
    }
  }
  return results
}

export class FolderWorkspace extends WorkspacePort {
  /**
   * @param {{ rootDir: string }} options
   */
  constructor({ rootDir }) {
    super()
    if (!rootDir || typeof rootDir !== 'string') {
      throw new WorkspaceConfigError('rootDir')
    }
    this.rootDir = path.resolve(rootDir)
  }

  /**
   * @returns {Promise<{ revision: string, digest: string, paths: string[] }>}
   */
  async snapshot() {
    const paths = walkDir(this.rootDir, this.rootDir).sort()
    const entries = paths.map((p) => {
      const fullPath = path.join(this.rootDir, p)
      const content = readFileOrFail(fullPath, p)
      return { path: p, contentDigest: digest16(content) }
    })
    const digest = digest16(entries)
    const revision = `folder:${digest}`
    return { revision, digest, paths }
  }

  /**
   * @param {string} relPath
   * @param {{ offset?: number, limit?: number }} [range]
   * @returns {Promise<{ summary: string, items: string[], next_cursor: number | null, raw_ref: string }>}
   */
  async read(relPath, range) {
    return readContained(this.rootDir, relPath, range)
  }
}
