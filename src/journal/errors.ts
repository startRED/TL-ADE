/**
 * Erro base do runtime ADE com código de saída padronizado e detalhes estruturados.
 */
export class AdeError extends Error {
  code: string
  exitCode: number
  details: Record<string, unknown>

  constructor(code: string, message: string, exitCode: number, details: Record<string,unknown> = {}) {
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
  constructor(line: number, reason: string) {
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
  constructor(errors: Array<{ path: string; message: string }>) {
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
  constructor(stale: Array<unknown>, current: number) {
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
  constructor(owner: { pid?: number|string }|null) {
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
  constructor(owner: unknown, reason: string) {
    super('awaiting_operator', `awaiting_operator: ${reason}`, 3, { owner, reason })
  }
}

/**
 * Sinaliza falha em comando ou operação do Git.
 */
export class GitError extends AdeError {
  constructor(reason: string, message: string, details: Record<string,unknown> = {}) {
    super('git_' + reason, message, 2, { ...details, reason })
  }
}

/**
 * Sinaliza estado inesperado na árvore ou saída truncada do Git.
 */
export class UnexpectedTreeStateError extends AdeError {
  constructor(message: string, details: Record<string,unknown> = {}) {
    super('unexpected_tree_state', message, 2, details)
  }
}

/**
 * Sinaliza que o HEAD ou a branch do worktree mudaram durante um `model_call`.
 */
export class StateIntegrityError extends AdeError {
  constructor(reason: string, details: Record<string,unknown> = {}) {
    super('state_integrity', 'integridade de estado violada: ' + reason, 4, { ...details, reason })
  }
}

