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
  quarter: '', half: '', xnote: '', quarterRest: '', wholeRest: '',
  fermata: '', repeat: '', gClef: '', percClef: '',
} as const

/**
 * Pautas por papel, não por empresa: o journal diz o papel de cada passo (maker, eval, review), e o modelo só é certo
 * para quem escreve. Uma pauta por empresa inventaria dado; a empresa aparece no rótulo quando o contrato a nomeia.
 */
const STAVES = [
  { key: 'escreve', label: 'Escreve', test: /maker|fix|impl/i },
  { key: 'prova', label: 'Prova', test: /eval|gate|test|prova|suite/i },
  { key: 'revisa', label: 'Revisa', test: /review|check|revis/i },
  { key: 'motor', label: 'Motor', test: /./ },
] as const
type StaffKey = typeof STAVES[number]['key']
const staffOf = (name: string): StaffKey => STAVES.find((s) => s.test.test(name))!.key

/** Altura da nota vem do dado: a rodada sobe a nota (r1 grave, r3 agudo); prova vermelha grave, verde aguda. */
function pitchOf(name: string): number {
  const round = /:r(\d+):/.exec(name)
  if (round) return Math.min(4, Number(round[1]) - 1)
  if (/:red:/.test(name)) return 0
  if (/:green:/.test(name)) return 3
  return 1
}

/** O id do passo em português; o id cru fica ao lado, em letra pequena. */
function stepSentence(name: string): string {
  const r = /:r(\d+):(maker|fix|review|check\w*)/.exec(name)
  if (r) return /maker|fix/.test(r[2]) ? `Rodada ${r[1]}: escreveu o código` : `Rodada ${r[1]}: revisão de outra empresa`
  if (/:red:/.test(name)) return 'Prova escrita antes do código (nasce vermelha)'
  if (/:green:/.test(name)) return 'Prova conferida depois do código'
  if (/prepare/.test(name)) return 'Preparou a cópia de trabalho'
  if (/deliver|commit/.test(name)) return 'Entregou a parte (commit)'
  if (/gate/.test(name)) return 'Portões de qualidade'
  if (/contain/.test(name)) return 'Conferiu o que mudou fora do escopo'
  return 'Passo do motor'
}

const TEST_LABEL = { passed: 'passou', failed: 'falhou', red_at_start: 'vermelha na largada' } as const
const FINDING_LABEL: Record<string, string> = { open: 'aberto', withdrawn: 'retirado', resolved: 'resolvido' }
const SEVERITY_PT: Record<string, string> = { high: 'grave', medium: 'média', low: 'leve', critical: 'crítica' }
const STEP_STATE_PT: Record<string, string> = { ok: 'feito', running: 'tocando', failed: 'falhou', error: 'falhou' }
const STATE_PT: Record<string, string> = {
  committed: 'pronta', delivered: 'pronta', done: 'pronta', approved: 'pronta', in_progress: 'tocando agora', running: 'tocando agora',
  pending: 'na fila', queued: 'na fila', failed: 'parou', blocked: 'parou', rejected: 'recusada', skipped: 'pulada',
}
const isDone = (s: string) => /committed|delivered|done|approved|pronta/.test(s)
const isLive = (s: string) => /in_progress|running/.test(s)
const isStopped = (s: string) => /failed|blocked|rejected/.test(s)
const noteState = (s: string) => (s === 'running' ? 'running' : /fail|error|refused/.test(s) ? 'failed' : 'done')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Esforço vira dinâmica de partitura: baixo p, médio mf, alto f, muito alto ff, máximo fff.
const DYNAMIC: Record<string, string> = { low: 'p', medium: 'mf', high: 'f', xhigh: 'ff', max: 'fff' }
const DYN_GLYPH: Record<string, string> = { p: '', m: '', f: '' }
const dynamicOf = (effort?: string) => (DYNAMIC[effort ?? ''] ?? '').split('').map((c) => DYN_GLYPH[c]).join('')

function makerOf(mission: Mission | null, unitId?: string) {
  const stories = mission?.stories ?? []
  const m = (unitId && stories.find((s) => s.id === unitId)?.maker) || stories.find((s) => s.maker)?.maker
  return typeof m === 'string' ? { model_id: m, effort: undefined } : m ?? null
}

/** Batuta presa ao relógio: anda enquanto a parte toca, rápido no começo e devagar depois, e para quando nada roda. */
function useBatonClock(since: string | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const id = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [since])
  if (!since) return 0
  const minutes = Math.max(0, (now - new Date(since).getTime()) / 60000)
  return 0.12 + 0.76 * (1 - Math.exp(-minutes / 25))
}

