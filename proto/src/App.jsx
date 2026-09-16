import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Code, Heading, ScrollArea, Text, TextField, Tooltip } from '@radix-ui/themes'
import {
  ArrowSquareOut, Play, CheckCircle, Warning, ArrowCounterClockwise, Trash, Flask, GitDiff, ChatCircleText, Terminal,
  FolderSimple, ClockCounterClockwise, GearSix, Pulse, Circle, CheckFat, X, Lightning,
} from '@phosphor-icons/react'

const PHASES = ['prepare', 'test', 'red', 'fix', 'tests', 'checker']
const STEP = {
  prepare: { title: 'Conferir o projeto', help: 'Roda o que o projeto já tem de verificação, para saber o ponto de partida.' },
  test: { title: 'Escrever a prova', help: 'Uma "prova" é um mini-programa que checa se o que você pediu funciona. Ex.: "clica em Entrar duas vezes e confere se o botão travou". A IA escreve só isso, sem mexer no código ainda.' },
  red: { title: 'Prova falha no código antigo', help: 'A ADE roda a prova ANTES de qualquer correção. Ela tem de falhar, porque o que você pediu ainda não existe. Se passasse agora, a prova estaria checando a coisa errada.' },
  fix: { title: 'Corrigir o código', help: 'Só agora a IA muda o código, o mínimo necessário.' },
  tests: { title: 'Prova passa no código novo', help: 'Roda a prova de novo. Agora tem de passar. Falhou antes e passou depois: é isso que garante que a mudança funciona de verdade.' },
  checker: { title: 'Segunda IA revisa', help: 'Uma segunda IA, de outra empresa (Codex), lê a mudança e aprova ou aponta problemas. Quem escreve nunca é quem aprova.' },
}
const STATE = {
  running: { label: 'Em andamento', color: 'teal' },
  awaiting_operator: { label: 'Precisa de você', color: 'amber' },
  complete: { label: 'Pronta', color: 'green' },
  discarded: { label: 'Descartada', color: 'gray' },
}
const REASON = {
  tests_red: 'Alguma prova ficou vermelha depois da correção.',
  no_red_test: 'A prova que a IA escreveu já passava no código antigo (ou ela não escreveu prova nenhuma). Então ela não serve para provar a mudança.',
  review_changes: 'A segunda IA (Codex) pediu mudanças.',
  no_changes: 'A IA não alterou nenhum arquivo.',
  engine_error: 'O motor falhou. Veja a atividade.',
  accepted_by_operator: 'Aceita por você.',
}
const SUGGESTIONS = [
  'O botão Entrar tem de ficar desabilitado enquanto o envio está em curso, para evitar duplo clique.',
  'Antes de enviar, avisar se o e-mail está em formato inválido, sem chamar o servidor.',
  'Quando o usuário volta a digitar, a mensagem de erro anterior tem de sumir.',
]

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export default function App() {
  const [state, setState] = useState({ project: null, mission: null, log: [], history: [], live: null, recent: [] })
  const [allowCommands, setAllowCommands] = useState(true)
  const [error, setError] = useState(null)
  const [request, setRequest] = useState('')
  const [tab, setTab] = useState('activity')
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState('mission')

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => setState(JSON.parse(e.data))
    return () => es.close()
  }, [])

  const m = state.mission
  const p = state.project
  const running = m?.state === 'running'

  async function run(text) {
    const req = (text ?? request).trim()
    if (!req || running) return
    setTab('activity'); setView('mission'); setError(null)
    const r = await post('/api/run', { request: req, model: 'sonnet', allow_commands: allowCommands })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || 'Não deu para começar.'); if (j.error?.includes('git')) setView('projects') }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="logo" /><span>TL-ADE</span><span className="dim">protótipo</span></div>
        <form className="cmd" onSubmit={(e) => { e.preventDefault(); run() }}>
          <TextField.Root size="2" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Descreva o que você quer que seja feito no projeto…" disabled={running}>
            <TextField.Slot><Lightning weight="fill" color="var(--teal-9)" /></TextField.Slot>
            <TextField.Slot>
              <Button size="1" type="submit" disabled={running || !request.trim()}>{running ? 'Rodando' : 'Rodar'}</Button>
            </TextField.Slot>
          </TextField.Root>
        </form>
        <div className="topright">{m && <MissionChip m={m} />}{p?.has_index && <a className="open-app" href="/api/app/" target="_blank" rel="noreferrer"><ArrowSquareOut /> Abrir o app</a>}</div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Seções">
          <RailButton icon={<Pulse />} label="Missão atual" active={view === 'mission'} onClick={() => setView('mission')} badge={m?.state === 'awaiting_operator'} />
          <RailButton icon={<ClockCounterClockwise />} label="Histórico" active={view === 'history'} onClick={() => setView('history')} />
          <RailButton icon={<FolderSimple />} label="Projetos" active={view === 'projects'} onClick={() => setView('projects')} />
          <span className="grow" />
          <RailButton icon={<GearSix />} label="Configurações" disabled />
        </nav>

        <aside className="side">
          <button className="side-head" onClick={() => setView('projects')} title={p?.dir || ''}>
            <FolderSimple size={16} color="var(--gray-10)" />
            <div>
              <Text size="2" weight="medium" as="p">{p?.name || 'Nenhuma pasta'}</Text>
              <Text size="1" color="gray" as="p">{p ? `${p.branch || 'sem git'} · ${p.runner === 'none' ? 'sem provas' : p.runner}` : 'escolha uma pasta'}</Text>
            </div>
            <span className="dim small" style={{ marginLeft: 'auto' }}>trocar</span>
          </button>
          {view === 'mission' && <Steps m={m} />}
          {view === 'history' && <History history={state.history} current={m} />}
          {view === 'projects' && <Projects p={p} recent={state.recent} running={running} onChanged={() => { setView('mission'); setError(null) }} />}
        </aside>

        <main className="main">
          {error && <div className="errbar"><Warning weight="fill" /> {error}</div>}
          {!m ? <Empty onPick={(s) => { setRequest(s); run(s) }} running={running} p={p} allowCommands={allowCommands} setAllowCommands={setAllowCommands} /> : (
            <>
              <div className="main-head">
                <Heading size="4" style={{ letterSpacing: '-0.01em' }}>{m.request}</Heading>
                <Text size="1" color="gray" as="p">{m.id} · rodada {m.round || 1} · começou às {m.started_at.slice(11, 16)}</Text>
              </div>
              <div className="tabs" role="tablist">
                <Tab active={tab === 'activity'} onClick={() => setTab('activity')} icon={<Terminal />}>Atividade</Tab>
                <Tab active={tab === 'diff'} onClick={() => setTab('diff')} icon={<GitDiff />} count={m.diff ? m.diff.split('\n').filter((l) => l.startsWith('diff --git')).length : null}>Alterações</Tab>
                <Tab active={tab === 'tests'} onClick={() => setTab('tests')} icon={<Flask />} count={m.tests_after ? `${m.tests_after.total - m.tests_after.failed}/${m.tests_after.total}` : null} tone={m.tests_after ? (m.tests_after.ok ? 'green' : 'red') : null}>Provas</Tab>
                <Tab active={tab === 'review'} onClick={() => setTab('review')} icon={<ChatCircleText />} count={m.review ? (m.review.verdict === 'approve' ? 'ok' : m.review.findings.length) : null} tone={m.review ? (m.review.verdict === 'approve' ? 'green' : 'amber') : null}>Revisão</Tab>
              </div>
              <ScrollArea className="main-body" scrollbars="vertical">
                {tab === 'activity' && <Console log={state.log} running={running} live={state.live} />}
                {tab === 'diff' && <Diff diff={m.diff} />}
                {tab === 'tests' && <Tests m={m} />}
                {tab === 'review' && <Review review={m.review} />}
              </ScrollArea>
            </>
          )}
        </main>

        <aside className="right">
          <Report m={m} decide={(o) => post('/api/decide', { option: o })} />
        </aside>
      </div>

      <footer className="status">
        <span className={connected ? 'ok' : 'bad'}>{connected ? '● servidor ligado' : '○ sem servidor'}</span>
        <span title={p?.dir}>{p ? p.dir : 'sem pasta'}</span>
        <span>Claude Sonnet escreve · Codex revisa</span>
        <span className="grow" />
        {m && <span>{m.cost.calls} chamadas · US$ {m.cost.usd.toFixed(3)} no Claude</span>}
      </footer>
    </div>
  )
}

