import path from 'node:path'
import { findStoryStarted } from '../engine/resume.ts'
import { safeId } from '../gates/output.ts'
import { createGitPort } from '../git/gitport.ts'
import { StateIntegrityError } from '../journal/errors.ts'
import { openIntents } from '../journal/fold.ts'
import { readJournal } from '../journal/journal.ts'
import { getProcessStartTime, isProcessAlive } from '../lease/process-info.ts'
import { readReceipt, receiptPath } from '../runner/receipt.ts'
import { reconcileLocalMerge, reconcilePush } from './reconcile-delivery.ts'
import { EFFECT_CLASSES, priorStepResult } from './step.ts'

/** Veredictos fechados desta fatia do reconciler. */
export const VERDICTS = ['ok', 'released', 'ambiguous']

const TREE_RESTORING_CLASSES = ['prepare', 'gate', 'eval_run', 'local_write']

export type ModelCallEvidence = {
  receipt_state?: string | null
  receipt_path?: string
  charge?: 'released' | 'charged'
  checkpoint_ref?: string
  checkpoint_tree?: string
  pid?: number
  start_time_recorded?: string | null
  start_time_now?: string | null
  head_before?: string | null
  head_now?: string | null
  branch_before?: string | null
  branch_now?: string | null
}

/**
 * Fecha a intenção aberta com um `step_result` cujo `status` é o veredicto.
 */
async function close(journal: { append: (partial: Record<string,unknown>) => Promise<Record<string,unknown>> }, intent: Record<string,any>, verdict: 'ok'|'released'|'ambiguous', reason: string, evidence: Record<string,unknown>&ModelCallEvidence, result: unknown = null): Promise<{ step_id: string; effect_class: string; verdict: 'ok'|'released'|'ambiguous'; reason: string; evidence: Record<string,unknown>&ModelCallEvidence; result: unknown }> {
  await journal.append({
    kind: 'step_result',
    step_id: intent.step_id,
    effect_class: intent.effect_class,
    input_digest: intent.input_digest,
    status: verdict,
    reconciled: true,
    reason,
    evidence,
    result,
  })
  return { step_id: intent.step_id, effect_class: intent.effect_class, verdict, reason, evidence, result }
}

/**
 * Reconcilia uma intenção `model_call` a partir do recibo durável e do estado do Git.
 */
