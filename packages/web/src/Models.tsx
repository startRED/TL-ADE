import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge, Button, Card, Flex, Heading, Text, TextField } from '@radix-ui/themes'
import { apiFetch, postJson } from './api.ts'

type Family = 'claude' | 'codex' | 'agy'
interface Slot {
  model_id: string
  family: Family
  effort: string
  reserve?: boolean
  why: { capacity: number; quality: number; intelligence: number; cost: number; note: string }
}
interface ModelsView {
  catalog: Array<{ model: string; label: string; effort: string }>
  plans: Record<Family, { label: string; tiers: Array<{ id: string; label: string; api?: boolean }> }>
  roles: Record<string, { label: string }>
  settings: { plans: Partial<Record<Family, string>>; blocked: string[]; effort: Record<string, string> }
  blocked: string[]
  quota: Partial<Record<Family, { used: number; resets_at: string | null; source: 'official' | 'manual' | 'plano' }>>
  chains: Record<string, Slot[]>
}
interface CompanyUsage {
  family: Family
  quota: { used: number; source: string } | null
  calls: number
  approved_stories: number
  approved_lines: number
  usd: number
  usd_per_1000_lines: number | null
  minutes_per_call: number | null
}
interface Usage { project_id: string; companies: CompanyUsage[]; usd_informative: true }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SOURCE = { official: 'leitura oficial', manual: 'informada à mão', plano: 'estimada pelo plano', estimated: 'estimada pelo plano' } as Record<string, string>
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Página Modelos do projeto ativo; remontada (e relida) quando o projeto ativo muda. */
export default function ModelsPage({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ModelsView | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [v, u] = await Promise.all([apiFetch<ModelsView>('/api/models'), apiFetch<Usage>('/api/usage')])
    setView(v)
    setUsage(u)
  }, [])

  useEffect(() => { load().catch((err) => setError(messageOf(err))) }, [load, projectId])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  if (!view) return error ? <Card role="alert"><Text color="red">{error}</Text></Card> : <Text color="gray">Lendo os modelos…</Text>
  const label = (id: string) => view.catalog.find((e) => e.model === id)?.label ?? id
  const families = Object.keys(view.plans) as Family[]
  const saveSettings = (body: Record<string, unknown>) => act(() => postJson('/api/models/settings', body))

  return (
    <Flex direction="column" gap="4">
      <Heading as="h1" size="7">Modelos</Heading>
      <Text color="gray">Cada papel tem uma fila em ordem, montada pelos seus planos. Quem escreve e quem revisa são de empresas diferentes.</Text>
      {error && <Card role="alert"><Text color="red">{error}</Text></Card>}

      <Card asChild>
        <section aria-label="Seus planos">
          <Heading as="h2" size="4" mb="2">Seus planos</Heading>
          <Flex gap="4" wrap="wrap">
            {families.map((f) => (
              <label key={f} className="field">
                <Text size="2">{view.plans[f].label}</Text>
                <select className="sel" value={view.settings.plans[f] ?? 'none'} onChange={(e) => saveSettings({ plans: { [f]: e.target.value } })}>
                  {view.plans[f].tiers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </label>
            ))}
          </Flex>
        </section>
      </Card>

      <Card asChild>
        <section aria-label="Cota da semana">
          <Heading as="h2" size="4" mb="2">Cota da semana</Heading>
          {families.filter((f) => view.quota[f]).length === 0 && <Text color="gray">Nenhum plano com cota.</Text>}
          <Flex direction="column" gap="3">
            {families.map((f) => {
              const q = view.quota[f]
              if (!q) return null
              return (
                <div key={f} data-testid={`quota-${f}`}>
                  <Flex justify="between"><Text weight="bold">{view.plans[f].label}</Text><Text className="mono">{q.used}%</Text></Flex>
                  <progress className="bar" max={100} value={Math.min(100, q.used)} aria-label={`Cota ${view.plans[f].label}`} />
                  <Text as="p" size="1" color="gray">
                    {SOURCE[q.source]} · {q.resets_at ? `renova ${when(q.resets_at)}` : 'sem hora de renovação lida'}
                  </Text>
                </div>
              )
            })}
          </Flex>
          {view.settings.plans.agy && view.settings.plans.agy !== 'none' && <ManualQuota onSave={(body) => act(() => postJson('/api/models/quota', body))} />}
        </section>
      </Card>

      <Card asChild>
        <section aria-label="Filas por papel">
          <Heading as="h2" size="4" mb="2">Filas por papel</Heading>
          <Flex direction="column" gap="4">
            {Object.entries(view.chains).map(([role, slots]) => (
              <div key={role}>
                <Flex align="center" justify="between" gap="2" wrap="wrap">
                  <Text weight="bold">{view.roles[role]?.label ?? role}</Text>
                  <select
                    className="sel"
                    aria-label={`Esforço de ${view.roles[role]?.label ?? role}`}
                    value={view.settings.effort[role] ?? ''}
                    onChange={(e) => {
                      const rest = Object.fromEntries(Object.entries(view.settings.effort).filter(([r]) => r !== role))
                      saveSettings({ efforts: e.target.value ? { ...rest, [role]: e.target.value } : rest })
                    }}
                  >
                    <option value="">esforço automático</option>
                    {EFFORTS.map((e) => <option key={e} value={e}>esforço {e}</option>)}
                  </select>
                </Flex>
                {slots.length === 0 && <Text as="p" size="2" color="gray">Nenhum modelo disponível.</Text>}
                <ol className="list">
                  {slots.map((s, i) => (
                    <li key={i} data-testid={`slot-${s.model_id}`}>
                      <Flex align="center" gap="2" wrap="wrap">
                        <Text>{label(s.model_id)} ({s.effort})</Text>
                        {s.reserve && <Badge color="gray">reserva</Badge>}
                        <Button size="1" variant="ghost" color="red" aria-label={`Bloquear ${s.model_id}`} onClick={() => saveSettings({ blocked: [...view.blocked, s.model_id] })}>Bloquear</Button>
                      </Flex>
                      <Text as="p" size="1" color="gray">
                        capacidade {s.why.capacity}% · qualidade {s.why.quality} · inteligência {s.why.intelligence} · custo US$ {s.why.cost} por tarefa
                      </Text>
                      <Text as="p" size="1" color="gray" className="mono">{s.why.note}</Text>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </Flex>
        </section>
      </Card>

      <Card asChild>
        <section aria-label="Modelos bloqueados">
          <Heading as="h2" size="4" mb="2">Modelos bloqueados</Heading>
          {view.blocked.length === 0 ? <Text color="gray">Nenhum.</Text> : (
            <Flex direction="column" gap="1">
              {view.blocked.map((m) => (
                <Flex key={m} align="center" gap="2">
                  <Text className="mono">{m}</Text>
                  <Button size="1" variant="soft" aria-label={`Desbloquear ${m}`} onClick={() => saveSettings({ blocked: view.blocked.filter((x) => x !== m) })}>Desbloquear</Button>
                </Flex>
              ))}
            </Flex>
          )}
        </section>
      </Card>

      <Card asChild>
        <section aria-label="Uso por empresa">
          <Heading as="h2" size="4" mb="1">Uso por empresa</Heading>
          {usage && <Text as="p" size="1" color="gray">Últimos 7 dias do projeto {usage.project_id}. O valor em dólar é só informativo: quem manda é a cota dos planos.</Text>}
          {usage?.companies.length === 0 && <Text color="gray">Nenhuma chamada nesta semana.</Text>}
          <div className="table-wrap">
            <table className="usage">
              <tbody>
                {usage?.companies.map((c) => (
                  <tr key={c.family} data-testid={`usage-${c.family}`}>
                    <th scope="row">{view.plans[c.family].label}</th>
                    <td>cota {c.quota ? `${c.quota.used}% (${SOURCE[c.quota.source]})` : 'sem leitura'}</td>
                    <td>{plural(c.calls, 'chamada', 'chamadas')}</td>
                    <td>{plural(c.approved_stories, 'parte', 'partes')} · {c.approved_lines} linhas aprovadas</td>
                    <td>{c.usd_per_1000_lines === null ? '—' : `US$ ${c.usd_per_1000_lines.toFixed(2)}`} por 1.000 linhas</td>
                    <td>{c.minutes_per_call === null ? '—' : `${c.minutes_per_call.toFixed(1)} min`} por chamada</td>
                    <td>US$ {c.usd.toFixed(2)} (informativo)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </Card>
    </Flex>
  )
}

/** O Google não expõe leitura de cota: o usuário informa o percentual e a hora de renovação. */
function ManualQuota({ onSave }: { onSave: (body: { family: 'agy'; used: number; resets_at: string }) => void }) {
  const [used, setUsed] = useState('')
  const [resets, setResets] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    onSave({ family: 'agy', used: Number(used), resets_at: new Date(resets).toISOString() })
  }

  return (
    <form className="dir-form" onSubmit={submit} aria-label="Cota do Google à mão">
      <TextField.Root type="number" min={0} max={100} value={used} onChange={(e) => setUsed(e.target.value)} aria-label="Uso do Google em %" placeholder="uso %" />
      <TextField.Root type="datetime-local" value={resets} onChange={(e) => setResets(e.target.value)} aria-label="Renovação do Google" />
      <Button type="submit" disabled={used === '' || !resets}>Salvar cota do Google</Button>
    </form>
  )
}
