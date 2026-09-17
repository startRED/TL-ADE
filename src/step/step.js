import path from 'node:path'
import { digest16 } from '../journal/canonical.js'
import { readJournal } from '../journal/journal.js'
import { StateIntegrityError } from '../journal/errors.js'
import { maybeFault } from './fault.js'

/** Classes de efeito fechadas desta fatia do motor. */
export const EFFECT_CLASSES = ['none', 'local_write', 'prepare', 'gate', 'model_call', 'local_commit', 'eval_run']

/** Chaves fechadas de `intent_context`; cada valor é `string | null`. */
export const INTENT_CONTEXT_KEYS = [
  'head_before',
  'branch_before',
  'head_after',
  'branch_after',
  'tree_before',
  'parent_commit',
  'remote_before',
  'base_before',
]

const UNIT_OR_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/

/**
 * Acha o último evento `step_result` gravado para o `step_id` informado.
 * @param {Array<Record<string, unknown>>} events
 * @param {string} stepId
 * @returns {Record<string, unknown> | null}
 */
export function priorStepResult(events, stepId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind === 'step_result' && ev.step_id === stepId) {
      return ev
    }
  }
  return null
}

/**
 * Cria o executor de steps write-ahead: grava a intenção antes do efeito e o
 * resultado depois, reusando o que já foi gravado no journal em disco.
 * @param {{
 *   journal: { append: (partial: Record<string, unknown>) => Promise<Record<string, unknown>> },
 *   missionDir: string,
 *   gitPort?: import('../git/gitport.js').GitPort | null,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {{ step: (spec: {
 *   unit: string,
 *   id: string,
 *   effect_class: string,
 *   input: unknown,
 *   intent_context?: Record<string, string | null>,
 *   worktree?: string,
 *   receiptPath?: string,
 * }, effectFn: () => Promise<unknown>) => Promise<{
 *   step_id: string,
 *   status: 'ok' | 'ambiguous',
 *   result: unknown,
 *   reused: boolean,
 *   reason?: string,
 *   evidence?: Record<string, unknown>,
 * }> }}
 */
