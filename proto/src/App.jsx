import { useEffect, useRef, useState } from 'react'
import { Badge, Box, Button, Callout, Code, Flex, Heading, ScrollArea, Separator, Tabs, Text, TextField, Card } from '@radix-ui/themes'
import { Play, CheckCircle, Warning, ArrowCounterClockwise, Trash, Robot, Flask, GitDiff, ChatCircleText, Terminal, HourglassMedium } from '@phosphor-icons/react'

const STEP_LABEL = { prepare: 'Preparar', maker: 'Claude escreve', tests: 'Testes', checker: 'Codex revisa' }
const STATE_LABEL = { running: 'Em andamento', awaiting_operator: 'Aguardando você', complete: 'Pronta', discarded: 'Descartada' }
const REASON_LABEL = {
  tests_red: 'Algum teste ficou vermelho.',
  no_new_test: 'A IA não escreveu um teste novo que prove a correção.',
  review_changes: 'O revisor (Codex) pediu mudanças.',
  no_changes: 'A IA não alterou nenhum arquivo.',
  engine_error: 'O engine falhou. Veja o log.',
  accepted_by_operator: 'Aceita por você.',
}

export default function App() {
  const [state, setState] = useState({ mission: null, log: [] })
  const [request, setRequest] = useState('O botão Entrar tem de ficar desabilitado enquanto o envio está em curso, para evitar duplo clique.')
  const [tab, setTab] = useState('activity')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => setState(JSON.parse(e.data))
    return () => es.close()
  }, [])

  const m = state.mission
  const running = m?.state === 'running'

  async function run(e) {
    e.preventDefault()
    if (!request.trim() || running) return
    setTab('activity')
    await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) })
  }
  const decide = (option) => fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option }) })

  return (
    <Flex direction="column" gap="3" p="3" style={{ height: '100%', maxWidth: 1600, margin: '0 auto' }}>
      <Card size="2">
        <Flex align="center" gap="4" wrap="wrap">
          <Flex align="center" gap="2" style={{ minWidth: 120 }}>
            <Box style={{ width: 22, height: 22, borderRadius: 6, background: 'linear-gradient(135deg, var(--teal-9), var(--teal-11))' }} />
            <Heading size="3">TL-ADE</Heading>
            <Text size="1" color="gray">protótipo</Text>
          </Flex>
          <form onSubmit={run} style={{ flex: 1, minWidth: 320 }}>
            <Flex gap="2">
              <TextField.Root size="3" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="O que você quer que seja feito no projeto de exemplo?" style={{ flex: 1 }} disabled={running}>
                <TextField.Slot><Code size="1" variant="ghost" color="gray">ade run</Code></TextField.Slot>
              </TextField.Root>
              <Button size="3" type="submit" disabled={running || !request.trim()}>
                {running ? <HourglassMedium /> : <Play weight="fill" />} {running ? 'Rodando' : 'Rodar'}
              </Button>
            </Flex>
          </form>
          <Flex gap="2" align="center">
            <Badge color={connected ? 'green' : 'red'} variant="soft">{connected ? 'servidor ligado' : 'sem servidor'}</Badge>
            <Badge variant="soft" color="gray">alvo: example/</Badge>
            <Badge variant="soft" color="gray">Claude · Codex</Badge>
          </Flex>
        </Flex>
      </Card>

      <Flex gap="3" style={{ flex: 1, minHeight: 0 }} wrap={{ initial: 'wrap', md: 'nowrap' }}>
        <Card size="2" className="pane" style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          <Heading size="2" color="gray" mb="3">Missão</Heading>
          {!m ? (
            <Flex direction="column" gap="2" align="center" justify="center" style={{ flex: 1, textAlign: 'center' }}>
              <Robot size={36} color="var(--gray-8)" />
              <Text size="2" color="gray">Nenhuma missão ainda. Escreva um pedido acima e clique em Rodar.</Text>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">{m.request}</Text>
              <Flex gap="2" align="center">
                <StateBadge state={m.state} />
                <Text size="1" color="gray">rodada {m.round || 1}</Text>
              </Flex>
              <Separator size="4" />
              <Flex direction="column" gap="2">
                {['prepare', 'maker', 'tests', 'checker'].map((name) => {
                  const s = m.steps.find((x) => x.name === name)
                  return <StepRow key={name} label={STEP_LABEL[name]} status={s?.status || 'pending'} />
                })}
              </Flex>
              <Separator size="4" />
              <Flex direction="column" gap="1">
                <KV k="Chamadas" v={m.cost.calls} />
                <KV k="Turnos do Claude" v={m.cost.turns} />
                <KV k="Tokens" v={`${(m.cost.tokens_in / 1000).toFixed(1)}k entrada · ${(m.cost.tokens_out / 1000).toFixed(1)}k saída`} />
                <KV k="Custo Claude" v={`US$ ${m.cost.usd.toFixed(3)}`} />
                <KV k="Custo Codex" v="não reportado" />
              </Flex>
            </Flex>
          )}
        </Card>

        <Card size="2" className="pane" style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Tabs.Root value={tab} onValueChange={setTab} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <Tabs.List>
              <Tabs.Trigger value="activity"><Terminal /> Atividade</Tabs.Trigger>
              <Tabs.Trigger value="diff"><GitDiff /> Alterações {m?.diff ? <Badge ml="1" size="1" variant="soft">{m.diff.split('\n').filter((l) => /^diff --git/.test(l)).length}</Badge> : null}</Tabs.Trigger>
              <Tabs.Trigger value="tests"><Flask /> Testes {m?.tests_after ? <Badge ml="1" size="1" variant="soft" color={m.tests_after.ok ? 'green' : 'red'}>{m.tests_after.total - m.tests_after.failed}/{m.tests_after.total}</Badge> : null}</Tabs.Trigger>
              <Tabs.Trigger value="review"><ChatCircleText /> Revisão</Tabs.Trigger>
            </Tabs.List>
            <Box pt="3" style={{ flex: 1, minHeight: 0 }}>
              <ScrollArea style={{ height: '100%' }}>
                {tab === 'activity' && <Activity log={state.log} running={running} />}
                {tab === 'diff' && <Diff diff={m?.diff} />}
                {tab === 'tests' && <Tests m={m} />}
                {tab === 'review' && <Review review={m?.review} />}
              </ScrollArea>
            </Box>
          </Tabs.Root>
        </Card>

        <Card size="2" className="pane" style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          <Heading size="2" color="gray" mb="3">Relatório</Heading>
          {!m ? <Text size="2" color="gray">Aparece aqui quando a missão começar.</Text> : (
            <Flex direction="column" gap="3">
              {m.state === 'running' && <Callout.Root color="teal"><Callout.Icon><HourglassMedium /></Callout.Icon><Callout.Text>Trabalhando. Nada para você fazer agora.</Callout.Text></Callout.Root>}
              {m.state === 'complete' && <Callout.Root color="green"><Callout.Icon><CheckCircle /></Callout.Icon><Callout.Text>{m.reason === 'accepted_by_operator' ? 'Aceita por você. ' : 'Testes verdes, teste novo presente e revisor de outra família aprovou. '}As alterações estão em <Code>proto/example</Code>.</Callout.Text></Callout.Root>}
              {m.state === 'discarded' && <Callout.Root color="gray"><Callout.Text>Descartada. Os arquivos voltaram ao estado original.</Callout.Text></Callout.Root>}
              {m.state === 'awaiting_operator' && (
                <>
                  <Callout.Root color="amber"><Callout.Icon><Warning /></Callout.Icon><Callout.Text>{REASON_LABEL[m.reason] || m.reason} Decida abaixo.</Callout.Text></Callout.Root>
                  <Flex direction="column" gap="2">
                    <Button size="3" onClick={() => decide('accept')}><CheckCircle /> Aceitar como está</Button>
                    <Button size="3" variant="soft" onClick={() => decide('retry')}><ArrowCounterClockwise /> Mais uma rodada com os achados</Button>
                    <Button size="3" variant="soft" color="red" onClick={() => decide('discard')}><Trash /> Descartar tudo</Button>
                  </Flex>
                </>
              )}
              {m.review && (
                <Box>
                  <Text size="1" color="gray">Resumo do revisor</Text>
                  <Text as="p" size="2">{m.review.summary}</Text>
                </Box>
              )}
              {m.new_tests?.length > 0 && (
                <Box>
                  <Text size="1" color="gray">Teste novo que prova a correção</Text>
                  {m.new_tests.map((t) => <Text as="p" size="2" key={t}>{t}</Text>)}
                </Box>
              )}
            </Flex>
          )}
        </Card>
      </Flex>
    </Flex>
  )
}

