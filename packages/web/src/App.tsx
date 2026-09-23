import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { apiFetch, postJson, subscribeEvents } from './api.ts'
import IntakeFlow from './Intake.tsx'
import Appearance, { PALETTES, type Mode, type Palette } from './Appearance.tsx'
import { EASE_OUT } from './motion.ts'
import { brl } from './format.ts'

interface Project {
  id: string
  name: string
  path: string
  open: boolean
  active: boolean
}

export interface ModelRef { family: string; model_id: string; effort?: string }
export interface MissionStory { id: string; title?: string; status?: string | null; calls?: number; cost?: number | null; maker?: ModelRef | string | null }
export interface Mission {
  id: string
  status?: string
  title?: string
  intent?: string
  consumed_usd?: number | null
  total_calls?: number
  stories?: MissionStory[]
  runtime_state?: string
  current_story?: string | null
  takeover?: { active: boolean; intervention_needed: boolean }
}

interface Snapshot {
  missions: Mission[]
  selectedMission: Mission | null
}

type Page = 'home' | 'projects' | 'appearance'

const APPEARANCE_KEY = 'ade.appearance'
const PALETTE_KEY = 'ade.palette'
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

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
  const [mode, setMode] = useState<Mode>(() => readPref<Mode>(APPEARANCE_KEY, ['light', 'dark', 'system'], 'system'))
  const [palette, setPalette] = useState<Palette>(() => readPref<Palette>(PALETTE_KEY, PALETTES.map((p) => p.id), 'grafite'))
  const [sysDark, setSysDark] = useState(systemDark)
  const [projects, setProjects] = useState<Project[]>([])
  const [snapshot, setSnapshot] = useState<{ projectId: string; data: Snapshot } | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [error, setError] = useState<string | null>(null)

  const dark = mode === 'system' ? sysDark : mode === 'dark'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSysDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.palette = palette
  }, [dark, palette])

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
  function chooseMode(next: Mode) { setMode(next); save(APPEARANCE_KEY, next) }
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

  const openProjects = projects.filter((p) => p.open)
  const active = openProjects.find((p) => p.active) ?? null
  const mission = active && snapshot?.projectId === active.id ? snapshot.data.selectedMission : null

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
                  onClick={() => { setPage('home'); if (!p.active) act(() => postJson('/api/projects/select', { id: p.id })) }}
                >
                  {p.active ? <span data-testid="active-project">{p.name}</span> : p.name}
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
          <button className="tab" aria-current={page === 'appearance' ? 'page' : undefined} onClick={() => setPage('appearance')}>Aparência</button>
        </nav>

        <div className="readouts">
          {mission?.consumed_usd != null && <span className="num" title="Custo equivalente de API">{brl(mission.consumed_usd)}</span>}
          {mission?.total_calls ? <><span className="rule" aria-hidden="true" /><span className="num">{mission.total_calls} chamadas</span></> : null}
          <span className="rule" aria-hidden="true" />
          <button className="switch" role="switch" aria-checked={dark} aria-label="Modo noturno" onClick={() => chooseMode(dark ? 'light' : 'dark')}>
            <span className="track" aria-hidden="true" />
            <span className="caps" aria-hidden="true">Noite</span>
          </button>
        </div>
      </header>

      <main className="stage">
        {error && <div className="alert" role="alert" style={{ marginBottom: '2rem' }}>{error}</div>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page === 'home' ? active?.id ?? 'none' : page}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE_OUT }}
          >
            {page === 'appearance'
              ? <Appearance mode={mode} palette={palette} onMode={chooseMode} onPalette={choosePalette} />
              : page === 'projects'
              ? <ProjectsPage projects={projects} onOpen={(dir) => act(async () => { await postJson('/api/projects/open', { path: dir }); setPage('home') })} />
              : active
                ? <IntakeFlow key={active.id} project={active} mission={mission} snapshotLoaded={snapshot?.projectId === active.id} />
                : <NoProject onOpen={() => setPage('projects')} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </>
  )
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
  const closed = projects.filter((p) => !p.open)

  function submit(e: FormEvent) {
    e.preventDefault()
    onOpen(dir.trim())
  }

  return (
    <section className="library">
      <div style={{ display: 'grid', gap: '1.75rem' }}>
        <h1 className="display">Projetos</h1>
        <p className="lede">A ADE trabalha dentro de um repositório git do seu PC. Abrir outra pasta não interrompe a missão das que já estão abertas.</p>
        <form className="open-form" onSubmit={submit}>
          <input className="field mono" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\meus-projetos\minha-app" aria-label="Caminho da pasta" />
          <button className="btn baton" type="submit" disabled={!dir.trim()}>Abrir</button>
        </form>
      </div>
      <div style={{ display: 'grid', gap: '1rem' }}>
        <h2 className="caps">Recentes</h2>
        {closed.length === 0
          ? <p className="empty">Nenhuma pasta fechada por aqui.</p>
          : (
            <ul className="shelf">
              {closed.map((p) => (
                <li key={p.path}>
                  <div>
                    <p>{p.name}</p>
                    <p className="mono" style={{ color: 'var(--ink-faint)' }}>{p.path}</p>
                  </div>
                  <button className="btn" aria-label={`Reabrir ${p.name}`} onClick={() => onOpen(p.path)}>Reabrir</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  )
}
