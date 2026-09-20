import path from 'node:path'
import { WorkspacePort, WorkspaceConfigError, readContained } from './port.js'
import { createGitPort } from '../git/gitport.js'
import { digest16 } from '../journal/canonical.js'

const INTERNAL_PREFIXES = ['.ade/', 'node_modules/']

export class GitWorkspace extends WorkspacePort {
  /**
   * @param {{ worktreeDir: string, gitPort?: any }} options
   */
  constructor({ worktreeDir, gitPort }) {
    super()
    if (!worktreeDir || typeof worktreeDir !== 'string') {
      throw new WorkspaceConfigError('worktreeDir')
    }
    this.worktreeDir = path.resolve(worktreeDir)
    this.gitPort = gitPort || createGitPort({ worktreeDir: this.worktreeDir })
  }

  /**
   * @returns {Promise<{ revision: string, digest: string, paths: string[] }>}
   */
  async snapshot() {
    const head = await this.gitPort.headInfo()
    const revision = head.commit || 'HEAD'

    // -z: nomes separados por NUL. O Buffer bruto preserva espaços nas extremidades
    // que `text` perderia no trim().
    const ls = await this.gitPort.run(['ls-files', '-z', '-c', '-o', '--exclude-standard'], {
      maxBuffer: 1 << 26,
    })
    const paths = ls.stdout.toString('utf8').split('\0')
      .filter((/** @type {string} */ p) => p.length > 0)
      .filter((/** @type {string} */ p) => !INTERNAL_PREFIXES.some((prefix) => p.startsWith(prefix)))
      .sort()

    const tree = await this.gitPort.worktreeTree()
    const digest = digest16({ revision, tree, paths })

    return { revision, digest, paths }
  }

  /**
   * @param {string} relPath
   * @param {{ offset?: number, limit?: number }} [range]
   * @returns {Promise<{ summary: string, items: string[], next_cursor: number | null, raw_ref: string }>}
   */
  async read(relPath, range) {
    return readContained(this.worktreeDir, relPath, range)
  }
}
