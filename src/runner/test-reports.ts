import path from 'node:path'
import { AdeError } from '../journal/errors.ts'

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'timeout'

/**
 * Resultado de uma prova; `id` = `suite::name`, igual em qualquer máquina.
 */
export interface TestResult {
  id: string
  suite: string
  name: string
  status: TestStatus
  durationMs: number
}

/**
 * Sinaliza falha do executor de provas (relatório ilegível, configuração inválida).
 */
export class TestRunnerError extends AdeError {
  constructor(reason: string, message: string, details: Record<string, unknown> = {}) {
    super('runner_' + reason, message, 2, { ...details, reason })
  }
}

const unreadable = (format: string, why: string): TestRunnerError =>
  new TestRunnerError('report_unreadable', `relatório ${format} ilegível: ${why}`, { format })

const result = (suite: string, name: string, status: TestStatus, durationMs: number): TestResult => ({
  id: `${suite}::${name}`,
  suite,
  name,
  status,
  durationMs: Math.round(durationMs),
})

// estouro vem no texto da falha: node --test (tipo testTimeoutFailure, "test timed out after"), vitest ("Test timed out
// in"), go ("panic: test timed out"), jest ("Exceeded timeout of") e pytest-timeout ("Failed: Timeout")
const TIMED_OUT = /test timed out|exceeded timeout of|timeoutfailure|failed: timeout/i

// caminho absoluto do relatório vira relativo à pasta da suíte, com barra normal
function relative(cwd: string, file: string): string {
  const rel = path.relative(cwd, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file
}

const unxml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')

const attr = (tag: string, key: string): string | undefined => {
  const v = tag.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1]
  return v === undefined ? undefined : unxml(v)
}

/**
 * Lê JUnit XML (node --test, pytest, phpunit, deno, swift). Suíte = `file` relativo a `cwd`, senão `classname`.
 */
