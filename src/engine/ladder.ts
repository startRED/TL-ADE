// Escada de correção de quem escreve.
//
// Lições da demo (proto/rounds.mjs, m-mu8usf5z): ser cortado no teto de turnos é trabalho inacabado, não defeito — a
// V02-R2 subiu ao modelo mais caro com MENOS turnos e morreu de novo no teto; chamada que não muda nada ou que o ambiente
// bloqueou não diz nada sobre o modelo e não pode gastar rodada; e o degrau de reserva não é escalada (v03-s6f: o Gemini
// de reserva recebeu as rodadas 4 a 6 e levou a parte de 1 prova vermelha para 5).
import { AdeError } from '../journal/errors.ts'
import { isBlockingFinding, normalizeFinding } from '../review/handoff.ts'
import { PHASE_TURN_LIMITS, reserveCalls } from './budget.ts'

// model null = padrão da CLI da família
export type Rung = { model: string | null; family: string; maxTurns: number; reserve: boolean }
// extended = a tentativa atual já é a repetição com mais turnos depois de um corte
export type LadderState = { ladder: Rung[]; rung: number; rounds: number; maxTurns: number; reserveUsed: boolean; extended: boolean }
export type MakerOutcome = { kind: 'ok' | 'max_turns' | 'no_change' | 'env_blocked' | 'rejected' }
export type Attempt = { kind: 'repeat' | 'next_model' | 'climb' | 'reserve' | 'park'; maxTurns: number; countsAsRound: boolean; state: LadderState }

const ROUNDS_PER_RUNG = 2
const OUTCOMES = new Set(['ok', 'max_turns', 'no_change', 'env_blocked', 'rejected'])
export const ENV_BLOCK = /sandbox|somente leitura|read-?only|permiss[aã]o negada|access (is )?denied|EPERM|EACCES/i

/** Monta a escada: turnos nunca caem de um degrau para o seguinte e reserva só no fim. */
export function buildLadder(rungs: Array<{ model: string | null; family: string; maxTurns?: number; reserve?: boolean }>): Rung[] {
  if (!Array.isArray(rungs) || rungs.length === 0) throw new AdeError('invalid_ladder', 'escada sem degraus', 4)
  let floor: number = PHASE_TURN_LIMITS.implementation
  let seenReserve = false
  return rungs.map((rung) => {
    if ((rung.model !== null && (typeof rung.model !== 'string' || !rung.model)) || typeof rung.family !== 'string' || !rung.family) {
      throw new AdeError('invalid_ladder', 'degrau sem modelo ou família', 4)
    }
    const declared = rung.maxTurns ?? floor
    if (!Number.isInteger(declared) || declared < 1) throw new AdeError('invalid_ladder', `teto de turnos inválido: ${declared}`, 4)
    if (seenReserve && !rung.reserve) throw new AdeError('invalid_ladder', 'degrau de reserva antes de degrau da escada', 4)
    seenReserve ||= Boolean(rung.reserve)
    floor = Math.max(floor, declared)
    return { model: rung.model, family: rung.family, maxTurns: floor, reserve: Boolean(rung.reserve) }
  })
}

export function ladderStart(ladder: Rung[]): LadderState {
  return { ladder, rung: 0, rounds: 0, maxTurns: ladder[0].maxTurns, reserveUsed: Boolean(ladder[0].reserve), extended: false }
}

/** Classifica a saída do maker; corte no teto (dito pela CLI) vem antes de "nada mudou", porque cortado não terminou. */
export function classifyMakerOutcome(opts: { subtype?: unknown; changed: boolean; resultText?: unknown }): MakerOutcome {
  if (opts.subtype === 'error_max_turns') return { kind: 'max_turns' }
  if (opts.changed) return { kind: 'ok' }
  return { kind: ENV_BLOCK.test(String(opts.resultText ?? '')) ? 'env_blocked' : 'no_change' }
}

function moveTo(state: LadderState, rung: number, kind: Attempt['kind'], countsAsRound: boolean): Attempt {
  const target = state.ladder[rung]
  // o teto já concedido (inclusive o dobro de um corte) nunca cai na troca de degrau
  const maxTurns = Math.max(state.maxTurns, target.maxTurns)
  return { kind, maxTurns, countsAsRound, state: { ...state, rung, rounds: 0, maxTurns, extended: false, reserveUsed: state.reserveUsed || target.reserve } }
}

/** Último degrau que a escada sobe por rodadas reprovadas; os de reserva ficam de fora. */
function climbLast(ladder: Rung[]): number {
  let i = ladder.length - 1
  while (i > 0 && ladder[i].reserve) i--
  return i
}

export function nextAttempt(state: LadderState, outcome: MakerOutcome): Attempt {
  if (!outcome || !OUTCOMES.has(outcome.kind)) throw new AdeError('invalid_maker_outcome', `desfecho desconhecido: ${outcome?.kind}`, 4)
  if (outcome.kind === 'ok') throw new AdeError('invalid_maker_outcome', 'desfecho ok não pede nova tentativa', 4)
  const current = state.ladder[state.rung]
  const park = (countsAsRound: boolean): Attempt => ({ kind: 'park', maxTurns: state.maxTurns, countsAsRound, state })

  // Cortado no teto repete no mesmo degrau com o dobro; cortado de novo com o dobro é rodada perdida.
  if (outcome.kind === 'max_turns' && !state.extended) {
    const maxTurns = state.maxTurns * 2
    return { kind: 'repeat', maxTurns, countsAsRound: false, state: { ...state, maxTurns, extended: true } }
  }
  if (outcome.kind === 'no_change' || outcome.kind === 'env_blocked') {
    const next = state.rung + 1
    if (next >= state.ladder.length || (state.ladder[next].reserve && state.reserveUsed)) return park(false)
    return moveTo(state, next, 'next_model', false)
  }

  // Rodada reprovada (ou cortada duas vezes): duas por degrau, depois sobe; a reserva entra uma vez só.
  if (current.reserve) return park(true)
  const rounds = state.rounds + 1
  if (rounds < ROUNDS_PER_RUNG) {
    return { kind: 'repeat', maxTurns: state.maxTurns, countsAsRound: true, state: { ...state, rounds, extended: false } }
  }
  const top = climbLast(state.ladder)
  if (state.rung < top) return moveTo(state, state.rung + 1, 'climb', true)
  const reserve = state.ladder.findIndex((rung, i) => i > state.rung && rung.reserve)
  if (reserve !== -1 && !state.reserveUsed) return moveTo(state, reserve, 'reserve', true)
  return park(true)
}

/** Troca de modelo gasta uma chamada da reserva existente; negada, a parte estaciona. */
export function reserveRung(opts: { events: Array<Record<string, any>>; storyId: string; rung: number; maxModelCalls: number }): 'reserved' | 'already_reserved' | 'denied' {
  const { reason } = reserveCalls({ events: opts.events, storyId: `${opts.storyId}:rung${opts.rung}`, maxModelCalls: opts.maxModelCalls })
  return reason === 'exhausted' ? 'denied' : reason === 'reserved' ? 'reserved' : 'already_reserved'
}

/** Pedido da rodada de correção: só as vermelhas que a parte deve e os achados graves abertos. */
export function correctionRequest(opts: { redTests: string[]; preexistingReds?: string[]; findings: Array<Record<string, unknown>> }): { red_tests: string[]; findings: Array<ReturnType<typeof normalizeFinding>> } {
  const old = new Set(opts.preexistingReds ?? [])
  return {
    red_tests: opts.redTests.filter((name) => !old.has(name)),
    findings: opts.findings.map(normalizeFinding).filter(isBlockingFinding),
  }
}
