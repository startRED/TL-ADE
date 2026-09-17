/**
 * Erro base do runtime ADE com código de saída padronizado e detalhes estruturados.
 */
export class AdeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} exitCode
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, exitCode, details = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

/**
 * Sinaliza corrupção de integridade ou formato na leitura de uma linha do journal.
 */
export class JournalCorruptError extends AdeError {
  /**
   * @param {number} line
   * @param {string} reason
   */
  constructor(line, reason) {
    super('journal_corrupt', `journal corrompido na linha ${line}: ${reason}`, 2, {
      line,
      reason,
    })
  }
}

/**
 * Sinaliza recusa na validação de schema de um evento antes da gravação no journal.
 */
export class InvalidEventError extends AdeError {
  /**
   * @param {Array<{path: string, message: string}>} errors
   */
  constructor(errors) {
    const first = errors[0]
    super('schema_invalid', `evento inválido: ${first.path} ${first.message}`, 4, {
      errors,
    })
  }
}

/**
 * Sinaliza bloqueio de execução por divergência de core_version em intenções em aberto.
 */
export class StaleWorkflowVersionError extends AdeError {
  /**
   * @param {Array<unknown>} stale
   * @param {number} current
   */
  constructor(stale, current) {
    super(
      'stale_workflow_version',
      `stale_workflow_version: ${stale.length} intenção(ões) aberta(s) de outro core_version; atual ${current}`,
      2,
      { stale, current_core_version: current },
    )
  }
}

/**
 * Sinaliza contenção exclusiva de lease de coordenador já retido por outro processo.
 */
export class CoordinatorConflictError extends AdeError {
  /**
   * @param {{pid?: number | string} | null} owner
   */
  constructor(owner) {
    const pid = owner?.pid ?? 'desconhecido'
    super('coordinator_conflict', `coordinator_conflict: lease em uso por pid ${pid}`, 5, {
      owner,
    })
  }
}

/**
 * Sinaliza que a recuperação automática de lease expirado exige intervenção do operador.
 */
export class LeaseAwaitingOperatorError extends AdeError {
  /**
   * @param {unknown} owner
   * @param {string} reason
   */
  constructor(owner, reason) {
    super('awaiting_operator', `awaiting_operator: ${reason}`, 3, { owner, reason })
  }
}

/**
 * Sinaliza falha em comando ou operação do Git.
 */
export class GitError extends AdeError {
  /**
   * @param {string} reason
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(reason, message, details = {}) {
    super('git_' + reason, message, 2, { ...details, reason })
  }
}

/**
 * Sinaliza estado inesperado na árvore ou saída truncada do Git.
 */
export class UnexpectedTreeStateError extends AdeError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super('unexpected_tree_state', message, 2, details)
  }
}

/**
 * Sinaliza que o HEAD ou a branch do worktree mudaram durante um `model_call`.
 */
export class StateIntegrityError extends AdeError {
  /**
   * @param {string} reason
   * @param {Record<string, unknown>} [details]
   */
  constructor(reason, details = {}) {
    super('state_integrity', 'integridade de estado violada: ' + reason, 4, { ...details, reason })
  }
}

