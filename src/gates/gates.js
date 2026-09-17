import { resolveGateArgv, runContained } from './command.js'
import { buildExtract, safeId, writeRawArtifact } from './output.js'

/**
 * @typedef {Object} GateSpec
 * @property {string} id
 * @property {string} [kind]
 * @property {'always'|'by_flag'} [when]
 * @property {string} [flag]
 * @property {string[]} [argv]
 * @property {string} [script]
 * @property {number} [expect_exit]
 * @property {number} [timeout_s]
 * @property {boolean} [idempotent]
 */

/**
 * @typedef {Object} PackageJsonSpec
 * @property {Record<string, string>} [scripts]
 */

/**
 * @typedef {Object} GitPort
 * @property {string} worktreeDir
 * @property {() => Promise<string>} worktreeTree
 */

/**
 * @typedef {Object} GateResult
 * @property {string} gate_id
 * @property {import('./output.js').ExtractStatus} status
 * @property {number|null} exit_code
 * @property {string[]} argv
 * @property {import('./output.js').BuildExtractResult} extract
 * @property {string} raw_ref
 * @property {boolean} reused
 */

/**
 * @typedef {Object} CreateGateRunnerOptions
 * @property {(spec: any, effectFn: () => Promise<any>) => Promise<any>} step
 * @property {string} missionDir
 * @property {GitPort} gitPort
 * @property {PackageJsonSpec} [packageJson]
 */

/**
 * @typedef {Object} RunGatesOptions
 * @property {GateSpec[]} gates
 * @property {string[]} flags
 * @property {string} tree
 * @property {string} unit
 * @property {string[]} [changedFiles]
 */

/**
 * @typedef {Object} RunGatesResult
 * @property {boolean} ok
 * @property {GateResult[]} results
 * @property {string} [verdict]
 */

/**
 * Filtra os gates de acordo com flags ativas e a condição `when`.
 * Mantém `when === 'always'` e mantém `when === 'by_flag'` só quando `flags.includes(gate.flag)`.
 * Qualquer outro valor de `when` lança TypeError.
 *
 * @param {GateSpec[]} gates
 * @param {string[]} flags
 * @returns {GateSpec[]}
 */
export function selectGates(gates, flags) {
  if (!Array.isArray(gates)) {
    throw new TypeError('gates precisa ser um array')
  }
  const activeFlags = Array.isArray(flags) ? flags : []

  /** @type {GateSpec[]} */
  const selected = []

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
 *
 * @param {CreateGateRunnerOptions} options
 * @returns {{ runGates: (options: RunGatesOptions) => Promise<RunGatesResult> }}
 */
export function createGateRunner({ step, missionDir, gitPort, packageJson = {} }) {
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
   *
   * @param {RunGatesOptions} options
   * @returns {Promise<RunGatesResult>}
   */
  async function runGates({ gates, flags, tree, unit, changedFiles = [] }) {
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

    const currentTree = await gitPort.worktreeTree()
    if (currentTree !== tree) {
      return { ok: false, results: [], verdict: 'refused' }
    }

    const selected = selectGates(gates, flags)

    /** @type {GateResult[]} */
    const results = []

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

      /** @type {{ step_id: string, status: string, result: any, reused: boolean }} */
      const stepOutput = await step(
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
        }
      )

      /** @type {{ exit_code: number|null, extract: import('./output.js').BuildExtractResult, raw_ref: string }} */
      const res = stepOutput.result

      /** @type {GateResult} */
      const gateResult = {
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