/* ---------- topo ---------- */
function MissionChip({ m }) {
  const s = STATE[m.state] || { label: m.state, color: 'gray' }
  const [, tick] = useState(0)
  useEffect(() => { if (m.state !== 'running') return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [m.state])
  const secs = Math.max(0, Math.round(((m.finished_at ? new Date(m.finished_at) : new Date()) - new Date(m.started_at)) / 1000))
  return (
    <div className="chip">
      <Badge color={s.color} variant={m.state === 'awaiting_operator' ? 'solid' : 'soft'} size="2">{s.label}</Badge>
      <Text size="1" color="gray">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</Text>
    </div>
  )
}

function RailButton({ icon, label, active, onClick, badge, disabled }) {
  return (
    <Tooltip content={label} side="right">
      <button className={`rail-btn ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled} aria-label={label} aria-current={active ? 'page' : undefined}>
        {icon}{badge && <span className="rail-badge" />}
      </button>
    </Tooltip>
  )
}

function Tab({ active, onClick, icon, children, count, tone }) {
  return (
    <button role="tab" aria-selected={active} className={`tab ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}<span>{children}</span>{count != null && <span className={`tab-count ${tone || ''}`}>{count}</span>}
    </button>
  )
}

/* ---------- lateral: passos ---------- */
function Steps({ m }) {
  const [showAll, setShowAll] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => { if (!m || m.state !== 'running') return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [m?.state])
  const steps = PHASES.map((name) => ({ name, ...STEP[name], ...(m?.steps.find((s) => s.name === name) || { status: 'pending' }) }))
  const done = steps.filter((s) => s.status === 'done').length
  const explainAll = !m || showAll
  return (
    <div className="steps">
      <div className="steps-head">
        <span className="lbl" style={{ margin: 0 }}>{m ? `Progresso · ${done} de 6` : 'Como a ADE trabalha'}</span>
        {m && <button className="link" onClick={() => setShowAll((v) => !v)}>{showAll ? 'menos' : 'explicar tudo'}</button>}
      </div>
      <div className="progress"><span style={{ '--p': done / 6 }} /></div>
      <ol className="timeline">
        {steps.map((s, i) => {
          const secs = s.started_at ? Math.max(0, Math.round(((s.finished_at ? new Date(s.finished_at) : new Date()) - new Date(s.started_at)) / 1000)) : null
          const open = explainAll || s.status === 'running' || s.status === 'failed'
          return (
            <li key={s.name} className={`step ${s.status}`}>
              <span className="step-dot">
                {s.status === 'done' ? <CheckFat weight="fill" /> : s.status === 'failed' ? <X weight="bold" /> : s.status === 'running' ? <Circle weight="fill" /> : <span>{i + 1}</span>}
              </span>
              <div className="step-body">
                <div className="step-title">
                  <span>{s.title}</span>
                  <span className="step-meta">{s.status === 'pending' ? '' : s.status === 'skipped' ? 'pulado' : s.status === 'failed' ? 'parou aqui' : `${secs ?? 0} s`}</span>
                </div>
                {open && <p className="step-help">{s.help}</p>}
              </div>
            </li>
          )
        })}
      </ol>
      {m && (
        <div className="stats">
          <Stat k="Chamadas de IA" v={m.cost.calls} />
          <Stat k="Turnos do Claude" v={m.cost.turns} />
          <Stat k="Custo no Claude" v={`US$ ${m.cost.usd.toFixed(3)}`} />
          <Stat k="Tokens" v={`${(m.cost.tokens_in / 1000).toFixed(1)}k novos · ${((m.cost.cache_read || 0) / 1000).toFixed(0)}k cache`} />
        </div>
      )}
    </div>
  )
}
const Stat = ({ k, v }) => <div className="stat"><span>{k}</span><b>{v}</b></div>

function History({ history, current }) {
  if (!history?.length) return <div className="side-empty"><p className="dim">As missões que terminarem aparecem aqui.</p></div>
  return (
    <div className="hist">
      {history.map((h) => (
        <div key={h.id} className={`hist-row ${h.id === current?.id ? 'now' : ''}`}>
          <Badge size="1" color={STATE[h.state]?.color || 'gray'} variant="soft">{STATE[h.state]?.label || h.state}</Badge>
          <p style={{ marginTop: 4 }}>{h.request}</p>
          <p className="dim small">{h.finished_at?.slice(11, 16)} · US$ {(h.usd || 0).toFixed(3)}</p>
        </div>
      ))}
    </div>
  )
}

function Projects({ p, recent, running, onChanged }) {
  const [dir, setDir] = useState(p?.dir || '')
  const [msg, setMsg] = useState(null)
  async function choose(d) {
    setMsg(null)
    const r = await post('/api/project', { dir: d })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return setMsg(j.error || 'Não abriu.')
    setDir(j.dir); onChanged()
  }
  async function gitInit() { const r = await post('/api/project/git-init', {}); if (r.ok) setMsg('git iniciado com um commit de base.') }
  return (
    <div className="projects">
      <span className="lbl">Pasta do projeto</span>
      <form onSubmit={(e) => { e.preventDefault(); choose(dir) }}>
        <TextField.Root size="2" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\meus-projetos\minha-app" disabled={running} />
        <Button size="2" type="submit" disabled={running || !dir.trim()} style={{ marginTop: 6, width: '100%' }}>Usar esta pasta</Button>
      </form>
      <p className="dim small">Cole o caminho de qualquer pasta do seu PC. Pasta vazia também serve: a IA cria o projeto do zero.</p>
      {msg && <p className="small" style={{ color: 'var(--amber-11)' }}>{msg}</p>}
      {p && (
        <div className="proj-info">
          <div><span>git</span><b>{p.git ? (p.dirty ? 'com alterações pendentes' : 'limpo') : 'não é repositório'}</b></div>
          <div><span>provas</span><b>{p.runner === 'none' ? 'nenhum runner (a IA cria)' : p.test_cmd}</b></div>
          <div><span>página</span><b>{p.has_index ? 'index.html na raiz' : 'sem página'}</b></div>
          {!p.git && <Button size="1" variant="soft" onClick={gitInit} disabled={running}>Iniciar git nesta pasta</Button>}
        </div>
      )}
      {recent?.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <span className="lbl">Recentes</span>
          {recent.map((d) => <button key={d} className="recent" onClick={() => choose(d)} disabled={running || d === p?.dir} title={d}><FolderSimple size={14} />{d.split(/[\\/]/).pop()}<span className="dim small">{d}</span></button>)}
        </div>
      )}
    </div>
  )
}

