import path from 'node:path'
import { createGitPort } from '../git/gitport.js'
import { StateIntegrityError } from '../journal/errors.js'
import { openIntents } from '../journal/fold.js'
import { readJournal } from '../journal/journal.js'
import { getProcessStartTime, isProcessAlive } from '../lease/process-info.js'
import { readReceipt, receiptPath } from '../runner/receipt.js'
import { EFFECT_CLASSES } from './step.js'

/** Veredictos fechados desta fatia do reconciler. */
export const VERDICTS = ['ok', 'released', 'ambiguous']

const TREE_RESTORING_CLASSES = ['prepare', 'gate', 'eval_run', 'local_write']

/**
 * @typedef {Object} ModelCallEvidence
 * @property {string | null} [receipt_state]
 * @property {string} [receipt_path]
 * @property {'released' | 'charged'} [charge]
 * @property {string} [checkpoint_ref]
 * @property {string} [checkpoint_tree]
 * @property {number} [pid]
 * @property {string | null} [start_time_recorded]
 * @property {string | null} [start_time_now]
 * @property {string | null} [head_before]
 * @property {string | null} [head_now]
 * @property {string | null} [branch_before]
 * @property {string | null} [branch_now]
 */

/**
 * Fecha a intenção aberta com um `step_result` cujo `status` é o veredicto.
 * @param {{ append: (partial: Record<string, unknown>) => Promise<Record<string, unknown>> }} journal
 * @param {Record<string, any>} intent
 * @param {'ok' | 'released' | 'ambiguous'} verdict
 * @param {string} reason
 * @param {Record<string, unknown> & ModelCallEvidence} evidence
 * @param {unknown} [result]
 * @returns {Promise<{ step_id: string, effect_class: string, verdict: 'ok' | 'released' | 'ambiguous', reason: string, evidence: Record<string, unknown> & ModelCallEvidence, result: unknown }>}
 */
async function close(journal, intent, verdict, reason, evidence, result = null) {
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
 * @param {Record<string, any>} intent
 * @param {{ append: (partial: Record<string, unknown>) => Promise<Record<string, unknown>> }} journal
 * @param {import('../git/gitport.js').GitPort | null} gitPort
 * @param {string} missionDir
 * @param {{ isAlive: (pid: number) => boolean, getStartTime: (pid: number) => Promise<string | null> }} deps
 * @returns {Promise<{ step_id: string, effect_class: string, verdict: 'ok' | 'released' | 'ambiguous', reason: string, evidence: Record<string, unknown> & ModelCallEvidence, result: unknown }>}
 */
async function reconcileModelCall(intent, journal, gitPort, missionDir, deps) {
  const file = intent.receipt_path || receiptPath(missionDir, intent.step_id)

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
  const receipt = readReceipt(file)

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

  /** @type {Record<string, unknown>} */
  const evidence = { receipt_state: receipt.state, receipt_path: file, charge: 'charged' }
  if (gitPort && (await gitPort.dirtyPaths()).length > 0) {
    const cp = await gitPort.checkpoint('reconcile/' + intent.step_id.replace(/[^A-Za-z0-9._-]/g, '-'))
    evidence.checkpoint_ref = cp.ref
    evidence.checkpoint_tree = cp.tree
  }

  return close(journal, intent, 'ambiguous', 'call_consumed', evidence)
}

/**
 * Reconcilia uma única intenção aberta, liberando as classes locais.
 * @param {{
 *   intent: Record<string, any>,
 *   journal: { append: (partial: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   gitPort?: import('../git/gitport.js').GitPort | null,
 *   missionDir: string,
 *   deps?: { isAlive?: (pid: number) => boolean, getStartTime?: (pid: number) => Promise<string | null> },
 * }} options
 * @returns {Promise<{ step_id: string, effect_class: string, verdict: 'ok' | 'released' | 'ambiguous', reason: string, evidence: Record<string, unknown> & ModelCallEvidence, result: unknown }>}
 */
export async function reconcileIntent({
  intent,
  journal,
  gitPort = null,
  missionDir,
  deps: { isAlive = isProcessAlive, getStartTime = getProcessStartTime } = {},
}) {
  if (!EFFECT_CLASSES.includes(intent?.effect_class)) {
    throw new TypeError('effect_class inválido')
  }

  if (intent.effect_class === 'none') {
    return close(journal, intent, 'released', 'pure_read', {})
  }

  if (TREE_RESTORING_CLASSES.includes(intent.effect_class)) {
    const treeBefore = intent.intent_context?.tree_before
    const port =
      gitPort ?? (typeof intent.worktree === 'string' && intent.worktree ? createGitPort({ worktreeDir: intent.worktree }) : null)
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
    return reconcileModelCall(intent, journal, gitPort, missionDir, { isAlive, getStartTime })
  }

  throw new Error(
    "reconciliação de effect_class '" + intent.effect_class + "' fica fora desta fatia (entra nas stories s4/s5)",
  )
}

/**
 * Percorre as intenções abertas do journal, em ordem de `seq`, reconciliando cada uma.
 * @param {{
 *   journal: { append: (partial: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   missionDir: string,
 *   gitPort?: import('../git/gitport.js').GitPort | null,
 *   deps?: Record<string, unknown>,
 * }} options
 * @returns {Promise<Array<{ step_id: string, effect_class: string, verdict: 'ok' | 'released' | 'ambiguous', reason: string, evidence: Record<string, unknown> & ModelCallEvidence, result: unknown }>>}
 */
export async function reconcileAll({ journal, missionDir, gitPort = null, deps = {} }) {
  const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
  const open = openIntents(events)

  /** @type {Array<{ step_id: string, effect_class: string, verdict: 'ok' | 'released' | 'ambiguous', reason: string, evidence: Record<string, unknown> & ModelCallEvidence, result: unknown }>} */
  const verdicts = []
  for (const openIntent of open) {
    const intentEvent = events.find((ev) => ev.kind === 'step_intent' && ev.seq === openIntent.seq)
    if (!intentEvent) {
      throw new TypeError('step_intent não encontrado para a intenção aberta')
    }
    const intent = {
      seq: /** @type {number} */ (intentEvent.seq),
      step_id: /** @type {string} */ (intentEvent.step_id),
      effect_class: /** @type {string} */ (intentEvent.effect_class),
      input_digest: /** @type {string} */ (intentEvent.input_digest),
      intent_context: /** @type {Record<string, string | null> | undefined} */ (intentEvent.intent_context),
      receipt_path: /** @type {string | undefined} */ (intentEvent.receipt_path),
      worktree: /** @type {string | undefined} */ (intentEvent.worktree),
    }
    verdicts.push(await reconcileIntent({ intent, journal, gitPort, missionDir, deps }))
  }
  return verdicts
}
