// Quem executa cada papel de uma parte, pelas filas dos planos do usuário (ADR 0033). As filas escolhem quem executa; o
// plano e os contratos aprovados não mudam (a aprovação cobre o quê e o escopo, não qual modelo executa).
import { CATALOG } from './catalog.ts'
import { buildChains, measureQuality } from './chains.ts'
import type { ChainSlot, QuotaReading } from './chains.ts'
import type { Family } from './catalog.ts'
import type { ModelSettings } from './settings.ts'
import { storyRisk } from '../intent/risk.ts'

export type StoryChains = { writer: ChainSlot[]; checker: ChainSlot[]; fix: ChainSlot[] }

const intelligence = (s: ChainSlot) => CATALOG.find((e) => e.model === s.model && e.effort === s.effort)?.intelligence ?? 0
const same = (a: ChainSlot, b: ChainSlot) => a.family === b.family && a.model === b.model && a.effort === b.effort

/**
 * Filas da parte; null sem `models.plans` (o motor usa os papéis do contrato).
 * - writer: fila do código comum (do código leve quando a parte é leve);
 * - fix: a escada começa em quem escreve, sobe só em inteligência do catálogo e termina na reserva de outra empresa;
 * - checker: a fila de revisão seguida da fila de quem escreve, para haver revisor de outra empresa também quando a
 *   rodada é da reserva; o motor pega o primeiro de empresa diferente de quem escreveu a rodada.
 */
export function routeStory({ settings, quota, events, now, contract }: {
  settings: ModelSettings
  quota: Partial<Record<Family, QuotaReading>>
  events: Array<Record<string, any>>
  now: number
  contract: Record<string, any>
}): (StoryChains & { why: Record<keyof StoryChains, string[]> }) | null {
  if (Object.keys(settings.plans).length === 0) return null
  const { chains, why } = buildChains({ ...settings, quota, measured: measureQuality(events), now })
  const role = storyRisk(contract) === 'light' ? 'impl_light' : 'impl'
  const writer = chains[role]
  const head = writer[0]
  const fix = head
    ? [head, ...chains.fix.filter((s) => !s.reserve && intelligence(s) > intelligence(head)), ...chains.fix.filter((s) => s.reserve && s.family !== head.family)]
    : []
  const checker = [...chains.checker, ...writer.filter((s) => !chains.checker.some((c) => same(c, s)))]
  return { writer, checker, fix, why: { writer: why[role], checker: why.checker, fix: why.fix } }
}

/** Primeiro papel do contrato (ou degrau da escada) com modelo bloqueado pelo usuário; conferido sem `models.plans`. */
export function blockedInContract(settings: ModelSettings, contract: Record<string, any>, ladder: Array<{ model: string | null }> = []): { role: string; model: string } | null {
  const roles: Array<[string, unknown]> = [
    ['maker', contract.roles?.maker?.model_id],
    ['checker', contract.roles?.checker_round?.model_id],
    ...ladder.map((rung): [string, unknown] => ['fix', rung.model]),
  ]
  for (const [role, model] of roles) {
    if (typeof model === 'string' && settings.blocked.includes(model)) return { role, model }
  }
  return null
}

/** Nome do modelo para a linha de comando: o Google leva o esforço no nome (gemini-3.8-flash-high). */
export const cliModel = (slot: { family: string; model: string; effort: string | null }) =>
  slot.family === 'agy' && slot.effort ? `${slot.model}-${slot.effort}` : slot.model