/** A missão como partitura: pautas por papel, um compasso por parte, a batuta no agora; a parte aberta vira a página ao lado. */
export default function MissionScore({ projectId, mission, fallbackId, running, rehearsal, projectLine, composer }: {
  projectId: string
  mission: Mission | null
  fallbackId?: string
  running: boolean
  rehearsal: string
  projectLine: ReactNode
  composer: ReactNode
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
  const liveUnit = live >= 0 ? units[live] : null
  const batonFrac = useBatonClock(liveUnit?.steps[0]?.at ?? null)
  const done = units.filter((u) => isDone(u.state)).length
  const waiting = !!mission?.takeover?.intervention_needed || /paused|stopped/i.test(mission?.runtime_state ?? '')
  const title = mission?.title ?? mission?.intent ?? missionId
  const open = units.find((u) => u.id === openId)
  const maker = makerOf(mission, liveUnit?.id)

  const cells = useMemo(() => units.map((u) => {
    const byStaff: Record<StaffKey, Step[]> = { escreve: [], prova: [], revisa: [], motor: [] }
    for (const s of u.steps) byStaff[staffOf(s.name)].push(s)
    return byStaff
  }), [units])

  const status = liveUnit
    ? `parte ${live + 1} de ${units.length} tocando agora${liveUnit.rounds > 1 ? `, rodada ${liveUnit.rounds + 1}` : ''}`
    : units.length ? `${done} de ${units.length} partes prontas` : 'esperando a primeira parte'

  return (
    <section aria-labelledby="score-title" className="score-view">
      <header className="score-head">
        <div className="score-title" data-live={live >= 0}>
          <span className="rehearsal big" aria-label={`Missão ${rehearsal}`}>{rehearsal}</span>
          <div style={{ display: 'grid', gap: '.9rem', minWidth: 0 }}>
            <h1 id="score-title" className="display" style={title.length > 32 ? { fontSize: 'clamp(2.4rem, 4.2vw, 4rem)', maxWidth: '24ch' } : undefined}>{title}</h1>
            <h2 className="direction status-line">{running ? `Missão em execução · ${status}` : status}</h2>
          </div>
        </div>
        {projectLine}
      </header>

      {error && <div className="alert" role="alert" style={{ marginBottom: '1.5rem' }}>{error}</div>}

      <div className="hall" data-open={!!open}>
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
                      <Staff
                        key={staff.key}
                        label={staff.label}
                        sub={staff.key === 'escreve' ? maker?.model_id ?? 'quem escreve' : staff.key === 'prova' ? 'antes e depois' : staff.key === 'revisa' ? 'outra empresa' : 'preparo e entrega'}
                        mono={staff.key === 'escreve' && !!maker}
                        dynamic={staff.key === 'escreve' ? dynamicOf(maker?.effort ?? undefined) : ''}
                        percussion={staff.key === 'motor'}
                      >
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
                              {mi === 0 && <span className="clef" aria-hidden="true">{staff.key === 'motor' ? G.percClef : G.gClef}</span>}
                              {steps.length === 0
                                ? <span className="rest" aria-hidden="true">{queued ? G.wholeRest : G.quarterRest}</span>
                                : steps.map((s, ni) => (
                                  <motion.span
                                    key={s.name}
                                    className="note"
                                    data-state={noteState(s.state)}
                                    title={`${stepSentence(s.name)} · ${STEP_STATE_PT[s.state] ?? s.state} · ${hour(s.at)}`}
                                    initial={reducedMotion() ? false : { opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.6, ease: EASE_OUT, delay: 0.35 + mi * 0.09 + ni * 0.05 }}
                                    style={{ translate: `0 ${staff.key === 'motor' ? 0 : 10 - pitchOf(s.name) * 5}px` }}
                                  >
                                    {noteState(s.state) === 'failed' ? G.xnote : s.state === 'running' ? G.half : G.quarter}
                                  </motion.span>
                                ))}
                            </div>
                          )
                        })}
                      </Staff>
                    ))}

                    {liveUnit && (
                      <motion.span
                        aria-hidden="true"
                        className="baton-line"
                        style={{ left: `calc(var(--label) + (100% - var(--label)) * ${(live + batonFrac) / units.length})` }}
                        initial={{ opacity: 0, scaleY: 0 }}
                        animate={{ opacity: 1, scaleY: 1 }}
                        transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.9 }}
                      />
                    )}
                  </div>
                </div>
              )}
        </div>

        <div className="margin-slot">
          <AnimatePresence mode="wait" initial={false}>
            {open && detail?.id === open.id
              ? <Leaf key={open.id} unit={open} detail={detail} index={units.indexOf(open)} onClose={() => setOpenId(null)} />
              : (
                <motion.aside
                  key="margin"
                  className="margin"
                  aria-label="Margem da partitura"
                  initial={{ opacity: 0, rotateY: -8 }}
                  animate={{ opacity: 1, rotateY: 0 }}
                  exit={{ opacity: 0, rotateY: 8 }}
                  transition={{ duration: 0.5, ease: EASE_OUT }}
                >
                  <div className="fermata" data-waiting={waiting}>
                    <span className="glyph" aria-hidden="true">{G.fermata}</span>
                    <h2>Sua vez</h2>
                    <p>{waiting ? 'A missão parou e espera você decidir.' : 'Nada para decidir agora.'}</p>
                  </div>
                  {mission && units.length > 0 && <CostChart mission={mission} units={units} live={live} />}
                  <img className="plate margin-plate" src={maestro} alt="Gravura de um regente de costas, com seis braços, cada mão conduzindo um fio" />
                </motion.aside>
              )}
          </AnimatePresence>
        </div>
      </div>

      <div className="composer-dock">{composer}</div>
    </section>
  )
}

