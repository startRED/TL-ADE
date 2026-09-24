import fs from 'node:fs'
import path from 'node:path'
import { judgeSuite } from '../runner/baseline.ts'
import { execSuite, findSuites, runSuites } from '../runner/suites.ts'
import type { SpawnSuite } from '../runner/suites.ts'
import { TestRunnerError } from '../runner/test-reports.ts'
import type { TestResult } from '../runner/test-reports.ts'
import { resolveGateArgv, runContained } from './command.ts'
import { newDiagnostics, parseDiagnostics } from './diagnostics.ts'
import type { Diagnostic, DiagnosticTool } from './diagnostics.ts'
import { buildExtract, safeId, writeRawArtifact } from './output.ts'
import type { BuildExtractResult } from './output.ts'
import type { GateSpec, PackageJsonSpec } from './types.ts'

// portão cuja saída se compara com o commit-base da parte por diagnóstico
const DIAGNOSTIC_TOOL: Readonly<Record<string, DiagnosticTool>> = Object.freeze({ typecheck: 'tsc', lint: 'oxlint' })

interface GitPort {
  worktreeDir: string
  worktreeTree: () => Promise<string>
  restoreTree: (tree: string, options: { label: string} ) => Promise<any>
}

interface GateResult {
  gate_id: string
  status: import('./output.ts').ExtractStatus
  exit_code: number | null
  argv: string[]
  extract: import('./output.ts').BuildExtractResult
  raw_ref: string
  reused: boolean
  new_diagnostics?: Diagnostic[]
  chargeable_reds?: string[]
}

// só o que a parte responde: diagnóstico novo ou prova cobrada
interface Judged {
  extract: BuildExtractResult
  new_diagnostics?: Diagnostic[]
  chargeable_reds?: string[]
}

interface RestorePendingGateResult {
  restored: boolean
  tree: string | null
  blocked?: boolean
}

/**
 * Grava atomicamente o marcador durável de restauração de gate.
 */
