import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { apiFetch, postJson, subscribeEvents } from './api.ts'
import ChatPanel from './Chat.tsx'
import IntakeFlow from './Intake.tsx'
import MissionScore from './Units.tsx'
import ModelsPage from './Models.tsx'
import OptionsPage from './Options.tsx'
import SkillsPage from './Skills.tsx'
import Appearance, { LIGHT_PALETTES, PALETTES, type Palette } from './Appearance.tsx'
import { EASE_OUT, scrollToTop } from './motion.ts'
import { shortPath } from './format.ts'
import { brl, elapsed } from './format.ts'

interface Project {
  id: string
  name: string
  path: string
  open: boolean
  active: boolean
  activity?: Activity
}

/** O que acontece agora no projeto (só nos abertos): vem de GET /api/projects. */
interface Activity {
  kind: 'waiting' | 'running' | 'done' | 'failed' | 'refused'
  stage?: 'interview' | 'briefing' | 'plan' | 'operator' | 'paused'
  mission_id: string
  request: string
  done?: number
  total?: number
  error?: string
}

const STAGE_LABEL = { interview: 'entrevista', briefing: 'briefing', plan: 'plano', operator: 'uma parte parou', paused: 'missão pausada' } as const

/** Linha de estado de um projeto: verbo curto, sem jargão; a cor e o ponto vêm da classe. */
function activityLine(a: Activity): string {
  if (a.kind === 'running') return a.total ? `Missão rodando · ${a.done ?? 0} de ${a.total} partes prontas` : 'Missão rodando'
  if (a.kind === 'waiting') return `Esperando você · ${STAGE_LABEL[a.stage ?? 'plan']}`
  if (a.kind === 'failed') return 'A última missão parou com erro'
  if (a.kind === 'refused') return 'O último pedido foi recusado'
  return 'A última missão terminou'
}

export interface ModelRef { family: string | null; model_id: string | null; effort?: string | null }
export interface MissionStory { id: string; title?: string; status?: string | null; reason?: string | null; calls?: number; cost?: number | null; maker?: ModelRef | string | null; models?: Record<string, ModelRef> }
export interface Mission {
  id: string
  status?: string
  title?: string
  intent?: string
  consumed_usd?: number | null
  started_at?: string | null
  finished_at?: string | null
  total_calls?: number
  by_company?: Array<{ family: string; calls: number; usd: number; unknown_cost_calls: number; minutes: number; roles: Record<string, number>; models: Record<string, number> }>
  stories?: MissionStory[]
  runtime_state?: string
  current_story?: string | null
  takeover?: { active: boolean; intervention_needed: boolean }
}

interface Snapshot {
  missions: Mission[]
  selectedMission: Mission | null
}

type Page = 'home' | 'projects' | 'models' | 'skills' | 'options' | 'appearance'

const PALETTE_KEY = 'ade.palette'

