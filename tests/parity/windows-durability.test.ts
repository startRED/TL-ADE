import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { contain } from '../../src/contain/contain.js'
import { createGitPort } from '../../src/git/gitport.js'
import { isProcessAlive } from '../../src/lease/process-info.js'
import { readReceipt } from '../../src/runner/receipt.js'
import { resolveBinary } from '../../src/runner/resolve-binary.js'
import { killTree, runWorker } from '../../src/runner/spawn.js'
import { makeRepo, removeRepo } from '../helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'

describe('windows durability parity', () => {
  let tmpDir: string
  let repoDir: string | null = null

  beforeEach(() => {
    tmpDir = makeTmpDir('ade-win-dur-')
  })

  afterEach(() => {
    if (repoDir) {
      try {
        removeRepo(repoDir)
      } catch {
        // ignora
      }
      repoDir = null
    }
    removeTmpDir(tmpDir)
  })

  // (1) CA1 — Dado um shim npm reconhecido ou desconhecido no Windows, quando é resolvido,
  // então o executável real usa shell desativado; o fallback desconhecido usa cmd.exe /c com argumentos preservados.
  test('ca1_shim_resolution_preserves_arguments_and_disables_shell', async () => {
    // Exemplo: shim npm conhecido para node.exe -> {exe:'node.exe',prefixArgs:['script.mjs'],via:'shim',mode:'npm_shim'}
    const nodeExe = path.join(tmpDir, 'node.exe')
    fs.writeFileSync(nodeExe, 'binary', 'utf8')
    const scriptMjs = path.join(tmpDir, 'script.mjs')
    fs.writeFileSync(scriptMjs, '// script', 'utf8')

    const npmShimCmd = path.join(tmpDir, 'tool-npm.cmd')
    fs.writeFileSync(
      npmShimCmd,
      '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\script.mjs" %*\r\n)\r\n',
      'utf8',
    )

    const resolvedNpm = resolveBinary('tool-npm', {
      platform: 'win32',
      pathEnv: tmpDir,
    })

    expect({
      exe: path.basename(resolvedNpm.exe),
      prefixArgs: resolvedNpm.prefixArgs.map((p) => path.basename(p)),
      via: resolvedNpm.via,
      mode: resolvedNpm.mode,
    }).toEqual({
      exe: 'node.exe',
      prefixArgs: ['script.mjs'],
      via: 'shim',
      mode: 'npm_shim',
    })

    // Exemplo: shim desconhecido C:\tmp\tool.cmd -> {exe:'cmd.exe',prefixArgs:['/d','/s','/c','C:\\tmp\\tool.cmd'],via:'cmd',mode:'cmd_fallback'}
    const unknownToolCmd = path.join(tmpDir, 'tool.cmd')
    fs.writeFileSync(unknownToolCmd, '@echo off\r\necho unknown\r\n', 'utf8')

    const resolvedUnknown = resolveBinary('tool', {
      platform: 'win32',
      pathEnv: tmpDir,
      comspec: 'cmd.exe',
    })

    expect(resolvedUnknown).toEqual({
      exe: 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', unknownToolCmd],
      via: 'cmd',
      mode: 'cmd_fallback',
      shim: unknownToolCmd,
    })

    // Passo 6: shim opaco com metacaracteres e afirmar que argv recebido pelo helper é idêntico ao argv enviado
    const echoHelper = path.join(tmpDir, 'echo-helper.mjs')
    fs.writeFileSync(
      echoHelper,
      `import fs from 'node:fs'
const outFile = process.argv[2]
const received = process.argv.slice(3)
fs.writeFileSync(outFile, JSON.stringify(received), 'utf8')
`,
      'utf8',
    )

    const outFile = path.join(tmpDir, 'received-argv.json')
    const testArgs = [
      'simple', 'with spaces', 'foo&bar', 'x=1^2', 'hello"world"', '<tag>',
      '%PATH%', '%ADE_ARGV_TEST%', 'foo|bar', '"&|<>^%PATH%"',
      'backslash\\"quote', 'trailing\\', '', '!ADE_ARGV_TEST!',
    ]

    const opaqueToolCmd = path.join(tmpDir, 'opaque-tool.cmd')
    fs.writeFileSync(
      opaqueToolCmd,
      `@echo off\r\n"${process.execPath}" "${echoHelper}" "${outFile}" %*\r\n`,
      'utf8',
    )

    const resolvedOpaque = resolveBinary('opaque-tool', {
      platform: 'win32',
      pathEnv: tmpDir,
      comspec: 'cmd.exe',
    })

    expect(resolvedOpaque.mode).toBe('cmd_fallback')
    expect(resolvedOpaque.via).toBe('cmd')

    const runRes = await runWorker({
      resolved: resolvedOpaque,
      args: testArgs,
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm-ca1',
      stepId: 's-ca1',
      env: { ADE_ARGV_TEST: 'valor que não deve substituir o argumento' },
      request: {
        unit: 'u1',
        authorization: 'auth',
        cwd: tmpDir,
        argv: ['opaque-tool', ...testArgs],
        timeout: 30,
        result_file: path.join(tmpDir, 'res-ca1.json'),
      },
    })

    expect(runRes.state).toBe('exited')
    expect(fs.existsSync(outFile)).toBe(true)
    const receivedArgv = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    expect(receivedArgv).toEqual(testArgs)
  })

  // (2) CA2 — Dado um worker que cria um processo neto e excede o tempo, quando o Runner encerra a chamada,
  // então pai e neto deixam de existir e o recibo termina em timeout.
  test('ca2_worker_timeout_kills_process_tree_including_grandchild', async () => {
    // Exemplo: helper com neto e timeout -> {receipt_state:'timeout',parent_exists:false,child_exists:false}
    const gcScript = path.join(tmpDir, 'grandchild.mjs')
    fs.writeFileSync(
      gcScript,
      `setInterval(() => {}, 1000)\n`,
      'utf8',
    )

    const pidsFile = path.join(tmpDir, 'pids.json')
    const parentScript = path.join(tmpDir, 'parent.mjs')
    fs.writeFileSync(
      parentScript,
      `import { spawn } from 'node:child_process'
import fs from 'node:fs'

const gc = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' })
fs.writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, child: gc.pid }), 'utf8')
setInterval(() => {}, 1000)
`,
      'utf8',
    )

    const res = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [parentScript, gcScript, pidsFile] },
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm-ca2',
      stepId: 's-ca2',
      request: {
        unit: 'u2',
        authorization: 'auth',
        cwd: tmpDir,
        argv: [process.execPath, parentScript, gcScript, pidsFile],
        timeout: 1,
        result_file: path.join(tmpDir, 'res-ca2.json'),
      },
      timeoutS: 1,
    })

    expect(res.state).toBe('timeout')
    expect(fs.existsSync(pidsFile)).toBe(true)
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'))
    const parentPid = pids.parent
    const childPid = pids.child

    const receipt = readReceipt(res.receiptFile)
    expect(receipt).not.toBeNull()

    // Aguarda eventual limpeza de handles pelo SO
    let parentAlive = isProcessAlive(parentPid)
    let childAlive = isProcessAlive(childPid)
    for (let i = 0; i < 30 && (parentAlive || childAlive); i++) {
      await new Promise((r) => setTimeout(r, 50))
      parentAlive = isProcessAlive(parentPid)
      childAlive = isProcessAlive(childPid)
    }

    expect({
      receipt_state: receipt!.state,
      parent_exists: parentAlive,
      child_exists: childAlive,
    }).toEqual({
      receipt_state: 'timeout',
      parent_exists: false,
      child_exists: false,
    })
  }, 20000)

  // (3) CA3 — Dado um diff maior que 1 MiB cujo último trecho contém segredo e violação de escopo,
  // quando contain roda, então segurança vence, o lote para e nenhuma restauração ou commit ocorre.
  test('ca3_diff_over_1mib_secret_precedes_scope_and_stops_batch', async () => {
    // Exemplo: diff com 1048577 bytes, segredo no último byte e fora.txt fora do escopo -> {status:'stop',reason:'secret',commit_calls:0,restore_calls:0}
    const repo = makeRepo()
    repoDir = repo.dir
    const port = createGitPort({ worktreeDir: repo.dir })

    fs.mkdirSync(path.join(repo.dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, 'src', 'app.js'), '// initial app\n')
    fs.writeFileSync(path.join(repo.dir, 'src', 'big.txt'), '')
    const initialCommit = await port.commit({ message: 'init' })

    // Cria arquivo com exatamente 1048577 bytes (1 MiB + 1 byte), com segredo no final
    const secret = 'AKIA1234567890123456'
    const totalBytes = 1048577
    const pad = '\n'.repeat(totalBytes - secret.length)
    fs.writeFileSync(path.join(repo.dir, 'src', 'big.txt'), pad + secret, 'latin1')

    // Arquivo fora do escopo
    fs.writeFileSync(path.join(repo.dir, 'fora.txt'), 'conteudo fora do escopo\n')

    let commitCalls = 0
    let restoreCalls = 0
    const origCommit = port.commit.bind(port)
    port.commit = async (options: { message: string }) => {
      commitCalls++
      return origCommit(options)
    }
    const origRestore = port.restore.bind(port)
    port.restore = async (tree: string, options: { label: string }) => {
      restoreCalls++
      return origRestore(tree, options)
    }

    const result = await contain({
      git: port,
      unitId: 'unit-ca3',
      treeBefore: initialCommit.tree,
      scopePaths: ['src/**'],
    })

    expect({
      status: result.status,
      reason: result.reason,
      commit_calls: commitCalls,
      restore_calls: restoreCalls,
    }).toEqual({
      status: 'stop',
      reason: 'secret',
      commit_calls: 0,
      restore_calls: 0,
    })
  })

  // (4) CA4 — Dada uma reescrita Git de mesmo tamanho no mesmo segundo ou rename entre lados do escopo,
  // quando a árvore é consultada, então a mudança e os dois caminhos são observados.
  test('ca4_git_dirty_paths_observes_same_size_rewrite_and_rename_paths', async () => {
    // Exemplo: rename secrets/x para src/x -> {dirty_paths:['secrets/x','src/x']}
    const repo = makeRepo()
    repoDir = repo.dir
    const port = createGitPort({ worktreeDir: repo.dir })

    fs.mkdirSync(path.join(repo.dir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(repo.dir, 'secrets', 'x'), 'conteudo secreto\n')
    await port.commit({ message: 'add secret' })

    fs.mkdirSync(path.join(repo.dir, 'src'), { recursive: true })
    repo.git(['mv', 'secrets/x', 'src/x'])

    const renameDirty = await port.dirtyPaths()
    expect({ dirty_paths: renameDirty }).toEqual({
      dirty_paths: ['secrets/x', 'src/x'],
    })

    // Reescrita de mesmo tamanho no mesmo segundo (racy git)
    const filePath = path.join(repo.dir, 'src', 'x')
    const t = new Date('2026-01-01T12:00:00Z')
    fs.writeFileSync(filePath, '1111')
    fs.utimesSync(filePath, t, t)
    const commitRacy = await port.commit({ message: 'racy baseline' })

    fs.writeFileSync(filePath, '2222')
    fs.utimesSync(filePath, t, t)

    const dirtyRacy = await port.dirtyPaths()
    expect(dirtyRacy).toContain('src/x')

    const newTree = await port.worktreeTree()
    expect(newTree).not.toBe(commitRacy.tree)
  })

  // (5) CA1 — Dado um PID Windows ativo e taskkill concluindo com sucesso, quando killTree for chamado,
  // então ele retorna {terminated_by:'taskkill'} e não chama child.kill.
  test('ca1_killtree_windows_taskkill_success', () => {
    let childKillCalls = 0
    const fakeChild = {
      kill: () => {
        childKillCalls++
      },
    }
    let executedCmd: string | null = null
    let executedArgs: string[] = []
    const fakeOk = (cmd: string, args: string[]) => {
      executedCmd = cmd
      executedArgs = args
    }

    const result = killTree(1234, {
      platform: 'win32',
      execFileSync: fakeOk,
      child: fakeChild,
    })

    expect(result).toEqual({ terminated_by: 'taskkill' })
    expect(childKillCalls).toBe(0)
    expect(executedCmd).toBe('taskkill')
    expect(executedArgs).toEqual(['/T', '/F', '/PID', '1234'])
  })

  // (6) CA2 — Dado taskkill recusado com code:'EPERM', quando killTree receber o filho não destacado,
  // então chama child.kill('SIGKILL') uma vez e retorna {terminated_by:'job_fallback'};
  // erros Windows diferentes de processo inexistente continuam lançados.
  test('ca2_killtree_windows_eperm_fallback_and_error_handling', () => {
    let killedWith: string | null = null
    const fakeChild = {
      kill: (sig: string) => {
        killedWith = sig
      },
    }
    const fakeEperm = () => {
      const err: any = new Error('EPERM: operation not permitted')
      err.code = 'EPERM'
      throw err
    }

    const resEperm = killTree(1234, {
      platform: 'win32',
      execFileSync: fakeEperm,
      child: fakeChild,
    })
    expect(resEperm).toEqual({ terminated_by: 'job_fallback' })
    expect(killedWith).toBe('SIGKILL')

    // EPERM sem child ou sem método kill propaga a falha fechada
    expect(() =>
      killTree(1234, {
        platform: 'win32',
        execFileSync: fakeEperm,
      }),
    ).toThrow('EPERM')

    expect(() =>
      killTree(1234, {
        platform: 'win32',
        execFileSync: fakeEperm,
        child: {} as any,
      }),
    ).toThrow('EPERM')

    // status === 128
    const fakeStatus128 = () => {
      const err: any = new Error('Process 128')
      err.status = 128
      throw err
    }
    const res128 = killTree(1234, {
      platform: 'win32',
      execFileSync: fakeStatus128,
      child: fakeChild,
    })
    expect(res128).toEqual({ terminated_by: 'already_exited' })

    // Mensagem indicando processo inexistente
    const fakeNotFound = () => {
      throw new Error('ERROR: The process with PID 1234 not found.')
    }
    const resNotFound = killTree(1234, {
      platform: 'win32',
      execFileSync: fakeNotFound,
      child: fakeChild,
    })
    expect(resNotFound).toEqual({ terminated_by: 'already_exited' })

    // Erro inesperado é relançado
    const fakeUnexpected = () => {
      const err: any = new Error('EACCES: permission denied')
      err.code = 'EACCES'
      throw err
    }
    expect(() =>
      killTree(1234, {
        platform: 'win32',
        execFileSync: fakeUnexpected,
        child: fakeChild,
      }),
    ).toThrow('EACCES')
  })

  // (7) CA3 — Dado um worker Windows que cria um processo neto e excede timeoutS:1, quando o Runner terminar,
  // então o resultado tem state:'timeout' e ambos os PIDs deixam de existir em até 1,5 segundo, sem teste ignorado.
  // Plataforma POSIX também testada com killTree.
  test('ca3_runworker_timeout_windows_tree_cleanup_and_posix', async () => {
    // Prova unitária POSIX com filho
    let posixSig: string | null = null
    const fakeChildPosix = {
      kill: (sig: string) => {
        posixSig = sig
      },
    }
    const resPosix = killTree(1234, { platform: 'linux', child: fakeChildPosix })
    expect(resPosix).toEqual({ terminated_by: 'sigkill' })
    expect(posixSig).toBe('SIGKILL')

    // Prova unitária POSIX sem filho
    const resPosixNoChild = killTree(1234, { platform: 'linux' })
    expect(resPosixNoChild).toEqual({ terminated_by: 'already_exited' })

    // Prova real de timeout com neto em loop
    const gcScript = path.join(tmpDir, 'grandchild-ca3.mjs')
    fs.writeFileSync(gcScript, `setInterval(() => {}, 1000)\n`, 'utf8')

    const pidsFile = path.join(tmpDir, 'pids-ca3.json')
    const parentScript = path.join(tmpDir, 'parent-ca3.mjs')
    fs.writeFileSync(
      parentScript,
      `import { spawn } from 'node:child_process'
import fs from 'node:fs'

const gc = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' })
fs.writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, child: gc.pid }), 'utf8')
setInterval(() => {}, 1000)
`,
      'utf8',
    )

    const res = await runWorker({
      resolved: { exe: process.execPath, prefixArgs: [parentScript, gcScript, pidsFile] },
      cwd: tmpDir,
      missionDir: tmpDir,
      missionId: 'm-ca3',
      stepId: 's-ca3',
      request: {
        unit: 'u-ca3',
        authorization: 'auth-ca3',
        cwd: tmpDir,
        argv: [process.execPath, parentScript, gcScript, pidsFile],
        timeout: 1,
        result_file: path.join(tmpDir, 'res-ca3.json'),
      },
      timeoutS: 1,
    })

    expect(res.state).toBe('timeout')
    expect(fs.existsSync(pidsFile)).toBe(true)
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'))
    const parentPid = pids.parent
    const childPid = pids.child

    let parentAlive = isProcessAlive(parentPid)
    let childAlive = isProcessAlive(childPid)
    for (let i = 0; i < 30 && (parentAlive || childAlive); i++) {
      await new Promise((r) => setTimeout(r, 50))
      parentAlive = isProcessAlive(parentPid)
      childAlive = isProcessAlive(childPid)
    }

    expect({
      state: res.state,
      parent_exists: parentAlive,
      child_exists: childAlive,
    }).toEqual({
      state: 'timeout',
      parent_exists: false,
      child_exists: false,
    })
  }, 20000)

  // (8) CA4 — Dado o índice de decisões, quando o novo registro for lido, então o ADR 0025 está aceito,
  // cita a autorização de Erick e documenta taskkill, o caso EPERM, a alternativa limitada e suas consequências.
  test('ca4_adr_0025_and_durability_index_records', () => {
    const adrPath = path.resolve(process.cwd(), 'docs/adr/0025-fallback-da-arvore-de-processos-windows.md')
    expect(fs.existsSync(adrPath)).toBe(true)
    const adrContent = fs.readFileSync(adrPath, 'utf8')
    expect(adrContent).toMatch(/Status:\s*\*?\*?\s*Aceito/i)
    expect(adrContent).toContain('2026-09-20')
    expect(adrContent).toContain('Erick')
    expect(adrContent).toContain('taskkill')
    expect(adrContent).toContain('EPERM')
    expect(adrContent).toMatch(/job_fallback|Job Object/i)

    const indexPath = path.resolve(process.cwd(), 'docs/adr/README.md')
    expect(fs.existsSync(indexPath)).toBe(true)
    const indexContent = fs.readFileSync(indexPath, 'utf8')
    expect(indexContent).toContain('0025')
    expect(indexContent).toContain('0025-fallback-da-arvore-de-processos-windows.md')
    expect(indexContent).toMatch(/Durabilidade e recuperação.*0025/s)
  })
})