export function createStepRunner({ journal, missionDir, gitPort = null, env = process.env }) {
  /** @type {Map<string, Promise<void>>} */
  const queues = new Map()

  /**
   * @param {{
   *   unit: string,
   *   id: string,
   *   effect_class: string,
   *   input: unknown,
   *   intent_context?: Record<string, string | null>,
   *   worktree?: string,
   *   receiptPath?: string,
   * }} spec
   * @param {() => Promise<unknown>} effectFn
   */
  async function runStep(spec, effectFn) {
    const { unit, id, effect_class, input, intent_context = {}, worktree = '', receiptPath = '' } = spec ?? {}

    if (typeof unit !== 'string' || !UNIT_OR_ID_REGEX.test(unit)) {
      throw new TypeError('unit inválida')
    }
    if (typeof id !== 'string' || !UNIT_OR_ID_REGEX.test(id)) {
      throw new TypeError('step id inválido')
    }
    if (!EFFECT_CLASSES.includes(effect_class)) {
      throw new TypeError('effect_class inválido')
    }
    if (typeof effectFn !== 'function') {
      throw new TypeError('effectFn inválido')
    }
    if (intent_context === null || typeof intent_context !== 'object' || Array.isArray(intent_context)) {
      throw new TypeError('intent_context inválido')
    }
    for (const key of Object.keys(intent_context)) {
      if (!INTENT_CONTEXT_KEYS.includes(key)) {
        throw new TypeError('intent_context inválido')
      }
      const value = /** @type {Record<string, unknown>} */ (intent_context)[key]
      if (value !== null && typeof value !== 'string') {
        throw new TypeError('intent_context inválido')
      }
    }
    if (typeof worktree !== 'string') {
      throw new TypeError('worktree inválido')
    }
    if (typeof receiptPath !== 'string') {
      throw new TypeError('receiptPath inválido')
    }

    const digest = digest16(input)
    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const prior = priorStepResult(events, id)

    if (prior && prior.status === 'ambiguous' && effect_class === 'model_call') {
      const priorData = /** @type {Record<string, unknown>} */ (prior.data ?? {})
      return {
        step_id: id,
        status: /** @type {'ambiguous'} */ ('ambiguous'),
        result: priorData.result ?? null,
        reused: true,
        reason: String(priorData.reason ?? ''),
        evidence: /** @type {Record<string, unknown>} */ (priorData.evidence ?? {}),
      }
    }

    if (prior && prior.status === 'ok' && (prior.input_digest === digest || effect_class === 'model_call')) {
      const priorData = /** @type {Record<string, unknown>} */ (prior.data ?? {})
      /** @type {{ step_id: string, status: 'ok', result: unknown, reused: boolean, reason?: string, evidence?: Record<string, unknown> }} */
      const reused = {
        step_id: id,
        status: /** @type {'ok'} */ ('ok'),
        result: priorData.result ?? null,
        reused: true,
      }
      if (priorData.reason !== undefined) {
        reused.reason = String(priorData.reason)
      }
      if (priorData.evidence !== undefined) {
        reused.evidence = /** @type {Record<string, unknown>} */ (priorData.evidence)
      }
      return reused
    }

    let before = null
    let recordedContext = intent_context
    if (effect_class === 'model_call' && gitPort) {
      before = await gitPort.headInfo()
      recordedContext = { ...intent_context, head_before: before.commit, branch_before: before.branch }
    }

    await journal.append({
      kind: 'step_intent',
      step_id: id,
      effect_class,
      input_digest: digest,
      intent_context: recordedContext,
      worktree,
      receipt_path: receiptPath,
      unit,
    })
    maybeFault('after_intent', env)

    let value
    try {
      value = await effectFn()
    } catch (err) {
      await journal.append({
        kind: 'step_result',
        step_id: id,
        effect_class,
        input_digest: digest,
        status: 'failed',
        error: { message: String(/** @type {{ message?: unknown }} */ (err)?.message ?? err) },
      })
      throw err
    }

    maybeFault('after_effect', env)

    if (effect_class === 'model_call' && gitPort && before) {
      const after = await gitPort.headInfo()
      if (after.commit !== before.commit || after.branch !== before.branch) {
        await journal.append({
          kind: 'step_result',
          step_id: id,
          effect_class,
          input_digest: digest,
          status: 'state_integrity',
          reason: 'head_moved',
          head_before: before.commit,
          head_after: after.commit,
          branch_before: before.branch,
          branch_after: after.branch,
        })
        throw new StateIntegrityError('head_moved', {
          step_id: id,
          head_before: before.commit,
          head_after: after.commit,
        })
      }
    }

    await journal.append({
      kind: 'step_result',
      step_id: id,
      effect_class,
      input_digest: digest,
      status: 'ok',
      result: value,
    })
    maybeFault('after_result', env)

    return { step_id: id, status: /** @type {'ok'} */ ('ok'), result: value, reused: false }
  }

  /**
   * @param {{
   *   unit: string,
   *   id: string,
   *   effect_class: string,
   *   input: unknown,
   *   intent_context?: Record<string, string | null>,
   *   worktree?: string,
   *   receiptPath?: string,
   * }} spec
   * @param {() => Promise<unknown>} effectFn
   */
  async function step(spec, effectFn) {
    const unit = spec?.unit
    if (typeof unit !== 'string' || !UNIT_OR_ID_REGEX.test(unit)) {
      throw new TypeError('unit inválida')
    }
    const prev = queues.get(unit) ?? Promise.resolve()
    const next = prev.then(
      () => runStep(spec, effectFn),
      () => runStep(spec, effectFn),
    )
    queues.set(
      unit,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  return { step }
}