export function parseJUnit(report: string, cwd: string): TestResult[] {
  // comentário e CDATA são texto: "<testcase" ou "<skipped" dentro deles não é marcação
  const xml = report.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  if (!/<testsuites?\b/.test(xml)) throw unreadable('junit', 'sem <testsuites> nem <testsuite>')
  // relatório cortado no meio não fecha a raiz: as provas que faltam não podem sumir caladas
  if (!/(<\/testsuites?>|<testsuites?\b[^>]*\/>)\s*$/.test(xml)) throw unreadable('junit', 'truncado: raiz não fechada')
  // valor entre aspas pode ter '>' cru: o reporter junit do node não o escapa
  const cases = [...xml.matchAll(/<testcase\b((?:[^<>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
  // testcase sem fechamento some do regex ou engole o seguinte: com a raiz fechada, a prova perdida viraria verde
  const count = (re: RegExp): number => xml.match(re)?.length ?? 0
  if (count(/<testcase\b/g) !== cases.length || count(/<\/testcase>/g) !== cases.filter((m) => m[2] !== undefined).length) {
    throw unreadable('junit', 'testcase sem fechamento ou fechamento sem testcase')
  }
  const out: TestResult[] = []
  for (const [, head, body = ''] of cases) {
    const name = attr(head, 'name')
    const file = attr(head, 'file')
    const suite = file ? relative(cwd, file) : attr(head, 'classname')
    const time = Number(attr(head, 'time') ?? 0)
    if (!name || !suite || !Number.isFinite(time)) throw unreadable('junit', `testcase incompleto: ${head.trim()}`)
    const fail = body.match(/<(failure|error)\b([^>]*)>/)
    const status: TestStatus = /<skipped\b/.test(body)
      ? 'skipped'
      : !fail
        ? 'passed'
        : TIMED_OUT.test(`${attr(fail[2], 'type') ?? ''} ${attr(fail[2], 'message') ?? ''}`)
          ? 'timeout'
          : 'failed'
    out.push(result(suite, name, status, time * 1000))
  }
  return out
}

interface JestAssertion {
  fullName?: unknown
  status?: unknown
  duration?: unknown
  failureMessages?: unknown
}

const JEST_SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled'])

function jestStatus(status: unknown, why: string): TestStatus {
  if (status === 'passed') return 'passed'
  if (status === 'failed') return TIMED_OUT.test(why) ? 'timeout' : 'failed'
  if (JEST_SKIPPED.has(String(status))) return 'skipped'
  throw unreadable('jest', `estado desconhecido: ${String(status)}`)
}

/**
 * Lê o JSON de vitest/jest (`--reporter=json` / `--json`). Suíte = arquivo relativo a `cwd`.
 */
export function parseJestJson(text: string, cwd: string): TestResult[] {
  let report: { testResults?: unknown }
  try {
    report = JSON.parse(text)
  } catch (err) {
    throw unreadable('jest', (err as Error).message)
  }
  if (!Array.isArray(report?.testResults)) throw unreadable('jest', 'sem testResults')
  const out: TestResult[] = []
  for (const file of report.testResults as Array<{ name?: unknown; status?: unknown; assertionResults?: unknown }>) {
    if (typeof file?.name !== 'string' || !Array.isArray(file.assertionResults)) throw unreadable('jest', 'arquivo sem name ou assertionResults')
    const suite = relative(cwd, file.name)
    // arquivo que nem carregou (erro de import, sintaxe) não tem prova, mas não pode sumir do resultado
    if (file.assertionResults.length === 0 && file.status === 'failed') {
      out.push(result(suite, '(arquivo não carregou)', 'failed', 0))
      continue
    }
    for (const a of file.assertionResults as JestAssertion[]) {
      if (typeof a.fullName !== 'string') throw unreadable('jest', 'prova sem fullName')
      const duration = typeof a.duration === 'number' ? a.duration : 0
      const why = Array.isArray(a.failureMessages) ? a.failureMessages.join('\n') : ''
      out.push(result(suite, a.fullName, jestStatus(a.status, why), duration))
    }
  }
  return out
}

// duração TRX: "hh:mm:ss.fffffff"
const trxMs = (d: string | undefined): number => {
  const m = d?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
  return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : 0
}

/**
 * Lê TRX do `dotnet test --logger trx`. Suíte = `className` da definição da prova.
 */
export function parseTrx(xml: string): TestResult[] {
  if (!/<TestRun\b/.test(xml)) throw unreadable('trx', 'sem <TestRun>')
  if (!/<\/TestRun>\s*$/.test(xml)) throw unreadable('trx', 'truncado: <TestRun> não fechado')
  const classOf = new Map<string, string>()
  for (const m of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const id = attr(m[1], 'id')
    const cls = attr(m[2].match(/<TestMethod\b([^>]*)/)?.[1] ?? '', 'className')
    if (id && cls) classOf.set(id, cls)
  }
  const out: TestResult[] = []
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>)/g)) {
    const name = attr(m[1], 'testName')
    const suite = classOf.get(attr(m[1], 'testId') ?? '')
    const outcome = attr(m[1], 'outcome')
    if (!name || !suite || !outcome) throw unreadable('trx', `UnitTestResult incompleto: ${m[1].trim()}`)
    const status: TestStatus =
      outcome === 'Passed' ? 'passed' : outcome === 'Timeout' ? 'timeout' : outcome === 'NotExecuted' ? 'skipped' : 'failed'
    out.push(result(suite, name, status, trxMs(attr(m[1], 'duration'))))
  }
  return out
}

interface GoEvent {
  Action?: string
  Package?: string
  Test?: string
  Elapsed?: number
  Output?: string
}

/**
 * Lê a saída de `go test -json`. Suíte = pacote; pacote que falhou fora de uma prova (não compila) vira prova vermelha.
 */
export function parseGoJson(text: string): TestResult[] {
  const tests = new Map<string, { pkg: string; test: string; action?: string; elapsed: number; out: string }>()
  const failedPkgs = new Set<string>()
  let events = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e: GoEvent
    try {
      e = JSON.parse(line)
    } catch (err) {
      throw unreadable('go', (err as Error).message)
    }
    if (!e.Package) continue
    events++
    if (!e.Test) {
      if (e.Action === 'fail') failedPkgs.add(e.Package)
      continue
    }
    const key = `${e.Package}::${e.Test}`
    const t = tests.get(key) ?? { pkg: e.Package, test: e.Test, elapsed: 0, out: '' }
    tests.set(key, t)
    if (e.Action === 'output') t.out += e.Output ?? ''
    else if (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip') {
      t.action = e.Action
      t.elapsed = e.Elapsed ?? 0
    }
  }
  if (!events) throw unreadable('go', 'nenhum evento de pacote')
  const out = [...tests.values()].map((t) =>
    result(
      t.pkg,
      t.test,
      t.action === 'pass' ? 'passed' : t.action === 'skip' ? 'skipped' : TIMED_OUT.test(t.out) ? 'timeout' : 'failed',
      t.elapsed * 1000,
    ),
  )
  for (const pkg of failedPkgs) {
    if (!out.some((r) => r.suite === pkg && r.status !== 'passed' && r.status !== 'skipped')) out.push(result(pkg, '(pacote)', 'failed', 0))
  }
  return out
}

/**
 * Lê a saída de `cargo test`. Cada binário de prova abre um bloco "running N tests" no stdout, na mesma ordem das
 * linhas "Running <alvo>" / "Doc-tests <crate>" que o cargo escreve no stderr; suíte = esse alvo.
 * O libtest estável não mede a duração por prova: `durationMs` fica 0.
 */
export function parseCargo(stdout: string, stderr: string): TestResult[] {
  if (!/^test result: /m.test(stdout)) throw unreadable('cargo', 'sem linha "test result:"')
  const targets = [...stderr.matchAll(/^\s*(?:Running (?:unittests )?(\S+)|Doc-tests (\S+))/gm)].map(
    (m) => m[1]?.replaceAll('\\', '/') ?? `doc-tests ${m[2]}`,
  )
  const blocks = stdout.split(/^running \d+ tests?$/m).slice(1)
  if (blocks.length !== targets.length) throw unreadable('cargo', `${blocks.length} blocos de prova para ${targets.length} alvos no stderr`)
  if (blocks.some((b) => !/^test result: /m.test(b))) throw unreadable('cargo', 'bloco de prova sem "test result:" (truncado)')
  return blocks.flatMap((block, i) =>
    [...block.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)\b.*$/gm)].map((m) =>
      result(targets[i], m[1], m[2] === 'ok' ? 'passed' : m[2] === 'ignored' ? 'skipped' : 'failed', 0),
    ),
  )
}