/** Lê uma preferência guardada; armazenamento bloqueado ou valor estranho devolve o padrão, sem lembrar a escolha. */
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    if (saved && (allowed as readonly string[]).includes(saved)) return saved as T
  } catch {
    // armazenamento bloqueado: fica o padrão
  }
  return fallback
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function App() {
  const [palette, setPalette] = useState<Palette>(() => readPref<Palette>(PALETTE_KEY, PALETTES.map((p) => p.id), 'cobalto'))
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [snapshot, setSnapshot] = useState<{ projectId: string; data: Snapshot } | null>(null)
  const [page, setPage] = useState<Page>('home')
  // missão anterior aberta pelo histórico (null: a atual)
  const [pastId, setPastId] = useState<string | null>(null)
  // trocar de página começa do topo, não da altura em que a outra estava
  useEffect(() => { scrollToTop() }, [page])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = LIGHT_PALETTES.includes(palette) ? 'light' : 'dark'
    root.dataset.palette = palette
  }, [palette])

  const refresh = useCallback(async () => {
    const list = await apiFetch<Project[]>('/api/projects')
    setProjects(list)
    const active = list.find((p) => p.active)
    if (active) {
      const data = await apiFetch<Snapshot>(`/api/projects/${encodeURIComponent(active.id)}/snapshot`)
      setSnapshot({ projectId: active.id, data })
    }
  }, [])

  useEffect(() => {
    refresh().catch((err) => setError(messageOf(err)))
    return subscribeEvents(() => { refresh().catch((err) => setError(messageOf(err))) })
  }, [refresh])

  function save(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      setError('O navegador não deixou guardar a aparência; ela vale só até recarregar.')
    }
  }
  function choosePalette(next: Palette) { setPalette(next); save(PALETTE_KEY, next) }

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  // Antes da primeira resposta nada aparece: mostrar "abra uma pasta" e trocar em seguida era a piscada ao abrir o link.
  const loaded = projects !== null
  const openProjects = (projects ?? []).filter((p) => p.open)
  const active = openProjects.find((p) => p.active) ?? null
  const mission = active && snapshot?.projectId === active.id ? snapshot.data.selectedMission : null
  const missions = active && snapshot?.projectId === active.id ? snapshot.data.missions : []
  // qualquer missão do histórico abre só para ver, inclusive a mais recente depois de fechada
  const past = pastId ? missions.find((m) => m.id === pastId) ?? null : null
  const openPast = (id: string | null) => { setPastId(id); scrollToTop() }

  return (
    <>
      <header className="strip">
        <nav className="brand" aria-label="Projetos abertos">
          <span className="monogram" aria-hidden="true">T</span>
          <span className="wordmark">TL-ADE</span>
          {openProjects.length > 0 && <span className="program"><span className="sep" aria-hidden="true">/</span>
            {openProjects.map((p) => (
              <span key={p.id} className="chip-wrap">
                <button
                  className="chip"
                  aria-pressed={p.active}
                  aria-label={`Usar ${p.name}`}
                  title={p.path}
                  onClick={() => { if (page === 'projects' || page === 'appearance') setPage('home'); if (!p.active) act(() => postJson('/api/projects/select', { id: p.id })) }}
                >
                  {p.activity && (p.activity.kind === 'running' || p.activity.kind === 'waiting') && <span className={`pulse ${p.activity.kind}`} aria-hidden="true" />}
                  <span className="chip-name" data-testid={p.active ? 'active-project' : undefined}>{p.name}</span>
                </button>
                <button className="chip-x" aria-label={`Fechar ${p.name}`} onClick={() => act(() => postJson('/api/projects/close', { id: p.id }))}>
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
          </span>}
          {!active && <span className="sr-only" data-testid="active-project">Nenhuma pasta</span>}
        </nav>

        <nav className="tabs" aria-label="Seções">
          <button className="tab" aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}>Missão</button>
          <button className="tab" aria-current={page === 'projects' ? 'page' : undefined} onClick={() => setPage('projects')}>Projetos</button>
          {([['models', 'Modelos'], ['skills', 'Skills'], ['options', 'Opções'], ['appearance', 'Aparência']] as const).map(([id, label]) => (
            <button key={id} className="tab" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>
          ))}
        </nav>

        <div className="readouts">
          {mission?.consumed_usd != null && <span className="num" title="Custo equivalente de API">{brl(mission.consumed_usd)}</span>}
          {mission?.total_calls ? <><span className="rule" aria-hidden="true" /><span className="num">{mission.total_calls} chamadas</span></> : null}
          {mission?.started_at && <><span className="rule" aria-hidden="true" /><MissionClock start={mission.started_at} end={mission.finished_at ?? null} /></>}
        </div>
      </header>

      <main className="stage">
        {error && <div className="alert" role="alert" style={{ marginBottom: '2rem' }}>{error}</div>}
        {/* antes da primeira resposta não há o que mostrar: um quadro vazio com chave própria esperava a saída animada
            e a missão só aparecia uns 6 s depois de abrir o painel */}
        {loaded && <AnimatePresence mode="wait" initial={false}>
          {/* troca de página: sai rápido e entra suave; a primeira tela entra pelas animações dela mesma */}
          <motion.div
            key={page === 'home' ? active?.id ?? 'none' : page}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={{ duration: 0.5, ease: EASE_OUT }}
          >
            {page === 'appearance'
              ? <Appearance palette={palette} onPalette={choosePalette} />
              : page === 'models' || page === 'skills' || page === 'options'
              ? !active
                ? <NoProject onOpen={() => setPage('projects')} />
                : <section className="library ported">
                    {page === 'models' ? <ModelsPage key={active.id} projectId={active.id} /> : page === 'skills' ? <SkillsPage key={active.id} projectId={active.id} /> : <OptionsPage key={active.id} projectId={active.id} />}
                  </section>
              : page === 'projects'
              ? <ProjectsPage projects={projects ?? []} onOpen={(dir) => act(async () => { await postJson('/api/projects/open', { path: dir }); setPage('home') })} />
              : active
                ? past
                  ? <MissionScore
                      key={past.id}
                      projectId={active.id}
                      mission={past}
                      running={false}
                      rehearsal={String(missions.length - missions.indexOf(past))}
                      projectLine={<p className="project-line"><button className="btn small" onClick={() => openPast(null)}>Voltar</button><span>Missão anterior: {past.id}</span></p>}
                      composer={null}
                    />
                  : <IntakeFlow key={active.id} project={active} mission={mission} missionCount={missions.length} snapshotLoaded={snapshot?.projectId === active.id} />
                : loaded ? <NoProject onOpen={() => setPage('projects')} /> : null}
          </motion.div>
        </AnimatePresence>}
        {/* Conversa sobre o projeto: abaixo da missão, na cópia do projeto; o cartão de permissão decide o que entra. */}
        {page === 'home' && active && missions.length > 0 && <MissionHistory missions={missions} current={mission?.id ?? null} viewing={past?.id ?? null} onOpen={openPast} />}
        {page === 'home' && active && <section className="conversation" aria-label="Conversa"><ChatPanel key={`chat:${active.id}`} projectId={active.id} /></section>}
      </main>
    </>
  )
}

/** Há quanto tempo a missão roda; parada no fim quando ela fecha. Atualiza a cada 30 s. */
function MissionClock({ start, end }: { start: string; end: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (end) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [end])
  return <span className="num" title={end ? 'Tempo total da missão' : 'Tempo desde o começo da missão'}>{elapsed(start, end ? Date.parse(end) : now)}</span>
}

function NoProject({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="library">
      <div style={{ display: 'grid', gap: '2rem' }}>
        <h1 className="display">Abra uma pasta em Projetos para começar.</h1>
        <p className="lede">A TL-ADE trabalha dentro de um repositório git do seu computador. Escolha a pasta e peça o que quer construir.</p>
        <div><button className="btn baton" onClick={onOpen}>Abrir uma pasta</button></div>
      </div>
    </section>
  )
}

function ProjectsPage({ projects, onOpen }: { projects: Project[]; onOpen: (dir: string) => void }) {
  const [dir, setDir] = useState('')
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  // O servidor abre o seletor de pasta do sistema (Explorer, Finder ou zenity) e devolve o caminho; cancelar não faz nada.
  async function browse() {
    setPicking(true)
    setPickError(null)
    try {
      const { path } = await postJson<{ path: string | null }>('/api/projects/pick', {})
      if (path) onOpen(path)
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    onOpen(dir.trim())
  }
  const isLive = (p: Project) => p.activity?.kind === 'running' || p.activity?.kind === 'waiting'
  const live = projects.filter(isLive)
  const rest = projects.filter((p) => !isLive(p))

  return (
    <section className="library">
      <div style={{ display: 'grid', gap: '1.75rem' }}>
        <h1 className="display">Projetos</h1>
        <p className="lede">A ADE trabalha dentro de um repositório git do seu PC. Abrir outra pasta não interrompe a missão das que já estão abertas.</p>
        <div><button className="btn baton" type="button" onClick={browse} disabled={picking}>{picking ? 'Esperando a escolha…' : 'Escolher pasta'}</button></div>
        {pickError && <div className="alert" role="alert">{pickError}</div>}
        <form className="open-form" onSubmit={submit}>
          <input className="field mono" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\meus-projetos\minha-app" aria-label="Caminho da pasta" />
          <button className="btn" type="submit" disabled={!dir.trim()}>Abrir</button>
        </form>
      </div>
      <div style={{ display: 'grid', gap: '2.5rem', alignContent: 'start' }}>
        {live.length > 0 && (
          <section className="project-group" aria-labelledby="live-label">
            <h2 className="caps" id="live-label">Em andamento</h2>
            <ul className="shelf">{live.map((p) => <ProjectRow key={p.path} project={p} onOpen={onOpen} />)}</ul>
          </section>
        )}
        <section className="project-group" aria-labelledby="recent-label">
          <h2 className="caps" id="recent-label">Recentes</h2>
          {rest.length === 0
            ? <p className="empty">{live.length ? 'Nenhuma outra pasta por aqui.' : 'As pastas que você abrir aparecem aqui.'}</p>
            : <ul className="shelf">{rest.map((p) => <ProjectRow key={p.path} project={p} onOpen={onOpen} />)}</ul>}
        </section>
      </div>
    </section>
  )
}

/** Um projeto na estante: nome, caminho, o que acontece nele agora e a ação que leva até lá. */
function ProjectRow({ project: p, onOpen }: { project: Project; onOpen: (dir: string) => void }) {
  const a = p.activity
  const verb = !p.open ? 'Reabrir' : a?.kind === 'running' ? 'Acompanhar' : a?.kind === 'waiting' ? 'Responder' : 'Mostrar'
  const progress = a?.kind === 'running' && a.total ? (a.done ?? 0) / a.total : null
  return (
    <li className={a ? `project-row ${a.kind}` : 'project-row'}>
      <div style={{ display: 'grid', gap: '.3rem', minWidth: 0 }}>
        <p>{p.name}{p.open && <span className="tag">aberto</span>}</p>
        <p className="mono path-line" title={p.path}>{shortPath(p.path)}</p>
        {a && (
          <p className="activity" data-testid={`activity-${p.id}`}>
            {(a.kind === 'running' || a.kind === 'waiting') && <span className={`pulse ${a.kind}`} aria-hidden="true" />}
            <span>{activityLine(a)}</span>
          </p>
        )}
        {a && a.kind !== 'done' && <p className="activity-request" title={a.request}>{'\u201c'}{a.request}{'\u201d'}</p>}
        {progress !== null && <span className="measure-bar" aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></span>}
      </div>
      <button className={a?.kind === 'waiting' ? 'btn baton' : 'btn'} aria-label={`${verb} ${p.name}`} onClick={() => onOpen(p.path)}>{verb}</button>
    </li>
  )
}

/** Pedidos anteriores do projeto, do mais recente ao mais antigo: abrir mostra a tabela daquela missão. */
function MissionHistory({ missions, current, viewing, onOpen }: { missions: Mission[]; current: string | null; viewing: string | null; onOpen: (id: string | null) => void }) {
  return (
    <section className="history" aria-label="Missões anteriores">
      <h2 className="caps">Missões deste projeto</h2>
      <p className="note-line">Cada pedido vira uma missão. Abra qualquer uma para ver; para uma nova, feche a da tela e escreva o pedido.</p>
      <ol className="history-list">
        {missions.map((m, i) => {
          const stories = m.stories ?? []
          const done = stories.filter((s) => /committed|delivered|done|approved/.test(s.status ?? '')).length
          const isCurrent = m.id === current
          const open = m.id === viewing
          return (
            <li key={m.id} className="history-row" aria-current={open ? 'true' : undefined}>
              <span className="mono history-no">{missions.length - i}</span>
              <div className="history-body">
                <p className="history-title">{m.title ?? m.intent ?? m.id}</p>
                <p className="mono history-meta">
                  {stories.length ? `${done} de ${stories.length} partes prontas` : 'sem partes'}
                  {typeof m.consumed_usd === 'number' && m.consumed_usd > 0 ? ` · ${brl(m.consumed_usd)}` : ''}
                  {isCurrent ? ' · mais recente' : ''}
                </p>
              </div>
              {open ? <button className="btn small" onClick={() => onOpen(null)}>Voltar</button> : <button className="btn small" onClick={() => onOpen(m.id)}>Abrir</button>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
