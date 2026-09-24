// Críticos reais do plano (lição de proto/server.mjs, planCritic): outra IA lê o plano como quem
// vai implementá-lo, em modo somente leitura, antes de qualquer código. Os candidatos saem dos
// papéis de .ade/config.json; `critiquePlan` usa o primeiro e, se ele falha, o de outra empresa.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAgyArgs } from '../adapters/agy/argv.ts'
import { isAgyAvailable, setAgyAvailable } from '../adapters/agy/index.ts'
import { parseAgyOutput } from '../adapters/agy/parse.ts'
import { parseClaudeOutput } from '../adapters/claude/parse.ts'
import { buildCodexArgs } from '../adapters/codex/argv.ts'
import { dropNulls, strictSchema } from '../adapters/codex/strict-schema.ts'
import { parseCodexOutput } from '../adapters/codex/parse.ts'
import { checkCanary, plantCanary } from '../contain/canary.ts'
import { AdeError } from '../journal/errors.ts'
import { resolveBinary } from '../runner/resolve-binary.ts'
import { runWorker } from '../runner/spawn.ts'
import { planStoriesOf } from './proportional.ts'
import type { PlanCritic } from './proportional.ts'

/** Cadeias que podem ler o plano, na ordem da demo: quem implementa, quem revisa, quem planeja. */
const CRITIC_ROLES = ['maker', 'checker_round', 'checker_gate', 'intent_compiler', 'research']
const CRITIC_FAMILIES = ['codex', 'agy']
const CRITIC_TIMEOUT_S = 600
/** O agy recebe o prompt no argv, limitado a ARGV_MAX_CHARS (30000). */
const PLAN_MAX_CHARS = 20000

const PLAN_CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'revise'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['story', 'problem', 'fix'],
        properties: { story: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
      },
    },
  },
}

export type ModelRef = { family: string; model_id: string; effort?: string }
type CriticInput = { plan: any; contracts: any[]; epicAcceptance?: string[] }
/** Chamada somente leitura de um papel: prompt e schema da resposta, na pasta da missão. */
/** `web`: a opção "Pesquisar fatos" da missão; o modelo pode buscar e ler páginas na internet. */
export type ModelCall = { missionId: string; stepId: string; prompt: string; schema: object; maxTurns?: number; web?: boolean }
type RunOpts = {
  repoDir: string
  env: Record<string, string | undefined>
  runWorkerImpl: typeof runWorker
  resolveBinaryImpl: (command: string) => { exe: string; prefixArgs: string[] }
}

function criticPrompt({ plan, contracts, epicAcceptance = [] }: CriticInput): string {
  const stories = planStoriesOf(contracts, plan.briefing?.human_decisions)
  const epic = epicAcceptance.length > 0
    ? ['Critérios do épico (cada um precisa de uma story que o entregue; o que faltar vira issue com story "novo" e fix descrevendo a story faltante):', ...epicAcceptance.map((c) => `- ${c}`)]
    : []
  return [
    'Você vai criticar um PLANO, não código. Leia cada story como quem vai implementá-la agora; quem implementa investiga o repositório e decide detalhes locais.',
    'Aponte só bloqueios concretos: requisito contraditório, referência obrigatória inexistente (confira), contrato público incompatível, risco sem proteção, dependência entre stories não declarada, duas stories no mesmo trecho, story que precisa mudar arquivo fora do seu scope_paths.',
    'Falta de receita, exemplo, nome de variável ou mensagem exata não é defeito. Não peça escopo novo nem opine sobre estilo.',
    'Plano executável: verdict = "ready" e issues = []. Senão verdict = "revise" e até 10 issues com story (id), problem (uma frase) e fix (o texto concreto que falta). Responda em português no JSON exigido.',
    `Pedido do usuário: ${plan.intent}`,
    ...epic,
    '--- PLANO ---',
    JSON.stringify({ stories }, null, 1).slice(0, PLAN_MAX_CHARS),
  ].join('\n')
}

function workerRequest(stepId: string, repoDir: string, argv: string[], resultFile: string) {
  return { unit: stepId, authorization: 'unattended', cwd: repoDir, argv, timeout: CRITIC_TIMEOUT_S, result_file: resultFile }
}