async function reconcileModelCall(intent: Record<string,any>, journal: { append: (partial: Record<string,unknown>) => Promise<Record<string,unknown>> }, gitPort: import('../git/gitport.ts').GitPort|null, missionDir: string, deps: { isAlive: (pid: number) => boolean; getStartTime: (pid: number) => Promise<string|null> }): Promise<{ step_id: string; effect_class: string; verdict: 'ok'|'released'|'ambiguous'; reason: string; evidence: Record<string,unknown>&ModelCallEvidence; result: unknown }> {
  let file = intent.receipt_path || receiptPath(missionDir, intent.step_id)

  if (gitPort && intent.intent_context?.head_before) {
    const now = await gitPort.headInfo()
    const headBefore = intent.intent_context.head_before
    const branchBefore = intent.intent_context.branch_before ?? null
    if (now.commit !== headBefore || (branchBefore && now.branch !== branchBefore)) {
      await close(journal, intent, 'ambiguous', 'head_moved', {
        receipt_state: null,
        receipt_path: file,
        head_before: headBefore,
        head_now: now.commit,
        branch_before: branchBefore,
        branch_now: now.branch,
        charge: 'charged',
      })
      throw new StateIntegrityError('head_moved', {
        step_id: intent.step_id,
        head_before: headBefore,
        head_now: now.commit,
      })
    }
  }

  // `readReceipt` já devolve null para arquivo inexistente (ENOENT); qualquer outro erro
  // (recibo corrompido) tem de propagar em vez de ser tratado como ausência de despacho.
  let receipt = readReceipt(file)
  if (!receipt && !intent.receipt_path && safeId(intent.step_id) !== intent.step_id) {
    file = receiptPath(missionDir, safeId(intent.step_id))
    receipt = readReceipt(file)
  }

  if (!receipt || receipt.state === 'start_failed' || (receipt.state === 'starting' && !receipt.process_fingerprint)) {
    return close(journal, intent, 'released', 'receipt_no_dispatch', {
      receipt_state: receipt?.state ?? null,
      receipt_path: file,
      charge: 'released',
    })
  }

  if (receipt.state === 'running' && receipt.process_fingerprint) {
    const pid = receipt.process_fingerprint.pid
    if (deps.isAlive(pid)) {
      const startTimeNow = await deps.getStartTime(pid)
      if (startTimeNow !== receipt.process_fingerprint.start_time) {
        return close(journal, intent, 'ambiguous', 'pid_fingerprint_mismatch', {
          receipt_state: 'running',
          receipt_path: file,
          charge: 'charged',
          pid,
          start_time_recorded: receipt.process_fingerprint.start_time,
          start_time_now: startTimeNow,
        })
      }
    }
  }

  const evidence: Record<string,unknown> = { receipt_state: receipt.state, receipt_path: file, charge: 'charged' }
  if (gitPort && (await gitPort.dirtyPaths()).length > 0) {
    const cp = await gitPort.checkpoint('reconcile/' + intent.step_id.replace(/[^A-Za-z0-9._-]/g, '-'))
    evidence.checkpoint_ref = cp.ref
    evidence.checkpoint_tree = cp.tree
  }

  if (evidence.checkpoint_ref && receipt.state === 'exited' && receipt.exit_code === 0) {
    return close(journal, intent, 'ok', 'call_consumed', evidence, {
      checkpoint: true,
      session_ref: intent.session_ref ?? null,
    })
  }

  return close(journal, intent, 'ambiguous', 'call_consumed', evidence)
}

/**
 * Reconcilia uma intenção `local_commit`: adota o commit existente quando `HEAD` já avançou com a
 * árvore e o pai esperados, libera quando `HEAD` ainda está no pai gravado, e nunca commita de novo.
 */
async function reconcileLocalCommit(intent: Record<string,any>, journal: { append: (partial: Record<string,unknown>) => Promise<Record<string,unknown>> }, gitPort: import('../git/gitport.ts').GitPort|null, _missionDir: string): Promise<{ step_id: string; effect_class: string; verdict: 'ok'|'released'|'ambiguous'; reason: string; evidence: Record<string,unknown>; result: unknown }> {
  if (!gitPort) {
    return close(journal, intent, 'ambiguous', 'commit_ambiguous', { reason_detail: 'sem gitPort' })
  }

  const head = await gitPort.headInfo()
  const { parent_commit: parent, tree_before: expectedTree } = intent.intent_context ?? {}

  if (!parent || !expectedTree) {
    return close(journal, intent, 'ambiguous', 'commit_ambiguous', { head: head.commit })
  }

  if (head.commit === parent) {
    return close(journal, intent, 'released', 'head_at_parent', { head: head.commit, parent })
  }

  const tree = (await gitPort.run(['rev-parse', 'HEAD^{tree}'], { maxBuffer: 1 << 20 })).text
  const firstParent = (
    await gitPort.run(['rev-parse', 'HEAD^'], { maxBuffer: 1 << 20, okCodes: [0, 128] })
  ).text

  if (tree === expectedTree && firstParent === parent) {
    return close(
      journal,
      intent,
      'ok',
      'commit_adopted',
      { head: head.commit, tree, parent },
      { commit: head.commit, tree },
    )
  }

  return close(journal, intent, 'ambiguous', 'commit_ambiguous', {
    head: head.commit,
    tree,
    parent_found: firstParent,
    parent_expected: parent,
  })
}

/**
 * Reconcilia uma única intenção aberta, liberando as classes locais.
 */
