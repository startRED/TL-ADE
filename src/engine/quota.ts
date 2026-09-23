// Cota esgotada pausa a missão e retoma sozinha na renovação.
//
// Lição da demo (proto/server.mjs, m-mu8usf5z V1-3, 22/09): o Opus parou no teto de turnos, a busca por "rate limit" caiu no
// texto de uma parte que escrevia código de cota e bloqueou o Claude por 1 h com a cota real em 0% e 3%. Só a mensagem de erro
// da CLI decide cota; texto de conversa e error_max_turns nunca decidem. A pausa fica no journal para sobreviver ao reinício.
import { setTimeout as delay } from 'node:timers/promises'
import { AdeError } from '../journal/errors.ts'
import { ENV_BLOCK } from './ladder.ts'

export type CallFailure = { kind: 'quota' | 'max_turns' | 'env_blocked' | 'other'; resetAt?: string }
type Journal = { append: (event: Record<string, unknown>) => Promise<unknown> }

const QUOTA_RE = /usage limit|rate limit|limit reached|hit your limit|out of extra usage/i
// sem hora legível na mensagem, a demo esperava 1 h antes de tentar de novo
const FALLBACK_WAIT_MS = 60 * 60 * 1000
// teto do setTimeout; esperas maiores acordam no meio e voltam a dormir
const MAX_SLEEP_MS = 2 ** 31 - 1

function parseResetAt(text: string): string | undefined {
  const epoch = /\|(\d{10})\b/.exec(text)
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString()
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/.exec(text)
  const ms = iso ? Date.parse(iso[0]) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export function classifyCallFailure(result: { subtype?: unknown; is_error?: unknown; result_text?: unknown } | null | undefined): CallFailure {
  if (result?.subtype === 'error_max_turns') return { kind: 'max_turns' }
  if (result?.is_error !== true) return { kind: 'other' }
  const text = String(result.result_text ?? '')
  if (QUOTA_RE.test(text)) {
    const resetAt = parseResetAt(text)
    return resetAt ? { kind: 'quota', resetAt } : { kind: 'quota' }
  }
  return { kind: ENV_BLOCK.test(text) ? 'env_blocked' : 'other' }
}

/** Pausa por cota ainda aberta no journal (sem `mission_resumed` depois dela). */
export function openQuotaPause(events: Array<Record<string, any>>): { resume_at: string; unit: string; step_id: string } | null {
  let open = null
  for (const event of events) {
    if (event.data?.reason !== 'quota') continue
    if (event.kind === 'mission_paused') open = event.data
    else if (event.kind === 'mission_resumed') open = null
  }
  return open
}

/** Registra a pausa uma vez por chamada: a mesma chamada reaproveitada depois do reinício não muda a hora. */
export async function pauseForQuota(opts: { journal: Journal; events: Array<Record<string, any>>; unit: string; stepId: string; resetAt?: string; now: number }): Promise<void> {
  if (opts.events.some((event) => event.kind === 'mission_paused' && event.data?.step_id === opts.stepId)) return
  const resume_at = opts.resetAt ?? new Date(opts.now + FALLBACK_WAIT_MS).toISOString()
  await opts.journal.append({ kind: 'mission_paused', unit: opts.unit, data: { reason: 'quota', resume_at, unit: opts.unit, step_id: opts.stepId } })
}

/** Dorme até a hora de renovação da pausa aberta e registra a retomada; devolve se havia pausa. */
export async function waitQuotaPause(opts: { journal: Journal; events: Array<Record<string, any>>; now: () => number; sleep?: (ms: number) => Promise<unknown> }): Promise<boolean> {
  const open = openQuotaPause(opts.events)
  if (!open) return false
  const resumeMs = Date.parse(open.resume_at)
  if (!Number.isFinite(resumeMs)) throw new AdeError('invalid_quota_pause', `hora de renovação inválida: ${open.resume_at}`, 4)
  const sleep = opts.sleep ?? delay
  for (let left = resumeMs - opts.now(); left > 0; left = resumeMs - opts.now()) await sleep(Math.min(left, MAX_SLEEP_MS))
  await opts.journal.append({ kind: 'mission_resumed', unit: open.unit, data: { reason: 'quota', resume_at: open.resume_at, unit: open.unit, step_id: open.step_id } })
  return true
}
