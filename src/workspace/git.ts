import path from 'node:path'
import { WorkspacePort, WorkspaceConfigError, readContained } from './port.ts'
import { createGitPort } from '../git/gitport.ts'
import { digest16 } from '../journal/canonical.ts'

const INTERNAL_PREFIXES = ['.ade/', 'node_modules/']

export class GitWorkspace extends WorkspacePort {
  worktreeDir: string
  gitPort: ReturnType<typeof createGitPort>

  constructor({ worktreeDir, gitPort }: { worktreeDir: string; gitPort?: ReturnType<typeof createGitPort> }) {
    super()
    if (!worktreeDir || typeof worktreeDir !== 'string') {
      throw new WorkspaceConfigError('worktreeDir')
    }
    this.worktreeDir = path.resolve(worktreeDir)
    this.gitPort = gitPort || createGitPort({ worktreeDir: this.worktreeDir })
  }

  async snapshot(): Promise<{ revision: string; digest: string; paths: string[] }> {
    const head = await this.gitPort.headInfo()
    const revision = head.commit || 'HEAD'

    // -z: nomes separados por NUL. O Buffer bruto preserva espaços nas extremidades
    // que `text` perderia no trim().
    const ls = await this.gitPort.run(['ls-files', '-z', '-c', '-o', '--exclude-standard'], {
      maxBuffer: 1 << 26,
    })
    const paths = ls.stdout.toString('utf8').split('\0')
      .filter((p: string) => p.length > 0)
      .filter((p: string) => !INTERNAL_PREFIXES.some((prefix) => p.startsWith(prefix)))
      .sort()

    const tree = await this.gitPort.worktreeTree()
    const digest = digest16({ revision, tree, paths })

    return { revision, digest, paths }
  }

  async read(relPath: string, range?: { offset?: number; limit?: number }): Promise<{ summary: string; items: string[]; next_cursor: number|null; raw_ref: string }> {
    return readContained(this.worktreeDir, relPath, range)
  }
}
