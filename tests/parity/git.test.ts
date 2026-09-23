import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeRepo, removeRepo } from '../helpers/git-repo.ts'
// Importações dos módulos da story (a implementar na fase 2)
import { createGitPort } from '../../src/git/gitport.ts'
import { AdeError, GitError } from '../../src/journal/errors.ts'

interface GitPortWithTreeAndDirty {
  worktreeDir: string
  run(args: string[], options?: { maxBuffer?: number; okCodes?: number[]; env?: Record<string, string | undefined> }): Promise<{ code: number; stdout: Buffer; stderr: string; text: string }>
  headInfo(): Promise<{ commit: string | null; branch: string | null; detached: boolean }>
  gitPath(name: string): Promise<string>
  commit(options: { message: string }): Promise<{ commit: string; tree: string }>
  worktreeTree(): Promise<string>
  dirtyPaths(): Promise<string[]>
}

interface GitPortWithCheckpointAndRestore extends GitPortWithTreeAndDirty {
  checkpoint(label: string): Promise<{ ref: string; commit: string; tree: string; n: number }>
  restoreTree(tree: string, options: { label: string }): Promise<{ tree: string; discardedRef: string }>
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

// Cada prova deste arquivo dispara dezenas de subprocessos do Git; no Windows, com a suíte
// inteira em paralelo, isso passa dos 5s padrão. Opção de timeout em describe() não é herdada
// pelas provas no vitest 2.x, por isso o ajuste vale para o arquivo.
vi.setConfig({ testTimeout: 30_000 })

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

