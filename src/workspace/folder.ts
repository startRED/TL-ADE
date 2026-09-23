import path from 'node:path'
import { WorkspacePort, WorkspaceConfigError, readContained, readDirOrFail, readFileOrFail } from './port.ts'
import { digest16 } from '../journal/canonical.ts'

function walkDir(dir: string, baseDir: string, results: string[] = []): string[] {
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
  rootDir: string

  constructor({ rootDir }: { rootDir: string }) {
    super()
    if (!rootDir || typeof rootDir !== 'string') {
      throw new WorkspaceConfigError('rootDir')
    }
    this.rootDir = path.resolve(rootDir)
  }

  async snapshot(): Promise<{ revision: string; digest: string; paths: string[] }> {
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

  async read(relPath: string, range?: { offset?: number; limit?: number }): Promise<{ summary: string; items: string[]; next_cursor: number|null; raw_ref: string }> {
    return readContained(this.rootDir, relPath, range)
  }
}
