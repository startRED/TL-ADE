import { useEffect, useRef, useState } from 'react'
import { Badge, Box, Button, Callout, Code, Flex, Heading, ScrollArea, Separator, Tabs, Text, TextField, Card } from '@radix-ui/themes'
import { Play, CheckCircle, Warning, ArrowCounterClockwise, Trash, Robot, Flask, GitDiff, ChatCircleText, Terminal, HourglassMedium } from '@phosphor-icons/react'

const STEP_LABEL = { prepare: '1. Conferir o projeto', test: '2. Escrever a prova', red: '3. Prova falha no código antigo', fix: '4. Corrigir o código', tests: '5. Prova passa no código novo', checker: '6. Segunda IA revisa' }
const STEP_HELP = {
  prepare: 'Roda o que o projeto já tem de verificação, para saber o ponto de partida.',
  test: 'Uma "prova" é um mini-programa que checa se o que você pediu funciona. Ex.: "clica em Entrar duas vezes e confere se o botão travou". A IA escreve só isso, sem mexer no código ainda.',
  red: 'A ADE roda a prova ANTES de qualquer correção. Ela tem de falhar, porque o que você pediu ainda não existe. Se passasse agora, a prova estaria checando a coisa errada.',
  fix: 'Só agora a IA muda o código, o mínimo necessário.',
  tests: 'Roda a prova de novo. Agora tem de passar. Falhou antes e passou depois: é isso que garante que a mudança funciona de verdade, e não só "parece" que funciona.',
  checker: 'Uma segunda IA, de outra empresa (Codex), lê a mudança e aprova ou aponta problemas. Quem escreve nunca é quem aprova.',
}
const STATE_LABEL = { running: 'Em andamento', awaiting_operator: 'Aguardando você', complete: 'Pronta', discarded: 'Descartada' }
const REASON_LABEL = {
  tests_red: 'Algum teste ficou vermelho.',
  no_new_test: 'A IA não escreveu um teste novo que prove a correção.',
  no_red_test: 'A prova que a IA escreveu já passava no código antigo (ou ela não escreveu prova nenhuma). Então ela não serve para provar a mudança. Veja a aba Testes.',
  review_changes: 'O revisor (Codex) pediu mudanças.',
  no_changes: 'A IA não alterou nenhum arquivo.',
  engine_error: 'O engine falhou. Veja o log.',
  accepted_by_operator: 'Aceita por você.',
}

