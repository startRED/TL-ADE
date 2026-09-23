import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Badge, Box, Button, Card, Flex, Heading, RadioGroup, Text, TextArea, TextField } from '@radix-ui/themes'
import { CheckCircle, PaperPlaneRight, Play, XCircle } from '@phosphor-icons/react'
import { apiFetch, postJson } from './api.ts'

interface Question {
  id: string
  text: string
  options: Array<{ id: string; label: string; why?: string }>
}

interface Decision {
  question_id?: string
  value: string
  origin: 'usuario' | 'ia_supondo' | 'padrao'
}

interface Briefing {
  goal: string
  in_scope: string[]
  out_of_scope: string[]
  done_means: string[]
  versions: Array<{ name: string; goal: string }>
}

interface Intake {
  mission_id: string
  stage: 'interview' | 'briefing' | 'plan' | 'running' | 'concluida' | 'recusada'
  rejected_at?: 'briefing' | 'plan'
  reason?: string
  error?: string
  questions?: Question[]
  decisions?: Decision[]
  briefing?: Briefing
  parts?: Array<{ id: string; title?: string; task?: string; criteria: string[] }>
  digest?: string
}

const ORIGIN_PT: Record<Decision['origin'], string> = { usuario: 'você escolheu', ia_supondo: 'IA supondo', padrao: 'padrão' }
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Caminho do pedido no projeto ativo: caixa de pedido, entrevista, briefing, plano e execução. */
export default function IntakeFlow({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`
  const [intake, setIntake] = useState<Intake | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIntake(await apiFetch<Intake | null>(`${base}/intake?if_missing=null`))
  }, [base])

  useEffect(() => {
    setIntake(undefined)
    load().catch((err) => setError(messageOf(err)))
  }, [load])

  async function act(path: string, body: unknown) {
    setBusy(true)
    setError(null)
    try {
      await postJson(`${base}${path}`, body)
      await load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const alert = error && <Card className="warn" role="alert"><Text color="red">{error}</Text></Card>
  if (intake === undefined) return <>{alert}<Text color="gray">Lendo o pedido…</Text></>

  let view: ReactNode
  if (!intake || intake.stage === 'recusada' || intake.stage === 'concluida') {
    view = <RequestBox last={intake} busy={busy} onSend={(text) => act('/requests', { text })} />
  } else if (intake.stage === 'interview') {
    view = <InterviewView questions={intake.questions ?? []} busy={busy} onAnswer={(answers) => act('/intake/interview', { answers })} />
  } else if (intake.stage === 'briefing' && intake.briefing) {
    view = (
      <Section title="Briefing" note="Confira o que entra e o que fica fora antes de a IA montar o plano.">
        <BriefingView b={intake.briefing} />
        <Decisions intake={intake} />
        <Verdict what="briefing" busy={busy} onApprove={() => act('/intake/briefing/approve', { digest: intake.digest })} onReject={(reason) => act('/intake/briefing/reject', { reason })} />
      </Section>
    )
  } else if (intake.stage === 'plan') {
    view = (
      <Section title="Plano" note="Cada parte e os critérios que a prova dela vai cobrar.">
        <Flex direction="column" gap="2">
          {(intake.parts ?? []).map((p) => (
            <Card key={p.id}>
              <Text as="p" weight="bold"><span className="mono">{p.id}</span> {p.title ?? p.task}</Text>
              <ul className="list">{p.criteria.map((c) => <li key={c}>{c}</li>)}</ul>
            </Card>
          ))}
        </Flex>
        <Decisions intake={intake} />
        <Verdict what="plano" busy={busy} onApprove={() => act('/intake/plan/approve', { digest: intake.digest })} onReject={(reason) => act('/intake/plan/reject', { reason })} />
      </Section>
    )
  } else {
    view = (
      <Section title="Missão em execução" note="O plano foi aprovado e a ADE está executando as partes.">
        <Text className="mono">{intake.mission_id}</Text>
      </Section>
    )
  }
  return <>{alert}{view}</>
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="5">{title}</Heading>
      <Text color="gray">{note}</Text>
      {children}
    </Flex>
  )
}

function RequestBox({ last, busy, onSend }: { last: Intake | null; busy: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    onSend(text)
  }
  const what = last?.rejected_at === 'plan' ? 'O plano' : 'O briefing'
  return (
    <Card>
      <form className="request-form" onSubmit={submit}>
        {last?.stage === 'recusada' && <Text as="p" color="amber">{what} foi recusado: {last.reason}</Text>}
        {last?.stage === 'concluida' && (
          <Text as="p" color={last.error ? 'red' : 'green'}>
            A missão {last.mission_id} terminou{last.error ? ` com erro: ${last.error}` : '.'}
          </Text>
        )}
        <TextArea aria-label="Pedido" value={text} onChange={(e) => setText(e.target.value)} placeholder="Descreva o que você quer construir ou mudar" rows={4} />
        <Flex justify="end">
          <Button type="submit" disabled={busy || !text.trim()}>
            <PaperPlaneRight aria-hidden="true" /> {busy ? 'Compilando o pedido…' : 'Enviar pedido'}
          </Button>
        </Flex>
      </form>
    </Card>
  )
}

function InterviewView({ questions, busy, onAnswer }: { questions: Question[]; busy: boolean; onAnswer: (answers: Record<string, string>) => void }) {
  // Só vai o que o usuário mudou: o resto adota a recomendação com origem 'padrão'.
  const [picked, setPicked] = useState<Record<string, string>>({})
  return (
    <Section title="Entrevista" note="A primeira opção é sempre a recomendada. Não sabe? Deixe como está.">
      {questions.map((q) => (
        <Card key={q.id}>
          <Text as="p" weight="bold" id={`q-${q.id}`}>{q.text}</Text>
          <RadioGroup.Root
            mt="2"
            aria-labelledby={`q-${q.id}`}
            value={picked[q.id] ?? q.options[0]?.id}
            onValueChange={(value) => setPicked({ ...picked, [q.id]: value })}
          >
            {q.options.map((o, i) => (
              <RadioGroup.Item key={o.id} value={o.id}>
                {o.label} {i === 0 && <Badge color="green">recomendado</Badge>}
                {o.why && <Text size="1" color="gray"> {o.why}</Text>}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </Card>
      ))}
      <Flex gap="2" wrap="wrap">
        <Button disabled={busy} onClick={() => onAnswer(picked)}><CheckCircle aria-hidden="true" /> Responder</Button>
        <Button variant="soft" disabled={busy} onClick={() => onAnswer({})}><Play aria-hidden="true" /> Seguir com as recomendações</Button>
      </Flex>
    </Section>
  )
}

function BriefingView({ b }: { b: Briefing }) {
  const list = (title: string, items: string[]) => items.length > 0 && (
    <Box>
      <Text as="p" weight="bold">{title}</Text>
      <ul className="list">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </Box>
  )
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Text as="p" size="3">{b.goal}</Text>
        {list('O que entra', b.in_scope)}
        {list('O que fica fora', b.out_of_scope)}
        {list('O que é pronto', b.done_means)}
        <Box>
          <Text as="p" weight="bold">{b.versions.length > 1 ? `Versões (${b.versions.length}, uma depois da outra)` : 'Versão'}</Text>
          <ul className="list">{b.versions.map((v) => <li key={v.name}><span className="mono">{v.name}</span> · {v.goal}</li>)}</ul>
        </Box>
      </Flex>
    </Card>
  )
}

function Decisions({ intake }: { intake: Intake }) {
  const decisions = intake.decisions ?? []
  if (decisions.length === 0) return null
  const questionOf = (id?: string) => intake.questions?.find((q) => q.id === id)
  return (
    <Card>
      <Text as="p" weight="bold">Decisões da entrevista</Text>
      <ul className="list">
        {decisions.map((d) => {
          const q = questionOf(d.question_id)
          return (
            <li key={d.question_id ?? d.value}>
              {q?.text ?? d.question_id}: {q?.options.find((o) => o.id === d.value)?.label ?? d.value}{' '}
              <Badge color={d.origin === 'usuario' ? 'indigo' : 'gray'}>{ORIGIN_PT[d.origin]}</Badge>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function Verdict({ what, busy, onApprove, onReject }: { what: string; busy: boolean; onApprove: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Button disabled={busy} onClick={onApprove}><CheckCircle weight="fill" aria-hidden="true" /> Aprovar {what}</Button>
        <Flex gap="2" wrap="wrap" align="center">
          <TextField.Root className="grow" aria-label="Motivo da recusa" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por que não serve?" />
          <Button color="red" variant="soft" disabled={busy || !reason.trim()} onClick={() => onReject(reason)}>
            <XCircle aria-hidden="true" /> Recusar {what}
          </Button>
        </Flex>
      </Flex>
    </Card>
  )
}
