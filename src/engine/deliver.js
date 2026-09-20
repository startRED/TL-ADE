import { digest16 } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'
import { reconcileLocalMerge } from '../step/reconcile-delivery.js'
import { priorStepResult } from '../step/step.js'

/**
 * Entrega local do commit revisado: fast-forward da base quando ela não mudou.
 *
 * A intenção é gravada antes do efeito e o resultado depois; quando a intenção anterior já foi
 * fechada pelo reconciliador, o resultado gravado é reusado em vez de repetir o merge.
 *
 * @param {{
 *   journal: { append: (event: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   events: Array<Record<string, any>>,
 *   gitPort: import('../git/gitport.js').GitPort,
 *   storyId: string,
 *   baseRef: string | null,
 *   baseBefore: string | null,
 *   reviewedCommit: string,
 * }} options
 * @returns {Promise<{ delivered: boolean, reason: string, commit: string | null }>}
 */
export async function deliverStory({
  journal,
  events,
  gitPort,
  storyId,
  baseRef,
  baseBefore,
  reviewedCommit,
}) {
  if (typeof reviewedCommit !== 'string' || !reviewedCommit.trim()) {
    throw new AdeError('invalid_delivery_input', 'entrega sem commit revisado', 4)
  }
  // Base sem branch (detached) ou sem commit observado não tem alvo de fast-forward: a story fica
  // com o commit preservado e o operador decide, em vez de a entrega escolher uma base calada.
  if (typeof baseRef !== 'string' || !baseRef.trim()) {
    return { delivered: false, reason: 'base_detached', commit: null }
  }
  if (typeof baseBefore !== 'string' || !baseBefore.trim()) {
    return { delivered: false, reason: 'base_without_commit', commit: null }
  }

  const stepId = `${storyId}:deliver`
  const prior = priorStepResult(events, stepId)
  if (prior) {
    const priorData = /** @type {Record<string, any>} */ (prior.data ?? {})
    return {
      delivered: prior.status === 'ok',
      reason: String(priorData.reason ?? (prior.status === 'ok' ? 'already_delivered' : 'delivery_ambiguous')),
      commit: prior.status === 'ok' ? (priorData.result?.commit ?? reviewedCommit) : null,
    }
  }

  const openIntent = [...events].reverse().find((event) =>
    event.kind === 'step_intent' && event.step_id === stepId,
  )
  if (openIntent) {
    const outcome = await reconcileLocalMerge({ intent: openIntent, gitPort })
    const delivered = outcome.verdict === 'ok'
    const commit = delivered ? (outcome.result?.commit ?? outcome.commit ?? reviewedCommit) : null
    await journal.append({
      kind: 'step_result',
      step_id: stepId,
      effect_class: 'local_merge',
      input_digest: openIntent.input_digest,
      status: delivered ? 'ok' : 'ambiguous',
      reason: outcome.reason,
      evidence: outcome.evidence,
      result: commit ? { commit } : null,
      data: { reason: outcome.reason, result: commit ? { commit } : null },
      reconciled: true,
      unit: storyId,
    })
    return { delivered, reason: outcome.reason, commit }
  }

  const intentContext = {
    base_before: baseBefore,
    head_after: reviewedCommit,
    branch_after: baseRef,
  }
  const inputDigest = digest16({
    base_ref: baseRef,
    base_before: baseBefore,
    reviewed_commit: reviewedCommit,
  })

  await journal.append({
    kind: 'step_intent',
    step_id: stepId,
    effect_class: 'local_merge',
    input_digest: inputDigest,
    intent_context: intentContext,
    unit: storyId,
  })

  const outcome = await reconcileLocalMerge({
    intent: {
      step_id: stepId,
      effect_class: 'local_merge',
      base_ref: baseRef,
      base_before: baseBefore,
      reviewed_commit: reviewedCommit,
      intent_context: intentContext,
    },
    gitPort,
  })

  const delivered = outcome.verdict === 'ok'
  const commit = delivered ? (outcome.result?.commit ?? outcome.commit ?? reviewedCommit) : null

  await journal.append({
    kind: 'step_result',
    step_id: stepId,
    effect_class: 'local_merge',
    input_digest: inputDigest,
    status: delivered ? 'ok' : 'ambiguous',
    reason: outcome.reason,
    evidence: outcome.evidence,
    result: commit ? { commit } : null,
    data: { reason: outcome.reason, result: commit ? { commit } : null },
    unit: storyId,
  })

  return { delivered, reason: outcome.reason, commit }
}

/**
 * Envolve o journal para que todo `story_done` declare se a entrega ocorreu.
 * Só o status `delivered` marca `delivered: true`.
 *
 * @param {{ append: (event: Record<string, unknown>) => Promise<Record<string, unknown>> }} journal
 * @returns {{ append: (event: Record<string, unknown>) => Promise<Record<string, unknown>> }}
 */
export function withDeliveryFlag(journal) {
  return {
    append: (partial) => {
      if (!partial || partial.kind !== 'story_done') {
        return journal.append(partial)
      }
      const data = partial.data && typeof partial.data === 'object' && !Array.isArray(partial.data)
        ? /** @type {Record<string, unknown>} */ (partial.data)
        : {}
      return journal.append({
        ...partial,
        data: { ...data, delivered: data.status === 'delivered' },
      })
    },
  }
}
