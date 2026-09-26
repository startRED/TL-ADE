// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdeError } from '../../journal/errors.ts'
import { buildCodexArgs } from './argv.ts'
import { codexEnvExtras } from './home.ts'
import { parseCodexOutput, parseCodexStreamUsage, parseCodexTokens, parseReviewResult } from './parse.ts'
import { dropNulls, fitToSchema, strictSchemaFile } from './strict-schema.ts'
import { runWorker } from '../../runner/spawn.ts'
import { safeId } from '../../gates/output.ts'
import { assertPaidAuthorization } from '../../engine/paid-call.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DEFAULT_REVIEW_SCHEMA = path.join(ROOT, 'schemas/review-result.schema.json')
const UNIT_RESULT_SCHEMA = path.join(ROOT, 'schemas/unit-result.schema.json')

/** O parecer vem em structured_output ou é o próprio envelope: ajusta ao schema original onde ele estiver. */
function fitEnvelope(envelope: any, schema: any): any {
  if (!envelope || typeof envelope !== 'object') return envelope
  return envelope.structured_output ? { ...envelope, structured_output: fitToSchema(envelope.structured_output, schema) } : fitToSchema(envelope, schema)
}

/**
 * Despacha execução do modelo para o Codex via `step()` write-ahead.
 */
export async function dispatchCodex(opts: {
    step: Function
    unit: string
    stepId: string
    packPath: string
    missionDir: string
    missionId: string
    cwd: string
    resultFile: string
    maxBudgetUsd?: number
    model?: string
    resolved: { exe: string; prefixArgs: string[] }
    timeoutS?: number
    env?: Record<string, string>
    runWorkerImpl?: typeof runWorker
    authorization?: any
    role?: string
    effort?: string
    sandbox?: string
    schemaPath?: string
  }): Promise<{
  step_id: string
  status: 'ok' | 'ambiguous'
  session_ref: string | null
  exit_code: number | null
  review_result: any | null
  unit_result: any | null
  valid: boolean
  cited: boolean
  tokens: any
  envelope_error: null | 'empty' | 'not_json' | 'truncated_json'
  subtype: null
  num_turns: null
  is_error: boolean
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
    maxBudgetUsd = 0.25,
    model = 'gpt-5.6-terra',
    resolved,
    timeoutS = 1800,
    env = {},
    runWorkerImpl = runWorker,
    authorization,
    role = 'checker_round',
    effort,
    sandbox,
    schemaPath = role === 'maker' ? UNIT_RESULT_SCHEMA : DEFAULT_REVIEW_SCHEMA,
  } = opts ?? {}

  // Revisão (review-result) ou quem escreve a parte (`maker`, sandbox de escrita e unit-result); outro papel é erro.
  const isMaker = role === 'maker'
  if (typeof role !== 'string' || !(isMaker || role.startsWith('checker'))) {
    throw new AdeError('codex_role_unsupported', `papel sem suporte no adapter codex: ${role}`, 4)
  }

  if (authorization) {
    assertPaidAuthorization(authorization, maxBudgetUsd)
  }

  // `codex exec -` lê o prompt pela entrada padrão. Sem o conteúdo do pack o processo recebe EOF
  // e não há revisão possível, então a falta do pack é erro na fronteira, não silêncio.
  if (typeof packPath !== 'string' || packPath === '') {
    throw new AdeError('codex_pack_missing', 'despacho do Codex sem pack para a entrada padrão', 4)
  }
  
  let stdinData: string
  try {
    stdinData = fs.readFileSync(packPath, 'utf8')
  } catch (err) {
    throw new AdeError(
      'codex_pack_unreadable',
      `pack ilegível em ${packPath}: ${err instanceof Error ? err.message : String(err)}`,
      4,
    )
  }

  const args = buildCodexArgs({
    role,
    cwd,
    // cópia estrita do schema: o modo estrito da OpenAI recusa o original com 400 antes de o modelo rodar
    schemaPath: strictSchemaFile(schemaPath, path.dirname(resultFile)),
    resultFile,
    model,
    effort,
    sandbox,
  })

  const input = {
    pack_path: packPath,
    max_budget_usd: maxBudgetUsd,
    model: model ?? null,
    role,
  }

  const r = await step({ unit, id: stepId, effect_class: 'model_call', input, session_ref: null }, async () => {
    
    const workerEnv: Record<string, string> = {
      ...env,
      // pasta do Codex só com o login: sem ela o revisor recebia o ~/.codex/AGENTS.md do operador (ADR 0045)
      ...codexEnvExtras(),
      ADE_FAKE_ROLE: isMaker ? 'maker' : 'checker',
      ADE_FAKE_RESULT_FILE: resultFile,
    }

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
      env: workerEnv,
      stdinData,
    })

    const parsed = parseCodexOutput(result.stdout, resultFile)
    const envelope = fitEnvelope(dropNulls(parsed.envelope), JSON.parse(fs.readFileSync(schemaPath, 'utf8')))
    const error = parsed.error
    const pr = parseReviewResult(envelope)
    const tokens = parseCodexStreamUsage(result.stdout) ?? parseCodexTokens(envelope)
    const failed = result.exitCode !== 0

    return {
      session_ref: null,
      exit_code: result.exitCode,
      review_result: isMaker ? null : pr.review_result,
      unit_result: isMaker ? envelope?.structured_output ?? envelope : null,
      // a escada lê o erro para classificar cota e bloqueio de ambiente
      is_error: failed,
      result_text: failed ? String(result.stderr || result.stdout) : '',
      valid: pr.valid,
      cited: pr.cited,
      tokens,
      envelope_error: error,
    }
  })

  // chamada reconciliada como cobrada volta do journal `ambiguous` e sem resultado
  const effectResult = (r.result ?? {})

  return {
    step_id: r.step_id,
    status: r.status,
    session_ref: effectResult?.session_ref ?? null,
    exit_code: effectResult?.exit_code ?? null,
    review_result: effectResult?.review_result ?? null,
    unit_result: effectResult?.unit_result ?? null,
    valid: effectResult?.valid ?? false,
    cited: effectResult?.cited ?? false,
    tokens: effectResult?.tokens ?? { source: 'unavailable' },
    envelope_error: effectResult?.envelope_error ?? null,
    subtype: null,
    num_turns: null,
    is_error: effectResult?.is_error === true,
    result_text: effectResult?.result_text ?? '',
  }
}
