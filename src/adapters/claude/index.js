import crypto from 'node:crypto'
import { buildClaudeArgs } from './argv.js'
import { parseClaudeOutput, parseTokens, parseUnitResult, parseUsage } from './parse.js'
import { runWorker } from '../../runner/spawn.js'
import { safeId } from '../../gates/output.js'
import { assertPaidAuthorization } from '../../engine/paid-call.js'

/**
 * Cunha o session id antes do spawn, monta os args do `claude` e despacha o efeito `model_call`
 * através do `step()` write-ahead, para que o journal já tenha o `session_ref` no instante do spawn.
 *
 * @param {{
 *   step: Function,
 *   unit: string,
 *   stepId: string,
 *   packPath: string,
 *   missionDir: string,
 *   missionId: string,
 *   cwd: string,
 *   resultFile: string,
 *   maxBudgetUsd: number,
 *   model?: string,
 *   resolved: { exe: string, prefixArgs: string[] },
 *   timeoutS?: number,
 *   env?: Record<string, string>,
 *   runWorkerImpl?: typeof runWorker,
 *   randomUUID?: () => string,
 *   authorization?: any,
 * }} opts
 * @returns {Promise<{
 *   step_id: string,
 *   status: 'ok' | 'ambiguous',
 *   session_ref: string,
 *   exit_code: number | null,
 *   unit_result: object | null,
 *   valid: boolean,
 *   cited: boolean,
 *   usage: ReturnType<typeof parseUsage>,
 *   envelope_error: null | 'empty' | 'not_json' | 'truncated_json',
 *   tokens: ReturnType<typeof parseTokens>,
 * }>}
 */
export async function dispatchClaude(opts) {
  const {
    step,
    unit,
    stepId,
    packPath,
    missionDir,
    missionId,
    cwd,
    resultFile,
    maxBudgetUsd,
    model,
    resolved,
    timeoutS = 1800,
    env = {},
    runWorkerImpl = runWorker,
    randomUUID = crypto.randomUUID,
    authorization,
  } = opts ?? {}

  if (authorization) {
    assertPaidAuthorization(authorization, maxBudgetUsd)
  }

  const sessionId = randomUUID()
  const args = buildClaudeArgs({ sessionId, packPath, maxBudgetUsd, model })
  const input = { pack_path: packPath, max_budget_usd: maxBudgetUsd, model: model ?? null }

  const r = await step({ unit, id: stepId, effect_class: 'model_call', input, session_ref: sessionId }, async () => {
    const result = await runWorkerImpl({
      resolved,
      args,
      cwd,
      missionDir,
      missionId,
      stepId: safeId(stepId),
      request: {
        unit,
        authorization: 'unattended',
        cwd,
        argv: [resolved.exe, ...resolved.prefixArgs, ...args],
        timeout: timeoutS,
        result_file: resultFile,
      },
      timeoutS,
      env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    })

    const { envelope, error } = parseClaudeOutput(result.stdout)
    const pu = parseUnitResult(envelope)
    const usage = parseUsage(envelope, 'maker')
    const tokens = parseTokens(envelope)

    return {
      session_ref: sessionId,
      exit_code: result.exitCode,
      unit_result: pu.unit_result,
      valid: pu.valid,
      cited: pu.cited,
      usage,
      envelope_error: error,
      tokens,
    }
  })

  const effectResult = /** @type {{
   *   session_ref: string,
   *   exit_code: number | null,
   *   unit_result: object | null,
   *   valid: boolean,
   *   cited: boolean,
   *   usage: ReturnType<typeof parseUsage>,
   *   envelope_error: null | 'empty' | 'not_json' | 'truncated_json',
   *   tokens?: ReturnType<typeof parseTokens>,
   * }} */ (r.result)

  return {
    step_id: r.step_id,
    status: r.status,
    session_ref: effectResult.session_ref,
    exit_code: effectResult.exit_code,
    unit_result: effectResult.unit_result,
    valid: effectResult.valid,
    cited: effectResult.cited,
    usage: effectResult.usage,
    envelope_error: effectResult.envelope_error,
    tokens: effectResult.tokens ?? { source: 'unavailable' },
  }
}