  // AC1: Dado um worktree sujo, quando restoreTree(arvoreAnterior, {label}) roda,
  // então a árvore descartada continua recuperável por git rev-parse <ref>^{tree} sob refs/ade/discarded/.
  // AC3: Dado um id que existe mas não é árvore (um blob), quando restoreTree é chamado com ele,
  // então é lançado erro da família AdeError com motivo de objeto que não é árvore, sem tocar no worktree.
  test('discarded_tree_is_kept_under_a_ref', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir }) as unknown as GitPortWithCheckpointAndRestore

    // Validações de entrada: tree que não casa /^[0-9a-f]{40}$/ ou label inválido lançam TypeError
    await expect(port.restoreTree('naoehumarvore', { label: 'm1' })).rejects.toThrow(TypeError)
    await expect(port.restoreTree(123 as unknown as string, { label: 'm1' })).rejects.toThrow(TypeError)
    await expect(port.restoreTree('4b825dc642cb6eb9a060e54bf8d69288fbee4904', { label: '' })).rejects.toThrow(TypeError)
    await expect(port.restoreTree('4b825dc642cb6eb9a060e54bf8d69288fbee4904', { label: 'm1/..' })).rejects.toThrow(TypeError)

    // Cria commit base
    const fileA = path.join(repo.dir, 'file.txt')
    writeFileSync(fileA, 'base content\n')
    await port.commit({ message: 'initial base' })
    const baseTree = await port.worktreeTree()

    // AC3 e Exemplo: id de blob existente rejeita com GitError('not_a_tree'), code: 'git_not_a_tree', exitCode: 2 sem tocar no worktree
    const blobSha = repo.git(['rev-parse', 'HEAD:file.txt']).trim()
    const untouchedMarker = path.join(repo.dir, 'untouched.txt')
    writeFileSync(untouchedMarker, 'preserve this')
    let blobErr: unknown = null
    try {
      await port.restoreTree(blobSha, { label: 'm1' })
    } catch (err) {
      blobErr = err
    }
    expect(blobErr).toBeInstanceOf(AdeError)
    expect(blobErr).toBeInstanceOf(GitError)
    expect((blobErr as GitError).code).toBe('git_not_a_tree')
    expect((blobErr as GitError).exitCode).toBe(2)
    // Sem tocar no worktree
    expect(existsSync(untouchedMarker)).toBe(true)
    rmSync(untouchedMarker)

    // Modifica o worktree para deixá-lo sujo
    writeFileSync(fileA, 'modified content\n')
    const untrackedFile = path.join(repo.dir, 'extra.txt')
    writeFileSync(untrackedFile, 'extra untracked\n')
    const dirtyTree = await port.worktreeTree()
    expect(dirtyTree).not.toBe(baseTree)

    // AC1 e Exemplo: worktree sujo -> await port.restoreTree(base, {label:'m1'})
    const restoreResult = await port.restoreTree(baseTree, { label: 'm1' })
    expect(restoreResult).toEqual({
      tree: baseTree,
      discardedRef: 'refs/ade/discarded/m1/1',
    })

    // git rev-parse refs/ade/discarded/m1/1^{tree} devolve a árvore suja
    const savedDiscardedTree = repo.git(['rev-parse', 'refs/ade/discarded/m1/1^{tree}']).trim()
    expect(savedDiscardedTree).toBe(dirtyTree)

    // Confirma restauração no disco
    expect(readFileSync(fileA, 'utf8')).toBe('base content\n')
    expect(existsSync(untrackedFile)).toBe(false)
  })

  // AC2: Dado um .gitignore não commitado que ignora notes.txt e o próprio notes.txt no disco,
  // quando a árvore anterior (sem esse .gitignore) é restaurada,
  // então notes.txt continua no disco e o .gitignore some.
  test('restore_keeps_a_file_ignored_only_by_the_discarded_rules', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir }) as unknown as GitPortWithCheckpointAndRestore

    // Commit inicial sem .gitignore
    writeFileSync(path.join(repo.dir, 'app.js'), 'console.log("hello")\n')
    await port.commit({ message: 'commit inicial' })
    const base = await port.worktreeTree()

    // Escrever .gitignore com notes.txt e escrever notes.txt
    const gitignorePath = path.join(repo.dir, '.gitignore')
    const notesPath = path.join(repo.dir, 'notes.txt')
    writeFileSync(gitignorePath, 'notes.txt\n')
    writeFileSync(notesPath, 'anotações importantes do operador\n')

    // Restaura a árvore base com label 'm/s'
    const result = await port.restoreTree(base, { label: 'm/s' })
    expect(result.tree).toBe(base)
    expect(result.discardedRef).toBe('refs/ade/discarded/m/s/1')

    // Exigir existsSync(notes.txt) === true e existsSync(.gitignore) === false
    expect(existsSync(notesPath)).toBe(true)
    expect(readFileSync(notesPath, 'utf8')).toBe('anotações importantes do operador\n')
    expect(existsSync(gitignorePath)).toBe(false)
  })

  // AC4: Dado dois checkpoints seguidos com o mesmo rótulo,
  // quando ambos terminam, então existem duas refs distintas numeradas em sequência sob refs/ade/checkpoints/.
  test('checkpoint_allocates_sequential_refs_for_same_label', async () => {
    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const port = createGitPort({ worktreeDir: repo.dir }) as unknown as GitPortWithCheckpointAndRestore

    // Validação de rótulo inválido: lança TypeError e nenhuma ref nova aparece sob refs/ade/
    const refsBefore = repo.git(['for-each-ref', '--format=%(refname)', 'refs/ade/']).trim()
    await expect(port.checkpoint('')).rejects.toThrow(TypeError)
    await expect(port.checkpoint(123 as unknown as string)).rejects.toThrow(TypeError)
    await expect(port.checkpoint('m1/..')).rejects.toThrow(TypeError)
    const refsAfter = repo.git(['for-each-ref', '--format=%(refname)', 'refs/ade/']).trim()
    expect(refsAfter).toBe(refsBefore)

    // Cria commit base para HEAD existir
    writeFileSync(path.join(repo.dir, 'tracked.txt'), 'tracked\n')
    await port.commit({ message: 'primeiro commit' })

    // Exemplo e AC4: Primeiro checkpoint sob o rótulo 'm1/s1'
    const cp1 = await port.checkpoint('m1/s1')
    expect(cp1.ref).toBe('refs/ade/checkpoints/m1/s1/1')
    expect(cp1.n).toBe(1)
    expect(cp1.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(cp1.tree).toMatch(/^[0-9a-f]{40}$/)

    // Modifica o arquivo para gerar novo estado de árvore
    writeFileSync(path.join(repo.dir, 'tracked.txt'), 'tracked alterado\n')

    // Segundo checkpoint logo depois sob o mesmo rótulo
    const cp2 = await port.checkpoint('m1/s1')
    expect(cp2.ref).toBe('refs/ade/checkpoints/m1/s1/2')
    expect(cp2.n).toBe(2)
    expect(cp2.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(cp2.tree).toMatch(/^[0-9a-f]{40}$/)
    expect(cp2.commit).not.toBe(cp1.commit)
    expect(cp2.tree).not.toBe(cp1.tree)

    // Verifica que ambas as refs existem no git real
    const allRefs = repo.git(['for-each-ref', '--format=%(refname)', 'refs/ade/checkpoints/m1/s1/']).trim().split('\n')
    expect(allRefs).toEqual([
      'refs/ade/checkpoints/m1/s1/1',
      'refs/ade/checkpoints/m1/s1/2',
    ])
  })
})