/* ---------- centro ---------- */
function Empty({ onPick, running, p, allowCommands, setAllowCommands }) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <Heading size="6" style={{ letterSpacing: '-0.02em' }}>O que você quer construir{p ? ` em ${p.name}` : ''}?</Heading>
        <p className="dim">Escreva em português, do seu jeito: uma correção, uma tela nova, um app inteiro. A ADE escreve a prova, implementa, confere e manda uma segunda IA revisar. Você só decide no fim.</p>
        <label className="toggle"><input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} /> Deixar a IA rodar comandos (instalar dependências, criar projeto). Desligue para ela só ler e editar arquivos.</label>
        {p?.name === 'example' && (
          <>
            <span className="lbl" style={{ marginTop: 18 }}>Experimente no projeto de exemplo</span>
            <div className="sugs">
              {SUGGESTIONS.map((s) => <button key={s} className="sug" onClick={() => onPick(s)} disabled={running}><Play weight="fill" />{s}</button>)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Console({ log, running, live }) {
  const end = useRef(null)
  const [thinking, setThinking] = useState(false)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [log.length, live?.text?.length])
  const groups = useMemo(() => {
    const out = []
    for (const l of log) {
      if (!thinking && l.kind === 'thinking') continue
      const g = out[out.length - 1]
      if (g && g.phase === l.phase) g.lines.push(l); else out.push({ phase: l.phase, lines: [l] })
    }
    return out
  }, [log, thinking])
  const thoughtCount = log.filter((l) => l.kind === 'thinking').length
  return (
    <div className="console">
      <div className="console-bar">
        <span className="dim small">Tudo que as IAs fazem, na ordem.</span>
        <button className="link" onClick={() => setThinking((v) => !v)}>{thinking ? 'esconder pensamento' : `mostrar pensamento${thoughtCount ? ` (${thoughtCount})` : ''}`}</button>
      </div>
      {groups.map((g, gi) => (
        <section key={gi} className="phase">
          <div className="phase-head"><span className="phase-n">{PHASES.indexOf(g.phase) + 1 || '·'}</span>{STEP[g.phase]?.title || 'Motor'}</div>
          {g.lines.map((l, i) => <Line key={i} l={l} />)}
        </section>
      ))}
      {running && (
        <div className={`line live ${live?.kind || ''}`}>
          <span className="who" data-src={live?.source || 'claude'}>{live ? ({ thinking: 'pensando', tool: 'ferramenta', text: 'escrevendo' })[live.kind] : 'trabalhando'}</span>
          <span className="txt">{live?.text || '…'}<span className="cursor" /></span>
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

function Line({ l }) {
  const who = l.kind === 'thinking' ? 'pensou' : l.kind === 'tool' ? 'fez' : l.kind === 'result' ? 'viu' : l.kind === 'error' ? 'erro' : l.source === 'engine' ? 'motor' : l.source
  return (
    <div className={`line ${l.kind}`}>
      <span className="who" data-src={l.source}>{who}</span>
      <span className="txt">{l.text}</span>
      <time>{l.ts.slice(11, 19)}</time>
    </div>
  )
}

function Diff({ diff }) {
  if (!diff) return <Hint>Sem alterações ainda. Aparecem aqui assim que a IA mexer em algum arquivo.</Hint>
  const files = []
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) files.push({ name: l.split(' b/')[1] || l, lines: [] })
    else if (files.length) files[files.length - 1].lines.push(l)
  }
  return (
    <div className="diff">
      {files.map((f) => (
        <section key={f.name} className="file">
          <div className="file-head"><GitDiff size={14} />{f.name}<span className="dim">+{f.lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length} −{f.lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}</span></div>
          <pre>{f.lines.filter((l) => !/^(index|---|\+\+\+)/.test(l)).map((l, i) => <span key={i} className={l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c'}>{l || ' '}</span>)}</pre>
        </section>
      ))}
    </div>
  )
}

function Tests({ m }) {
  const explain = <div className="explain"><b>Como a ADE prova que a mudança funciona:</b> a IA escreve primeiro uma prova (um mini-programa que checa o que você pediu). A prova tem de <b>falhar</b> no código antigo e <b>passar</b> no código novo. Se ela já passasse antes, não estaria checando nada de novo.</div>
  if (!m?.tests_after) return <div>{explain}<Hint>{m?.tests_before ? `Ponto de partida: ${m.tests_before.total} provas, ${m.tests_before.failed} falhando. Esperando a IA terminar.` : 'As provas rodam antes e depois da alteração.'}</Hint></div>
  const before = new Map(m.tests_before.tests.map((t) => [t.name, t.status]))
  return (
    <div>
      {explain}
      {m.tests_after.error && <div className="explain bad"><Code>{m.tests_after.error}</Code></div>}
      <table className="tbl">
        <thead><tr><th>Prova</th><th>Antes</th><th>Depois</th></tr></thead>
        <tbody>
          {m.tests_after.tests.map((t) => {
            const b = before.get(t.name)
            return (
              <tr key={t.name}>
                <td>{t.name}{!b && <span className="new">nova</span>}{t.message && <div className="dim small">{t.message}</div>}</td>
                <td><Result s={b} /></td>
                <td><Result s={t.status} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Hint>{m.red_tests?.length ? `Prova que falhou antes e serve de evidência: ${m.red_tests.map((t) => t.name).join(', ')}.` : 'Nenhuma prova nova falhou antes da correção.'}</Hint>
    </div>
  )
}
const Result = ({ s }) => !s ? <span className="dim">não existia</span> : <span className={`res ${s === 'passed' ? 'ok' : 'bad'}`}>{s === 'passed' ? 'passou' : 'falhou'}</span>

function Review({ review }) {
  if (!review) return <Hint>A revisão pelo Codex roda depois que a prova passa.</Hint>
  return (
    <div className="review">
      <div className="verdict"><Badge size="2" color={review.verdict === 'approve' ? 'green' : 'amber'} variant="solid">{review.verdict === 'approve' ? 'Aprovado' : 'Pediu mudanças'}</Badge><span className="dim">Codex · leitura apenas</span></div>
      <p>{review.summary}</p>
      {review.findings.length === 0 ? <Hint>Nenhum problema apontado.</Hint> : review.findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <div className="finding-head"><span className="sev">{({ high: 'grave', medium: 'médio', low: 'leve' })[f.severity]}</span><Code size="1">{f.file}</Code></div>
          <p>{f.problem}</p>
          <p className="dim">Sugestão: {f.fix}</p>
        </div>
      ))}
    </div>
  )
}
const Hint = ({ children }) => <p className="hint">{children}</p>

/* ---------- direita ---------- */
function Report({ m, decide }) {
  if (!m) return <div className="rpt"><span className="lbl">Sua parte</span><p className="dim">Você só entra no fim: aceitar, pedir outra rodada ou descartar. Enquanto isso, nada para fazer.</p></div>
  return (
    <div className="rpt">
      <span className="lbl">Sua parte</span>
      {m.state === 'running' && <div className="card calm"><Pulse /><div><b>Trabalhando</b><p>Nada para fazer agora. Acompanhe pela atividade ou vá tomar um café.</p></div></div>}
      {m.state === 'complete' && <div className="card good"><CheckCircle weight="fill" /><div><b>Pronta</b><p>{m.reason === 'accepted_by_operator' ? 'Aceita por você.' : 'A prova falhou antes, passou depois, e o Codex aprovou.'} As alterações estão em <Code>proto/example</Code>. <a href="/api/app/" target="_blank" rel="noreferrer">Abrir o app</a> para ver funcionando.</p></div></div>}
      {m.state === 'discarded' && <div className="card"><Trash /><div><b>Descartada</b><p>Os arquivos voltaram ao que eram.</p></div></div>}
      {m.state === 'awaiting_operator' && (
        <>
          <div className="card warn"><Warning weight="fill" /><div><b>Precisa de você</b><p>{REASON[m.reason] || m.reason}</p></div></div>
          <div className="decide">
            <button className="act primary" onClick={() => decide('accept')}><CheckCircle weight="fill" /><span><b>Aceitar como está</b><small>Fecha a missão e mantém as alterações.</small></span></button>
            <button className="act" onClick={() => decide('retry')}><ArrowCounterClockwise /><span><b>Mais uma rodada</b><small>A IA recebe os problemas apontados e tenta de novo.</small></span></button>
            <button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar tudo</b><small>Volta os arquivos ao que eram.</small></span></button>
          </div>
        </>
      )}
      {m.review && <div className="block"><span className="lbl">O revisor disse</span><p>{m.review.summary}</p></div>}
      {m.red_tests?.length > 0 && <div className="block"><span className="lbl">Prova usada</span>{m.red_tests.map((t) => <p key={t.name}>{t.name}</p>)}</div>}
    </div>
  )
}
