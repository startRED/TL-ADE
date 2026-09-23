import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildWorkerEnv } from './spawn.ts'
import { parseCargo, parseGoJson, parseJestJson, parseJUnit, parseTrx, TestRunnerError } from './test-reports.ts'
import type { TestResult } from './test-reports.ts'

/**
 * Suíte descoberta: pasta relativa à raiz ('' = raiz), toolchain e argv. `{out}`/`{outdir}` = relatório fora do projeto.
 */
export interface Suite {
  dir: string
  toolchain: string
  argv: string[]
}

export interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SpawnSuite = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<SpawnResult>

type Report = 'jest' | 'junit' | 'go' | 'cargo' | 'trx'

const has = (dir: string, file: string): boolean => existsSync(path.join(dir, file))

function testScript(dir: string): string {
  const file = path.join(dir, 'package.json')
  try {
    const script: unknown = JSON.parse(readFileSync(file, 'utf8'))?.scripts?.test
    return typeof script === 'string' ? script : ''
  } catch (err) {
    throw new TestRunnerError('config', `package.json ilegível: ${file}`, { file, cause: (err as Error).message })
  }
}

// pelo manifesto, não pelo executável instalado: checkout sem node_modules não pode sumir com a suíte (falha ao rodar)
const jsRunner = (d: string, name: string): boolean => has(d, 'package.json') && new RegExp(`\\b${name}\\b`).test(testScript(d))

// Na ordem; por pasta vale o primeiro de cada grupo. `one` = o runner aceita rodar um arquivo só (`only`).
const TOOLCHAINS: Array<{ toolchain: string; group: string; report: Report; one: boolean; argv: string[]; when: (dir: string) => boolean }> = [
  { toolchain: 'vitest', group: 'js', report: 'jest', one: true, argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile={out}'], when: (d) => jsRunner(d, 'vitest') },
  { toolchain: 'jest', group: 'js', report: 'jest', one: true, argv: ['node', 'node_modules/jest/bin/jest.js', '--ci', '--json', '--outputFile={out}'], when: (d) => jsRunner(d, 'jest') },
  { toolchain: 'node-test', group: 'js', report: 'junit', one: true, argv: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={out}'], when: (d) => jsRunner(d, 'node\\s+--test') },
  { toolchain: 'go', group: 'go', report: 'go', one: false, argv: ['go', 'test', '-json', './...'], when: (d) => has(d, 'go.mod') },
  { toolchain: 'cargo', group: 'rust', report: 'cargo', one: false, argv: ['cargo', 'test', '--no-fail-fast'], when: (d) => has(d, 'Cargo.toml') },
  { toolchain: 'dotnet', group: 'dotnet', report: 'trx', one: false, argv: ['dotnet', 'test', '--logger', 'trx', '--results-directory', '{outdir}'], when: (d) => readdirSync(d).some((f) => /\.(sln|slnx|csproj|fsproj)$/i.test(f)) },
]

// pastas com ponto (.git, .ade = estado do motor), dependências, build e exemplos nunca viram suíte
const SKIP = /^(\..*|node_modules|vendor|target|dist|build|out|obj|bin|coverage|__pycache__|examples?|samples?|docs?|fixtures|testdata|third_party|external)$/i

/**
 * Descobre as suítes da raiz e das subpastas diretas. Subpasta só entra com grupo que a raiz não tem (frontend JS num
 * projeto Go), para a mesma prova não rodar duas vezes.
 */
export function findSuites(root: string): Suite[] {
  const at = (dir: string): Array<Suite & { group: string }> => {
    const abs = path.join(root, dir)
    const seen = new Set<string>()
    const out: Array<Suite & { group: string }> = []
    for (const t of TOOLCHAINS) {
      if (seen.has(t.group) || !t.when(abs)) continue
      seen.add(t.group)
      out.push({ dir, toolchain: t.toolchain, argv: [...t.argv], group: t.group })
    }
    return out
  }
  const top = at('')
  const rootGroups = new Set(top.map((s) => s.group))
  // ponytail: só um nível de subpasta; recursão quando aparecer projeto com toolchain mais fundo
  const subdirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP.test(e.name))
    .map((e) => e.name)
    .sort()
  return [...top, ...subdirs.flatMap((d) => at(d).filter((s) => !rootGroups.has(s.group)))].map(({ dir, toolchain, argv }) => ({ dir, toolchain, argv }))
}

// variáveis que os toolchains precisam para achar cache e instalação; segredos continuam barrados por buildWorkerEnv
const TOOLCHAIN_ENV = ['LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'DOTNET_ROOT']

/**
 * Processo real de uma suíte: sem shell, com maxBuffer e morto ao estourar o tempo.
 */
export const execSuite: SpawnSuite = (cmd, args, { cwd, timeoutMs }) => {
  const extras: Record<string, string> = {}
  for (const k of TOOLCHAIN_ENV) {
    const v = process.env[k]
    if (v !== undefined) extras[k] = v
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, shell: false, windowsHide: true, maxBuffer: 1 << 28, timeout: timeoutMs, killSignal: 'SIGKILL', env: buildWorkerEnv(extras) },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error?.killed)
        resolve({
          exitCode: timedOut ? null : typeof error?.code === 'number' ? error.code : error ? null : 0,
          stdout,
          stderr: error && typeof error.code !== 'number' && !timedOut ? `${stderr}\n${error.message}` : stderr,
          timedOut,
        })
      },
    )
  })
}

