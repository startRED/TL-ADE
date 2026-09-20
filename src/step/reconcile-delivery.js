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
  const headDiverged = currentHead !== baseBefore && currentHead !== reviewedCommit
  const baseDiverged = baseCurrent !== null && baseCurrent !== baseBefore

  // Queda depois do efeito: a base já aponta para o commit revisado. Repetir o fast-forward seria
  // um segundo efeito sobre o mesmo commit, então o merge é dado por aplicado.
  if (!hasMergeHead && baseCurrent !== null && baseCurrent === reviewedCommit) {
    return {
      verdict: 'ok',
      reason: 'already_merged',
      commit: baseCurrent,
      evidence: {
        base_ref: baseRef,
        base_before: baseBefore,
        base_current: baseCurrent,
        reviewed_commit: reviewedCommit,
        current_head: currentHead,
        merge_head: null,
        merged_commit: baseCurrent,
      },
      result: {
        commit: baseCurrent,
      },
    }
  }

  if (hasMergeHead || headDiverged || baseDiverged) {
    const reason = hasMergeHead ? 'merge_in_progress' : (baseDiverged ? 'base_diverged' : 'head_diverged')
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

const NETWORK_ERROR_CODES = new Set([
  'ENETUNREACH',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ECONNABORTED',
])

/**
 * Classifica se um erro representa falha de conectividade ou indisponibilidade de porta.
 * @param {unknown} err
 * @returns {boolean}
 */
function isNetworkError(err) {
  if (!err || typeof err !== 'object') {
    return false
  }
  const anyErr = /** @type {{ code?: unknown, message?: unknown, cause?: unknown }} */ (err)
  const code = anyErr.code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return true
  }
  if (anyErr.cause && typeof anyErr.cause === 'object') {
    const causeCode = /** @type {{ code?: unknown }} */ (anyErr.cause).code
    if (typeof causeCode === 'string' && NETWORK_ERROR_CODES.has(causeCode)) {
      return true
    }
  }
  const message = anyErr.message
  if (typeof message === 'string') {
    for (const netCode of NETWORK_ERROR_CODES) {
      if (message.includes(netCode)) {
        return true
      }
    }
  }
  return false
}

/**
 * Constrói o resultado padrão de awaiting_operator para falhas de rede da porta.
 * @param {unknown} err
 * @returns {{
 *   verdict: 'ambiguous',
 *   reason: 'network',
 *   state: 'awaiting_operator',
 *   handoff: 'awaiting_operator',
 *   evidence: { reason: 'network', state: 'awaiting_operator', error: string },
 * }}
 */
function buildNetworkUnavailableResult(err) {
  const anyErr = /** @type {{ message?: unknown, code?: unknown }} */ (err ?? {})
  const errorMsg =
    typeof anyErr.message === 'string'
      ? anyErr.message
      : typeof anyErr.code === 'string'
        ? anyErr.code
        : 'ENETUNREACH'

  return {
    verdict: 'ambiguous',
    reason: 'network',
    state: 'awaiting_operator',
    handoff: 'awaiting_operator',
    evidence: {
      reason: 'network',
      state: 'awaiting_operator',
      error: errorMsg,
    },
  }
}

/**
 * Extrai e normaliza os campos de base_ref, head_commit e head_ref da intenção para operações no forge.
 * @param {Record<string, any>} intent
 * @returns {{ baseRef: string, headCommit: string | null, headRef: string }}
 */
function extractForgeIntentRefs(intent) {
  const intentContext = intent.intent_context ?? {}
  const baseRef =
    intent.base_ref ??
    intent.base ??
    intent.data?.base_ref ??
    intentContext.base_ref ??
    intentContext.branch_before ??
    'main'
  const headCommit =
    intent.head_commit ??
    intent.commit ??
    intent.data?.head_commit ??
    intent.data?.commit ??
    intentContext.head_commit ??
    intentContext.head_after ??
    intentContext.head_before ??
    null
  const headRef =
    intent.head_ref ??
    intent.branch ??
    intent.data?.head_ref ??
    intent.data?.branch ??
    intentContext.head_ref ??
    intentContext.branch_after ??
    'head'

  return { baseRef, headCommit, headRef }
}

/**
 * Consulta o pull request no forgePort tratando erros de conectividade de rede sem nova consulta.
 * @param {{ findPullRequest: (params: { headRef?: string }) => Promise<any> }} forgePort
 * @param {string} headRef
 * @returns {Promise<{ ok: true, pr: any } | { ok: false, result: ReturnType<typeof buildNetworkUnavailableResult> }>}
 */
async function queryForgePullRequest(forgePort, headRef) {
  try {
    const pr = await forgePort.findPullRequest({ headRef })
    return { ok: true, pr }
  } catch (err) {
    if (isNetworkError(err)) {
      return { ok: false, result: buildNetworkUnavailableResult(err) }
    }
    throw err
  }
}

/**
 * Reconcilia uma intenção de efeito 'pull_request'.
 *
 * @param {{
 *   intent: Record<string, any>,
 *   forgePort: {
 *     findPullRequest: (params: { headRef?: string }) => Promise<{
 *       state: string,
 *       baseRefName: string,
 *       headRefOid: string,
 *       mergedAt?: string | null,
 *     } | null>,
 *   },
 * }} options
 * @returns {Promise<{
 *   verdict: 'ok' | 'released' | 'ambiguous',
 *   reason: string,
 *   state?: string,
 *   handoff?: string,
 *   evidence: Record<string, unknown>,
 *   pr?: unknown,
 * }>}
 */
