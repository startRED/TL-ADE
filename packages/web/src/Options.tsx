import { useEffect, useState, type FormEvent } from 'react'
import { Button, Card, Flex, Heading, RadioGroup, Switch, Text, TextField } from '@radix-ui/themes'
import { apiFetch, postJson } from './api.ts'

type Autonomy = 'safe' | 'controlled' | 'restricted'
interface MissionOptions {
  autonomy: Autonomy
  ceilings: { max_turns: number | null; max_rounds: number | null; usd_informative: number | null }
  fast_lane: boolean
  visual_gate: boolean
  images: boolean
  research: boolean
}
type Flag = 'fast_lane' | 'visual_gate' | 'images' | 'research'
type Ceiling = keyof MissionOptions['ceilings']

// Níveis do ADR 0015; a autonomia muda decisões durante a execução, nunca aprova briefing ou plano.
const AUTONOMY: Array<[Autonomy, string]> = [
  ['safe', 'ler, editar, testar, branch e commit local'],
  ['controlled', 'também push, PR, dependências novas e migrations, com uma aprovação na missão'],
  ['restricted', 'também produção, segredos e ações destrutivas; nunca roda desatendida'],
]
const FLAGS: Array<[Flag, string, string]> = [
  ['fast_lane', 'Faixa rápida', 'Pedido curto de correção em projeto existente pula a entrevista.'],
  ['visual_gate', 'Portão visual', 'Varre a interface atrás de cara de template e força uma rodada de retoque.'],
  ['images', 'Imagens geradas por IA', 'Quando o plano pede fotos ou ilustrações, gera antes das partes começarem.'],
  ['research', 'Pesquisa na internet', 'Só quando o plano depende de um fato de fora, como a versão de uma biblioteca.'],
]
const CEILINGS: Array<[Ceiling, string, string]> = [
  ['max_turns', 'Teto de turnos por chamada', 'Nenhuma chamada passa disso, nem a repetição depois de um corte.'],
  ['max_rounds', 'Teto de rodadas por parte', 'Somando todos os modelos da fila; ao chegar nele a parte para e espera você.'],
  ['usd_informative', 'Valor em dólar (só informativo)', 'Só informativo: aparece para você, mas nunca bloqueia. Quem manda é a cota dos planos.'],
]

type Draft = Omit<MissionOptions, 'ceilings'> & { ceilings: Record<Ceiling, string> }
const toDraft = (o: MissionOptions): Draft => ({
  ...o,
  ceilings: { max_turns: String(o.ceilings.max_turns ?? ''), max_rounds: String(o.ceilings.max_rounds ?? ''), usd_informative: String(o.ceilings.usd_informative ?? '') },
})
// Campo vazio é "sem teto"; o servidor recusa o que não for número válido.
const num = (v: string) => (v.trim() === '' ? null : Number(v))
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Página Opções do projeto ativo: valem para o próximo pedido e ficam fixadas na missão ao aprovar o plano. */
export default function OptionsPage({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/options`
  const [draft, setDraft] = useState<Draft | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    apiFetch<MissionOptions>(base).then((o) => setDraft(toDraft(o)), (err) => setStatus({ ok: false, text: messageOf(err) }))
  }, [base])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!draft) return
    setStatus(null)
    try {
      const { ceilings } = draft
      const saved = await postJson<MissionOptions>(base, {
        ...draft,
        ceilings: { max_turns: num(ceilings.max_turns), max_rounds: num(ceilings.max_rounds), usd_informative: num(ceilings.usd_informative) },
      })
      setDraft(toDraft(saved))
      setStatus({ ok: true, text: 'Opções salvas.' })
    } catch (err) {
      setStatus({ ok: false, text: messageOf(err) })
    }
  }

  if (!draft) return status ? <Card role="alert"><Text color="red">{status.text}</Text></Card> : <Text color="gray">Lendo as opções…</Text>
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })

  return (
    <Flex direction="column" gap="4">
      <Heading as="h1" size="7">Opções</Heading>
      <Text color="gray">Como a ADE trabalha neste projeto. Valem para o próximo pedido; ao aprovar um plano, ficam fixadas naquela missão.</Text>
      <form className="request-form" aria-label="Opções da missão" onSubmit={save}>
        <Card asChild>
          <section aria-label="Autonomia">
            <Heading as="h2" size="4" mb="2">Autonomia</Heading>
            <Text as="p" size="2" color="gray" mb="2">O que ela faz sozinha durante a execução. Briefing e plano sempre esperam a sua aprovação.</Text>
            <RadioGroup.Root value={draft.autonomy} onValueChange={(v) => set({ autonomy: v as Autonomy })} aria-label="Autonomia">
              {AUTONOMY.map(([level, note]) => (
                <RadioGroup.Item key={level} value={level}><span className="mono">{level}</span> — {note}</RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </section>
        </Card>

        <Card asChild>
          <section aria-label="Tetos">
            <Heading as="h2" size="4" mb="2">Tetos</Heading>
            <Flex direction="column" gap="3">
              {CEILINGS.map(([key, label, note]) => (
                <label key={key} className="field">
                  <Text size="2" weight="bold">{label}</Text>
                  <TextField.Root
                    type="number"
                    min={key === 'usd_informative' ? 0 : 1}
                    step={key === 'usd_informative' ? 'any' : 1}
                    className="num-field"
                    placeholder="sem teto"
                    aria-label={label}
                    value={draft.ceilings[key]}
                    onChange={(e) => set({ ceilings: { ...draft.ceilings, [key]: e.target.value } })}
                  />
                  <Text size="1" color="gray">{note}</Text>
                </label>
              ))}
            </Flex>
          </section>
        </Card>

        <Card asChild>
          <section aria-label="Etapas">
            <Heading as="h2" size="4" mb="2">Etapas</Heading>
            <Flex direction="column" gap="3">
              {FLAGS.map(([key, label, note]) => (
                <Text as="label" key={key} size="2">
                  <Flex gap="3" align="start">
                    <Switch aria-label={label} checked={draft[key]} onCheckedChange={(v) => set({ [key]: v })} />
                    <span><b>{label}</b><br /><Text size="1" color="gray">{note}</Text></span>
                  </Flex>
                </Text>
              ))}
            </Flex>
          </section>
        </Card>

        <Flex gap="3" align="center" wrap="wrap">
          <Button type="submit">Salvar opções</Button>
          {status && <Text role="status" color={status.ok ? 'green' : 'red'}>{status.text}</Text>}
        </Flex>
      </form>
    </Flex>
  )
}
