import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveGateArgv, runContained } from '../../src/gates/command.ts'
import * as gatesModule from '../../src/gates/gates.ts'
import { createGateRunner } from '../../src/gates/gates.ts'
import { createGitPort } from '../../src/git/gitport.ts'
import { openJournal, readJournal } from '../../src/journal/journal.ts'
import { createStepRunner } from '../../src/step/step.ts'
import { makeRepo, removeRepo } from '../helpers/git-repo.ts'

const restorePendingGate = (gatesModule as Record<string, any>).restorePendingGate as (opts: {
  missionDir: string
  gitPort: any
}) => Promise<{ restored: boolean; tree: string | null; blocked?: boolean }>


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

let repoDirs: string[] = []
let missionDirs: string[] = []

afterEach(() => {
  for (const dir of repoDirs) {
    try {
      removeRepo(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  repoDirs = []
  for (const dir of missionDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  missionDirs = []
})

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

function setupGateEnv() {
  const repo = makeRepo()
  repoDirs.push(repo.dir)
  writeFileSync(path.join(repo.dir, 'base.txt'), 'base\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'commit inicial'])

  const missionDir = mkdtempSync(path.join(os.tmpdir(), 'ade-gate-parity-'))
  missionDirs.push(missionDir)

  const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
  const gitPort = createGitPort({ worktreeDir: repo.dir })
  const { step } = createStepRunner({ journal, missionDir, gitPort, env: {} })

  return { repo, missionDir, journal, gitPort, step }
}

function makeCounterScript(counterFile: string, comment = ''): string {
  const normPath = counterFile.replace(/\\/g, '/')
  return `const fs = require('node:fs'); const f = ${JSON.stringify(normPath)}; const n = fs.existsSync(f) ? parseInt(fs.readFileSync(f, 'utf8') || '0', 10) : 0; fs.writeFileSync(f, String(n + 1));${comment}`
}

describe('runGates with step() and cache parity', () => {
  // CA1: Dado um gate ok que roda duas vezes sobre a mesma árvore com o mesmo argv,
  // quando runGates roda a segunda vez, então o resultado vem com reused:true e o
  // processo filho não é executado de novo (contador do script de teste continua em 1).
  // CA2: Dado o mesmo tree e o mesmo id de gate, mas com o argv alterado, quando
  // runGates roda, então o gate é executado de novo (reused:false) e o contador vai a 2.
  // Tempo limite próprio de 30 s: cria repositório git e dispara processos node; o padrão de 5 s estoura com a suíte inteira em paralelo.
  test('changed_gate_command_is_not_served_from_cache', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()
    const tree = await gitPort.worktreeTree()
    const counterFile = path.join(missionDir, 'counter.txt')

    const script1 = makeCounterScript(counterFile)
    const gate1 = {
      id: 'count',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', script1],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    // Execução inicial sobre tree
    const r1 = await runner.runGates({
      gates: [gate1],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r1.ok).toBe(true)
    expect(r1.results).toHaveLength(1)
    expect(r1.results[0].gate_id).toBe('count')
    expect(r1.results[0].reused).toBe(false)
    expect(r1.results[0].status).toBe('success')
    expect(r1.results[0].exit_code).toBe(0)
    expect(r1.results[0].raw_ref).toBe(`art:gates/count/${tree}`)
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    // CA1: Segunda chamada com mesmo argv sobre mesma tree -> cache hit, reused: true, contador continua '1'
    const r2 = await runner.runGates({
      gates: [gate1],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r2.ok).toBe(true)
    expect(r2.results).toHaveLength(1)
    expect(r2.results[0].gate_id).toBe('count')
    expect(r2.results[0].reused).toBe(true)
    expect(r2.results[0].status).toBe('success')
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    // CA2: Terceira chamada sobre mesma tree com argv alterado -> cache miss, reused: false, contador vira '2'
    const script2 = makeCounterScript(counterFile, ' /*v2*/')
    const gate2 = {
      id: 'count',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', script2],
    }
    const r3 = await runner.runGates({
      gates: [gate2],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r3.ok).toBe(true)
    expect(r3.results).toHaveLength(1)
    expect(r3.results[0].gate_id).toBe('count')
    expect(r3.results[0].reused).toBe(false)
    expect(r3.results[0].status).toBe('success')
    expect(readFileSync(counterFile, 'utf8')).toBe('2')
  }, 30_000)

  // CA3: Dado um gate by_flag com flag:'coverage' e flags:[], quando runGates roda,
  // então esse gate não aparece em results e nenhum step_intent dele é gravado no journal.
  test('by_flag_gate_is_skipped_without_the_flag', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()
    const tree = await gitPort.worktreeTree()
    const counterFile = path.join(missionDir, 'counter-cov.txt')

    const script = makeCounterScript(counterFile)
    const gate = {
      id: 'cov',
      kind: 'test',
      when: 'by_flag' as const,
      flag: 'coverage',
      argv: ['node', '-e', script],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    // Chamada sem a flag 'coverage': o gate deve ser ignorado
    const r = await runner.runGates({
      gates: [gate],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r.ok).toBe(true)
    expect(r.results).toEqual([])
    expect(existsSync(counterFile)).toBe(false)

    // Nenhum step_intent do gate 'cov' gravado no journal
    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const gateIntents = events.filter(
      (ev) => ev.kind === 'step_intent' && String(ev.step_id || '').startsWith('gate:cov')
    )
    expect(gateIntents).toHaveLength(0)

    // Com a flag 'coverage', o gate deve ser executado
    const rWithFlag = await runner.runGates({
      gates: [gate],
      flags: ['coverage'],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(rWithFlag.ok).toBe(true)
    expect(rWithFlag.results).toHaveLength(1)
    expect(rWithFlag.results[0].gate_id).toBe('cov')
    expect(rWithFlag.results[0].reused).toBe(false)
    expect(existsSync(counterFile)).toBe(true)
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    // Caso adverso: when inválido deve lançar TypeError
    const badGate = {
      id: 'bad',
      kind: 'test',
      when: 'invalid_when' as any,
      argv: ['node', '-e', 'process.exit(0)'],
    }
    await expect(
      runner.runGates({
        gates: [badGate],
        flags: [],
        tree,
        unit: 'u1',
        changedFiles: [],
      })
    ).rejects.toThrow(new TypeError('when de gate inválido: invalid_when'))
  })

  // CA4: Dado dois gates always em que o primeiro sai com código 1, quando runGates roda,
  // então devolve ok:false, results tem só o primeiro com status:'error' e o segundo nunca é executado.
  test('gate_run_stops_at_the_first_failure', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()
    const tree = await gitPort.worktreeTree()
    const counterFile = path.join(missionDir, 'counter-ok.txt')

    const gateFail = {
      id: 'falha',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', 'process.exit(1)'],
    }
    const gateOk = {
      id: 'ok',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', makeCounterScript(counterFile)],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    const r = await runner.runGates({
      gates: [gateFail, gateOk],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })

    expect(r.ok).toBe(false)
    expect(r.results).toHaveLength(1)
    expect(r.results[0].gate_id).toBe('falha')
    expect(r.results[0].status).toBe('error')
    expect(r.results[0].exit_code).toBe(1)
    expect(existsSync(counterFile)).toBe(false)
  })

  // Gates com kind omitido e kind:'test' explícito compartilham o cache de step()
  test('omitted_kind_and_explicit_test_kind_share_cache', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()
    const tree = await gitPort.worktreeTree()
    const counterFile = path.join(missionDir, 'counter-kind.txt')

    const script = makeCounterScript(counterFile)
    const gateWithoutKind = {
      id: 'kind-test',
      when: 'always' as const,
      argv: ['node', '-e', script],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    const r1 = await runner.runGates({
      gates: [gateWithoutKind],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r1.ok).toBe(true)
    expect(r1.results[0].reused).toBe(false)
    expect(readFileSync(counterFile, 'utf8')).toBe('1')

    const gateWithExplicitKind = {
      id: 'kind-test',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', script],
    }

    const r2 = await runner.runGates({
      gates: [gateWithExplicitKind],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })
    expect(r2.ok).toBe(true)
    expect(r2.results[0].reused).toBe(true)
    expect(readFileSync(counterFile, 'utf8')).toBe('1')
  })

  // Verificação de árvore divergente recusa sem lançar e sem executar processo
  test('tree_mismatch_returns_refused_without_starting_process', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()
    const counterFile = path.join(missionDir, 'counter-refused.txt')

    const script = makeCounterScript(counterFile)
    const gate = {
      id: 'refused-test',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', script],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    const r = await runner.runGates({
      gates: [gate],
      flags: [],
      tree: '0000000000000000000000000000000000000000',
      unit: 'u1',
      changedFiles: [],
    })

    expect(r.ok).toBe(false)
    expect(r.results).toEqual([])
    expect(r.verdict).toBe('refused')
    expect(existsSync(counterFile)).toBe(false)
  })

  // gitPort sem worktreeTree é recusado na criação do runner
  test('gitPort_without_worktreeTree_is_rejected', () => {
    const { missionDir, step } = setupGateEnv()
    expect(() => {
      createGateRunner({
        step,
        missionDir,
        gitPort: { worktreeDir: '/w' } as any,
        packageJson: {},
      })
    }).toThrow(new TypeError('gitPort inválido'))
  })
})

describe('gate restoration of leftovers parity', () => {
  // CA1: Dado um gate que cria coverage/report.json no worktree, quando runGates termina
  // e o engine commita com gitPort.commit, então o commit não contém coverage/report.json,
  // o arquivo não existe mais no disco e a mudança candidata do Maker continua presente no commit.
  test('gate_artifacts_never_reach_the_commit', async () => {
    const { repo, missionDir, gitPort, step } = setupGateEnv()

    const candidateFile = path.join(repo.dir, 'src', 'novo.js')
    mkdirSync(path.dirname(candidateFile), { recursive: true })
    writeFileSync(candidateFile, 'console.log("maker candidate");\n')

    const tree = await gitPort.worktreeTree()

    const gate = {
      id: 'coverage',
      kind: 'test',
      when: 'always' as const,
      argv: [
        'node',
        '-e',
        'fs.mkdirSync("coverage");fs.writeFileSync("coverage/report.json","{}")',
      ],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    const result = await runner.runGates({
      gates: [gate],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: ['src/novo.js'],
    })

    expect(result.ok).toBe(true)

    const reportPath = path.join(repo.dir, 'coverage', 'report.json')
    expect(existsSync(reportPath)).toBe(false)
    expect(existsSync(candidateFile)).toBe(true)

    await gitPort.commit({ message: 'feat: candidate maker change' })

    const show = await gitPort.run(['show', '--name-only', '--format=', 'HEAD'])
    const filesInCommit = show.stdout.toString('utf8')
    expect(filesInCommit).toContain('src/novo.js')
    expect(filesInCommit).not.toContain('coverage')
  })

  // CA2: Dado um marcador gate-restore.json deixado no missionDir com a árvore anterior
  // e um coverage/report.json presente no worktree (simulando crash no meio do gate),
  // quando restorePendingGate roda, então o arquivo some, o marcador é apagado e o
  // retorno traz {restored:true, tree:<tree_before>}.
  test('gate_leftovers_after_crash_are_not_committed', async () => {
    const { repo, missionDir, gitPort } = setupGateEnv()

    const candidateFile = path.join(repo.dir, 'src', 'novo.js')
    mkdirSync(path.dirname(candidateFile), { recursive: true })
    writeFileSync(candidateFile, 'console.log("maker candidate");\n')
    const treeBefore = await gitPort.worktreeTree()

    const reportPath = path.join(repo.dir, 'coverage', 'report.json')
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, '{}')

    const markerFile = path.join(missionDir, 'gate-restore.json')
    writeFileSync(
      markerFile,
      JSON.stringify({
        gate_id: 'cov',
        tree_before: treeBefore,
        worktree: gitPort.worktreeDir,
      })
    )

    const result = await restorePendingGate({ missionDir, gitPort })

    expect(result).toEqual({ restored: true, tree: treeBefore })
    expect(existsSync(reportPath)).toBe(false)
    expect(existsSync(markerFile)).toBe(false)
    expect(existsSync(candidateFile)).toBe(true)

    // Sem marcador pendente, chamada subsequente não restaura nada
    const noopResult = await restorePendingGate({ missionDir, gitPort })
    expect(noopResult).toEqual({ restored: false, tree: null })
  })

  // CA3: Dado um marcador com JSON ilegível, quando restorePendingGate roda,
  // então o marcador continua no disco, o retorno traz {restored:false, tree:null, blocked:true}
  // e runGates devolve {ok:false, results:[], error:'gate_restore_marker_invalid'} sem executar processo.
  test('invalid_restore_marker_blocks_the_run', async () => {
    const { missionDir, gitPort, step } = setupGateEnv()

    const markerFile = path.join(missionDir, 'gate-restore.json')
    writeFileSync(markerFile, 'não-json')

    const restoreRes = await restorePendingGate({ missionDir, gitPort })
    expect(restoreRes).toEqual({ restored: false, tree: null, blocked: true })
    expect(existsSync(markerFile)).toBe(true)

    const counterFile = path.join(missionDir, 'counter-blocked.txt')
    const script = makeCounterScript(counterFile)
    const gate = {
      id: 'should-not-run',
      kind: 'test',
      when: 'always' as const,
      argv: ['node', '-e', script],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })
    const tree = await gitPort.worktreeTree()

    const runRes = await runner.runGates({
      gates: [gate],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })

    expect(runRes).toEqual({
      ok: false,
      results: [],
      error: 'gate_restore_marker_invalid',
    })
    expect(existsSync(counterFile)).toBe(false)
    expect(existsSync(markerFile)).toBe(true)

    // Marcador de outro worktree preserva arquivo e bloqueia
    writeFileSync(
      markerFile,
      JSON.stringify({
        gate_id: 'cov',
        tree_before: tree,
        worktree: '/outro/worktree',
      })
    )
    const mismatchRes = await restorePendingGate({ missionDir, gitPort })
    expect(mismatchRes).toEqual({ restored: false, tree: null, blocked: true })
    expect(existsSync(markerFile)).toBe(true)

    // Marcador sem tree_before preserva arquivo e bloqueia
    writeFileSync(
      markerFile,
      JSON.stringify({
        gate_id: 'cov',
        worktree: gitPort.worktreeDir,
      })
    )
    const noTreeRes = await restorePendingGate({ missionDir, gitPort })
    expect(noTreeRes).toEqual({ restored: false, tree: null, blocked: true })
    expect(existsSync(markerFile)).toBe(true)
  })

  // CA4: Dado um gate que falha com código 1 depois de criar coverage/report.json,
  // quando runGates devolve ok:false, então o artefato já foi restaurado e
  // gitPort.dirtyPaths() não lista coverage/report.json.
  test('failed_gate_still_restores_leftovers', async () => {
    const { repo, missionDir, gitPort, step } = setupGateEnv()
    const tree = await gitPort.worktreeTree()

    const gate = {
      id: 'failing-cov',
      kind: 'test',
      when: 'always' as const,
      argv: [
        'node',
        '-e',
        'fs.mkdirSync("coverage");fs.writeFileSync("coverage/report.json","{}");process.exit(1)',
      ],
    }

    const runner = createGateRunner({ step, missionDir, gitPort, packageJson: {} })

    const result = await runner.runGates({
      gates: [gate],
      flags: [],
      tree,
      unit: 'u1',
      changedFiles: [],
    })

    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].status).toBe('error')
    expect(result.results[0].exit_code).toBe(1)

    const reportPath = path.join(repo.dir, 'coverage', 'report.json')
    expect(existsSync(reportPath)).toBe(false)

    const dirty = await gitPort.dirtyPaths()
    expect(dirty).toEqual([])

    const markerPath = path.join(missionDir, 'gate-restore.json')
    expect(existsSync(markerPath)).toBe(false)
  })
})