export async function reconcilePullRequest({ intent, forgePort }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new DeliveryInvalidInputError('intent inválido')
  }
  if (!forgePort || typeof forgePort.findPullRequest !== 'function') {
    throw new DeliveryInvalidInputError('forgePort inválido')
  }

  const { baseRef, headCommit, headRef } = extractForgeIntentRefs(intent)

  const query = await queryForgePullRequest(forgePort, headRef)
  if (!query.ok) {
    return query.result
  }
  const pr = query.pr

  if (!pr) {
    return {
      verdict: 'ambiguous',
      reason: 'pr_not_found',
      state: 'awaiting_operator',
      handoff: 'awaiting_operator',
      evidence: {
        expected_base: baseRef,
        expected_head: headCommit,
        head_ref: headRef,
        pr: null,
      },
    }
  }

  const isStateOpen = pr.state === 'OPEN'
  const baseMatches = pr.baseRefName === baseRef
  const headMatches = pr.headRefOid === headCommit

  if (isStateOpen && baseMatches && headMatches) {
    return {
      verdict: 'ok',
      reason: 'pr_open_adopted',
      evidence: {
        state: pr.state,
        baseRefName: pr.baseRefName,
        headRefOid: pr.headRefOid,
        mergedAt: pr.mergedAt ?? null,
      },
      pr,
    }
  }

  const reason = !isStateOpen
    ? 'pr_state_mismatch'
    : !headMatches
      ? 'pr_head_mismatch'
      : 'pr_base_mismatch'

  return {
    verdict: 'ambiguous',
    reason,
    state: 'awaiting_operator',
    handoff: 'awaiting_operator',
    evidence: {
      expected_base: baseRef,
      expected_head: headCommit,
      state: pr.state,
      baseRefName: pr.baseRefName,
      headRefOid: pr.headRefOid,
      mergedAt: pr.mergedAt ?? null,
    },
    pr,
  }
}

/**
 * Reconcilia uma intenção de efeito 'pull_request_merge'.
 *
 * @param {{
 *   intent: Record<string, any>,
 *   forgePort: {
 *     findPullRequest: (params: { headRef?: string }) => Promise<{
 *       state: string,
 *       baseRefName: string,
 *       headRefOid: string,
 *       mergedAt?: string | null,
 *     } | null>,
 *   },
 * }} options
 * @returns {Promise<{
 *   verdict: 'ok' | 'released' | 'ambiguous',
 *   reason: string,
 *   commit?: string,
 *   state?: string,
 *   handoff?: string,
 *   evidence: Record<string, unknown>,
 *   pr?: unknown,
 * }>}
 */
export async function reconcileRemoteMerge({ intent, forgePort }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new DeliveryInvalidInputError('intent inválido')
  }
  if (!forgePort || typeof forgePort.findPullRequest !== 'function') {
    throw new DeliveryInvalidInputError('forgePort inválido')
  }

  const { baseRef, headCommit, headRef } = extractForgeIntentRefs(intent)

  const query = await queryForgePullRequest(forgePort, headRef)
  if (!query.ok) {
    return query.result
  }
  const pr = query.pr

  if (!pr) {
    return {
      verdict: 'ambiguous',
      reason: 'pr_not_found',
      state: 'awaiting_operator',
      handoff: 'awaiting_operator',
      evidence: {
        expected_base: baseRef,
        expected_head: headCommit,
        head_ref: headRef,
        pr: null,
      },
    }
  }

  const isMerged = pr.state === 'MERGED'
  const baseMatches = pr.baseRefName === baseRef
  const headMatches = pr.headRefOid === headCommit

  if (isMerged && baseMatches && headMatches) {
    return {
      verdict: 'ok',
      reason: 'remote_merged',
      commit: pr.headRefOid,
      evidence: {
        state: pr.state,
        baseRefName: pr.baseRefName,
        headRefOid: pr.headRefOid,
        mergedAt: pr.mergedAt ?? null,
      },
      pr,
    }
  }

  let reason = 'merge_ambiguous'
  if (pr.state === 'CLOSED') {
    reason = 'pr_closed'
  } else if (pr.state === 'OPEN') {
    reason = 'merge_enqueued_still_open'
  } else if (!headMatches) {
    reason = 'pr_head_mismatch'
  } else if (!baseMatches) {
    reason = 'pr_base_mismatch'
  }

  return {
    verdict: 'ambiguous',
    reason,
    state: 'awaiting_operator',
    handoff: 'awaiting_operator',
    evidence: {
      expected_base: baseRef,
      expected_head: headCommit,
      state: pr.state,
      baseRefName: pr.baseRefName,
      headRefOid: pr.headRefOid,
      mergedAt: pr.mergedAt ?? null,
    },
    pr,
  }
}

/**
 * Reconcilia uma intenção de efeito 'ci_rerun'.
 *
 * @param {{
 *   intent: Record<string, any>,
 * }} options
 * @returns {{
 *   verdict: 'ambiguous',
 *   reason: string,
 *   attempts: number,
 *   rerun_calls: number,
 *   state: string,
 *   handoff: string,
 *   evidence: { attempts: number, rerun_calls: number },
 * }}
 */
export function reconcileCiRerun({ intent }) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new DeliveryInvalidInputError('intent inválido')
  }

  return {
    verdict: 'ambiguous',
    reason: 'ci_rerun_requires_operator',
    attempts: 1,
    rerun_calls: 0,
    state: 'awaiting_operator',
    handoff: 'awaiting_operator',
    evidence: {
      attempts: 1,
      rerun_calls: 0,
    },
  }
}
