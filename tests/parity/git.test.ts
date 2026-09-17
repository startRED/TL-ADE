import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
// Importações dos módulos da story (a implementar na fase 2)
import { createGitPort } from '../../src/git/gitport.js'
import { AdeError, GitError } from '../../src/journal/errors.js'

interface GitPortWithTreeAndDirty {
  worktreeDir: string
  run(args: string[], options?: { maxBuffer?: number; okCodes?: number[]; env?: Record<string, string | undefined> }): Promise<{ code: number; stdout: Buffer; stderr: string; text: string }>
  headInfo(): Promise<{ commit: string | null; branch: string | null; detached: boolean }>
  gitPath(name: string): Promise<string>
  commit(options: { message: string }): Promise<{ commit: string; tree: string }>
  worktreeTree(): Promise<string>
  dirtyPaths(): Promise<string[]>
}

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

  // AC1: Dado um arquivo reescrito com o mesmo tamanho dentro do mesmo segundo,
  // quando worktreeTree() é chamado antes e depois, então os dois ids de árvore são diferentes.
  // Exemplos: árvore vazia e worktree limpo devolvem a árvore correta.
  test('worktree_tree_sees_a_same_size_rewrite_within_one_second', async () => {
    // Exemplo: repositório sem nenhum commit e sem arquivo -> await port.worktreeTree() -> '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const emptyRepo = makeRepo()
    tmpDirs.push(emptyRepo.dir)
    const emptyPort = createGitPort({ worktreeDir: emptyRepo.dir }) as unknown as GitPortWithTreeAndDirty
    const emptyTree = await emptyPort.worktreeTree()
    expect(emptyTree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')

    // Repositório com arquivo inicial commitado
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir }) as unknown as GitPortWithTreeAndDirty

    const filePath = path.join(repo.dir, 'test.txt')
    writeFileSync(filePath, 'aaaa')
    await port.commit({ message: 'initial commit' })

    // AC3 (parte): Dado um worktree sem alteração alguma, quando worktreeTree() é chamado,
    // então devolve a mesma árvore de HEAD
    const headTree = (await port.run(['rev-parse', 'HEAD^{tree}'], { maxBuffer: 1 << 20 })).text
    const cleanTree = await port.worktreeTree()
    expect(cleanTree).toBe(headTree)

    // AC1 e Exemplo: writeFileSync(f,'aaaa') -> tree T1; writeFileSync(f,'bbbb') no mesmo segundo -> tree T2, com T1 !== T2
    const t1 = await port.worktreeTree()
    writeFileSync(filePath, 'bbbb')
    const t2 = await port.worktreeTree()
    expect(t1).toMatch(/^[0-9a-f]{40}$/)
    expect(t2).toMatch(/^[0-9a-f]{40}$/)
    expect(t1).not.toBe(t2)
  })

  // AC2: Dado um arquivo renomeado de secrets/x para pkg/x e já registrado no índice,
  // quando dirtyPaths() é chamado, então a lista contém os dois caminhos.
  // Exemplos: repositório limpo -> [] e arquivo novo não rastreado -> ['pkg/a.txt'].
  test('rename_out_of_scope_into_scope_is_contained', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir }) as unknown as GitPortWithTreeAndDirty

    // Cria commit inicial com secrets/x
    const secretsDir = path.join(repo.dir, 'secrets')
    mkdirSync(secretsDir, { recursive: true })
    writeFileSync(path.join(secretsDir, 'x'), 'secret content')
    await port.commit({ message: 'add secret' })

    // AC3 (parte) e Exemplo: repositório limpo com um commit -> await port.dirtyPaths() -> []
    const cleanDirty = await port.dirtyPaths()
    expect(cleanDirty).toEqual([])

    // Exemplo: arquivo novo pkg/a.txt não rastreado -> await port.dirtyPaths() -> ['pkg/a.txt']
    const pkgDir = path.join(repo.dir, 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'a.txt'), 'untracked content')
    const untrackedDirty = await port.dirtyPaths()
    expect(untrackedDirty).toEqual(['pkg/a.txt'])

    // Remove arquivo não rastreado para isolar o rename
    rmSync(path.join(pkgDir, 'a.txt'))

    // AC2 e Exemplo: git mv secrets/x pkg/x -> await port.dirtyPaths() -> ['pkg/x', 'secrets/x']
    repo.git(['mv', 'secrets/x', 'pkg/x'])
    const renameDirty = await port.dirtyPaths()
    expect(renameDirty).toContain('secrets/x')
    expect(renameDirty).toContain('pkg/x')
    expect(renameDirty).toEqual(['pkg/x', 'secrets/x'])
  })
})

