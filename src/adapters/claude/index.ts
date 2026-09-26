import crypto from 'node:crypto'
import { buildClaudeArgs } from './argv.ts'
import { claudeEnvExtras, writeIsolationSettings } from './isolation.ts'
import { parseClaudeOutput, parseTokens, parseUnitResult, parseUsage } from './parse.ts'
import { parseReviewResult } from '../codex/parse.ts'
import { runWorker } from '../../runner/spawn.ts'
import { safeId } from '../../gates/output.ts'
import { assertPaidAuthorization } from '../../engine/paid-call.ts'

/**
 * Cunha o session id antes do spawn, monta os args do `claude` e despacha o efeito `model_call`
 * através do `step()` write-ahead, para que o journal já tenha o `session_ref` no instante do spawn.
 * Com `role: 'checker_*'` o Claude revisa: só leitura e resposta pelo review-result.
 * Com `resumeSessionId` retoma aquela sessão e manda `prompt` pela entrada padrão (ADR 0046).
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
    effort?: string
    maxTurns?: number
    role?: string
    resolved: { exe: string; prefixArgs: string[] }
    timeoutS?: number
    env?: Record<string, string>
    runWorkerImpl?: typeof runWorker
    randomUUID?: () => string
    authorization?: any
    mcpConfigPath?: string
    resumeSessionId?: string
    prompt?: string
    scratch?: boolean
  }): Promise<{
  step_id: string
  status: 'ok' | 'ambiguous'
  session_ref: string
  exit_code: number | null
  unit_result: object | null
  review_result: any | null
  valid: boolean
  cited: boolean
  usage: ReturnType<typeof parseUsage>
  envelope_error: null | 'empty' | 'not_json' | 'truncated_json'
  tokens: ReturnType<typeof parseTokens>
  subtype: string | null
  num_turns: number | null
  result_text: string
  is_error: boolean
  session_missing: boolean
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
    effort,
    maxTurns,
    role = 'maker',
    resolved,
    timeoutS = 1800,
    env = {},
    runWorkerImpl = runWorker,
    randomUUID = crypto.randomUUID,
    authorization,
    mcpConfigPath,
    resumeSessionId,
    prompt,
    scratch,
  } = opts ?? {}

  if (authorization) {
    assertPaidAuthorization(authorization, maxBudgetUsd)
  }

  const sessionId = resumeSessionId ?? randomUUID()
  const args = buildClaudeArgs({ sessionId, packPath, settingsPath: writeIsolationSettings(cwd), maxBudgetUsd, model, effort, mcpConfigPath, maxTurns, role, resume: resumeSessionId !== undefined, scratch })
  const input = { pack_path: packPath, max_budget_usd: maxBudgetUsd, model: model ?? null, ...(effort === undefined ? {} : { effort }), ...(maxTurns === undefined ? {} : { max_turns: maxTurns }), ...(resumeSessionId === undefined ? {} : { resume_of: resumeSessionId }) }

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
      env: { ...env, ...claudeEnvExtras() },
      ...(resumeSessionId === undefined ? {} : { stdinData: prompt ?? '' }),
    })

    const { envelope, error } = parseClaudeOutput(result.stdout)
    // a revisão só vale vinda de structured_output: o envelope do Claude não é uma revisão
    const pu = role === 'maker'
      ? { ...parseUnitResult(envelope), review_result: null }
      : { ...parseReviewResult(envelope?.structured_output ? envelope : null), unit_result: null }
    const usage = parseUsage(envelope, role)
    const tokens = parseTokens(envelope)

    return {
      session_ref: sessionId,
      exit_code: result.exitCode,
      unit_result: pu.unit_result,
      review_result: pu.review_result,
      valid: pu.valid,
      cited: pu.cited,
      usage,
      envelope_error: error,
      tokens,
      // a escada de correção lê o corte no teto e o texto final (bloqueio de ambiente)
      subtype: typeof envelope?.subtype === 'string' ? envelope.subtype : null,
      num_turns: typeof envelope?.num_turns === 'number' ? envelope.num_turns : null,
      result_text: typeof envelope?.result === 'string' ? envelope.result : '',
      // a cota é lida só da mensagem de erro, nunca do texto de uma resposta bem-sucedida
      is_error: envelope?.is_error === true,
      // sessão de outra máquina ou apagada: a CLI sai 1 sem envelope e o motor cai para sessão nova
      session_missing: resumeSessionId !== undefined && /No conversation found/i.test(String(result.stderr ?? '')),
    }
  })

  // chamada reconciliada como cobrada volta do journal `ambiguous` e sem resultado
  const effectResult = (r.result ?? {})

  return {
    step_id: r.step_id,
    status: r.status,
    session_ref: effectResult.session_ref,
    exit_code: effectResult.exit_code,
    unit_result: effectResult.unit_result,
    review_result: effectResult.review_result ?? null,
    valid: effectResult.valid,
    cited: effectResult.cited,
    usage: effectResult.usage,
    envelope_error: effectResult.envelope_error,
    tokens: effectResult.tokens ?? { source: 'unavailable' },
    subtype: effectResult.subtype ?? null,
    num_turns: effectResult.num_turns ?? null,
    result_text: effectResult.result_text ?? '',
    is_error: effectResult.is_error === true,
    session_missing: effectResult.session_missing === true,
  }
}