function StateBadge({ state }) {
  const color = { running: 'teal', awaiting_operator: 'amber', complete: 'green', discarded: 'gray' }[state]
  return <Badge color={color} variant="solid">{STATE_LABEL[state] || state}</Badge>
}

function StepRow({ label, status }) {
  const color = { pending: 'var(--gray-7)', running: 'var(--teal-9)', done: 'var(--green-9)', failed: 'var(--amber-9)', skipped: 'var(--gray-7)' }[status]
  const text = { pending: 'na fila', running: 'agora', done: 'ok', failed: 'atenção', skipped: 'pulado' }[status]
  return (
    <Flex align="center" gap="2">
      <Box style={{ width: 8, height: 8, borderRadius: 4, background: color, boxShadow: status === 'running' ? `0 0 8px ${color}` : 'none' }} />
      <Text size="2" style={{ flex: 1 }} color={status === 'pending' ? 'gray' : undefined}>{label}</Text>
      <Text size="1" color="gray">{text}</Text>
    </Flex>
  )
}

function KV({ k, v }) {
  return <Flex justify="between" gap="3"><Text size="1" color="gray">{k}</Text><Text size="1">{v}</Text></Flex>
}

function Activity({ log, running }) {
  const end = useRef(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [log.length])
  if (!log.length) return <Text size="2" color="gray">O que a IA faz aparece aqui, linha a linha.</Text>
  const color = { engine: 'gray', claude: 'teal', codex: 'violet', operador: 'amber' }
  return (
    <Box>
      {log.map((l, i) => (
        <div className="log-line" key={i}>
          <time>{l.ts.slice(11, 19)}</time>
          <Badge size="1" variant="soft" color={l.kind === 'error' ? 'red' : color[l.source] || 'gray'} style={{ justifySelf: 'start' }}>{l.source}</Badge>
          <Text size="1" style={{ whiteSpace: 'pre-wrap', color: l.kind === 'tool' ? 'var(--gray-11)' : undefined }}>{l.text}</Text>
        </div>
      ))}
      {running && <Text size="1" color="gray" mt="2" as="p">…</Text>}
      <div ref={end} />
    </Box>
  )
}

