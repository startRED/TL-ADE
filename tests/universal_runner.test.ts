import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'
import { findSuites, runSuites } from '../src/runner/suites.ts'
import type { SpawnSuite } from '../src/runner/suites.ts'
import { parseCargo, parseGoJson, parseJestJson, parseJUnit, parseTrx } from '../src/runner/test-reports.ts'

const FIX = fileURLToPath(new URL('./fixtures/runner/', import.meta.url))
const fixture = (name: string) => readFileSync(path.join(FIX, name), 'utf8')
const pick = (r: { id: string; status: string; durationMs: number }) => ({ id: r.id, status: r.status, durationMs: r.durationMs })

const temps: string[] = []
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ade-runner-'))
  temps.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), content)
  }
  return root
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

// dublê do processo: escreve o relatório no destino que o argv pede e devolve o código de saída
function fakeSpawn(report: string, { exitCode = 1, timedOut = false } = {}) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs: number }> = []
  const spawn: SpawnSuite = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...opts })
    const dest = args.find((a) => a.startsWith('--test-reporter-destination='))
    if (dest) writeFileSync(dest.slice('--test-reporter-destination='.length), report)
    return { exitCode: timedOut ? null : exitCode, stdout: '', stderr: '', timedOut }
  }
  return { spawn, calls }
}

