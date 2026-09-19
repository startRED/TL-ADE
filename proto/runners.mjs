// Provas em qualquer ecossistema: reconhecer o projeto (e subpasta de outro ecossistema, ex.: backend Go + frontend JS),
// montar o comando que gera relatório prova a prova e ler esse relatório. Formato comum: JUnit XML, que quase todo runner
// gera sem pacote extra; jest/vitest (JSON), go (go test -json), cargo (texto estável) e dotnet (TRX) têm leitor próprio.
// Runner sem relatório (npm test, rspec, mix, dart) vale pelo código de saída: funciona, mas sem saber qual prova falhou.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile, readdir, stat, rm, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const IS_WIN = process.platform === 'win32'
const has = (d, f) => existsSync(path.join(d, f))
const pkg = (d) => { try { return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')) } catch { return {} } }
const dirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } }
const files = (d) => { try { return readdirSync(d) } catch { return [] } }
const val = (v, d) => (typeof v === 'function' ? v(d) : v)

// Na ordem; vale o primeiro de cada grupo por pasta. {out} = arquivo de relatório, {outdir} = pasta de relatório (ambos fora
// do projeto), {python} = interpretador do .venv do projeto. Sem report = só código de saída; sem test_cmd = só a linguagem.
const ECOSYSTEMS = [
  { group: 'js', runner: 'vitest', language: 'js', when: (d) => has(d, 'package.json') && has(d, 'node_modules/vitest/vitest.mjs'), test_cmd: 'node node_modules/vitest/vitest.mjs run', report: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile={out}'], one: ['node', 'node_modules/vitest/vitest.mjs', 'run', '{file}', '--passWithNoTests', '--reporter=json', '--outputFile={out}'], format: 'jest' },
  { group: 'js', runner: 'jest', language: 'js', when: (d) => has(d, 'package.json') && has(d, 'node_modules/jest/bin/jest.js'), test_cmd: 'node node_modules/jest/bin/jest.js', report: ['node', 'node_modules/jest/bin/jest.js', '--ci', '--json', '--outputFile={out}'], one: ['node', 'node_modules/jest/bin/jest.js', '--ci', '--json', '--outputFile={out}', '--passWithNoTests', '--runTestsByPath', '{file}'], format: 'jest' },
  { group: 'js', runner: 'node-test', language: 'js', when: (d) => /\bnode\s+--test\b/.test(pkg(d).scripts?.test || ''), test_cmd: 'node --test', report: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={out}'], one: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={out}', '{file}'], format: 'junit' },
  { group: 'js', runner: 'npm', language: 'js', when: (d) => { const t = pkg(d).scripts?.test; return !!t && !/no test specified/.test(t) }, test_cmd: 'npm test' },
  { group: 'js', runner: 'none', language: 'js', when: (d) => has(d, 'package.json') },
  { group: 'python', runner: 'pytest', language: 'python', when: (d) => ['pyproject.toml', 'pytest.ini', 'requirements.txt', 'setup.py', 'setup.cfg'].some((f) => has(d, f)), test_cmd: '.venv\\Scripts\\python.exe -m pytest -q', report: ['{python}', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml={out}'], one: ['{python}', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml={out}', '{file}'], format: 'junit' },
  { group: 'go', runner: 'go', language: 'go', when: (d) => has(d, 'go.mod'), test_cmd: 'go test ./...', report: ['go', 'test', '-json', './...'], one: ['go', 'test', '-json', '{pkg}'], format: 'gojson' },
  { group: 'rust', runner: 'cargo', language: 'rust', when: (d) => has(d, 'Cargo.toml'), test_cmd: 'cargo test', report: ['cargo', 'test', '--no-fail-fast'], format: 'cargo' },
  { group: 'jvm', runner: 'maven', language: 'java', when: (d) => has(d, 'pom.xml'), test_cmd: 'mvn test', report: ['mvn', '-q', '-B', 'test'], format: 'junit-dir', dir: 'target/surefire-reports' },
  { group: 'jvm', runner: 'gradle', language: (d) => (has(d, 'build.gradle.kts') ? 'kotlin' : 'java'), when: (d) => has(d, 'build.gradle') || has(d, 'build.gradle.kts'), test_cmd: (d) => (has(d, IS_WIN ? 'gradlew.bat' : 'gradlew') ? (IS_WIN ? 'gradlew.bat test' : './gradlew test') : 'gradle test'), report: (d) => [has(d, IS_WIN ? 'gradlew.bat' : 'gradlew') ? (IS_WIN ? 'gradlew.bat' : './gradlew') : 'gradle', 'test', '--continue'], format: 'junit-dir', dir: 'build/test-results' },
  { group: 'dotnet', runner: 'dotnet', language: 'csharp', when: (d) => files(d).some((f) => /\.(sln|slnx|csproj|fsproj)$/i.test(f)), test_cmd: 'dotnet test', report: ['dotnet', 'test', '--logger', 'trx', '--results-directory', '{outdir}'], format: 'trx' },
  { group: 'php', runner: 'phpunit', language: 'php', when: (d) => has(d, 'composer.json'), test_cmd: 'vendor/bin/phpunit', report: [IS_WIN ? 'vendor\\bin\\phpunit.bat' : 'vendor/bin/phpunit', '--log-junit', '{out}'], one: [IS_WIN ? 'vendor\\bin\\phpunit.bat' : 'vendor/bin/phpunit', '--log-junit', '{out}', '{file}'], format: 'junit' },
  { group: 'swift', runner: 'swift', language: 'swift', when: (d) => has(d, 'Package.swift'), test_cmd: 'swift test', report: ['swift', 'test', '--xunit-output', '{out}'], format: 'junit' },
  { group: 'deno', runner: 'deno', language: 'ts', when: (d) => has(d, 'deno.json') || has(d, 'deno.jsonc'), test_cmd: 'deno test -A', report: ['deno', 'test', '-A', '--junit-path={out}'], one: ['deno', 'test', '-A', '--junit-path={out}', '{file}'], format: 'junit' },
  { group: 'dart', runner: 'dart', language: 'dart', when: (d) => has(d, 'pubspec.yaml'), test_cmd: (d) => (/^\s*flutter:/m.test(readFileSync(path.join(d, 'pubspec.yaml'), 'utf8')) ? 'flutter test' : 'dart test') },
  { group: 'ruby', runner: 'ruby', language: 'ruby', when: (d) => has(d, 'Gemfile'), test_cmd: (d) => (has(d, 'spec') ? 'bundle exec rspec' : 'bundle exec rake test') },
  { group: 'elixir', runner: 'mix', language: 'elixir', when: (d) => has(d, 'mix.exs'), test_cmd: 'mix test' },
]
// ferramentas que o planejador precisa saber se existem nesta máquina antes de escolher linguagem para projeto novo
export const TOOLCHAINS = ['node', 'python', 'uv', 'go', 'cargo', 'dotnet', 'java', 'mvn', 'gradle', 'php', 'composer', 'ruby', 'bundle', 'deno', 'bun', 'swift', 'dart', 'flutter', 'mix']

