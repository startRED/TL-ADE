// Prova antes do código (ADR 0036). O pedido que vem do painel traz critérios (dado/quando/então) mas nenhum teste
// escrito, e o eval vermelho exige uma prova que falhe antes do código. Esta etapa despacha um modelo que só escreve
// as provas dos critérios nos arquivos de teste do escopo; o eval vermelho roda de novo sobre elas e só então a parte
// segue para quem escreve o código. Mexer fora dos arquivos de teste desfaz a etapa e estaciona a parte.
import fs from 'node:fs'
import path from 'node:path'
import { reserveCalls } from './budget.ts'
import { authorizedStep, type PaidCallAuthorization } from './paid-call.ts'
import type { GitPort } from '../git/gitport.ts'
import { packTelemetry } from '../pack/pack.ts'
import { buildModelTelemetry, modelsFromUsage } from '../telemetry/telemetry.ts'
import { JOURNEY_FORMAT } from '../visual/journey.ts'

type Journal = { append: (event: Record<string, unknown>) => Promise<unknown> }

/** Arquivo de prova pelo nome: pasta de testes ou sufixo .test/.spec. Padrões com curinga não são alvo de escrita. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/

export function proofTargets(scopePaths: string[]): string[] {
  return scopePaths.map((p) => p.replace(/\\/g, '/')).filter((p) => !p.includes('*') && TEST_PATH.test(p))
}

export const PROOF_POLICY = [
  'Nesta chamada você só escreve PROVAS (testes); o código de produção é de outra etapa, depois de você.',
  '- Escreva um teste por critério do contrato (cada cenário dado/quando/então), nos arquivos de prova listados, e mantenha os testes que já existem.',
  '- As provas precisam FALHAR agora, por asserção: o código novo ainda não existe. Nada de erro de importação ou de sintaxe.',
  '  Para função que ainda não existe, importe o módulo inteiro (import * as m from ...) e verifique com asserção (ex.: assert.equal(typeof m.apagar, "function")) antes de chamar.',
  '- Não crie nem altere nenhum arquivo fora dos arquivos de prova. Não implemente a funcionalidade.',
  '- Rode o comando de provas uma vez para conferir que as novas falham por asserção e que as antigas continuam passando.',
].join('\n')

/** Parte com tela: a prova também escreve o roteiro de navegador dos critérios, que o motor roda antes dos juízes. */
export const JOURNEY_POLICY = [
  '- Esta parte tem tela: escreva também o roteiro de navegador (.ade/journey.json) dos critérios que se veem na tela. Ele também precisa falhar agora, antes do código.',
  JOURNEY_FORMAT,
].join('\n')

export type ProofWriter = { family: string; model?: string; effort?: string | null; resolved: { exe: string; prefixArgs: string[] }; dispatch: (opts: any) => Promise<any> }

type WriterOpts = {
  storyId: string
  missionId: string
  missionDir: string
  worktreeDir: string
  wtPort: GitPort
  treeBefore: string
  contract: Record<string, any>
  testCommand: string[]
  writer: ProofWriter
  step: Function
  journal: Journal
  events: () => Array<Record<string, any>>
  compilePack: (o: any) => { pack_path: string; manifest: any }
  maxModelCalls: number
  usd: number
  quotaReceipt: any
  contextBytes: number
  weeklyCap: number
  workerEnv?: Record<string, string>
  maxTurns?: number
  /** Sufixo do passo: nova tentativa ou outro modelo da cadeia não reaproveita a chamada anterior que falhou. */
  attempt?: string
  /** Skills de teste que o plano escolheu para a parte (seção do pack e o que vai para a telemetria). */
  skills?: { section: string; skills: Array<{ name: string; source: string; sha256: string; bytes: number }> }
  now: () => number
}