export async function reconcileIntent({
  intent,
  journal,
  gitPort = null,
  missionDir,
  deps = {},
}: {
intent: Record<string,any>
journal: { append: (partial: Record<string,unknown>) => Promise<Record<string,unknown>> }
gitPort?: import('../git/gitport.ts').GitPort|null
missionDir: string
deps?: {
isAlive?: (pid: number) => boolean
getStartTime?: (pid: number) => Promise<string|null>
remotePort?: { readRef: (remote: string,ref: string) => Promise<string|null> }
}
}): Promise<{ step_id: string; effect_class: string; verdict: 'ok'|'released'|'ambiguous'; reason: string; evidence: Record<string,unknown>&ModelCallEvidence; result: unknown }> {
  const { isAlive = isProcessAlive, getStartTime = getProcessStartTime } = deps
  if (!EFFECT_CLASSES.includes(intent?.effect_class)) {
    throw new TypeError('effect_class inválido')
  }

  if (intent.effect_class === 'none') {
    return close(journal, intent, 'released', 'pure_read', {})
  }

  if (TREE_RESTORING_CLASSES.includes(intent.effect_class)) {
    // Prova e portão de journal antigo gravavam a intenção sem `tree_before`, mas o step_id termina na árvore
    // conferida antes de rodar (`eval:<id>:<fase>:<árvore>`, `gate:<id>:<árvore>`).
    const idTree = /^(eval|gate):.*:([0-9a-f]{40})$/.exec(String(intent.step_id))?.[2]
    const treeBefore = intent.intent_context?.tree_before ?? (['eval_run', 'gate'].includes(intent.effect_class) ? idTree : undefined)
    // A worktree gravada na intenção manda: a porta recebida é a da raiz do projeto, e restaurar ali a árvore de uma
    // prova apagou as edições não commitadas do operador (e trocou o índice dele) em 24/09.
    const port =
      typeof intent.worktree === 'string' && intent.worktree ? createGitPort({ worktreeDir: intent.worktree }) : gitPort
    // Sem porta Git ou sem `tree_before` não dá para comparar nem restaurar a árvore: fechar aqui
    // marcaria como inalterada uma intenção que pode ter escrito no worktree. A intenção fica aberta.
    if (!port) {
      throw new StateIntegrityError('reconciliação de ' + intent.effect_class + ' sem worktree para observar a árvore', {
        step_id: intent.step_id,
        effect_class: intent.effect_class,
      })
    }
    if (!treeBefore) {
      throw new StateIntegrityError('reconciliação de ' + intent.effect_class + ' sem tree_before em intent_context', {
        step_id: intent.step_id,
        effect_class: intent.effect_class,
      })
    }

    const actual = await port.worktreeTree()
    if (actual === treeBefore) {
      return close(journal, intent, 'released', 'tree_unchanged', { tree: actual })
    }

    const { discardedRef } = await port.restoreTree(treeBefore, {
      label: 'reconcile/' + intent.step_id.replace(/[^A-Za-z0-9._-]/g, '-'),
    })
    return close(journal, intent, 'released', 'tree_restored', {
      tree_before: treeBefore,
      tree_found: actual,
      discarded_ref: discardedRef,
    })
  }

  if (intent.effect_class === 'model_call') {
    const port = intent.worktree ? createGitPort({ worktreeDir: intent.worktree }) : gitPort
    return reconcileModelCall(intent, journal, port, missionDir, { isAlive, getStartTime })
  }

  if (intent.effect_class === 'local_commit') {
    return reconcileLocalCommit(intent, journal, gitPort, missionDir)
  }

  if (intent.effect_class === 'push') {
    const remoteP = deps.remotePort
    if (!remoteP || typeof remoteP.readRef !== 'function') {
      return close(journal, intent, 'ambiguous', 'push_ambiguous', { reason_detail: 'sem remotePort' })
    }
    const outcome = await reconcilePush({ intent, remotePort: remoteP })
    return close(
      journal,
      intent,
      outcome.verdict,
      outcome.reason,
      outcome.evidence,
      outcome.commit ? { commit: outcome.commit } : outcome.remote_head ? { remote_head: outcome.remote_head } : null,
    )
  }

  if (intent.effect_class === 'local_merge') {
    const port =
      gitPort ??
      (typeof intent.worktree === 'string' && intent.worktree ? createGitPort({ worktreeDir: intent.worktree }) : null)
    if (!port) {
      return close(journal, intent, 'ambiguous', 'merge_ambiguous', { reason_detail: 'sem gitPort' })
    }
    const outcome = await reconcileLocalMerge({ intent, gitPort: port })
    return close(
      journal,
      intent,
      outcome.verdict,
      outcome.reason,
      outcome.evidence,
      outcome.result ?? (outcome.commit ? { commit: outcome.commit } : null),
    )
  }

  throw new Error(
    "reconciliação de effect_class '" + intent.effect_class + "' fica fora desta fatia (entra nas stories s4/s5)",
  )
}