async function readReport(report: Report, { out, outdir, cwd, r }: { out: string; outdir: string; cwd: string; r: SpawnResult }): Promise<TestResult[]> {
  if (report === 'go') return parseGoJson(r.stdout)
  if (report === 'cargo') return parseCargo(r.stdout, r.stderr)
  if (report === 'trx') {
    const trx = (await readdir(outdir, { recursive: true })).filter((f) => /\.trx$/i.test(f))
    if (!trx.length) throw new TestRunnerError('report_unreadable', 'relatório trx ausente', { format: 'trx' })
    const texts = await Promise.all(trx.map((f) => readFile(path.join(outdir, f), 'utf8')))
    return texts.flatMap(parseTrx)
  }
  let text: string
  try {
    text = await readFile(out, 'utf8')
  } catch (err) {
    throw new TestRunnerError('report_unreadable', `relatório ${report} ausente: ${(err as Error).message}`, { format: report })
  }
  return report === 'jest' ? parseJestJson(text, cwd) : parseJUnit(text, cwd)
}

/**
 * Roda cada suíte e devolve o resultado prova a prova. Suíte de subpasta leva a pasta na frente da suíte do relatório.
 * `only` (relativo à raiz) roda só esse arquivo de prova, nas suítes que o contêm.
 * Relatório ausente ou ilegível lança `runner_report_unreadable`; nunca vira verde.
 */
export async function runSuites(root: string, suites: Suite[], { spawn, timeoutMs, only }: { spawn: SpawnSuite; timeoutMs: number; only?: string }): Promise<TestResult[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TestRunnerError('config', `timeoutMs inválido: ${timeoutMs}`)
  const results: TestResult[] = []
  let ranOnly = false
  for (const s of suites) {
    const tc = TOOLCHAINS.find((t) => t.toolchain === s.toolchain)
    if (!tc) throw new TestRunnerError('config', `toolchain desconhecido: ${s.toolchain}`, { dir: s.dir })
    const cwd = path.join(root, s.dir)
    let argv = s.argv
    if (only !== undefined) {
      const rel = path.relative(cwd, path.resolve(root, only))
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !tc.one) continue
      argv = [...argv, rel.split(path.sep).join('/')]
      ranOnly = true
    }
    const outdir = await mkdtemp(path.join(os.tmpdir(), 'ade-suite-'))
    const out = path.join(outdir, 'report')
    try {
      const args = argv.map((a) => a.replaceAll('{outdir}', outdir).replaceAll('{out}', out))
      const r = await spawn(args[0], args.slice(1), { cwd, timeoutMs })
      const label = s.dir || '.'
      if (r.timedOut) {
        results.push({ id: `${label}::${s.toolchain}`, suite: label, name: s.toolchain, status: 'timeout', durationMs: timeoutMs })
        continue
      }
      let read: TestResult[]
      try {
        read = await readReport(tc.report, { out, outdir, cwd, r })
      } catch (err) {
        if (err instanceof TestRunnerError) throw new TestRunnerError('report_unreadable', err.message, { ...err.details, dir: s.dir, toolchain: s.toolchain })
        throw err
      }
      // suíte sem nenhuma prova lida (saída vazia, relatório sem testcase) não é verde
      if (!read.length) throw new TestRunnerError('report_unreadable', 'relatório sem nenhuma prova', { dir: s.dir, toolchain: s.toolchain })
      for (const t of read) {
        const suite = s.dir ? `${s.dir}/${t.suite}` : t.suite
        results.push({ ...t, suite, id: `${suite}::${t.name}` })
      }
      // saiu com erro sem prova vermelha (não compila, limite de cobertura): a suíte não está verde
      if (r.exitCode !== 0 && !read.some((t) => t.status === 'failed' || t.status === 'timeout')) {
        const name = `${s.toolchain} (saiu com código ${r.exitCode})`
        results.push({ id: `${label}::${name}`, suite: label, name, status: 'failed', durationMs: 0 })
      }
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }
  if (only !== undefined && !ranOnly) throw new TestRunnerError('only_unsupported', `nenhuma suíte roda só o arquivo ${only}`, { only })
  return results
}
