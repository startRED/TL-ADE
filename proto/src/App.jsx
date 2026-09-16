import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Code, Heading, ScrollArea, Switch, TextField, Tooltip } from '@radix-ui/themes'
import {
  ArrowSquareOut, Play, CheckCircle, Warning, ArrowCounterClockwise, Trash, Flask, GitDiff, ChatCircleText, Terminal,
  FolderSimple, ClockCounterClockwise, GearSix, Pulse, Circle, CheckFat, X, Lightning, Sparkle, Cpu, ListChecks, Eye, SkipForward, MagnifyingGlass,
} from '@phosphor-icons/react'

const MISSION_STEPS = ['intent', 'plan', 'research', 'prepare', 'assets']
const ROLES_PT = { planner: 'planejador', maker: 'maker', checker: 'revisor', research: 'pesquisador' }
const skillsByRole = (m) => !m?.skills ? {} : Array.isArray(m.skills) ? { maker: m.skills } : m.skills
const allSkills = (m) => Object.entries(skillsByRole(m)).flatMap(([role, list]) => (Array.isArray(list) ? list : []).map((x) => ({ ...x, role })))
const STORY_STEPS = ['test', 'red', 'fix', 'tests', 'visual', 'checker']
const STEP = {
  intent: { title: 'Entender o pedido', help: 'Uma IA lê o seu pedido, decide o tamanho, os domínios e quais skills cada papel (planejador, maker, revisor, pesquisador) vai receber.' },
  plan: { title: 'Montar o plano', help: 'O planejador, já com as skills dele, explora o projeto e divide o trabalho em partes (stories), cada uma com critérios de aceite e como provar.' },
  research: { title: 'Pesquisar fatos', help: 'Só quando o plano depende de algo externo (versão de API, regra pública). O Google (agy) responde com fontes.' },
  prepare: { title: 'Conferir o projeto', help: 'Roda o que o projeto já tem de verificação, para saber o ponto de partida.' },
  assets: { title: 'Gerar imagens', help: 'Quando o plano pede fotos ou ilustrações, o Codex gera as imagens ($imagegen) e salva em assets/img antes de qualquer parte começar.' },
  test: { title: 'Escrever a prova', help: 'Uma "prova" é um mini-programa que checa se o que você pediu funciona. A IA escreve só isso, sem mexer no código ainda.' },
  red: { title: 'Prova falha no código antigo', help: 'A ADE roda a prova ANTES de qualquer mudança. Ela tem de falhar, porque o que você pediu ainda não existe. Se passasse agora, a prova estaria checando a coisa errada.' },
  fix: { title: 'Implementar', help: 'Só agora a IA muda o código, seguindo as skills ativas, o mínimo para a prova passar e os critérios valerem.' },
  tests: { title: 'Prova passa no código novo', help: 'Roda a prova de novo. Agora tem de passar. Falhou antes e passou depois: é isso que garante que funciona.' },
  visual: { title: 'Portão visual', help: 'Quando há interface, o Impeccable varre o código atrás de cara de template (cores gritantes, fontes batidas, layout genérico). Se achar algo, a IA faz uma rodada de retoque.' },
  checker: { title: 'Segunda IA revisa', help: 'Uma IA de outra empresa (Codex) lê a mudança e aprova ou aponta problemas. Quem escreve nunca é quem aprova.' },
}
const STATE = {
  planning: { label: 'Entendendo o pedido', color: 'teal' },
  awaiting_plan: { label: 'Plano pronto', color: 'amber' },
  running: { label: 'Em andamento', color: 'teal' },
  awaiting_operator: { label: 'Precisa de você', color: 'amber' },
  complete: { label: 'Pronta', color: 'green' },
  discarded: { label: 'Descartada', color: 'gray' },
}
const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0)
const fmtUsd = (n) => `US$ ${(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''
function Quota({ q }) {
  const c = q?.claude, x = q?.codex
  const win = (w, name) => w ? <span className="quota-win"><b>{w.used}%</b> {name}{w.resets_at ? <small> · zera {fmtWhen(w.resets_at)}</small> : null}</span> : null
  return (
    <div className="quota">
      <div className="quota-row"><span className="quota-vendor">Claude</span>{c ? <>{win(c.five_hour, 'da sessão de 5 h')}{win(c.seven_day, 'da semana')}<small className="dim">lido {fmtWhen(c.at)}</small></> : <small className="dim">sem leitura ainda: abra o Claude Code uma vez (a linha de status grava a cota)</small>}</div>
      <div className="quota-row"><span className="quota-vendor">Codex</span>{x ? <>{win(x.five_hour, 'da sessão de 5 h')}{win(x.seven_day, 'da semana')}<small className="dim">lido {fmtWhen(x.at)}</small></> : <small className="dim">sem sessão do Codex ainda</small>}</div>
      <div className="quota-row"><span className="quota-vendor">Antigravity</span><small className="dim">não expõe: abra o agy → Models &amp; Quota</small></div>
    </div>
  )
}
const REASON = {
  tests_red: 'Alguma prova ficou vermelha depois da implementação.',
  no_red_test: 'A prova que a IA escreveu já passava no código antigo (ou ela não escreveu prova). Então não serve para provar a mudança.',
  review_changes: 'A segunda IA (Codex) pediu mudanças e a IA não convergiu em 4 rodadas.',
  review_failed: 'O revisor (Codex) não respondeu. Veja o erro na atividade; "Mais uma rodada" tenta de novo.',
  no_changes: 'A IA não alterou nenhum arquivo.',
  engine_error: 'O motor falhou. Veja a atividade.',
  plan_failed: 'Não deu para transformar o pedido em plano. Reescreva o pedido com mais contexto.',
  approve_plan: 'O plano tem várias partes. Confira e aprove.',
  questions: 'A IA precisa de uma resposta sua antes de começar.',
}
const ROLE_LABEL = { intent: 'Entender o pedido e escolher skills', planner: 'Planejar (entender o pedido)', maker: 'Escrever código e provas', checker: 'Revisar (outra empresa)', research: 'Pesquisar fatos' }
const SUGGESTIONS = [
  'Crie uma planilha financeira de gastos pessoais, com categorias, total por mês e visual profissional.',
  'Crie a página inicial de um site de uma cafeteria, com cardápio, horário e um formulário de reserva.',
  'Crie uma lista de tarefas com prioridade e filtro, salvando no navegador.',
]
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const secsBetween = (a, b) => Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000))

export default function App() {
  const [state, setState] = useState({ project: null, mission: null, log: [], history: [], live: null, recent: [], settings: null, catalog: [], registry: {} })
  const [request, setRequest] = useState('')
  const [tab, setTab] = useState('plan')
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState('mission')
  const [error, setError] = useState(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true); es.onerror = () => setConnected(false)
    es.onmessage = (e) => setState(JSON.parse(e.data))
    return () => es.close()
  }, [])

  const m = state.mission, p = state.project, s = state.settings
  const busy = m && ['running', 'planning'].includes(m.state)
  useEffect(() => { if (m?.state === 'planning') setTab('activity'); if (m?.state === 'awaiting_plan') setTab('plan') }, [m?.state])

  async function run(text) {
    const req = (text ?? request).trim()
    if (!req || busy) return
    setView('mission'); setError(null)
    const r = await post('/api/run', { request: req })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || 'Não deu para começar.'); if (/git|pasta/i.test(j.error || '')) setView('projects'); if (/Modelos/.test(j.error || '')) setView('models') }
  }
  const decide = (option, text) => post('/api/decide', typeof text === 'object' ? { option, ...text } : { option, text })
  const saveSettings = (patch) => post('/api/settings', patch)

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="logo" /><span>TL-ADE</span><span className="dim">demonstração</span></div>
        <form className="cmd" onSubmit={(e) => { e.preventDefault(); run() }}>
          <TextField.Root size="2" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={p ? `O que construir em ${p.name}? Escreva do seu jeito.` : 'Escolha uma pasta primeiro'} disabled={busy}>
            <TextField.Slot><Lightning weight="fill" color="var(--teal-9)" /></TextField.Slot>
            <TextField.Slot><Button size="1" type="submit" disabled={busy || !request.trim()}>{busy ? 'Rodando' : 'Rodar'}</Button></TextField.Slot>
          </TextField.Root>
        </form>
        <div className="topright">
          {m && <MissionChip m={m} />}
          {p?.has_index && <a className="open-app" href="/api/app/" target="_blank" rel="noreferrer"><ArrowSquareOut /> Abrir o app</a>}
        </div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Seções">
          <RailButton icon={<Pulse />} label="Missão" active={view === 'mission'} onClick={() => setView('mission')} badge={m && ['awaiting_operator', 'awaiting_plan'].includes(m.state)} />
          <RailButton icon={<Sparkle />} label="Skills" active={view === 'skills'} onClick={() => setView('skills')} />
          <RailButton icon={<Cpu />} label="Modelos" active={view === 'models'} onClick={() => setView('models')} />
          <RailButton icon={<ClockCounterClockwise />} label="Histórico" active={view === 'history'} onClick={() => setView('history')} />
          <RailButton icon={<FolderSimple />} label="Projetos" active={view === 'projects'} onClick={() => setView('projects')} />
          <span className="grow" />
          <RailButton icon={<GearSix />} label="Opções" active={view === 'options'} onClick={() => setView('options')} />
        </nav>

        <aside className="side">
          <button className="side-head" onClick={() => setView('projects')} title={p?.dir || ''}>
            <FolderSimple size={16} color="var(--gray-10)" />
            <div>
              <p className="side-title">{p?.name || 'Nenhuma pasta'}</p>
              <p className="dim small">{p ? `${p.branch || 'sem git'} · ${p.runner === 'none' ? 'sem provas' : p.runner}${p.files === 0 ? ' · vazia' : ''}` : 'escolha uma pasta'}</p>
            </div>
            <span className="dim small" style={{ marginLeft: 'auto' }}>trocar</span>
          </button>
          {view === 'mission' && <Progress m={m} quota={state.quota} />}
          {view === 'skills' && <SkillsPanel state={state} save={saveSettings} />}
          {view === 'models' && <ModelsPanel state={state} save={saveSettings} />}
          {view === 'history' && <History history={state.history} current={m} />}
          {view === 'projects' && <Projects p={p} recent={state.recent} busy={busy} onChanged={() => { setView('mission'); setError(null) }} />}
          {view === 'options' && <Options s={s} save={saveSettings} />}
        </aside>

        <main className="main">
          {error && <div className="errbar"><Warning weight="fill" /> {error}</div>}
          {!m ? <Empty onPick={(t) => { setRequest(t); run(t) }} busy={busy} p={p} s={s} /> : (
            <>
              <div className="main-head">
                <Heading size="4" style={{ letterSpacing: '-0.01em' }}>{m.plan?.title || m.request}</Heading>
                <p className="dim small">{m.plan ? m.request : `${m.id} · começou às ${m.started_at.slice(11, 16)}`}</p>
              </div>
              <div className="tabs" role="tablist">
                <Tab active={tab === 'plan'} onClick={() => setTab('plan')} icon={<ListChecks />} count={m.stories.length || null}>Plano</Tab>
                <Tab active={tab === 'activity'} onClick={() => setTab('activity')} icon={<Terminal />}>Atividade</Tab>
                <Tab active={tab === 'diff'} onClick={() => setTab('diff')} icon={<GitDiff />}>Alterações</Tab>
                <Tab active={tab === 'tests'} onClick={() => setTab('tests')} icon={<Flask />} {...testsBadge(m)}>Provas</Tab>
                <Tab active={tab === 'visual'} onClick={() => setTab('visual')} icon={<Eye />} {...visualBadge(m)}>Visual</Tab>
                <Tab active={tab === 'review'} onClick={() => setTab('review')} icon={<ChatCircleText />} {...reviewBadge(m)}>Revisão</Tab>
              </div>
              <ScrollArea className="main-body" scrollbars="vertical">
                {tab === 'plan' && <Plan m={m} catalog={state.catalog} />}
                {tab === 'activity' && <Console log={state.log} busy={busy} live={state.live} />}
                {tab === 'diff' && <Diff m={m} />}
                {tab === 'tests' && <Tests m={m} />}
                {tab === 'visual' && <Visual m={m} />}
                {tab === 'review' && <Review m={m} />}
              </ScrollArea>
            </>
          )}
        </main>

        <aside className="right"><Report m={m} decide={decide} /></aside>
      </div>

      <footer className="status">
        <span className={connected ? 'ok' : 'bad'}>{connected ? '● servidor ligado' : '○ sem servidor'}</span>
        <span title={p?.dir}>{p ? p.dir : 'sem pasta'}</span>
        {s && <span>{s.roles.intent?.model || s.roles.planner.model} entende · {s.roles.planner.model} planeja · {s.roles.maker.model} escreve · {s.roles.checker.model} revisa</span>}
        <span className="grow" />
        {m && <span>{m.cost.calls} chamadas · {fmtTok(m.cost.tokens_in + m.cost.tokens_out)} tokens · {fmtUsd(m.cost.usd)} no Claude</span>}
      </footer>
    </div>
  )
}

const cur = (m) => m && m.current != null ? m.stories[m.current] : (m?.stories?.find((s) => s.state === 'blocked') || null)
function testsBadge(m) { const st = cur(m); if (!st?.tests_after) return {}; return { count: `${st.tests_after.total - st.tests_after.failed}/${st.tests_after.total}`, tone: st.tests_after.ok ? 'green' : 'red' } }
function visualBadge(m) { const st = cur(m); if (!st?.visual?.available) return {}; return { count: st.visual.findings.length, tone: st.visual.findings.length ? 'amber' : 'green' } }
function reviewBadge(m) { const st = cur(m); if (!st?.review) return {}; return { count: st.review.verdict === 'approve' ? 'ok' : st.review.findings.length, tone: st.review.verdict === 'approve' ? 'green' : 'amber' } }

/* ---------- topo ---------- */
function MissionChip({ m }) {
  const s = STATE[m.state] || { label: m.state, color: 'gray' }
  const [, tick] = useState(0)
  useEffect(() => { if (!['running', 'planning'].includes(m.state)) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [m.state])
  const secs = secsBetween(m.started_at, m.finished_at)
  return <div className="chip"><Badge color={s.color} variant={m.state.startsWith('awaiting') ? 'solid' : 'soft'} size="2">{s.label}</Badge><span className="dim small">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span></div>
}
function RailButton({ icon, label, active, onClick, badge }) {
  return <Tooltip content={label} side="right"><button className={`rail-btn ${active ? 'active' : ''}`} onClick={onClick} aria-label={label} aria-current={active ? 'page' : undefined}>{icon}{badge && <span className="rail-badge" />}</button></Tooltip>
}
function Tab({ active, onClick, icon, children, count, tone }) {
  return <button role="tab" aria-selected={active} className={`tab ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{children}</span>{count != null && <span className={`tab-count ${tone || ''}`}>{count}</span>}</button>
}

