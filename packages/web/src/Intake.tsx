import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, ArrowsInSimple, ArrowsOutSimple, Check, Paperclip, Pause, PaperPlaneRight, Play, Stop, WarningCircle, X } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { apiFetch, postJson, subscribeEvents } from './api.ts'
import type { Mission } from './App.tsx'
import MissionScore from './Units.tsx'
import { shortPath } from './format.ts'
import { EASE_OUT, scrollToTop } from './motion.ts'
import Plate from './Plate.tsx'

interface Question {
  id: string
  text: string
  why?: string
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
  /** Da IA: o que entendeu do pedido e, no plano, o que o usuário vai ter e o que ela assumiu. */
  understanding?: { summary?: string; explanation?: string; decisions?: string[] }
  /** Controle da missão: rodando, pausando (termina a parte atual) ou pausada; null antes de rodar. */
  control?: 'RUNNING' | 'DRAINING' | 'STOPPED' | null
  stopped?: boolean
  closed?: boolean
}

interface ProjectRef { id: string; name: string; path: string }

const ORIGIN_PT: Record<Decision['origin'], string> = { usuario: 'você escolheu', ia_supondo: 'IA supondo', padrao: 'padrão' }
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** O que a IA faz em cada ação e quanto costuma levar: a espera de 15 s a 1 min precisa dizer que está andando. */
const THINKING: Record<string, { label: string; hint: string }> = {
  '/requests': { label: 'Lendo o pedido e o projeto', hint: 'A IA entende o pedido e prepara as perguntas. Costuma levar de 15 a 40 s.' },
  '/intake/interview': { label: 'Montando o plano', hint: 'Divide o pedido em partes e escreve como provar cada uma. Costuma levar de 30 s a 1 min e meio.' },
  '/intake/briefing/approve': { label: 'Montando o plano', hint: 'Divide o briefing em partes e escreve como provar cada uma. Costuma levar de 30 s a 1 min e meio.' },
  '/intake/plan/approve': { label: 'Preparando a execução', hint: 'Confere o projeto e começa a primeira parte.' },
  '/mission/resume': { label: 'Retomando a missão', hint: 'Confere o projeto e continua da parte em que parou.' },
}

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
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIntake(await apiFetch<Intake | null>(`${base}/intake?if_missing=null`))
  }, [base])

  useEffect(() => {
    setIntake(undefined)
    load().catch((err) => setError(messageOf(err)))
  }, [load])
  // o motor escreve no journal ao pausar, retomar e terminar: relê o pedido para os botões seguirem o estado real
  useEffect(() => subscribeEvents(() => { load().catch(() => undefined) }), [load])

  // etapa nova começa do topo: a entrevista respondida no fim da página não deixa o plano aparecer pela metade
  const stage = intake?.stage
  useEffect(() => {
    if (stage) scrollToTop(true)
  }, [stage])

  async function act(path: string, body: unknown) {
    setBusy(true)
    setPending(path)
    setError(null)
    try {
      await postJson(`${base}${path}`, body)
      await load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const thinking = busy && pending ? THINKING[pending] : undefined
  const alert = (error || thinking) && <>
    {error && <div className="alert" role="alert" style={{ marginBottom: '2rem' }}>{error}</div>}
    {thinking && <Thinking {...thinking} />}
  </>
  const projectLine = (
    <p className="project-line" data-testid="project-state">
      <span className="mono" title={project.path}>{shortPath(project.path)}</span>
      <span>{!snapshotLoaded ? 'Lendo o estado do projeto…' : mission ? `Última missão: ${mission.id}` : 'Nenhum pedido ainda.'}</span>
    </p>
  )
  if (intake === undefined) return alert || null

  if (intake?.stage === 'interview') {
    return <>{alert}<InterviewView questions={intake.questions ?? []} summary={intake.understanding?.summary} busy={busy} onAnswer={(answers) => act('/intake/interview', { answers })} /></>
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
        <Movement title="Plano" note={intake.understanding?.explanation ?? 'Cada parte e os critérios que a prova dela vai cobrar.'} plate="estante">
          {(intake.understanding?.decisions?.length ?? 0) > 0 && (
            <motion.div {...rise(1)}><Ledger title="O que a IA assumiu" items={intake.understanding?.decisions ?? []} /></motion.div>
          )}
          <h3 className="caps">{(intake.parts ?? []).length === 1 ? 'A parte e como ela vai ser provada' : `As ${(intake.parts ?? []).length} partes e como cada uma vai ser provada`}</h3>
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
  // Na tela fica a missão do pedido que rodou e não foi fechada; plano recusado ou missão fechada voltam ao começo.
  // Sem pedido do painel (missão feita pela CLI), a última missão continua na tela.
  const showMission = running || (intake ? intake.stage === 'concluida' && !intake.closed : Boolean(mission))
  if (showMission) {
    return (
      <>{alert}
        <MissionScore
          projectId={project.id}
          mission={mission}
          fallbackId={intake?.mission_id}
          running={running}
          rehearsal={String(Math.max(1, missionCount))}
          projectLine={projectLine}
          composer={<>
            <MissionControls intake={intake} busy={busy} onAct={(a) => act(`/mission/${a}`, {})} />
            {running
              ? <p className="direction">O próximo pedido abre quando esta missão terminar.</p>
              : <RequestBox last={intake} busy={busy} compact onSend={(body) => act('/requests', body)} />}
          </>}
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
          <motion.div {...rise(2)}><RequestBox last={intake} busy={busy} onSend={(body) => act('/requests', body)} /></motion.div>
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

type Attachment = { name: string; data: string; url?: string; broken?: boolean }
// os mesmos formatos que o servidor grava (src/panel/attachments.ts): extensão e assinatura dos primeiros bytes
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md'
const MAX_FILES = 10
const MAX_BYTES = 10 * 1024 * 1024
const SIGNATURES: Record<string, string[] | null> = {
  png: ['\x89PNG\r\n\x1a\n'], jpg: ['\xff\xd8\xff'], jpeg: ['\xff\xd8\xff'], gif: ['GIF87a', 'GIF89a'], webp: ['RIFF'], pdf: ['%PDF-'], txt: null, md: null,
}
// a miniatura sai da extensão já conferida pela assinatura: File.type pode vir vazio ou genérico
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const extension = (name: string) => /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? ''
// só extensões próprias da lista: `in` aceitaria herdadas como `constructor`
const accepted = (f: File) => Object.hasOwn(SIGNATURES, extension(f.name))
function signed(name: string, data: string) {
  const ext = extension(name)
  const sigs = SIGNATURES[ext]
  if (sigs === null) return true
  const head = atob(data.slice(0, 16))
  return !!sigs?.some((s) => head.startsWith(s)) && (ext !== 'webp' || head.slice(8, 12) === 'WEBP')
}
// o print do sistema chega sempre como image.png: cada colagem ganha nome próprio para não esbarrar no repetido
const GENERIC_PASTE = /^image\.(png|jpe?g|gif|webp)$/i
function pastedName(f: File, taken: string[]) {
  const ext = GENERIC_PASTE.exec(f.name)?.[1].toLowerCase()
  if (!ext) return f
  let n = 1
  while (taken.includes(`imagem-colada-${n}.${ext}`)) n++
  return new File([f], `imagem-colada-${n}.${ext}`, { type: f.type })
}
const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(f)
})

function RequestBox({ last, busy, compact, onSend }: { last: Intake | null; busy: boolean; compact?: boolean; onSend: (body: { text: string; attachments?: { name: string; data: string }[] }) => void }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  // leituras em base64 ainda abertas: o envio espera por elas
  const [reading, setReading] = useState(0)
  // nomes na lista ou em leitura; seleções seguidas conferem limite e repetição contra todos
  const taken = useRef<string[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const clip = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const blocked = busy || reading > 0
  const send = () => onSend(files.length ? { text, attachments: files.map(({ name, data }) => ({ name, data })) } : { text })
  const field = useRef<HTMLTextAreaElement>(null)
  // o campo cresce com o texto até um teto; passou dele, o botão abre o pedido inteiro
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = field.current
    if (el && !expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])
  function paste(e: ClipboardEvent<HTMLTextAreaElement>) {
    // com texto junto (Word, Excel) o texto vence; só arquivo ou print vira anexo
    const pasted = Array.from(e.clipboardData.files)
    if (!pasted.length || e.clipboardData.getData('text/plain')) return
    e.preventDefault()
    const names = [...taken.current]
    void add(pasted.map((f) => { const g = pastedName(f, names); names.push(g.name); return g }))
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    if (blocked) return
    // com só anexos o botão fica ativo, mas o servidor exige o texto: avisa e devolve o foco ao campo
    if (!text.trim()) { setProblem('Escreva o pedido antes de enviar.'); field.current?.focus(); return }
    send()
  }
  async function add(picked: FileList | File[] | null) {
    const chosen = Array.from(picked ?? [])
    if (picker.current) picker.current.value = ''
    const errors: string[] = []
    const batch: File[] = []
    for (const f of chosen) {
      if (!accepted(f)) { errors.push(`${f.name}: tipo não aceito (use PNG, JPEG, GIF, WebP, PDF, .txt ou .md).`); continue }
      if (f.size > MAX_BYTES) { errors.push(`${f.name}: passa do limite de 10 MB.`); continue }
      if (taken.current.length >= MAX_FILES) { errors.push(`${f.name}: limite de 10 arquivos atingido.`); continue }
      if (taken.current.includes(f.name)) { errors.push(`${f.name}: já está anexado.`); continue }
      taken.current.push(f.name)
      batch.push(f)
    }
    setProblem(errors.length ? errors.join(' ') : null)
    if (!batch.length) return
    setReading((n) => n + 1)
    const ready: Attachment[] = []
    try {
      const read = await Promise.allSettled(batch.map(toBase64))
      read.forEach((r, i) => {
        const f = batch[i]
        let ok = false
        try { ok = r.status === 'fulfilled' && signed(f.name, r.value) } catch { ok = false }
        if (ok && r.status === 'fulfilled') {
          // signed() já restringiu a extensão às chaves próprias da lista
          const image = IMAGE_TYPES[extension(f.name)]
          ready.push({ name: f.name, data: r.value, url: image ? URL.createObjectURL(new Blob([f], { type: image })) : undefined })
          return
        }
        taken.current = taken.current.filter((n) => n !== f.name)
        errors.push(r.status === 'fulfilled' ? `${f.name}: o conteúdo não corresponde ao tipo do arquivo.` : `${f.name}: não foi possível ler o arquivo.`)
      })
    } catch {
      // falha inesperada: nada do lote entra e o envio não fica travado
      const names = batch.map((f) => f.name)
      taken.current = taken.current.filter((n) => !names.includes(n))
      for (const x of ready.splice(0)) if (x.url) URL.revokeObjectURL(x.url)
      errors.push('Não foi possível anexar os arquivos escolhidos.')
    } finally {
      setFiles((xs) => [...xs, ...ready])
      setReading((n) => n - 1)
      if (errors.length) setProblem(errors.join(' '))
    }
  }
  function remove(name: string) {
    // o foco não cai no vazio: passa ao X vizinho, ou ao clipe quando a lista acaba
    const i = files.findIndex((x) => x.name === name)
    const neighbour = files[i + 1] ?? files[i - 1]
    taken.current = taken.current.filter((n) => n !== name)
    setFiles((xs) => xs.filter((x) => { if (x.name === name && x.url) URL.revokeObjectURL(x.url); return x.name !== name }))
    requestAnimationFrame(() => {
      const next = neighbour && list.current?.querySelector<HTMLButtonElement>(`button[data-name="${CSS.escape(neighbour.name)}"]`)
      ;(next || clip.current)?.focus()
    })
  }
  function broken(name: string) {
    setFiles((xs) => xs.map((x) => (x.name === name ? { ...x, broken: true } : x)))
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
      {last?.stage === 'concluida' && last.error && <p className="note-line warn">A missão {last.mission_id} parou com erro: {last.error}</p>}
      {/* o › fica preso ao campo: aviso acima dele não o deixa por cima do texto */}
      <div className="field-wrap">
      <span className="prompt" aria-hidden="true">›</span>
      <textarea
        ref={field}
        className={expanded ? 'field open' : 'field'}
        aria-label="Pedido"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={paste}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !blocked) send() }}
        placeholder={compact ? 'Peça a próxima mudança' : 'Descreva o que você quer construir ou mudar'}
        rows={compact ? 1 : 3}
      />
      </div>
      {(files.length > 0 || problem) && (
        <div className="attachments">
          {files.length > 0 && (
            <ul ref={list} className="attach-list" aria-label="Anexos">
              {files.map((f) => {
                const thumb = f.url && !f.broken
                return (
                  <li key={f.name} className={thumb ? 'attach thumb' : 'attach chip'} title={f.name}>
                    {thumb ? <img src={f.url} alt={f.name} onError={() => broken(f.name)} /> : <span className="attach-name">{f.name}</span>}
                    <button type="button" className="attach-remove" data-name={f.name} aria-label={`Remover ${f.name}`} onClick={() => remove(f.name)}>
                      <X size={12} weight="bold" aria-hidden="true" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {problem && <p className="attach-error" role="alert"><WarningCircle size={14} weight="bold" aria-hidden="true" /><span>{problem}</span></p>}
        </div>
      )}
      <div className="composer-row">
        <div className="composer-tools">
          <button ref={clip} type="button" className="clip" aria-label="Anexar arquivos" title="Anexar arquivos" onClick={() => picker.current?.click()}>
            <Paperclip size={18} weight="light" aria-hidden="true" />
          </button>
          {(overflowing || expanded) && (
            <button type="button" className="clip" aria-expanded={expanded} aria-label={expanded ? 'Retrair campo' : 'Expandir campo'} title={expanded ? 'Retrair campo' : 'Expandir campo'} onClick={() => { setExpanded(!expanded); field.current?.focus({ preventScroll: true }) }}>
              {expanded ? <ArrowsInSimple size={18} weight="light" aria-hidden="true" /> : <ArrowsOutSimple size={18} weight="light" aria-hidden="true" />}
            </button>
          )}
          <input ref={picker} type="file" multiple accept={ACCEPT} hidden tabIndex={-1} onChange={(e) => void add(e.target.files)} />
          {!compact && <span className="note-line kbd-hint">Ctrl + Enter envia. Ctrl + V cola imagens.</span>}
        </div>
        <button className="btn baton" type="submit" disabled={blocked || (!text.trim() && files.length === 0)}>
          <PaperPlaneRight size={15} aria-hidden="true" /> {busy ? 'Enviando…' : reading ? 'Lendo anexos…' : 'Enviar pedido'}
        </button>
      </div>
    </form>
  )
}

function InterviewView({ questions, summary, busy, onAnswer }: { questions: Question[]; summary?: string; busy: boolean; onAnswer: (answers: Record<string, string>) => void }) {
  // Só vai o que o usuário mudou: o resto adota a recomendação com origem 'padrão'.
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [written, setWritten] = useState<Record<string, string>>({})
  // Escolher "responder com minhas palavras" manda o texto; em branco, vale a própria opção.
  const answers = () => Object.fromEntries(Object.entries(picked).map(([id, opt]) => {
    const free = questions.find((q) => q.id === id)?.options.find((o) => o.id === opt)?.free_text
    return [id, free && written[id]?.trim() ? written[id].trim() : opt]
  }))
  return (
    <Movement title="Entrevista" note={`${summary ? `${summary} ` : ''}A primeira opção é sempre a recomendada. Não sabe? Deixe como está.`} plate="afinacao">
      {questions.map((q, qi) => (
        <motion.fieldset key={q.id} className="question" style={{ border: 0, margin: 0, padding: '0 0 2rem' }} {...rise(qi + 1)}>
          <legend style={{ padding: 0 }}><p style={{ font: '500 19px/1.4 var(--text)', marginBottom: '1rem' }}><span className="q-index">{qi + 1}.</span>{q.text}</p>{q.why && <p className="q-why">{q.why}</p>}</legend>
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

/** Aviso fixo enquanto a IA trabalha: o que ela faz, quanto costuma levar e há quanto tempo está nisso. */
function Thinking({ label, hint }: { label: string; hint: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <motion.div
      className="thinking"
      role="status"
      aria-live="polite"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_OUT }}
    >
      <span className="pulse running" aria-hidden="true" />
      <div>
        <p className="thinking-label">{label}<span className="mono thinking-time">{seconds} s</span></p>
        <p className="thinking-hint">{hint}</p>
      </div>
      <span className="thinking-bar" aria-hidden="true" />
    </motion.div>
  )
}

/** Pausar, retomar e parar a missão do pedido. Pausar deixa a parte em andamento terminar; parar mantém o que já foi entregue. */
function MissionControls({ intake, busy, onAct }: { intake: Intake | null; busy: boolean; onAct: (action: 'pause' | 'resume' | 'stop' | 'close') => void }) {
  if (!intake) return null
  const running = intake.stage === 'running'
  const paused = !intake.stopped && intake.stage === 'concluida' && intake.control === 'STOPPED'
  // fechar volta ao começo do projeto para um pedido novo; a missão continua no histórico
  const close = <button className="btn small" disabled={busy} onClick={() => onAct('close')}><X size={13} aria-hidden="true" /> Fechar missão</button>
  if (intake.stopped || (intake.stage === 'concluida' && !paused)) return <div className="mission-controls">{close}</div>
  if (running && intake.control === 'DRAINING') {
    return <p className="mission-controls note-line"><span className="pulse waiting" aria-hidden="true" />Pausando: a parte em andamento termina e a missão para.</p>
  }
  if (running) {
    return (
      <div className="mission-controls">
        <button className="btn small" disabled={busy} onClick={() => onAct('pause')}><Pause size={13} aria-hidden="true" /> Pausar</button>
        <button className="btn small" disabled={busy} onClick={() => onAct('stop')}><Stop size={13} aria-hidden="true" /> Parar</button>
      </div>
    )
  }
  if (paused) {
    return (
      <div className="mission-controls">
        <span className="note-line">Missão pausada. O que já foi entregue fica.</span>
        <button className="btn baton small" disabled={busy} onClick={() => onAct('resume')}><Play size={13} aria-hidden="true" /> Retomar</button>
        <button className="btn small" disabled={busy} onClick={() => onAct('stop')}><Stop size={13} aria-hidden="true" /> Parar de vez</button>
        {close}
      </div>
    )
  }
  return null
}