export default function App() {
  const [state, setState] = useState({ mission: null, log: [], live: null })
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
        <Card size="2" className="pane" style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <Heading size="2" color="gray" mb="3">Missão</Heading>
          {!m ? (
            <Flex direction="column" gap="3">
              <Text size="2" color="gray">Nenhuma missão ainda. Escreva um pedido acima e clique em Rodar. Toda missão passa por estes 6 passos:</Text>
              {['prepare', 'test', 'red', 'fix', 'tests', 'checker'].map((name) => <StepRow key={name} label={STEP_LABEL[name]} step={null} help={STEP_HELP[name]} />)}
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">{m.request}</Text>
              <Text size="1" color="gray">A missão passa por 6 passos. O ponto aceso é onde ela está agora.</Text>
              <Flex gap="2" align="center">
                <StateBadge state={m.state} />
                <Text size="1" color="gray">rodada {m.round || 1}</Text>
              </Flex>
              <Flex gap="1" style={{ height: 5 }}>
                {['prepare', 'test', 'red', 'fix', 'tests', 'checker'].map((name) => {
                  const st = m.steps.find((x) => x.name === name)?.status || 'pending'
                  const bg = { pending: 'var(--gray-a4)', running: 'var(--teal-9)', done: 'var(--green-9)', failed: 'var(--amber-9)', skipped: 'var(--gray-a6)' }[st]
                  return <Box key={name} style={{ flex: 1, borderRadius: 2, background: bg, opacity: st === 'running' ? 0.9 : 1 }} />
                })}
              </Flex>
              <Separator size="4" />
              <Flex direction="column" gap="3">
                {['prepare', 'test', 'red', 'fix', 'tests', 'checker'].map((name) => {
                  const s = m.steps.find((x) => x.name === name)
                  return <StepRow key={name} label={STEP_LABEL[name]} step={s} help={STEP_HELP[name]} />
                })}
              </Flex>
              <Separator size="4" />
              <Flex direction="column" gap="1">
                <KV k="Chamadas" v={m.cost.calls} />
                <KV k="Turnos do Claude" v={m.cost.turns} />
                <KV k="Tokens" v={`${(m.cost.tokens_in / 1000).toFixed(1)}k novos · ${((m.cost.cache_read || 0) / 1000).toFixed(0)}k cache · ${(m.cost.tokens_out / 1000).toFixed(1)}k saída`} />
                <KV k="Custo Claude" v={`US$ ${m.cost.usd.toFixed(3)}`} />
                <KV k="Custo Codex" v="não reportado" />
              </Flex>
            </Flex>
          )}
          {state.history?.length > 1 && (
            <Box mt="4">
              <Text size="1" color="gray">Missões anteriores neste projeto</Text>
              {state.history.filter((h) => h.id !== m?.id).map((h) => (
                <Flex key={h.id} justify="between" gap="2" mt="1"><Text size="1" truncate style={{ maxWidth: 200 }}>{h.request}</Text><StateBadge state={h.state} /></Flex>
              ))}
            </Box>
          )}
        </Card>

        <Card size="2" className="pane" style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Tabs.Root value={tab} onValueChange={setTab} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <Tabs.List>
              <Tabs.Trigger value="activity"><Terminal /> Atividade</Tabs.Trigger>
              <Tabs.Trigger value="diff"><GitDiff /> Alterações {m?.diff ? <Badge ml="1" size="1" variant="soft">{m.diff.split('\n').filter((l) => /^diff --git/.test(l)).length}</Badge> : null}</Tabs.Trigger>
              <Tabs.Trigger value="tests"><Flask /> Provas {m?.tests_after ? <Badge ml="1" size="1" variant="soft" color={m.tests_after.ok ? 'green' : 'red'}>{m.tests_after.total - m.tests_after.failed}/{m.tests_after.total}</Badge> : null}</Tabs.Trigger>
              <Tabs.Trigger value="review"><ChatCircleText /> Revisão</Tabs.Trigger>
            </Tabs.List>
            <Box pt="3" style={{ flex: 1, minHeight: 0 }}>
              <ScrollArea style={{ height: '100%' }}>
                {tab === 'activity' && <Activity log={state.log} running={running} live={state.live} />}
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
              {m.state === 'complete' && <Callout.Root color="green"><Callout.Icon><CheckCircle /></Callout.Icon><Callout.Text>{m.reason === 'accepted_by_operator' ? 'Aceita por você. ' : 'O teste novo falhou antes e passou depois; o Codex aprovou. '}As alterações estão em <Code>proto/example</Code>.</Callout.Text></Callout.Root>}
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

function StepRow({ label, step, help }) {
  const status = step?.status || 'pending'
  const [, tick] = useState(0)
  useEffect(() => { if (status !== 'running') return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [status])
  const color = { pending: 'var(--gray-7)', running: 'var(--teal-9)', done: 'var(--green-9)', failed: 'var(--amber-9)', skipped: 'var(--gray-7)' }[status]
  const secs = step?.started_at ? Math.max(0, Math.round(((step.finished_at ? new Date(step.finished_at) : new Date()) - new Date(step.started_at)) / 1000)) : null
  const text = { pending: 'na fila', running: `${secs ?? 0} s`, done: `ok · ${secs ?? 0} s`, failed: 'parou aqui', skipped: 'pulado' }[status]
  return (
    <Box>
      <Flex align="center" gap="2">
        <Box style={{ width: 8, height: 8, borderRadius: 4, background: color, boxShadow: status === 'running' ? `0 0 8px ${color}` : 'none', flexShrink: 0 }} />
        <Text size="2" weight={status === 'running' || status === 'failed' ? 'medium' : 'regular'} style={{ flex: 1 }} color={status === 'pending' ? 'gray' : undefined}>{label}</Text>
        <Text size="1" color={status === 'failed' ? 'amber' : 'gray'}>{text}</Text>
      </Flex>
      <Text size="1" color="gray" as="p" style={{ marginLeft: 16, lineHeight: 1.4 }}>{help}</Text>
    </Box>
  )
}

function KV({ k, v }) {
  return <Flex justify="between" gap="3"><Text size="1" color="gray">{k}</Text><Text size="1">{v}</Text></Flex>
}

function Activity({ log, running, live }) {
  const end = useRef(null)
  const [showThinking, setShowThinking] = useState(true)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [log.length, live?.text?.length])
  if (!log.length) return <Text size="2" color="gray">O que a IA faz aparece aqui, linha a linha: pensamento, ferramentas, resultado.</Text>
  const color = { engine: 'gray', claude: 'teal', codex: 'violet', operador: 'amber' }
  const rows = showThinking ? log : log.filter((l) => l.kind !== 'thinking')
  return (
    <Box>
      <Flex justify="end" mb="2"><Button size="1" variant="ghost" color="gray" onClick={() => setShowThinking((v) => !v)}>{showThinking ? 'Esconder pensamento' : 'Mostrar pensamento'}</Button></Flex>
      {rows.map((l, i) => (
        <div className={`log-line kind-${l.kind}`} key={i}>
          <time>{l.ts.slice(11, 19)}</time>
          <Badge size="1" variant="soft" color={l.kind === 'error' ? 'red' : color[l.source] || 'gray'} style={{ justifySelf: 'start' }}>{l.kind === 'thinking' ? 'pensando' : l.kind === 'tool' ? 'ferramenta' : l.kind === 'result' ? 'resultado' : l.source}</Badge>
          <Text size="1" className="log-text">{l.text}</Text>
        </div>
      ))}
      {running && (
        <div className={`log-line live kind-${live?.kind || 'text'}`}>
          <time>agora</time>
          <Badge size="1" variant="solid" color={live?.source === 'codex' ? 'violet' : 'teal'} style={{ justifySelf: 'start' }}>{live ? (live.kind === 'thinking' ? 'pensando' : live.kind === 'tool' ? 'ferramenta' : 'escrevendo') : 'trabalhando'}</Badge>
          <Text size="1" className="log-text">{live?.text || '…'}<span className="cursor" /></Text>
        </div>
      )}
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
  const explain = <Callout.Root color="gray" variant="surface" mb="3"><Callout.Text><b>Como a ADE prova que a mudança funciona:</b> a IA escreve primeiro um teste novo. Esse teste tem de <b>falhar</b> no código antigo (prova que ele pega o problema) e <b>passar</b> depois da correção (prova que a correção resolve). Sem esse antes/depois, um teste verde não diz nada.</Callout.Text></Callout.Root>
  if (!m?.tests_after) return <Box>{explain}<Text size="2" color="gray">{m?.tests_before ? `Ponto de partida: ${m.tests_before.total} testes, ${m.tests_before.failed} falhando. Esperando a IA terminar.` : 'Os testes rodam antes e depois da alteração.'}</Text></Box>
  const before = new Map(m.tests_before.tests.map((t) => [t.name, t.status]))
  return (
    <Box>
      {explain}
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
