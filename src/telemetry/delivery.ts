import type { GitPort } from '../git/gitport.ts'
import { AdeError } from '../journal/errors.ts'
import { provenanceOfCommit } from './cost.ts'

export type Commit = { sha: string; date: string; message: string; files: string[] }
export type DeliveryMetrics = {
  requested_at: string | null
  request_mark: string | null
  delivered_at: string | null
  to_plan_approval_ms: number | null
  to_delivery_ms: number | null
  rounds_by_part: Record<string, number>
  user_corrections: Array<{ sha: string; files: string[]; parts: string[] }>
}

const DELIVERED = new Set(['committed', 'delivered'])

function timeOf(value: unknown, what: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) throw new AdeError('invalid_date', `data inválida em ${what}: ${String(value)}`, 2)
  return ms
}

const isPlanApproval = (e: Record<string, any> | undefined) => e?.kind === 'decision' && e.data?.decision === 'plan_approved'

/**
 * Medição de entrega calculada do journal e do git log, sem evento novo. O pedido é o primeiro
 * registro do journal, exceto quando esse registro é a própria aprovação do plano: aí o journal não
 * guarda o pedido e os prazos ficam indisponíveis. A entrega é o último `story_done` com commit
 * revisado. Correção do usuário é commit sem rodapé ADE-Missao, posterior a um commit da missão,
 * que altera arquivo que ele tocou.
 */
export function deliveryMetrics(events: Array<Record<string, any>>, commits: Commit[]): DeliveryMetrics {
  const request = events[0] && !isPlanApproval(events[0]) ? events[0] : undefined
  const since = (e: Record<string, any> | undefined) => (e && request ? timeOf(e.at, `evento ${e.kind}`) - timeOf(request.at, 'pedido') : null)
  const approval = events.find(isPlanApproval)
  const delivered = events.filter((e) => e?.kind === 'story_done' && DELIVERED.has(e.data?.status) && e.data?.commit)
  const last = delivered.reduce<Record<string, any> | undefined>((a, e) => (a && timeOf(a.at, `evento ${a.kind}`) >= timeOf(e.at, `evento ${e.kind}`) ? a : e), undefined)

  const rounds_by_part: Record<string, number> = {}
  for (const e of events) {
    if (e?.kind !== 'review_result') continue
    const part = String(e.unit ?? e.data?.unit)
    rounds_by_part[part] = (rounds_by_part[part] ?? 0) + 1
  }

  const partOfSha = new Map(delivered.map((e) => [String(e.data.commit), String(e.data.unit)]))
  const mine = commits.filter((c) => partOfSha.has(c.sha)).map((c) => ({ ...c, ms: timeOf(c.date, `commit ${c.sha}`) }))
  const user_corrections: DeliveryMetrics['user_corrections'] = []
  for (const c of commits) {
    if (partOfSha.has(c.sha) || provenanceOfCommit(c.message)) continue
    const ms = timeOf(c.date, `commit ${c.sha}`)
    const earlier = mine.filter((m) => m.ms < ms)
    const files = c.files.filter((f) => earlier.some((m) => m.files.includes(f)))
    if (files.length === 0) continue
    const parts = [...new Set(earlier.filter((m) => m.files.some((f) => files.includes(f))).map((m) => partOfSha.get(m.sha) as string))]
    user_corrections.push({ sha: c.sha, files, parts })
  }

  return {
    requested_at: request ? String(request.at) : null,
    request_mark: request ? String(request.data?.decision ?? request.kind) : null,
    delivered_at: last ? String(last.at) : null,
    to_plan_approval_ms: since(approval),
    to_delivery_ms: since(last),
    rounds_by_part,
    user_corrections,
  }
}

/**
 * Commits de HEAD desde `since`, com sha, data do committer, mensagem e arquivos alterados; null
 * quando o git recusa a leitura (128: pasta fora de repositório ou HEAD sem commit).
 */
export async function gitCommitsSince(git: Pick<GitPort, 'run'>, since: string): Promise<Commit[] | null> {
  const log = await git.run(['-c', 'core.quotePath=false', 'log', `--since=${since}`, '--name-only', '--format=%x1e%H%x1f%cI%x1f%B%x1f', 'HEAD'], { maxBuffer: 1 << 26, okCodes: [0, 128] })
  if (log.code !== 0) return null
  return log.stdout.toString('utf8').split('\x1e').slice(1).map((record) => {
    const [sha, date, message, files] = record.split('\x1f')
    return { sha, date, message: message.trim(), files: files.split('\n').map((f) => f.trim()).filter(Boolean) }
  })
}

function duration(ms: number | null, missing: string): string {
  if (ms === null) return missing
  const minutes = Math.round(ms / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Seção "Medição de entrega" do `ade report`; sem git legível, as correções aparecem como indisponíveis. */
export function renderDeliveryMetrics(metrics: DeliveryMetrics, gitReadable = true): string {
  const unknown = 'indisponível (o journal não registra o pedido)'
  let section = '\n## Medição de entrega\n\n'
  section += metrics.requested_at === null
    ? `- pedido: ${unknown}\n`
    : `- pedido: ${metrics.requested_at} (primeiro registro do journal: ${metrics.request_mark})\n`
  section += `- até a aprovação do plano: ${metrics.requested_at === null ? unknown : duration(metrics.to_plan_approval_ms, 'plano ainda não aprovado')}\n`
  section += `- até a entrega aprovada: ${metrics.delivered_at === null ? 'ainda não entregue' : metrics.requested_at === null ? unknown : duration(metrics.to_delivery_ms, 'ainda não entregue')}\n`
  const rounds = Object.entries(metrics.rounds_by_part)
  if (rounds.length === 0) section += '- rodadas por parte: nenhuma revisão\n'
  else section += `\n| parte | rodadas |\n| --- | --- |\n${rounds.map(([part, n]) => `| ${part} | ${n} |\n`).join('')}`
  if (!gitReadable) section += '\n- correções do usuário: indisponível (git log sem leitura)\n'
  else if (metrics.user_corrections.length === 0) section += '\n- correções do usuário: nenhuma\n'
  else section += `\n| correção | arquivos | partes |\n| --- | --- | --- |\n${metrics.user_corrections.map((c) => `| ${c.sha.slice(0, 12)} | ${c.files.join(', ')} | ${c.parts.join(', ')} |\n`).join('')}`
  return section
}
