import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, Check, PaperPlaneRight, X } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { apiFetch, postJson } from './api.ts'
import type { Mission } from './App.tsx'
import MissionScore from './Units.tsx'
import { EASE_OUT } from './motion.ts'
import Plate from './Plate.tsx'

interface Question {
  id: string
  text: string
  options: Array<{ id: string; label: string; why?: string; free_text?: boolean }>
}

interface Decision {
  question_id?: string
  value: string
  origin: 'usuario' | 'ia_supondo' | 'padrao'
}

interface Briefing {
  goal: string
  in_scope: string[]
  out_of_scope: string[]
  done_means: string[]
  versions: Array<{ name: string; goal: string }>
}

interface Intake {
  mission_id: string
  stage: 'interview' | 'briefing' | 'plan' | 'running' | 'concluida' | 'recusada'
  rejected_at?: 'briefing' | 'plan'
  reason?: string
  error?: string
  questions?: Question[]
  decisions?: Decision[]
  briefing?: Briefing
  parts?: Array<{ id: string; title?: string; task?: string; criteria: string[] }>
  digest?: string
}

interface ProjectRef { id: string; name: string; path: string }

const ORIGIN_PT: Record<Decision['origin'], string> = { usuario: 'você escolheu', ia_supondo: 'IA supondo', padrao: 'padrão' }
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Entrada em cascata: cada bloco assenta um pouco depois do anterior, uma vez só. */
const rise = (i: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, ease: EASE_OUT, delay: 0.06 * i },
})

