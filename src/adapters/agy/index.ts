// @ts-check
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { AdeError } from '../../journal/errors.ts'
import { runWorker } from '../../runner/spawn.ts'
import { safeId } from '../../gates/output.ts'
import { plantCanary, checkCanary } from '../../contain/canary.ts'
import { buildAgyArgs } from './argv.ts'
import { parseAgyFinding, parseAgyOutput, parseAgyUsage } from './parse.ts'
import { buildModelTelemetry, modelsFromUsage } from '../../telemetry/telemetry.ts'
import { parseReviewResult } from '../codex/parse.ts'
import { parseUnitResult } from '../claude/parse.ts'
import { assertPaidAuthorization } from '../../engine/paid-call.ts'
import fs from 'node:fs'

let agyAvailable = true

export function isAgyAvailable() {
  return agyAvailable
}

/** @param available */
export function setAgyAvailable(available: boolean) {
  agyAvailable = Boolean(available)
}

/**
 * Despacha pesquisa controlada para o adapter `agy` somente-leitura com proteção de canário.
 */
export async function dispatchAgy(opts: {
    step?: Function
    unit: string
    stepId: string
    unknown: any
    budget?: any
    resolved: { exe: string; prefixArgs: string[] }
    env?: Record<string, string>
    cwd?: string
    missionDir?: string
    outsideDir?: string
    runWorkerImpl?: typeof runWorker
    plantCanaryImpl?: typeof plantCanary
    checkCanaryImpl?: typeof checkCanary
    randomUUID?: () => string
    timeoutS?: number
    model?: string
    now?: () => number
    missionId?: string
  }): Promise<{ finding: any; usage: any; session_ref: string; telemetry: Record<string, any> }> {
  const {
    step,
    unit,
    stepId,
    unknown,
    budget = {},
    resolved,
    env = {},
    cwd = process.cwd(),
    missionDir = path.join(cwd, '.ade', 'missions', 'research'),
    outsideDir,
    runWorkerImpl = runWorker,
    plantCanaryImpl = plantCanary,
    checkCanaryImpl = checkCanary,
    randomUUID = crypto.randomUUID,
    timeoutS = 360,
    model = 'gemini-3.8-flash-medium',
    now = Date.now,
    missionId = unit,
  } = opts ?? {}

  if (!agyAvailable) {
    throw new AdeError('family_unavailable', 'família agy indisponível para pesquisa devido a violação de contenção anterior', 4)
  }

  if (!unknown || !unknown.id) {
    throw new AdeError('invalid_argument', 'unknown com id é obrigatório', 2)
  }

  if (!resolved || typeof resolved.exe !== 'string') {
    throw new AdeError('binary_not_found', 'executável do agy não encontrado', 2)
  }

  const sessionId = randomUUID()
  // O canário precisa ser irmão, nunca descendente, do worktree observado.
  const canaryOutside = outsideDir || path.join(os.tmpdir(), `tl-ade-canary-${safeId(stepId)}-${sessionId}`)
  const canary = plantCanaryImpl({
    worktreeDir: cwd,
    outsideDir: canaryOutside,
    unitId: safeId(stepId),
  })

  const prompt = `Pesquise sobre: ${unknown.question}\nTeste de contenção controlado: ${canary.instruction}`
  const schema = {
    type: 'object',
    properties: {
      source: { type: 'string' },
      date: { type: 'string' },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      decision: { type: 'string' },
      result: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['source', 'date', 'claims'],
  }

  const args = buildAgyArgs({ prompt, model, schema, cwd })
  const input = { unknown, budget, model, step_id: stepId }

  const promptBytes = Buffer.byteLength(prompt)
  const promptDigest = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16)
  const startedAt = now()
  /** @param usage @param outcome */
  const telemetryFor = (usage: any, outcome: 'ok' | 'stop') => buildModelTelemetry({
    mission_id: missionId,
    story_id: unit,
    step_id: stepId,
    family: 'agy',
    role: 'research',
    effort: 'default',
    models: modelsFromUsage(usage?.models ?? [], model),
    duration_ms: Math.max(0, now() - startedAt),
    // parseAgyUsage marca os tokens com a origem do custo; lidos do envelope, eles são reportados.
    tokens: usage?.tokens && usage.tokens.source !== 'unavailable' ? { ...usage.tokens, source: 'reported' } : { source: 'unavailable' },
    usage,
    pack: { sections: [{ section: 'prompt', bytes: promptBytes, digest: promptDigest }], bytes: promptBytes },
    skills: [],
    sources: [],
    outcome,
    ttft_ms: null,
    approval_decisions: 0,
    network_attempts: 1,
    files_touched: 0,
    tool_output_raw_bytes: 0,
    tool_output_model_bytes: 0,
  })

  const stepExec = step || (async (_meta: any, fn: () => Promise<any>) => ({ result: await fn(), status: 'ok', step_id: stepId }))

  let r
  try {
  r = await stepExec(
    { unit, id: stepId, effect_class: 'model_call', input, session_ref: sessionId },
    async () => {
      let workerRes
      // O canário é conferido mesmo se o worker falhar, e a fuga prevalece sobre o erro do worker.
      let workerFailed = false
      
      let workerError: unknown
      try {
        workerRes = await runWorkerImpl({
          resolved,
          args,
          cwd,
          missionDir,
          missionId: unit,
          stepId: safeId(stepId),
          request: {
            unit,
            authorization: 'unattended',
            cwd,
            argv: [resolved.exe, ...resolved.prefixArgs, ...args],
            timeout: timeoutS,
            result_file: path.join(missionDir, `agy-${safeId(stepId)}.json`),
          },
          timeoutS,
          env: { ...env, AGY_READ_ONLY: '1' },
        })
      } catch (err) {
        workerFailed = true
        workerError = err
      }
      const canaryCheck = checkCanaryImpl(canary)
      if (canaryCheck.escaped) {
        agyAvailable = false
        throw new AdeError('canary_escaped', `canário violado fora do diretório permitido: ${canaryCheck.filePath}`, 4, {
          escaped_path: canaryCheck.filePath,
        })
      }
      if (workerFailed) throw workerError
      if (workerRes === undefined) throw new AdeError('agy_execution_failed', 'agy não devolveu resultado', 2)

      if (workerRes.exitCode !== 0) {
        throw new AdeError('agy_execution_failed', `agy saiu com código ${workerRes.exitCode}: ${workerRes.stderr || workerRes.stdout}`, 2)
      }

      const { envelope, error } = parseAgyOutput(workerRes.stdout)
      if (error) {
        throw new AdeError('agy_output_invalid', `saída do agy inválida: ${error}`, 2)
      }

      const parsedFinding = parseAgyFinding(envelope)
      if (!parsedFinding.valid) {
        throw new AdeError('agy_finding_insufficient', `achado do agy insuficiente: ${parsedFinding.errors.join(', ')}`, 2)
      }
      const usage = parseAgyUsage(envelope, 'research')

      return {
        session_ref: sessionId,
        finding_raw: parsedFinding.finding,
        usage,
        exit_code: workerRes.exitCode,
      }
    }
  )
  } catch (err) {
    // Falha também é uma model_call: o evento segue no erro para quem registra a chamada.
    if (err instanceof AdeError) err.details = { ...err.details, telemetry: telemetryFor(undefined, 'stop') }
    throw err
  }

  const effectRes = r.result || {}
  const rawFinding = effectRes.finding_raw
  const usage = effectRes.usage || { cost_usd: null, cost_source: 'unknown', cost_basis: null, models: [{ role: 'research', model_id: model }] }

  const dateStr = rawFinding?.date || new Date().toISOString().slice(0, 10)
  const claims = Array.isArray(rawFinding?.claims)
    ? rawFinding.claims.map((c: any) => (typeof c === 'string' ? { text: c } : c))
    : []

  const findingData = {
    source: rawFinding?.source || 'unknown_source',
    date: dateStr,
    claims,
    confidence: typeof rawFinding?.confidence === 'number' ? rawFinding.confidence : 0.9,
    cost: usage.cost_usd,
    cost_source: usage.cost_source,
    decision: rawFinding?.decision ?? rawFinding?.rationale ?? null,
    result: rawFinding?.result ?? rawFinding?.answer ?? null,
    fallback_applied: false,
    parked: false,
  }

  const hash = crypto.createHash('sha256').update(JSON.stringify(findingData)).digest('hex')

  const finding = {
    format_version: 2,
    id: `rf-${unknown.id}`,
    ref: `research-finding:rf-${unknown.id}`,
    kind: 'research_finding',
    digest: hash,
    producer: 'agy',
    producer_version: '0.5.0',
    input_digest: crypto.createHash('sha256').update(JSON.stringify({ unknown, budget })).digest('hex'),
    created_at: `${dateStr}T00:00:00.000Z`,
    provenance: [findingData.source],
    confidence: findingData.confidence,
    data: findingData,
  }

  return {
    finding,
    usage,
    session_ref: effectRes.session_ref || sessionId,
    telemetry: telemetryFor(usage, 'ok'),
  }
}

