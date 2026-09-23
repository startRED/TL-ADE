import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { apiFetch, subscribeEvents } from './api.ts'
import type { Mission } from './App.tsx'
import { brl, hour } from './format.ts'
import { EASE_OUT, reducedMotion } from './motion.ts'
import maestro from './assets/plates/maestro.webp'

interface Step { name: string; state: string; at: string }
interface Unit { id: string; title: string | null; state: string; rounds: number; steps: Step[] }
interface Detail {
  id: string
  base_commit: string | null
  head_commit: string | null
  diff: Array<{ file: string; lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }> }>
  tests: Array<{ name: string; status: 'passed' | 'failed' | 'red_at_start'; baseline_red: boolean }>
  review: { verdict: string; model_id: string | null; findings: Array<{ id: string; severity: string; text: string; status: string; citation: string | null }> } | null
}

// Glifos SMuFL da Bravura: a notação é de verdade, não desenho aproximado.
const G = {
  note: '', quarter: '', half: '', xnote: '', quarterRest: '', wholeRest: '',
  fermata: '', repeat: '',
} as const

/** Pautas da orquestra: cada passo da parte cai na pauta do papel que o executou. */
const STAVES = [
  { key: 'escreve', label: 'Escreve', test: /maker|fix|impl/i },
  { key: 'prova', label: 'Prova', test: /eval|gate|test|prova|suite/i },
  { key: 'revisa', label: 'Revisa', test: /review|check|revis/i },
  { key: 'motor', label: 'Motor', test: /./ },
] as const
type StaffKey = typeof STAVES[number]['key']
const staffOf = (name: string): StaffKey => STAVES.find((s) => s.test.test(name))!.key