/* ---------- lateral: progresso (épicos = stories) ---------- */
function Interview({ questions, onAnswer, onSkip }) {
  const qs = (questions || []).map((q, i) => typeof q === 'string' ? { id: `q${i + 1}`, question: q, why: '', options: [], allow_other: true } : q)
  const [picked, setPicked] = useState(() => Object.fromEntries(qs.map((q) => [q.id, q.options?.[0]?.label || ''])))
  const [other, setOther] = useState({})
  const answers = qs.map((q) => ({ id: q.id, question: q.question, answer: picked[q.id] === '__other' ? (other[q.id] || '').trim() : picked[q.id] }))
  const ready = answers.every((a) => a.answer)
  return (
    <>
      <p className="dim small" style={{ margin: '0 0 8px' }}>A primeira opção é sempre a recomendada. Não sabe? Deixe como está.</p>
      {qs.map((q) => (
        <div className="q-card" key={q.id}>
          <b>{q.question}</b>{q.why && <small className="dim"> {q.why}</small>}
          {q.options.map((o, i) => (
            <label className={'q-opt' + (picked[q.id] === o.label ? ' on' : '')} key={o.label}>
              <input type="radio" name={q.id} checked={picked[q.id] === o.label} onChange={() => setPicked({ ...picked, [q.id]: o.label })} />
              <span><b>{o.label}</b>{i === 0 && <em> recomendado</em>}<small>{o.hint}</small></span>
            </label>
          ))}
          {q.allow_other && (
            <label className={'q-opt' + (picked[q.id] === '__other' ? ' on' : '')}>
              <input type="radio" name={q.id} checked={picked[q.id] === '__other'} onChange={() => setPicked({ ...picked, [q.id]: '__other' })} />
              <span><b>Outro</b><input className="ta" style={{ marginTop: 6 }} value={other[q.id] || ''} onFocus={() => setPicked({ ...picked, [q.id]: '__other' })} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} placeholder="Escreva do seu jeito" /></span>
            </label>
          )}
        </div>
      ))}
      <div className="decide">
        <button className="act primary" disabled={!ready} onClick={() => onAnswer(answers)}><CheckCircle weight="fill" /><span><b>Responder e montar o plano</b><small>O planejador usa as suas escolhas.</small></span></button>
        <button className="act" onClick={onSkip}><Play weight="fill" /><span><b>Seguir com as recomendações</b></span></button>
      </div>
    </>
  )
}
function Progress({ m, quota }) {
  const [showAll, setShowAll] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => { if (!m || !['running', 'planning'].includes(m.state)) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [m?.state])
  if (!m) return (
    <div className="steps">
      <span className="lbl">Como a ADE trabalha</span>
      <ol className="timeline">{[...MISSION_STEPS, ...STORY_STEPS].filter((n) => n !== 'research').map((n, i) => <StepRow key={n} i={i} s={{ name: n, status: 'pending', ...STEP[n] }} open />)}</ol>
    </div>
  )
  const done = m.stories.filter((s) => s.state === 'done').length
  const st = cur(m)
  return (
    <div className="steps">
      <div className="steps-head"><span className="lbl" style={{ margin: 0 }}>{m.plan ? `Partes · ${done} de ${m.stories.length}` : 'Missão'}</span><button className="link" onClick={() => setShowAll((v) => !v)}>{showAll ? 'menos' : 'explicar tudo'}</button></div>
      <div className="progress"><span style={{ '--p': m.stories.length ? done / m.stories.length : 0 }} /></div>
      <ol className="timeline">
        {MISSION_STEPS.filter((n) => n !== 'research' || m.steps.find((x) => x.name === 'research')).map((n, i) => <StepRow key={n} i={i} s={{ ...STEP[n], ...(m.steps.find((x) => x.name === n) || { status: 'pending' }), name: n }} open={showAll} />)}
      </ol>
      {m.stories.length > 0 && <span className="lbl" style={{ marginTop: 12 }}>Partes do trabalho</span>}
      <ol className="stories">
        {m.stories.map((s, i) => (
          <li key={s.id} className={`story ${s.state} ${st === s ? 'cur' : ''}`}>
            <span className="story-dot">{s.state === 'done' ? <CheckFat weight="fill" /> : s.state === 'blocked' ? <X weight="bold" /> : s.state === 'skipped' ? <SkipForward /> : s.state === 'running' ? <Circle weight="fill" /> : i + 1}</span>
            <div className="story-body">
              <div className="story-title"><span>{s.title}</span><span className="step-meta">{s.state === 'running' ? `rodada ${s.round}` : s.state === 'done' ? 'pronta' : s.state === 'blocked' ? 'parou' : s.state === 'skipped' ? 'pulada' : ''}</span></div>
              {(st === s) && <ol className="timeline inner">{STORY_STEPS.filter((n) => n !== 'visual' || m.plan?.needs_ui).map((n, j) => <StepRow key={n} i={j} s={{ ...STEP[n], ...(s.steps.find((x) => x.name === n) || { status: 'pending' }), name: n }} open={showAll} />)}</ol>}
            </div>
          </li>
        ))}
      </ol>
      <div className="stats">
        <Stat k="Chamadas de IA" v={m.cost.calls} />
        <Stat k="Tokens" v={`${fmtTok(m.cost.tokens_in)} novos · ${fmtTok(m.cost.cache_read || 0)} cache`} />
        <Stat k="Custo no Claude" v={fmtUsd(m.cost.usd)} />
      </div>
      <span className="lbl">Cota do plano</span>
      <Quota q={quota} />
    </div>
  )
}
function StepRow({ s, i, open }) {
  const status = s.status || 'pending'
  const secs = s.started_at ? secsBetween(s.started_at, s.finished_at) : null
  const meta = { pending: '', running: `${secs ?? 0} s`, done: `ok · ${secs ?? 0} s`, failed: 'atenção', warn: 'avisos', skipped: 'pulado' }[status]
  const show = open || status === 'running' || status === 'failed'
  return (
    <li className={`step ${status}`}>
      <span className="step-dot">{status === 'done' ? <CheckFat weight="fill" /> : status === 'failed' ? <X weight="bold" /> : status === 'warn' ? <Warning weight="fill" /> : status === 'running' ? <Circle weight="fill" /> : <span>{i + 1}</span>}</span>
      <div className="step-body"><div className="step-title"><span>{s.title}</span><span className="step-meta">{meta}</span></div>{show && <p className="step-help">{s.help}</p>}</div>
    </li>
  )
}
const Stat = ({ k, v }) => <div className="stat"><span>{k}</span><b>{v}</b></div>

