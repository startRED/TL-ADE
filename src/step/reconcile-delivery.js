import { AdeError } from '../journal/errors.js'

/**
 * Sinaliza entrada inválida na reconciliação de entrega.
 */
export class DeliveryInvalidInputError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('invalid_input', message, 4, details)
  }
}

/**
 * Sinaliza violação de integridade na reconciliação de entrega.
 */
export class DeliveryIntegrityError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('delivery_integrity', message, 2, details)
  }
}

/**
 * Valida se um valor de identificador ou ref de texto é válido.
 * @param {unknown} val
 * @param {string} name
 * @returns {void}
 */
function assertNonEmptyString(val, name) {
  if (typeof val !== 'string' || !val.trim()) {
    throw new DeliveryInvalidInputError(`${name} inválido`)
  }
}

/**
 * Reconcilia uma intenção de efeito 'push'.
 *
 * @param {{
 *   intent: Record<string, any>,
 *   remotePort: {
 *     readRef?: (remote: string, ref: string) => Promise<string | null>,
 *     readRemoteRef?: (remote: string, ref: string) => Promise<string | null>,
 *   },
 * }} options
 * @returns {Promise<{
 *   verdict: 'ok' | 'released' | 'ambiguous',
 *   reason: string,
 *   remote_head?: string | null,
 *   commit?: string | null,
 *   state?: string,
 *   handoff?: string,
 *   evidence: Record<string, unknown>,
 * }>}
 */