// Subpasta só entra com ecossistema que a raiz não tem (frontend/ JS num projeto Go); pastas de exemplo, dependência e build nunca.
const SKIP = /^(\..*|node_modules|vendor|target|dist|build|out|obj|bin|coverage|__pycache__|examples?|samples?|docs?|fixtures|testdata|third_party|external)$/i
export function findSuites(root) {
  const at = (rel) => {
    const d = path.join(root, rel), seen = new Set(), out = []
    for (const e of ECOSYSTEMS) {
      if (seen.has(e.group) || !e.when(d)) continue
      seen.add(e.group)
      out.push({ cwd: rel.split(path.sep).join('/'), group: e.group, runner: e.runner, language: val(e.language, d), test_cmd: val(e.test_cmd, d) || null, report: val(e.report, d) || null, one: e.one || null, format: e.format || null, dir: e.dir || null })
    }
    return out
  }
  const top = at(''), groups = new Set(top.map((s) => s.group))
  return [...top, ...dirs(root).filter((n) => !SKIP.test(n)).flatMap((n) => at(n).filter((s) => !groups.has(s.group)))]
}

// ---------- leitores de relatório ----------
const unxml = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
const attr = (tag, k) => unxml(tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1])
const firstLine = (s) => (String(s || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, 300)

export function parseJUnit(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] || ''
    if (/<skipped\b/.test(body)) continue
    const f = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/)
    const where = attr(m[1], 'file') || attr(m[1], 'classname')
    out.push({ name: [where, attr(m[1], 'name')].filter(Boolean).join(' > '), status: f ? 'failed' : 'passed', message: f ? firstLine(attr(f[2], 'message') || unxml(f[3]).replace(/<!\[CDATA\[|\]\]>/g, '')) : '' })
  }
  return out
}
export function parseTrx(xml) {
  return [...String(xml).matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)]
    .map((m) => ({ outcome: attr(m[1], 'outcome'), name: attr(m[1], 'testName'), body: m[2] || '' }))
    .filter((t) => t.outcome !== 'NotExecuted')
    .map((t) => ({ name: t.name, status: t.outcome === 'Passed' ? 'passed' : 'failed', message: t.outcome === 'Passed' ? '' : firstLine(unxml(t.body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1])) }))
}
// linha "arquivo_test.go:12: ..." é o motivo; sem ela, a primeira linha que não é cabeçalho do go test
const goWhy = (s) => { const ls = String(s).split('\n'); return (ls.find((l) => /\.go:\d+/.test(l)) || ls.find((l) => l.trim() && !/^\s*(=== |--- |FAIL|PASS|ok\s|#)/.test(l)) || '').trim().slice(0, 300) }
export function parseGoJson(text) {
  const tests = new Map(), failedPkgs = new Set(), build = []
  for (const line of String(text).split('\n')) {
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.Action === 'build-output') { build.push(e.Output || ''); continue }
    if (!e.Package) continue
    if (!e.Test) { if (e.Action === 'fail') failedPkgs.add(e.Package); continue }
    const k = `${e.Package} > ${e.Test}`, t = tests.get(k) || { name: k, status: 'passed', out: '' }
    tests.set(k, t)
    if (e.Action === 'output') t.out += e.Output || ''
    else if (e.Action === 'fail') t.status = 'failed'
    else if (e.Action === 'skip') t.status = 'skip'
  }
  const out = [...tests.values()].filter((t) => t.status !== 'skip').map((t) => ({ name: t.name, status: t.status, message: t.status === 'failed' ? goWhy(t.out) : '' }))
  for (const p of failedPkgs) if (!out.some((t) => t.status === 'failed' && t.name.startsWith(`${p} > `))) out.push({ name: `${p} (pacote não compila ou não roda)`, status: 'failed', message: goWhy(build.join('')) || 'o pacote falhou fora de uma prova' })
  return out
}
export function parseCargo(text) {
  const s = String(text)
  return [...s.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)\s*$/gm)].filter((m) => m[2] !== 'ignored').map((m) => ({
    name: m[1], status: m[2] === 'ok' ? 'passed' : 'failed',
    message: m[2] === 'ok' ? '' : ((s.split(`---- ${m[1]} stdout ----`)[1] || '').split('\n').map((l) => l.trim()).find((l) => l && !/^note:/.test(l)) || '').slice(0, 300),
  }))
}
export function parseJest(j) {
  return j.testResults.flatMap((f) => (f.assertionResults.length === 0 && f.status === 'failed'
    ? [{ name: `${path.basename(f.name)} (arquivo ainda não roda)`, status: 'failed', message: firstLine(f.message).slice(0, 200) }]
    : f.assertionResults.filter((a) => !['skipped', 'pending', 'todo', 'disabled'].includes(a.status)).map((a) => ({ name: a.fullName, status: a.status === 'passed' ? 'passed' : 'failed', message: firstLine((a.failureMessages || [])[0]) }))))
}
async function readReport(s, { out, outdir, cwd, t0, stdout }) {
  if (s.format === 'jest') { const j = JSON.parse(await readFile(out, 'utf8')); return { tests: parseJest(j), files: j.testResults.map((f) => f.name) } }
  if (s.format === 'junit') return { tests: parseJUnit(await readFile(out, 'utf8')) }
  if (s.format === 'gojson') return { tests: parseGoJson(stdout) }
  if (s.format === 'cargo') return { tests: parseCargo(stdout) }
  // relatório em pasta (Maven/Gradle escrevem no projeto; TRX vai para a pasta temporária): só arquivos desta execução
  const [base, rx, parse] = s.format === 'trx' ? [outdir, /\.trx$/i, parseTrx] : [path.join(cwd, s.dir), /\.xml$/i, parseJUnit]
  const tests = []
  for (const f of (await readdir(base, { recursive: true })).filter((x) => rx.test(x))) {
    const p = path.join(base, f); if ((await stat(p)).mtimeMs >= t0 - 2000) tests.push(...parse(await readFile(p, 'utf8')))
  }
  return { tests }
}

// only = arquivo de prova (relativo ao projeto): roda só ele, nas suítes que o contêm e sabem rodar um arquivo. Devolve null
// quando nenhuma o rodou (runner sem molde de um arquivo, arquivo fora do include): quem chamou roda a suíte inteira.
// Roda cada suíte e junta tudo num resultado só. named = todas deram resultado prova a prova (o motor confere prova nova
// vermelha, regressão e prova que passa sem o código); senão, vale o código de saída da suíte que não deu.
// Nome de prova de subpasta leva a subpasta na frente; da raiz fica igual ao do runner (missão em andamento não muda de nomes).
// runner que recebeu um arquivo fora do include (vitest, jest) ou sem prova coletada (pytest)
const NO_TESTS = /no test files found|no tests found|no tests ran|collected 0 items/i
export async function runSuites(dir, suites, { run, python, timeoutMs = 5 * 60 * 1000, only = null }) {
  const target = only && path.resolve(dir, only)
  const inSuite = (s) => { const r = path.relative(path.join(dir, s.cwd), target); return !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null }
  const live = suites.filter((s) => s.test_cmd && (!only || (s.one && inSuite(s))))
  if (only && !live.length) return null
  if (!live.length) return { ok: false, total: 0, failed: 0, tests: [], runner: 'none', named: false, covered: [] }
  const tests = [], tails = [], covered = []
  let named = true, timeout = false
  for (const s of live) {
    const cwd = path.join(dir, s.cwd), tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-t-')), out = path.join(tmp, 'report.out'), t0 = Date.now()
    try {
      const file = only ? inSuite(s) : null
      const argv = (file ? s.one : s.report || s.test_cmd.split(' ')).map((a) => a.replaceAll('{out}', out).replaceAll('{outdir}', tmp).replaceAll('{file}', file || '').replaceAll('{pkg}', file ? `./${path.posix.dirname(file)}` : ''))
      if (argv[0] === '{python}') argv[0] = await python(cwd)
      // NODE_TEST_CONTEXT herdado de um node --test em volta faz o node --test filho ignorar o relatório; undefined tira do ambiente
      const r = await run(argv[0], argv.slice(1), { cwd, timeoutMs, env: { NODE_TEST_CONTEXT: undefined } })
      timeout ||= !!r.timedOut
      const tail = `${r.out}\n${r.err}`.trim().split('\n').slice(-12).join('\n')
      tails.push(tail)
      let rep = null
      try { rep = s.format ? await readReport(s, { out, outdir: tmp, cwd, t0, stdout: r.out }) : null } catch {}
      const pre = s.cwd ? `${s.cwd}: ` : ''
      if (rep?.tests.length) {
        // relatório que põe o caminho absoluto no nome (node --test): nome relativo, igual em qualquer máquina
        const rel = (n) => n.replaceAll(cwd + path.sep, '').replaceAll(cwd.split(path.sep).join('/') + '/', '')
        tests.push(...rep.tests.map((t) => ({ ...t, name: pre + rel(t.name) })))
        covered.push(...(rep.files || []))
        // tudo passou mas o runner saiu com erro (arquivo que não compila, limite de cobertura): a suíte não está verde
        if (r.code !== 0 && !rep.tests.some((t) => t.status !== 'passed')) tests.push({ name: `${pre}${s.test_cmd} (saiu com código ${r.code})`, status: 'failed', message: tail.slice(-300) })
      } else if (only) {
        // um arquivo: runner que não achou prova nele (fora do include) não conta; quem chamou decide. O vitest sai com código 1
        // ("No test files found"): contava como prova vermelha e a parte 1 do épico 2 gastou duas rodadas no Sol sem nada a corrigir
        if ((rep && r.code === 0) || NO_TESTS.test(`${r.out}\n${r.err}`)) continue
        tests.push({ name: `${pre}${file}`, status: 'failed', message: tail.slice(-300) })
      } else {
        named = false
        tests.push({ name: pre + s.test_cmd, status: r.code === 0 ? 'passed' : 'failed', message: r.code === 0 ? '' : tail.slice(-300) })
      }
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  }
  if (only && !tests.length) return null
  const failed = tests.filter((t) => t.status !== 'passed').length
  return { ok: failed === 0 && tests.length > 0, total: tests.length, failed, tests, runner: live.map((s) => s.runner).join('+'), named, timeout, covered, output: tails.join('\n').slice(-2000), only: only || undefined }
}