const TEST_LABEL = { passed: 'passou', failed: 'falhou', red_at_start: 'vermelha na largada' } as const
const FINDING_LABEL: Record<string, string> = { open: 'aberto', withdrawn: 'retirado', resolved: 'resolvido' }
const STATE_PT: Record<string, string> = {
  committed: 'pronta', delivered: 'pronta', done: 'pronta', approved: 'pronta', in_progress: 'tocando agora', running: 'tocando agora',
  pending: 'na fila', queued: 'na fila', failed: 'parou', blocked: 'parou', rejected: 'recusada', skipped: 'pulada',
}
const isDone = (s: string) => /committed|delivered|done|approved|pronta/.test(s)
const isLive = (s: string) => /in_progress|running/.test(s)
const isStopped = (s: string) => /failed|blocked|rejected/.test(s)
const noteState = (s: string) => (s === 'running' ? 'running' : /fail|error|refused/.test(s) ? 'failed' : 'done')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A missão como partitura: pautas por papel, um compasso por parte, a batuta no agora; a parte aberta vira a página ao lado. */
export default function MissionScore({ projectId, mission, fallbackId, running, projectLine }: {
  projectId: string
  mission: Mission | null
  fallbackId?: string
  running: boolean
  projectLine: ReactNode
}) {
  const missionId = mission?.id ?? fallbackId ?? ''
  const base = `/api/projects/${encodeURIComponent(projectId)}/missions/${encodeURIComponent(missionId)}/units`
  const [units, setUnits] = useState<Unit[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawn, setDrawn] = useState(reducedMotion())

  const load = useCallback(async () => {
    if (!mission) return
    setUnits(await apiFetch<Unit[]>(base))
    if (openId) setDetail(await apiFetch<Detail>(`${base}/${encodeURIComponent(openId)}`))
  }, [base, openId, mission])

  useEffect(() => {
    const reload = () => { load().then(() => setError(null), (err) => setError(messageOf(err))) }
    reload()
    return subscribeEvents(reload)
  }, [load])

  useEffect(() => {
    if (drawn || units.length === 0) return
    const id = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(id)
  }, [drawn, units.length])

  const live = units.findIndex((u) => isLive(u.state))
  const done = units.filter((u) => isDone(u.state)).length
  const waiting = !!mission?.takeover?.intervention_needed || /paused|stopped/i.test(mission?.runtime_state ?? '')
  const title = mission?.title ?? mission?.intent ?? missionId
  const open = units.find((u) => u.id === openId)

  const cells = useMemo(() => units.map((u) => {
    const byStaff: Record<StaffKey, Step[]> = { escreve: [], prova: [], revisa: [], motor: [] }
    for (const s of u.steps) byStaff[staffOf(s.name)].push(s)
    return byStaff
  }), [units])

  return (
    <section aria-labelledby="score-title">
      <header className="score-head">
        <div className="score-title" data-live={live >= 0}>
          <div style={{ display: 'grid', gap: '1rem', minWidth: 0 }}>
            {running && <h2 className="caps" style={{ color: 'var(--baton)' }}>Missão em execução</h2>}
            <h1 id="score-title" className="display" style={title.length > 32 ? { fontSize: 'clamp(2.4rem, 4.2vw, 4rem)', maxWidth: '22ch' } : undefined}>{title}</h1>
            {projectLine}
          </div>
        </div>
        <div className="score-meta">
          <span className="caps">Partes prontas</span>
          <span className="display" style={{ fontSize: '2.4rem' }}><span className="num" style={{ fontFamily: 'var(--display)' }}>{done}</span><span style={{ color: 'var(--sage)' }}> / {units.length || '—'}</span></span>
        </div>
      </header>

      {error && <div className="alert" role="alert" style={{ marginBottom: '1.5rem' }}>{error}</div>}

      <div className="hall">
        <div style={{ minWidth: 0 }}>
          {!mission
            ? <p className="empty">A missão {missionId} começou; a partitura aparece assim que a primeira parte entrar.</p>
            : units.length === 0
              ? <p className="empty">Lendo as partes…</p>
              : (
                <div className="score" role="group" aria-label={`Partitura da missão ${missionId}`}>
                  <div className="score-grid" style={{ ['--measures' as string]: units.length }}>
                    <div aria-hidden="true" />
                    {units.map((u, i) => (
                      <button
                        key={u.id}
                        className="measure-head"
                        aria-expanded={u.id === openId}
                        onClick={() => setOpenId(u.id === openId ? null : u.id)}
                      >
                        <span className="bar-no" aria-hidden="true">{i + 1}</span>
                        <span className="part-name">{u.title ?? u.id}</span>
                        <span className="part-state">
                          {isDone(u.state) ? <span className="stamp" title="Pronta e provada"><Check size={14} weight="bold" aria-hidden="true" /></span>
                            : isStopped(u.state) ? <span className="stamp" title="Parou"><X size={14} weight="bold" aria-hidden="true" /></span>
                              : u.rounds > 1 ? <span className="repeat">{u.rounds}x<span className="glyph" aria-hidden="true">{G.repeat}</span></span>
                                : <span className="caps" style={{ fontSize: 10 }}>{STATE_PT[u.state] ?? u.state}</span>}
                        </span>
                        <span className="sr-only">{STATE_PT[u.state] ?? u.state}, {u.rounds} rodada(s)</span>
                      </button>
                    ))}

                    {STAVES.map((staff, si) => (
                      <Staff key={staff.key} staffIndex={si} label={staff.label} sub={staffSub(staff.key, mission, units[live]?.id)} dynamic={staff.key === 'escreve' ? dynamicOf(makerOf(mission, units[live]?.id)?.effort ?? undefined) : ''} percussion={staff.key === 'motor'}>
                        {units.map((u, mi) => {
                          const steps = cells[mi][staff.key]
                          const queued = !isDone(u.state) && !isLive(u.state) && u.steps.length === 0
                          return (
                            <div
                              key={u.id}
                              className={`bar-cell${staff.key === 'motor' ? ' percussion' : ''}`}
                              data-state={queued ? 'queued' : 'played'}
                              style={{ ['--drawn' as string]: drawn ? 1 : 0, transitionDelay: `${mi * 90 + si * 40}ms` }}
                            >
                              {steps.length === 0
                                ? <span className="rest" aria-hidden="true">{queued ? G.wholeRest : G.quarterRest}</span>
                                : steps.map((s, ni) => (
                                  <motion.span
                                    key={s.name}
                                    className="note"
                                    data-state={noteState(s.state)}
                                    title={`${s.name} · ${s.state} · ${hour(s.at)}`}
                                    initial={reducedMotion() ? false : { opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.6, ease: EASE_OUT, delay: 0.35 + mi * 0.09 + ni * 0.05 }}
                                    style={{ translate: `0 ${((ni * 7 + si * 3) % 5) * 5 - 10}px` }}
                                  >
                                    {noteState(s.state) === 'failed' ? G.xnote : s.state === 'running' ? G.half : G.quarter}
                                  </motion.span>
                                ))}
                            </div>
                          )
                        })}
                      </Staff>
                    ))}

                    {live >= 0 && (
                      <motion.span
                        aria-hidden="true"
                        className="baton-line"
                        style={{ left: `calc(var(--label) + (100% - var(--label)) * ${(live + Math.min(0.88, 0.22 + units[live].steps.length * 0.09)) / units.length})` }}
                        initial={{ opacity: 0, scaleY: 0 }}
                        animate={{ opacity: 1, scaleY: 1 }}
                        transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.9 }}
                      />
                    )}
                  </div>
                </div>
              )}

          <AnimatePresence mode="wait">
            {open && detail?.id === open.id && (
              <Leaf key={open.id} unit={open} detail={detail} index={units.indexOf(open)} onClose={() => setOpenId(null)} />
            )}
          </AnimatePresence>
        </div>

        <aside className="margin" aria-label="Margem da partitura">
          <div className="fermata" data-waiting={waiting}>
            <span className="glyph" aria-hidden="true">{G.fermata}</span>
            <h2>Sua vez</h2>
            <p>{waiting ? 'A missão parou e espera você decidir.' : 'Nada para decidir agora.'}</p>
          </div>
          {mission && <Tally mission={mission} units={units} />}
          <figure style={{ margin: 0 }}>
            <img className="plate" src={maestro} alt="Gravura de um regente de costas, com seis braços, cada mão conduzindo um fio" />
          </figure>
        </aside>
      </div>
    </section>
  )
}