/** O pedido do projeto ativo: abertura, entrevista, briefing, plano e, depois, a partitura da missão. */
export default function IntakeFlow({ project, mission, missionCount, snapshotLoaded }: { project: ProjectRef; mission: Mission | null; missionCount: number; snapshotLoaded: boolean }) {
  const base = `/api/projects/${encodeURIComponent(project.id)}`
  const [intake, setIntake] = useState<Intake | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIntake(await apiFetch<Intake | null>(`${base}/intake?if_missing=null`))
  }, [base])

  useEffect(() => {
    setIntake(undefined)
    load().catch((err) => setError(messageOf(err)))
  }, [load])

  async function act(path: string, body: unknown) {
    setBusy(true)
    setError(null)
    try {
      await postJson(`${base}${path}`, body)
      await load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const alert = error && <div className="alert" role="alert" style={{ marginBottom: '2rem' }}>{error}</div>
  const projectLine = (
    <p className="project-line" data-testid="project-state">
      <span className="mono" title={project.path}>{project.path}</span>
      <span>{!snapshotLoaded ? 'Lendo o estado do projeto…' : mission ? `Última missão: ${mission.id}` : 'Nenhum pedido ainda.'}</span>
    </p>
  )
  if (intake === undefined) return alert || null

  if (intake?.stage === 'interview') {
    return <>{alert}<InterviewView questions={intake.questions ?? []} busy={busy} onAnswer={(answers) => act('/intake/interview', { answers })} /></>
  }
  if (intake?.stage === 'briefing' && intake.briefing) {
    const b = intake.briefing
    return (
      <>{alert}
        <Movement title="Briefing" note="Confira o que entra e o que fica fora antes de a IA montar o plano." plate="estante">
          <motion.p className="goal" {...rise(1)}>{b.goal}</motion.p>
          <motion.div className="columns" {...rise(2)}>
            <Ledger title="O que entra" items={b.in_scope} />
            <Ledger title="O que fica fora" items={b.out_of_scope} kind="out" />
            <Ledger title="O que é pronto" items={b.done_means} kind="done" />
          </motion.div>
          <motion.div {...rise(3)} style={{ display: 'grid', gap: '1rem' }}>
            <h3 className="caps">{b.versions.length > 1 ? `Versões (${b.versions.length}, uma depois da outra)` : 'Versão'}</h3>
            <ol className="versions">
              {b.versions.map((v, i) => (
                <li key={v.name} className="version">
                  <span className="rehearsal" aria-hidden="true">{String.fromCharCode(65 + (i % 26))}</span>
                  <p><strong className="mono">{v.name}</strong> · {v.goal}</p>
                </li>
              ))}
            </ol>
          </motion.div>
          <Decisions intake={intake} />
          <Verdict what="briefing" busy={busy} onApprove={() => act('/intake/briefing/approve', { digest: intake.digest })} onReject={(reason) => act('/intake/briefing/reject', { reason })} />
        </Movement>
      </>
    )
  }
  if (intake?.stage === 'plan') {
    return (
      <>{alert}
        <Movement title="Plano" note="Cada parte e os critérios que a prova dela vai cobrar." plate="estante">
          <ol className="parts">
            {(intake.parts ?? []).map((p, i) => (
              <motion.li key={p.id} className="part-row" {...rise(i + 1)}>
                <span className="bar" aria-hidden="true">{i + 1}</span>
                <div>
                  <h3><span className="mono" style={{ color: 'var(--ink-faint)', marginRight: '.6rem' }}>{p.id}</span>{p.title ?? p.task}</h3>
                  <ul className="ledger">{p.criteria.map((c) => <li key={c}>{c}</li>)}</ul>
                </div>
              </motion.li>
            ))}
          </ol>
          <Decisions intake={intake} />
          <Verdict what="plano" busy={busy} onApprove={() => act('/intake/plan/approve', { digest: intake.digest })} onReject={(reason) => act('/intake/plan/reject', { reason })} />
        </Movement>
      </>
    )
  }

  const running = intake?.stage === 'running'
  if (mission || running) {
    return (
      <>{alert}
        <MissionScore
          projectId={project.id}
          mission={mission}
          fallbackId={intake?.mission_id}
          running={running}
          rehearsal={String.fromCharCode(64 + Math.min(26, Math.max(1, missionCount)))}
          projectLine={projectLine}
          composer={running
            ? <p className="direction">O próximo pedido abre quando esta missão terminar.</p>
            : <RequestBox last={intake} busy={busy} compact onSend={(text) => act('/requests', { text })} />}
        />
      </>
    )
  }

  const finished = intake?.stage === 'concluida' && !intake.error
  return (
    <>{alert}
      <section className="overture">
        <div className="copy">
          <motion.h1 className="display" {...rise(0)}>O que você quer construir em <em>{project.name}</em>?<span className="cursor" aria-hidden="true" /></motion.h1>
          <motion.div {...rise(1)}>{projectLine}</motion.div>
          <motion.div {...rise(2)}><RequestBox last={intake} busy={busy} onSend={(text) => act('/requests', { text })} /></motion.div>
        </div>
        <motion.div
          className="plate-frame"
          initial={{ opacity: 0, filter: 'blur(8px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 1.4, ease: EASE_OUT, delay: 0.2 }}
        >
          <Plate name={finished ? 'coda' : 'maestro'} depth={1.4} />
        </motion.div>
      </section>
    </>
  )
}

function Movement({ title, note, plate, children }: { title: string; note: string; plate: 'estante' | 'afinacao'; children: ReactNode }) {
  return (
    <section className="movement">
      <motion.header {...rise(0)}>
        <h2 className="display">{title}</h2>
        <p className="lede">{note}</p>
        <Plate name={plate} decorative />
      </motion.header>
      <div className="body">{children}</div>
    </section>
  )
}

function Ledger({ title, items, kind }: { title: string; items: string[]; kind?: 'out' | 'done' }) {
  if (items.length === 0) return null
  return (
    <div className={`ledger ${kind ?? ''}`}>
      <h3 className="caps">{title}</h3>
      <ul className="ledger">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  )
}

function RequestBox({ last, busy, compact, onSend }: { last: Intake | null; busy: boolean; compact?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    onSend(text)
  }
  const what = last?.rejected_at === 'plan' ? 'O plano' : 'O briefing'
  return (
    <form className={`composer${compact ? ' compact' : ' terminal'}`} onSubmit={submit}>
      {!compact && (
        <ol className="term-tabs" aria-label="Etapas até a execução">
          {['pedido', 'entrevista', 'briefing', 'plano', 'partes'].map((s, i) => <li key={s} aria-current={i === 0 ? 'step' : undefined}>{s}</li>)}
        </ol>
      )}
      {last?.stage === 'recusada' && <p className="note-line warn">{what} foi recusado: {last.reason}</p>}
      {last?.stage === 'concluida' && (
        <p className={`note-line${last.error ? ' warn' : ''}`}>A missão {last.mission_id} terminou{last.error ? ` com erro: ${last.error}` : '.'}</p>
      )}
      <span className="prompt" aria-hidden="true">›</span>
      <textarea
        className="field"
        aria-label="Pedido"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !busy) onSend(text) }}
        placeholder={compact ? 'Peça a próxima mudança' : 'Descreva o que você quer construir ou mudar'}
        rows={compact ? 1 : 3}
      />
      <div className="composer-row">
        {!compact && <span className="note-line">Ctrl + Enter também envia.</span>}
        <button className="btn baton" type="submit" disabled={busy || !text.trim()}>
          <PaperPlaneRight size={15} aria-hidden="true" /> {busy ? 'Compilando o pedido…' : 'Enviar pedido'}
        </button>
      </div>
    </form>
  )
}

