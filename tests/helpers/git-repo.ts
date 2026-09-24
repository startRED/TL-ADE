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
  // Configuração pela interface suportada do Git: `git config` acha o arquivo certo mesmo quando
  // `.git` é arquivo (worktree linkado), o que escrever em `.git/config` na mão não faz.
  for (const [key, value] of [
    ['user.name', 'ADE Test'],
    ['user.email', 'ade@test.local'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ]) {
    git(['config', key, value])
  }

  return { dir, git }
}

export function removeRepo(dir: string): void {
  // Windows segura por instantes os arquivos que o servidor do painel acabou de ler (EPERM na limpeza): tenta de novo
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