export function writeMarkerSync(missionDir: string, data: { gate_id: string; tree_before: string; worktree: string }): void {
  const file = path.join(missionDir, 'gate-restore.json')
  const tmp = path.join(missionDir, 'gate-restore.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Remove o marcador durável de restauração de gate se existir.
 */
export function clearMarkerSync(missionDir: string): void {
  const file = path.join(missionDir, 'gate-restore.json')
  fs.rmSync(file, { force: true })
  fs.rmSync(path.join(missionDir, 'gate-restore.json.tmp'), { force: true })
}

/**
 * Restaura o worktree para a árvore anterior se houver marcador pendente de crash.
 * Marcador inválido, ilegível ou de outro worktree bloqueia a rodada.
 */
export async function restorePendingGate({ missionDir, gitPort }: { missionDir: string; gitPort: GitPort }): Promise<RestorePendingGateResult> {
  const markerPath = path.join(missionDir, 'gate-restore.json')
  if (!fs.existsSync(markerPath)) {
    return { restored: false, tree: null }
  }

  let marker
  try {
    const raw = fs.readFileSync(markerPath, 'utf8')
    marker = JSON.parse(raw)
  } catch {
    return { restored: false, tree: null, blocked: true }
  }

  if (
    !marker ||
    typeof marker !== 'object' ||
    typeof marker.tree_before !== 'string' ||
    !marker.tree_before ||
    marker.worktree !== gitPort.worktreeDir
  ) {
    return { restored: false, tree: null, blocked: true }
  }

  const label = 'gate-' + (marker.gate_id ? safeId(String(marker.gate_id)) : 'pending')
  await gitPort.restoreTree(marker.tree_before, { label })
  clearMarkerSync(missionDir)

  return { restored: true, tree: marker.tree_before }
}

interface CreateGateRunnerOptions {
  step: (spec: any, effectFn: () => Promise<any>) => Promise<any>
  missionDir: string
  gitPort: GitPort
  packageJson?: PackageJsonSpec
  spawnSuite?: SpawnSuite
}

interface RunGatesOptions {
  gates: GateSpec[]
  flags: string[]
  tree: string
  unit: string
  changedFiles?: string[]
  baseTree?: string
}

interface RunGatesResult {
  ok: boolean
  results: GateResult[]
  verdict?: string
  error?: string
}

/**
 * Filtra os gates de acordo com flags ativas e a condição `when`.
 * Mantém `when === 'always'` e mantém `when === 'by_flag'` só quando `flags.includes(gate.flag)`.
 * Qualquer outro valor de `when` lança TypeError.
 */
export function selectGates(gates: GateSpec[], flags: string[]): GateSpec[] {
  if (!Array.isArray(gates)) {
    throw new TypeError('gates precisa ser um array')
  }
  const activeFlags = Array.isArray(flags) ? flags : []

  
  const selected: GateSpec[] = []

  for (const gate of gates) {
    if (!gate || typeof gate !== 'object') {
      throw new TypeError('gate precisa ser um objeto')
    }
    if (gate.when === 'always') {
      selected.push(gate)
    } else if (gate.when === 'by_flag') {
      if (typeof gate.flag === 'string' && activeFlags.includes(gate.flag)) {
        selected.push(gate)
      }
    } else {
      throw new TypeError('when de gate inválido: ' + gate.when)
    }
  }

  return selected
}

/**
 * Cria o executor de portões (gates) com cache por árvore via step().
 */
export function createGateRunner({ step, missionDir, gitPort, packageJson = {}, spawnSuite = execSuite }: CreateGateRunnerOptions): { runGates: (options: RunGatesOptions) => Promise<RunGatesResult> } {
  if (typeof step !== 'function') {
    throw new TypeError('step precisa ser uma função')
  }
  if (!missionDir || typeof missionDir !== 'string') {
    throw new TypeError('missionDir precisa ser string')
  }
  if (
    !gitPort ||
    typeof gitPort !== 'object' ||
    typeof gitPort.worktreeDir !== 'string' ||
    typeof gitPort.worktreeTree !== 'function'
  ) {
    throw new TypeError('gitPort inválido')
  }

  /**
   * Gate vermelho julgado contra o commit-base da parte: tipos e lint travam só com diagnóstico novo; provas, só com
   * vermelha que estava verde na largada (estouro de tempo repete com limite folgado). Sem leitura possível, segue vermelho.
   */
  async function judgeAgainstBase({ gate, kind, argv, timeoutS, tree, baseTree, text, extract }: { gate: GateSpec; kind: string; argv: string[]; timeoutS: number; tree: string; baseTree: string; text: string; extract: BuildExtractResult }): Promise<Judged> {
    const cwd = gitPort.worktreeDir
    const label = 'gate-base-' + safeId(gate.id)
    const tool = DIAGNOSTIC_TOOL[kind]
    if (tool) {
      const after = parseDiagnostics(tool, text)
      if (!after.length) return { extract }
      await gitPort.restoreTree(baseTree, { label })
      const base = await runContained({ argv, cwd, timeoutS })
      await gitPort.restoreTree(tree, { label })
      const fresh = newDiagnostics(parseDiagnostics(tool, base.stdout + '\n' + base.stderr), after)
      const excerpt = fresh.map((d) => `${d.file}: ${d.code} ${d.message}`).join('\n')
      return fresh.length
        ? { extract: { ...extract, excerpt, bytes_model: Buffer.byteLength(excerpt, 'utf8') }, new_diagnostics: fresh }
        : { extract: { ...extract, status: 'success', summary: `${extract.summary} sem diagnóstico novo sobre ${after.length} da linha de base` }, new_diagnostics: [] }
    }
    if (kind !== 'test') return { extract }
    try {
      const suites = findSuites(cwd)
      if (!suites.length) return { extract }
      const timeoutMs = timeoutS * 1000
      await gitPort.restoreTree(baseTree, { label })
      const baseline = await runSuites(cwd, suites, { spawn: spawnSuite, timeoutMs })
      await gitPort.restoreTree(tree, { label })
      // a repetição folgada também ganha o limite por prova no total, senão o processo cai antes de aproveitá-lo
      // ponytail: soma um limite folgado só; várias lentas em série pedem limite por contagem
      const seen: TestResult[] = []
      const verdict = await judgeSuite(async (testTimeoutMs) => {
        const run = await runSuites(cwd, suites, { spawn: spawnSuite, timeoutMs: timeoutMs + (testTimeoutMs ?? 0), testTimeoutMs })
        seen.push(...run)
        return run
      }, baseline)
      const reds = verdict.reds.map((t) => t.id)
      const excerpt = reds.map((id) => `prova vermelha: ${id}`).join('\n')
      // a isenção cobre só a falha que o próprio gate atribui às provas comparadas: a saída dele cita (arquivo ou nome) uma
      // vermelha ou estouro da suíte prova a prova. Sem citação a causa é outra (configuração, script) e segue vermelho
      const cited = text.replace(/\\+/g, '/')
      const explained = seen.some((t) => (t.status === 'failed' || t.status === 'timeout') && (cited.includes(t.suite) || cited.includes(t.name)))
      if (verdict.ok && !explained) return { extract: { ...extract, summary: `${extract.summary} sem prova vermelha citada pelo gate que explique a falha` } }
      return verdict.ok
        ? { extract: { ...extract, status: 'success', summary: `${extract.summary} sem prova vermelha nova${verdict.retried ? ' (repetida com limite folgado)' : ''}` }, chargeable_reds: [] }
        : { extract: { ...extract, excerpt, bytes_model: Buffer.byteLength(excerpt, 'utf8') }, chargeable_reds: reds }
    } catch (err) {
      if (!(err instanceof TestRunnerError)) throw err
      return { extract: { ...extract, summary: `${extract.summary} sem julgamento prova a prova: ${err.message}` } }
    }
  }

  /**
   * Executa os gates selecionados sobre a árvore informada. Com `baseTree`, gate vermelho é julgado contra ela.
   */
  async function runGates({ gates, flags, tree, unit, changedFiles = [], baseTree }: RunGatesOptions): Promise<RunGatesResult> {
    if (!Array.isArray(gates)) {
      throw new TypeError('gates precisa ser um array')
    }
    if (!Array.isArray(flags)) {
      throw new TypeError('flags precisa ser um array')
    }
    if (typeof tree !== 'string' || !tree) {
      throw new TypeError('tree precisa ser string')
    }
    if (typeof unit !== 'string' || !unit) {
      throw new TypeError('unit precisa ser string')
    }

    const pending = await restorePendingGate({ missionDir, gitPort })
    if (pending.blocked) {
      return { ok: false, results: [], error: 'gate_restore_marker_invalid' }
    }

    const currentTree = await gitPort.worktreeTree()
    if (currentTree !== tree) {
      return { ok: false, results: [], error: 'gate_tree_mismatch', verdict: 'refused' }
    }

    const selected = selectGates(gates, flags)

    
    const results: GateResult[] = []

    for (const gate of selected) {
      const argv = resolveGateArgv({
        gate,
        packageJson,
        vars: {
          worktree: gitPort.worktreeDir,
          tree,
          changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
        },
      })

      const expect_exit = gate.expect_exit ?? 0
      const timeout_s = gate.timeout_s ?? 300
      const kind = gate.kind ?? 'test'

      const safeGateId = safeId(gate.id)
      const artRef = `gates/${safeGateId}/${tree}`
      const rawRef = `art:${artRef}`

      
      const stepOutput: { step_id: string; status: string; result: any; reused: boolean } = await step(
        {
          unit,
          id: `gate:${gate.id}:${tree}`,
          effect_class: 'gate',
          input: {
            argv,
            kind,
            expect_exit,
            timeout_s,
            tree,
            ...(baseTree ? { base_tree: baseTree } : {}),
          },
          worktree: gitPort.worktreeDir,
        },
        async () => {
          const treeBefore = tree
          writeMarkerSync(missionDir, {
            gate_id: gate.id,
            tree_before: treeBefore,
            worktree: gitPort.worktreeDir,
          })

          try {
            const contained = await runContained({
              argv,
              cwd: gitPort.worktreeDir,
              timeoutS: timeout_s,
            })

            const text = contained.stdout + '\n' + contained.stderr

            const rawArtifact = writeRawArtifact({
              missionDir,
              ref: artRef,
              text,
            })

            const extract = buildExtract({
              kind,
              exitCode: contained.exitCode,
              expectExit: expect_exit,
              stdout: contained.stdout,
              stderr: contained.stderr,
              rawRef,
              bytesRaw: rawArtifact.bytes,
            })

            const judged: Judged =
              extract.status === 'error' && baseTree && baseTree !== tree
                ? await judgeAgainstBase({ gate, kind, argv, timeoutS: timeout_s, tree, baseTree, text, extract })
                : { extract }

            return {
              exit_code: contained.exitCode,
              raw_ref: rawRef,
              ...judged,
            }
          } finally {
            await gitPort.restoreTree(treeBefore, { label: 'gate-' + safeId(gate.id) })
            clearMarkerSync(missionDir)
          }
        }
      )

      
      const res: Judged & { exit_code: number | null; raw_ref: string } = stepOutput.result

      
      const gateResult: GateResult = {
        gate_id: gate.id,
        status: res.extract.status,
        exit_code: res.exit_code,
        argv,
        extract: res.extract,
        raw_ref: res.raw_ref,
        reused: Boolean(stepOutput.reused),
        ...(res.new_diagnostics ? { new_diagnostics: res.new_diagnostics } : {}),
        ...(res.chargeable_reds ? { chargeable_reds: res.chargeable_reds } : {}),
      }

      results.push(gateResult)

      if (gateResult.status === 'error') {
        return { ok: false, results }
      }
    }

    return { ok: true, results }
  }

  return { runGates }
}