describe('executor universal de provas', () => {
  test('discovers_root_and_subfolder_suites_ignoring_dependency_and_state_folders', () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'node_modules/vitest/vitest.mjs': '',
      'backend/go.mod': 'module x\n',
      'engine/Cargo.toml': '[package]\nname = "calc"\n',
      'node_modules/go.mod': 'module lixo\n',
      '.git/Cargo.toml': '',
      '.ade/go.mod': 'module estado\n',
    })
    const suites = findSuites(root)
    expect(suites).toEqual([
      { dir: '', toolchain: 'vitest', argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile={out}'] },
      { dir: 'backend', toolchain: 'go', argv: ['go', 'test', '-json', './...'] },
      { dir: 'engine', toolchain: 'cargo', argv: ['cargo', 'test', '--no-fail-fast'] },
    ])
  })

  test('reads_junit_passed_failed_and_skipped_with_duration', () => {
    const results = parseJUnit(fixture('junit.xml'), '/repo')
    expect(results).toEqual([
      { id: 'tests/a.test.mjs::soma', suite: 'tests/a.test.mjs', name: 'soma', status: 'passed', durationMs: 12 },
      { id: 'tests/a.test.mjs::falha', suite: 'tests/a.test.mjs', name: 'falha', status: 'failed', durationMs: 3 },
      { id: 'tests/a.test.mjs::pula', suite: 'tests/a.test.mjs', name: 'pula', status: 'skipped', durationMs: 0 },
    ])
  })

  test('reads_trx_go_cargo_and_vitest_into_individual_results_with_stable_ids', () => {
    expect(parseGoJson('{"Action":"fail","Package":"x","Test":"TestA","Elapsed":0.1}').map(pick)).toEqual([
      { id: 'x::TestA', status: 'failed', durationMs: 100 },
    ])
    expect(parseGoJson(fixture('go.jsonl')).map(pick)).toEqual([
      { id: 'x::TestA', status: 'failed', durationMs: 100 },
      { id: 'x::TestB', status: 'passed', durationMs: 20 },
      { id: 'x::TestC', status: 'skipped', durationMs: 0 },
      { id: 'x::TestSlow', status: 'timeout', durationMs: 1000 },
    ])
    expect(parseTrx(fixture('dotnet.trx')).map(pick)).toEqual([
      { id: 'Calc.Tests::Soma', status: 'passed', durationMs: 12 },
      { id: 'Calc.Tests::Falha', status: 'failed', durationMs: 1500 },
      { id: 'Calc.Tests::Lenta', status: 'timeout', durationMs: 2000 },
      { id: 'Calc.Tests::Pula', status: 'skipped', durationMs: 0 },
    ])
    expect(parseCargo(fixture('cargo.stdout.txt'), fixture('cargo.stderr.txt')).map(pick)).toEqual([
      { id: 'src/lib.rs::tests::soma', status: 'passed', durationMs: 0 },
      { id: 'src/lib.rs::tests::falha', status: 'failed', durationMs: 0 },
      { id: 'src/lib.rs::tests::pula', status: 'skipped', durationMs: 0 },
      { id: 'tests/integra.rs::integra', status: 'passed', durationMs: 0 },
    ])
    const vitest = parseJestJson(fixture('vitest.json'), '/repo')
    expect(vitest.map(pick)).toEqual([
      { id: 'src/calc.test.ts::calc soma', status: 'passed', durationMs: 4 },
      { id: 'src/calc.test.ts::calc falha', status: 'failed', durationMs: 1 },
      { id: 'src/calc.test.ts::calc lenta', status: 'timeout', durationMs: 5003 },
      { id: 'src/calc.test.ts::calc pulada', status: 'skipped', durationMs: 0 },
    ])
    expect(vitest[0]).toMatchObject({ suite: 'src/calc.test.ts', name: 'calc soma' })
  })

  test('marks_timed_out_test_as_timeout_distinct_from_failure', async () => {
    const xml = `<testsuites><testcase name="lenta" time="0.063" classname="test" file="/repo/a.test.mjs">
      <failure type="testTimeoutFailure" message="test timed out after 50ms">x</failure></testcase>
      <testcase name="quebra" time="0.001" classname="test" file="/repo/a.test.mjs">
      <failure type="testCodeFailure" message="1 == 2">x</failure></testcase></testsuites>`
    expect(parseJUnit(xml, '/repo').map((r) => r.status)).toEqual(['timeout', 'failed'])

    // a suíte inteira que estoura o tempo também é estouro, não verde nem falha comum
    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const { spawn } = fakeSpawn('', { timedOut: true })
    const results = await runSuites(root, findSuites(root), { spawn, timeoutMs: 1000 })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'timeout', durationMs: 1000 })
  })

  test('node_test_only_project_is_discovered_run_and_read_test_by_test', async () => {
    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const suites = findSuites(root)
    expect(suites).toEqual([
      { dir: '', toolchain: 'node-test', argv: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={out}'] },
    ])
    const file = path.join(root, 'tests', 'a.test.mjs')
    const { spawn, calls } = fakeSpawn(`<testsuites>
      <testcase name="soma" time="0.002" classname="test" file="${file}"/>
      <testcase name="falha" time="0.001" classname="test" file="${file}"><failure type="testCodeFailure" message="x">x</failure></testcase>
    </testsuites>`)
    const results = await runSuites(root, suites, { spawn, timeoutMs: 5000 })
    expect(results.map(pick)).toEqual([
      { id: 'tests/a.test.mjs::soma', status: 'passed', durationMs: 2 },
      { id: 'tests/a.test.mjs::falha', status: 'failed', durationMs: 1 },
    ])
    expect(calls[0]).toMatchObject({ cmd: 'node', cwd: root, timeoutMs: 5000 })
    expect(calls[0].args.some((a) => a.includes('{out}'))).toBe(false)

    // only: roda só o arquivo pedido, na suíte que o contém
    await runSuites(root, suites, { spawn, timeoutMs: 5000, only: 'tests/a.test.mjs' })
    expect(calls[1].args.at(-1)).toBe('tests/a.test.mjs')
  })

  test('malformed_report_marks_suite_unreadable_with_ade_error_never_green', async () => {
    for (const read of [
      () => parseJUnit('<html>quebrado</html>', '/repo'),
      () => parseJestJson('{"testResults": nada', '/repo'),
      () => parseJestJson('{"ok":true}', '/repo'),
      () => parseGoJson('isto não é json\n'),
      () => parseTrx('<Results/>'),
      () => parseCargo('saída qualquer sem resumo\n', ''),
    ]) {
      expect(read).toThrow(AdeError)
      expect(read).toThrow(expect.objectContaining({ code: 'runner_report_unreadable' }))
    }

    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const { spawn } = fakeSpawn('<<lixo', { exitCode: 0 })
    const run = runSuites(root, findSuites(root), { spawn, timeoutMs: 1000 })
    await expect(run).rejects.toBeInstanceOf(AdeError)
    await expect(run).rejects.toMatchObject({ code: 'runner_report_unreadable', details: { dir: '', toolchain: 'node-test' } })

    // relatório que nem foi escrito também é ilegível
    const silent: SpawnSuite = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    await expect(runSuites(root, findSuites(root), { spawn: silent, timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'runner_report_unreadable',
    })
  })
})