function InterviewView({ questions, busy, onAnswer }: { questions: Question[]; busy: boolean; onAnswer: (answers: Record<string, string>) => void }) {
  // Só vai o que o usuário mudou: o resto adota a recomendação com origem 'padrão'.
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [written, setWritten] = useState<Record<string, string>>({})
  // Escolher "responder com minhas palavras" manda o texto; em branco, vale a própria opção.
  const answers = () => Object.fromEntries(Object.entries(picked).map(([id, opt]) => {
    const free = questions.find((q) => q.id === id)?.options.find((o) => o.id === opt)?.free_text
    return [id, free && written[id]?.trim() ? written[id].trim() : opt]
  }))
  return (
    <Movement title="Entrevista" note="A primeira opção é sempre a recomendada. Não sabe? Deixe como está." plate="afinacao">
      {questions.map((q, qi) => (
        <motion.fieldset key={q.id} className="question" style={{ border: 0, margin: 0, padding: '0 0 2rem' }} {...rise(qi + 1)}>
          <legend style={{ padding: 0 }}><p style={{ font: '500 19px/1.4 var(--text)', marginBottom: '1rem' }}><span className="q-index">{qi + 1}.</span>{q.text}</p></legend>
          <div className="choices">
            {q.options.map((o, i) => (
              <label key={o.id} className="choice">
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  value={o.id}
                  checked={(picked[q.id] ?? q.options[0]?.id) === o.id}
                  onChange={() => setPicked({ ...picked, [q.id]: o.id })}
                />
                <span>
                  {o.label}{i === 0 && <span className="tag yellow">recomendado</span>}
                  {o.why && <span className="why">{o.why}</span>}
                </span>
              </label>
            ))}
          </div>
          {q.options.find((o) => o.id === picked[q.id])?.free_text && (
            <textarea
              className="field"
              rows={2}
              aria-label={`Sua resposta: ${q.text}`}
              placeholder="Escreva a resposta"
              value={written[q.id] ?? ''}
              onChange={(e) => setWritten({ ...written, [q.id]: e.target.value })}
              style={{ marginTop: '.75rem' }}
            />
          )}
        </motion.fieldset>
      ))}
      <div className="verdict-row">
        <button className="btn baton" disabled={busy} onClick={() => onAnswer(answers())}><Check size={15} aria-hidden="true" /> Responder</button>
        <button className="btn" disabled={busy} onClick={() => onAnswer({})}>Seguir com as recomendações <ArrowRight size={15} aria-hidden="true" /></button>
      </div>
    </Movement>
  )
}

function Decisions({ intake }: { intake: Intake }) {
  const decisions = intake.decisions ?? []
  if (decisions.length === 0) return null
  const questionOf = (id?: string) => intake.questions?.find((q) => q.id === id)
  return (
    <div style={{ display: 'grid', gap: '.5rem' }}>
      <h3 className="caps">Decisões da entrevista</h3>
      <ul className="decisions">
        {decisions.map((d) => {
          const q = questionOf(d.question_id)
          return (
            <li key={d.question_id ?? d.value}>
              <span>{q?.text ?? d.question_id}:</span>
              <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>{q?.options.find((o) => o.id === d.value)?.label ?? d.value}</strong>
              <span className={`tag${d.origin === 'usuario' ? ' yellow' : ''}`}>{ORIGIN_PT[d.origin]}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Verdict({ what, busy, onApprove, onReject }: { what: string; busy: boolean; onApprove: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="verdict">
      <div className="verdict-row">
        <button className="btn baton" disabled={busy} onClick={onApprove}><Check size={15} weight="bold" aria-hidden="true" /> Aprovar {what}</button>
      </div>
      <div className="verdict-row">
        <input className="field" aria-label="Motivo da recusa" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Por que não serve?" />
        <button className="btn" disabled={busy || !reason.trim()} onClick={() => onReject(reason)}>
          <X size={15} aria-hidden="true" /> Recusar {what}
        </button>
      </div>
    </div>
  )
}
