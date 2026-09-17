import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
// Importações dos módulos da story (a implementar na fase 2)
import { createGitPort } from '../../src/git/gitport.js'
import { AdeError, GitError } from '../../src/journal/errors.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeRepo(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

describe('git port parity', () => {
  // AC1, AC2 e exemplos de hooks, headInfo, run e validação de entrada
  test('repository_hooks_do_not_run_inside_runtime_git_commands', async () => {
    // Exemplo: createGitPort({ worktreeDir: 42 }) lança TypeError
    expect(() => createGitPort({ worktreeDir: 42 as unknown as string })).toThrow(TypeError)
    expect(() => createGitPort({ worktreeDir: '' })).toThrow(TypeError)
    expect(() => createGitPort({} as unknown as { worktreeDir: string })).toThrow(TypeError)

    const repo = makeRepo()
    tmpDirs.push(repo.dir)

    const port = createGitPort({ worktreeDir: repo.dir })
    expect(port.worktreeDir).toBe(repo.dir)

    // Exemplo: repositório recém-init sem commit -> headInfo() devolve commit: null, branch: 'main', detached: false
    const emptyHead = await port.headInfo()
    expect(emptyHead).toEqual({ commit: null, branch: 'main', detached: false })

    // AC1: Dado um repositório com hook pre-commit que grava um marcador e sai 1
    const hooksDir = path.join(repo.dir, '.git', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = path.join(hooksDir, 'pre-commit')
    const hookScript = '#!/bin/sh\necho ran > "$(dirname "$0")/../../hook-ran.txt"\nexit 1\n'
    writeFileSync(hookPath, hookScript, { mode: 0o755 })
    try {
      chmodSync(hookPath, 0o755)
    } catch {
      // ignora em plataformas sem suporte fino a chmod
    }

    const markerPath = path.join(repo.dir, 'hook-ran.txt')
    expect(existsSync(markerPath)).toBe(false)

    // Snapshot de process.env antes
    const envSnapshotBefore = { ...process.env }

    // Cria um arquivo e tenta commitar
    writeFileSync(path.join(repo.dir, 'committed.txt'), 'conteúdo\n')

    // Quando commit({message}) é chamado: então o commit é criado, o marcador não existe
    // e o snapshot de process.env é idêntico antes e depois
    const commitResult = await port.commit({ message: 'primeiro commit' })
    expect(commitResult).toBeDefined()
    expect(commitResult.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(commitResult.tree).toMatch(/^[0-9a-f]{40}$/)

    // Marcador do hook pre-commit não deve existir (hook não rodou)
    expect(existsSync(markerPath)).toBe(false)

    // Snapshot do env inalterado
    expect(process.env).toEqual(envSnapshotBefore)

    // Exemplo: repositório com um commit -> headInfo() devolve o hash de 40 hex, branch 'main', detached: false
    const headWithCommit = await port.headInfo()
    expect(headWithCommit).toEqual({
      commit: commitResult.commit,
      branch: 'main',
      detached: false,
    })

    // AC2: Dado um comando que passa env próprio tentando reativar hooks,
    // quando ele roda, então o isolamento de hooks continua valendo e o hook não executa
    const statusResult = await port.run(['status', '--porcelain'], {
      maxBuffer: 1 << 20,
      env: { GIT_CONFIG_COUNT: '0' },
    })
    expect(statusResult.code).toBe(0)
    expect(existsSync(markerPath)).toBe(false)

    // Para provar que o isolamento vence mesmo em comandos que disparam hooks,
    // cria uma alteração e executa commit com env tentando reativar hooks (GIT_CONFIG_COUNT: '0')
    writeFileSync(path.join(repo.dir, 'committed_bypass.txt'), 'conteúdo 2\n')
    await port.run(['add', '-A'], { maxBuffer: 1 << 26 })
    const commitWithEnvResult = await port.run(
      ['commit', '-m', 'commit tentando override de env'],
      {
        maxBuffer: 1 << 24,
        env: {
          GIT_CONFIG_COUNT: '0',
          GIT_CONFIG_KEY_0: '',
          GIT_CONFIG_VALUE_0: '',
        },
      },
    )
    expect(commitWithEnvResult.code).toBe(0)
    expect(existsSync(markerPath)).toBe(false)

    // Exemplo: comando com erro de saída nonzero rejeita com GitError code 'git_exit_nonzero' e exitCode 2
    let nonzeroErr: unknown = null
    try {
      await port.run(['rev-parse', '--verify', 'refs/heads/inexistente'], { maxBuffer: 1 << 20 })
    } catch (err) {
      nonzeroErr = err
    }
    expect(nonzeroErr).toBeInstanceOf(GitError)
    expect(nonzeroErr).toBeInstanceOf(AdeError)
    expect((nonzeroErr as GitError).code).toBe('git_exit_nonzero')
    expect((nonzeroErr as GitError).exitCode).toBe(2)
  })

  // AC3: Dado um worktree linkado (.git é arquivo, criado por git worktree add),
  // quando um GitPort é criado sobre ele, então headInfo() devolve o commit correto
  // e gitPath('index') devolve um caminho absoluto existente.
  test('linked_worktree_is_supported', async () => {
    const mainRepo = makeRepo()
    tmpDirs.push(mainRepo.dir)

    // Cria commit base no repo principal
    writeFileSync(path.join(mainRepo.dir, 'base.txt'), 'base content\n')
    mainRepo.git(['add', '-A'])
    mainRepo.git(['commit', '-m', 'commit base'])
    const baseCommit = mainRepo.git(['rev-parse', 'HEAD']).trim()

    // Cria worktree linkado
    const wtDir = mkdtempSync(path.join(os.tmpdir(), 'ade-wt-'))
    tmpDirs.push(wtDir)
    // remove pasta criada por mkdtemp para que git worktree add possa criá-la/usá-la
    rmSync(wtDir, { recursive: true, force: true })

    mainRepo.git(['worktree', 'add', wtDir, '-b', 'unit-story'])

    // Confirma que é worktree linkado (.git é arquivo)
    const dotGitPath = path.join(wtDir, '.git')
    expect(existsSync(dotGitPath)).toBe(true)
    expect(statSync(dotGitPath).isFile()).toBe(true)

    const wtPort = createGitPort({ worktreeDir: wtDir })
    expect(wtPort.worktreeDir).toBe(wtDir)

    // headInfo() devolve o commit correto
    const wtHead = await wtPort.headInfo()
    expect(wtHead).toEqual({
      commit: baseCommit,
      branch: 'unit-story',
      detached: false,
    })

    // gitPath('index') devolve caminho absoluto existente
    const indexPath = await wtPort.gitPath('index')
    expect(path.isAbsolute(indexPath)).toBe(true)
    expect(existsSync(indexPath)).toBe(true)
  })
})