/* ---------- lateral: skills ---------- */
function SkillsPanel({ state, save }) {
  const { catalog, settings: s, mission: m } = state
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [body, setBody] = useState('')
  if (!s) return null
  const active = new Map(allSkills(m).map((x) => [x.id, x]))
  const list = catalog.filter((c) => !q || `${c.id} ${c.description}`.toLowerCase().includes(q.toLowerCase()))
  const toggleForce = (id) => save({ skills: { forced: s.skills.forced.includes(id) ? s.skills.forced.filter((x) => x !== id) : [...s.skills.forced, id], excluded: s.skills.excluded.filter((x) => x !== id) } })
  const toggleExclude = (id) => save({ skills: { excluded: s.skills.excluded.includes(id) ? s.skills.excluded.filter((x) => x !== id) : [...s.skills.excluded, id], forced: s.skills.forced.filter((x) => x !== id) } })
  async function show(id) { if (open === id) return setOpen(null); const r = await fetch(`/api/skill?id=${id}`); const j = await r.json(); setBody(j.body || ''); setOpen(id) }
  return (
    <div className="panel">
      <div className="steps-head"><span className="lbl" style={{ margin: 0 }}>Skills · {catalog.length} no catálogo</span><label className="sw"><Switch size="1" checked={s.skills.auto} onCheckedChange={(v) => save({ skills: { auto: v } })} /> automático</label></div>
      <p className="dim small">Skills são manuais de qualidade que cada papel recebe junto com o pedido. A IA que entende o pedido escolhe as skills do planejador, do maker, do revisor e do pesquisador; o motor garante as regras fixas (interface ou design: sempre <b>design-taste-frontend</b> + <b>impeccable</b> no maker). Até {s.skills.max} no maker, 3 nos outros, entregues inteiras (sem corte, por decisão sua).</p>
      {allSkills(m).length > 0 && <div className="chips">{allSkills(m).map((x) => <span key={x.role + x.id} className="chip-skill on" title={x.reason}>{x.id}<small>{ROLES_PT[x.role]} · {x.reason}</small></span>)}</div>}
      <TextField.Root size="1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtrar…" style={{ marginTop: 8 }}><TextField.Slot><MagnifyingGlass /></TextField.Slot></TextField.Root>
      <ul className="skill-list">
        {list.map((c) => {
          const forced = s.skills.forced.includes(c.id), excluded = s.skills.excluded.includes(c.id)
          return (
            <li key={c.id} className={`skill ${active.has(c.id) ? 'active' : ''} ${excluded ? 'off' : ''}`}>
              <button className="skill-name" onClick={() => show(c.id)}><span>{c.id}</span><span className="dim small">{c.source} · {(c.bytes / 4 / 1000).toFixed(1)}k tok</span></button>
              <p className="dim small">{c.description || 'sem descrição'}</p>
              <div className="skill-actions">
                {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                <span className="grow" />
                <button className={`mini ${forced ? 'on' : ''}`} onClick={() => toggleForce(c.id)}>{forced ? 'fixada' : 'fixar'}</button>
                <button className={`mini ${excluded ? 'on' : ''}`} onClick={() => toggleExclude(c.id)}>{excluded ? 'excluída' : 'excluir'}</button>
              </div>
              {open === c.id && <pre className="skill-body">{body.slice(0, 6000)}{body.length > 6000 ? '\n…' : ''}</pre>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ---------- lateral: modelos ---------- */
function ModelsPanel({ state, save }) {
  const { settings: s, registry } = state
  if (!s) return null
  const setRole = (role, family, model) => save({ roles: { [role]: { family, model } } })
  return (
    <div className="panel">
      <span className="lbl">Quem faz o quê</span>
      <p className="dim small">Cada papel tem um modelo. Quem escreve e quem revisa têm de ser de empresas diferentes: é a regra que faz a revisão valer alguma coisa.</p>
      {Object.entries(ROLE_LABEL).map(([role, label]) => (
        <div key={role} className="role">
          <span className="role-label">{label}</span>
          <select className="sel" value={`${(s.roles[role] || {}).family || 'claude'}|${(s.roles[role] || {}).model || ''}`} onChange={(e) => { const [f, mo] = e.target.value.split('|'); setRole(role, f, mo) }}>
            {Object.entries(registry).map(([fam, fr]) => <optgroup key={fam} label={fr.label}>{fr.models.map((mo) => <option key={mo.id} value={`${fam}|${mo.id}`}>{mo.label}{mo.note ? ` · ${mo.note}` : ''}</option>)}</optgroup>)}
          </select>
        </div>
      ))}
      <p className="dim small" style={{ marginTop: 10 }}>Fable é o mais forte e o mais caro (~US$ 0,60 só de abertura por chamada). Use para planejar pedidos grandes, não para escrever código linha a linha.</p>
    </div>
  )
}

function Options({ s, save }) {
  if (!s) return null
  return (
    <div className="panel">
      <span className="lbl">Opções</span>
      <label className="opt"><Switch checked={s.allow_commands} onCheckedChange={(v) => save({ allow_commands: v })} /><span><b>Deixar a IA rodar comandos</b><small>Instalar dependências, criar projeto. Desligue para ela só ler e editar arquivos.</small></span></label>
      <label className="opt"><Switch checked={s.visual_gate} onCheckedChange={(v) => save({ visual_gate: v })} /><span><b>Portão visual (Impeccable)</b><small>Varre a interface atrás de cara de template e força uma rodada de retoque.</small></span></label>
      <label className="opt"><Switch checked={s.research_enabled} onCheckedChange={(v) => save({ research_enabled: v })} /><span><b>Pesquisa com Google (agy)</b><small>Só quando o plano depende de um fato externo.</small></span></label>
      <label className="opt"><Switch checked={s.assets_enabled !== false} onCheckedChange={(v) => save({ assets_enabled: v })} /><span><b>Imagens geradas pelo Codex</b><small>Quando o plano pede fotos ou ilustrações, o Codex gera ($imagegen) antes das partes começarem. Consome cota do Codex.</small></span></label>
      <label className="opt"><select className="ta" style={{ width: 'auto' }} value={s.autonomy || 'auto'} onChange={(e) => save({ autonomy: e.target.value })}><option value="auto">segue sozinha</option><option value="ask">para e pergunta</option></select><span><b>Depois de 4 rodadas de revisão</b><small>Segue sozinha: se as provas estão verdes e o revisor não apontou nada grave, aceita e vai para a próxima parte. Para e pergunta: você decide.</small></span></label>
      <label className="opt"><select className="ta" style={{ width: 'auto' }} value={s.interview || 'auto'} onChange={(e) => save({ interview: e.target.value })}><option value="auto">automática</option><option value="always">sempre</option><option value="never">nunca</option></select><span><b>Entrevista antes do plano</b><small>Perguntas fáceis de múltipla escolha para escolher o jeito do programa. Automática: só em pedidos médios e grandes.</small></span></label>
    </div>
  )
}

function History({ history, current }) {
  if (!history?.length) return <div className="side-empty"><p className="dim">As missões que terminarem aparecem aqui.</p></div>
  return <div className="hist">{history.map((h) => (
    <div key={h.id} className={`hist-row ${h.id === current?.id ? 'now' : ''}`}>
      <Badge size="1" color={STATE[h.state]?.color || 'gray'} variant="soft">{STATE[h.state]?.label || h.state}</Badge>
      <p style={{ marginTop: 4 }}>{h.title || h.request}</p>
      <p className="dim small">{h.project?.split(/[\\/]/).pop()} · {h.stories || 0} partes · {h.finished_at?.slice(11, 16)} · {fmtUsd(h.usd)}</p>
    </div>
  ))}</div>
}

function Projects({ p, recent, busy, onChanged }) {
  const [dir, setDir] = useState(p?.dir || '')
  const [msg, setMsg] = useState(null)
  async function choose(d) { setMsg(null); const r = await post('/api/project', { dir: d }); const j = await r.json().catch(() => ({})); if (!r.ok) return setMsg(j.error || 'Não abriu.'); setDir(j.dir); onChanged() }
  async function gitInit() { const r = await post('/api/project/git-init', {}); if (r.ok) setMsg('git iniciado com um commit de base.') }
  return (
    <div className="panel">
      <span className="lbl">Pasta do projeto</span>
      <form onSubmit={(e) => { e.preventDefault(); choose(dir) }}>
        <TextField.Root size="2" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\meus-projetos\minha-app" disabled={busy} />
        <Button size="2" type="submit" disabled={busy || !dir.trim()} style={{ marginTop: 6, width: '100%' }}>Usar esta pasta</Button>
      </form>
      <p className="dim small">Cole o caminho de qualquer pasta do seu PC. Se não existir, a ADE cria. Pasta vazia: a IA monta o projeto do zero.</p>
      {msg && <p className="small" style={{ color: 'var(--amber-11)' }}>{msg}</p>}
      {p && (
        <div className="proj-info">
          <div><span>git</span><b>{p.git ? (p.dirty ? 'com alterações pendentes' : 'limpo') : 'não é repositório'}</b></div>
          <div><span>provas</span><b>{p.runner === 'none' ? 'nenhum runner (a IA cria)' : p.test_cmd}</b></div>
          <div><span>página</span><b>{p.has_index ? 'index.html na raiz' : 'sem página'}</b></div>
          {p.nested && <p className="dim small" style={{ margin: '4px 0 0' }}>Fica dentro do repositório {p.root}; os commits da ADE vão para lá, só com arquivos desta pasta.</p>}
          {!p.git && <Button size="1" variant="soft" onClick={gitInit} disabled={busy}>Iniciar git nesta pasta</Button>}
        </div>
      )}
      {recent?.length > 0 && <div style={{ marginTop: 16 }}><span className="lbl">Recentes</span>{recent.map((d) => <button key={d} className="recent" onClick={() => choose(d)} disabled={busy || d === p?.dir} title={d}><FolderSimple size={14} />{d.split(/[\\/]/).pop()}<span className="dim small">{d}</span></button>)}</div>}
    </div>
  )
}

/* ---------- centro ---------- */
function Empty({ onPick, busy, p, s }) {
  return (
    <div className="empty"><div className="empty-inner">
      <Heading size="6" style={{ letterSpacing: '-0.02em' }}>O que você quer construir{p ? ` em ${p.name}` : ''}?</Heading>
      <p className="dim">Escreva em português, do seu jeito: uma correção, uma tela, um app inteiro. A ADE entende o pedido, escolhe as skills, escreve as provas, implementa, confere o visual e manda outra IA revisar. Você só decide no fim.</p>
      {s && <p className="dim small">Agora: {s.roles.planner.model} planeja · {s.roles.maker.model} escreve · {s.roles.checker.model} revisa · comandos {s.allow_commands ? 'liberados' : 'bloqueados'}.</p>}
      <span className="lbl" style={{ marginTop: 18 }}>Experimente</span>
      <div className="sugs">{SUGGESTIONS.map((t) => <button key={t} className="sug" onClick={() => onPick(t)} disabled={busy || !p}><Play weight="fill" />{t}</button>)}</div>
    </div></div>
  )
}

function Plan({ m, catalog }) {
  if (!m.plan) return <Hint>{m.state === 'planning' ? 'A IA está lendo o pedido e o projeto para montar o plano. Acompanhe na Atividade.' : 'Sem plano.'}</Hint>
  const pl = m.plan
  return (
    <div className="plan">
      <div className="plan-head">
        <Badge variant="soft" color="gray">{({ trivial: 'trivial', bounded: 'pequeno', feature: 'funcionalidade', subsystem: 'grande' })[pl.complexity] || pl.complexity}</Badge>
        {pl.needs_ui && <Badge variant="soft" color="teal">interface</Badge>}{pl.needs_backend && <Badge variant="soft" color="violet">backend</Badge>}
        {pl.domains.map((d) => <Badge key={d} variant="outline" color="gray">{d}</Badge>)}
      </div>
      {pl.explanation && <div className="explain"><b>Em palavras simples</b><p style={{ whiteSpace: 'pre-line', margin: '6px 0 0' }}>{pl.explanation}</p></div>}
      <p className="plan-summary">{pl.summary}</p>
      {pl.questions?.length > 0 && m.state === 'awaiting_plan' && m.reason === 'questions' && <div className="explain"><b>A IA quer saber como você prefere:</b><ul>{pl.questions.map((q) => <li key={q.id || q}>{q.question || q}</li>)}</ul><small className="dim">Responda no painel da direita.</small></div>}
      {m.answers?.length > 0 && <div className="explain"><b>Suas escolhas</b><ul>{m.answers.map((a) => <li key={a.id}>{a.question} <b>→ {a.answer}</b></li>)}</ul></div>}
      {pl.assets?.length > 0 && (
        <>
          <span className="lbl">Imagens do plano</span>
          {pl.assets_style && <p className="dim small" style={{ margin: '0 0 8px' }}>Direção de arte: {pl.assets_style}</p>}
          <div className="assets-grid">
            {pl.assets.map((a) => { const done = (m.assets_done || []).some((d) => d.file === a.file); return (
              <figure key={a.file} className={done ? 'done' : ''}>
                {done ? <img src={`/api/app/${a.file}?t=${m.assets_done.length}`} alt={a.purpose} /> : <div className="ph">{m.state === 'running' ? 'gerando…' : 'ainda não gerada'}</div>}
                <figcaption><b>{a.file.replace('assets/img/', '')}</b><small>{a.purpose}</small></figcaption>
              </figure>
            ) })}
          </div>
        </>
      )}
      <span className="lbl">Partes do trabalho</span>
      <ol className="plan-stories">
        {m.stories.map((s, i) => (
          <li key={s.id} className={s.state}>
            <div className="ps-head"><span className="ps-n">{i + 1}</span><b>{s.title}</b><Badge size="1" variant="soft" color={{ done: 'green', running: 'teal', blocked: 'amber', skipped: 'gray', queued: 'gray' }[s.state]}>{{ done: 'pronta', running: 'em andamento', blocked: 'parou', skipped: 'pulada', queued: 'na fila' }[s.state]}</Badge></div>
            <p className="dim">{s.request}</p>
            <ul className="acc">{s.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="dim small">Prova: {s.test_hint}</p>
          </li>
        ))}
      </ol>
      <span className="lbl">Skills por papel</span>
      {Object.entries(skillsByRole(m)).map(([role, list]) => <div key={role} className="role-skills"><span className="role-name">{ROLES_PT[role]}</span>{list?.length ? <div className="chips">{list.map((x) => <span key={x.id} className="chip-skill on">{x.id}<small>{x.reason} · {Math.round(x.bytes / 4 / 1000)}k tok</small></span>)}</div> : <span className="dim small">nenhuma</span>}</div>)}
      {m.research?.findings?.length > 0 && <><span className="lbl">Pesquisa</span>{m.research.findings.map((f) => <div key={f.question} className="explain"><b>{f.question}</b><p>{f.answer}</p>{f.sources?.length > 0 && <p className="dim small">{f.sources.join(' · ')}</p>}</div>)}</>}
    </div>
  )
}

function Console({ log, busy, live }) {
  const end = useRef(null)
  const [thinking, setThinking] = useState(false)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [log.length, live?.text?.length])
  const groups = useMemo(() => {
    const out = []
    for (const l of log) { if (!thinking && l.kind === 'thinking') continue; const g = out[out.length - 1]; const key = `${l.phase}|${l.story}`; if (g && g.key === key) g.lines.push(l); else out.push({ key, phase: l.phase, story: l.story, lines: [l] }) }
    return out
  }, [log, thinking])
  const thoughtCount = log.filter((l) => l.kind === 'thinking').length
  return (
    <div className="console">
      <div className="console-bar"><span className="dim small">Tudo que as IAs fazem, na ordem.</span><button className="link" onClick={() => setThinking((v) => !v)}>{thinking ? 'esconder pensamento' : `mostrar pensamento${thoughtCount ? ` (${thoughtCount})` : ''}`}</button></div>
      {groups.map((g, gi) => (
        <section key={gi} className="phase">
          <div className="phase-head">{g.story != null && <span className="phase-n">P{g.story + 1}</span>}{STEP[g.phase]?.title || 'Motor'}</div>
          {g.lines.map((l, i) => <Line key={i} l={l} />)}
        </section>
      ))}
      {busy && <div className={`line live ${live?.kind || ''}`}><span className="who" data-src={live?.source || 'claude'}>{live ? ({ thinking: 'pensando', tool: 'ferramenta', text: 'escrevendo' })[live.kind] : 'trabalhando'}</span><span className="txt">{live?.text || '…'}<span className="cursor" /></span></div>}
      <div ref={end} />
    </div>
  )
}
function Line({ l }) {
  const who = l.kind === 'thinking' ? 'pensou' : l.kind === 'tool' ? 'fez' : l.kind === 'result' ? 'viu' : l.kind === 'error' ? 'erro' : l.source === 'engine' ? 'motor' : l.source
  return <div className={`line ${l.kind}`}><span className="who" data-src={l.source}>{who}</span><span className="txt">{l.text}</span><time>{l.ts.slice(11, 19)}</time></div>
}

function Diff({ m }) {
  const st = cur(m); const diff = st?.diff
  if (!diff) return <Hint>Sem alterações na parte atual. Aparecem aqui assim que a IA mexer em algum arquivo.</Hint>
  const files = []
  for (const l of diff.split('\n')) { if (l.startsWith('diff --git')) files.push({ name: l.split(' b/')[1] || l, lines: [] }); else if (files.length) files[files.length - 1].lines.push(l) }
  return <div className="diff">{files.map((f) => (
    <section key={f.name} className="file">
      <div className="file-head"><GitDiff size={14} />{f.name}<span className="dim">+{f.lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length} −{f.lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}</span></div>
      <pre>{f.lines.filter((l) => !/^(index|---|\+\+\+)/.test(l)).slice(0, 400).map((l, i) => <span key={i} className={l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c'}>{l || ' '}</span>)}</pre>
    </section>
  ))}</div>
}

function Tests({ m }) {
  const st = cur(m)
  const explain = <div className="explain"><b>Como a ADE prova que a mudança funciona:</b> a IA escreve primeiro uma prova (um mini-programa que checa o que você pediu). A prova tem de <b>falhar</b> no código antigo e <b>passar</b> no código novo.</div>
  if (!st?.tests_after) return <div>{explain}<Hint>{m.tests_before ? `Ponto de partida: ${m.tests_before.total} provas, ${m.tests_before.failed} falhando.` : 'As provas rodam antes e depois da mudança.'}</Hint></div>
  const before = new Map((m.tests_before?.tests || []).map((t) => [t.name, t.status]))
  return (
    <div>{explain}
      {st.tests_after.error && <div className="explain bad"><Code>{st.tests_after.error}</Code></div>}
      <table className="tbl"><thead><tr><th>Prova</th><th>Antes</th><th>Depois</th></tr></thead><tbody>
        {st.tests_after.tests.map((t) => { const b = before.get(t.name); return <tr key={t.name}><td>{t.name}{!b && <span className="new">nova</span>}{t.message && <div className="dim small">{t.message}</div>}</td><td><Result s={b} /></td><td><Result s={t.status} /></td></tr> })}
      </tbody></table>
      <Hint>{st.red_tests?.length ? `Prova que falhou antes e serve de evidência: ${st.red_tests.map((t) => t.name).join(', ')}.` : 'Nenhuma prova nova falhou antes da mudança.'}</Hint>
    </div>
  )
}
const Result = ({ s }) => !s ? <span className="dim">não existia</span> : <span className={`res ${s === 'passed' ? 'ok' : 'bad'}`}>{s === 'passed' ? 'passou' : 'falhou'}</span>

function Visual({ m }) {
  const st = cur(m)
  if (!m.plan?.needs_ui) return <Hint>Este pedido não tem interface; o portão visual não roda.</Hint>
  if (!st?.visual) return <Hint>O portão visual roda depois que as provas passam. Ele varre o código atrás de cara de template (fontes batidas, cores gritantes, gradiente roxo, três cards iguais).</Hint>
  if (!st.visual.available) return <Hint>Impeccable não encontrado nesta máquina.</Hint>
  return (
    <div>
      <p className="small dim">Impeccable detect · {st.visual.findings.length} achado(s){st.visual.error ? ` · ${st.visual.error}` : ''}</p>
      {st.visual.findings.length === 0 ? <div className="explain"><b>Nenhum sinal de template.</b> O visual passou no detector.</div> : st.visual.findings.map((f, i) => <div key={i} className="finding medium"><div className="finding-head"><span className="sev">{f.rule}</span><Code size="1">{f.file}{f.line ? `:${f.line}` : ''}</Code></div><p>{f.message}</p></div>)}
      {p2(st)}
    </div>
  )
}
const p2 = (st) => st.review ? null : null

function Review({ m }) {
  const st = cur(m); const review = st?.review
  if (!review) return <Hint>A revisão pelo Codex roda depois que a prova passa e o visual é conferido.</Hint>
  return (
    <div className="review">
      <div className="verdict"><Badge size="2" color={review.verdict === 'approve' ? 'green' : 'amber'} variant="solid">{review.verdict === 'approve' ? 'Aprovado' : 'Pediu mudanças'}</Badge><span className="dim">Codex · leitura apenas</span></div>
      <p>{review.summary}</p>
      {review.findings.length === 0 ? <Hint>Nenhum problema apontado.</Hint> : review.findings.map((f, i) => <div key={i} className={`finding ${f.severity}`}><div className="finding-head"><span className="sev">{({ high: 'grave', medium: 'médio', low: 'leve' })[f.severity]}</span><Code size="1">{f.file}</Code></div><p>{f.problem}</p><p className="dim">Sugestão: {f.fix}</p></div>)}
    </div>
  )
}
const Hint = ({ children }) => <p className="hint">{children}</p>

/* ---------- direita ---------- */
function Report({ m, decide }) {
  const [answer, setAnswer] = useState('')
  if (!m) return <div className="rpt"><span className="lbl">Sua parte</span><p className="dim">Você só entra quando a ADE precisar: aprovar um plano grande, responder uma dúvida, ou decidir no fim. Enquanto isso, nada para fazer.</p></div>
  const st = cur(m)
  return (
    <div className="rpt">
      <span className="lbl">Sua parte</span>
      {m.state === 'planning' && <div className="card calm"><Pulse /><div><b>Entendendo o pedido</b><p>Primeiro uma IA entende o pedido e escolhe as skills de cada papel; depois o planejador monta as partes. Uns dois minutos.</p></div></div>}
      {m.state === 'running' && <div className="card calm"><Pulse /><div><b>Trabalhando</b><p>{st ? `Parte ${m.current + 1} de ${m.stories.length}: ${st.title}.` : 'Preparando.'} Nada para fazer agora.</p></div></div>}
      {m.state === 'complete' && <div className="card good"><CheckCircle weight="fill" /><div><b>Pronta</b><p>{m.stories.length} parte(s) provadas, revisadas e commitadas na sua pasta.{m.plan?.needs_ui ? ' Abra o app pelo botão no topo.' : ''}</p></div></div>}
      {m.state === 'discarded' && <div className="card"><Trash /><div><b>Descartada</b><p>Os arquivos voltaram ao que eram.</p></div></div>}
      {m.state === 'awaiting_plan' && (
        <>
          <div className="card warn"><ListChecks weight="fill" /><div><b>{m.reason === 'questions' ? 'A IA tem uma dúvida' : 'Plano pronto para aprovar'}</b><p>{REASON[m.reason]} Veja a aba Plano.</p></div></div>
          {m.reason === 'questions' ? (
            <Interview questions={m.plan.questions} onAnswer={(answers) => decide('answer', { answers })} onSkip={() => decide('start')} />
          ) : (
            <>
              {m.plan.explanation && <div className="explain"><b>Em palavras simples</b><p style={{ whiteSpace: 'pre-line', margin: '6px 0 0' }}>{m.plan.explanation}</p></div>}
              <div className="decide"><button className="act primary" onClick={() => decide('start')}><Play weight="fill" /><span><b>Começar</b><small>{m.stories.length} parte(s), uma de cada vez.</small></span></button></div>
              <textarea className="ta" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Quer mudar algo? Escreva do seu jeito: tirar uma parte, juntar, trocar cores, adicionar…" />
              <div className="decide"><button className="act" disabled={!answer.trim()} onClick={() => { decide('revise', answer); setAnswer('') }}><ArrowCounterClockwise /><span><b>Pedir mudanças</b><small>O planejador refaz o plano com o seu pedido e você confere de novo.</small></span></button><button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar plano</b></span></button></div>
            </>
          )}
        </>
      )}
      {m.state === 'awaiting_operator' && (
        <>
          <div className="card warn"><Warning weight="fill" /><div><b>Precisa de você</b><p>{REASON[m.reason] || m.reason}</p></div></div>
          <div className="decide">
            <button className="act primary" onClick={() => decide('accept')}><CheckCircle weight="fill" /><span><b>Aceitar como está</b><small>Commita esta parte e segue para a próxima.</small></span></button>
            <button className="act" onClick={() => decide('retry')}><ArrowCounterClockwise /><span><b>Mais uma rodada</b><small>A IA recebe os problemas e tenta de novo.</small></span></button>
            <button className="act" onClick={() => decide('skip')}><SkipForward /><span><b>Pular esta parte</b><small>Desfaz só ela e segue.</small></span></button>
            <button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar tudo</b><small>Volta os arquivos ao que eram.</small></span></button>
          </div>
        </>
      )}
      {st?.review && <div className="block"><span className="lbl">O revisor disse</span><p>{st.review.summary}</p></div>}
      {allSkills(m).length > 0 && <div className="block"><span className="lbl">Skills nesta missão</span><div className="chips">{allSkills(m).map((x) => <span key={x.role + x.id} className="chip-skill on" title={x.reason}>{x.id}<small>{ROLES_PT[x.role]}</small></span>)}</div></div>}
      {m.roles && <div className="block"><span className="lbl">Quem fez</span><p className="small">{m.roles.intent?.model || m.roles.planner.model} entendeu · {m.roles.planner.model} planejou · {m.roles.maker.model} escreveu · {m.roles.checker.model} revisou</p></div>}
    </div>
  )
}
