import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveGateArgv, runContained } from '../../src/gates/command.js'

describe('gate command and containment parity', () => {
  // CA1: Dado um gate { id:'lint', script:'lint' } e um package.json cujo scripts.lint é
  // node node_modules/oxlint/bin/oxlint src tests, quando resolveGateArgv roda,
  // então devolve ['node','node_modules/oxlint/bin/oxlint','src','tests'].
  test('gate_script_name_matching', () => {
    const result = resolveGateArgv({
      gate: { id: 'lint', script: 'lint' },
      packageJson: {
        scripts: {
          lint: 'node node_modules/oxlint/bin/oxlint src tests',
        },
      },
      vars: {
        worktree: '/w',
        tree: 'abc',
        changedFiles: [],
      },
    })
    expect(result).toEqual(['node', 'node_modules/oxlint/bin/oxlint', 'src', 'tests'])
  })

  // CA2: Dado um gate com argv:['node','x.js','--root','{worktree}','{changed_files}'] e
  // vars:{ worktree:'/w', tree:'abc', changedFiles:['a.js','b.js'] }, quando resolveGateArgv roda,
  // então devolve ['node','x.js','--root','/w','a.js','b.js'], e com changedFiles:[] o token some sem deixar argumento vazio.
  test('gate_placeholders_and_script_name_matching', () => {
    const withFiles = resolveGateArgv({
      gate: { id: 't', argv: ['node', 'x.js', '--root', '{worktree}', '{changed_files}'] },
      packageJson: {},
      vars: {
        worktree: '/w',
        tree: 'abc',
        changedFiles: ['a.js', 'b.js'],
      },
    })
    expect(withFiles).toEqual(['node', 'x.js', '--root', '/w', 'a.js', 'b.js'])

    const withoutFiles = resolveGateArgv({
      gate: { id: 't', argv: ['node', 'x.js', '--root', '{worktree}', '{changed_files}'] },
      packageJson: {},
      vars: {
        worktree: '/w',
        tree: 'abc',
        changedFiles: [],
      },
    })
    expect(withoutFiles).toEqual(['node', 'x.js', '--root', '/w'])

    // Substituição de {tree} em token combinado
    const withTree = resolveGateArgv({
      gate: { id: 't', argv: ['node', 'build.js', '--tree={tree}'] },
      packageJson: {},
      vars: {
        worktree: '/w',
        tree: 'tree123',
        changedFiles: [],
      },
    })
    expect(withTree).toEqual(['node', 'build.js', '--tree=tree123'])

    // Placeholder desconhecido deve lançar TypeError
    expect(() => {
      resolveGateArgv({
        gate: { id: 't', argv: ['node', 'x.js', '{nome}'] },
        packageJson: {},
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('placeholder desconhecido: {nome}'))
  })

  // CA3: Dado um gate com argv:['npx','vitest'] ou com script:'inexistente',
  // quando resolveGateArgv roda, então lança TypeError com a mensagem exata prevista, sem executar nada.
  test('gate_command_must_start_with_node', async () => {
    expect(() => {
      resolveGateArgv({
        gate: { id: 't', argv: ['npx', 'vitest'] },
        packageJson: {},
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('argv inválido: cmd[0] precisa ser node'))

    // Validação de argv[0] na fronteira de runContained em chamada direta
    await expect(
      runContained({
        argv: ['npx', 'vitest'],
        cwd: process.cwd(),
        timeoutS: 30,
      })
    ).rejects.toThrow(new TypeError('argv inválido: cmd[0] precisa ser node'))

    expect(() => {
      resolveGateArgv({
        gate: { id: 't', script: 'inexistente' },
        packageJson: { scripts: {} },
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('script de gate inexistente: inexistente'))

    expect(() => {
      resolveGateArgv({
        gate: { id: 't', script: 'lint' },
        packageJson: { scripts: { lint: 'node "foo"' } },
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('script de gate com aspas não é suportado: lint'))

    expect(() => {
      resolveGateArgv({
        gate: { id: 't' },
        packageJson: {},
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('gate precisa de argv ou script, nunca os dois'))

    expect(() => {
      resolveGateArgv({
        gate: { id: 't', argv: ['node', 'a.js'], script: 'lint' },
        packageJson: { scripts: { lint: 'node b.js' } },
        vars: {
          worktree: '/w',
          tree: 'abc',
          changedFiles: [],
        },
      })
    }).toThrow(new TypeError('gate precisa de argv ou script, nunca os dois'))

    // Caminho absoluto terminado em .exe é aceito
    const validExe = resolveGateArgv({
      gate: { id: 't', argv: ['C:\\tools\\node.exe', 'index.js'] },
      packageJson: {},
      vars: {
        worktree: '/w',
        tree: 'abc',
        changedFiles: [],
      },
    })
    expect(validExe).toEqual(['C:\\tools\\node.exe', 'index.js'])
  })

  // CA4: Dado runContained sobre ['node','-e','process.stdout.write("oi");process.exit(3)'],
  // quando termina, então devolve exitCode:3, stdout:'oi' e timedOut:false.
  test('contained_run_returns_exit_code_and_output', async () => {
    const result = await runContained({
      argv: ['node', '-e', 'process.stdout.write("oi");process.exit(3)'],
      cwd: process.cwd(),
      timeoutS: 30,
    })

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('oi')
    expect(result.timedOut).toBe(false)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.stderr).toBe('')

    // Processo com timeout dispara timedOut: true e exitCode: null
    const timeoutResult = await runContained({
      argv: ['node', '-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
      timeoutS: 0.1,
    })
    expect(timeoutResult.timedOut).toBe(true)
    expect(timeoutResult.exitCode).toBeNull()

    // Passagem de variáveis de ambiente extras via env
    const envResult = await runContained({
      argv: ['node', '-e', 'process.stdout.write(process.env.TEST_VAR || "")'],
      cwd: process.cwd(),
      timeoutS: 30,
      env: { TEST_VAR: 'contained_val' },
    })
    expect(envResult.exitCode).toBe(0)
    expect(envResult.stdout).toBe('contained_val')

    // Executável inexistente retorna exitCode: null, timedOut: false e preserva diagnóstico em stderr
    const missingExeResult = await runContained({
      argv: [path.resolve('non_existent_binary.exe')],
      cwd: process.cwd(),
      timeoutS: 30,
    })
    expect(missingExeResult.exitCode).toBeNull()
    expect(missingExeResult.timedOut).toBe(false)
    expect(missingExeResult.stderr).toContain('ENOENT')

    // Diretório de trabalho inexistente retorna exitCode: null, timedOut: false e preserva diagnóstico em stderr
    const missingCwdResult = await runContained({
      argv: ['node', '-e', 'process.exit(0)'],
      cwd: path.join(process.cwd(), 'non_existent_cwd_' + Date.now()),
      timeoutS: 30,
    })
    expect(missingCwdResult.exitCode).toBeNull()
    expect(missingCwdResult.timedOut).toBe(false)
    expect(missingCwdResult.stderr).toContain('ENOENT')
  })
})
