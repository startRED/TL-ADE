import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { newDiagnostics, parseDiagnostics } from '../src/gates/diagnostics.ts'
import { createGateRunner } from '../src/gates/gates.ts'
import { chargeableReds, judgeSuite, SLOW_TEST_MS } from '../src/runner/baseline.ts'
import { runSuites } from '../src/runner/suites.ts'
import type { SpawnSuite } from '../src/runner/suites.ts'
import type { TestResult, TestStatus } from '../src/runner/test-reports.ts'

const BASE = 'b'.repeat(40)
const AFTER = 'a'.repeat(40)

const BASE_TSC = [
  'src/a.ts(10,3): error TS2322: X',
  'src/b.ts(4,1): error TS2304: Cannot find name \'y\'.',
  'src/c.ts(7,9): error TS7006: Parameter \'z\' implicitly has an \'any\' type.',
].join('\n')
// os mesmos 3 erros, cada um descido de linha
const SHIFTED_TSC = [
  'src/a.ts(12,3): error TS2322: X',
  'src/b.ts(9,1): error TS2304: Cannot find name \'y\'.',
  'src/c.ts(20,9): error TS7006: Parameter \'z\' implicitly has an \'any\' type.',
].join('\n')
const NEW_TSC = `${SHIFTED_TSC}\nsrc/novo.ts(3,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

// worktree de mentira: o dublê do git troca de árvore escrevendo tree.txt; o gate imprime a saída gravada para a árvore atual
function gateEnv(outputs: Record<string, { out: string; code: number }>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ade-baseline-'))
  temps.push(dir)
  for (const [tree, o] of Object.entries(outputs)) {
    writeFileSync(path.join(dir, `out-${tree}.txt`), o.out)
    writeFileSync(path.join(dir, `code-${tree}.txt`), String(o.code))
  }
  writeFileSync(
    path.join(dir, 'gate.cjs'),
    "const fs = require('fs'); const t = fs.readFileSync('tree.txt', 'utf8');\n" +
      "process.stdout.write(fs.readFileSync('out-' + t + '.txt', 'utf8')); process.exitCode = Number(fs.readFileSync('code-' + t + '.txt', 'utf8'))\n",
  )
  let current = AFTER
  writeFileSync(path.join(dir, 'tree.txt'), current)
  const restores: string[] = []
  const gitPort = {
    worktreeDir: dir,
    worktreeTree: async () => current,
    restoreTree: async (tree: string) => {
      restores.push(tree)
      current = tree
      writeFileSync(path.join(dir, 'tree.txt'), tree)
      return { tree }
    },
  }
  const step = async (spec: { id: string }, fn: () => Promise<unknown>) => ({ step_id: spec.id, status: 'done', result: await fn(), reused: false })
  const missionDir = mkdtempSync(path.join(tmpdir(), 'ade-baseline-m-'))
  temps.push(missionDir)
  return { dir, gitPort, restores, runner: createGateRunner({ step, missionDir, gitPort }), current: () => current }
}

const typecheckGate = { id: 'tipos', kind: 'typecheck', when: 'always' as const, argv: ['node', 'gate.cjs'] }

const t = (id: string, status: TestStatus): TestResult => ({ id, suite: id.split('::')[0], name: id.split('::')[1], status, durationMs: 1 })

describe('portões por diagnóstico e vermelhas da largada', () => {
  test('shifted_tsc_errors_are_not_new_and_gate_passes', async () => {
    const a = parseDiagnostics('tsc', 'src/a.ts(10,3): error TS2322: X')
    const b = parseDiagnostics('tsc', 'src/a.ts(12,3): error TS2322: X')
    expect(a).toEqual([{ file: 'src/a.ts', code: 'TS2322', message: 'X' }])
    expect(newDiagnostics(a, b)).toEqual([])
    expect(newDiagnostics(parseDiagnostics('tsc', BASE_TSC), parseDiagnostics('tsc', SHIFTED_TSC))).toEqual([])

    const env = gateEnv({ [BASE]: { out: BASE_TSC, code: 2 }, [AFTER]: { out: SHIFTED_TSC, code: 2 } })
    const res = await env.runner.runGates({ gates: [typecheckGate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(res.ok).toBe(true)
    expect(res.results[0]).toMatchObject({ status: 'success', new_diagnostics: [] })
    // a árvore da parte volta para o lugar depois de conferir a linha de base
    expect(env.current()).toBe(AFTER)
  })

  test('new_tsc_error_fails_gate_citing_only_the_new_error', async () => {
    const fresh = newDiagnostics(parseDiagnostics('tsc', BASE_TSC), parseDiagnostics('tsc', NEW_TSC))
    expect(fresh).toEqual([{ file: 'src/novo.ts', code: 'TS2345', message: "Argument of type 'string' is not assignable to parameter of type 'number'." }])

    const env = gateEnv({ [BASE]: { out: BASE_TSC, code: 2 }, [AFTER]: { out: NEW_TSC, code: 2 } })
    const res = await env.runner.runGates({ gates: [typecheckGate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(res.ok).toBe(false)
    expect(res.results[0].status).toBe('error')
    expect(res.results[0].new_diagnostics).toEqual(fresh)
    expect(res.results[0].extract.excerpt).toContain('src/novo.ts')
    expect(res.results[0].extract.excerpt).not.toContain('src/a.ts')
  })

  test('oxlint_unix_diagnostics_compare_by_rule_and_repeated_triple_is_not_new', () => {
    const before = parseDiagnostics('oxlint', 'src/x.ts:3:7: Variable \'a\' is declared but never used. [Warning/eslint(no-unused-vars)]')
    const after = parseDiagnostics(
      'oxlint',
      'src\\x.ts:9:7: Variable \'a\' is declared but never used. [Warning/eslint(no-unused-vars)]\nsrc\\x.ts:12:7: Variable \'a\' is declared but never used. [Warning/eslint(no-unused-vars)]\n\n2 problems',
    )
    expect(after[0]).toEqual({ file: 'src/x.ts', code: 'eslint(no-unused-vars)', message: "Variable 'a' is declared but never used." })
    expect(after).toHaveLength(2)
    // novo é a tripla (arquivo, código, mensagem) ausente na linha de base: a mesma tripla repetida não é nova
    expect(newDiagnostics(before, after)).toEqual([])
    // outra regra no mesmo arquivo é tripla nova
    const other = parseDiagnostics('oxlint', 'src/x.ts:3:1: Unexpected console statement. [Warning/eslint(no-console)]')
    expect(newDiagnostics(before, [...after, ...other])).toEqual(other)
  })

  test('failing_gate_without_readable_diagnostic_stays_red_and_unknown_tool_is_refused', async () => {
    expect(() => parseDiagnostics('eslint' as 'tsc', 'x')).toThrow(TypeError)
    const env = gateEnv({ [BASE]: { out: '', code: 0 }, [AFTER]: { out: 'tsc caiu sem diagnóstico', code: 1 } })
    const res = await env.runner.runGates({ gates: [typecheckGate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(res.ok).toBe(false)
    expect(res.results[0].status).toBe('error')
  })

  test('red_at_start_is_not_charged_green_turned_red_is_charged', () => {
    const baseline = [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'passed'), t('a.test.ts::lenta', 'timeout')]
    const after = [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'failed'), t('a.test.ts::lenta', 'timeout'), t('b.test.ts::nova', 'failed')]
    expect(chargeableReds(baseline, after).map((r) => r.id)).toEqual(['a.test.ts::verde', 'b.test.ts::nova'])
    expect(chargeableReds(baseline, [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'passed')])).toEqual([])
  })

  test('timeout_only_red_is_retried_with_loose_per_test_limit_and_opens_no_round', async () => {
    const baseline = [t('a.test.ts::lenta', 'passed'), t('a.test.ts::velha', 'failed')]
    const calls: Array<number | undefined> = []
    const run = async (testTimeoutMs?: number) => {
      calls.push(testTimeoutMs)
      return calls.length === 1
        ? [t('a.test.ts::lenta', 'timeout'), t('a.test.ts::velha', 'failed')]
        : [t('a.test.ts::lenta', 'passed'), t('a.test.ts::velha', 'failed')]
    }
    const verdict = await judgeSuite(run, baseline)
    expect(calls).toEqual([undefined, SLOW_TEST_MS])
    expect(verdict).toMatchObject({ ok: true, retried: true, reds: [] })

    // vermelha que falha de novo na repetição é de verdade: vira rodada
    const twice: Array<number | undefined> = []
    const real = await judgeSuite(async (ms) => (twice.push(ms), [t('a.test.ts::lenta', 'failed')]), baseline)
    expect(twice).toEqual([undefined, SLOW_TEST_MS])
    expect(real.ok).toBe(false)

    // 24/09, missão real: provas instáveis sob carga (lease, crash) falhavam numa execução e passavam na outra e abriam
    // rodada de correção sobre código que a parte nem tocou. Só é cobrada a vermelha que falha nas duas execuções.
    let n = 0
    const flaky = await judgeSuite(async () => (++n === 1
      ? [t('a.test.ts::instavel', 'failed'), t('a.test.ts::lenta', 'passed')]
      : [t('a.test.ts::instavel', 'passed'), t('a.test.ts::lenta', 'passed')]), baseline)
    expect(flaky).toMatchObject({ ok: true, retried: true, reds: [] })

    // o limite folgado chega ao runner como limite POR PROVA
    const dir = mkdtempSync(path.join(tmpdir(), 'ade-baseline-s-'))
    temps.push(dir)
    const args: string[][] = []
    const spawn: SpawnSuite = async (_cmd, a) => {
      args.push(a)
      const out = a.find((x) => x.startsWith('--outputFile='))!.slice('--outputFile='.length)
      writeFileSync(out, JSON.stringify({ testResults: [{ name: path.join(dir, 'a.test.ts'), status: 'passed', assertionResults: [{ fullName: 'lenta', status: 'passed', duration: 1 }] }] }))
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    await runSuites(dir, [{ dir: '', toolchain: 'vitest', argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile={out}'] }], { spawn, timeoutMs: 1000, testTimeoutMs: SLOW_TEST_MS })
    expect(args[0]).toContain(`--testTimeout=${SLOW_TEST_MS}`)
  })

  test('epic_suite_closes_with_start_red_and_not_with_new_red', async () => {
    const epicStart = [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'passed')]
    const closes = await judgeSuite(async () => [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'passed')], epicStart)
    expect(closes.ok).toBe(true)
    const blocked = await judgeSuite(async () => [t('a.test.ts::velha', 'failed'), t('a.test.ts::verde', 'failed')], epicStart)
    expect(blocked.ok).toBe(false)
    expect(blocked.reds.map((r) => r.id)).toEqual(['a.test.ts::verde'])
  })

  test('test_gate_red_at_start_is_not_charged_through_the_gate_runner', async () => {
    // o comando do gate cita a vermelha da largada, como o reporter do runner faz
    const env = gateEnv({ [BASE]: { out: '', code: 1 }, [AFTER]: { out: ' FAIL  a.test.ts > velha', code: 1 } })
    writeFileSync(path.join(env.dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    const report = (tree: string) =>
      JSON.stringify({
        testResults: [
          {
            name: path.join(env.dir, 'a.test.ts'),
            status: 'failed',
            assertionResults: [
              { fullName: 'velha', status: 'failed', failureMessages: ['x'] },
              { fullName: 'verde', status: tree === BASE || tree === 'ok' ? 'passed' : 'failed', failureMessages: tree === BASE ? [] : ['y'] },
            ],
          },
        ],
      })
    let mode = 'ok'
    const spawnSuite: SpawnSuite = async (_cmd, a) => {
      const out = a.find((x) => x.startsWith('--outputFile='))!.slice('--outputFile='.length)
      writeFileSync(out, report(env.current() === BASE ? BASE : mode))
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
    }
    const step = async (spec: { id: string }, fn: () => Promise<unknown>) => ({ step_id: spec.id, status: 'done', result: await fn(), reused: false })
    const missionDir = mkdtempSync(path.join(tmpdir(), 'ade-baseline-m-'))
    temps.push(missionDir)
    const runner = createGateRunner({ step, missionDir, gitPort: env.gitPort, spawnSuite })
    const gate = { id: 'provas', kind: 'test', when: 'always' as const, argv: ['node', 'gate.cjs'] }

    const ok = await runner.runGates({ gates: [gate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(ok.results[0]).toMatchObject({ status: 'success', chargeable_reds: [] })

    // falha do comando que não cita prova nenhuma (configuração) segue vermelha, mesmo com a vermelha da largada na suíte
    writeFileSync(path.join(env.dir, `out-${AFTER}.txt`), 'npm ERR! Missing script: "test:ci"')
    const cfg = await runner.runGates({ gates: [gate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(cfg.ok).toBe(false)
    expect(cfg.results[0].status).toBe('error')
    expect(cfg.results[0].chargeable_reds).toBeUndefined()
    expect(env.current()).toBe(AFTER)

    mode = 'broke'
    const red = await runner.runGates({ gates: [gate], flags: [], tree: AFTER, unit: 'S1', baseTree: BASE })
    expect(red.ok).toBe(false)
    expect(red.results[0].chargeable_reds).toEqual(['a.test.ts::verde'])
    expect(env.current()).toBe(AFTER)
  })
})
