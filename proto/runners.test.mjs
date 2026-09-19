// node --test proto/runners.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseJUnit, parseTrx, parseGoJson, parseCargo, findSuites } from './runners.mjs'

test('JUnit: passou, falhou, erro, pulada e entidades XML', () => {
  const xml = `<testsuite><testcase classname="calc" name="soma &amp; sobe"/>
    <testcase classname="calc" name="divide"><failure message="esperado 2, veio 3">stack</failure></testcase>
    <testcase file="t/a.test.mjs" name="carrega"><error><![CDATA[TypeError: x is not a function]]></error></testcase>
    <testcase classname="calc" name="lenta"><skipped/></testcase></testsuite>`
  assert.deepEqual(parseJUnit(xml), [
    { name: 'calc > soma & sobe', status: 'passed', message: '' },
    { name: 'calc > divide', status: 'failed', message: 'esperado 2, veio 3' },
    { name: 't/a.test.mjs > carrega', status: 'failed', message: 'TypeError: x is not a function' },
  ])
})

test('TRX do dotnet: resultado por prova, NotExecuted fica fora', () => {
  const trx = `<Results><UnitTestResult testName="Calc.Soma" outcome="Passed" />
    <UnitTestResult testName="Calc.Divide" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure
Expected: 2</Message></ErrorInfo></Output></UnitTestResult>
    <UnitTestResult testName="Calc.Pula" outcome="NotExecuted" /></Results>`
  assert.deepEqual(parseTrx(trx), [
    { name: 'Calc.Soma', status: 'passed', message: '' },
    { name: 'Calc.Divide', status: 'failed', message: 'Assert.Equal() Failure' },
  ])
})

test('go test -json: prova, subprova, pulada e pacote que não compila', () => {
  const ev = (o) => JSON.stringify(o)
  const out = [
    ev({ Action: 'run', Package: 'm/calc', Test: 'TestSoma' }), ev({ Action: 'pass', Package: 'm/calc', Test: 'TestSoma' }),
    ev({ Action: 'output', Package: 'm/calc', Test: 'TestDivide/zero', Output: '    calc_test.go:14: esperado erro\n' }),
    ev({ Action: 'fail', Package: 'm/calc', Test: 'TestDivide/zero' }), ev({ Action: 'fail', Package: 'm/calc', Test: 'TestDivide' }),
    ev({ Action: 'skip', Package: 'm/calc', Test: 'TestLenta' }), ev({ Action: 'fail', Package: 'm/calc' }),
    ev({ ImportPath: 'm/api [m/api.test]', Action: 'build-output', Output: '# m/api\napi/h.go:3:2: undefined: Foo\n' }),
    ev({ ImportPath: 'm/api [m/api.test]', Action: 'build-fail' }), ev({ Action: 'fail', Package: 'm/api', FailedBuild: 'm/api [m/api.test]' }),
    'linha que não é JSON',
  ].join('\n')
  assert.deepEqual(parseGoJson(out), [
    { name: 'm/calc > TestSoma', status: 'passed', message: '' },
    { name: 'm/calc > TestDivide/zero', status: 'failed', message: 'calc_test.go:14: esperado erro' },
    { name: 'm/calc > TestDivide', status: 'failed', message: '' },
    { name: 'm/api (pacote não compila ou não roda)', status: 'failed', message: 'api/h.go:3:2: undefined: Foo' },
  ])
})

test('cargo test: ok, FAILED com motivo, ignored fora', () => {
  const out = `running 3 tests
test calc::soma ... ok
test calc::divide ... FAILED
test calc::lenta ... ignored

failures:

---- calc::divide stdout ----
thread 'calc::divide' panicked at src/lib.rs:9:5:
note: run with RUST_BACKTRACE=1`
  assert.deepEqual(parseCargo(out), [
    { name: 'calc::soma', status: 'passed', message: '' },
    { name: 'calc::divide', status: 'failed', message: "thread 'calc::divide' panicked at src/lib.rs:9:5:" },
  ])
})

test('suítes: raiz Go + frontend JS em subpasta; exemplo e ecossistema repetido ficam fora', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ade-suites-'))
  writeFileSync(path.join(d, 'go.mod'), 'module m\n')
  for (const sub of ['web', 'examples', 'tools']) mkdirSync(path.join(d, sub))
  writeFileSync(path.join(d, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  writeFileSync(path.join(d, 'examples', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  writeFileSync(path.join(d, 'tools', 'go.mod'), 'module t\n')
  assert.deepEqual(findSuites(d).map((s) => [s.cwd, s.runner, s.language]), [['', 'go', 'go'], ['web', 'node-test', 'js']])
})
