import crypto from 'node:crypto'
import { buildClaudeArgs } from './argv.ts'
import { parseClaudeOutput, parseTokens, parseUnitResult, parseUsage } from './parse.ts'
import { runWorker } from '../../runner/spawn.ts'
import { safeId } from '../../gates/output.ts'
import { assertPaidAuthorization } from '../../engine/paid-call.ts'

/**
 * Cunha o session id antes do spawn, monta os args do `claude` e despacha o efeito `model_call`
 * através do `step()` write-ahead, para que o journal já tenha o `session_ref` no instante do spawn.
 */
export async function dispatchClaude(opts: {
    step: Function
    unit: string
    stepId: string
    packPath: string
    missionDir: string
    missionId: string
    cwd: string
    resultFile: string
    maxBudgetUsd: number
    model?: string
    maxTurns?: number
    resolved: { exe: string; prefixArgs: string[] }
    timeoutS?: number
    env?: Record<string, string>
    runWorkerImpl?: typeof runWorker
    randomUUID?: () => string
    authorization?: any
    mcpConfigPath?: string
  }): Promise<{
  step_id: string
  status: 'ok' | 'ambiguous'
  session_ref: string
  exit_code: number | null
  unit_result: object | null
  valid: boolean
  cited: boolean
  usage: ReturnType<typeof parseUsage>
  envelope_error: null | 'empty' | 'not_json' | 'truncated_json'
  tokens: ReturnType<typeof parseTokens>
  subtype: string | null
  num_turns: number | null
  result_text: string
}> {
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
    maxTurns,
    resolved,
    timeoutS = 1800,
    env = {},
    runWorkerImpl = runWorker,
    randomUUID = crypto.randomUUID,
    authorization,
    mcpConfigPath,
  } = opts ?? {}

  if (authorization) {
    assertPaidAuthorization(authorization, maxBudgetUsd)
  }

  const sessionId = randomUUID()
  const args = buildClaudeArgs({ sessionId, packPath, maxBudgetUsd, model, mcpConfigPath, maxTurns })
  const input = { pack_path: packPath, max_budget_usd: maxBudgetUsd, model: model ?? null, ...(maxTurns === undefined ? {} : { max_turns: maxTurns }) }

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
      // a escada de correção lê o corte no teto e o texto final (bloqueio de ambiente)
      subtype: typeof envelope?.subtype === 'string' ? envelope.subtype : null,
      num_turns: typeof envelope?.num_turns === 'number' ? envelope.num_turns : null,
      result_text: typeof envelope?.result === 'string' ? envelope.result : '',
    }
  })

  const effectResult = (r.result)

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
    subtype: effectResult.subtype ?? null,
    num_turns: effectResult.num_turns ?? null,
    result_text: effectResult.result_text ?? '',
  }
}