function Diff({ diff }) {
  if (!diff) return <Text size="2" color="gray">Sem alterações ainda.</Text>
  return (
    <Box style={{ fontFamily: 'var(--code-font-family)', fontSize: 12, lineHeight: 1.55, background: 'var(--gray-a2)', borderRadius: 6, padding: '8px 0', overflowX: 'auto' }}>
      {diff.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff') || l.startsWith('index') || l.startsWith('@@') ? 'diff-hdr' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : 'diff-ctx'
        return <span className={`diff-line ${cls}`} key={i}>{l || ' '}</span>
      })}
    </Box>
  )
}

function Tests({ m }) {
  if (!m?.tests_after) return <Text size="2" color="gray">{m?.tests_before ? `Linha de base: ${m.tests_before.total} testes, ${m.tests_before.failed} vermelhos. Esperando a IA terminar.` : 'Os testes rodam antes e depois da alteração.'}</Text>
  const before = new Map(m.tests_before.tests.map((t) => [t.name, t.status]))
  return (
    <Box>
      {m.tests_after.error && <Callout.Root color="red" mb="3"><Callout.Text><Code>{m.tests_after.error}</Code></Callout.Text></Callout.Root>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Teste', 'Antes', 'Depois'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--gray-a5)' }}><Text size="1" color="gray">{h}</Text></th>)}</tr></thead>
        <tbody>
          {m.tests_after.tests.map((t) => {
            const b = before.get(t.name)
            return (
              <tr key={t.name}>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--gray-a3)' }}><Text size="2">{t.name}</Text>{!b && <Badge ml="2" size="1" color="teal" variant="soft">novo</Badge>}{t.message && <Text as="p" size="1" color="red">{t.message}</Text>}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--gray-a3)' }}><Result s={b} /></td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--gray-a3)' }}><Result s={t.status} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Text size="1" color="gray" as="p" mt="3">Um teste novo que já nasce verde não prova nada: a regra do projeto é vermelho antes, verde depois. Este protótipo ainda não mede o "vermelho antes"; o slice 1 mede.</Text>
    </Box>
  )
}

function Result({ s }) {
  if (!s) return <Text size="2" color="gray">não existia</Text>
  return <Badge variant="soft" color={s === 'passed' ? 'green' : 'red'}>{s === 'passed' ? 'verde' : 'vermelho'}</Badge>
}

function Review({ review }) {
  if (!review) return <Text size="2" color="gray">A revisão pelo Codex roda depois dos testes.</Text>
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2"><Badge color={review.verdict === 'approve' ? 'green' : 'amber'} variant="solid">{review.verdict === 'approve' ? 'Aprovado' : 'Pediu mudanças'}</Badge><Text size="1" color="gray">Codex, sandbox somente leitura</Text></Flex>
      <Text size="2">{review.summary}</Text>
      {review.findings.length === 0 ? <Text size="2" color="gray">Nenhum achado.</Text> : review.findings.map((f, i) => (
        <Card key={i} variant="surface">
          <Flex gap="2" align="center" mb="1"><Badge size="1" color={{ high: 'red', medium: 'amber', low: 'gray' }[f.severity]} variant="soft">{f.severity}</Badge><Code size="1">{f.file}</Code></Flex>
          <Text as="p" size="2">{f.problem}</Text>
          <Text as="p" size="1" color="gray">Correção: {f.fix}</Text>
        </Card>
      ))}
    </Flex>
  )
}