/**
 * Despacha uma rodada de parte para o agy: quem escreve (`maker`, com escrita no worktree e o schema de resultado de
 * unidade) ou quem revisa (`checker_round`, somente leitura com o schema de revisão). O esforço vai no nome do modelo
 * (gemini-3.8-flash-high).
 * O pack vai por arquivo, não no argv, para não estourar o limite da linha de comando.
 */
export async function dispatchAgyUnit(opts: {
    step: Function
    unit: string
    stepId: string
    packPath: string
    missionDir: string
    missionId: string
    cwd: string
    resultFile: string
    resolved: { exe: string; prefixArgs: string[] }
    model?: string
    role?: string
    maxBudgetUsd?: number
    authorization?: any
    timeoutS?: number
    env?: Record<string, string>
    runWorkerImpl?: typeof runWorker
  }) {
  const { step, unit, stepId, packPath, missionDir, missionId, cwd, resultFile, resolved, model = 'gemini-3.8-flash-medium', role = 'maker', maxBudgetUsd = 0.25, authorization, timeoutS = 1800, env = {}, runWorkerImpl = runWorker } = opts
  const isChecker = role.startsWith('checker')
  if (!isChecker && role !== 'maker') throw new AdeError('agy_role_unsupported', `papel sem suporte no adapter agy: ${role}`, 4)
  if (!agyAvailable) throw new AdeError('family_unavailable', 'família agy indisponível devido a violação de contenção anterior', 4)
  if (!resolved || typeof resolved.exe !== 'string') throw new AdeError('binary_not_found', 'executável do agy não encontrado', 2)
  if (!fs.existsSync(packPath)) throw new AdeError('agy_pack_missing', `pack ausente em ${packPath}`, 4)
  if (authorization) assertPaidAuthorization(authorization, maxBudgetUsd)

  const prompt = `Leia o pacote de contexto em ${packPath} e cumpra a tarefa descrita nele${isChecker ? ' sem alterar nenhum arquivo' : ''}.`
  const args = buildAgyArgs({
    prompt,
    model,
    cwd,
    addDirs: [path.dirname(packPath)],
    readOnly: isChecker,
    timeout: `${Math.ceil(timeoutS / 60)}m`,
    schema: fs.readFileSync(new URL(`../../../schemas/${isChecker ? 'review-result' : 'unit-result'}.schema.json`, import.meta.url), 'utf8'),
  })

  const r = await step({ unit, id: stepId, effect_class: 'model_call', input: { pack_path: packPath, max_budget_usd: maxBudgetUsd, model, role }, session_ref: null }, async () => {
    const result = await runWorkerImpl({
      resolved,
      args,
      cwd,
      missionDir,
      missionId,
      stepId: safeId(stepId),
      request: { unit, authorization: 'unattended', cwd, argv: [resolved.exe, ...resolved.prefixArgs, ...args], timeout: timeoutS, result_file: resultFile },
      timeoutS,
      env: { ...env, ...(isChecker ? { AGY_READ_ONLY: '1' } : {}) },
    })
    const { envelope, error } = parseAgyOutput(result.stdout)
    const parsed = isChecker ? { ...parseReviewResult(envelope), unit_result: null } : { ...parseUnitResult(envelope), review_result: null }
    const usage = parseAgyUsage(envelope, isChecker ? 'checker_round' : 'maker')
    const failed = result.exitCode !== 0 || envelope?.is_error === true
    return {
      exit_code: result.exitCode,
      review_result: parsed.review_result ?? null,
      unit_result: parsed.unit_result,
      valid: parsed.valid,
      cited: parsed.cited,
      usage,
      tokens: usage.tokens && usage.tokens.source !== 'unavailable' ? { ...usage.tokens, source: 'reported' } : { source: 'unavailable' },
      envelope_error: error,
      // a escada lê o texto final; num erro, a mensagem vai para a classificação de cota
      is_error: failed,
      result_text: failed ? String(result.stderr || result.stdout) : typeof envelope?.response === 'string' ? envelope.response : '',
    }
  })
  const e = r.result ?? {}
  return {
    step_id: r.step_id,
    status: r.status,
    session_ref: null,
    exit_code: e.exit_code ?? null,
    review_result: e.review_result ?? null,
    unit_result: e.unit_result ?? null,
    valid: e.valid ?? false,
    cited: e.cited ?? false,
    usage: e.usage,
    tokens: e.tokens ?? { source: 'unavailable' },
    envelope_error: e.envelope_error ?? null,
    subtype: null,
    num_turns: null,
    is_error: e.is_error === true,
    result_text: e.result_text ?? '',
  }
}
