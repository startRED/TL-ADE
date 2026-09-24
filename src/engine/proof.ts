// Prova antes do código (ADR 0036). O pedido que vem do painel traz critérios (dado/quando/então) mas nenhum teste
// escrito, e o eval vermelho exige uma prova que falhe antes do código. Esta etapa despacha um modelo que só escreve
// as provas dos critérios nos arquivos de teste do escopo; o eval vermelho roda de novo sobre elas e só então a parte
// segue para quem escreve o código. Mexer fora dos arquivos de teste desfaz a etapa e estaciona a parte.
import path from 'node:path'
import { reserveCalls } from './budget.ts'
import { authorizedStep, type PaidCallAuthorization } from './paid-call.ts'
import type { GitPort } from '../git/gitport.ts'
import { packTelemetry } from '../pack/pack.ts'
import { buildModelTelemetry, modelsFromUsage } from '../telemetry/telemetry.ts'

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

export type ProofWriter = { family: string; model?: string; effort?: string | null; resolved: { exe: string; prefixArgs: string[] }; dispatch: (opts: any) => Promise<any> }

export async function writeProof(opts: {
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
  now: () => number
}): Promise<{ kind: 'skip' } | { kind: 'park'; reason: string } | { kind: 'written'; tree: string; files: string[] }> {
  const { storyId, contract, writer } = opts
  const targets = proofTargets(contract.guardrails?.scope_paths ?? [])
  if (targets.length === 0) return { kind: 'skip' }

  const unit = `${storyId}:proof`
  const reserved = reserveCalls({ events: opts.events(), storyId: unit, maxModelCalls: opts.maxModelCalls })
  if (reserved.reason === 'exhausted') return { kind: 'park', reason: 'budget_calls_exhausted' }
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
    stepId: `${storyId}:proof:pack`,
    sections: {
      contract: JSON.stringify(contract, null, 2),
      policy: PROOF_POLICY,
      story: JSON.stringify({
        tarefa: 'Escrever as provas que falham desta parte, antes do código.',
        parte: contract.title ?? storyId,
        pedido: contract.task,
        criterios: (contract.scenarios ?? []).map((s: any) => ({ id: s.id, dado: s.given, quando: s.when, entao: s.then })),
        arquivos_de_prova: targets,
        comando_de_provas: opts.testCommand.join(' '),
      }, null, 2),
      skills: '',
    },
  })

  const startedAt = opts.now()
  const stepId = `${storyId}:proof`
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
        skills: [],
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

  const changed = (await opts.wtPort.dirtyPaths(opts.treeBefore)).map((p) => p.replace(/\\/g, '/')).filter((p) => !p.startsWith('.ade/'))
  const outside = changed.filter((p) => !targets.includes(p))
  if (outside.length > 0) {
    await opts.wtPort.restoreTree(opts.treeBefore, { label: `proof-out-of-scope/${storyId}` })
    await opts.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'proof_rejected', reason: 'proof_out_of_scope', outside } })
    return { kind: 'park', reason: 'proof_out_of_scope' }
  }
  if (changed.length === 0) return { kind: 'park', reason: 'proof_not_written' }
  const tree = await opts.wtPort.worktreeTree()
  await opts.journal.append({ kind: 'decision', unit: storyId, data: { decision: 'proof_written', family: writer.family, model: writer.model ?? null, files: changed, tree } })
  return { kind: 'written', tree, files: changed }
}
