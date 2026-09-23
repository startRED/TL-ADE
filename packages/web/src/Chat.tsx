import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Badge, Button, Flex, Heading, Text, TextArea, TextField } from './ui.tsx'
import { ChatCircleDots, PaperPlaneRight } from '@phosphor-icons/react'
import { apiFetch, postJson } from './api.ts'

type Kind = 'add' | 'del' | 'ctx'
interface Proposal {
  status: 'pendente' | 'aprovada' | 'recusada'
  summary: string
  files: Array<{ file: string; lines: Array<{ kind: Kind; text: string }> }>
  blocked_reason?: string
}
interface Turn { id: string; role: 'user' | 'assistant'; text: string; at: string; proposal?: Proposal }
interface ChatState { busy: boolean; turns: Turn[] }

const FAMILIES = ['claude', 'codex', 'agy'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const DIFF_SIGN = { add: '+', del: '-', ctx: ' ' } as const
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Conversa do projeto, na coluna da direita: cada pergunta roda o agente numa cópia; mudança vira cartão de permissão. */
export default function ChatPanel({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/chat`
  const [state, setState] = useState<ChatState>({ busy: false, turns: [] })
  const [text, setText] = useState('')
  const [family, setFamily] = useState<(typeof FAMILIES)[number]>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('medium')
  const [error, setError] = useState<string | null>(null)
  const turnsRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => setState(await apiFetch<ChatState>(base)), [base])

  useEffect(() => { load().catch((err) => setError(messageOf(err))) }, [load])

  // O turno roda no servidor depois do 202: relê até ele acabar.
  useEffect(() => {
    if (!state.busy) return
    const timer = setTimeout(() => { load().catch((err) => setError(messageOf(err))) }, 700)
    return () => clearTimeout(timer)
  }, [state, load])

  // Mensagem nova aparece no fim da conversa, que rola dentro da coluna.
  useEffect(() => {
    const el = turnsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.turns.length, state.busy])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(messageOf(err))
    }
    await load().catch((err) => setError(messageOf(err)))
  }

  const pending = state.turns.some((t) => t.proposal?.status === 'pendente')

  function submit(e: FormEvent) {
    e.preventDefault()
    act(async () => {
      // Modelo em branco: a CLI da empresa usa o padrão dela; o servidor recusa modelo que não é da empresa.
      await postJson(base, { text, family, effort, ...(model.trim() ? { model: model.trim() } : {}) })
      setText('')
    })
  }

  return (
    <aside className="rail" aria-label="Conversa">
      <Flex align="center" justify="between" gap="2">
        <Flex align="center" gap="2">
          <ChatCircleDots size={18} aria-hidden="true" />
          <Heading as="h2" size="4">Conversa</Heading>
        </Flex>
        <Button size="1" variant="ghost" color="gray" disabled={state.busy || state.turns.length === 0} onClick={() => act(() => postJson(`${base}/clear`, {}))}>
          Limpar conversa
        </Button>
      </Flex>
      <Text size="2" color="gray">O agente trabalha numa cópia do projeto; o que ele mudar só entra no projeto se você aprovar.</Text>

      <div className="rail-turns" ref={turnsRef}>
        {state.turns.length === 0 && !state.busy && <Text size="2" color="gray" className="rail-empty">Pergunte sobre o código ou peça uma mudança pequena.</Text>}
        {state.turns.map((t) => (
          <div key={t.id} className={`chat-turn ${t.role}`}>
            <Text as="p" size="1" color="gray">{t.role === 'user' ? 'Você' : 'Agente'}</Text>
            <Text as="p" size="2" className="chat-text">{t.text}</Text>
            {t.proposal && <PermissionCard proposal={t.proposal} onDecide={(action) => act(() => postJson(`${base}/${action}`, { id: t.id }))} />}
          </div>
        ))}
        {state.busy && <Text size="2" color="gray" role="status">O agente está respondendo…</Text>}
      </div>
      {error && <Text size="2" color="red" role="alert">{error}</Text>}

      <form className="composer" onSubmit={submit}>
        <TextArea variant="soft" aria-label="Pergunta ao chat" value={text} onChange={(e) => setText(e.target.value)} placeholder="Pergunte ou peça uma mudança pequena" />
        <Flex gap="2" align="center" wrap="wrap">
          <select className="sel" aria-label="Empresa" value={family} onChange={(e) => setFamily(e.target.value as typeof family)}>
            {FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <TextField.Root size="1" variant="soft" color="gray" className="model-field" aria-label="Modelo" placeholder="modelo (padrão)" value={model} onChange={(e) => setModel(e.target.value)} />
          <select className="sel" aria-label="Esforço" value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
            {EFFORTS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <Button type="submit" size="1" className="push" disabled={!text.trim() || state.busy || pending}>
            <PaperPlaneRight aria-hidden="true" /> Perguntar
          </Button>
        </Flex>
        {pending && <Text size="1" color="gray">Decida o cartão acima antes de perguntar de novo.</Text>}
      </form>
    </aside>
  )
}

function PermissionCard({ proposal, onDecide }: { proposal: Proposal; onDecide: (action: 'approve' | 'reject') => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  async function decide(action: 'approve' | 'reject') {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onDecide(action)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const count = proposal.files.length
  return (
    <section className="permission-card" aria-label="Proposta de alteração">
      <Text as="p" size="2" weight="bold">{proposal.summary}</Text>
      <Text as="p" size="1" color="gray">A IA quer mudar {count} {count === 1 ? 'arquivo' : 'arquivos'}.</Text>
      {proposal.files.map((f) => (
        <div key={f.file} className="diff">
          <Text as="p" size="1" weight="bold" className="mono">{f.file}</Text>
          <pre>
            {f.lines.map((l, i) => <div key={i} data-kind={l.kind} className={`diff-${l.kind}`}>{DIFF_SIGN[l.kind]}{l.text}</div>)}
          </pre>
        </div>
      ))}
      {proposal.status === 'pendente'
        ? (
          <Flex direction="column" gap="2">
            {proposal.blocked_reason && <Text as="p" size="2" color="orange">Aprovar travado: {proposal.blocked_reason}</Text>}
            <Flex gap="2">
              <Button size="1" disabled={Boolean(proposal.blocked_reason) || submitting} onClick={() => decide('approve')}>Aprovar</Button>
              <Button size="1" variant="soft" color="gray" disabled={submitting} onClick={() => decide('reject')}>Recusar</Button>
            </Flex>
          </Flex>
        )
        : <Badge color={proposal.status === 'aprovada' ? 'green' : 'gray'}>{proposal.status}</Badge>}
    </section>
  )
}