export async function writeProof(opts: WriterOpts): Promise<{ kind: 'skip' } | { kind: 'park'; reason: string } | { kind: 'written'; tree: string; files: string[] }> {
  const { storyId, contract, writer } = opts
  const targets = proofTargets(contract.guardrails?.scope_paths ?? [])
  if (targets.length === 0) return { kind: 'skip' }

  const stepId = opts.attempt ? `${storyId}:proof:${opts.attempt}` : `${storyId}:proof`
  await opts.journal.append({ kind: 'model_started', unit: storyId, data: { unit: storyId, role: 'prova', step_id: stepId, family: writer.family, model_id: writer.model ?? null, effort: writer.effort ?? null } })
  const dispatch = await dispatchWriter(opts, {
    unit: `${storyId}:proof`,
    stepId,
    policy: contract.needs_ui ? `${PROOF_POLICY}\n${JOURNEY_POLICY}` : PROOF_POLICY,
    story: {
      tarefa: 'Escrever as provas que falham desta parte, antes do código.',
      parte: contract.title ?? storyId,
      pedido: contract.task,
      criterios: (contract.scenarios ?? []).map((s: any) => ({ id: s.id, dado: s.given, quando: s.when, entao: s.then })),
      arquivos_de_prova: targets,
      comando_de_provas: opts.testCommand.join(' '),
      ...(contract.needs_ui ? { roteiro_de_navegador: '.ade/journey.json' } : {}),
    },
  })
  if (dispatch === 'exhausted') return { kind: 'park', reason: 'budget_calls_exhausted' }

  const changed = (await opts.wtPort.dirtyPaths(opts.treeBefore)).map((p) => p.replace(/\\/g, '/')).filter((p) => !p.startsWith('.ade/'))
  const outside = changed.filter((p) => !targets.includes(p))
  if (outside.length > 0) {
    await opts.wtPort.restoreTree(opts.treeBefore, { label: `proof-out-of-scope/${storyId}` })
    await opts.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'proof_rejected', reason: 'proof_out_of_scope', outside } })
    return { kind: 'park', reason: 'proof_out_of_scope' }
  }
  // modelo que caiu com erro (schema recusado, CLI quebrada) não é o mesmo que "não escreveu": a cadeia tenta o próximo
  if (changed.length === 0) return { kind: 'park', reason: dispatch?.is_error || (dispatch?.exit_code ?? 0) !== 0 ? 'proof_writer_error' : 'proof_not_written' }
  const tree = await opts.wtPort.worktreeTree()
  await opts.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'proof_written', family: writer.family, model: writer.model ?? null, files: changed, tree } })
  return { kind: 'written', tree, files: changed }
}

/**
 * Reescrita única do roteiro de navegador: o mesmo passo quebrou duas passadas seguidas do mesmo jeito e o maker
 * respondeu que o roteiro contradiz o critério. A prova reescreve só `.ade/journey.json`, a partir dos critérios e da
 * tela atual; qualquer outra mudança desfaz a etapa.
 */
export async function rewriteJourney(opts: Omit<WriterOpts, 'testCommand'> & { failure: unknown; claim: string }): Promise<{ kind: 'park'; reason: string } | { kind: 'written' }> {
  const { storyId, contract } = opts
  const dispatch = await dispatchWriter({ ...opts, testCommand: [] }, {
    unit: `${storyId}:journey`,
    stepId: `${storyId}:journey:rewrite`,
    policy: [
      'Nesta chamada você só reescreve o roteiro de navegador (.ade/journey.json). Não mude nenhum outro arquivo.',
      '- O roteiro atual quebrou duas vezes no mesmo passo e quem escreve o código diz que ele contradiz o critério. Releia os critérios e o código da tela atual e escreva o roteiro que confere o que o critério pede.',
      JOURNEY_FORMAT,
    ].join('\n'),
    story: {
      tarefa: 'Reescrever o roteiro de navegador desta parte.',
      parte: contract.title ?? storyId,
      criterios: (contract.scenarios ?? []).map((s: any) => ({ id: s.id, dado: s.given, quando: s.when, entao: s.then })),
      falha_do_roteiro: opts.failure,
      alegacao_do_maker: opts.claim,
    },
  })
  if (dispatch === 'exhausted') return { kind: 'park', reason: 'budget_calls_exhausted' }
  const outside = (await opts.wtPort.dirtyPaths(opts.treeBefore)).map((p) => p.replace(/\\/g, '/')).filter((p) => !p.startsWith('.ade/'))
  if (outside.length > 0) {
    await opts.wtPort.restoreTree(opts.treeBefore, { label: `journey-out-of-scope/${storyId}` })
    return { kind: 'park', reason: 'journey_out_of_scope' }
  }
  return fs.existsSync(path.join(opts.worktreeDir, '.ade', 'journey.json')) ? { kind: 'written' } : { kind: 'park', reason: 'journey_not_written' }
}

