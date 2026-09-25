import { AdeError } from '../journal/errors.ts'
import { normalize } from '../engine/loop.ts'
import { type Finding, isBlockingFinding, normalizeFinding } from './handoff.ts'

// O revisor julga pelo mesmo contrato do maker (lição da demo: revisor sem contrato reabre decisão já tomada).
const CONTRACT_FIELDS = ['scope_paths', 'do_not_touch', 'out_of_scope', 'interfaces', 'decisions'] as const

export type ReviewContract = Record<(typeof CONTRACT_FIELDS)[number], string[]>

export interface ReviewRequest extends ReviewContract {
  prior_findings: Finding[]
  maker_response: { text: string; wrong_tests: string[] }
  diff: string[]
  instructions: string[]
}

export interface WrongTestVerdict {
  path: string
  agreed: boolean
  reason?: string
}

const INSTRUCTIONS = [
  'Julgue pelo mesmo contrato do maker: scope_paths, do_not_touch, out_of_scope, interfaces e decisions já estão decididos.',
  'Achado que o maker recusou com citação válida: mantenha em action_items com withdrawn: true, withdrawn_reason e citation (file:<caminho do diff>#Lx-Ly ou contract:<trecho do contrato>).',
  'Depois da primeira rodada, abra achado novo só se for grave (critical ou high).',
  'Para cada prova em maker_response.wrong_tests, devolva em wrong_tests {path, agreed, reason}; só a prova com agreed: true pode ser editada.',
]

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AdeError('invalid_review_request', `pedido ao revisor: ${field} deve ser lista de textos`, 4)
  }
  return value
}

/** Caminhos que o maker alegou como prova errada, uma linha `PROVA ERRADA: <caminho> - <motivo>` cada. */
export function wrongTestClaims(makerResponse: string): string[] {
  return [...makerResponse.matchAll(/^\s*PROVA ERRADA:\s*(\S+)/gm)].map((match) => match[1])
}

/** Motivo da linha `ROTEIRO ERRADO: <motivo>` do maker (o roteiro de navegador contradiz o critério), ou `null`. */
export function journeyWrongClaim(makerResponse: string): string | null {
  return /^\s*ROTEIRO ERRADO:\s*(.+)$/m.exec(makerResponse)?.[1].trim() ?? null
}

/** Monta o pedido ao revisor com o contrato do maker, os achados anteriores, a resposta do maker e o diff. */
export function buildReviewHandoff(opts: {
  contract: ReviewContract
  priorFindings: unknown[]
  makerResponse: string
  diff: string[]
}): ReviewRequest {
  if (typeof opts.makerResponse !== 'string') {
    throw new AdeError('invalid_review_request', 'pedido ao revisor: makerResponse deve ser texto', 4)
  }
  const contract = Object.fromEntries(
    CONTRACT_FIELDS.map((field) => [field, stringList(opts.contract?.[field], field)]),
  ) as ReviewContract
  if (!Array.isArray(opts.priorFindings)) {
    throw new AdeError('invalid_review_request', 'pedido ao revisor: priorFindings deve ser lista', 4)
  }
  return {
    ...contract,
    prior_findings: opts.priorFindings.map(normalizeFinding),
    maker_response: { text: opts.makerResponse, wrong_tests: wrongTestClaims(opts.makerResponse) },
    diff: stringList(opts.diff, 'diff'),
    instructions: INSTRUCTIONS,
  }
}

/** Citação existe no diff (`file:<caminho>` com ou sem linhas) ou no contrato (`contract:<trecho>`). */
function citationExists(citation: string | undefined, request: ReviewRequest): boolean {
  if (!citation) return false
  if (citation.startsWith('file:')) return request.diff.includes(citation.slice(5).split('#')[0])
  if (!citation.startsWith('contract:')) return false
  const excerpt = citation.slice(9).trim()
  return excerpt.length > 0 && CONTRACT_FIELDS.some((field) => request[field].some((entry) => entry.includes(excerpt)))
}

const findingKey = (f: Finding) => `${normalize(f.location)}|${normalize(f.problem)}`

/**
 * A TL-ADE é autônoma: achado grave que o revisor manda para "human" (decisão de intenção) não tem quem decida. Ele vai
 * ao modelo com a instrução de escolher a opção conservadora dentro do escopo e registrar a escolha (S2 da missão real:
 * sem isso a rodada nova começava sem nada para corrigir).
 */
function autonomousFinding(f: Finding): Finding {
  if (f.target_role !== 'human' || (f.severity !== 'critical' && f.severity !== 'high')) return f
  return {
    ...f,
    target_role: 'maker',
    required_action: `${f.required_action ?? ''} Sem operador para decidir: escolha a opção conservadora dentro do escopo (por exemplo, tirar o item em conflito em vez de mexer fora do escopo) e registre a escolha no resultado.`.trim(),
  }
}

/**
 * Achados que bloqueiam a rodada: retirado com citação válida sai; citação inexistente mantém;
 * depois da primeira rodada, achado novo só bloqueia se grave.
 */
export function blockingReviewFindings(opts: { findings: unknown[]; request: ReviewRequest; round: number }): Finding[] {
  const priorIds = new Set(opts.request.prior_findings.map((f) => f.id))
  const priorKeys = new Set(opts.request.prior_findings.map(findingKey))
  return opts.findings.map(normalizeFinding).map(autonomousFinding).filter((f) => {
    if (f.withdrawn === true && citationExists(f.citation, opts.request)) return false
    const isNew = opts.round > 1 && !priorIds.has(f.id) && !priorKeys.has(findingKey(f))
    if (isNew && f.severity !== 'critical' && f.severity !== 'high') return false
    return isBlockingFinding(f)
  })
}

/** Só a prova alegada pelo maker e com veredito favorável do revisor fica liberada para edição. */
export function wrongTestVerdict(request: { claimed: string[]; verdicts: WrongTestVerdict[] }): { allowedPaths: string[] } {
  if (!Array.isArray(request.verdicts)) {
    throw new AdeError('invalid_wrong_test_verdict', 'veredito de prova errada deve ser lista', 4)
  }
  for (const verdict of request.verdicts) {
    if (typeof verdict?.path !== 'string' || typeof verdict.agreed !== 'boolean') {
      throw new AdeError('invalid_wrong_test_verdict', 'veredito de prova errada exige path (texto) e agreed (booleano)', 4)
    }
  }
  const agreed = new Set(request.verdicts.filter((v) => v.agreed).map((v) => v.path))
  return { allowedPaths: request.claimed.filter((p) => agreed.has(p)) }
}

/** Prova alegada como errada e editada sem veredito favorável: a rodada é reprovada. */
export function testEditViolations(opts: { changedPaths: string[]; claimed: string[]; allowedPaths: string[] }): string[] {
  return opts.changedPaths.filter((p) => opts.claimed.includes(p) && !opts.allowedPaths.includes(p))
}