export async function reconcilePush({ intent, remotePort }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new DeliveryInvalidInputError('intent inválido')
  }
  if (!remotePort || (typeof remotePort.readRef !== 'function' && typeof remotePort.readRemoteRef !== 'function')) {
    throw new DeliveryInvalidInputError('remotePort inválido')
  }

  const intentContext = intent.intent_context ?? {}

  // Validação explícita antes de operações de string
  if ('remote' in intent && intent.remote !== undefined) {
    assertNonEmptyString(intent.remote, 'remote')
  }
  if ('ref' in intent && intent.ref !== undefined) {
    assertNonEmptyString(intent.ref, 'ref')
  }
  if ('branch' in intent && intent.branch !== undefined) {
    assertNonEmptyString(intent.branch, 'branch')
  }
  if ('remote' in intentContext && intentContext.remote !== undefined && intentContext.remote !== null) {
    assertNonEmptyString(intentContext.remote, 'intent_context.remote')
  }
  if ('branch_before' in intentContext && intentContext.branch_before !== undefined && intentContext.branch_before !== null) {
    assertNonEmptyString(intentContext.branch_before, 'intent_context.branch_before')
  }

  const remote = intent.remote ?? intent.data?.remote ?? intentContext.remote ?? 'origin'
  const branch = intent.branch ?? intent.data?.branch ?? intentContext.branch_before ?? 'main'
  const ref = intent.ref ?? intent.data?.ref ?? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`)
  const targetCommit =
    intent.commit ??
    intent.data?.commit ??
    intentContext.commit ??
    intentContext.head_after ??
    intentContext.head_before ??
    intent.input?.commit ??
    null
  const remoteBefore = intentContext.remote_before ?? intent.remote_before ?? intent.data?.remote_before ?? null

  const readFn =
    typeof remotePort.readRef === 'function'
      ? remotePort.readRef.bind(remotePort)
      : typeof remotePort.readRemoteRef === 'function'
        ? remotePort.readRemoteRef.bind(remotePort)
        : null

  if (!readFn) {
    throw new DeliveryInvalidInputError('remotePort inválido')
  }

  const remoteHead = await readFn(remote, ref)

  // 1. Remoto inalterado (inclusive null/null): released
  if (remoteHead === remoteBefore) {
    return {
      verdict: 'released',
      reason: 'remote_unchanged',
      remote_head: remoteHead,
      evidence: {
        remote,
        ref,
        remote_head: remoteHead,
        remote_before: remoteBefore,
      },
    }
  }

  // 2. Commit esperado já aterrissou no remoto: ok
  if (targetCommit && remoteHead === targetCommit) {
    return {
      verdict: 'ok',
      reason: 'push_landed',
      remote_head: remoteHead,
      commit: remoteHead,
      evidence: {
        remote,
        ref,
        remote_head: remoteHead,
        remote_before: remoteBefore,
        target_commit: targetCommit,
      },
    }
  }

  // 3. Remoto divergente ou resetado: ambiguous + awaiting_operator
  return {
    verdict: 'ambiguous',
    reason: remoteHead === null ? 'remote_ref_missing_after_intent' : 'remote_diverged',
    state: 'awaiting_operator',
    handoff: 'awaiting_operator',
    remote_head: remoteHead,
    evidence: {
      remote,
      ref,
      remote_head: remoteHead,
      remote_before: remoteBefore,
      target_commit: targetCommit,
      state: 'awaiting_operator',
    },
  }
}

/**
 * Reconcilia uma intenção de efeito 'local_merge'.
 *
 * @param {{
 *   intent: Record<string, any>,
 *   gitPort: {
 *     headInfo?: () => Promise<{ commit: string | null, branch: string | null }>,
 *     readLocalRef?: (ref: string) => Promise<string | null>,
 *     fastForward: (baseRef: string, reviewedCommit: string) => Promise<{ commit: string }>,
 *   },
 * }} options
 * @returns {Promise<{
 *   verdict: 'ok' | 'released' | 'ambiguous',
 *   reason: string,
 *   commit?: string,
 *   fast_forward_calls?: number,
 *   state?: string,
 *   handoff?: string,
 *   evidence: Record<string, unknown>,
 *   result?: { commit: string },
 * }>}
 */
export async function reconcileLocalMerge({ intent, gitPort }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new DeliveryInvalidInputError('intent inválido')
  }
  if (!gitPort || typeof gitPort.fastForward !== 'function') {
    throw new DeliveryInvalidInputError('gitPort inválido')
  }

  const intentContext = intent.intent_context ?? {}

  if ('base_ref' in intent && intent.base_ref !== undefined) {
    assertNonEmptyString(intent.base_ref, 'base_ref')
  }
  if ('base_before' in intent && intent.base_before !== undefined) {
    assertNonEmptyString(intent.base_before, 'base_before')
  }
  if ('reviewed_commit' in intent && intent.reviewed_commit !== undefined) {
    assertNonEmptyString(intent.reviewed_commit, 'reviewed_commit')
  }

  const baseRef = intent.base_ref ?? intent.base ?? intent.data?.base_ref ?? intentContext.branch_after ?? 'main'
  assertNonEmptyString(baseRef, 'base_ref')

  const baseBefore = intentContext.base_before ?? intent.base_before ?? intent.data?.base_before
  if (baseBefore !== undefined && baseBefore !== null) {
    assertNonEmptyString(baseBefore, 'base_before')
  }

  const reviewedCommit =
    intent.reviewed_commit ??
    intent.reviewed ??
    intent.commit ??
    intent.data?.reviewed_commit ??
    intent.data?.commit ??
    intentContext.head_after ??
    intentContext.head_before ??
    intent.input?.commit
  if (reviewedCommit !== undefined && reviewedCommit !== null) {
    assertNonEmptyString(reviewedCommit, 'reviewed_commit')
  }

  if (!baseBefore || !reviewedCommit) {
    throw new DeliveryInvalidInputError('base_before e reviewed_commit são obrigatórios para merge local')
  }

  const head = typeof gitPort.headInfo === 'function'
    ? await gitPort.headInfo()
    : { commit: null, branch: null }

  const currentHead = intent.current_head ?? head.commit
  const mergeHead =
    (typeof gitPort.readLocalRef === 'function' ? await gitPort.readLocalRef('MERGE_HEAD') : null) ??
    intent.merge_head ??
    null
  const baseCurrent =
    (typeof gitPort.readLocalRef === 'function' ? await gitPort.readLocalRef(baseRef) : null) ??
    intent.base_current ??
    (head.branch === baseRef ? head.commit : null)

  const hasMergeHead = mergeHead !== null
  const headDiverged = currentHead !== reviewedCommit
  const baseDiverged = baseCurrent !== null && baseCurrent !== baseBefore

  if (hasMergeHead || headDiverged || baseDiverged) {
    const reason = hasMergeHead ? 'merge_in_progress' : (headDiverged ? 'head_diverged' : 'base_diverged')
    return {
      verdict: 'ambiguous',
      reason,
      state: 'awaiting_operator',
      handoff: 'awaiting_operator',
      fast_forward_calls: 0,
      evidence: {
        base_ref: baseRef,
        base_before: baseBefore,
        base_current: baseCurrent,
        reviewed_commit: reviewedCommit,
        current_head: currentHead,
        merge_head: mergeHead,
        fast_forward_calls: 0,
        state: 'awaiting_operator',
      },
    }
  }

  const ff = await gitPort.fastForward(baseRef, reviewedCommit)
  const finalCommit = ff?.commit ?? reviewedCommit

  return {
    verdict: 'ok',
    reason: 'fast_forward_merged',
    commit: finalCommit,
    evidence: {
      base_ref: baseRef,
      base_before: baseBefore,
      base_current: baseCurrent,
      reviewed_commit: reviewedCommit,
      current_head: currentHead,
      merge_head: null,
      merged_commit: finalCommit,
    },
    result: {
      commit: finalCommit,
    },
  }
}