// Esforço vira dinâmica de partitura: baixo p, médio mf, alto f, muito alto ff, máximo fff.
const DYNAMIC: Record<string, string> = { low: 'p', medium: 'mf', high: 'f', xhigh: 'ff', max: 'fff' }
const DYN_GLYPH: Record<string, string> = { p: '', m: '', f: '' }
const dynamicOf = (effort?: string) => (DYNAMIC[effort ?? ''] ?? '').split('').map((c) => DYN_GLYPH[c]).join('')

function makerOf(mission: Mission | null, unitId?: string) {
  const stories = mission?.stories ?? []
  const m = (unitId && stories.find((s) => s.id === unitId)?.maker) || stories.find((s) => s.maker)?.maker
  return typeof m === 'string' ? { model_id: m, effort: undefined } : m ?? null
}

function staffSub(key: StaffKey, mission: Mission | null, liveId?: string): string {
  if (key === 'escreve') return makerOf(mission, liveId)?.model_id ?? 'quem escreve'
  if (key === 'prova') return 'antes e depois'
  if (key === 'revisa') return 'outra empresa'
  return 'preparo e entrega'
}

function Staff({ label, sub, dynamic, percussion, staffIndex, children }: { label: string; sub: string; dynamic: string; percussion: boolean; staffIndex: number; children: ReactNode }) {
  return (
    <>
      <div className="staff-label" style={percussion ? { minHeight: '4rem' } : undefined} data-staff={staffIndex}>
        <strong>{label}</strong>
        <span className={label === 'Escreve' && sub.includes('-') ? 'model' : undefined}>{sub}</span>
        {dynamic && <em className="dynamic" title="Esforço de quem escreve">{dynamic}</em>}
      </div>
      {children}
    </>
  )
}

/** Custo por parte como hastes gravadas: a altura é o gasto, a amarela é a parte que toca agora. */
function Tally({ mission, units }: { mission: Mission; units: Unit[] }) {
  const stories = mission.stories ?? []
  const costs = units.map((u) => stories.find((s) => s.id === u.id)?.cost ?? 0)
  const max = Math.max(0.01, ...costs)
  const liveIdx = units.findIndex((u) => isLive(u.state))
  return (
    <div className="tally">
      <div className="tally-row">
        <span className="label">Gasto</span>
        <span className="num">{mission.consumed_usd != null ? brl(mission.consumed_usd) : '—'}</span>
      </div>
      <div className="tally-row">
        <span className="label">Chamadas de IA</span>
        <span className="num">{mission.total_calls ?? 0}</span>
      </div>
      {units.length > 0 && (
        <div className="pulse" aria-label="Gasto por parte">
          <svg viewBox={`0 0 ${units.length * 10} 40`} preserveAspectRatio="none" role="img">
            <title>Gasto por parte</title>
            <line x1="0" x2={units.length * 10} y1="40" y2="40" stroke="var(--sage)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {costs.map((c, i) => {
              const h = Math.max(1.5, (c / max) * 36)
              return (
                <motion.rect
                  key={units[i].id}
                  x={i * 10 + 3.5}
                  width="3"
                  y={40 - h}
                  height={h}
                  fill={i === liveIdx ? 'var(--baton)' : 'var(--ink)'}
                  initial={reducedMotion() ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  style={{ transformOrigin: `${i * 10 + 5}px 40px` }}
                  transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.6 + i * 0.06 }}
                >
                  <title>{`${units[i].title ?? units[i].id}: ${brl(c)}`}</title>
                </motion.rect>
              )
            })}
          </svg>
          <p className="caps" style={{ marginTop: '.6rem', fontSize: 10 }}>Gasto por parte</p>
        </div>
      )}
    </div>
  )
}