/**
 * Percorre as intenções abertas do journal, em ordem de `seq`, reconciliando cada uma.
 */
export async function reconcileAll({ journal, missionDir, gitPort = null, deps = {} }: {
journal: { append: (partial: Record<string,unknown>) => Promise<Record<string,unknown>> }
missionDir: string
gitPort?: import('../git/gitport.ts').GitPort|null
deps?: Record<string,unknown>
}): Promise<Array<Record<string,any>>> {
  const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
  const open = openIntents(events)

  const verdicts: Array<Record<string,any>> = []
  for (const openIntent of open) {
    const intentEvent = events.find((ev) => ev.kind === 'step_intent' && ev.seq === openIntent.seq)
    if (!intentEvent) {
      throw new TypeError('step_intent não encontrado para a intenção aberta')
    }
    const data = ((intentEvent.data ?? {}) as Record<string, unknown>)
    const intent = {
      ...data,
      seq: (intentEvent.seq as number),
      step_id: (intentEvent.step_id as string),
      effect_class: (intentEvent.effect_class as string),
      input_digest: (intentEvent.input_digest as string),
      intent_context: (intentEvent.intent_context ?? data.intent_context as Record<string, string | null> | undefined),
      receipt_path: (intentEvent.receipt_path ?? data.receipt_path as string | undefined),
      worktree: (intentEvent.worktree ?? data.worktree as string | undefined) ||
        (intentEvent.effect_class === 'model_call'
          ? findStoryStarted(events, String(data.unit))?.worktree_dir
          : undefined),
      session_ref: (intentEvent.session_ref ?? data.session_ref as string | null | undefined),
    }
    verdicts.push(await reconcileIntent({ intent, journal, gitPort, missionDir, deps }))
  }
  return verdicts
}

/**
 * Verifica se o commit local de um step foi entregue: alcançável a partir do `HEAD` atual.
 */
export async function verifyDelivery({ events, gitPort, stepId }: {
events: Array<Record<string,any>>
gitPort: { run: (args: string[],options?: Record<string,unknown>) => Promise<{ code: number }> }
stepId: string
}): Promise<{ delivered: boolean; reason: 'commit_on_branch'|'amended_after_journal'|'no_local_commit'; commit: string|null; handoff: 'awaiting_operator'|null }> {
  const prior = priorStepResult(events, stepId)
  const priorData = ((prior?.data ?? {}) as Record<string, any>)
  const commit = (priorData.result?.commit as string | undefined)

  if (!prior || prior.status !== 'ok' || !commit) {
    return { delivered: false, reason: 'no_local_commit', commit: null, handoff: 'awaiting_operator' }
  }

  const probe = await gitPort.run(['merge-base', '--is-ancestor', commit, 'HEAD'], {
    maxBuffer: 1 << 20,
    okCodes: [0, 1, 128],
  })

  if (probe.code === 0) {
    return { delivered: true, reason: 'commit_on_branch', commit, handoff: null }
  }

  return { delivered: false, reason: 'amended_after_journal', commit, handoff: 'awaiting_operator' }
}