function Staff({ label, sub, mono, dynamic, percussion, children }: { label: string; sub: string; mono: boolean; dynamic: string; percussion: boolean; children: ReactNode }) {
  return (
    <>
      <div className="staff-label" style={percussion ? { minHeight: '4rem' } : undefined}>
        <strong>{label}</strong>
        <span className={mono ? 'model' : undefined}>{sub}</span>
        {dynamic && <em className="dynamic" title="Esforço de quem escreve">{dynamic}</em>}
      </div>
      {children}
    </>
  )
}

/** Gasto por parte como hastes gravadas com o número do compasso e o valor; a haste dourada é a parte que toca agora. */
function CostChart({ mission, units, live }: { mission: Mission; units: Unit[]; live: number }) {
  const stories = mission.stories ?? []
  const costs = units.map((u) => stories.find((s) => s.id === u.id)?.cost ?? 0)
  const max = Math.max(0.01, ...costs)
  return (
    <figure className="cost-chart">
      <figcaption className="direction">Gasto por parte</figcaption>
      <ol className="stems" style={{ ['--n' as string]: units.length }}>
        {units.map((u, i) => (
          <li key={u.id} title={`${u.title ?? u.id}: ${brl(costs[i])}`}>
            <span className="val num">{costs[i] > 0 ? costs[i].toFixed(1) : '·'}</span>
            <motion.i
              data-live={i === live}
              style={{ height: `${Math.max(2, (costs[i] / max) * 100)}%` }}
              initial={reducedMotion() ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.6 + i * 0.06 }}
            />
            <span className="no">{i + 1}</span>
          </li>
        ))}
      </ol>
      <p className="note-line">Em dólares equivalentes de API; o que pesa de verdade é a cota do plano.</p>
    </figure>
  )
}

function Leaf({ unit, detail, index, onClose }: { unit: Unit; detail: Detail; index: number; onClose: () => void }) {
  const approved = detail.review?.verdict === 'approved'
  return (
    <motion.article
      className="leaf"
      data-testid="unit-detail"
      initial={{ opacity: 0, rotateY: -70, x: -30 }}
      animate={{ opacity: 1, rotateY: 0, x: 0 }}
      exit={{ opacity: 0, rotateY: -40 }}
      transition={{ duration: 0.75, ease: EASE_OUT }}
      style={{ transformOrigin: 'left center' }}
    >
      <header className="leaf-head">
        <div style={{ display: 'grid', gap: '.5rem' }}>
          <h2 className="display">{unit.title ?? unit.id}</h2>
          <p className="direction">Compasso {index + 1}, {STATE_PT[unit.state] ?? unit.state}, {unit.rounds} rodada(s)</p>
        </div>
        <button className="btn quiet" onClick={onClose}><X size={14} aria-hidden="true" /> Fechar</button>
      </header>

      <section>
        <h3>Parecer</h3>
        {!detail.review
          ? <p className="empty">Ainda sem revisão.</p>
          : (
            <>
              <p className="verdict-line">
                <span className="display">{approved ? 'Aprovado' : 'Pediu mudanças'}</span>
                <span className="direction"> por <span className="mono" style={{ fontStyle: 'normal' }}>{detail.review.model_id ?? 'revisor não registrado'}</span></span>
              </p>
              <ul className="findings">
                {detail.review.findings.map((f) => (
                  <li key={f.id}>
                    <span className="finding-meta">{SEVERITY_PT[f.severity] ?? f.severity} · {FINDING_LABEL[f.status] ?? f.status}</span>
                    <span>{f.text}</span>
                    {f.citation && <span className="mono" style={{ color: 'var(--ink-faint)' }}>{f.citation}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
      </section>

      <section>
        <h3>Passos</h3>
        <ol className="steps">
          {unit.steps.map((s) => (
            <li key={s.name} className="step" data-state={s.state}>
              <span className="glyph" aria-hidden="true">{noteState(s.state) === 'failed' ? G.xnote : s.state === 'running' ? G.half : G.quarter}</span>
              <span className="step-text">{stepSentence(s.name)}<span className="mono">{s.name}</span></span>
              <time>{STEP_STATE_PT[s.state] ?? s.state} · {hour(s.at)}</time>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3>Provas</h3>
        <TestList tests={detail.tests.filter((t) => !t.baseline_red)} />
        {detail.tests.some((t) => t.baseline_red) && (
          <>
            <p className="direction" style={{ marginTop: '.5rem' }}>Vermelhas na largada</p>
            <TestList tests={detail.tests.filter((t) => t.baseline_red)} />
          </>
        )}
      </section>

      <section>
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