/** Reserva, pacote, despacho e telemetria de quem escreve provas (etapa de provas e reescrita do roteiro). */
async function dispatchWriter(opts: WriterOpts, call: { unit: string; stepId: string; policy: string; story: Record<string, unknown> }): Promise<any> {
  const { storyId, contract, writer } = opts
  const { unit, stepId } = call
  const reserved = reserveCalls({ events: opts.events(), storyId: unit, maxModelCalls: opts.maxModelCalls })
  if (reserved.reason === 'exhausted') return 'exhausted'
  const reservation = { calls: 1, usd: opts.usd, turns: 1, family: writer.family }
  if (reserved.reason === 'reserved') {
    await opts.journal.append({ kind: 'budget_reserved', unit, data: { ...reservation, phase: 'proof', quota_receipt: opts.quotaReceipt, unit } })
  }
  const authorization: PaidCallAuthorization = {
    authorized: true,
    family: writer.family,
    phase: 'proof',
    reservation,
    quota_receipt: opts.quotaReceipt,
    context_bytes: opts.contextBytes,
    weekly_percent_cap: opts.weeklyCap,
  }

  const pack = opts.compilePack({
    missionDir: opts.missionDir,
    stepId: `${unit}:pack`,
    sections: {
      contract: JSON.stringify(contract, null, 2),
      policy: call.policy,
      story: JSON.stringify(call.story, null, 2),
      skills: opts.skills?.section ?? '',
    },
    ...(opts.skills?.skills.length ? { skills: opts.skills.skills } : {}),
  })

  const startedAt = opts.now()
  const resultFile = path.join(opts.missionDir, 'proof-result.json')
  let dispatch: any
  let outcome: 'ok' | 'park' | 'stop' = 'ok'
  try {
    dispatch = await writer.dispatch({
      step: authorizedStep(opts.step, authorization, opts.now()),
      authorization,
      unit: storyId,
      stepId,
      packPath: pack.pack_path,
      missionDir: opts.missionDir,
      missionId: opts.missionId,
      cwd: opts.worktreeDir,
      resultFile,
      maxBudgetUsd: opts.usd,
      resolved: writer.resolved,
      // o dublê de testes lê o arquivo de resultado pelo ambiente, como no despacho do maker
      env: opts.workerEnv && !opts.workerEnv.ADE_FAKE_RESULT_FILE ? { ...opts.workerEnv, ADE_FAKE_RESULT_FILE: resultFile } : opts.workerEnv,
      model: writer.model,
      ...(writer.effort && writer.family !== 'agy' ? { effort: writer.effort } : {}),
      ...(writer.family === 'claude' ? {} : { role: 'maker' }),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    })
  } catch (err) {
    outcome = 'stop'
    throw err
  } finally {
    await opts.journal.append({
      kind: 'telemetry',
      unit: storyId,
      data: buildModelTelemetry({
        mission_id: opts.missionId,
        story_id: storyId,
        step_id: stepId,
        family: writer.family,
        role: 'prova',
        effort: writer.effort ?? 'default',
        models: modelsFromUsage(dispatch?.usage?.models ?? [], writer.model ?? null),
        duration_ms: Math.max(0, opts.now() - startedAt),
        tokens: dispatch?.tokens ?? { source: 'unavailable' },
        usage: dispatch?.usage,
        pack: packTelemetry(pack.manifest),
        skills: pack.manifest?.skills ?? [],
        sources: [],
        outcome,
        ttft_ms: null,
        approval_decisions: 0,
        network_attempts: 0,
        files_touched: 0,
        tool_output_raw_bytes: 0,
        tool_output_model_bytes: 0,
      }),
    })
  }
  return dispatch
}
