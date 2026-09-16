import { useEffect, useMemo, useRef, useState } from 'react'
import { Switch } from '@radix-ui/themes'
import {
  ArrowSquareOut, ArrowLeft, ArrowCounterClockwise, Play, Pause, Trash, SkipForward, CheckCircle, XCircle, Warning,
  Circle, CircleDashed, CaretRight, GitDiff, GitCommit, FolderSimple, FolderOpen, ClockCounterClockwise, GearSix,
  Sparkle, UserCircle, Cpu, MagnifyingGlass, Plus, Paperclip, File as FileIcon, X, NotePencil, ListChecks,
  TestTube, Wrench, Eye, ShieldCheck, ListBullets, Terminal, ImageSquare, Compass, Table, Storefront, List,
} from '@phosphor-icons/react'

/* ========================= textos e mapas ========================= */
const ROLES_PT = { planner: 'planejador', maker: 'maker', checker: 'revisor', research: 'pesquisador' }
const skillsByRole = (m) => !m?.skills ? {} : Array.isArray(m.skills) ? { maker: m.skills } : m.skills
const allSkills = (m) => Object.entries(skillsByRole(m)).flatMap(([role, list]) => (Array.isArray(list) ? list : []).map((x) => ({ ...x, role })))

const STEP = {
  intent: { title: 'Entender o pedido', help: 'Uma IA lê o seu pedido, decide o tamanho, os domínios e quais skills cada papel (planejador, maker, revisor, pesquisador) vai receber.' },
  plan: { title: 'Montar o plano', help: 'O planejador, já com as skills dele, explora o projeto e divide o trabalho em partes, cada uma com critérios de aceite e como provar.' },
  research: { title: 'Pesquisar fatos', help: 'Só quando o plano depende de algo externo, como a versão de uma API ou uma regra pública. A busca responde com fontes.' },
  prepare: { title: 'Conferir o projeto', help: 'Roda o que o projeto já tem de verificação, para saber o ponto de partida.' },
  assets: { title: 'Gerar imagens', help: 'Quando o plano pede fotos ou ilustrações, a segunda IA gera as imagens e salva no projeto antes de qualquer parte começar.' },
  test: { title: 'Prova', help: 'Uma "prova" é um mini-programa que checa se o que você pediu funciona. A IA escreve só isso, sem mexer no código ainda.' },
  red: { title: 'Falha antes', help: 'A ADE roda a prova ANTES de qualquer mudança. Ela tem de falhar, porque o que você pediu ainda não existe. Se passasse agora, a prova estaria checando a coisa errada.' },
  fix: { title: 'Implementar', help: 'Só agora a IA muda o código, seguindo as skills ativas, o mínimo para a prova passar e os critérios valerem.' },
  tests: { title: 'Passa depois', help: 'Roda a prova de novo. Agora ela tem de passar. Falhou antes e passou depois: é isso que garante que funciona.' },
  visual: { title: 'Visual', help: 'Quando há interface, um detector varre o código atrás de cara de template: cores gritantes, fontes batidas, layout genérico. Se achar algo, a IA faz uma rodada de retoque.' },
  checker: { title: 'Revisão', help: 'Uma IA de outra empresa lê a mudança e aprova ou aponta problemas. Quem escreve nunca é quem aprova.' },
  commit: { title: 'Commit', help: 'Com a prova verde e o revisor de acordo, a ADE grava a mudança no histórico da sua pasta. Dá para voltar atrás depois.' },
}
const STORY_FLOW = [
  { name: 'test', icon: TestTube }, { name: 'red', icon: XCircle }, { name: 'fix', icon: Wrench },
  { name: 'tests', icon: CheckCircle }, { name: 'visual', icon: Eye }, { name: 'checker', icon: ShieldCheck },
  { name: 'commit', icon: GitCommit },
]
const STATUS_PT = { pending: 'ainda não', running: 'fazendo agora', done: 'feito', failed: 'deu problema', warn: 'com avisos', skipped: 'pulado' }
const STATE = {
  planning: { label: 'Entendendo o pedido', tone: 'accent' },
  awaiting_plan: { label: 'Plano pronto', tone: 'warn' },
  running: { label: 'Em andamento', tone: 'accent' },
  awaiting_operator: { label: 'Precisa de você', tone: 'warn' },
  paused: { label: 'Pausada', tone: 'mute' },
  complete: { label: 'Pronta', tone: 'good' },
  discarded: { label: 'Descartada', tone: 'mute' },
}
const REASON = {
  tests_red: 'Alguma prova ficou vermelha depois da implementação.',
  no_red_test: 'A prova que a IA escreveu já passava no código antigo, ou ela não escreveu prova. Assim a prova não serve para garantir a mudança.',
  review_changes: 'A segunda IA pediu mudanças e quem escreve não conseguiu fechar em 4 rodadas.',
  review_failed: 'O revisor não respondeu. Veja o erro na atividade completa; "Mais uma rodada" tenta de novo.',
  budget: 'A missão passou do teto de gasto definido em Opções. Continue se quiser gastar mais, ou descarte.',
  skips: 'Duas partes seguidas foram puladas; as próximas dependem delas. Peça mudanças no plano ou mande um pedido menor.',
  no_changes: 'A IA não alterou nenhum arquivo.',
  engine_error: 'O motor falhou. Veja a atividade completa.',
  plan_failed: 'Não deu para transformar o pedido em plano. Reescreva o pedido com mais contexto.',
  approve_plan: 'O plano tem várias partes. Confira e aprove.',
  questions: 'A IA precisa de uma resposta sua antes de começar.',
}
const COMPLEXITY_PT = { trivial: 'pedido pequeno', bounded: 'pedido curto', feature: 'funcionalidade', subsystem: 'trabalho grande' }
const ROLE_CARD = {
  intent: { label: 'Entender o pedido', icon: Compass, note: 'Lê o que você escreveu, mede o tamanho e escolhe as skills de cada papel.' },
  planner: { label: 'Planejar', icon: ListChecks, note: 'Divide o trabalho em partes, com critérios de aceite e como provar cada uma.' },
  maker: { label: 'Escrever código e provas', icon: Wrench, note: 'Escreve a prova primeiro e depois o código que faz a prova passar.' },
  checker: { label: 'Revisar', icon: ShieldCheck, note: 'De outra empresa. Lê a mudança e aprova ou aponta problemas. Quem escreve nunca aprova.' },
  research: { label: 'Pesquisar fatos', icon: MagnifyingGlass, note: 'Busca na internet quando o plano depende de uma informação de fora.' },
}
const PAGE_TITLE = { skills: 'Skills', models: 'Modelos', history: 'Pedidos anteriores', projects: 'Projetos', options: 'Opções' }
const SUGGESTIONS = [
  { icon: Table, text: 'Crie uma planilha financeira de gastos pessoais, com categorias, total por mês e visual profissional.' },
  { icon: Storefront, text: 'Crie a página inicial de um site de uma cafeteria, com cardápio, horário e um formulário de reserva.' },
  { icon: ListBullets, text: 'Crie uma lista de tarefas com prioridade e filtro, salvando no navegador.' },
]