async function codexCall(ref: ModelRef, call: ModelCall, missionDir: string, opts: RunOpts): Promise<unknown> {
  const stepId = `${call.stepId}-codex`
  const resultFile = path.join(missionDir, `${stepId}.json`)
  const schemaPath = path.join(missionDir, `${call.stepId}.schema.json`)
  // Mesma missão, mesmo arquivo: resposta de um `ade plan` anterior não pode passar por nova.
  fs.rmSync(resultFile, { force: true })
  fs.mkdirSync(missionDir, { recursive: true })
  // modo estrito da OpenAI: o schema original volta 400 antes de o modelo rodar (mesma cópia do adapter do Codex)
  fs.writeFileSync(schemaPath, JSON.stringify(strictSchema(call.schema)))
  const resolved = opts.resolveBinaryImpl('codex')
  const args = [...buildCodexArgs({ role: 'checker_plan', cwd: opts.repoDir, schemaPath, resultFile, model: ref.model_id, effort: ref.effort }), ...(call.web ? ['-c', 'tools.web_search=true'] : [])]
  const res = await opts.runWorkerImpl({
    resolved,
    args,
    cwd: opts.repoDir,
    missionDir,
    missionId: call.missionId,
    stepId,
    request: workerRequest(stepId, opts.repoDir, [resolved.exe, ...resolved.prefixArgs, ...args], resultFile),
    timeoutS: CRITIC_TIMEOUT_S,
    env: opts.env as Record<string, string>,
    stdinData: call.prompt,
  })
  const { envelope, error } = parseCodexOutput(res.stdout, resultFile)
  if (!envelope) throw new AdeError('codex_output_invalid', `codex saiu com código ${res.exitCode} sem resposta (${error})`, 2)
  // opcional não preenchido volta null no modo estrito: sai antes de validar contra o schema original
  return dropNulls(envelope.structured_output ?? envelope)
}

async function agyCall(ref: ModelRef, call: ModelCall, missionDir: string, opts: RunOpts): Promise<unknown> {
  if (!isAgyAvailable()) throw new AdeError('family_unavailable', 'família agy indisponível após violação de contenção', 4)
  const stepId = `${call.stepId}-agy`
  const resolved = opts.resolveBinaryImpl('agy')
  const canary = plantCanary({
    worktreeDir: opts.repoDir,
    outsideDir: path.join(os.tmpdir(), `tl-ade-canary-${stepId}-${crypto.randomUUID()}`),
    unitId: stepId,
  })
  const prompt = `${call.prompt}\nTeste de contenção controlado: ${canary.instruction}`
  const args = buildAgyArgs({ prompt, model: ref.model_id, schema: call.schema, cwd: opts.repoDir })
  const run = await opts
    .runWorkerImpl({
      resolved,
      args,
      cwd: opts.repoDir,
      missionDir,
      missionId: call.missionId,
      stepId,
      request: workerRequest(stepId, opts.repoDir, [resolved.exe, ...resolved.prefixArgs, ...args], path.join(missionDir, `${stepId}.json`)),
      timeoutS: CRITIC_TIMEOUT_S,
      env: { ...opts.env, AGY_READ_ONLY: '1' } as Record<string, string>,
    })
    .then((res) => ({ res }), (error: unknown) => ({ error }))
  // A fuga do canário prevalece sobre o erro do worker, como na pesquisa.
  const check = checkCanary(canary)
  if (check.escaped) {
    setAgyAvailable(false)
    throw new AdeError('canary_escaped', `canário violado fora do diretório permitido: ${check.filePath}`, 4)
  }
  if ('error' in run) throw run.error
  if (run.res.exitCode !== 0) throw new AdeError('agy_execution_failed', `agy saiu com código ${run.res.exitCode}`, 2)
  const { envelope, error } = parseAgyOutput(run.res.stdout)
  if (!envelope) throw new AdeError('agy_output_invalid', `saída do agy inválida: ${error}`, 2)
  if (envelope.structured_output) return envelope.structured_output
  const text = String(envelope.response ?? '')
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
}

/**
 * Claude só leitura com resposta estruturada: prompt pela entrada padrão, schema no argv, ferramentas de leitura
 * e poucos turnos (o mesmo desenho do claudeCall da demo, que entende e planeja pedidos há semanas).
 */
async function claudeCall(ref: ModelRef, call: ModelCall, missionDir: string, opts: RunOpts): Promise<unknown> {
  const stepId = `${call.stepId}-claude`
  fs.mkdirSync(missionDir, { recursive: true })
  const resolved = opts.resolveBinaryImpl('claude')
  const args = [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(call.schema),
    '--safe-mode', '--no-session-persistence', '--max-turns', String(call.maxTurns ?? 8),
    '--permission-mode', 'acceptEdits', '--tools', 'Read', 'Glob', 'Grep', ...(call.web ? ['WebSearch', 'WebFetch'] : []),
    '--model', ref.model_id, ...(ref.effort ? ['--effort', ref.effort] : []),
  ]
  const res = await opts.runWorkerImpl({
    resolved,
    args,
    cwd: opts.repoDir,
    missionDir,
    missionId: call.missionId,
    stepId,
    request: workerRequest(stepId, opts.repoDir, [resolved.exe, ...resolved.prefixArgs, ...args], path.join(missionDir, `${stepId}.json`)),
    timeoutS: CRITIC_TIMEOUT_S,
    env: opts.env as Record<string, string>,
    stdinData: call.prompt,
  })
  const { envelope, error } = parseClaudeOutput(res.stdout)
  if (!envelope) throw new AdeError('claude_output_invalid', `claude saiu com código ${res.exitCode} sem resposta (${error})`, 2)
  if (envelope.is_error) throw new AdeError('claude_output_invalid', `claude respondeu com erro: ${String(envelope.result ?? envelope.subtype ?? 'sem detalhe').slice(0, 300)}`, 2)
  if (!envelope.structured_output) throw new AdeError('claude_output_invalid', 'claude respondeu sem o JSON exigido', 2)
  return envelope.structured_output
}

