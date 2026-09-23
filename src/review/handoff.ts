// @ts-check
import crypto from 'node:crypto'
import { normalize } from '../engine/loop.ts'

interface Finding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  category: 'patch' | 'bad_spec' | 'intent_gap'
  target_role: 'maker' | 'planner' | 'human'
  location: string
  problem: string
  evidence_refs: string[]
  required_action: string
  state?: 'open' | 'resolved' | 'deferred'
  resolution_evidence?: string | null
}

/**
 * Normaliza e enriquece um finding com identidade, localização, estado e evidência.
 */
export function normalizeFinding(item: any, index: number = 0): Finding {
  const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `finding-${index + 1}`
  const location = typeof item.location === 'string' ? item.location : 'unknown'
  const severity = ['critical', 'high', 'medium', 'low'].includes(item.severity)
    ? item.severity
    : 'medium'
  const category = ['patch', 'bad_spec', 'intent_gap'].includes(item.category)
    ? item.category
    : 'patch'
  const target_role = ['maker', 'planner', 'human'].includes(item.target_role)
    ? item.target_role
    : 'maker'
  const problem = typeof item.problem === 'string' ? item.problem : String(item.problem ?? '')
  const evidence_refs = Array.isArray(item.evidence_refs) ? item.evidence_refs : []
  const required_action =
    typeof item.required_action === 'string' ? item.required_action : String(item.required_action ?? '')

  return {
    id,
    severity,
    category,
    target_role,
    location,
    problem,
    evidence_refs,
    required_action,
    state: item.state ?? 'open',
    resolution_evidence: item.resolution_evidence ?? null,
  }
}

/**
 * Determina se um finding é bloqueante para a continuidade direta do trabalho.
 */
export function isBlockingFinding(f: Finding): boolean {
  if (f.state === 'resolved' || f.state === 'deferred') return false
  if (f.target_role !== 'maker') return false
  return f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium'
}

/**
 * Calcula o digest determinístico dos findings de uma revisão para detecção de estagnação:
 * sha256(sorted(normalize(location) + '|' + normalize(problem)))
 */
export function computeFindingsDigest(findings: Array<any>): string {
  if (!Array.isArray(findings) || findings.length === 0) {
    return crypto.createHash('sha256').update('').digest('hex')
  }

  const items = findings.map((f) => {
    const loc = normalize(f.location ?? '')
    const prob = normalize(f.problem ?? '')
    return `${loc}|${prob}`
  })

  items.sort()
  const payload = items.join('\n')
  return crypto.createHash('sha256').update(payload).digest('hex')
}

/**
 * Detecta se existem findings bloqueantes não corrigidos antes de reenviar o trabalho.
 */
export function detectUnresolvedFindings(opts: {
    previousFindings: Finding[]
    treeBeforeRework: string
    treeAfterRework: string
    changedFiles?: string[]
  }): { unresolved: boolean; reason?: string; blockingFindings: Finding[] } {
  const { previousFindings, treeBeforeRework, treeAfterRework, changedFiles = [] } = opts
  const blocking = previousFindings.filter(isBlockingFinding)

  if (blocking.length === 0) {
    return { unresolved: false, blockingFindings: [] }
  }

  // Se a árvore de trabalho não mudou nada entre as rodadas, os findings permanecem intocados
  if (treeBeforeRework === treeAfterRework) {
    return {
      unresolved: true,
      reason: 'árvore inalterada após rodada de retrabalho com achados bloqueantes pendentes',
      blockingFindings: blocking,
    }
  }

  // Se nenhum arquivo apontado nos findings bloqueantes foi alterado
  const findingFiles = new Set(
    blocking.map((f) => f.location.split(':')[0].trim()).filter((p) => p.length > 0 && p !== 'unknown'),
  )

  if (findingFiles.size > 0 && changedFiles.length > 0) {
    const touchedTargetFiles = changedFiles.some((f) => findingFiles.has(f))
    if (!touchedTargetFiles) {
      return {
        unresolved: true,
        reason: 'nenhum arquivo apontado nos achados bloqueantes foi modificado no retrabalho',
        blockingFindings: blocking,
      }
    }
  }

  return { unresolved: false, blockingFindings: [] }
}

/**
 * Monta um handoff compacto preservando contrato, árvore-base, decisões e achados abertos entre tentativas.
 */
export function buildReviewHandoff(opts: {
    storyId: string
    contractRevision: string
    treeBase: string
    decisions?: Array<{ id: string; choice: string }>
    openFindings: Finding[]
    deltas?: Array<{ kind: 'added' | 'changed' | 'removed'; ref: string }>
    round: number
    notes?: string
  }): Record<string, unknown> {
  const {
    storyId,
    contractRevision,
    treeBase,
    decisions = [],
    openFindings = [],
    deltas = [],
    round,
    notes = '',
  } = opts

  return {
    format_version: 2,
    story_id: storyId,
    contract_revision: contractRevision,
    tree_base: treeBase,
    round,
    decisions,
    open_findings: openFindings.map((f) => ({
      id: f.id,
      location: f.location,
      severity: f.severity,
      state: f.state ?? 'open',
      problem: f.problem.slice(0, 220),
      required_action: f.required_action,
    })),
    deltas,
    next_action: openFindings.length > 0 ? 'rework' : 'verify',
    notes: notes.slice(0, 500),
  }
}