function Leaf({ unit, detail, index, onClose }: { unit: Unit; detail: Detail; index: number; onClose: () => void }) {
  const approved = detail.review?.verdict === 'approved'
  return (
    <motion.article
      className="leaf"
      data-testid="unit-detail"
      initial={{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
      animate={{ opacity: 1, clipPath: 'inset(0 0 0% 0)' }}
      exit={{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
      transition={{ duration: 0.7, ease: EASE_OUT }}
    >
      <header className="leaf-head">
        <div style={{ display: 'grid', gap: '.6rem' }}>
          <span className="caps">Compasso {index + 1} · {STATE_PT[unit.state] ?? unit.state} · {unit.rounds} rodada(s)</span>
          <h2 className="display">{unit.title ?? unit.id}</h2>
        </div>
        <button className="btn quiet" onClick={onClose}><X size={14} aria-hidden="true" /> Fechar página</button>
      </header>
      <div className="leaf-grid">
        <section>
          <h3>Passos</h3>
          <ol className="steps">
            {unit.steps.map((s) => (
              <li key={s.name} className="step" data-state={s.state}>
                <span className="glyph" aria-hidden="true">{noteState(s.state) === 'failed' ? G.xnote : G.note}</span>
                <span className="mono">{s.name}</span>
                <time>{s.state} · {hour(s.at)}</time>
              </li>
            ))}
          </ol>
          <h3 style={{ marginTop: '1.5rem' }}>Provas</h3>
          <TestList tests={detail.tests.filter((t) => !t.baseline_red)} />
          {detail.tests.some((t) => t.baseline_red) && (
            <>
              <p className="caps" style={{ marginTop: '.5rem' }}>Vermelhas na largada</p>
              <TestList tests={detail.tests.filter((t) => t.baseline_red)} />
            </>
          )}
        </section>
        <section>
          <h3>Parecer</h3>
          {!detail.review
            ? <p className="empty">Ainda sem revisão.</p>
            : (
              <>
                <div className="review-verdict">
                  <span className={`seal${approved ? '' : ' changes'}`}>{approved ? 'Aprovado' : 'Pediu mudanças'}</span>
                  <span className="direction">revisor <span className="mono" style={{ fontStyle: 'normal' }}>{detail.review.model_id ?? 'desconhecido'}</span></span>
                </div>
                <ul className="findings">
                  {detail.review.findings.map((f) => (
                    <li key={f.id}>
                      <span><span className="tag">{f.severity}</span> <span className="tag">{FINDING_LABEL[f.status] ?? f.status}</span></span>
                      <span>{f.text}</span>
                      {f.citation && <span className="mono" style={{ color: 'var(--ink-faint)' }}>{f.citation}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
        </section>
        <section className="wide">
          <h3>O que mudou</h3>
          {detail.diff.length === 0
            ? <p className="empty">Sem commit da parte ainda.</p>
            : <p className="mono" style={{ color: 'var(--ink-faint)' }}>{detail.base_commit?.slice(0, 8)}..{detail.head_commit?.slice(0, 8)}</p>}
          {detail.diff.map((f) => (
            <div key={f.file} className="diff-file">
              <p className="mono">{f.file}</p>
              <pre>
                {f.lines.map((l, i) => <div key={i} data-kind={l.kind} className={`diff-${l.kind}`}>{l.text}</div>)}
              </pre>
            </div>
          ))}
        </section>
      </div>
    </motion.article>
  )
}

function TestList({ tests }: { tests: Detail['tests'] }) {
  if (tests.length === 0) return <p className="empty">Nenhuma.</p>
  return (
    <ul className="tests">
      {tests.map((t) => (
        <li key={`${t.name}:${t.status}`}>
          <span className="mono">{t.name}</span>
          <span className={t.status === 'passed' ? 'pass' : 'fail'}>{TEST_LABEL[t.status]}</span>
        </li>
      ))}
    </ul>
  )
}
