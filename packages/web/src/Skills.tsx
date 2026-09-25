import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Flex, Heading, Switch, Text, TextField } from './ui.tsx'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { apiFetch, postJson } from './api.ts'

interface Skill { id: string; domain: string | null; trust: string; source: string; summary: string }
interface Plugin { source: string; enabled: boolean; skills: number }
type Filter = 'domain' | 'trust' | 'source'

const FILTERS: Array<[Filter, string]> = [['domain', 'Domínio'], ['trust', 'Confiança'], ['source', 'Fonte']]
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const uniq = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))].sort()

/** Página Skills: catálogo com filtros e leitura do corpo, e os plugins (fontes) ligados ou desligados no projeto ativo. */
export default function SkillsPage({ projectId }: { projectId: string }) {
  const pluginsPath = `/api/projects/${encodeURIComponent(projectId)}/plugins`
  const [all, setAll] = useState<Skill[]>([])
  const [list, setList] = useState<Skill[]>([])
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [filters, setFilters] = useState<Record<Filter, string>>({ domain: '', trust: '', source: '' })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ id: string; body: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = (err: unknown) => setError(messageOf(err))
  const load = useCallback(async () => {
    const [skills, plugs] = await Promise.all([apiFetch<Skill[]>('/api/skills'), apiFetch<Plugin[]>(pluginsPath)])
    setAll(skills)
    setPlugins(plugs)
  }, [pluginsPath])

  useEffect(() => { load().catch((err) => setError(messageOf(err))) }, [load])
  useEffect(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
    apiFetch<Skill[]>(`/api/skills?${params}`).then(setList, (err) => setError(messageOf(err)))
  }, [filters])

  async function show(id: string) {
    if (open?.id === id) return setOpen(null)
    try {
      setOpen(await apiFetch<{ id: string; body: string }>(`/api/skills/${encodeURIComponent(id)}`))
    } catch (err) {
      fail(err)
    }
  }

  async function toggle(source: string, enabled: boolean) {
    setError(null)
    try {
      setPlugins(await postJson<Plugin[]>(pluginsPath, { source, enabled }))
    } catch (err) {
      fail(err)
    }
  }

  const off = new Set((plugins ?? []).filter((p) => !p.enabled).map((p) => p.source))
  const q = query.trim().toLowerCase()
  const shown = list.filter((s) => !q || `${s.id} ${s.summary}`.toLowerCase().includes(q))
  const options: Record<Filter, string[]> = { domain: uniq(all.map((s) => s.domain)), trust: uniq(all.map((s) => s.trust)), source: uniq(all.map((s) => s.source)) }

  return (
    <Flex direction="column" gap="4">
      <Heading as="h1" size="7">Skills</Heading>
      <Text color="gray">Manuais de qualidade que cada papel recebe junto com o pedido. Só entram as do catálogo fora da quarentena e de plugin ligado neste projeto.</Text>
      {error && <Card role="alert"><Text color="red">{error}</Text></Card>}

      <Card asChild>
        <section aria-label="Plugins">
          <Heading as="h2" size="4" mb="2">Plugins</Heading>
          {plugins === null
            ? <Text color="gray">Lendo o catálogo…</Text>
            : plugins.length === 0
            ? <Text color="gray">Nenhuma fonte no catálogo. Sincronize com <span className="mono">ade catalog sync</span>.</Text>
            : (
              <Flex direction="column" gap="2">
                {plugins.map((p) => (
                  <Text as="label" key={p.source} size="2">
                    <Flex gap="3" align="center">
                      <Switch aria-label={`Plugin ${p.source}`} checked={p.enabled} onCheckedChange={(v) => toggle(p.source, v)} />
                      <span className="mono">{p.source}</span>
                      <Text color="gray">{p.skills} skill(s)</Text>
                    </Flex>
                  </Text>
                ))}
              </Flex>
            )}
        </section>
      </Card>

      <Card asChild>
        <section aria-label="Catálogo">
          <Heading as="h2" size="4" mb="2">Catálogo · {shown.length}</Heading>
          <Flex gap="3" wrap="wrap" mb="3">
            <TextField.Root className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nome ou descrição" aria-label="Buscar skill">
              <TextField.Slot><MagnifyingGlass aria-hidden="true" /></TextField.Slot>
            </TextField.Root>
            {FILTERS.map(([key, label]) => (
              <label key={key} className="field">
                <Text size="1" color="gray">{label}</Text>
                <select className="sel" aria-label={label} value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}>
                  <option value="">todos</option>
                  {options[key].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
          </Flex>
          <ul className="skill-list">
            {shown.map((s) => (
              <li key={s.id} className="skill-item">
                <Flex gap="2" align="center" wrap="wrap">
                  <Button variant="ghost" aria-label={`Abrir ${s.id}`} aria-expanded={open?.id === s.id} onClick={() => show(s.id)}>
                    <span className="mono">{s.id}</span>
                  </Button>
                  <Text size="1" color="gray" className="mono">{s.source}{s.domain ? ` · ${s.domain}` : ''}</Text>
                  <Badge color={s.trust === 'quarantine' ? 'red' : 'gray'}>{s.trust}</Badge>
                  {off.has(s.source) && <Badge color="orange">desligada neste projeto</Badge>}
                </Flex>
                <Text as="p" size="2" color="gray">{s.summary || 'sem descrição'}</Text>
                {open?.id === s.id && <pre className="skill-body">{open.body || 'Corpo não encontrado no catálogo.'}</pre>}
              </li>
            ))}
          </ul>
        </section>
      </Card>
    </Flex>
  )
}