/* ========================= helpers ========================= */
const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0)
const fmtUsd = (n) => `US$ ${(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''
const fmtHour = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
// arquivos do projeto: com vários projetos abertos o mesmo caminho existe em pastas diferentes, então o dir vai na URL
const appUrl = (rel, dir, extra) => `/api/app/${rel}?${new URLSearchParams({ ...(dir ? { dir } : {}), ...(extra || {}) })}`
const folderName = (dir) => (dir || '').split(/[\\/]/).filter(Boolean).pop() || dir || ''
const secsBetween = (a, b) => Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000))
const missionStep = (m, name) => (m?.steps || []).find((x) => x.name === name)
const tail = (text, n = 2) => (text || '').trim().split('\n').filter(Boolean).slice(-n).join(' ').slice(-200)
const cur = (m) => m && m.current != null ? m.stories[m.current] : (m?.stories?.find((s) => s.state === 'blocked') || null)

function storyStepStatus(st, name, m) {
  if (name === 'commit') return st.state === 'done' ? 'done' : st.state === 'skipped' ? 'skipped' : st.state === 'blocked' ? 'failed' : 'pending'
  if (name === 'visual' && !m?.plan?.needs_ui) return 'skipped'
  const hits = (st.steps || []).filter((x) => x.name === name)
  return hits.length ? hits[hits.length - 1].status : 'pending'
}
function storyStatusLine(st, m) {
  const r = st.round || 1
  if (st.state === 'queued') return 'Na fila. Começa assim que a parte anterior terminar.'
  if (st.state === 'skipped') return 'Você pulou esta parte. O que ela tinha mexido foi desfeito.'
  if (st.state === 'blocked') return REASON[m.reason] || 'Esta parte parou e precisa de você.'
  if (st.state === 'done') {
    const t = st.tests_after ? `${st.tests_after.total - st.tests_after.failed} de ${st.tests_after.total} provas passando` : 'provas verdes'
    const v = st.review?.verdict === 'approve' ? 'o revisor aprovou' : st.review ? 'o revisor pediu ajustes e a IA atendeu' : 'revisada'
    return `Pronta em ${r} rodada${r > 1 ? 's' : ''}: ${t}, ${v} e a mudança foi gravada na sua pasta.`
  }
  const doing = [...(st.steps || [])].reverse().find((x) => x.status === 'running')
  const busy = {
    test: 'a IA está escrevendo a prova',
    red: 'a ADE está rodando a prova no código antigo, ela tem de falhar agora',
    fix: 'a IA está mudando o código',
    tests: 'a ADE está rodando as provas outra vez',
    visual: 'o detector está conferindo o visual',
    checker: 'a segunda IA está revisando a mudança',
  }[doing?.name] || 'preparando esta parte'
  return r > 1 ? `Rodada ${r} de 4: o revisor pediu mudanças e ${busy}.` : `${busy[0].toUpperCase()}${busy.slice(1)}.`
}
function storySummary(st) {
  const bits = []
  bits.push(`${st.round || 1} rodada${(st.round || 1) > 1 ? 's' : ''}`)
  if (st.tests_after) bits.push(`${st.tests_after.total - st.tests_after.failed}/${st.tests_after.total} provas`)
  if (st.review) bits.push(st.review.verdict === 'approve' ? 'aprovada' : 'com ajustes')
  if (st.state === 'skipped') bits.push('pulada')
  return bits.join(' · ')
}

const pendingDecision = (m) => !m ? null : m.state === 'awaiting_plan' ? (m.reason === 'questions' ? 'questions' : 'plan') : m.state === 'awaiting_operator' ? 'operator' : null
const PENDING_WHY = {
  questions: 'A IA quer saber como você prefere o programa antes de montar o plano.',
  plan: 'O plano está pronto. Confira as partes e diga se pode começar.',
}

/* ========================= app ========================= */
export default function App() {
  const [state, setState] = useState({ dir: null, project: null, mission: null, log: [], history: [], live: null, recent: [], settings: null, catalog: [], registry: {}, attachments: [], engines: [] })
  const [request, setRequest] = useState('')
  const [menu, setMenu] = useState(false)
  const [attachErr, setAttachErr] = useState(null)
  const [connected, setConnected] = useState(false)
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [nav, setNav] = useState(false)
  const [side, setSide] = useState(false)
  const [cleared, setCleared] = useState(null)
  const [resumeErr, setResumeErr] = useState(null)
  const ask = useRef(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true); es.onerror = () => setConnected(false)
    es.onmessage = (e) => setState(JSON.parse(e.data))
    return () => es.close()
  }, [])

  const m = state.mission, p = state.project, s = state.settings
  const busy = !!m && ['running', 'planning'].includes(m.state)
  const live = !!m && !['complete', 'discarded'].includes(m.state)
  const shown = m && m.id !== cleared ? m : null
  const need = pendingDecision(shown)
  const paused = shown?.state === 'paused'
  // servidor antigo não manda engines: lista vazia, e a seção "Em andamento" some
  const engines = state.engines || []
  const withMission = engines.filter((e) => e.mission)

  useEffect(() => { if (m?.id && m.id !== cleared) setCleared(null) }, [m?.id])
  useEffect(() => { document.title = need ? '● TL-ADE' : 'TL-ADE' }, [need])
  useEffect(() => { if (need || paused) setSide(true) }, [need, paused])

  async function attachFiles(payload) { setAttachErr(null); const r = await post('/api/attach', { ...payload, dir: state.dir }); if (!r.ok) { const j = await r.json().catch(() => ({})); setAttachErr(j.error || 'Não anexou.') } }
  async function pick(kind) {
    setMenu(false)
    const r = await post('/api/pick', { kind }); const j = await r.json().catch(() => ({})); const paths = j.paths || []
    if (!paths.length) return
    if (kind === 'folder') { const pr = await post('/api/project', { dir: paths[0] }); if (!pr.ok) { const e = await pr.json().catch(() => ({})); setError(e.error || 'Não abriu a pasta.') } else { setPage(null); setError(null) } }
    else await attachFiles({ paths })
  }
  async function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])]; if (!files.length) return
    e.preventDefault()
    const encoded = await Promise.all(files.map((f) => new Promise((res) => {
      const rd = new FileReader()
      rd.onload = () => res({ name: f.name && f.name !== 'image.png' ? f.name : `colado-${Date.now().toString(36)}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, data: rd.result })
      rd.readAsDataURL(f)
    })))
    await attachFiles({ files: encoded })
  }
  // rascunho do pedido por pasta: o que você escreveu não some ao trocar de pasta nem ao recarregar
  const draftKey = (d) => 'ade.draft.' + (d || '')
  const dirRef = useRef(state.dir)
  useEffect(() => {
    if (dirRef.current !== state.dir) { try { localStorage.setItem(draftKey(dirRef.current), request) } catch {} dirRef.current = state.dir }
    try { const saved = localStorage.getItem(draftKey(state.dir)); if (saved != null && saved !== request) setRequest(saved) } catch {}
  }, [state.dir]) // eslint-disable-line
  useEffect(() => { try { if (state.dir !== undefined) localStorage.setItem(draftKey(state.dir), request) } catch {} }, [request]) // eslint-disable-line
  const [dirtyReq, setDirtyReq] = useState(null) // pedido que esbarrou em alterações pendentes; "Commitar e continuar" reenvia com commit_first
  async function run(text, opts = {}) {
    const req = (text ?? request).trim()
    if (!req || busy) return
    setPage(null); setError(null); setCleared(null); setRequest(''); setDirtyReq(null)
    const r = await post('/api/run', { request: req, dir: state.dir, ...(opts.commitFirst ? { commit_first: true } : {}) })
    if (!r.ok) {
      const j = await r.json().catch(() => ({})); setRequest(req)
      if (j.code === 'dirty') { setDirtyReq(req); setError(j.error); return }
      setError(j.error || 'Não deu para começar.'); if (/git|pasta/i.test(j.error || '')) setPage('projects'); if (/Modelos/.test(j.error || '')) setPage('models')
    }
  }
  const decide = (option, extra) => post('/api/decide', typeof extra === 'object' ? { option, ...extra, dir: state.dir } : { option, text: extra, dir: state.dir })
  async function pause() {
    const r = await post('/api/pause', { dir: state.dir })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || 'Não deu para pausar.') }
  }
  async function resume(body) {
    setResumeErr(null)
    const r = await post('/api/resume', body)
    if (r.ok) { setPage(null); setError(null); setCleared(null); return }
    const j = await r.json().catch(() => ({}))
    setResumeErr({ key: body.id || body.dir, error: j.error || 'Não deu para continuar.' })
  }
  const save = (patch) => post('/api/settings', patch)
  const go = (name) => { setPage(name); setNav(false); setDrawer(false) }
  function novoPedido() {
    setPage(null); setNav(false); setError(null)
    if (m) setCleared(m.id)
    setTimeout(() => ask.current?.focus(), 30)
  }

  const showSide = !page && !!shown
  return (
    <div className={`shell${showSide ? ' has-side' : ''}`}>
      {nav && <button className="scrim" aria-label="Fechar o menu" onClick={() => setNav(false)} />}
      <nav className={`sidebar${nav ? ' open' : ''}`} aria-label="Navegação">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><Sparkle weight="fill" /></span><span className="brand-name">TL-ADE</span><span className="brand-tag">demonstração</span></div>

        <button className="new-req" onClick={novoPedido} disabled={live}><NotePencil weight="bold" /> Novo pedido</button>
        {need && <button className="need-badge" onClick={() => { setPage(null); setSide(true); setNav(false) }}><Warning weight="fill" /> 1 decisão esperando você</button>}

        <div className="side-block">
          <span className="side-lbl">Projeto</span>
          <button className="proj-card" onClick={() => go('projects')} title={p?.dir || 'escolha uma pasta'}>
            <span className="proj-ico"><FolderSimple weight="fill" /></span>
            <span className="proj-txt">
              <b>{p?.name || 'Nenhuma pasta'}</b>
              <small>{p ? `${p.branch || 'sem histórico'} · ${p.runner === 'none' ? 'sem provas' : p.runner}` : 'escolha uma pasta'}</small>
            </span>
            <span className="proj-swap">trocar</span>
          </button>
          <button className="proj-add" onClick={() => pick('folder')}><Plus weight="bold" /> Abrir outra pasta</button>
          <p className="side-tip">Abrir outra pasta não interrompe a missão desta: as duas rodam ao mesmo tempo.</p>
        </div>

        {engines.length > 1 && (
          <div className="side-block">
            <span className="side-lbl">Pastas abertas</span>
            <div className="side-hist eng-list">
              {engines.map((e) => {
                const es = e.mission ? (STATE[e.mission.state] || { label: e.mission.state, tone: 'mute' }) : { label: 'sem pedido', tone: 'mute' }
                return (
                  <button key={e.dir} className={`hist-item${e.active ? ' now' : ''}`} onClick={() => post('/api/select', { dir: e.dir })} title={e.dir}>
                    <span className="hist-top">
                      <span className="hist-title">{e.project?.name || folderName(e.dir)}</span>
                      <span className={`dot-${es.tone}${e.busy ? ' dot-live' : ''}`} aria-hidden="true">●</span>
                      <span role="button" tabIndex={0} className="eng-close" title={e.busy ? 'Pause antes de fechar' : 'Fechar esta pasta'} onClick={async (ev) => { ev.stopPropagation(); if (e.busy) return setError('Essa pasta tem um pedido rodando. Pause ou espere terminar antes de fechar.'); const hasM = e.mission && ['awaiting_plan', 'awaiting_operator', 'paused'].includes(e.mission.state); if (hasM && !window.confirm('Esta pasta tem um pedido esperando ou pausado. Ele fica salvo e você pode continuar depois pelo histórico. Fechar a pasta?')) return; const r = await post('/api/close', { dir: e.dir }); if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || 'Não deu para fechar.') } }}><X /></span>
                    </span>
                    <span className="hist-sub"><span>{e.mission ? (e.mission.plan?.title || e.mission.request) : (e.project ? `${e.project.branch || 'sem git'} · ${e.project.runner === 'none' ? 'sem provas' : e.project.runner}` : '')}</span><span>{es.label}</span></span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="side-block grow-block">
          <span className="side-lbl">Pedidos anteriores</span>
          <div className="side-hist">
            {state.history?.length ? state.history.slice(0, 7).map((h) => (
              <div key={h.id} className="hist-wrap">
                <button className={`hist-item${h.id === m?.id ? ' now' : ''}`} onClick={() => go('history')} title={h.request}>
                  <span className="hist-top"><span className="hist-title">{h.title || h.request}</span><span className={`dot-${STATE[h.state]?.tone || 'mute'}`} aria-hidden="true">●</span></span>
                  <span className="hist-sub"><span>{folderName(h.project)}</span><span className="mono">{fmtHour(h.finished_at)} · {fmtUsd(h.usd)}</span></span>
                </button>
                {h.resumable && h.id !== m?.id && <button className="mini hist-resume" onClick={() => resume({ id: h.id })}><Play weight="fill" /> Continuar</button>}
                {resumeErr?.key === h.id && <p className="hist-err">{resumeErr.error}</p>}
              </div>
            )) : <p className="side-none">Os pedidos que terminarem aparecem aqui.</p>}
            {state.history?.length > 7 && <button className="link side-more" onClick={() => go('history')}>ver todos os {state.history.length}</button>}
          </div>
        </div>

        <div className="side-foot">
          <div className="side-links">
            <button className={page === 'skills' ? 'on' : ''} onClick={() => go('skills')}><Sparkle /> Skills</button>
            <button className={page === 'models' ? 'on' : ''} onClick={() => go('models')}><Cpu /> Modelos</button>
            <button className={page === 'options' ? 'on' : ''} onClick={() => go('options')}><GearSix /> Opções</button>
          </div>
          <Quota q={state.quota} />
          <p className="side-status"><span className={connected ? 'ok' : 'bad'}>●</span> {connected ? 'servidor ligado' : 'sem servidor'}</p>
        </div>
      </nav>

      <main className="main">
        <header className="head">
          <button className="icon-btn only-narrow" onClick={() => setNav(true)} aria-label="Abrir o menu"><List /></button>
          {page ? (
            <><button className="ghost-btn" onClick={() => setPage(null)}><ArrowLeft /> Voltar</button><span className="head-title">{PAGE_TITLE[page]}</span></>
          ) : (
            <><span className="head-title">{shown ? (shown.plan?.title || 'Seu pedido') : 'Conversa'}</span>{shown && <MissionChip m={shown} />}</>
          )}
          <span className="grow" />
          {!page && shown && ['running', 'planning'].includes(shown.state) && (
            <button className="ghost-btn" onClick={pause} disabled={!!shown.pause_requested}><Pause weight="fill" /> {shown.pause_requested ? 'pausando…' : 'Pausar'}</button>
          )}
          {showSide && <button className={`ghost-btn only-mid${need ? ' warn' : ''}`} onClick={() => setSide(true)}><ListChecks /> Sua vez</button>}
          {!page && <button className={`ghost-btn${drawer ? ' on' : ''}`} onClick={() => setDrawer((v) => !v)}><Terminal /> Atividade completa</button>}
        </header>

        {error && <div className={'errbar' + (dirtyReq ? ' ask' : '')}><Warning weight="fill" /><span>{error}</span>
          {dirtyReq && <button className="btn primary sm" onClick={() => run(dirtyReq, { commitFirst: true })}>Commitar e continuar</button>}
          <button onClick={() => { setError(null); setDirtyReq(null) }} aria-label="Fechar"><X /></button></div>}

        {page ? (
          <div className="page">
            {page === 'skills' && <SkillsPage state={state} save={save} />}
            {page === 'models' && <ModelsPage state={state} save={save} />}
            {page === 'history' && <HistoryPage history={state.history} current={m} onResume={(id) => resume({ id })} err={resumeErr} />}
            {page === 'projects' && <ProjectsPage p={p} recent={state.recent} busy={busy} onChanged={() => { setPage(null); setError(null) }} />}
            {page === 'options' && <OptionsPage s={s} save={save} />}
          </div>
        ) : (
          <>
            {shown
              ? <Conversation state={state} m={shown} />
              : <Empty p={p} busy={busy} onPick={(t) => run(t)} />}

            <form className="composer" onSubmit={(e) => { e.preventDefault(); run() }} onDrop={(e) => { e.preventDefault(); onPaste({ clipboardData: e.dataTransfer, preventDefault() {} }) }} onDragOver={(e) => e.preventDefault()}>
              <div className="composer-inner">
                <div className="composer-box">
                  {(state.attachments?.length > 0 || attachErr) && (
                    <div className="attachments">
                      {state.attachments.map((a) => (
                        <span className="att-chip" key={a.name} title={a.path}>
                          {a.image ? <img src={appUrl(a.path, state.dir)} alt="" /> : <FileIcon />}
                          <span>{a.name}</span>
                          <button type="button" onClick={() => post('/api/attach/remove', { name: a.name, dir: state.dir })} aria-label={`Remover ${a.name}`}><X /></button>
                        </span>
                      ))}
                      {attachErr && <span className="att-chip bad">{attachErr}</span>}
                    </div>
                  )}
                  <div className="composer-row">
                    <div className="plus-wrap">
                      <button type="button" className="plus" aria-label="Anexar" onClick={() => setMenu((v) => !v)} disabled={live}><Plus weight="bold" /></button>
                      {menu && (
                        <div className="menu" onMouseLeave={() => setMenu(false)}>
                          <button type="button" onClick={() => pick('files')}><Paperclip /> Adicionar arquivos ou fotos <kbd>Ctrl+V</kbd></button>
                          <button type="button" onClick={() => pick('folder')}><FolderOpen /> Escolher a pasta do projeto</button>
                        </div>
                      )}
                    </div>
                    <textarea
                      ref={ask} className="ask" rows={1} value={request} disabled={live}
                      onChange={(e) => setRequest(e.target.value)} onPaste={onPaste}
                      onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px` }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() } }}
                      placeholder={busy ? 'Rodando… pause ou espere' : paused ? 'Missão pausada: continue ou descarte ao lado' : live ? 'Esperando a sua decisão ao lado' : p ? `O que construir em ${p.name}? Escreva do seu jeito; cole imagens com Ctrl+V.` : 'Escolha uma pasta primeiro, no botão +'}
                    />
                    <button className="run" type="submit" disabled={live || !request.trim()}>{busy ? 'Rodando' : 'Rodar'}</button>
                  </div>
                </div>
                {s && <p className="composer-hint"><span className="mono">{s.roles.planner.model}</span> planeja · <span className="mono">{s.roles.maker.model}</span> escreve · <span className="mono">{s.roles.checker.model}</span> revisa · comandos {s.allow_commands ? 'liberados' : 'bloqueados'}</p>}
              </div>
            </form>
          </>
        )}
      </main>

      {showSide && (
        <>
          {side && <button className="scrim side-scrim" aria-label="Fechar" onClick={() => setSide(false)} />}
          <aside className={`turn${side ? ' open' : ''}`} aria-label="Sua vez">
            <TurnPanel m={shown} state={state} decide={decide} need={need} onNew={novoPedido} onResume={() => resume({ dir: state.dir })} err={resumeErr && resumeErr.key === state.dir ? resumeErr.error : null} onClose={() => setSide(false)} />
          </aside>
        </>
      )}

      {drawer && !page && (
        <aside className="drawer" aria-label="Atividade completa">
          <div className="drawer-head"><Terminal /><b>Atividade completa</b><span className="grow" /><button className="icon-btn" onClick={() => setDrawer(false)} aria-label="Fechar"><X /></button></div>
          <div className="drawer-body"><Console log={state.log} busy={busy} live={state.live} /></div>
        </aside>
      )}
    </div>
  )
}

/* ========================= painel "Sua vez" ========================= */
function TurnPanel({ m, state, decide, need, onNew, onResume, err, onClose }) {
  const [text, setText] = useState('')
  const st = cur(m)
  const paused = m.state === 'paused'
  const why = need === 'operator' ? (REASON[m.reason] || m.reason) : PENDING_WHY[need]
  return (
    <>
      <div className={`turn-head${need ? ' hot' : ''}`}>
        <div className="turn-head-top">
          <span className="turn-ico" aria-hidden="true">{need ? <Warning weight="fill" /> : paused ? <Pause weight="fill" /> : <ListChecks />}</span>
          <b>{need ? 'Precisa de você' : paused ? 'Missão pausada' : 'Sua vez'}</b>
          <span className="grow" />
          <button className="icon-btn only-mid" onClick={onClose} aria-label="Fechar"><X /></button>
        </div>
        <p>{need ? why : paused ? 'A IA foi interrompida. A parte em andamento voltou para a fila e o que ela tinha mexido foi desfeito.' : 'Nada para decidir agora.'}</p>
      </div>

      <div className="turn-body">
        {need === 'questions' && <Interview questions={m.plan.questions} onAnswer={(answers) => decide('answer', { answers })} onSkip={() => decide('start')} />}

        {need === 'plan' && (
          <>
            <p className="turn-note">São {m.stories.length} parte{m.stories.length > 1 ? 's' : ''}, feitas uma de cada vez. Cada uma só é gravada depois de passar na prova e na revisão.</p>
            <div className="decide">
              <button className="act primary" onClick={() => decide('start')}><Play weight="fill" /><span><b>Começar</b><small>{m.stories.length} parte{m.stories.length > 1 ? 's' : ''}, uma de cada vez.</small></span></button>
            </div>
            <label className="field">
              <span className="field-lbl">Quer mudar algo?</span>
              <textarea className="ta" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva do seu jeito: tirar uma parte, juntar duas, trocar as cores, adicionar…" />
            </label>
            <div className="decide">
              <button className="act" disabled={!text.trim()} onClick={() => { decide('revise', text); setText('') }}><ArrowCounterClockwise /><span><b>Pedir mudanças</b><small>O planejador refaz e você confere de novo.</small></span></button>
              <button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar</b><small>Nada é alterado no projeto.</small></span></button>
            </div>
          </>
        )}

        {need === 'operator' && (
          <>
            {st && <p className="turn-note">Parada na parte {(m.stories.indexOf(st) + 1) || 1}: {st.title}.</p>}
            <div className="decide">
              <button className="act primary" onClick={() => decide('accept')}><CheckCircle weight="fill" /><span><b>Aceitar como está</b><small>Grava esta parte e segue para a próxima.</small></span></button>
              <button className="act" onClick={() => decide('retry')}><ArrowCounterClockwise /><span><b>Mais uma rodada</b><small>A IA recebe os problemas e tenta de novo.</small></span></button>
              <button className="act" onClick={() => decide('skip')}><SkipForward /><span><b>Pular esta parte</b><small>Desfaz só ela e segue.</small></span></button>
              <button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar tudo</b><small>Volta os arquivos ao que eram antes.</small></span></button>
            </div>
          </>
        )}

        {paused && (
          <>
            <div className="decide">
              <button className="act primary" onClick={onResume}><Play weight="fill" /><span><b>Continuar</b><small>Retoma da parte {(m.current ?? 0) + 1}, do começo dela.</small></span></button>
              <button className="act danger" onClick={() => decide('discard')}><Trash /><span><b>Descartar</b><small>Volta os arquivos ao que eram antes do pedido.</small></span></button>
            </div>
            {err && <p className="warn-box">{err}</p>}
          </>
        )}

        {!need && m.state === 'complete' && (
          <>
            <p className="turn-done"><CheckCircle weight="fill" /> Tudo pronto e gravado na sua pasta.</p>
            <div className="decide">
              {state.project?.has_index && <a className="act primary" href={appUrl('', state.dir)} target="_blank" rel="noreferrer"><ArrowSquareOut /><span><b>Abrir o app</b><small>Vê o resultado no navegador.</small></span></a>}
              <button className="act" onClick={onNew}><NotePencil /><span><b>Novo pedido</b><small>Começa outra coisa nesta pasta.</small></span></button>
            </div>
          </>
        )}

        {!need && m.state === 'discarded' && (
          <div className="decide"><button className="act" onClick={onNew}><NotePencil /><span><b>Novo pedido</b><small>Os arquivos voltaram ao que eram.</small></span></button></div>
        )}

        {!need && ['running', 'planning'].includes(m.state) && (
          <>
            <span className="side-lbl">O que a IA está fazendo</span>
            <p className="turn-live">{tail(state.live?.text, 3) || 'Começando…'}</p>
            {st && <p className="turn-note">Parte {m.current + 1} de {m.stories.length}: {st.title}.</p>}
          </>
        )}

        <div className="turn-nums">
          <div><span>Chamadas de IA</span><b className="mono">{m.cost.calls}</b></div>
          <div><span>Custo</span><b className="mono">{fmtUsd(m.cost.usd)}</b></div>
          <div><span>Tokens</span><b className="mono">{fmtTok(m.cost.tokens_in + m.cost.tokens_out)}</b></div>
          <div><span>Cache lido</span><b className="mono">{fmtTok(m.cost.cache_read || 0)}</b></div>
        </div>
      </div>
    </>
  )
}

/* ========================= peças de conversa ========================= */
function Ade({ time, children, kind = '' }) {
  return (
    <article className={`msg ade ${kind}`}>
      <div className="msg-who"><span className="av ade-av" aria-hidden="true"><Sparkle weight="fill" /></span><span className="who-name">TL-ADE</span>{time && <time className="mono">{fmtHour(time)}</time>}</div>
      <div className="msg-card">{children}</div>
    </article>
  )
}
function You({ time, children }) {
  return (
    <article className="msg you">
      <div className="msg-who"><span className="who-name">Você</span>{time && <time className="mono">{fmtHour(time)}</time>}<span className="av you-av" aria-hidden="true"><UserCircle weight="fill" /></span></div>
      <div className="msg-card">{children}</div>
    </article>
  )
}
const Typing = ({ live }) => (
  <div className="typing">
    <span className="dots" aria-hidden="true"><i /><i /><i /></span>
    <span className="typing-txt">{tail(live?.text) || 'trabalhando…'}</span>
  </div>
)
const Skeleton = ({ lines = 3 }) => <div className="skel" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${[92, 78, 64, 84][i % 4]}%` }} />)}</div>
const Chip = ({ children, tone = 'mute' }) => <span className={`chip tone-${tone}`}>{children}</span>
const STORY_CHIP = { done: 'pronta', running: 'em andamento', blocked: 'parou', skipped: 'pulada', queued: 'na fila' }
const STORY_TONE = { done: 'good', running: 'accent', blocked: 'warn', skipped: 'mute', queued: 'mute' }

function Fold({ title, icon, meta, tone, children, open: initial = false }) {
  const [open, setOpen] = useState(initial)
  return (
    <div className={`fold${open ? ' open' : ''}`}>
      <button type="button" className="fold-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <CaretRight className="fold-caret" aria-hidden="true" />
        <span className="fold-ico" aria-hidden="true">{icon}</span>
        <span className="fold-title">{title}</span>
        {meta && <span className={`fold-meta tone-${tone || 'mute'}`}>{meta}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

function MissionChip({ m }) {
  const s = STATE[m.state] || { label: m.state, tone: 'mute' }
  const [, tick] = useState(0)
  useEffect(() => { if (!['running', 'planning'].includes(m.state)) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [m.state])
  const secs = secsBetween(m.started_at, m.finished_at)
  return <span className="head-chip"><Chip tone={s.tone}>{s.label}</Chip><span className="mono dim small">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span></span>
}

/* ========================= a conversa ========================= */
function Conversation({ state, m }) {
  const end = useRef(null)
  const busy = ['running', 'planning'].includes(m.state)
  useEffect(() => { if (busy) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [m.state, m.current, state.log.length, busy])
  const intentStep = missionStep(m, 'intent')
  const assetsStep = missionStep(m, 'assets')
  const started = m.state !== 'awaiting_plan'
  const done = m.stories.filter((s) => s.state === 'done').length

  return (
    <div className="talk">
      <div className="talk-inner">
        <You time={m.started_at}>
          <p className="you-text">{m.request}</p>
          {m.attachments?.length > 0 && (
            <div className="thumbs">
              {m.attachments.map((a) => a.image
                ? <img key={a.name} src={appUrl(a.path, state.dir)} alt={a.name} title={a.name} />
                : <span key={a.name} className="thumb-file"><FileIcon /> {a.name}</span>)}
            </div>
          )}
        </You>

        {(m.intent || intentStep) && (
          <Ade>
            <h3 className="msg-h">Entendi o pedido</h3>
            {m.intent ? <>
              <p className="msg-p">{m.intent.summary}</p>
              <div className="chip-row">
                <Chip tone="accent">{COMPLEXITY_PT[m.intent.complexity] || m.intent.complexity}</Chip>
                {m.intent.needs_ui && <Chip>tem interface</Chip>}
                {(m.intent.domains || []).map((d) => <Chip key={d}>{d}</Chip>)}
              </div>
            </> : intentStep.status === 'running' ? <Skeleton lines={2} /> : null}
            {allSkills(m).length > 0 && (
              <Fold title="Ver as skills escolhidas" icon={<Sparkle />} meta={`${allSkills(m).length} manuais`}>
                {Object.entries(skillsByRole(m)).map(([role, list]) => (
                  <div key={role} className="role-line">
                    <span className="role-name">{ROLES_PT[role]}</span>
                    {list?.length ? <div className="chip-row">{list.map((x) => <span key={x.id} className="skill-chip" title={x.reason}>{x.id}<small>{x.reason}</small></span>)}</div> : <span className="dim small">nenhuma</span>}
                  </div>
                ))}
              </Fold>
            )}
            {intentStep?.status === 'running' && <Typing live={state.live} />}
          </Ade>
        )}

        {m.state === 'awaiting_plan' && m.reason === 'questions' && (
          <Ade kind="ask"><h3 className="msg-h">Tenho uma dúvida</h3><p className="msg-p">Antes de montar o plano, responda ao lado, no painel "Precisa de você". São perguntas de múltipla escolha e a primeira opção já é a recomendada.</p></Ade>
        )}

        {m.answers?.length > 0 && <You><p className="you-text">{m.answers.map((a) => a.answer).join(' · ')}</p></You>}
        {(m.plan_feedback || []).map((f, i) => <You key={i}><p className="you-text">{f}</p></You>)}

        {m.state === 'planning' && !m.plan && (
          <Ade><h3 className="msg-h">Montando o plano</h3><p className="msg-p">Estou lendo o projeto para dividir o trabalho em partes pequenas, cada uma com o que precisa valer no fim.</p><Skeleton /><Typing live={state.live} /></Ade>
        )}

        {m.plan && m.stories.length > 0 && (
          <Ade>
            <h3 className="msg-h">O plano</h3>
            {m.plan.explanation && <p className="msg-lead">{m.plan.explanation}</p>}
            {!started && (
              <ol className="plan-lines">
                {m.stories.map((s, i) => (
                  <li key={s.id}><span className="pl-n mono">{i + 1}</span><span className="pl-t">{s.title}</span><Chip tone={STORY_TONE[s.state]}>{STORY_CHIP[s.state]}</Chip></li>
                ))}
              </ol>
            )}
            {m.plan.assets?.length > 0 && !started && <Assets m={m} dir={state.dir} />}
          </Ade>
        )}

        {assetsStep && (
          <Ade>
            <h3 className="msg-h">Gerando as imagens</h3>
            <p className="msg-p">{(m.assets_done || []).length} de {m.plan?.assets?.length || 0} prontas. As imagens entram no projeto antes das partes começarem.</p>
            <Assets m={m} dir={state.dir} />
            {assetsStep.status === 'running' && <Typing live={state.live} />}
          </Ade>
        )}

        {started && m.stories.length > 0 && (
          <div className="story-stack">
            <span className="side-lbl">Partes · {done} de {m.stories.length} prontas</span>
            {m.stories.map((st, i) => ['running', 'blocked'].includes(st.state)
              ? <StoryCard key={st.id} st={st} i={i} m={m} state={state} />
              : <StoryRow key={st.id} st={st} i={i} m={m} state={state} />)}
          </div>
        )}

        {m.state === 'complete' && (
          <Ade kind="good" time={m.finished_at}>
            <h3 className="msg-h">Pronta</h3>
            <p className="msg-lead">{done} de {m.stories.length} parte{m.stories.length > 1 ? 's' : ''} provada{m.stories.length > 1 ? 's' : ''}, revisada{m.stories.length > 1 ? 's' : ''} e gravada{m.stories.length > 1 ? 's' : ''} na sua pasta.</p>
            <div className="final-grid">
              <div><span>Custo</span><b className="mono">{fmtUsd(m.cost.usd)}</b></div>
              <div><span>Chamadas de IA</span><b className="mono">{m.cost.calls}</b></div>
              <div><span>Tokens</span><b className="mono">{fmtTok(m.cost.tokens_in + m.cost.tokens_out)}</b></div>
              <div><span>Tempo</span><b className="mono">{Math.max(1, Math.round(secsBetween(m.started_at, m.finished_at) / 60))} min</b></div>
            </div>
            <p className="dim small">O que fazer agora está no painel ao lado.</p>
          </Ade>
        )}

        {m.state === 'paused' && (
          <Ade kind="mute" time={m.finished_at}>
            <h3 className="msg-h">Pausada</h3>
            <p className="msg-p">{m.stories.length
              ? `Continuar retoma da parte ${(m.current ?? 0) + 1}${m.stories[m.current ?? 0] ? `: ${m.stories[m.current ?? 0].title}` : ''}, do começo dela. O que ela tinha mexido foi desfeito; as partes já gravadas ficam como estão.`
              : 'Continuar retoma do ponto em que a IA parou. Nada ficou pela metade na sua pasta.'}</p>
          </Ade>
        )}

        {m.state === 'discarded' && (
          <Ade kind="mute"><h3 className="msg-h">Descartada</h3><p className="msg-p">Os arquivos voltaram ao que eram antes do pedido. Nada ficou pela metade.</p></Ade>
        )}

        <div ref={end} className="talk-end" />
      </div>
    </div>
  )
}

function Assets({ m, dir }) {
  const list = m.plan?.assets || []
  if (!list.length) return null
  return (
    <>
      {m.plan.assets_style && <p className="dim small">Direção de arte: {m.plan.assets_style}</p>}
      <div className="assets-grid">
        {list.map((a) => {
          const ok = (m.assets_done || []).some((d) => d.file === a.file)
          return (
            <figure key={a.file} className={ok ? 'done' : ''}>
              {ok ? <img src={appUrl(a.file, dir, { t: m.assets_done.length })} alt={a.purpose} /> : <div className="ph"><ImageSquare />{m.state === 'running' ? 'gerando…' : 'ainda não'}</div>}
              <figcaption><b className="mono">{a.file.replace('assets/img/', '')}</b><small>{a.purpose}</small></figcaption>
            </figure>
          )
        })}
      </div>
    </>
  )
}

/* ========================= uma parte do trabalho ========================= */
const STEP_ICON = {
  done: <CheckCircle weight="fill" />, failed: <XCircle weight="fill" />, warn: <Warning weight="fill" />,
  running: <Circle weight="fill" />, skipped: <CircleDashed />, pending: <Circle />,
}
function Stepper({ st, m }) {
  const [help, setHelp] = useState(null)
  return (
    <div className="stepper-wrap">
      <ol className="stepper">
        {STORY_FLOW.map((f) => {
          const status = storyStepStatus(st, f.name, m)
          const on = help === f.name
          return (
            <li key={f.name} className={`sp ${status}${on ? ' open' : ''}`}>
              <button type="button" className="sp-dot" onClick={() => setHelp(on ? null : f.name)} onMouseEnter={() => setHelp(f.name)} onMouseLeave={() => setHelp((h) => h === f.name ? null : h)} aria-label={`${STEP[f.name].title}: ${STATUS_PT[status]}`}>
                {STEP_ICON[status]}
              </button>
              <span className="sp-label">{STEP[f.name].title}</span>
            </li>
          )
        })}
      </ol>
      {help && <p className="sp-help"><b>{STEP[help].title}.</b> {STEP[help].help}</p>}
    </div>
  )
}
function StoryFolds({ st, m, state, i, open }) {
  const logs = useMemo(() => state.log.filter((l) => l.story === i), [state.log, i])
  return (
    <div className="story-folds">
      <Fold title="Provas" icon={<TestTube />} meta={st.tests_after ? `${st.tests_after.total - st.tests_after.failed}/${st.tests_after.total}` : null} tone={st.tests_after?.ok ? 'good' : st.tests_after ? 'bad' : 'mute'} open={open}>
        <Tests st={st} m={m} />
      </Fold>
      <Fold title="Alterações" icon={<GitDiff />} meta={st.diff ? `${(st.diff.match(/^diff --git/gm) || []).length} arquivo(s)` : null}>
        <Diff st={st} />
      </Fold>
      {m.plan?.needs_ui && (
        <Fold title="Visual" icon={<Eye />} meta={st.visual?.available ? `${st.visual.findings.length} achado(s)` : null} tone={st.visual?.findings?.length ? 'warn' : 'good'}>
          <Visual st={st} m={m} />
        </Fold>
      )}
      <Fold title="Revisão" icon={<ShieldCheck />} meta={st.review ? (st.review.verdict === 'approve' ? 'aprovado' : `${st.review.findings.length} ponto(s)`) : null} tone={st.review?.verdict === 'approve' ? 'good' : 'warn'} open={st.state === 'blocked'}>
        <Review st={st} />
      </Fold>
      <Fold title="Atividade desta parte" icon={<Terminal />} meta={logs.length ? `${logs.length} linhas` : null}>
        {logs.length ? <Console log={logs} busy={false} live={null} bare /> : <p className="hint">Ainda não há registro desta parte.</p>}
      </Fold>
    </div>
  )
}
function StoryCard({ st, i, m, state }) {
  return (
    <Ade kind={`story ${st.state}`}>
      <div className="story-head">
        <h3 className="msg-h">Parte {i + 1} · {st.title}</h3>
        <Chip tone={STORY_TONE[st.state]}>{STORY_CHIP[st.state]}</Chip>
      </div>
      <Stepper st={st} m={m} />
      <p className="story-line">{storyStatusLine(st, m)}</p>
      {st.state === 'running' && <Typing live={state.live} />}
      <StoryFolds st={st} m={m} state={state} i={i} open={st.state === 'running'} />
    </Ade>
  )
}
function StoryRow({ st, i, m, state }) {
  const [open, setOpen] = useState(false)
  const can = st.state !== 'queued'
  return (
    <div className={`st-row ${st.state}${open ? ' open' : ''}`}>
      <button className="st-row-head" onClick={() => can && setOpen((v) => !v)} aria-expanded={open} disabled={!can}>
        <span className="st-mark" aria-hidden="true">{st.state === 'done' ? <CheckCircle weight="fill" /> : st.state === 'skipped' ? <SkipForward /> : <Circle />}</span>
        <span className="st-n mono">{i + 1}</span>
        <span className="st-txt"><b>{st.title}</b>{can && <small>{storySummary(st)}</small>}</span>
        <Chip tone={STORY_TONE[st.state]}>{STORY_CHIP[st.state]}</Chip>
        {can && <CaretRight className="st-caret" aria-hidden="true" />}
      </button>
      {open && (
        <div className="st-row-body">
          <Stepper st={st} m={m} />
          <p className="story-line">{storyStatusLine(st, m)}</p>
          <StoryFolds st={st} m={m} state={state} i={i} open={false} />
        </div>
      )}
    </div>
  )
}

/* ========================= entrevista ========================= */
function Interview({ questions, onAnswer, onSkip }) {
  const qs = (questions || []).map((q, i) => typeof q === 'string' ? { id: `q${i + 1}`, question: q, why: '', options: [], allow_other: true } : q)
  const [picked, setPicked] = useState(() => Object.fromEntries(qs.map((q) => [q.id, q.options?.[0]?.label || ''])))
  const [other, setOther] = useState({})
  const answers = qs.map((q) => ({ id: q.id, question: q.question, answer: picked[q.id] === '__other' ? (other[q.id] || '').trim() : picked[q.id] }))
  const ready = answers.every((a) => a.answer)
  return (
    <>
      <p className="dim small">A primeira opção é sempre a recomendada. Não sabe? Deixe como está.</p>
      {qs.map((q) => (
        <div className="q-card" key={q.id}>
          <b>{q.question}</b>{q.why && <small className="dim"> {q.why}</small>}
          {q.options.map((o, i) => (
            <label className={'q-opt' + (picked[q.id] === o.label ? ' on' : '')} key={o.label}>
              <input type="radio" name={q.id} checked={picked[q.id] === o.label} onChange={() => setPicked({ ...picked, [q.id]: o.label })} />
              <span><b>{o.label}{i === 0 && <em>recomendado</em>}</b><small>{o.hint}</small></span>
            </label>
          ))}
          {q.allow_other && (
            <label className={'q-opt' + (picked[q.id] === '__other' ? ' on' : '')}>
              <input type="radio" name={q.id} checked={picked[q.id] === '__other'} onChange={() => setPicked({ ...picked, [q.id]: '__other' })} />
              <span><b>Outro</b><input className="ta" value={other[q.id] || ''} onFocus={() => setPicked({ ...picked, [q.id]: '__other' })} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} placeholder="Escreva do seu jeito" /></span>
            </label>
          )}
        </div>
      ))}
      <div className="decide two">
        <button className="act primary" disabled={!ready} onClick={() => onAnswer(answers)}><CheckCircle weight="fill" /><span><b>Responder e montar o plano</b><small>O planejador usa as suas escolhas.</small></span></button>
        <button className="act" onClick={onSkip}><Play weight="fill" /><span><b>Seguir com as recomendações</b><small>A IA escolhe por você.</small></span></button>
      </div>
    </>
  )
}

/* ========================= provas, alterações, visual, revisão ========================= */
const Hint = ({ children }) => <p className="hint">{children}</p>
const Result = ({ s }) => !s ? <span className="dim small">não existia</span> : <span className={`res ${s === 'passed' ? 'ok' : 'bad'}`}>{s === 'passed' ? 'passou' : 'falhou'}</span>

function Tests({ st, m }) {
  if (!st?.tests_after) return <Hint>{m.tests_before ? `Ponto de partida: ${m.tests_before.total} provas, ${m.tests_before.failed} falhando. As provas desta parte rodam antes e depois da mudança.` : 'As provas rodam antes e depois da mudança.'}</Hint>
  const before = new Map((m.tests_before?.tests || []).map((t) => [t.name, t.status]))
  return (
    <>
      <p className="msg-p">A IA escreve a prova primeiro. Ela tem de falhar no código antigo e passar no código novo.</p>
      {st.tests_after?.error && <p className="bad-box mono">{st.tests_after.error}</p>}
      <table className="tbl"><thead><tr><th>Prova</th><th>Antes</th><th>Depois</th></tr></thead><tbody>
        {st.tests_after.tests.map((t) => { const b = before.get(t.name); return (
          <tr key={t.name}><td><span className="mono">{t.name}</span>{!b && <span className="new">nova</span>}{t.message && <span className="dim small block">{t.message}</span>}</td><td><Result s={b} /></td><td><Result s={t.status} /></td></tr>
        ) })}
      </tbody></table>
      <Hint>{st.red_tests?.length ? `Prova que falhou antes e serve de evidência: ${st.red_tests.map((t) => t.name).join(', ')}.` : 'Nenhuma prova nova falhou antes da mudança.'}</Hint>
    </>
  )
}
function Diff({ st }) {
  const diff = st?.diff
  if (!diff) return <Hint>Sem alterações nesta parte. Elas aparecem aqui assim que a IA mexer em algum arquivo.</Hint>
  const files = []
  for (const l of diff.split('\n')) { if (l.startsWith('diff --git')) files.push({ name: l.split(' b/')[1] || l, lines: [] }); else if (files.length) files[files.length - 1].lines.push(l) }
  return <>{files.map((f) => (
    <section key={f.name} className="file">
      <div className="file-head"><GitDiff size={14} /><span className="mono">{f.name}</span><span className="grow" /><span className="mono add">+{f.lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length}</span><span className="mono del">-{f.lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}</span></div>
      <pre>{f.lines.filter((l) => !/^(index|---|\+\+\+)/.test(l)).slice(0, 400).map((l, i) => <span key={i} className={l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c'}>{l || ' '}</span>)}</pre>
    </section>
  ))}</>
}
function Visual({ st, m }) {
  if (!m.plan?.needs_ui) return <Hint>Este pedido não tem interface, então o detector visual não roda.</Hint>
  if (!st?.visual) return <Hint>O detector roda depois que as provas passam. Ele varre o código atrás de cara de template: fontes batidas, cores gritantes, três cards iguais.</Hint>
  if (!st.visual.available) return <Hint>O detector visual não foi encontrado nesta máquina.</Hint>
  return (
    <>
      <p className="dim small">{st.visual.findings.length} achado(s){st.visual.error ? ` · ${st.visual.error}` : ''}</p>
      {st.visual.findings.length === 0
        ? <p className="good-box">Nenhum sinal de template. O visual passou.</p>
        : st.visual.findings.map((f, i) => <div key={i} className="finding medium"><div className="finding-head"><span className="sev">{f.rule}</span><span className="mono small">{f.file}{f.line ? `:${f.line}` : ''}</span></div><p>{f.message}</p></div>)}
    </>
  )
}
function Review({ st }) {
  const review = st?.review
  if (!review) return <Hint>A revisão pela segunda IA roda depois que a prova passa e o visual é conferido.</Hint>
  return (
    <>
      <div className="verdict"><Chip tone={review.verdict === 'approve' ? 'good' : 'warn'}>{review.verdict === 'approve' ? 'Aprovado' : 'Pediu mudanças'}</Chip><span className="dim small">segunda IA, só leitura</span></div>
      <p className="msg-p">{review.summary}</p>
      {review.findings.length === 0 ? <Hint>Nenhum problema apontado.</Hint> : review.findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}><div className="finding-head"><span className="sev">{({ high: 'grave', medium: 'médio', low: 'leve' })[f.severity] || f.severity}</span><span className="mono small">{f.file}</span></div><p>{f.problem}</p><p className="dim">Sugestão: {f.fix}</p></div>
      ))}
    </>
  )
}

function Console({ log, busy, live, bare }) {
  const end = useRef(null)
  const [thinking, setThinking] = useState(false)
  useEffect(() => { if (!bare) end.current?.scrollIntoView({ block: 'end' }) }, [log.length, live?.text?.length, bare])
  const groups = useMemo(() => {
    const out = []
    for (const l of log) { if (!thinking && l.kind === 'thinking') continue; const g = out[out.length - 1]; const key = `${l.phase}|${l.story}`; if (g && g.key === key) g.lines.push(l); else out.push({ key, phase: l.phase, story: l.story, lines: [l] }) }
    return out
  }, [log, thinking])
  const thoughts = log.filter((l) => l.kind === 'thinking').length
  return (
    <div className="console">
      <div className="console-bar"><span className="dim small">{bare ? 'O que as IAs fizeram nesta parte.' : 'Tudo que as IAs fazem, na ordem.'}</span><button className="link" onClick={() => setThinking((v) => !v)}>{thinking ? 'esconder pensamento' : `mostrar pensamento${thoughts ? ` (${thoughts})` : ''}`}</button></div>
      {groups.length === 0 && !busy && <p className="hint">Nada registrado ainda.</p>}
      {groups.map((g, gi) => (
        <section key={gi} className="phase">
          <div className="phase-head">{g.story != null && <span className="phase-n mono">P{g.story + 1}</span>}{STEP[g.phase]?.title || 'Motor'}</div>
          {g.lines.map((l, i) => <Line key={i} l={l} />)}
        </section>
      ))}
      {busy && <div className={`line live ${live?.kind || ''}`}><span className="who" data-src={live?.source || 'claude'}>{live ? ({ thinking: 'pensando', tool: 'ferramenta', text: 'escrevendo' })[live.kind] || 'fazendo' : 'trabalhando'}</span><span className="txt">{live?.text || '…'}<span className="cursor" /></span></div>}
      <div ref={end} />
    </div>
  )
}
function Line({ l }) {
  const who = l.kind === 'thinking' ? 'pensou' : l.kind === 'tool' ? 'fez' : l.kind === 'result' ? 'viu' : l.kind === 'error' ? 'erro' : l.source === 'engine' ? 'motor' : l.source
  return <div className={`line ${l.kind}`}><span className="who" data-src={l.source}>{who}</span><span className="txt">{l.text}</span><time>{l.ts.slice(11, 19)}</time></div>
}

/* ========================= vazio e cota ========================= */
function Empty({ p, busy, onPick }) {
  return (
    <div className="talk empty">
      <div className="empty-inner">
        <h1 className="empty-h">O que você quer construir{p ? <> em <span className="accent">{p.name}</span></> : ''}?</h1>
        <p className="empty-p">Escreva em português, do seu jeito: uma correção, uma tela, um app inteiro. A ADE entende o pedido, escolhe as skills, escreve as provas, implementa, confere o visual e manda outra IA revisar. Você só decide no fim.</p>
        <span className="side-lbl center-lbl">Experimente</span>
        <div className="sugs">
          {SUGGESTIONS.map(({ icon: Ico, text }) => (
            <button key={text} className="sug" onClick={() => onPick(text)} disabled={busy || !p}>
              <span className="sug-ico"><Ico weight="fill" /></span>
              <span className="sug-txt">{text}</span>
              <CaretRight className="sug-go" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
function Bar({ pct }) { return <span className="bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></span> }
function Quota({ q }) {
  const rows = [['Claude', q?.claude], ['Codex', q?.codex]]
  return (
    <div className="quota">
      <span className="side-lbl">Cota do plano</span>
      {rows.map(([name, v]) => (
        <div className="quota-row" key={name}>
          <span className="quota-top"><span>{name}</span>{v ? <span className="mono">{(v.five_hour || v.seven_day)?.used ?? 0}%</span> : <span className="dim small">sem leitura</span>}</span>
          {v && <Bar pct={(v.five_hour || v.seven_day)?.used ?? 0} />}
          {v && <span className="quota-note">{v.five_hour ? 'sessão de 5 h' : 'semana'} · lido {fmtWhen(v.at)}</span>}
        </div>
      ))}
    </div>
  )
}

/* ========================= páginas ========================= */
const Page = ({ title, note, children }) => (
  <div className="page-inner">
    <header className="page-head"><h1>{title}</h1>{note && <p>{note}</p>}</header>
    {children}
  </div>
)
const Card = ({ title, note, children, className = '' }) => (
  <section className={`card ${className}`}>
    {title && <header className="card-head"><h2>{title}</h2>{note && <p>{note}</p>}</header>}
    {children}
  </section>
)

function ModelsPage({ state, save }) {
  const { settings: s, registry } = state
  if (!s) return null
  return (
    <Page title="Modelos" note="Cada papel tem um modelo. Quem escreve e quem revisa têm de ser de empresas diferentes: é a regra que faz a revisão valer alguma coisa.">
      <div className="role-cards">
        {Object.entries(ROLE_CARD).map(([role, { label, icon: Ico, note }]) => (
          <Card key={role} className="role-card">
            <div className="role-card-top"><span className="role-ico"><Ico weight="fill" /></span><div><b>{label}</b><p>{note}</p></div></div>
            <select className="sel" aria-label={label} value={`${(s.roles[role] || {}).family || 'claude'}|${(s.roles[role] || {}).model || ''}`} onChange={(e) => { const [f, mo] = e.target.value.split('|'); save({ roles: { [role]: { family: f, model: mo } } }) }}>
              {Object.entries(registry).map(([fam, fr]) => <optgroup key={fam} label={fr.label}>{fr.models.map((mo) => <option key={mo.id} value={`${fam}|${mo.id}`}>{mo.label}{mo.note ? ` · ${mo.note}` : ''}</option>)}</optgroup>)}
            </select>
          </Card>
        ))}
      </div>
      <p className="page-foot">Fable é o mais forte e o mais caro, cerca de US$ 0,60 só de abertura por chamada. Use para planejar pedidos grandes, não para escrever código linha a linha.</p>
    </Page>
  )
}

function OptionsPage({ s, save }) {
  if (!s) return null
  const Row = ({ title, note, control }) => <div className="opt-row"><div className="opt-txt"><b>{title}</b><small>{note}</small></div><div className="opt-ctl">{control}</div></div>
  return (
    <Page title="Opções" note="Como a ADE se comporta enquanto trabalha por você.">
      <div className="opt-cards">
        <Card title="Autonomia" note="Quanto ela faz sozinha antes de te chamar.">
          <Row title="Deixar a IA rodar comandos" note="Instalar dependências, criar projeto. Desligue para ela só ler e editar arquivos." control={<Switch checked={s.allow_commands} onCheckedChange={(v) => save({ allow_commands: v })} />} />
          <Row title="Depois de 4 rodadas de revisão" note="Segue sozinha: com as provas verdes e nada grave, aceita e vai para a próxima parte. Para e pergunta: você decide." control={<select className="sel" value={s.autonomy || 'auto'} onChange={(e) => save({ autonomy: e.target.value })}><option value="auto">segue sozinha</option><option value="ask">para e pergunta</option></select>} />
          <Row title="Modo noturno (sem perguntar)" note="Responde a entrevista com as recomendações, aprova o plano sozinha e, se uma parte travar sem saída, pula a parte e segue. Para só se estourar o teto da missão ou der erro do motor." control={<Switch checked={!!s.unattended} onCheckedChange={(v) => save({ unattended: v })} />} />
          <Row title="Teto por missão (US$ no Claude)" note="Estourou: a missão pausa e espera você." control={<input className="ta" style={{ width: 80 }} type="number" min={5} step={5} value={s.max_usd_per_mission ?? 60} onChange={(e) => save({ max_usd_per_mission: Number(e.target.value) || 60 })} />} />
          <Row title="Faixa rápida para correções pequenas" note="Pedido curto do tipo corrija, ajuste, troque, em projeto existente: pula a entrevista e o plano e vai direto para prova, correção e revisão." control={<Switch checked={s.fast_lane !== false} onCheckedChange={(v) => save({ fast_lane: v })} />} />
        </Card>
        <Card title="Custo" note="O teto de gasto por parte do trabalho.">
          <Row title="Orçamento por parte" note="Estourou: sem novas rodadas. Com as provas verdes e nada grave, aceita e segue; senão para e pergunta." control={<label className="num"><span className="mono">US$</span><input className="ta" type="number" min={1} step={1} value={s.max_usd_per_story ?? 4} onChange={(e) => save({ max_usd_per_story: Number(e.target.value) || 4 })} /></label>} />
        </Card>
        <Card title="Entrevista e imagens" note="O que a ADE faz antes de começar a escrever código.">
          <Row title="Entrevista antes do plano" note="Perguntas fáceis de múltipla escolha para escolher o jeito do programa. Automática: só em pedidos médios e grandes." control={<select className="sel" value={s.interview || 'auto'} onChange={(e) => save({ interview: e.target.value })}><option value="auto">automática</option><option value="always">sempre</option><option value="never">nunca</option></select>} />
          <Row title="Conferência do visual" note="Varre a interface atrás de cara de template e força uma rodada de retoque." control={<Switch checked={s.visual_gate} onCheckedChange={(v) => save({ visual_gate: v })} />} />
          <Row title="Imagens geradas por IA" note="Quando o plano pede fotos ou ilustrações, a segunda IA gera antes das partes começarem. Consome cota dela." control={<Switch checked={s.assets_enabled !== false} onCheckedChange={(v) => save({ assets_enabled: v })} />} />
          <Row title="Pesquisa na internet" note="Só quando o plano depende de um fato de fora, como a versão de uma biblioteca." control={<Switch checked={s.research_enabled} onCheckedChange={(v) => save({ research_enabled: v })} />} />
        </Card>
      </div>
    </Page>
  )
}

function ProjectsPage({ p, recent, busy, onChanged }) {
  const [dir, setDir] = useState(p?.dir || '')
  const [msg, setMsg] = useState(null)
  async function choose(d) { setMsg(null); const r = await post('/api/project', { dir: d }); const j = await r.json().catch(() => ({})); if (!r.ok) return setMsg(j.error || 'Não abriu.'); setDir(j.dir); onChanged() }
  return (
    <Page title="Projetos" note="A ADE trabalha dentro de uma pasta do seu PC. Pasta vazia: a IA monta o projeto do zero.">
      {p && (
        <Card title={p.name} note={p.dir}>
          <div className="proj-grid">
            <div><span>Histórico</span><b>{p.git ? (p.dirty ? 'com alterações pendentes' : 'limpo') : 'ainda não iniciado'}</b></div>
            <div><span>Provas</span><b className="mono">{p.runner === 'none' ? 'nenhuma ainda' : p.test_cmd}</b></div>
            <div><span>Página</span><b>{p.has_index ? 'tem página inicial' : 'sem página'}</b></div>
          </div>
          {p.nested && <p className="dim small">Fica dentro de {p.root}; o histórico vai para lá, só com arquivos desta pasta.</p>}
          {!p.git && <button className="btn" disabled={busy} onClick={async () => { const r = await post('/api/project/git-init', {}); if (r.ok) setMsg('Histórico iniciado com um ponto de partida.') }}>Iniciar o histórico nesta pasta</button>}
          {p.git && p.dirty && <button className="btn" disabled={busy} onClick={async () => { const r = await post('/api/project/commit', { dir: p.dir }); const j = await r.json().catch(() => ({})); setMsg(r.ok ? 'Alterações pendentes commitadas; a pasta está limpa.' : (j.error || 'Não deu para commitar.')) }}>Commitar as alterações pendentes</button>}
        </Card>
      )}
      <Card title="Abrir outra pasta">
        <button className="btn primary big" type="button" onClick={async () => { const r = await post('/api/pick', { kind: 'folder' }); const j = await r.json().catch(() => ({})); if (j.paths?.[0]) choose(j.paths[0]) }}><FolderOpen weight="fill" /> Procurar no Explorer, ou criar uma pasta nova</button>
        <form className="dir-form" onSubmit={(e) => { e.preventDefault(); choose(dir) }}>
          <input className="ta" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\meus-projetos\minha-app" aria-label="Caminho da pasta" />
          <button className="btn" type="submit" disabled={!dir.trim()}>Usar</button>
        </form>
        <p className="dim small">Cole o caminho de qualquer pasta do seu PC. Se ela não existir, a ADE cria. A missão que estiver rodando na pasta atual continua ao fundo.</p>
        {msg && <p className="warn-box">{msg}</p>}
      </Card>
      {recent?.length > 0 && (
        <Card title="Recentes">
          <div className="rows">
            {recent.map((d) => (
              <button key={d} className="row" onClick={() => choose(d)} disabled={d === p?.dir}>
                <span className="row-ico"><FolderSimple weight="fill" /></span>
                <span className="row-txt"><b>{d.split(/[\\/]/).pop()}</b><small className="mono">{d}</small></span>
                {d === p?.dir ? <Chip tone="accent">atual</Chip> : <CaretRight className="row-go" />}
              </button>
            ))}
          </div>
        </Card>
      )}
    </Page>
  )
}

function HistoryPage({ history, current, onResume, err }) {
  if (!history?.length) return <Page title="Pedidos anteriores"><Card><p className="hint">Os pedidos que terminarem aparecem aqui, com o custo e o resultado.</p></Card></Page>
  return (
    <Page title="Pedidos anteriores" note={`${history.length} no total.`}>
      <Card>
        <div className="rows">
          {history.map((h) => (
            <div key={h.id} className={`row static${h.id === current?.id ? ' now' : ''}`}>
              <span className={`row-dot dot-${STATE[h.state]?.tone || 'mute'}`} aria-hidden="true" />
              <span className="row-txt">
                <b>{h.title || h.request}</b>
                <small>{folderName(h.project)} · {h.done ?? 0} de {h.stories || 0} parte(s) · {fmtWhen(h.finished_at)}</small>
                {err?.key === h.id && <small className="bad">{err.error}</small>}
              </span>
              <span className="row-end">
                {h.resumable && h.id !== current?.id && <button className="mini" onClick={() => onResume(h.id)}><Play weight="fill" /> Continuar</button>}
                <Chip tone={STATE[h.state]?.tone || 'mute'}>{STATE[h.state]?.label || h.state}</Chip>
                <span className="mono small dim">{fmtUsd(h.usd)}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </Page>
  )
}

function SkillsPage({ state, save }) {
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
    <Page title="Skills" note="Skills são manuais de qualidade que cada papel recebe junto com o pedido. A IA que entende o pedido escolhe as do planejador, do maker, do revisor e do pesquisador; o motor garante as regras fixas.">
      <Card title="Como são escolhidas">
        <div className="opt-row"><div className="opt-txt"><b>Escolha automática</b><small>Até {s.skills.max} no maker e 3 nos outros papéis, entregues inteiras. Desligue para usar só as que você fixar.</small></div><div className="opt-ctl"><Switch checked={s.skills.auto} onCheckedChange={(v) => save({ skills: { auto: v } })} /></div></div>
        {allSkills(m).length > 0 && <div className="chip-row">{allSkills(m).map((x) => <span key={x.role + x.id} className="skill-chip on" title={x.reason}>{x.id}<small>{ROLES_PT[x.role]} · {x.reason}</small></span>)}</div>}
      </Card>
      <Card title={`Catálogo · ${catalog.length}`}>
        <label className="search"><MagnifyingGlass /><input className="ta" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtrar pelo nome ou pela descrição" aria-label="Filtrar skills" /></label>
        <ul className="skill-list">
          {list.map((c) => {
            const forced = s.skills.forced.includes(c.id), excluded = s.skills.excluded.includes(c.id)
            return (
              <li key={c.id} className={`skill ${active.has(c.id) ? 'active' : ''} ${excluded ? 'off' : ''}`}>
                <button className="skill-name" onClick={() => show(c.id)}><span className="mono">{c.id}</span><span className="dim small mono">{c.source} · {(c.bytes / 4 / 1000).toFixed(1)}k tok</span></button>
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
      </Card>
    </Page>
  )
}