/**
 * Chamada por uma fila de modelos (claude, codex ou agy), na ordem: o primeiro que responde vale.
 * É a porta do planejamento do pedido; os críticos seguem só com codex e agy.
 */
export function refsModelCall(
  refs: ModelRef[],
  label: string,
  { repoDir, env = process.env, runWorkerImpl = runWorker, resolveBinaryImpl = resolveBinary }: { repoDir: string } & Partial<Omit<RunOpts, 'repoDir'>>,
): (call: ModelCall) => Promise<unknown> {
  const opts: RunOpts = { repoDir, env, runWorkerImpl, resolveBinaryImpl }
  const usable = refs.filter((ref) => ref && ['claude', 'codex', 'agy'].includes(ref.family))
  if (usable.length === 0) throw new AdeError('role_call_failed', `papel ${label} sem modelo configurado`, 2, { role: label })
  return async (call) => {
    const errors: string[] = []
    for (const ref of usable) {
      try {
        const run = ref.family === 'claude' ? claudeCall : ref.family === 'codex' ? codexCall : agyCall
        return await run(ref, call, path.join(repoDir, '.ade', 'missions', call.missionId), opts)
      } catch (err) {
        if (err instanceof AdeError && err.code === 'canary_escaped') throw err
        errors.push(`${ref.family}/${ref.model_id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new AdeError('role_call_failed', `papel ${label} sem resposta: ${errors.join('; ')}`, 2, { role: label })
  }
}

/** Críticos do plano a partir dos papéis configurados; vazio quando nenhum é codex ou agy. */
export function planCriticsFromConfig(
  adeConfig: any,
  {
    repoDir,
    env = process.env,
    runWorkerImpl = runWorker,
    resolveBinaryImpl = resolveBinary,
  }: { repoDir: string } & Partial<Omit<RunOpts, 'repoDir'>>,
): PlanCritic[] {
  const opts: RunOpts = { repoDir, env, runWorkerImpl, resolveBinaryImpl }
  const critics: PlanCritic[] = []
  for (const name of CRITIC_ROLES) {
    const role = adeConfig?.roles?.[name]
    const refs: ModelRef[] = role ? [role.primary, ...role.fallbacks] : []
    for (const ref of refs) {
      if (!CRITIC_FAMILIES.includes(ref.family)) continue
      if (critics.some((c) => c.family === ref.family && c.model === ref.model_id)) continue
      const modelCall = ref.family === 'codex' ? codexCall : agyCall
      critics.push({
        family: ref.family,
        model: ref.model_id,
        critique: (input: CriticInput) =>
          modelCall(
            ref,
            { missionId: input.plan.mission_id, stepId: 'plan-critic', prompt: criticPrompt(input), schema: PLAN_CRITIC_SCHEMA },
            path.join(repoDir, '.ade', 'missions', input.plan.mission_id),
            opts,
          ),
      })
    }
  }
  return critics
}

/**
 * Chamada pelas cadeias codex/agy de um papel de .ade/config.json, na ordem primária e
 * fallbacks: a primeira que responde vale. Null quando o papel não tem cadeia codex nem agy.
 */
export function roleModelCall(
  adeConfig: any,
  roleName: string,
  { repoDir, env = process.env, runWorkerImpl = runWorker, resolveBinaryImpl = resolveBinary }: { repoDir: string } & Partial<Omit<RunOpts, 'repoDir'>>,
): ((call: ModelCall) => Promise<unknown>) | null {
  const opts: RunOpts = { repoDir, env, runWorkerImpl, resolveBinaryImpl }
  const role = adeConfig?.roles?.[roleName]
  const refs: ModelRef[] = (role ? [role.primary, ...(role.fallbacks ?? [])] : []).filter((ref: ModelRef) => CRITIC_FAMILIES.includes(ref?.family))
  if (refs.length === 0) return null
  return async (call) => {
    const errors: string[] = []
    for (const ref of refs) {
      try {
        return await (ref.family === 'codex' ? codexCall : agyCall)(ref, call, path.join(repoDir, '.ade', 'missions', call.missionId), opts)
      } catch (err) {
        // Fuga do canário não é falha da cadeia: interrompe a chamada.
        if (err instanceof AdeError && err.code === 'canary_escaped') throw err
        errors.push(`${ref.family}/${ref.model_id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new AdeError('role_call_failed', `papel ${roleName} sem resposta: ${errors.join('; ')}`, 2, { role: roleName })
  }
}
