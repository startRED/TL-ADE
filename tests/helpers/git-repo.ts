import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface GitRepo {
  dir: string
  git(args: string[]): string
}

export function makeRepo(): { dir: string; git(args: string[]): string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-git-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      maxBuffer: 1 << 26,
      encoding: 'utf8',
    })

  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'ADE Test'])
  git(['config', 'user.email', 'ade@test.local'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'core.autocrlf', 'false'])

  return { dir, git }
}

export function removeRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
