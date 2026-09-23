import fs from 'node:fs'
import path from 'node:path'
import { resolveGateArgv, runContained } from './command.ts'
import { buildExtract, safeId, writeRawArtifact } from './output.ts'
import type { GateSpec, PackageJsonSpec } from './types.ts'

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
}

interface RunGatesOptions {
  gates: GateSpec[]
  flags: string[]
  tree: string
  unit: string
  changedFiles?: string[]
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
export function createGateRunner({ step, missionDir, gitPort, packageJson = {} }: CreateGateRunnerOptions): { runGates: (options: RunGatesOptions) => Promise<RunGatesResult> } {
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
   * Executa os gates selecionados sobre a árvore informada.
   */
  async function runGates({ gates, flags, tree, unit, changedFiles = [] }: RunGatesOptions): Promise<RunGatesResult> {
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

            return {
              exit_code: contained.exitCode,
              extract,
              raw_ref: rawRef,
            }
          } finally {
            await gitPort.restoreTree(treeBefore, { label: 'gate-' + safeId(gate.id) })
            clearMarkerSync(missionDir)
          }
        }
      )

      
      const res: { exit_code: number | null; extract: import('./output.ts').BuildExtractResult; raw_ref: string } = stepOutput.result

      
      const gateResult: GateResult = {
        gate_id: gate.id,
        status: res.extract.status,
        exit_code: res.exit_code,
        argv,
        extract: res.extract,
        raw_ref: res.raw_ref,
        reused: Boolean(stepOutput.reused),
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
