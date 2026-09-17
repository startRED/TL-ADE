// TL-ADE — demonstração (incompleta, mas real). Orquestra Claude Code, Codex e Antigravity (agy)
// sobre qualquer pasta escolhida pelo operador: pedido -> plano com stories -> skills automáticas ->
// prova vermelha -> implementação -> provas verdes -> portão visual -> revisão por outra família.
// Sem durabilidade de verdade (estado em memória; journal só registra). Esse é o slice 1.

import { SCOUT_SCHEMA, scoutPrompt } from './scout.mjs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, appendFile, rm, stat, access, readdir, realpath , rename } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ADE_DIR = path.join(ROOT, '.ade')
const REVIEW_SCHEMA = path.join(ROOT, 'review.schema.json')
const RESEARCH_SCHEMA = path.join(ROOT, 'research.schema.json')
const PLANCRITIC_SCHEMA = path.join(ROOT, 'plancritic.schema.json')
const PORT = Number(process.env.ADE_PORT) || 4317 // abrir.bat 2 → 4318/5174: duas ADEs em projetos diferentes ao mesmo tempo
const IS_WIN = process.platform === 'win32'
const HOME = os.homedir()
const IMPECCABLE = path.join(HOME, '.claude/plugins/cache/impeccable/impeccable/4.3.1/skills/impeccable/scripts/impeccable')

// ---------- registro de modelos (verificado nas CLIs instaladas em 2026-09-16) ----------
const REGISTRY = {
  claude: { label: 'Claude Code', models: [
    { id: 'sonnet', label: 'Sonnet 5', note: 'rápido e barato; padrão para escrever código' },
    { id: 'opus', label: 'Opus 5', note: 'mais forte; padrão para planejar' },
    { id: 'fable', label: 'Fable 5.1', note: 'o mais forte; ~US$ 0,60 por chamada só de abertura' },
    { id: 'haiku', label: 'Haiku 4.5', note: 'muito barato; tarefas mecânicas' },
  ] },
  codex: { label: 'Codex (OpenAI)', models: [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'padrão para revisar' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'mais leve' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: '' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'o mais forte da OpenAI' },
    { id: 'gpt-5.5', label: 'GPT-5.5', note: '' },
  ] },
  agy: { label: 'Antigravity (Google)', models: [
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', note: 'padrão para pesquisa; esforço alto ou baixo' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'rápido e barato; padrão do batedor' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', note: '' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 via Google', note: 'conta como família Claude' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 via Google', note: 'conta como família Claude' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', note: 'quarta opinião' },
  ] },
}
// Esforço por papel (Erick, 17/09): Claude → --effort; Codex → model_reasoning_effort; Antigravity → sufixo do modelo (pro só tem high/low).
const EFFORTS = ['low', 'medium', 'high']
function effortOf(role) { return state.settings.roles[role]?.effort || DEFAULT_SETTINGS.roles[role]?.effort || 'medium' }
function agyModel(id, effort) { const mm = /^(gemini-[\d.]+-(flash|pro))(?:-(high|medium|low))?$/.exec(id || ''); if (!mm) return id; const e = mm[2] === 'pro' && effort === 'medium' ? 'high' : (effort || 'medium'); return `${mm[1]}-${e}` }
// Recomendação de quem planeja, pela dificuldade que o entendedor mediu (Erick, 17/09): leve → Sonnet; normal → Opus médio; pesado → Fable alto.
const PLANNER_BY_DIFFICULTY = { easy: { family: 'claude', model: 'sonnet', effort: 'medium' }, normal: { family: 'claude', model: 'opus', effort: 'medium' }, hard: { family: 'claude', model: 'fable', effort: 'high' } }
function plannerChoice(kind = 'complex') { const r = state.settings.roles; const x = kind === 'light' ? (r.planner_light || r.planner) : r.planner; return { family: x.family || 'claude', model: x.model, effort: x.effort || 'high' } }
// Planejador por família: Claude (saída estruturada do Claude Code) ou Codex (--output-schema, só leitura). Devolve { structured_output }.
async function plannerCall(who, { role, prompt, schema, maxTurns }) {
  if (who.family === 'codex') {
    const m = state.mission, dir = state.project.dir
    const file = path.join(ADE_DIR, 'schemas', createHash('sha1').update(JSON.stringify(schema)).digest('hex').slice(0, 12) + '.json')
    await mkdir(path.dirname(file), { recursive: true }); if (!(await exists(file))) await writeFile(file, JSON.stringify(schema))
    log('engine', `codex (${role}, ${who.model}, esforço ${who.effort}) com saída estruturada`); setLive({ source: 'codex', kind: 'thinking', text: `${role}: lendo o projeto…` })
    let last = null, usage = null; const t0 = Date.now()
    const r = await run('codex', ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c', `model_reasoning_effort=${who.effort}`, '-C', dir, '-m', who.model, '--output-schema', file, '-'], { cwd: dir, stdin: prompt, timeoutMs: 30 * 60 * 1000, onLine: (line) => {
      let ev; try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text
      if (ev.type === 'item.started' && ev.item?.type === 'command_execution') setLive({ source: 'codex', kind: 'tool', text: ev.item.command || '' })
      if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') log('codex', `$ ${ev.item.command}`.slice(0, 200), 'tool')
      if (ev.type === 'turn.completed') usage = ev.usage
    } })
    setLive(null); m.cost.calls += 1
    if (usage) { m.cost.tokens_in += usage.input_tokens || 0; m.cost.tokens_out += usage.output_tokens || 0 }
    let out = null; try { out = JSON.parse(last) } catch {}
    journal({ type: 'model_call', family: 'codex', role, model: who.model, effort: who.effort, usd: 0, tokens_in: usage?.input_tokens || 0, cache_read: usage?.cached_input_tokens || 0, tokens_out: usage?.output_tokens || 0, prompt_chars: prompt.length, wall_ms: Date.now() - t0 }).catch(() => {})
    readQuota().then(broadcastSoon)
    if (!out) log('engine', `codex (${role}) não devolveu JSON (código ${r.code}): ${(last || r.err || r.out).trim().slice(0, 300)}`, 'error')
    return out ? { structured_output: out } : null
  }
  if (who.family !== 'claude') { log('engine', `planejador ${who.model} não é Claude nem Codex; usando opus alto`, 'warn'); who = { family: 'claude', model: 'opus', effort: 'high' } }
  return claudeCall({ role, prompt, model: who.model, effort: who.effort, tools: ['Read', 'Glob', 'Grep'], schema, maxTurns })
}
const vendorOf = (family, model) => family === 'agy' && /^claude/.test(model) ? 'anthropic' : family === 'agy' && /^gpt/.test(model) ? 'openai' : family === 'claude' ? 'anthropic' : family === 'codex' ? 'openai' : 'google'

const DEFAULT_SETTINGS = {
  roles: {
    intent: { family: 'claude', model: 'sonnet', effort: 'medium' },
    planner: { family: 'claude', model: 'fable', effort: 'high' }, // plano complexo: divide pedido grande em épicos; plano único de dificuldade pesada
    planner_light: { family: 'claude', model: 'opus', effort: 'high' }, // plano intermediário/simples: stories de cada épico, planos leves e normais, revisões automáticas
    maker: { family: 'claude', model: 'sonnet', effort: 'high' },
    checker: { family: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
    research: { family: 'agy', model: 'gemini-3.1-pro', effort: 'high' },
    scout: { family: 'agy', model: 'gemini-3.8-flash', effort: 'medium' }, // batedor: lê muito (projeto, web, GitHub) e devolve um recibo curto
  },
  planner_recommend: true, // o entendedor mede a dificuldade e recomenda quem planeja; você escolhe (modo noturno segue a recomendação)
  epic_plans_cheaper: true, // com Fable como planejador, ele só divide o pedido em épicos; o plano de cada épico sai no Opus alto (medido: US$ 5,60 e 13 min por épico no Fable, 74k tokens de saída)
  plan_critic: true, // outra IA (o revisor) lê o plano antes de qualquer código e aponta o que obrigaria quem escreve a decidir; o planejador corrige uma vez
  scout_enabled: true, // batedor antes de planejar (pedido de funcionalidade para cima, em projeto que já tem código) e sob demanda pelo maker
  allow_commands: true,
  research_enabled: true,
  visual_gate: true,
  fast_lane: true, // faixa rápida (ADR 0008 / E18): pedido curto de correção num projeto existente pula entrevista e plano no Opus
  max_usd_per_story: 5, // orçamento por parte (spec E4): estourou com provas verdes → aceita; sem provas verdes → para
  unattended: false, // modo noturno (ADR 0015): responde a entrevista com as recomendações, aprova o plano, e em parada sem saída pula a parte e segue
  max_usd_per_mission: 60, // teto por missão (US$ no Claude): estourou → pausa em vez de continuar gastando
  autonomy: 'auto', // auto: após 6 rodadas com provas verdes e sem achado grave do revisor, aceita e segue; ask: para e pergunta
  interview: 'auto', // auto | always | never — entrevista de múltipla escolha antes do plano (spec: ≤5 perguntas, recomendação primeiro)
  assets_enabled: true, // imagens geradas pelo Codex ($imagegen) quando o plano pede
  skills: { auto: true, forced: [], excluded: [], max: 4 },
}

// ---------- estado ----------
// Vários projetos ao mesmo tempo: cada pasta tem um "engine" (projeto, missão, log, anexos). O que é global fica em G.
// `state` é um proxy: dentro de uma cadeia assíncrona iniciada por withEngine(e, fn), state.mission/project/log/... apontam
// para aquele engine; fora dela, para o engine ativo (o que o painel está mostrando). Assim o motor não precisou mudar.
const G = { history: [], recent: [], settings: DEFAULT_SETTINGS, catalog: [], registry: REGISTRY, quota: { claude: null, codex: null } }
const engines = new Map() // dir → engine
let activeDir = null
const als = new AsyncLocalStorage()
const PAUSE = Symbol('pause')
function newEngine(project) { return { project, mission: null, log: [], live: null, attachments: [], phase: null, children: new Set(), chat: [], chat_busy: false } }
function engineFor(dir) { const key = path.resolve(dir); if (!engines.has(key)) { const e = newEngine(null); engines.set(key, e); loadChat(key).then((c) => { e.chat = c; broadcastSoon() }).catch(() => {}) } return engines.get(key) }
// conversa por pasta (Erick, 17/09): perguntas e pedidos variados, com o modelo que você escolher, sem virar missão. Só leitura.
const CHATS_DIR = path.join(ADE_DIR, 'chats')
const chatKey = (dir) => path.resolve(dir).replace(/[^\w.-]+/g, '_').slice(-90)
async function loadChat(dir) { try { return JSON.parse(await readFile(path.join(CHATS_DIR, chatKey(dir) + '.json'), 'utf8')) } catch { return [] } }
async function saveChat(dir, turns) { await mkdir(CHATS_DIR, { recursive: true }); await writeFile(path.join(CHATS_DIR, chatKey(dir) + '.json'), JSON.stringify(turns.slice(-80))) }
function activeEngine() { if (!activeDir) return null; return engines.get(activeDir) || null }
function currentEngine() { return als.getStore() || activeEngine() || (activeDir = 'sem-projeto', engines.set('sem-projeto', newEngine(null)), engines.get('sem-projeto')) }
const withEngine = (e, fn) => als.run(e, fn)
const state = new Proxy({}, {
  get(_, k) { if (k in G) return G[k]; return currentEngine()[k] },
  set(_, k, v) { if (k in G) G[k] = v; else currentEngine()[k] = v; return true },
})

// ---------- anexos e diálogos do Explorer ----------
const ATTACH_DIR = '.ade-attachments'
async function pickNative(kind, start = '') {
  // Diálogo nativo do Explorer. O dono (form invisível, TopMost) precisa estar MOSTRADO: com um form nunca exibido o ShowDialog devolvia Cancel na hora, sem abrir nada.
  // Pasta: truque do OpenFileDialog (Explorer moderno, com "Nova pasta"); a pasta é o diretório do nome escolhido.
  const owner = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; Opacity = 0; ShowInTaskbar = $false; Width = 1; Height = 1; StartPosition = 'CenterScreen' }; $f.Show(); $f.Activate(); "
  const script = kind === 'folder'
    ? owner + "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Escolha a pasta do projeto (ou crie uma nova com o botao)'; $d.ShowNewFolderButton = $true; $d.RootFolder = 'MyComputer'; $d.SelectedPath = '" + String(start).replace(/'/g, "''") + "'; $r = $d.ShowDialog($f); $f.Close(); if ($r -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
    : owner + "$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Anexar arquivos ou fotos'; $d.Multiselect = $true; $d.Filter = 'Tudo (*.*)|*.*|Imagens|*.png;*.jpg;*.jpeg;*.webp;*.gif|Documentos|*.pdf;*.md;*.txt;*.docx;*.xlsx;*.csv;*.json'; $r = $d.ShowDialog($f); $f.Close(); if ($r -eq 'OK') { [Console]::Out.Write(($d.FileNames -join [char]10)) }"
  const r = await run('powershell', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 10 * 60 * 1000 })
  return r.out.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean)
}
function safeName(name) { return name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'anexo' }
async function addAttachments({ paths = [], files = [] }) {
  if (!state.project) throw new Error('Escolha uma pasta primeiro.')
  const dir = path.join(state.project.dir, ATTACH_DIR); await mkdir(dir, { recursive: true }); await ensureIgnore(state.project.dir)
  const added = []
  const put = async (name, data) => {
    let target = safeName(name), i = 1
    while (await exists(path.join(dir, target))) target = target.replace(/(\.[^.]*)?$/, (ext) => `-${i++}${ext}`)
    await writeFile(path.join(dir, target), data)
    const item = { name: target, path: `${ATTACH_DIR}/${target}`, bytes: data.length, image: /\.(png|jpe?g|webp|gif)$/i.test(target) }
    state.attachments.push(item); added.push(item)
  }
  for (const f of files) { const data = Buffer.from(String(f.data || '').replace(/^data:[^,]*,/, ''), 'base64'); if (data.length > 25e6) throw new Error(`${f.name}: acima de 25 MB`); await put(f.name || 'colado.png', data) }
  for (const src of paths) { const st = await stat(src).catch(() => null); if (!st?.isFile()) continue; if (st.size > 25e6) throw new Error(`${path.basename(src)}: acima de 25 MB`); await put(path.basename(src), await readFile(src)) }
  broadcast(); return added
}
function attachBlock(list) {
  if (!list?.length) return ''
  return `ANEXOS DO USUÁRIO (abra com Read; imagens e PDF o Read mostra; trate como referência do que ele quer): ${list.map((a) => `${a.path} (${a.image ? 'imagem' : 'arquivo'}, ${Math.round(a.bytes / 1024)} KB)`).join('; ')}`
}

// ---------- cota do plano ----------
// Claude: a linha de status do Claude Code recebe rate_limits em cada turno interativo e grava em ~/.claude/ade-usage.json (ver README).
// Codex: cada sessão (sem --ephemeral) grava token_count com rate_limits em ~/.codex/sessions. Antigravity não deixa nada legível: abrir o agy → Models & Quota.
async function readQuota() {
  try {
    const j = JSON.parse(await readFile(path.join(HOME, '.claude/ade-usage.json'), 'utf8'))
    const rl = j.rate_limits || {}
    const pick = (w) => w ? { used: Math.round(w.used_percentage ?? w.used_percent ?? 0), resets_at: w.resets_at ? new Date(typeof w.resets_at === 'number' ? w.resets_at * 1000 : w.resets_at).toISOString() : null } : null
    state.quota.claude = { at: j.t ? new Date(j.t * 1000).toISOString() : null, five_hour: pick(rl.five_hour), seven_day: pick(rl.seven_day) }
  } catch { state.quota.claude = null }
  try {
    const root = path.join(HOME, '.codex/sessions')
    let newest = null
    for (const y of await readdir(root)) for (const mo of await readdir(path.join(root, y))) for (const d of await readdir(path.join(root, y, mo))) for (const f of await readdir(path.join(root, y, mo, d))) {
      const full = path.join(root, y, mo, d, f); const st = await stat(full)
      if (!newest || st.mtimeMs > newest.m) newest = { full, m: st.mtimeMs }
    }
    const lines = (await readFile(newest.full, 'utf8')).split('\n').filter((l) => l.includes('"rate_limits"'))
    const ev = JSON.parse(lines[lines.length - 1]); const rl = ev.payload?.rate_limits || {}
    const win = (w) => w ? { used: Math.round(w.used_percent || 0), minutes: w.window_minutes, resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null } : null
    const wins = [rl.primary, rl.secondary].filter(Boolean).map(win)
    state.quota.codex = { at: new Date(newest.m).toISOString(), five_hour: wins.find((w) => w.minutes <= 300) || null, seven_day: wins.find((w) => w.minutes > 300) || null, plan: rl.plan_type || null }
  } catch { state.quota.codex = null }
}
let pending = null
const clients = new Set()

function now() { return new Date().toISOString() }
function engineView(e, dir, full) { return { dir, project: e.project, mission: e.mission, live: e.live, attachments: e.attachments, log: full ? e.log : undefined, chat: full ? e.chat : undefined, chat_busy: !!e.chat_busy, busy: !!(e.mission && ['running', 'planning'].includes(e.mission.state)) } }
function pub() {
  const a = activeEngine() || newEngine(null)
  return {
    ...engineView(a, activeDir, true),
    engines: [...engines.entries()].filter(([, e]) => e.project).map(([dir, e]) => ({ ...engineView(e, dir, false), active: dir === activeDir })),
    history: G.history, recent: G.recent, settings: G.settings, registry: G.registry, quota: G.quota, catalog: G.catalog.map(({ body, ...c }) => c),
  }
}
function tickClock() {
  for (const e of engines.values()) {
    const m = e.mission; if (!m) continue
    const on = ['running', 'planning'].includes(m.state)
    if (on && !m.active_since) m.active_since = now()
    else if (!on && m.active_since) { m.active_ms = (m.active_ms || 0) + Math.max(0, Date.now() - new Date(m.active_since)); m.active_since = null }
  }
}
function broadcast() { tickClock(); const data = `data: ${JSON.stringify(pub())}\n\n`; for (const res of clients) res.write(data); persistSoon() }
function broadcastSoon() { if (pending) return; pending = setTimeout(() => { pending = null; broadcast() }, 150) }
function setLive(live) { state.live = live; broadcastSoon() }

async function journal(event) {
  await mkdir(ADE_DIR, { recursive: true })
  await appendFile(path.join(ADE_DIR, 'journal.jsonl'), JSON.stringify({ ts: now(), project: state.project?.dir, mission: state.mission?.id, ...event }) + '\n')
}
function log(source, text, kind = 'info') {
  const line = { ts: now(), source, text: String(text).slice(0, 4000), kind, phase: state.phase, story: state.mission?.current ?? null }
  state.log.push(line)
  if (state.log.length > 800) state.log.shift()
  journal({ type: 'log', ...line }).catch(() => {})
  broadcast()
}
function story() { const m = state.mission; return m && m.current != null ? m.stories[m.current] : null }
function setStep(name, status, extra = {}) {
  const target = ['intent', 'plan', 'research', 'prepare', 'assets'].includes(name) ? state.mission : story()
  if (!target) return
  const step = target.steps.find((s) => s.name === name)
  const stamp = status === 'running' ? { started_at: now() } : { finished_at: now() }
  if (status === 'running') state.phase = name
  if (step) Object.assign(step, { status, ...stamp, ...extra }); else target.steps.push({ name, status, ...stamp, ...extra })
  journal({ type: 'step', name, status, story: state.mission?.current ?? null }).catch(() => {})
  broadcast()
}

// ---------- processos ----------
function run(cmd, args, { cwd, stdin, onLine, timeoutMs = 20 * 60 * 1000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    // shell:true no Windows concatena os argumentos sem aspas: qualquer argumento com espaço ou aspas
    // (mensagem de commit, prompt do agy, schema JSON) precisa de escape estilo MSVC aqui, uma vez só.
    const quoted = IS_WIN ? args.map((a) => /[\s"&|<>^()]/.test(a) ? '"' + a.replace(/(\\*)"/g, '$1$1\\"') + '"' : a) : args
    const eng = als.getStore(); if (eng?.mission?.pause_requested) return reject(PAUSE)
    const child = spawn(cmd, quoted, { cwd, shell: IS_WIN, env: { ...process.env, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', ...env }, windowsHide: true })
    if (eng) eng.children.add(child)
    let out = '', err = '', buf = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (!onLine) return
      buf += d
      const lines = buf.split(/\r?\n/); buf = lines.pop()
      for (const l of lines) if (l.trim()) onLine(l)
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); if (eng) eng.children.delete(child); if (onLine && buf.trim()) onLine(buf); if (eng?.mission?.pause_requested) return reject(PAUSE); resolve({ code, out, err, timedOut }) })
    child.on('error', (e) => { clearTimeout(timer); if (eng) eng.children.delete(child); resolve({ code: -1, out, err: String(e) }) })
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end() } else child.stdin.end()
  })
}
const exists = (p) => access(p).then(() => true, () => false)
// mata a árvore inteira (shell:true no Windows: cmd.exe → claude/codex/node); só child.kill() deixaria o neto vivo
function killTree(child) { try { if (IS_WIN) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM') } catch {} }

// ---------- pausar / continuar / persistir ----------
const MISSIONS_DIR = path.join(ADE_DIR, 'missions')
async function persistMission(e = currentEngine()) {
  const m = e?.mission; if (!m || !e.project) return
  await mkdir(MISSIONS_DIR, { recursive: true })
  const file = path.join(MISSIONS_DIR, `${m.id}.json`), tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ dir: e.project.dir, mission: m, log: e.log.slice(-400), saved_at: now() }))
  for (let i = 0; ; i++) { try { await rename(tmp, file); break } catch (err) { if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) { await rm(tmp, { force: true }).catch(() => {}); throw err } await new Promise((r) => setTimeout(r, 60 * (i + 1))) } } // Windows: antivírus/indexador seguram o arquivo por instantes
}
async function persistEngines() { await saveJson('engines.json', { dirs: [...engines.entries()].filter(([, e]) => e.project).map(([k]) => k), active: activeDir }) }
let persistTimer = null
function persistSoon() { if (persistTimer) return; persistTimer = setTimeout(() => { persistTimer = null; for (const e of engines.values()) persistMission(e).catch(() => {}); persistEngines().catch(() => {}) }, 3000) }
// guard: toda cadeia do motor passa por aqui. PAUSE vira estado 'paused' (parte em andamento volta para a fila); outro erro vira parada.
async function guard(fn) {
  try { return await fn() } catch (err) {
    const m = state.mission; if (!m) return
    if (err === PAUSE || (m.reason === 'budget' && state.settings.unattended)) {
      const byQuota = !m.pause_requested && !!m.quota_until
      m.pause_requested = false; m.state = 'paused'; m.reason = byQuota ? 'quota' : null
      if (m.current != null && m.stories[m.current] && m.stories[m.current].state !== 'done') { const st = m.stories[m.current]; Object.assign(st, { state: 'queued', round: 0, steps: [], red_tests: [], tests_after: null, diff: '', review: null, visual: null, base: null, maker_committed: false }); if (state.project) await gitDiscard(state.project.dir).catch(() => {}); await refreshProject().catch(() => {}) }
      state.live = null; log('operador', 'pausou; a parte em andamento volta do começo quando continuar')
      await persistMission().catch(() => {}); return finish()
    }
    m.state = 'awaiting_operator'; m.reason = 'engine_error'; log('engine', `erro do engine: ${err.message}`, 'error'); await persistMission().catch(() => {}); return finish()
  }
}
function quotaPause(who, until) {
  const m = state.mission; m.quota_until = until
  log('engine', `cota do ${who} esgotada: a missão pausa sem gastar rodadas e retoma sozinha ${new Date(until).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}. Para não esperar, troque o modelo desse papel em Modelos e continue.`, 'warn')
  scheduleQuotaResume(currentEngine()); throw PAUSE
}
function scheduleQuotaResume(e) {
  const m = e.mission; if (!m?.quota_until) return
  setTimeout(() => { if (e.mission === m && m.state === 'paused' && m.reason === 'quota' && !busyOf(e)) withEngine(e, () => guard(resumeMission)) }, Math.max(5000, new Date(m.quota_until) - Date.now()))
}
async function pauseMission() {
  const e = currentEngine(); const m = e.mission
  if (!m || !['running', 'planning'].includes(m.state)) return 'Nada rodando para pausar.'
  m.pause_requested = true; log('operador', 'pediu para pausar; interrompendo a IA…', 'warn')
  for (const c of e.children) killTree(c) // sem processo vivo, a próxima chamada a run() rejeita com PAUSE e o guard fecha a missão
  return null
}
async function resumeMission() {
  const m = state.mission
  if (!m || m.state !== 'paused') return 'Esta missão não está pausada.'
  const fresh = await discover(state.project.dir); if (fresh.dirty) { await gitDiscard(fresh.dir); }
  state.project = await discover(fresh.dir); m.finished_at = null; const auto = m.reason === 'quota'; m.reason = null; m.quota_until = null; log(auto ? 'engine' : 'operador', 'continuou a missão')
  if (m.program) {
    let reopened = 0
    for (const ep of m.program.epics) {
      const miss = (ep.stories || []).filter((x) => x.state !== 'done' && !(ep.stories || []).some((f) => f.id === `${x.id}f` && f.state === 'done'))
      if (ep.state === 'done' && miss.length) { ep.state = 'queued'; ep.attempts = 0; ep.already = (ep.stories || []).filter((x) => x.state === 'done').map((x) => x.title); ep.missing = miss.map((x) => `${x.title} (${x.skipped_reason || x.state})`); ep.stories_prev = (ep.stories || []).filter((x) => x.state === 'done'); reopened++ }
      if (ep.state === 'incomplete') { ep.state = 'queued'; ep.attempts = 0; reopened++ }
      if (ep.state === 'failed') { ep.state = 'queued'; ep.reason = null; ep.plan_tries = 0; reopened++ }
    }
    if (reopened) { for (const ep of m.program.epics) if (['running', 'blocked'].includes(ep.state)) ep.state = 'queued'; m.epic = null; m.stories = []; m.current = null; m.reason = null; log('engine', `${reopened} épico(s) incompleto(s) ou sem plano voltaram para a fila antes de seguir`, 'warn') }
  }
  if (m.program) { m.state = 'running'; return guard(async () => { if (m.epic && m.stories.length) { const r = await runStories(); return r } return runProgram() }) }
  if (!m.plan || !m.stories.length) { m.state = 'planning'; m.steps = []; return guard(planMission) }
  return guard(runStories)
}
async function journalWallMs(id) {
  let total = 0
  try { for (const line of (await readFile(path.join(ADE_DIR, 'journal.jsonl'), 'utf8')).split('\n')) { if (!line.includes(id)) continue; try { const j = JSON.parse(line); if (j.mission === id) total += j.wall_ms || 0 } catch {} } } catch {}
  return total
}
async function loadSavedMissions() {
  const saved = await loadJson('engines.json', { dirs: [], active: null })
  for (const d of saved.dirs || []) { try { const e = engineFor(d); e.project = await discover(d); if (e.project.error) engines.delete(path.resolve(d)) } catch { engines.delete(path.resolve(d)) } }
  let files = []; try { files = (await readdir(MISSIONS_DIR)).filter((f) => f.endsWith('.json')) } catch { files = [] } // cópias de segurança e temporários da gravação atômica não são missões
  const latest = new Map() // dir → missão mais recente
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(path.join(MISSIONS_DIR, f), 'utf8')); const key = path.resolve(j.dir)
      if (!latest.has(key) || (j.mission.started_at || '') > (latest.get(key).mission.started_at || '')) latest.set(key, j)
    } catch {}
  }
  for (const [key, j] of latest) {
    const m = j.mission
    const e = engineFor(key); if (!e.project) { e.project = await discover(key); if (e.project.error) { engines.delete(key); continue } }
    if (['running', 'planning'].includes(m.state)) { // caiu no meio: vira pausada; a parte em andamento volta do começo ao continuar
      m.pause_requested = false; m.state = 'paused'; m.reason = null
      if (m.current != null && m.stories[m.current] && m.stories[m.current].state !== 'done') Object.assign(m.stories[m.current], { state: 'queued', round: 0, steps: [], red_tests: [], tests_after: null, diff: '', review: null, visual: null, base: null, maker_committed: false })
      if (!m.plan || !m.stories.length) { m.steps = [] }
      j.log = [...(j.log || []), { ts: now(), source: 'engine', kind: 'warn', text: 'o servidor foi reiniciado no meio; a missão ficou pausada. Continuar retoma da parte pendente.' }]
    }
    if (m.program && m.epic) m.epic = m.program.epics.find((x) => x.id === m.epic.id) || null
    if (m.active_since) { m.active_ms = (m.active_ms || 0) + Math.max(0, new Date(j.saved_at || m.active_since) - new Date(m.active_since)); m.active_since = null } // caiu rodando: conta até a última gravação
    if (m.active_ms == null) m.active_ms = await journalWallMs(m.id) // missão anterior ao relógio: soma a duração das chamadas de modelo do journal
    e.mission = m; e.log = j.log || []; e.live = null
    if (m.state === 'paused' && m.reason === 'quota') scheduleQuotaResume(e)
  }
  if (saved.active && engines.get(path.resolve(saved.active))?.project) activeDir = path.resolve(saved.active)
}

// ---------- configurações e recentes ----------
async function loadJson(file, fallback) { try { return JSON.parse(await readFile(path.join(ADE_DIR, file), 'utf8')) } catch { return fallback } }
async function saveJson(file, data) { await mkdir(ADE_DIR, { recursive: true }); await writeFile(path.join(ADE_DIR, file), JSON.stringify(data, null, 2)) }
async function saveRecent(dir) { state.recent = [dir, ...state.recent.filter((d) => d !== dir)].slice(0, 8); await saveJson('projects.json', state.recent) }

// ---------- catálogo de skills ----------
const DENY = /caveman|cavecrew|closeout|stocktake|humanizer|^bro$|eli5|revisor|tl-orchestrator|graphify|everything-claude|configure-ecc|hookify|instinct|continuous-learning|^agent-sort|dmux|devfleet|council|crosspost|article-writing|brand-voice|content-engine|customer-|customs-|carrier-|energy-|finance-billing|healthcare|hipaa|investor|jira|knowledge-ops|lead-|logistics|market-research|messages-ops|nanoclaw|openclaw|opensource|production-scheduling|project-flow|quality-nonconformance|returns-|unified-notifications|visa-|google-workspace|x-api|videodb|video-editing|remotion|manim|fal-ai|minecraft|voxy|prism-client|neoforge|mod-backport|spark-profiler|log-crash|chunk-pipeline|proxmox|iridium|safe-change|stitch|imagegen|image-to-code|full-output|gpt-taste|design-taste-frontend-v1|frontend-slides|ui-demo|^claw$|^ck$|cost-aware|ecc-tools|email-ops|enterprise-agent|inventory|llm-trading|nutrient|foundation-models|exa-search|rules-distill|gan-style|eval-harness|connections-optimizer|content-hash|continuous-agent|click-path|session-closeout|skill-stocktake|using-superpowers|writing-skills|claude-md-improver|everything-claude-useful|token-budget|context-budget|strategic-compact|prompt-optimizer|search-first|repo-scan|research-ops|team-builder|terminal-ops|social-graph|plankton|santa-|ralphinho|gateguard|safety-guard|automation-audit|agent-payment|defi-|evm-|iterative-retrieval|regex-vs|nodejs-keccak|liquid-glass|canary-watch|benchmark|blueprint|code-tour|codebase-onboarding|deep-research|data-scraper|dashboard-builder|agent-harness|agent-introspection|agentic-engineering|ai-first|autonomous-agent|autonomous-loops|claude-api|claude-devfleet|product-capability|product-lens|api-connector-builder|security-bounty|security-scan|seo$|skill-comply|workspace-surface|^agent-eval$|documentation-lookup|dispatching-parallel|subagent-driven|using-git-worktrees|executing-plans|finishing-a-development|receiving-code-review|requesting-code-review|github-ops|laravel-plugin-discovery/i
const TAGS = {
  frontend: /frontend|\bui\b|design|landing|css|tailwind|react|visual|interface|layout|typograph|web page|website|component/i,
  backend: /backend|\bapi\b|server|express|rest|graphql|endpoint|node\.js|nodejs/i,
  database: /database|postgres|\bsql\b|migration|schema/i,
  testing: /\btest|tdd|vitest|jest|pytest|e2e/i,
  python: /python|django|flask|pytest/i,
  security: /security|auth|owasp|secret|vulnerab/i,
  a11y: /accessib|wcag|a11y/i,
  seo: /\bseo\b/i,
}
const skillRoots = () => [
  path.join(HOME, '.claude', 'skills'),
  path.join(HOME, '.claude', 'plugins', 'cache', 'impeccable', 'impeccable', '4.3.1', 'skills'),
  path.join(HOME, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'frontend-design', '94258c5913c4', 'skills'),
  path.join(HOME, '.claude', 'plugins', 'cache', 'everything-claude-code', 'everything-claude-code', '1.10.0', 'skills'),
  path.join(HOME, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '6.0.3', 'skills'),
]
async function loadCatalog() {
  const seen = new Map()
  for (const root of skillRoots()) {
    let dirs = []; try { dirs = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const d of dirs) {
      if (seen.has(d.name) || DENY.test(d.name)) continue
      if (!(await stat(path.join(root, d.name)).then((s) => s.isDirectory(), () => false))) continue   // links simbólicos (npx skills add) não passam em isDirectory()
      const file = path.join(root, d.name, 'SKILL.md')
      let body; try { body = (await readFile(file, 'utf8')).split(String.fromCharCode(13)).join('') } catch { continue }
      const fm = /^---\n([\s\S]*?)\n---/.exec(body)
      const desc = (fm && /description:\s*(.*)/.exec(fm[1])?.[1] || '').replace(/^["']|["']$/g, '').slice(0, 220)
      const text = `${d.name} ${desc}`
      const tags = Object.entries(TAGS).filter(([, re]) => re.test(text)).map(([t]) => t)
      const source = root.includes('plugins') ? (root.includes('impeccable') ? 'impeccable' : root.includes('superpowers') ? 'superpowers' : root.includes('frontend-design') ? 'anthropic' : 'ecc') : 'local'
      seen.set(d.name, { id: d.name, description: desc, tags, source, bytes: body.length, path: file, body })
    }
  }
  state.catalog = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}
// Decisão de Erick (2026-09-16): skills entram INTEIRAS, sem corte. O plano (E70) fixa 7,5k/20k tokens
// para a ADE real; a demonstração só mede e mostra o tamanho.
const ROLES = ['planner', 'maker', 'checker', 'research']
function catalogListing() {
  return state.catalog.map((c) => `- ${c.id} [${c.tags.join(',') || 'geral'}] (${Math.round(c.bytes / 4 / 1000)}k tok): ${c.description || 'sem descrição'}`).join('\n')
}
// O modelo de entendimento escolhe skills por papel; o motor valida contra o catálogo, aplica as regras
// fixas de Erick (interface/design => taste + impeccable no maker) e as fixações/exclusões do operador.
function selectSkills(intent) {
  const s = state.settings.skills
  const domains = new Set(intent.domains || [])
  const out = {}
  for (const role of ROLES) {
    const picks = []
    const add = (id, reason) => { const c = state.catalog.find((x) => x.id === id); if (c && !picks.find((p) => p.id === id) && !s.excluded.includes(id)) picks.push({ id, reason, bytes: c.bytes, source: c.source }) }
    if (role === 'maker') for (const id of s.forced) add(id, 'você fixou')
    if (s.auto) {
      for (const p of (intent.skills?.[role] || [])) add(p.id, p.reason ? `IA: ${p.reason}` : 'escolha da IA')
      if (role === 'maker' && (domains.has('frontend') || domains.has('design') || intent.needs_ui)) { add('design-taste-frontend', 'regra: interface ou design'); add('impeccable', 'regra: interface ou design') }
      if (role === 'maker' && (domains.has('backend') || domains.has('api') || intent.needs_backend)) { add('backend-patterns', 'regra: backend'); add('api-design', 'regra: API') }
      if (role === 'maker' && domains.has('python')) add('python-patterns', 'regra: Python')
      if (role === 'checker' && (domains.has('frontend') || intent.needs_ui)) add('impeccable', 'regra: revisor de interface conhece o detector')
      if (role === 'checker') add('code-review-and-quality', 'regra: critérios de revisão')
    }
    out[role] = picks.slice(0, role === 'maker' ? s.max : 3)
  }
  return out
}
const SKILLS_MARK = '\n\n=== SKILLS ATIVAS'
function skillsBlock(selected) {
  if (!selected.length) return ''
  return '\n\n=== SKILLS ATIVAS (siga-as; são o padrão de qualidade deste projeto) ===\n' + selected.map((s) => {
    const c = state.catalog.find((x) => x.id === s.id)
    const body = c.body.replace(/^---\n[\s\S]*?\n---\n/, '')
    return `\n--- skill: ${s.id} ---\n${body}`
  }).join('\n')
}

// ---------- projeto ----------
async function discover(dir) {
  const info = { dir, name: path.basename(dir), git: false, dirty: false, branch: null, root: null, nested: false, runner: 'none', test_cmd: null, has_index: false, language: null, files: 0 }
  const st = await stat(dir).catch(() => null)
  if (!st?.isDirectory()) return { ...info, error: 'A pasta não existe.' }
  const g = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
  info.git = g.code === 0 && g.out.trim() === 'true'
  if (info.git) {
    info.dirty = (await run('git', ['status', '--porcelain', '--', '.'], { cwd: dir })).out.trim().length > 0
    info.branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).out.trim() || null
    const root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir })).out.trim()
    info.root = root ? path.resolve(root) : null
    // realpath: pasta que é junction/symlink (ex.: Skin-Sniper → "Skin Sniper/original") não é subpasta de outro repo
    const real = await realpath(dir).catch(() => path.resolve(dir))
    info.nested = !!info.root && real.toLowerCase() !== info.root.toLowerCase()
  }
  info.has_index = await exists(path.join(dir, 'index.html'))
  try { info.files = (await readdir(dir)).filter((f) => f !== 'node_modules' && f !== '.git').length } catch {}
  const pkgPath = path.join(dir, 'package.json')
  if (await exists(pkgPath)) {
    info.language = 'js'
    let pkg = {}; try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')) } catch {}
    if (await exists(path.join(dir, 'node_modules', 'vitest'))) { info.runner = 'vitest'; info.test_cmd = 'node node_modules/vitest/vitest.mjs run' }
    else if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) { info.runner = 'npm'; info.test_cmd = 'npm test' }
  } else if (await exists(path.join(dir, 'pyproject.toml')) || await exists(path.join(dir, 'pytest.ini')) || await exists(path.join(dir, 'requirements.txt'))) {
    info.language = 'python'; info.runner = 'pytest'; info.test_cmd = '.venv\\Scripts\\python.exe -m pytest -q'
  } else if (await exists(path.join(dir, 'go.mod'))) {
    info.language = 'go'; info.runner = 'go'; info.test_cmd = 'go test ./...'
  } else if (await exists(path.join(dir, 'Cargo.toml'))) {
    info.language = 'rust'; info.runner = 'cargo'; info.test_cmd = 'cargo test'
  }
  return info
}
async function refreshProject() { state.project = { ...state.project, ...(await discover(state.project.dir)) } }

async function runTests(project) {
  const dir = project.dir
  if (project.runner === 'vitest') {
    const outFile = path.join(dir, '.ade-vitest.json')
    await rm(outFile, { force: true })
    const r = await run('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${outFile}`], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
    try {
      const j = JSON.parse(await readFile(outFile, 'utf8')); await rm(outFile, { force: true })
      const tests = j.testResults.flatMap((f) => {
        if (f.assertionResults.length === 0 && f.status === 'failed') return [{ name: `${path.basename(f.name)} (arquivo ainda não roda)`, status: 'failed', message: (f.message || '').split('\n')[0].slice(0, 200) }]
        return f.assertionResults.map((a) => ({ name: a.fullName, status: a.status, message: (a.failureMessages || [])[0]?.split('\n')[0] || '' }))
      })
      const failed = tests.filter((t) => t.status !== 'passed').length
      return { ok: failed === 0 && tests.length > 0, total: tests.length, failed, tests, runner: 'vitest' }
    } catch { return { ok: false, total: 0, failed: 0, tests: [], runner: 'vitest', timeout: !!r.timedOut, error: (r.err || r.out).slice(-600) } }
  }
  if (project.runner === 'pytest') {
    const py = await ensurePython(dir)
    const r = await run(py, ['-m', 'pytest', '-v', '-p', 'no:cacheprovider', '--no-header'], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
    const out = (r.out + '\n' + r.err).trim()
    const tests = []
    for (const line of out.split('\n')) {
      const v = /^(\S+::\S+) (PASSED|FAILED|ERROR)/.exec(line.trim()); if (v && v[2] === 'PASSED') tests.push({ name: v[1], status: 'passed', message: '' })
      const m1 = /^(FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(line.trim()); if (m1) tests.push({ name: m1[2], status: 'failed', message: (m1[3] || '').slice(0, 300) })
    }
    const nfail = tests.filter((t) => t.status !== 'passed').length
    const total = tests.length
    if (!tests.length && r.code !== 0) tests.push({ name: 'pytest', status: 'failed', message: out.split('\n').slice(-6).join(' ').slice(-300) })
    return { ok: r.code === 0 && total > 0, total: total || tests.length, failed: r.code === 0 ? 0 : Math.max(nfail, 1), tests, runner: 'pytest', output: out.split('\n').slice(-12).join('\n') }
  }
  if (['npm', 'go', 'cargo'].includes(project.runner)) {
    const [cmd, ...args] = project.test_cmd.split(' ')
    const r = await run(cmd, args, { cwd: dir, timeoutMs: 5 * 60 * 1000 })
    const tail = (r.out + '\n' + r.err).trim().split('\n').slice(-12).join('\n')
    return { ok: r.code === 0, total: 1, failed: r.code === 0 ? 0 : 1, tests: [{ name: project.test_cmd, status: r.code === 0 ? 'passed' : 'failed', message: r.code === 0 ? '' : tail.slice(-300) }], runner: project.runner, output: tail }
  }
  return { ok: false, total: 0, failed: 0, tests: [], runner: 'none' }
}
// Python: interpretador do projeto em .venv (uv), com requirements.txt + pytest instalados antes de cada rodada de provas.
async function ensurePython(dir) {
  const py = path.join(dir, '.venv', 'Scripts', 'python.exe')
  if (!(await exists(py))) { const v = await run('uv', ['venv', '.venv', '-q'], { cwd: dir }); if (v.code !== 0) log('engine', `uv venv falhou: ${(v.err || v.out).trim().slice(0, 200)}`, 'error') }
  const pkgs = ['pytest']
  const req = await exists(path.join(dir, 'requirements.txt'))
  // sem --python: o uv usa o .venv do cwd. Se o venv não foi criado pelo uv (python -m venv), o uv pode falhar ao inspecioná-lo: cai para o pip do próprio venv.
  const spec = [...pkgs, ...(req ? ['-r', 'requirements.txt'] : [])]
  let i = await run('uv', ['pip', 'install', '-q', ...spec], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
  if (i.code !== 0) i = await run(py, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', ...spec], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
  if (i.code !== 0) log('engine', `instalação Python falhou: ${(i.err || i.out).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`, 'error')
  return py
}
// forma longa: ':!__pycache__' falha no git ("Unimplemented pathspec magic '_'")
const DIFF_EXCLUDES = ['node_modules', '**/node_modules/**', 'package-lock.json', '.ade-vitest.json', 'dist', 'build', '__pycache__', '.venv', '.ade-attachments'].map((x) => `:(exclude)${x}`)
const IGNORE_LINES = ['node_modules/', '.ade-vitest.json', 'dist/', '__pycache__/', '.venv/', '.ade-attachments/']
async function ensureIgnore(dir) {
  const f = path.join(dir, '.gitignore')
  let cur = ''; try { cur = await readFile(f, 'utf8') } catch {}
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()))
  const missing = IGNORE_LINES.filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, '')))
  if (!missing.length) return
  await writeFile(f, (cur.trimEnd() ? cur.trimEnd() + '\n' : '') + missing.join('\n') + '\n')
  await run('git', ['add', '.gitignore'], { cwd: dir }); await run('git', ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'ade: .gitignore', '--', '.gitignore'], { cwd: dir })
}
async function gitHead(dir) { const r = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir }); return r.code === 0 ? r.out.trim() : null }
async function gitDiff(dir, base = null) {
  const a = await run('git', ['add', '-N', '--', '.'], { cwd: dir }) // ignorados pelo .gitignore ficam fora sozinhos; pathspec de exclusão aqui faz o git reclamar
  // a pasta do próprio motor nunca faz parte do diff de uma missão (dogfood: a demo vive dentro do repositório que ela desenvolve)
  const self = path.relative(dir, ROOT).split(path.sep).join('/'), own = self && !self.startsWith('..') && !path.isAbsolute(self) ? [`:(exclude)${self}`] : []
  const d = await run('git', ['diff', ...(base ? [base] : []), '--', '.', ...DIFF_EXCLUDES, ...own], { cwd: dir })
  if (a.code !== 0 || d.code !== 0) throw new Error(`git diff falhou: ${(a.err || d.err).trim().split('\n')[0]}`)
  return d.out
}
async function gitDiscard(dir) { await run('git', ['reset', '-q', '--', '.'], { cwd: dir }); await run('git', ['checkout', '--', '.'], { cwd: dir }); await run('git', ['clean', '-fd', '.'], { cwd: dir }) }
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.secrets?|id_(rsa|ed25519|ecdsa)|[^/]*\.(pem|p12|pfx|key))$/i
async function gitCommit(dir, msg) {
  await run('git', ['add', '-A', '--', '.'], { cwd: dir })
  const staged = (await run('git', ['diff', '--cached', '--name-only'], { cwd: dir })).out.split('\n').map((f) => f.trim()).filter(Boolean)
  const secrets = staged.filter((f) => SECRET_FILE.test(f))
  if (secrets.length) { await run('git', ['reset', '-q', '--', ...secrets], { cwd: dir }); log('engine', `arquivo(s) com cara de segredo ficaram FORA do commit: ${secrets.join(', ')}. Se for de propósito, commite você mesmo`, 'warn') }
  const c = await run('git', ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', msg, '--', '.'], { cwd: dir })
  return c.code === 0
}

function describeTool(c, dir) {
  const i = c.input || {}
  const f = i.file_path ? (path.relative(dir, i.file_path) || path.basename(i.file_path)) : ''
  if (c.name === 'Edit') return `Edit ${f}\n- ${(i.old_string || '').split('\n')[0].slice(0, 100)}\n+ ${(i.new_string || '').split('\n')[0].slice(0, 100)}`
  if (c.name === 'MultiEdit') return `MultiEdit ${f} (${(i.edits || []).length} edições)`
  if (c.name === 'Write') return `Write ${f} (${(i.content || '').length} caracteres)`
  if (c.name === 'Bash') return `$ ${(i.command || '').slice(0, 200)}`
  if (c.name === 'Read') return `Read ${f}`
  if (c.name === 'Glob') return `Glob ${i.pattern || ''}`
  if (c.name === 'Grep') return `Grep ${i.pattern || ''}`
  return `${c.name} ${f || i.command || ''}`.trim()
}

// ---------- chamada Claude (maker / planner) ----------
async function claudeCall({ role, prompt, model, effort, tools, skipPermissions, schema, maxTurns = 40 }) {
  const m = state.mission, dir = state.project.dir
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--no-session-persistence', '--max-turns', String(maxTurns), '--model', model]
  if (EFFORTS.includes(effort)) args.push('--effort', effort)
  // Cache de prompt (medido em 17/09): o cache é por prefixo exato e dura 5 min, renovado a cada leitura. Cada chamada nossa é uma sessão nova;
  // com as skills dentro do prompt do usuário, ~37k tokens eram REESCRITOS no cache a cada chamada (US$ 0,15). Com a parte estável (skills) no
  // system prompt por arquivo e as seções dinâmicas (cwd, git status) fora do system, a chamada seguinte LÊ 40k do cache (US$ 0,013).
  args.push('--exclude-dynamic-system-prompt-sections')
  const cut = prompt.indexOf(SKILLS_MARK)
  if (cut >= 0) {
    const stable = prompt.slice(cut).trim(); prompt = prompt.slice(0, cut) + '\nAs skills ativas deste papel estão no system prompt; siga-as.'
    const file = path.join(ADE_DIR, 'sysprompts', createHash('sha1').update(stable).digest('hex').slice(0, 16) + '.md')
    await mkdir(path.dirname(file), { recursive: true }); if (!(await exists(file))) await writeFile(file, stable)
    args.push('--append-system-prompt-file', file)
  }
  // shell:true no Windows concatena argumentos: aspas internas precisam de escape estilo MSVC.
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  if (skipPermissions) args.push('--dangerously-skip-permissions')
  else { args.push('--permission-mode', 'acceptEdits'); if (tools) args.push('--tools', ...tools) }
  log('engine', `claude (${role}, ${model}${EFFORTS.includes(effort) ? `, esforço ${effort}` : ''})${schema ? ' com saída estruturada' : ''}`)
  let result = null, liveBuf = null
  const touched = new Set()
  const t0 = Date.now()
  const r = await run('claude', args, {
    cwd: dir, stdin: prompt, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'system' && ev.subtype === 'init') log('claude', `sessão iniciada · modelo ${ev.model}`)
      if (ev.type === 'stream_event') {
        const e = ev.event
        if (e?.type === 'content_block_start') liveBuf = { kind: e.content_block?.type === 'thinking' ? 'thinking' : e.content_block?.type === 'tool_use' ? 'tool' : 'text', text: e.content_block?.name ? `${e.content_block.name} ` : '' }
        if (e?.type === 'content_block_delta' && liveBuf) { const d = e.delta || {}; liveBuf.text += d.thinking_delta ?? d.thinking ?? d.text ?? d.partial_json ?? ''; setLive({ source: 'claude', kind: liveBuf.kind, text: liveBuf.text.slice(-1200) }) }
        if (e?.type === 'content_block_stop') { liveBuf = null; setLive(null) }
      }
      if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
        if (c.type === 'thinking' && c.thinking?.trim()) log('claude', c.thinking.trim(), 'thinking')
        if (c.type === 'text' && c.text.trim()) log('claude', c.text.trim(), 'text')
        if (c.type === 'tool_use') { log('claude', describeTool(c, dir), 'tool'); if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(c.name) && c.input?.file_path) touched.add(path.relative(dir, c.input.file_path) || c.input.file_path) }
      }
      if (ev.type === 'user') for (const c of ev.message?.content || []) if (c.type === 'tool_result') {
        const body = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')
        const first = body.trim().split('\n').slice(0, 3).join('\n')
        if (first) log('claude', first.slice(0, 240), c.is_error ? 'error' : 'result')
      }
      if (ev.type === 'result') result = ev
    },
  })
  setLive(null)
  if (result) {
    result.touched = [...touched]
    const c = m.cost
    c.usd += result.total_cost_usd || 0; c.calls += 1; c.turns += result.num_turns || 0
    c.tokens_in += (result.usage?.input_tokens || 0) + (result.usage?.cache_creation_input_tokens || 0)
    c.cache_read += result.usage?.cache_read_input_tokens || 0; c.tokens_out += result.usage?.output_tokens || 0
    c.by_model[model] = (c.by_model[model] || 0) + (result.total_cost_usd || 0)
    log('engine', `claude terminou · ${result.num_turns} turnos · US$ ${(result.total_cost_usd || 0).toFixed(2)} · ${Math.round((result.duration_ms || 0) / 1000)} s`)
    journal({ type: 'model_call', family: 'claude', role, model, effort: effort || null, story: m.current, turns: result.num_turns || 0, usd: result.total_cost_usd || 0, tokens_in: result.usage?.input_tokens || 0, cache_write: result.usage?.cache_creation_input_tokens || 0, cache_read: result.usage?.cache_read_input_tokens || 0, tokens_out: result.usage?.output_tokens || 0, prompt_chars: prompt.length, wall_ms: Date.now() - t0, max_turns: maxTurns }).catch(() => {})
    readQuota().then(broadcastSoon)
    if (result.is_error) log('engine', `claude reportou erro: ${result.result || result.subtype}`, 'error')
  } else log('engine', `claude saiu com código ${r.code}: ${(r.err || r.out).slice(0, 300)}`, 'error')
  const failText = !result || result.is_error ? String(result?.result || r.err || r.out || '') : ''
  if (state.mission && /usage limit|rate limit|limit reached|out of extra usage/i.test(failText)) {
    await readQuota().catch(() => {})
    const resets = [state.quota.claude?.five_hour, state.quota.claude?.seven_day].filter((w) => w?.resets_at && w.used >= 99 && new Date(w.resets_at) > new Date()).map((w) => +new Date(w.resets_at))
    quotaPause('Claude', new Date(resets.length ? Math.max(...resets) + 60 * 1000 : Date.now() + 60 * 60 * 1000).toISOString())
  }
  return result
}

// ---------- pesquisa: agy ----------
async function research(questions) {
  const m = state.mission, dir = state.project.dir
  const model = agyModel(state.settings.roles.research.model, effortOf('research'))
  const prompt = `Responda em português, com fontes verificáveis (URL), às perguntas abaixo, no formato JSON exigido. Seja curto e factual; se não souber, diga desconhecido.\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
  const rrole = state.settings.roles.research
  if (rrole.family === 'claude') { // pesquisa num modelo Claude (papel configurado em Modelos): busca na web, mesmo formato de resposta
    const rc = await claudeCall({ role: 'pesquisa', prompt, model: rrole.model, effort: effortOf('research'), tools: ['WebSearch', 'WebFetch'], schema: JSON.parse(await readFile(RESEARCH_SCHEMA, 'utf8')), maxTurns: 12 })
    const parsed = rc?.structured_output || null
    for (const f of parsed?.findings || []) log('claude', `${f.question}: ${f.answer} ${f.sources?.length ? `(${f.sources.join(', ')})` : ''}`, 'text')
    if (!parsed) log('engine', 'pesquisa sem resposta (claude não devolveu o JSON)', 'error')
    return parsed
  }
  if (rrole.family !== 'agy') { log('engine', `pesquisa: família ${rrole.family} não suportada (use Claude ou Gemini em Modelos); sigo sem pesquisa`, 'warn'); return null }
  log('engine', `agy (pesquisa, ${model})`)
  setLive({ source: 'agy', kind: 'thinking', text: 'pesquisando…' })
  const r = await run('agy', [`--print=${prompt.replace(/"/g, "'")}`, '--output-format', 'json', '--model', model, '--json-schema', RESEARCH_SCHEMA, '--dangerously-skip-permissions'], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
  setLive(null)
  m.cost.calls += 1
  try {
    const j = JSON.parse(r.out)
    m.cost.tokens_in += j.usage?.input_tokens || 0; m.cost.tokens_out += j.usage?.output_tokens || 0
    const parsed = typeof j.response === 'string' ? JSON.parse(j.response) : j.response
    for (const f of parsed.findings || []) log('agy', `${f.question}: ${f.answer} ${f.sources?.length ? `(${f.sources.join(', ')})` : ''}`, 'text')
    return parsed
  } catch { log('engine', `agy não devolveu JSON: ${(r.out || r.err).slice(0, 300)}`, 'error'); return null }
}

// ---------- conversa (chat) ----------
async function chatTurn(e, text, { family, model, effort }) {
  const dir = e.project.dir, m = e.mission
  const turns = e.chat || (e.chat = [])
  const history = turns.slice(-8).map((t) => `${t.role === 'user' ? 'Usuário' : 'Assistente'}: ${t.text.slice(0, 1500)}`).join('\n')
  const tree = await projectTree(dir)
  const atts = e.attachments.splice(0) // anexos colados/escolhidos vão com a pergunta e saem da barra
  const prompt = [
    `Você é o assistente de conversa da TL-ADE no projeto ${e.project.name} (${dir}). Responda em português, direto e curto (até ~250 palavras, salvo pedido de detalhe); listas curtas e blocos de código quando ajudarem. Só leitura: não edite arquivos nem rode nada que altere o projeto. Se a pergunta for sobre o projeto, leia só o necessário.`,
    m ? `Missão atual desta pasta: "${m.request.slice(0, 200)}" · estado ${m.state}${m.reason ? ` (${m.reason})` : ''} · custo US$ ${m.cost.usd.toFixed(2)} · partes: ${m.stories.map((s) => `${s.id} ${s.state}`).join(', ') || 'nenhuma'}${m.program ? ` · épicos: ${m.program.epics.map((x) => `${x.id} ${x.state}`).join(', ')}` : ''}. Detalhes das partes ficam em .ade/missions/${m.id}.json na pasta do TL-ADE (${ADE_DIR}).` : 'Sem missão nesta pasta agora.',
    `Arquivos do projeto (${tree.length}): ${tree.slice(0, 150).join(', ')}`,
    history ? `Conversa até aqui:\n${history}` : '', attachBlock(atts), `Usuário: ${text}`,
  ].filter(Boolean).join('\n')
  const user = { role: 'user', text, ts: now(), attachments: atts }, ai = { role: 'ai', text: '', pending: true, family, model, effort, ts: now(), usd: 0 }
  turns.push(user, ai); e.chat_busy = true; broadcast()
  const stream = (t) => { ai.text = t; broadcastSoon() }
  let answer = '', usd = 0
  try {
    if (family === 'claude') {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--no-session-persistence', '--max-turns', '12', '--model', model, '--permission-mode', 'plan', '--exclude-dynamic-system-prompt-sections', '--tools', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']
      if (EFFORTS.includes(effort)) args.push('--effort', effort)
      let buf = ''
      const r = await run('claude', args, { cwd: dir, stdin: prompt, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, timeoutMs: 8 * 60 * 1000, onLine: (line) => {
        let ev; try { ev = JSON.parse(line) } catch { return }
        if (ev.type === 'stream_event') { const ev2 = ev.event; if (ev2?.type === 'content_block_start' && ev2.content_block?.type === 'text') buf = ''; if (ev2?.type === 'content_block_delta' && ev2.delta?.text) { buf += ev2.delta.text; stream(buf) } }
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'tool_use') stream((buf ? buf + '\n\n' : '') + `_${describeTool(c, dir)}_`)
        if (ev.type === 'result') { answer = ev.result || buf; usd = ev.total_cost_usd || 0 }
      } })
      if (!answer) answer = `(sem resposta; código ${r.code}) ${(r.err || '').slice(0, 300)}`
    } else if (family === 'codex') {
      const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c', `model_reasoning_effort=${EFFORTS.includes(effort) ? effort : 'medium'}`, '-C', dir, '-m', model, '-']
      const r = await run('codex', args, { cwd: dir, stdin: prompt, timeoutMs: 8 * 60 * 1000, onLine: (line) => {
        let ev; try { ev = JSON.parse(line) } catch { return }
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') { answer = ev.item.text; stream(answer) }
        if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') stream((answer ? answer + '\n\n' : '') + `_$ ${(ev.item.command || '').slice(0, 120)}_`)
      } })
      if (!answer) answer = `(sem resposta; código ${r.code}) ${(r.err || r.out).slice(0, 300)}`
    } else {
      const id = agyModel(model, effort)
      const r = await run('agy', [`--print=${prompt.replace(/"/g, "'").replace(/\r?\n/g, ' ')}`, '--output-format', 'json', '--model', id, '--mode', 'plan', '--dangerously-skip-permissions'], { cwd: dir, timeoutMs: 8 * 60 * 1000 })
      try { const j = JSON.parse(r.out); answer = typeof j.response === 'string' ? j.response : JSON.stringify(j.response) } catch { answer = `(sem resposta; código ${r.code}) ${(r.err || r.out).slice(0, 300)}` }
    }
  } catch (err) { answer = err === PAUSE ? '(interrompido)' : `(erro: ${err.message})` }
  ai.text = answer; ai.pending = false; ai.usd = usd; ai.done_ts = now(); e.chat_busy = false
  readQuota().then(broadcastSoon); broadcast()
  await saveChat(dir, turns).catch(() => {})
}

// ---------- batedor: Gemini (agy) lê muito e devolve pouco ----------
// Chamado pelo motor antes de planejar (pergunta focada no pedido/épico) e pelo maker sob demanda (scout.mjs, quando precisa de
// documentação, arquivo grande ou fato de fora). O recibo entra nos prompts; os outros modelos leem só o trecho apontado.
const SCOUT_SCRIPT = path.join(ROOT, 'scout.mjs')
async function scout(question, { web = false, files = [] } = {}) {
  const m = state.mission
  // batedor num modelo Claude (papel configurado em Modelos): mesmo prompt e mesmo schema do scout.mjs, só leitura.
  // Antes o motor só sabia chamar o agy e mandava `--model sonnet` para o Gemini, que recusava.
  const role = state.settings.roles.scout
  if (role.family === 'claude') {
    log('engine', `batedor (claude ${role.model}, esforço ${effortOf('scout')}): ${question.slice(0, 140)}`)
    const r = await claudeCall({ role: 'batedor', prompt: scoutPrompt(question, { web, files }), model: role.model, effort: effortOf('scout'), tools: web ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] : ['Read', 'Glob', 'Grep'], schema: SCOUT_SCHEMA, maxTurns: 14 })
    const rec = r?.structured_output
    if (!rec?.summary) { log('engine', 'batedor sem recibo (claude não devolveu o JSON do recibo)', 'error'); return null }
    log('claude', `recibo do batedor: ${rec.summary}`, 'text')
    return { summary: rec.summary, facts: rec.facts || [], files: rec.files || [], sources: rec.sources || [], model: role.model, question, at: now() }
  }
  if (role.family !== 'agy') { log('engine', `batedor: família ${role.family} não suportada (use Claude ou Gemini em Modelos); sigo sem recibo`, 'warn'); return null }
  const model = agyModel(state.settings.roles.scout.model, effortOf('scout'))
  log('engine', `batedor (agy ${model}): ${question.slice(0, 140)}`)
  setLive({ source: 'agy', kind: 'thinking', text: 'batedor lendo o projeto…' })
  const t0 = Date.now()
  const r = await run('node', [SCOUT_SCRIPT, '--json', '--model', model, ...(web ? ['--web'] : []), question.replace(/[\r\n"]+/g, ' '), ...files], { cwd: state.project.dir, timeoutMs: 7 * 60 * 1000 })
  setLive(null); if (m) m.cost.calls += 1
  let rec = null; try { rec = JSON.parse(r.out.trim().split('\n').pop()) } catch {}
  if (!rec?.summary) { log('engine', `batedor sem recibo (código ${r.code}): ${(r.err || r.out).trim().slice(0, 300)}`, 'error'); return null }
  if (m) { m.cost.tokens_in += rec.usage?.input_tokens || 0; m.cost.tokens_out += rec.usage?.output_tokens || 0 }
  journal({ type: 'model_call', family: 'agy', role: 'scout', model, story: m?.current ?? null, tokens_in: rec.usage?.input_tokens || 0, tokens_out: rec.usage?.output_tokens || 0, prompt_chars: question.length, wall_ms: Date.now() - t0, files: (rec.files || []).length }).catch(() => {})
  log('agy', `recibo do batedor: ${rec.summary}`, 'text')
  return { summary: rec.summary, facts: rec.facts || [], files: rec.files || [], sources: rec.sources || [], model, question, at: now() }
}
function scoutBlock(rec) {
  if (!rec) return ''
  return [`RECIBO DO BATEDOR (Gemini já leu o projeto para isto; confie e leia só o trecho apontado):`, rec.summary,
    rec.facts.length ? `Fatos: ${rec.facts.join(' | ')}` : '', rec.files.length ? `Arquivos: ${rec.files.map((f) => `${f.path} linhas ${f.lines} (${f.why})`).join('; ')}` : '',
    rec.sources.length ? `Fontes: ${rec.sources.join(' ')}` : ''].filter(Boolean).join('\n')
}
const scoutWorth = () => state.settings.scout_enabled !== false && (state.project?.files || 0) > 3

// ---------- mapa do código (sem IA): símbolo@linha por arquivo, para ler só o trecho ----------
const MAP_RULES = [
  [/\.(m?js|jsx|tsx?)$/i, /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/],
  [/\.py$/i, /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/],
  [/\.go$/i, /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/],
  [/\.rs$/i, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl(?:<[^>]*>)?)\s+([A-Za-z_]\w*)/],
  [/\.css$/i, /^\/\*\s*[-=]*\s*([^*]{3,60}?)\s*[-=]*\s*\*\/|^(@media[^{]{0,40})/],
  [/\.html?$/i, /<(?:section|header|main|nav|footer|template|dialog|form|aside)\b[^>]*\bid="([\w-]+)"|<(section|header|main|nav|footer|template|dialog|aside)\b/],
  [/\.md$/i, /^#{1,3}\s+(.{3,60})/],
]
async function codeMap(dir, files, { maxFiles = 60, maxChars = 7000 } = {}) {
  const out = []
  for (const f of files.slice(0, maxFiles)) {
    const rule = MAP_RULES.find(([ext]) => ext.test(f)); if (!rule) continue
    let body; try { body = await readFile(path.join(dir, f), 'utf8') } catch { continue }
    if (body.length > 400000) continue
    const lines = body.split('\n'); if (lines.length < 40) continue // pequeno: lê inteiro
    const syms = []
    lines.forEach((l, i) => { const mm = rule[1].exec(l); if (mm) { const name = mm.slice(1).find(Boolean); if (name) syms.push(`${name.trim()}@${i + 1}`) } })
    if (!syms.length) continue
    out.push(`${f} (${lines.length} linhas): ${syms.length > 40 ? syms.slice(0, 40).join(', ') + ' …' : syms.join(', ')}`)
  }
  let text = out.join('\n'); if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…'
  return text ? `MAPA DO CÓDIGO (símbolo@linha; leia só o trecho que precisa, com Read offset/limit): \n${text}` : ''
}

// ---------- crítica do plano: o revisor (outra empresa) lê o plano como quem vai implementar ----------
async function planCritic(plan) {
  const m = state.mission, dir = state.project.dir, model = state.settings.roles.checker.model
  if (state.settings.roles.checker.family !== 'codex') return null
  const prompt = [
    'Você vai criticar um PLANO, não código. Quem vai implementar cada story é um modelo rápido e barato, que segue instruções muito bem e decide mal, numa sessão nova que só vê a story, as decisions e os arquivos citados.',
    'Leia cada story como se fosse implementá-la agora. Aponte SÓ o que obrigaria esse modelo a decidir ou adivinhar: passo de recipe vago, arquivo ou símbolo citado que não existe no projeto (confira), interface sem assinatura, formato de dado sem exemplo, caso de borda sem resposta, examples que não cobrem um critério de aceite, dependência entre stories não declarada, duas stories mexendo no mesmo trecho, story que muda um formato ou contrato já coberto por provas de outra story enquanto proíbe tocar nessas provas (contrato impossível), story grande demais para ~300 linhas de diff.',
    'O achado MAIS importante: para cada critério de aceite, todo valor que a story precisa produzir, calcular, gravar ou exibir cuja ORIGEM o plano não nomeia (parâmetro, campo de qual arquivo, decisão anterior), e toda decisão que quem implementa teria de inventar. Confira também: critério que não é observável de fora ou que só repete o pedido; critério sem exemplo concreto; story que depende de um comportamento de outra parte do sistema que nenhuma decision, ADR ou arquivo do projeto registra (suposição escondida: mande declarar); e, se o projeto tem AGENTS.md ou CLAUDE.md, qualquer passo do plano que viole uma proibição ou convenção escrita ali (leia o arquivo).',
    'Só liste o que BLOQUEIA a implementação sem adivinhar; sugestão de clareza ou de estilo não entra. Todo achado traz em fix o texto concreto que falta, pronto para colar na story.',
    'Não opine sobre arquitetura nem estilo, não peça escopo novo. Se o plano está executável, verdict = "ready" e issues = []. Senão verdict = "revise" e até 10 issues: story (id), problem (uma frase), fix (o texto concreto que falta). Responda em português no JSON exigido.',
    `Pedido do usuário: ${m.request}`, m.epic ? `Épico: ${m.epic.title}. ${m.epic.goal}` : '',
    '--- PLANO ---', JSON.stringify({ decisions: plan.decisions, stories: plan.stories }, null, 1).slice(0, 40000),
  ].filter(Boolean).join('\n')
  log('engine', `codex (crítica do plano, ${model})`); setLive({ source: 'codex', kind: 'thinking', text: 'lendo o plano como quem vai implementar…' })
  let last = null, usage = null
  const r = await run('codex', ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c', `model_reasoning_effort=${effortOf('checker')}`, '-C', dir, '-m', model, '--output-schema', PLANCRITIC_SCHEMA, '-'], { cwd: dir, stdin: prompt, onLine: (line) => { let ev; try { ev = JSON.parse(line) } catch { return } if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text; if (ev.type === 'turn.completed') usage = ev.usage } })
  setLive(null); m.cost.calls += 1
  if (usage) { m.cost.tokens_in += usage.input_tokens || 0; m.cost.tokens_out += usage.output_tokens || 0 }
  let crit = null; try { crit = JSON.parse(last) } catch {}
  journal({ type: 'model_call', family: 'codex', role: 'plan_critic', model, tokens_in: usage?.input_tokens || 0, tokens_out: usage?.output_tokens || 0, prompt_chars: prompt.length, verdict: crit?.verdict || null, issues: crit?.issues?.length || 0 }).catch(() => {})
  if (!crit) { log('engine', `crítica do plano falhou (código ${r.code}); sigo com o plano como está`, 'warn'); return null }
  log('codex', `plano ${crit.verdict === 'ready' ? 'executável' : 'precisa de detalhe'}: ${crit.summary}`, 'text')
  m.plan_critic = { verdict: crit.verdict, summary: crit.summary, issues: crit.issues || [] }
  return crit
}

// ---------- revisão: Codex ----------
async function checker(diff, tests, st) {
  const m = state.mission, dir = state.project.dir
  const { model } = state.settings.roles.checker
  const prompt = [
    'Você é o revisor. Outra IA, de outro fornecedor, fez a alteração abaixo no projeto. Não escreva código; só avalie.',
    'Regras: toda mudança de comportamento vem com uma prova (teste) que falha antes e passa depois; sem mudanças fora do escopo; sem quebrar acessibilidade; sem segredos em código; interface sem cara de template (cores saturadas, gradiente roxo, três cards iguais).',
    st.early_impl && st.red_verified ? 'Nesta story quem escreveu implementou junto com a prova; o harness conferiu o vermelho de outro jeito: guardou de lado o código novo, rodou a suíte, viu as provas novas falharem e devolveu o código. Trate as provas como provas que falham sem o código.' : '',
    (st.early_impl && !st.red_verified) || st.no_red ? 'ATENÇÃO: nesta story o harness NÃO viu as provas novas falharem antes da implementação. Confira você se as provas realmente exercitam o comportamento novo (falhariam sem o código); prova que passa sem o código = achado high.' : '',
    m.plan?.decisions?.length ? `DECISÕES DO PLANO (são contrato, já aprovadas; um achado que contradiz uma decisão NÃO é achado, por melhor que seja a ideia):\n${m.plan.decisions.map((d) => `- ${d}`).join('\n')}` : '',
    st.round > 1 && st.review?.findings?.length ? [
      `ESTA É A RODADA ${st.round} DE REVISÃO. Seus achados da rodada anterior: ${st.review.findings.map((f) => `[${f.severity}] ${f.file}: ${String(f.problem).slice(0, 220)}`).join(' | ')}`,
      `Resposta de quem escreveu: ${String(st.last_summary || '(sem resposta)').slice(0, 1800)}`,
      'Regras desta rodada: (1) confira se cada achado anterior foi corrigido; (2) se quem escreveu RECUSOU um achado citando uma decisão do plano, o contrato da story ou um critério de aceite, e a citação procede, RETIRE o achado (não repita); (3) achado NOVO só vale se for high E tiver sido introduzido pelo diff desta rodada ou violar um critério de aceite; melhorias que você não pediu na primeira rodada viram no máximo low. O objetivo é convergir, não reabrir a story.',
    ].join('\n') : '',
    `Pedido do usuário: ${m.request}`, `Story em revisão: ${st.title}. Critérios de aceite: ${(st.acceptance || []).map((a, i) => `(${i + 1}) ${a}`).join(' ')}`,
    st.assumptions?.length ? `SUPOSIÇÕES que quem escreveu declarou (faltava decisão no plano). Julgue cada uma: cabe no contrato e nos critérios = aceite e não comente; fixa comportamento que um critério ou decisão cobre de outro jeito = achado citando o critério:\n${st.assumptions.map((a) => `- ${a}`).join('\n')}` : '',
    st.contract_issue ? `Quem escreveu alegou CONTRATO ERRADO: ${st.contract_issue}. Diga no summary se a alegação procede.` : '',
    st.scope_paths?.length ? `Contrato da story: só podia alterar ${st.scope_paths.join(', ')}${st.do_not_touch?.length ? `; proibido alterar ${st.do_not_touch.join(', ')}` : ''}${st.interfaces?.length ? `; interfaces: ${st.interfaces.join(' | ')}` : ''}. Alteração fora do contrato ou interface quebrada = achado high. EXCEÇÃO legítima (não é achado): atualizar asserções de provas antigas que afirmavam o formato ou comportamento que esta story manda mudar, mesmo em arquivo da lista proibida, desde que a mudança se limite a essas asserções.` : '',
    `Skills que o autor tinha de seguir: ${(m.skills.maker || []).map((s) => s.id).join(', ') || 'nenhuma'}.`,
    `O harness JÁ RODOU as provas fora da sandbox: ${tests.failed} falharam de ${tests.total} (runner: ${tests.runner}); a prova nova falhou antes da implementação e passou depois. Não tente rodar provas nem instalar nada (sua sandbox é somente leitura e isso vai falhar); avalie o código e o diff. Arquivos de lock (package-lock.json) e dependências não fazem parte do escopo revisado.`,
    tests.tests?.length ? `Provas que rodaram e passaram (nomes): ${tests.tests.filter((t) => t.status === 'passed').map((t) => t.name).slice(0, 60).join(' | ')}. Um critério coberto por uma dessas provas está provado; não peça prova extra para ele.` : '',
    'Critérios de aceite sobre detalhe decorativo (borda lateral colorida, gradiente, cor exata) cedem ao portão visual (Impeccable): não peça mudanças para reintroduzir isso; avalie a intenção do critério.',
    'Severidade: high = comportamento errado, critério de aceite não atendido, segurança, acessibilidade quebrada, mudança fora do escopo. Cobertura de prova além do necessário, estilo de código, nomes e refatorações são low e NÃO impedem approve: registre como achado low e aprove.',
    'Inspecione nesta ordem: corretude (caminhos que não são o feliz: nulo, borda, erro, assíncrono, estado), segurança, tratamento de erro (catch vazio, erro engolido, recurso que vaza), contrato e interfaces, aderência às decisões, adequação das provas (prova que só confere o dublê e não o comportamento = achado). Separe "está errado" de "eu faria diferente": preferência é low. Não promova detalhe a high nem esconda defeito real como low; se não tem certeza da gravidade, diga o risco em vez de chutar. Todo achado high cita o critério de aceite pelo número, a decisão do plano ou o item do contrato que ele viola; sem citação possível, não é high. Um achado por problema: não repita o mesmo problema arquivo por arquivo. A correção sugerida vai em palavras, nunca em código.',
    'Responda em português no formato JSON exigido. verdict = "approve" só se não houver achado high.',
    (() => {
      if (!st.scope_paths?.length) return ''
      const rx = (g) => new RegExp('^' + String(g).replace(/\\/g, '/').replace(/^\.\//, '').replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '(/.*)?$')
      const files = [...new Set([...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((x) => x[1]))]
      const allow = st.scope_paths.map(rx), deny = (st.do_not_touch || []).map(rx)
      const forbidden = files.filter((f) => deny.some((r) => r.test(f))), outside = files.filter((f) => !allow.some((r) => r.test(f)) && !forbidden.includes(f))
      return forbidden.length || outside.length ? `CONFERÊNCIA MECÂNICA DO CONTRATO (feita pelo motor):${forbidden.length ? ` alterou arquivo PROIBIDO: ${forbidden.join(', ')}.` : ''}${outside.length ? ` alterou arquivo FORA de scope_paths: ${outside.join(', ')}.` : ''} Abra cada um: só é legítimo se cair na EXCEÇÃO acima (asserções de prova antiga que a story invalida) ou for o mínimo indispensável dito por quem escreveu; caso contrário é achado high.` : ''
    })(),
    diff.length > 60000 ? `ATENÇÃO: o diff tem ${diff.length} caracteres e abaixo vão só os primeiros 60000. Arquivos alterados: ${[...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((x) => x[1]).join(', ')}. Abra com as suas ferramentas os que não aparecerem inteiros antes de aprovar.` : '',
    (() => { const names = new Set((st.tests_after?.tests || []).map((t) => t.name)); const gone = (st.red_tests || []).map((t) => t.name).filter((n) => n && !/[\\/]|\.test\./.test(n) && !names.has(n)); return gone.length ? `PROVAS QUE NASCERAM VERMELHAS E NÃO EXISTEM MAIS: ${gone.slice(0, 8).join(' | ')}. Confira se foram só renomeadas; prova apagada ou asserção enfraquecida para passar é achado high.` : '' })(),
    (() => { const debt = [...diff.matchAll(/^\+(?!\+\+).*\b(TODO|FIXME|XXX|HACK)\b.*$/gm)].map((x) => x[0].slice(1, 160).trim()).filter((l) => !/#\d+|issue/i.test(l)); return debt.length ? `MARCADORES DE DÍVIDA ACRESCENTADOS POR ESTE DIFF (sem referência a item de trabalho): ${debt.slice(0, 8).join(' | ')}. Trabalho declarado como pendente dentro do escopo da story é achado high; fora do escopo, low.` : '' })(),
    '--- DIFF ---', diff.slice(0, 60000),
  ].join('\n') + skillsBlock(m.skills.checker || [])
  // Receita de chamada curta (architecture.md E16): sem config, regras e skills do usuário; sessão efêmera.
  // skills.max_context_tokens=0 é rejeitado ("expected a nonzero usize"); 1 remove todas as skills do usuário. Sem --ephemeral: a sessão gravada em ~/.codex/sessions é de onde a cota é lida.
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c', `model_reasoning_effort=${effortOf('checker')}`, '-C', dir, '-m', model, '--output-schema', REVIEW_SCHEMA, '-']
  log('engine', `codex (revisão, ${model}, esforço ${effortOf('checker')})`)
  let lastMessage = null, usage = null
  const r = await run('codex', args, {
    cwd: dir, stdin: prompt,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') lastMessage = ev.item.text
      if (ev.type === 'item.started' && ev.item?.type === 'command_execution') setLive({ source: 'codex', kind: 'tool', text: ev.item.command || '' })
      if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') { setLive(null); log('codex', `$ ${ev.item.command}`.slice(0, 200), 'tool') }
      if (ev.type === 'item.completed' && ev.item?.type === 'reasoning' && ev.item.text) log('codex', ev.item.text.slice(0, 600), 'thinking')
      if (ev.type === 'item.started' && ev.item?.type === 'reasoning') setLive({ source: 'codex', kind: 'thinking', text: 'raciocinando…' })
      if (ev.type === 'turn.completed') usage = ev.usage
    },
  })
  setLive(null)
  let review = null
  try { review = lastMessage ? JSON.parse(lastMessage) : null } catch {}
  if (!review) {
    const msg = (lastMessage || r.err || r.out || '').trim()
    log('engine', `codex falhou (código ${r.code}): ${msg.slice(0, 300)}`, 'error')
    if (/usage limit|quota|rate limit/i.test(msg)) {
      await readQuota().catch(() => {})
      const resets = [state.quota.codex?.five_hour, state.quota.codex?.seven_day].filter((w) => w && w.used >= 99 && new Date(w.resets_at) > new Date()).map((w) => +new Date(w.resets_at))
      quotaPause('Codex', new Date(resets.length ? Math.max(...resets) + 60 * 1000 : Date.now() + 60 * 60 * 1000).toISOString())
    }
  }
  m.cost.calls += 1
  journal({ type: 'model_call', family: 'codex', role: 'checker', model, story: m.current, tokens_in: usage?.input_tokens || 0, cache_read: usage?.cached_input_tokens || 0, tokens_out: usage?.output_tokens || 0, prompt_chars: prompt.length, verdict: review?.verdict || null }).catch(() => {})
  readQuota().then(broadcastSoon)
  if (usage) { m.cost.tokens_in += usage.input_tokens || 0; m.cost.tokens_out += usage.output_tokens || 0 }
  if (review) log('codex', `${review.verdict === 'approve' ? 'aprovou' : 'pediu mudanças'}: ${review.summary}`, 'text')
  return review
}

// ---------- assets: imagens geradas pelo Codex ($imagegen, verificado em codex exec headless: research/addendum-frontend-engine-anchor.md §5) ----------
async function makeAssets() {
  const m = state.mission, dir = state.project.dir
  const wanted = (m.plan.assets || []).filter((a) => /^assets\/img\/[\w.-]+\.(png|jpg|jpeg|webp)$/i.test(a.file))
  if (m.assets_done || !state.settings.assets_enabled || !wanted.length) return
  const { model } = state.settings.roles.checker
  setStep('assets', 'running'); m.assets_done = []
  for (const a of wanted) {
    const full = path.join(dir, a.file)
    if (await exists(full)) { m.assets_done.push(a); continue }
    await mkdir(path.dirname(full), { recursive: true })
    log('engine', `codex gera imagem: ${a.file}`)
    const style = (m.plan.assets_style || '').trim()
    const prompt = [
      `Use $imagegen to generate ONE image and save it at exactly "${a.file}" (path relative to the working directory; the folder already exists).`,
      `Scene: ${a.prompt}`,
      style ? `Art direction shared by every image of this website (follow it exactly): ${style}.` : '',
      'It must look like a real photograph taken for this website, not AI art: natural light with real shadows, physically plausible objects, natural imperfections, shallow depth of field where a photographer would use it, subtle film grain, muted realistic colors, matte surfaces. Forbidden: text, letters, logos, watermarks, HDR glow, oversaturation, plastic-smooth skin or surfaces, perfect symmetry, floating objects, close-up faces, stock-photo grey backdrop, 3D render or illustration style unless the scene asks for an illustration.',
      'Do not create or modify any other file. When the file is saved, reply with just the path.',
    ].filter(Boolean).join(' ')
    // configuração completa do Codex (a skill imagegen precisa estar visível); sandbox só na pasta do projeto
    const r = await run('codex', ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', dir, '-m', model, prompt], {
      cwd: dir, stdin: '', timeoutMs: 10 * 60 * 1000,
      onLine: (line) => { let ev; try { ev = JSON.parse(line) } catch { return } if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') log('codex', ev.item.text.slice(0, 200), 'text'); if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') log('codex', `$ ${ev.item.command}`.slice(0, 160), 'tool') },
    })
    m.cost.calls += 1
    if (await exists(full)) { m.assets_done.push(a); log('engine', `imagem pronta: ${a.file}`) }
    else log('engine', `imagem não gerada: ${a.file} (código ${r.code}) ${(r.err || '').trim().slice(0, 200)}`, 'error')
    broadcast()
  }
  readQuota().then(broadcastSoon)
  if (m.assets_done.length) { await gitCommit(dir, `ade: ${m.assets_done.length} imagem(ns) gerada(s) pelo Codex`); await refreshProject(); log('engine', `commit feito: ${m.assets_done.length} imagem(ns)`) }
  setStep('assets', m.assets_done.length === wanted.length ? 'done' : 'warn')
}

// ---------- portão visual: Impeccable detect ----------
async function visualGate() {
  const dir = state.project.dir
  if (!(await exists(IMPECCABLE))) return { available: false, findings: [] }
  const r = await run(`"${IMPECCABLE}"`, ['detect', '.', '--json', '--no-advisory'], { cwd: dir, timeoutMs: 3 * 60 * 1000 })
  let findings = []
  try { findings = JSON.parse(r.out || '[]') } catch { return { available: true, findings: [], error: (r.err || r.out).slice(0, 300) } }
  const flat = findings.flatMap((f) => f.findings ? f.findings.map((x) => ({ file: f.file || f.path, ...x })) : [f])
  const seen = new Set(), out = []
  for (const f of flat) {
    const file = path.relative(dir, f.file || f.path || '') || '', rule = f.antipattern || f.rule || f.id || '', snippet = (f.snippet || '').trim()
    const key = `${file}|${rule}|${snippet}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, file, line: f.line || null, rule, severity: f.severity || '', message: `${f.name || f.message || f.description || rule}${snippet ? ' — ' + snippet : ''}${f.name && f.description ? ' (' + f.description + ')' : ''}`.slice(0, 400) })
  }
  return { available: true, findings: out.slice(0, 40) }
}
// só o que esta story introduziu: o que já existia antes dela não é culpa dela
function newFindings(after, before) { const old = new Set((before?.findings || []).map((f) => f.key)); return { ...after, findings: after.findings.filter((f) => !old.has(f.key)), pre_existing: (after.findings || []).length - after.findings.filter((f) => !old.has(f.key)).length } }

// ---------- entendimento do pedido (escolhe skills por papel) ----------
const INTENT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' }, complexity: { type: 'string', enum: ['trivial', 'bounded', 'feature', 'subsystem', 'project'] },
    difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] }, difficulty_why: { type: 'string' },
    domains: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
    needs_ui: { type: 'boolean' }, needs_backend: { type: 'boolean' },
    research_questions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, question: { type: 'string' }, why: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, hint: { type: 'string' } }, required: ['label', 'hint'] } }, allow_other: { type: 'boolean' } }, required: ['id', 'question', 'why', 'options', 'allow_other'] } },
    skills: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['planner', 'maker', 'checker', 'research'].map((r) => [r, { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } }])), required: ['planner', 'maker', 'checker', 'research'] },
  },
  required: ['summary', 'complexity', 'difficulty', 'difficulty_why', 'domains', 'keywords', 'needs_ui', 'needs_backend', 'research_questions', 'questions', 'skills'],
}
function intentPrompt() {
  const p = state.project, s = state.settings
  return [
    'Você é a primeira IA da TL-ADE: entende o pedido do usuário e decide o que cada papel precisa. Responda em português no formato JSON exigido. Não explore o projeto além de 2 leituras; o planejador explora depois.',
    `Pedido: ${state.mission.request}`,
    attachBlock(state.mission.attachments),
    '- difficulty: easy (mudança localizada, padrão conhecido, pouca decisão), normal (funcionalidade com algumas decisões de desenho), hard (arquitetura, concorrência, algoritmo delicado, muitas partes interligadas, regras de negócio densas). difficulty_why: uma frase. Isso define quem planeja: leve → modelo rápido; pesado → o mais forte.',
    `Projeto: ${p.name}; ${p.files} itens na raiz; linguagem: ${p.language || 'nenhuma'}; runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}; index.html: ${p.has_index ? 'sim' : 'não'}.`,
    `Papéis e modelos: planejador ${s.roles.planner.model} (monta stories); maker ${s.roles.maker.model} (escreve provas e código); revisor ${s.roles.checker.model} (Codex, lê o diff, não escreve); pesquisador ${s.roles.research.model} (Google, só fatos externos).`,
    'Se há anexos, abra-os antes de decidir (uma imagem de referência muda domínios, skills e perguntas).',
    'Escolha, para cada papel, as skills do catálogo abaixo que elevam a qualidade daquele papel neste pedido (ids exatos; até 4 para o maker, até 3 para os outros; lista vazia é válida). Regras fixas: se há interface ou design, o maker recebe design-taste-frontend e impeccable (pode acrescentar frontend-design e accessibility); backend/API recebe backend-patterns e api-design; banco recebe postgres-patterns; o revisor recebe skills de revisão/segurança, não de estilo; o pesquisador raramente precisa de skill.',
    '- summary: 2 frases do que será entregue e das escolhas feitas por você quando o pedido é vago.',
    '- complexity: trivial (1 arquivo, correção) | bounded (1 a 3 partes pequenas) | feature (4 a 6 partes de UM subsistema) | subsystem (precisaria de mais de 6 partes, ou toca mais de um subsistema: vira uma fila de épicos) | project (vários subsistemas ou fases, ex.: "faça o motor inteiro", "crie o app completo"). Na dúvida entre feature e subsystem, escolha subsystem: partes grandes demais falham na revisão.',
    '- domains (subconjunto de frontend, design, backend, api, database, testing, python, security, a11y, docs, devops), keywords (5 a 12, pt e en), needs_ui, needs_backend.',
    '- research_questions: só fatos externos que mudariam a implementação; normalmente vazio.',
    interviewRule(),
    'CATÁLOGO DE SKILLS:', catalogListing(),
  ].join('\n')
}

// Entrevista (prompt reverso): perguntas fáceis, múltipla escolha, recomendação primeiro. Spec: trivial 0, bounded ≤2, feature+ ≤5.
function interviewRule() {
  const mode = state.settings.interview || 'auto'
  if (mode === 'never') return '- questions: sempre lista vazia.'
  return [
    `- questions: entrevista curta para o usuário (leigo) escolher o jeito do programa antes do plano. ${mode === 'always' ? 'Faça de 2 a 5 perguntas sempre que complexity não for trivial.' : 'trivial: nenhuma. bounded: até 2, só se a resposta mudaria o resultado. feature/subsystem: de 2 a 5.'}`,
    '  Cada pergunta: id curto (q1…), question (uma frase simples), why (por que importa, uma frase), options (2 a 4; a PRIMEIRA é sempre a recomendada; label curto + hint de uma frase, sem termos técnicos), allow_other (se vale escrever outra resposta).',
    '  Temas bons: estilo visual e clima, para quem é, o que é prioridade, dados (guardar onde, precisa de login?), plataforma (web, celular, desktop), integrações. Nunca pergunte o que a pasta já responde nem o que você pode decidir bem sozinho.',
  ].join('\n')
}

// ---------- plano (Intent Compiler) ----------
function planPrompt(revising = false) {
  const p = state.project, m = state.mission
  return [
    'Você é o Intent Compiler da TL-ADE. Transforme o pedido do usuário em um plano executável por outra IA, em português, no formato JSON exigido.',
    `Pedido: ${state.mission.request}`,
    m.epic ? `ÉPICO ATUAL (planeje SÓ isto; o pedido acima é contexto): ${m.epic.title}. Objetivo: ${m.epic.goal}. Critérios do épico: ${(m.epic.acceptance || []).join('; ')}.` : '',
    m.epic?.already?.length ? `ESTE ÉPICO JÁ FOI TENTADO. Já está pronto e commitado (NÃO refaça): ${m.epic.already.join('; ')}. Ficou faltando (planeje SÓ isto, em partes menores e independentes entre si quando possível; se uma parte é de configuração ou documentação, a prova confere o efeito observável: arquivo, script, código de saída): ${(m.epic.missing || []).join('; ')}.` : '',
    m.epic && m.program?.epics?.some((e) => e.state === 'done') ? `Épicos já concluídos e commitados (não refaça; construa em cima): ${m.program.epics.filter((e) => e.state === 'done').map((e) => `${e.title}: ${(e.summary || '').slice(0, 200)}`).join(' | ')}` : '',
    attachBlock(m.attachments),
    `Entendimento prévio (outra IA): ${state.mission.intent?.summary || ''} Domínios: ${(state.mission.intent?.domains || []).join(', ')}.`,
    scoutBlock(m.scout), m.map || '',
    m.answers?.length ? `ESCOLHAS DO USUÁRIO NA ENTREVISTA (obrigatórias): ${m.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}` : '',
    `Projeto: ${p.name} em ${p.dir}; ${p.files} itens na raiz; linguagem detectada: ${p.language || 'nenhuma'}; runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}; index.html na raiz: ${p.has_index ? 'sim' : 'não'}.`,
    'Explore o projeto só o necessário (Glob/Read/Grep). Depois produza:',
    '- title (≤8 palavras), summary (2 frases, o que será entregue), complexity (trivial|bounded|feature|subsystem).',
    '- explanation: 4 a 8 linhas curtas para um usuário leigo, sem termos técnicos (nada de JSON, vitest, ES modules, tokens): o que ele vai ter no fim, o que cada parte entrega em uma frase, e o que foi assumido por conta própria.',
    state.settings.assets_enabled ? [
      '- assets: imagens que o Codex vai gerar ANTES das stories, só quando needs_ui e imagens reais melhorariam muito o resultado (hero, produtos, ilustrações). 0 a 6 itens: file (sempre assets/img/<nome>.png), prompt (em inglês), purpose (onde a imagem entra, em português). As stories que usam a imagem citam o caminho e exigem alt descritivo.',
      '- assets_style: UMA direção de arte em inglês, compartilhada por todas as imagens, coerente com o visual da página (paleta em palavras, luz, hora do dia, lente/câmera, textura, clima). Ex.: "editorial food photography, 50mm, soft window light late afternoon, muted warm palette (walnut, cream, sage), matte surfaces, subtle film grain".',
      '- Cada prompt de asset descreve uma cena real e específica (assunto, o que está em volta, enquadramento, profundidade de campo, imperfeições naturais: migalhas, vapor, marcas de uso) como um fotógrafo faria. Proibido: texto, logotipos, rostos em close, brilho HDR, saturação alta, simetria perfeita, fundo neutro de banco de imagens, "3D render", "digital art", objetos flutuando.',
    ].join('\n') : '- assets: lista vazia. assets_style: string vazia.',
    '- Critérios de aceite descrevem comportamento observável pelo usuário ou pela prova, nunca implementação: não fixe nomes de variáveis CSS, valores exatos, estrutura interna de arquivos ou "usar só X". Isso gera reprovações inúteis na revisão.',
    '- Nunca prescreva nos critérios: borda lateral colorida em cards, gradiente roxo/azul, três cards iguais, fundo creme/bege por reflexo, sombras pretas puras. O portão visual (Impeccable) bloqueia isso e a story trava.',
    '- domains: subconjunto de [frontend, design, backend, api, database, testing, python, security, a11y, docs].',
    '- keywords: 5 a 12 palavras técnicas do pedido (em inglês e português) para escolher skills.',
    '- needs_ui, needs_backend: booleanos.',
    '- research_questions: só fatos externos que mudariam a implementação (versão de API, regra de negócio pública); normalmente vazio.',
    '- questions: só se o pedido for ambíguo a ponto de gerar trabalho errado; no máximo 2; normalmente vazio (prefira uma escolha razoável e registre em summary).',
    'REGRA DE OURO: quem implementa é um modelo rápido e barato que segue instruções muito bem e decide mal. TODA decisão é sua, agora. Se ao ler uma story alguém precisaria escolher biblioteca, nome, formato de dado, local do arquivo, mensagem de erro ou comportamento de borda, o plano está incompleto.',
    '- ORIGEM DOS VALORES: todo valor que uma story produz, calcula, grava ou exibe tem origem nomeada na recipe, nos examples ou nas decisions (parâmetro tal, campo tal de tal arquivo, decisão tal). Valor sem origem nomeada é decisão que sobrou para quem implementa: plano incompleto.',
    '- CRITÉRIOS de aceite: cada um é um resultado observável de fora, com valores concretos (teste: alguém que nunca viu o código consegue dizer se passou?); critério com "e também" são dois critérios; critério que só repete o pedido com outras palavras não prova nada. Toda story com 2 ou mais critérios tem pelo menos um de caminho feliz e um de borda ou de falha.',
    '- RASTREIO (o motor confere): os critérios de cada story são numerados pela ordem, CA1, CA2... Termine cada passo da recipe com os critérios que ele atende entre colchetes: "[CA1]", "[CA1,CA3]"; passo de preparo que não atende critério nenhum termina com "[prep]". Comece cada example com o critério que ele comprova: "[CA2] total([]) → 0". Todo critério aparece em pelo menos um passo e em pelo menos um example.',
    '- decisions: escreva cada uma como "X, porque Y" e, quando havia alternativa real, acrescente "; descartado: Z". Decisão sem motivo não orienta ninguém quando aparece um caso que ela não previu.',
    m.program?.decisions_log?.length ? `- DECISÕES DOS ÉPICOS ANTERIORES (já valem no código commitado; siga-as e NÃO as repita nas decisions; se este épico precisa contrariar uma, diga qual e por quê numa decision nova):\n${m.program.decisions_log.map((e) => `  [${e.epic}] ${e.decisions.join(' | ')}`).join('\n').slice(0, 6000)}` : '',
    '- decisions: 3 a 12 decisões que valem para TODAS as stories, uma frase cada, concretas: bibliotecas e versões (ou "nenhuma dependência"), estrutura de pastas, convenção de nomes, formato dos dados (com um exemplo literal), tratamento de erro, idioma dos textos, estilo visual quando houver interface. Siga o que o projeto já usa (veja o recibo do batedor e o mapa).',
    '- recipe de cada story: 3 a 8 passos numeráveis, em ordem, cada um com arquivo e ação concreta: "criar src/x.js exportando f(a, b) → tipo", "em src/y.js, dentro de render@120, chamar f antes de montar a lista", "registrar a rota em src/app.js". Cite símbolo@linha do mapa quando o arquivo existe. Nada de "implementar a lógica" ou "ajustar conforme necessário".',
    '- A recipe NUNCA manda commitar, dar push, criar branch nem rodar a suíte inteira, o typecheck ou o lint do projeto: o motor roda tudo isso e faz o commit depois das provas e da revisão. O último passo de uma recipe é código ou prova, nunca git nem "rodar os comandos de prova". Se o AGENTS.md do projeto manda commitar em certo formato, isso é com o motor, não com a story.',
    '- examples de cada story: 2 a 5 casos literais de entrada → saída que viram provas, incluindo pelo menos um caso de borda (vazio, inválido, limite). Ex.: "total([{preco: 2, qtd: 3}]) → 6", "total([]) → 0", "POST /itens sem nome → 400 {erro: \'nome obrigatório\'}".',
    '- test_file de cada story: caminho exato do arquivo de prova a criar ou estender, no padrão que o projeto já usa.',
    '- A primeira story de um projeto ou épico novo cria o esqueleto: pastas, arquivos com as interfaces exportadas (corpo mínimo), runner de provas. As seguintes só preenchem; assim cada uma cita arquivos que já existem.',
    '- Story que MUDA formato de retorno, contrato público ou comportamento já provado: as provas antigas que afirmam o formato anterior entram em scope_paths (nunca em do_not_touch) e a recipe diz quais asserções atualizar. do_not_touch com prova que a própria story invalida é plano impossível.',
    '- CONTRATO de cada story (quem implementa é um modelo mais barato; o contrato é o que evita erro): scope_paths (arquivos que ela pode criar ou alterar; caminhos reais do projeto ou nomes novos), do_not_touch (arquivos que NÃO pode alterar), out_of_scope (o que fica de fora, em 1 linha cada), interfaces (assinaturas que ela expõe ou consome, ex.: "appendEvent(event) → Promise<seq>", "GET /api/items → [{id,name}]"). acceptance no formato "Dado …, quando …, então …", cada um provável por UMA prova automatizada sem chamada real de rede, CLI ou serviço (dublês). test_hint diz o arquivo de prova e como simular dependências.',
    '- stories: 1 a 6 stories PEQUENAS, em ordem de execução. TAMANHO É REGRA: cada story = um comportamento observável, request com no máximo 120 palavras, acceptance com 2 a 4 critérios, diff esperado de até ~300 linhas, provável de passar numa revisão rigorosa em 1 ou 2 rodadas. Nunca junte dois comportamentos com "e também". Se o trabalho não cabe em 6 stories desse tamanho, faça só a primeira fatia coerente e diga em summary o que ficou para o próximo épico. Cada uma: id (s1, s2…), title, request (instrução completa e autossuficiente para a IA que vai implementar, incluindo o estilo visual quando houver interface), acceptance, test_hint (como provar), depends_on (ids das stories anteriores de que esta depende; [] se independente).',
    p.runner === 'none' ? '- Não há runner de provas: a primeira story deve incluir criar o mínimo para rodar provas (JS: package.json + vitest; Python: pytest).' : '',
    '- Se o pedido é visual e não há index.html, uma story deve entregar index.html na raiz funcionando como arquivos estáticos (ES modules, sem build), para abrir no navegador.',
    'Pedidos simples viram 1 ou 2 stories. Não invente escopo além do pedido. questions: normalmente vazio (a entrevista já aconteceu).',
    revising ? `MODO EDIÇÃO: o plano abaixo já está quase pronto. NÃO explore o projeto de novo (no máximo 2 leituras para conferir um caminho ou símbolo). Devolva o MESMO JSON, alterando só o que o último pedido de mudança exige; copie o resto sem reescrever. A correção sugerida em cada pedido é uma ilustração, não uma ordem: se aplicá-la contradiz o pedido do usuário, uma escolha da entrevista ou uma decision, NÃO aplique; resolva o problema apontado de outro jeito e diga no summary qual pedido recusou e por quê. Nunca resolva um pedido entregando menos do que o épico pede.\nPLANO ATUAL:\n${JSON.stringify({ ...m.plan, epics: undefined, explanation: m.plan.epic_explanation || m.plan.explanation })}` : '',
    m.plan_feedback?.length && !revising ? `PLANO ANTERIOR (para revisar, não para repetir):\n${JSON.stringify({ title: m.plan.title, summary: m.plan.summary, stories: m.stories.map((s) => ({ id: s.id, title: s.title, request: s.request })) })}` : '',
    m.plan_feedback?.length ? `O usuário pediu estas mudanças no plano, em ordem: ${m.plan_feedback.map((f, i) => `(${i + 1}) ${f}`).join(' ')} Aplique-as e mantenha o resto.` : '',
  ].filter(Boolean).join('\n') + skillsBlock(state.mission.skills.planner || [])
}
const PLAN_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, summary: { type: 'string' }, explanation: { type: 'string' }, complexity: { type: 'string', enum: ['trivial', 'bounded', 'feature', 'subsystem', 'project'] },
    domains: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
    needs_ui: { type: 'boolean' }, needs_backend: { type: 'boolean' },
    research_questions: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    assets_style: { type: 'string' },
    assets: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, prompt: { type: 'string' }, purpose: { type: 'string' } }, required: ['file', 'prompt', 'purpose'] } },
    stories: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string' }, request: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, test_hint: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, scope_paths: { type: 'array', items: { type: 'string' } }, do_not_touch: { type: 'array', items: { type: 'string' } }, out_of_scope: { type: 'array', items: { type: 'string' } }, interfaces: { type: 'array', items: { type: 'string' } }, recipe: { type: 'array', items: { type: 'string' } }, examples: { type: 'array', items: { type: 'string' } }, test_file: { type: 'string' } }, required: ['id', 'title', 'request', 'acceptance', 'test_hint', 'depends_on', 'scope_paths', 'do_not_touch', 'out_of_scope', 'interfaces', 'recipe', 'examples', 'test_file'] } },
  },
  required: ['title', 'summary', 'explanation', 'complexity', 'domains', 'keywords', 'needs_ui', 'needs_backend', 'research_questions', 'questions', 'decisions', 'assets_style', 'assets', 'stories'],
}

// ---------- pacote de contexto (sessão nova do Claude sem releitura) ----------
// Cada fase abre um processo novo (decisão de Erick: sessões novas, não uma só). Para o maker não gastar turnos relendo,
// o prompt já traz a árvore do projeto e o conteúdo atual dos arquivos que a story tocou (ou que a story cita).
const PACK_FILE_MAX = 12000, PACK_TOTAL_MAX = 48000, PACK_FILES_MAX = 10
const TEXT_EXT = /\.(html?|css|m?js|jsx|tsx?|json|md|py|toml|txt|yml|yaml|go|rs|sql|env\.example|cfg|ini)$/i
async function projectTree(dir) {
  const a = await run('git', ['ls-files', '--', '.'], { cwd: dir }), b = await run('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], { cwd: dir })
  const all = [...new Set((a.out + '\n' + b.out).split('\n').map((x) => x.trim()).filter((x) => x && !/(^|\/)(node_modules|\.venv|dist|build|__pycache__|\.ade-attachments)(\/|$)/.test(x)))]
  return all.length > 200 ? [...all.slice(0, 200), `… e mais ${all.length - 200}`] : all
}
function citedFiles(st, tree) { const text = `${st.request} ${(st.acceptance || []).join(' ')} ${st.test_hint || ''}`; return tree.filter((f) => f.length > 3 && text.includes(f)) }
async function contextPack(st, extra = []) {
  const dir = state.project.dir
  const tree = await projectTree(dir)
  const want = [...new Set([...(st.files || []).slice().reverse(), ...extra, ...citedFiles(st, tree)])].filter((f) => TEXT_EXT.test(f)).slice(0, PACK_FILES_MAX)
  const parts = [`ARQUIVOS DO PROJETO (${tree.length}): ${tree.join(', ')}`]
  let total = 0
  for (const f of want) {
    let body; try { body = await readFile(path.join(dir, f), 'utf8') } catch { continue }
    if (body.length > PACK_FILE_MAX) body = body.slice(0, PACK_FILE_MAX) + `\n… (cortado; ${body.length} caracteres no total; use Read com offset se precisar do resto)`
    if (total + body.length > PACK_TOTAL_MAX) break
    total += body.length
    parts.push(`=== ${f} (estado atual) ===\n${body}`)
  }
  if (want.length) parts.push('Os arquivos acima já estão no estado atual: NÃO os releia; edite direto com Edit. Leia só o que não está aqui.')
  const map = await codeMap(dir, tree.filter((f) => TEXT_EXT.test(f) && !want.includes(f)), { maxFiles: 40, maxChars: 5000 }); if (map) parts.push(map)
  if (st.last_summary) parts.push(`Resumo da sessão anterior desta parte: ${st.last_summary.slice(0, 1200)}`)
  return parts.join('\n')
}

// ---------- épicos (subsystem / project): fila de missões pequenas, uma por subsistema ----------
const EPICS_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, explanation: { type: 'string' },
    epics: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, depends_on: { type: 'array', items: { type: 'string' } } }, required: ['id', 'title', 'goal', 'acceptance', 'depends_on'] } },
  },
  required: ['title', 'explanation', 'epics'],
}
function epicsPrompt() {
  const p = state.project, m = state.mission
  return [
    'Você é o Intent Compiler da TL-ADE. O pedido é grande (vários subsistemas). NÃO escreva stories: divida em ÉPICOS, cada um um subsistema ou fatia coerente que cabe em 2 a 6 partes pequenas (cada parte ~300 linhas de diff, uma prova). Ordem de execução com dependências explícitas; a base vem antes do que depende dela.',
    `Pedido: ${m.request}`,
    attachBlock(m.attachments),
    `Entendimento prévio: ${m.intent?.summary || ''} Domínios: ${(m.intent?.domains || []).join(', ')}.`,
    scoutBlock(m.scout), m.map || '',
    m.answers?.length ? `Escolhas do usuário: ${m.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}` : '',
    `Projeto: ${p.name} em ${p.dir}; ${p.files} itens na raiz; linguagem: ${p.language || 'nenhuma'}; runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}. Explore só o necessário (Glob/Read/Grep). Se o projeto tem docs/ ou ADRs, cite os arquivos relevantes no goal de cada épico.`,
    'Responda em português no JSON exigido: title (≤8 palavras); explanation (4 a 8 linhas leigas: o que existirá no fim e o que cada épico entrega); epics (2 a 10): id (e1, e2…), title (≤8 palavras), goal (instrução completa para planejar esse épico sozinho depois: o que construir, onde, quais arquivos/ADRs ler, o que NÃO fazer), acceptance (2 a 4 critérios observáveis do épico), depends_on (ids anteriores).',
  ].filter(Boolean).join('\n') + skillsBlock(m.skills.planner || [])
}
// tamanho de story: regra sem IA. Story grande demais volta ao planejador para dividir (uma vez).
const WORDS = (t) => String(t || '').trim().split(/\s+/).length
const VAGUE = /\b(conforme necess[áa]rio|se necess[áa]rio|implementar a l[óo]gica|ajustar o que for|etc\.?|e assim por diante|adequadamente|apropriad[oa]|tbd|a definir|a decidir|por enquanto|provis[óo]ri[oa]|vers[ãa]o simplificada)\b|\.\.\.\s*$/i
function underSpecified(st) { return (st.recipe || []).length < 2 || (st.examples || []).length < 2 || !String(st.test_file || '').trim() || (st.recipe || []).some((x) => VAGUE.test(x)) }
// rastreio critério <-> passo <-> exemplo: devolve os critérios (CA1..CAn) que nenhum passo da recipe ou nenhum example cita
function untraced(st) {
  const n = (st.acceptance || []).length; if (!n) return []
  const cited = (list) => new Set((list || []).flatMap((x) => [...String(x).matchAll(/CA(\d+)/g)].map((y) => +y[1])))
  const inRecipe = cited(st.recipe), inExamples = cited(st.examples), miss = []
  for (let i = 1; i <= n; i++) { if (!inRecipe.has(i)) miss.push(`CA${i} sem passo na recipe`); if (!inExamples.has(i)) miss.push(`CA${i} sem example`) }
  return miss
}
function tooBig(st) { return (st.acceptance || []).length > 4 || WORDS(st.request) > 140 || /\b(e tamb[ée]m|al[ée]m disso)\b/i.test(st.request || '') || !(st.scope_paths || []).length }

// ---------- prompts do maker ----------
function common(st) {
  const p = state.project, m = state.mission
  return [
    `Projeto: ${p.name} (${p.language || 'linguagem a definir'}); runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}.`,
    `Objetivo da missão: ${m.plan.title}. ${m.plan.summary}`,
    m.plan.decisions?.length ? `DECISÕES DO PLANO (já tomadas; não rediscuta nem troque):\n${m.plan.decisions.map((d) => `- ${d}`).join('\n')}` : '',
    `Story atual: ${st.title}. Instrução: ${st.request}`,
    st.recipe?.length ? `RECEITA (siga na ordem; um passo de cada vez):\n${st.recipe.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '',
    st.recipe?.some((x) => /(commit|push|npm (run |test)|vitest|tsc)/i.test(x)) ? 'ATENÇÃO: se um passo da receita mandar commitar, dar push, ou rodar a suíte inteira, o typecheck ou o lint, IGNORE esse trecho do passo: o motor faz isso depois de você. Vale a regra de PROVAS abaixo.' : '',
    st.examples?.length ? `EXEMPLOS que têm de valer (entrada → saída):\n${st.examples.map((x) => `- ${x}`).join('\n')}` : '',
    'DECISÃO FALTANDO: confira se a story, as DECISÕES e os EXEMPLOS dizem de onde vem cada valor que você precisa produzir. Escolha entre opções que o contrato já permite (nome de variável, ordem de um laço) é detalhe seu. Se a escolha fixa a origem de um dado ou um comportamento cobrado num critério, NÃO adivinhe calado: adote a opção mais simples que satisfaz os exemplos e escreva no fim uma linha `SUPOSIÇÃO: <o que faltava> -> <o que você adotou>` para cada uma (o revisor vai julgar). Na dúvida, é suposição.',
    'Siga o padrão que o código já usa (erros, nomes, estrutura de módulo); introduzir padrão novo é decisão, não detalhe.',
    'DEPENDÊNCIAS: nunca instale nem importe pacote que as DECISÕES ou a receita não nomeiam (nome de pacote inventado é risco de segurança). Se a parte parece exigir um, isso é CONTRATO ERRADO ou SUPOSIÇÃO, não correção automática. Mudança de arquitetura (novo módulo central, troca de formato de dado, nova camada) também não é sua: declare e pare.',
    'Cinco leituras ou buscas seguidas sem nenhuma edição é sinal de que você está sondando em vez de trabalhar: aja com o que já sabe ou declare o bloqueio na frase final.',
    attachBlock(m.attachments),
    `Critérios de aceite: ${(st.acceptance || []).map((a, i) => `(${i + 1}) ${a}`).join(' ')}`,
    st.scope_paths?.length ? `CONTRATO. Pode criar ou alterar SÓ: ${st.scope_paths.join(', ')}${st.do_not_touch?.length ? `. NÃO altere: ${st.do_not_touch.join(', ')}` : ''}${st.out_of_scope?.length ? `. Fora do escopo (não faça): ${st.out_of_scope.join('; ')}` : ''}${st.interfaces?.length ? `. Interfaces a respeitar: ${st.interfaces.join(' | ')}` : ''}. Precisa tocar em outro arquivo? Faça o mínimo e diga na frase final.` : '',
    'Trabalhe só dentro do diretório atual; não suba para diretórios acima. Leia antes de escrever.',
    scoutBlock(m.scout),
    'Arquivos grandes: use o MAPA DO CÓDIGO e leia só o trecho (Read com offset e limit); não leia inteiro um arquivo com mais de 300 linhas sem precisar. Código novo vai em módulo novo e pequeno quando o arquivo de destino já passa de 400 linhas; nunca reescreva um arquivo inteiro para mudar um trecho.',
    m.allow_commands && state.settings.scout_enabled !== false ? `Batedor sob demanda (Gemini, barato e rápido): quando precisar de documentação, de um arquivo com mais de 500 linhas, de um fato de biblioteca/API ou de algo na internet/GitHub, NÃO leia você: rode  node "${SCOUT_SCRIPT}" "pergunta objetiva" [arquivos]  (acrescente --web para pesquisar fora) e use o recibo impresso. Uma chamada por dúvida, pergunta curta e específica.` : '',
    m.allow_commands ? 'Você pode rodar comandos (instalar dependências, inicializar projeto). Não rode servidores que fiquem abertos. NUNCA use git para gravar ou desfazer (add, commit, stash, reset, checkout, restore, clean, push): o motor faz o commit depois das provas e da revisão; commit seu esconde o trabalho do revisor e derruba a parte. git status, diff e log, só para ler, pode. PROVAS: rode no máximo o arquivo de prova desta parte, uma vez depois de cada mudança; NUNCA a suíte inteira, modo watch ou comando que fique esperando: o motor roda a suíte completa depois de você. Não fique aguardando processo.' : 'Você só tem ferramentas de leitura e edição; o harness roda as provas.',
    p.runner === 'none' ? 'Não há runner de provas: crie o mínimo (JS: package.json com vitest e "test": "vitest run"; Python: requirements.txt com pytest e as dependências) antes da prova.' : '',
    p.language === 'python' || /python|fastapi|django|flask|pytest/i.test(m.request) ? 'Python: o harness cria .venv com uv e instala requirements.txt + pytest antes de cada rodada de provas. Liste toda dependência em requirements.txt; para rodar algo você mesmo use .venv\\Scripts\\python.exe (o "python" do PATH é o stub da Microsoft Store, sem pacotes). Não instale nada globalmente.' : '',
    p.has_index ? 'Há um index.html na raiz; o que for visual tem de aparecer nele.' : (m.plan.needs_ui ? 'Se esta story é visual, entregue/atualize index.html na raiz funcionando como arquivos estáticos (ES modules, sem build).' : ''),
    m.research?.findings?.length ? `Pesquisa prévia: ${m.research.findings.map((f) => `${f.question} → ${f.answer}`).join(' | ')}` : '',
    m.assets_done?.length ? `Imagens já geradas no projeto (use onde indicado, com alt descritivo; não gere outras): ${m.assets_done.map((a) => `${a.file} — ${a.purpose}`).join('; ')}. Regras de aplicação: object-fit: cover com enquadramento pensado (object-position), width/height ou aspect-ratio para não pular o layout, loading="lazy" fora do topo; texto sobre foto só com scrim/gradiente na cor da página garantindo contraste AA; sobreposição sutil (mix-blend-mode ou overlay de 10–25 % na cor de marca) quando a foto destoar da paleta; nunca esticar, nunca borda colorida, nunca filtro exagerado.` : '',
    m.answers?.length ? `Escolhas do usuário na entrevista: ${m.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}` : '',
  ].filter(Boolean)
}
function testPrompt(st, pack) {
  return [`Pedido original do usuário: ${state.mission.request}`, ...common(st),
    `FASE 1 de 2: escreva APENAS as provas novas (testes automatizados) desta story: uma função de teste por critério de aceite, todas no mesmo arquivo, com nomes que digam o critério. Todas devem FALHAR (ou nem carregar) no código atual, porque o comportamento ainda não existe. ${st.test_file ? `Arquivo de prova: ${st.test_file}. ` : ''}${st.examples?.length ? 'Cada EXEMPLO acima vira uma asserção. ' : ''}Dica de prova: ${st.test_hint}. Não implemente o comportamento ainda. Provas NUNCA fazem chamada real de rede, CLI externa ou serviço: simule com dublês (stub/mock) e teste o comportamento observável; prova que depende do ambiente vira falha falsa e trava a parte.`,
    'PROIBIDO nesta fase: criar ou alterar qualquer arquivo que não seja arquivo de prova. Se você implementar agora, as provas nascem verdes e não provam nada.',
    'QUALIDADE DA PROVA: (a) se o arquivo de prova já existe, ACRESCENTE; nunca crie um arquivo paralelo nem reescreva ou apague prova que já está lá; (b) nome da prova é uma frase que diz o critério; um conceito por prova; preparar, agir, conferir; (c) teste a interface pública e a saída observável, nunca estado interno nem "a função privada foi chamada"; (d) dublê só na fronteira do sistema (processo filho, relógio, sistema de arquivos, rede), nunca em módulo do próprio projeto; (e) determinística: sem hora real, sem depender da ordem das provas; congele o relógio quando o tempo importa; todo await presente; (f) valores concretos dos EXEMPLOS: prova que só repete o critério com outras palavras não prova nada; (g) cobertura nesta ordem: caminho feliz, bordas, erros, transições de estado; pelo menos uma prova de borda ou de falha; (h) se a parte mexe com processo filho, caminho de arquivo, hash ou entrada de fora, inclua um caso adverso (entrada malformada ou maliciosa, caminho que sai da pasta, hash adulterado).',
    st.red_retry ? 'SEGUNDA TENTATIVA: na primeira, nenhuma prova nova falhou no código atual. Escreva provas que exercitem o comportamento que AINDA NÃO EXISTE (importe o que será criado, chame, confira o resultado dos EXEMPLOS). Se a parte é só configuração ou documentação, prove o efeito observável: arquivo existe com tal conteúdo, comando sai com código 0, script do package.json existe.' : '',
    pack, 'Ao terminar, escreva uma frase com o nome do arquivo de prova e os nomes das provas novas.'].filter(Boolean).join('\n')
}
function fixPrompt(st, round, review, visual, pack) {
  const red = st.red_tests.map((t) => `- ${t.name}: ${t.message}`).join('\n')
  const base = [`Pedido original do usuário: ${state.mission.request}`, ...common(st), pack,
    `FASE 2 de 2: a prova nova está vermelha, como esperado:\n${red}`,
    st.red_regress?.length ? `Provas ANTIGAS que ficaram vermelhas depois que a prova nova entrou (em geral portão de tipos/lint reclamando do que ainda não existe). Têm de voltar a passar com a sua implementação; não as altere:\n${st.red_regress.map((t) => `- ${t.name}: ${t.message}`).join('\n')}` : '',
    'Agora implemente o necessário para a prova passar e os critérios de aceite valerem. Não modifique a prova. Não toque em nada fora do escopo da story. Seja direto: você tem no máximo 30 ações; não investigue ferramentas do harness, não reescreva provas antigas, não amplie o escopo.',
    'CONFLITO DE CONTRATO: se uma prova ANTIGA fica vermelha só porque afirma o formato ou comportamento que ESTA story manda mudar (ex.: igualdade estrita com o formato anterior), atualize APENAS essas asserções, mesmo que o arquivo esteja na lista de "não altere"; não mexa em mais nada desse arquivo e diga na frase final quais asserções mudou e por quê. Não reverta o comportamento pedido para agradar a prova antiga.',
    'REGRAS DE IMPLEMENTAÇÃO: falhe fechado na fronteira (entrada inválida é erro, não valor padrão calado); falhe alto se faltar configuração obrigatória; nada de catch vazio; invariantes valem com duas chamadas ao mesmo tempo; nova tentativa só limitada e idempotente. Código que você substitui SAI: o antigo e o novo não convivem; depois de remover, procure quem ainda cita o símbolo. Nunca enfraqueça asserção, apague prova ou marque prova como skip para passar: se a prova estiver errada, escreva `PROVA ERRADA: <nome> - <motivo>` na frase final e não mexa nela.',
    round > 1 && st.tests_after && !st.tests_after.ok ? `DEPURAÇÃO (rodada ${round}; a tentativa anterior não deixou as provas verdes): (1) antes de mudar qualquer linha, explique em uma frase POR QUE a prova falha; (2) reproduza rodando só o arquivo de prova; (3) uma hipótese por vez sobre a CAUSA, não o sintoma; teste com a menor mudança; hipótese refutada = desfaça a mudança antes da próxima; (4) correção mínima na causa provada, sem refatoração de carona; (5) depois de verde, procure o mesmo padrão errado nos outros arquivos do escopo.` : '',
    'CONTRATO ERRADO: se a parte é irrealizável como está escrita (um critério contradiz uma decisão, um exemplo é impossível, a prova exige o que o contrato proíbe), não force nem contorne: escreva `CONTRATO ERRADO: <o que contradiz o quê>` na frase final e pare. O planejador corrige a parte; insistir só gasta rodadas.',
    'Ao terminar, escreva uma frase dizendo o que mudou.']
  if (round > 1 && review) { base.push('Se um pedido do revisor contradiz uma DECISÃO DO PLANO, o contrato ou um critério de aceite, não o aplique: na frase final cite literalmente a decisão ou o critério que o impede (o revisor vai ler a sua resposta). Todo o resto, corrija.'); base.push(`Rodada ${round}. O revisor (outra IA) pediu mudanças: ${review.summary}`); for (const f of review.findings) base.push(`- [${f.severity}] ${f.file}: ${f.problem} Correção sugerida: ${f.fix}`) }
  if (visual?.length) { base.push('O portão visual (Impeccable detect) apontou; corrija. Se um achado conflita com um detalhe decorativo de um critério de aceite (borda lateral, gradiente, cor), o portão vence: satisfaça a intenção do critério de outro jeito, sem investigar o detector, e diga isso na frase final.'); for (const f of visual) base.push(`- ${f.file}${f.line ? ':' + f.line : ''} [${f.rule}] ${f.message}`) }
  return base.join('\n') + skillsBlock(state.mission.skills.maker || [])
}

// ---------- pipeline ----------
// Faixa rápida (spec ADR 0008, E18): classificador determinístico ANTES de qualquer modelo. Pedido curto, com verbo de correção,
// em projeto que já tem arquivos → trivial: sem entrevista, sem plano no Opus, uma story direto para prova + correção. Revisor continua.
const FIX_VERBS = /\b(corrija|conserte|arrume|ajuste|troque|mude|altere|renomeie|remova|tire|apague|aumente|diminua|esconda|mostre|inverta|centralize|alinhe|traduza|substitua)\b/i
const BIG_WORDS = /\b(e tamb[ée]m|al[ée]m disso|tela nova|p[áa]gina nova|sistema|m[óo]dulo|refa[çc]a|reescreva|redesign|do zero|completo|inteir[oa])\b/i
function fastLane(request) {
  const p = state.project
  if (state.settings.fast_lane === false || !p || p.files === 0) return null
  if (request.length > 220 || /\n/.test(request) || !FIX_VERBS.test(request) || BIG_WORDS.test(request)) return null
  const ui = /\b(bot[ãa]o|cor|cores|css|tela|p[áa]gina|layout|fonte|imagem|menu|link|t[íi]tulo|texto|estilo)\b/i.test(request) || (p.has_index && !/\b(api|rota|endpoint|servidor|banco)\b/i.test(request))
  const be = /\b(api|rota|endpoint|banco|sql|servidor|valida[çc][ãa]o)\b/i.test(request)
  const domains = new Set(['testing']); if (ui) { domains.add('frontend'); domains.add('design') } if (be) { domains.add('backend'); domains.add('api') } if (p.language === 'python') domains.add('python')
  return { complexity: 'trivial', difficulty: 'easy', difficulty_why: 'correção curta', summary: request, domains: [...domains], keywords: [], needs_ui: ui, needs_backend: be, research_questions: [], questions: [], skills: { planner: [], maker: [], checker: [], research: [] } }
}
async function planMission() {
  const m = state.mission
  const fl = fastLane(m.request)
  if (fl) {
    m.intent = fl; m.skills = selectSkills(fl); setStep('intent', 'done', { fast: true })
    log('engine', `faixa rápida: pedido pequeno de correção; sem entrevista e sem plano no ${state.settings.roles.planner.model}; skills do maker: ${m.skills.maker.map((x) => x.id).join(', ') || 'nenhuma'}`)
    m.plan = { title: m.request.slice(0, 60), summary: m.request, explanation: 'Pedido pequeno: a ADE vai direto para a prova e a correção, sem entrevista nem plano longo. O revisor confere no fim.', complexity: 'trivial', domains: fl.domains, keywords: [], needs_ui: fl.needs_ui, needs_backend: fl.needs_backend, research_questions: [], questions: [], assets_style: '', assets: [],
      stories: [{ id: 's1', title: m.request.slice(0, 72), request: m.request, acceptance: ['O que o usuário pediu acontece de forma observável', 'Nada que funcionava antes quebrou (provas antigas continuam verdes)'], test_hint: 'uma prova que falha hoje e passa quando o pedido estiver atendido' }] }
    m.stories = m.plan.stories.map((st) => ({ ...st, state: 'queued', steps: [], round: 0, red_tests: [], tests_after: null, diff: '', review: null, visual: null }))
    setStep('plan', 'done', { fast: true }); broadcast()
    return runStories()
  }
  setStep('intent', 'running')
  const ri = await claudeCall({ role: 'entender', prompt: intentPrompt(), model: state.settings.roles.intent.model, effort: effortOf('intent'), tools: ['Read', 'Glob'], schema: INTENT_JSON_SCHEMA, maxTurns: 4 })
  const intent = ri?.structured_output
  if (!intent) { setStep('intent', 'failed'); m.state = 'awaiting_operator'; m.reason = 'plan_failed'; log('engine', 'o entendimento não veio no formato esperado', 'error'); return finish() }
  m.intent = intent
  m.skills = selectSkills(intent)
  setStep('intent', 'done')
  { const big = ['subsystem', 'project'].includes(intent.complexity), kind = big || intent.difficulty === 'hard' ? 'complex' : 'light', w = plannerChoice(kind)
    log('engine', `dificuldade ${intent.difficulty || '?'}${intent.difficulty_why ? ` (${intent.difficulty_why})` : ''}: ${big ? 'divisão em épicos' : 'plano'} com o planejador ${kind === 'complex' ? 'complexo' : 'intermediário'} (${w.model}, ${w.effort})${big ? `; o plano de cada épico sai no intermediário (${plannerChoice('light').model})` : ''}`) }
  log('engine', `entendido: ${intent.complexity} · ${intent.domains.join(', ')} · skills — planejador: ${m.skills.planner.map((s) => s.id).join(', ') || 'nenhuma'}; maker: ${m.skills.maker.map((s) => s.id).join(', ') || 'nenhuma'}; revisor: ${m.skills.checker.map((s) => s.id).join(', ') || 'nenhuma'}; pesquisa: ${m.skills.research.map((s) => s.id).join(', ') || 'nenhuma'}`)
  if (intent.questions?.length && state.settings.unattended) { m.answers = intent.questions.map((q) => ({ id: q.id, question: q.question, answer: q.options?.[0]?.label || 'não sei' })); log('engine', `modo noturno: entrevista respondida com as recomendações (${m.answers.length} pergunta(s))`, 'warn') }
  else if (intent.questions?.length) { m.plan = { title: m.request.slice(0, 60), summary: intent.summary, complexity: intent.complexity, domains: intent.domains, needs_ui: intent.needs_ui, needs_backend: intent.needs_backend, questions: intent.questions, research_questions: [], stories: [] }; m.state = 'awaiting_plan'; m.reason = 'questions'; broadcast(); await persistMission().catch(() => {}); return }
  return continuePlanning()
}
async function continuePlanning() {
  const m = state.mission, intent = m.intent
  m.state = 'planning'; broadcast()
  if (intent.research_questions?.length && state.settings.research_enabled && !m.research) {
    setStep('research', 'running'); m.research = await research(intent.research_questions.slice(0, 3)); setStep('research', m.research ? 'done' : 'failed')
  }
  if (['subsystem', 'project'].includes(intent.complexity) && !m.program) return makeProgram()
  if (!m.scout && scoutWorth() && ['feature', 'subsystem', 'project'].includes(intent.complexity)) { setStep('scout', 'running'); m.scout = await scout(`O que quem vai planejar "${m.request.slice(0, 300)}" precisa saber deste projeto: onde ficam as partes envolvidas, padrões e provas existentes, o que já existe do pedido e o que pode atrapalhar.`); setStep('scout', m.scout ? 'done' : 'failed') }
  if (!m.map) m.map = await codeMap(state.project.dir, (await projectTree(state.project.dir)).filter((f) => TEXT_EXT.test(f)))
  return makePlan()
}
async function makeProgram() {
  const m = state.mission, intent = m.intent
  m.state = 'planning'; setStep('plan', 'running')
  const r = await plannerCall(plannerChoice('complex'), { role: 'épicos', prompt: epicsPrompt(), schema: EPICS_JSON_SCHEMA, maxTurns: 10 })
  const pr = r?.structured_output
  if (!pr?.epics?.length) { setStep('plan', 'failed'); m.state = 'awaiting_operator'; m.reason = 'plan_failed'; log('engine', 'a divisão em épicos não veio no formato esperado', 'error'); return finish() }
  m.program = { title: pr.title, explanation: pr.explanation, epics: pr.epics.map((e) => ({ ...e, state: 'queued', usd: 0, stories: [], summary: '' })), current: null }
  m.plan = { title: pr.title, summary: pr.explanation.split('\n')[0], explanation: pr.explanation, complexity: intent.complexity, domains: intent.domains, needs_ui: intent.needs_ui, needs_backend: intent.needs_backend, questions: [], research_questions: [], assets: [], assets_style: '', epics: m.program.epics, stories: [] }
  m.stories = []
  setStep('plan', 'done')
  log('engine', `pedido grande: dividido em ${m.program.epics.length} épicos, um por vez (${m.program.epics.map((e) => e.title).join(' → ')})`)
  if (state.settings.unattended) { log('engine', 'modo noturno: fila de épicos aprovada automaticamente', 'warn'); return runProgram() }
  m.state = 'awaiting_plan'; m.reason = 'approve_plan'; broadcast(); await persistMission().catch(() => {})
}
// roda os épicos em ordem: cada um é planejado na hora (vendo o código dos anteriores) e executado com o fluxo normal de stories
function closeEpic(ep, stories) {
  const done = stories.filter((x) => x.state === 'done'), missing = stories.filter((x) => x.state !== 'done' && !stories.some((f) => f.fix_of === x.id && f.state === 'done'))
  ep.stories = [...(ep.stories_prev || []), ...stories.map((x) => ({ id: x.id, title: x.title, state: x.state, skipped_reason: x.skipped_reason || null }))]
  ep.already = [...(ep.already || []), ...done.map((x) => x.title)]
  ep.summary = `${ep.already.length} parte(s) pronta(s): ${ep.already.join('; ')}`
  const pg = state.mission.program, dec = (state.mission.plan?.decisions || []).map((d) => String(d).slice(0, 400))
  if (pg && dec.length) pg.decisions_log = [...(pg.decisions_log || []).filter((e) => e.epic !== ep.id), { epic: ep.id, title: ep.title, decisions: dec }]
  if (!missing.length) { ep.state = 'done'; ep.missing = []; return }
  ep.missing = missing.map((x) => `${x.title} (${x.skipped_reason || x.state})`)
  if ((ep.attempts || 0) < 1) { ep.attempts = (ep.attempts || 0) + 1; ep.state = 'queued'; ep.stories_prev = ep.stories.filter((x) => x.state === 'done'); log('engine', `épico "${ep.title}" incompleto (${missing.length} parte(s) sem concluir); volta para a fila e o planejador replaneja só o que falta`, 'warn') }
  else { ep.state = 'incomplete'; ep.reason = `faltou: ${ep.missing.join('; ')}`; log('engine', `épico "${ep.title}" continua incompleto depois do replanejamento; a missão pausa para você decidir (os épicos seguintes dependem dele)`, 'error') }
}
async function runProgram() {
  const m = state.mission, pg = m.program
  if (!pg) return runStories()
  for (const e of pg.epics) if (e.state === 'blocked') { e.state = 'queued'; e.reason = null } // reavalia bloqueios a cada passada
  if (pg.epics.some((e) => e.state === 'incomplete')) { m.epic = null; m.current = null; m.state = 'paused'; m.reason = 'epic_incomplete'; await persistMission().catch(() => {}); finish(); return 'stopped' }
  for (let i = 0; i < pg.epics.length; i++) {
    const ep = pg.epics[i]
    if (['done', 'failed', 'blocked', 'incomplete'].includes(ep.state)) continue
    const bad = (ep.depends_on || []).filter((id) => pg.epics.find((x) => x.id === id)?.state !== 'done')
    if (bad.length) { ep.state = 'blocked'; ep.reason = `depende de ${bad.join(', ')}`; log('engine', `épico "${ep.title}" bloqueado: depende de ${bad.join(', ')}, que não concluiu. Nada gasto.`, 'warn'); continue }
    const cap = state.settings.max_usd_per_mission || 60, planCost = Math.max(3, ...pg.epics.filter((x) => x.plan_usd).map((x) => x.plan_usd))
    if (m.cost.usd + planCost > cap) {
      log('engine', `teto da missão: gasto US$ ${m.cost.usd.toFixed(2)} + plano do próximo épico (~US$ ${planCost.toFixed(2)}) passa de US$ ${cap}. Pauso antes de planejar "${ep.title}"; aumente o teto em Opções e continue.`, 'warn')
      m.epic = null; m.current = null; m.state = 'paused'; m.reason = 'budget'; await persistMission().catch(() => {}); finish(); return 'stopped'
    }
    pg.current = i; ep.state = 'running'; m.epic = ep; m.stories = []; m.plan_feedback = []; m.tests_before = null; m.split_tried = false; m.spec_tried = false; m.critic_tried = false; m.current = null
    const usd0 = m.cost.usd
    log('engine', `épico ${i + 1} de ${pg.epics.length}: ${ep.title}`)
    m.state = 'planning'; broadcast()
    if (scoutWorth() && i > 0) { setStep('scout', 'running'); m.scout = await scout(`Épico "${ep.title}": ${ep.goal.slice(0, 400)}. O que quem vai planejar este épico precisa saber do estado atual do projeto (o que os épicos anteriores deixaram, onde ficam as partes envolvidas, provas existentes)?`); setStep('scout', m.scout ? 'done' : 'failed') }
    m.map = await codeMap(state.project.dir, (await projectTree(state.project.dir)).filter((f) => TEXT_EXT.test(f)))
    const planned = await makePlan({ inProgram: true })
    ep.plan_usd = m.cost.usd - usd0
    if (!planned) {
      ep.usd = m.cost.usd - usd0; ep.plan_tries = (ep.plan_tries || 0) + 1; ep.state = 'queued'; m.epic = null
      if (ep.plan_tries < 2) { log('engine', `o plano do épico "${ep.title}" não veio; tento mais uma vez com mais turnos`, 'warn'); return runProgram() }
      log('engine', `o plano do épico "${ep.title}" não veio em duas tentativas; a missão pausa (seguir para o próximo épico deixaria um buraco)`, 'error')
      ep.plan_tries = 0; m.current = null; m.state = 'paused'; m.reason = 'plan_failed'; await persistMission().catch(() => {}); finish(); return 'stopped'
    }
    if (m.state === 'awaiting_plan') return // dúvida do planejador: espera você; decide('start'/'answer') volta para cá
    const res = await runStories()
    ep.usd = m.cost.usd - usd0
    if (res !== 'ok') return // pausou ou parou esperando você; ao continuar, runStories termina o épico e chama runProgram de novo
    if (ep.state === 'running') closeEpic(ep, m.stories)
    m.epic = null; broadcast(); await persistMission().catch(() => {})
    if (ep.state !== 'done') return runProgram()
  }
  m.epic = null; m.current = null; m.state = 'complete'; m.reason = null
  const failed = pg.epics.filter((e) => e.state !== 'done').length
  log('engine', failed ? `fila de épicos terminou com ${failed} épico(s) não concluído(s) (veja o motivo em cada um)` : 'fila de épicos concluída: tudo provado, revisado e commitado', failed ? 'warn' : 'info')
  return finish()
}
async function makePlan({ inProgram = false } = {}) {
  const m = state.mission, intent = m.intent
  m.state = 'planning'; setStep('plan', 'running')
  // revisão automática (dividir, detalhar, crítica) é edição de um plano que já existe: modelo mais barato, poucos turnos, sem reexplorar.
  // Medido em 17/09: uma revisão no Fable custou US$ 4,83 (42 turnos, 63k tokens de saída) porque reescrevia tudo.
  const revising = !!(m.plan?.stories?.length && m.plan_feedback?.length && (m.split_tried || m.spec_tried || m.critic_tried) && m.auto_revision)
  const base = plannerChoice(!inProgram && m.intent?.difficulty === 'hard' ? 'complex' : 'light')
  const who = revising ? { ...plannerChoice('light'), effort: 'medium' } : base
  m.auto_revision = false
  const turns = revising ? 6 : 20 + (m.epic?.plan_tries || 0) * 16
  const r = await plannerCall(who, { role: revising ? 'revisão do plano' : 'plano', prompt: planPrompt(revising) + `\n\nLIMITE: você tem ${turns} turnos de ferramenta. Use o mapa e o recibo do batedor em vez de reler arquivos; leia só trechos. Entregue o plano antes do limite: plano não entregue é dinheiro perdido.`, schema: PLAN_JSON_SCHEMA, maxTurns: turns })
  const plan = r?.structured_output
  if (!plan?.stories?.length) { setStep('plan', 'failed'); if (inProgram) return false; m.state = 'awaiting_operator'; m.reason = 'plan_failed'; log('engine', 'o plano não veio no formato esperado', 'error'); return finish() }
  // parte grande demais volta ao planejador uma vez, sem gastar com maker
  const vague = plan.stories.filter((x) => !tooBig(x) && underSpecified(x))
  const loose = plan.stories.filter((x) => !tooBig(x)).map((x) => ({ id: x.id, miss: untraced(x) })).filter((x) => x.miss.length)
  if ((vague.length || loose.length) && !m.spec_tried) {
    m.spec_tried = true
    if (vague.length) m.plan_feedback = [...(m.plan_feedback || []), `A(s) parte(s) ${vague.map((x) => x.id).join(', ')} está(ão) subespecificada(s): faltam passos concretos na recipe (arquivo + ação, sem "conforme necessário"), pelo menos 2 examples literais de entrada → saída ou o test_file. Complete; mantenha as outras.`]
    if (loose.length) { m.plan_feedback = [...(m.plan_feedback || []), `Rastreio incompleto (cada critério CAn precisa aparecer entre colchetes em pelo menos um passo da recipe e no começo de pelo menos um example): ${loose.map((x) => `${x.id}: ${x.miss.join(', ')}`).join('; ')}. Acrescente as marcas; se um critério não tem passo ou exemplo de verdade, crie o passo ou o exemplo que falta. Mantenha o resto.`]; log('engine', `plano sem rastreio completo de critérios (${loose.map((x) => x.id).join(', ')}); pedindo as marcas ao planejador`, 'warn') }
    m.stories = plan.stories.map((s) => ({ ...s, state: 'queued', steps: [], round: 0 })); m.plan = { ...(m.plan || {}), ...plan }
    if (vague.length) log('engine', `plano com parte(s) subespecificada(s) (${vague.map((x) => x.id).join(', ')}); pedindo detalhe ao planejador`, 'warn')
    m.auto_revision = true
    return makePlan({ inProgram })
  }
  const big = plan.stories.filter(tooBig)
  if (big.length && !m.split_tried) {
    m.split_tried = true
    m.plan_feedback = [...(m.plan_feedback || []), `Divida a(s) parte(s) ${big.map((x) => x.id).join(', ')} em 2 ou 3 partes menores: cada uma com UM comportamento, até 4 critérios, até 120 palavras e scope_paths preenchido; mantenha as outras.`]
    m.stories = plan.stories.map((s) => ({ ...s, state: 'queued', steps: [], round: 0 })); m.plan = { ...(m.plan || {}), ...plan }
    log('engine', `plano com parte(s) grande(s) demais (${big.map((x) => x.id).join(', ')}); pedindo divisão ao planejador`, 'warn')
    m.auto_revision = true
    return makePlan({ inProgram })
  }
  if (state.settings.plan_critic !== false && !m.critic_tried && ['feature', 'subsystem', 'project'].includes(m.intent?.complexity)) {
    const crit = await planCritic(plan)
    if (crit) m.critic_tried = true
    if (crit?.verdict === 'revise' && crit.issues?.length) {
      m.plan_feedback = [...(m.plan_feedback || []), `Outra IA leu o plano como se fosse implementar e apontou onde teria de decidir sozinha. Corrija cada ponto na story indicada (recipe, examples, interfaces, decisions) e mantenha o resto: ${crit.issues.slice(0, 10).map((x) => `[${x.story}] ${x.problem} → ${x.fix}`).join(' | ')}`]
      m.stories = plan.stories.map((s) => ({ ...s, state: 'queued', steps: [], round: 0 })); m.plan = { ...(m.plan || {}), ...plan }
      log('engine', `crítica do plano: ${crit.issues.length} ponto(s) em aberto; planejador corrige uma vez`, 'warn')
      m.auto_revision = true
    return makePlan({ inProgram })
    }
  }
  const keep = m.program ? { epics: m.program.epics, explanation: m.program.explanation } : {}
  m.plan = { ...plan, ...keep, title: m.program ? m.program.title : plan.title, epic_title: m.epic?.title || null, epic_explanation: m.program ? plan.explanation : null, needs_ui: plan.needs_ui || intent.needs_ui, needs_backend: plan.needs_backend || intent.needs_backend, domains: [...new Set([...(intent.domains || []), ...(plan.domains || [])])] }
  m.stories = plan.stories.map((s) => ({ ...s, state: 'queued', steps: [], round: 0, red_tests: [], tests_after: null, diff: '', review: null, visual: null }))
  setStep('plan', 'done')
  log('engine', `plano${m.epic ? ` do épico "${m.epic.title}"` : ''}: ${plan.title} · ${m.plan.complexity} · ${m.stories.length} story(s)`)
  if (plan.questions?.length) { m.state = 'awaiting_plan'; m.reason = 'questions'; broadcast(); await persistMission().catch(() => {}); return inProgram ? true : undefined }
  if (inProgram) return true
  if (state.settings.unattended) log('engine', `modo noturno: plano com ${m.stories.length} parte(s) aprovado automaticamente`, 'warn')
  else if (m.user_feedback || m.stories.length > 2) { m.state = 'awaiting_plan'; m.reason = 'approve_plan'; broadcast(); await persistMission().catch(() => {}); return }
  return runStories()
}

async function runStories() {
  const m = state.mission
  m.state = 'running'; broadcast()
  try {
    if (!m.tests_before) {
      setStep('prepare', 'running'); m.tests_before = await runTests(state.project)
      log('engine', state.project.runner === 'none' ? 'ponto de partida: sem runner de provas (a IA vai criar um)' : `ponto de partida: ${m.tests_before.total} provas, ${m.tests_before.failed} vermelhas`)
      setStep('prepare', 'done')
    }
    await makeAssets()
    for (let i = 0; i < m.stories.length; i++) {
      const st = m.stories[i]
      if (st.state === 'done' || st.state === 'skipped') continue
      // dependência não concluída: não gasta nada
      const badDeps = (st.depends_on || []).filter((id) => { const d = m.stories.find((x) => x.id === id); return d && d.state !== 'done' })
      if (badDeps.length) { st.state = 'skipped'; st.skipped_reason = `depende de ${badDeps.join(', ')}, que não concluiu`; log('engine', `parte "${st.title}" pulada sem gastar: ${st.skipped_reason}`, 'warn'); broadcast(); continue }
      m.current = i; st.state = 'running'; broadcast()
      let ok = await runStory(st)
      // rejeitada pelo revisor com achado grave depois das rodadas: o trabalho fica e vira uma parte de correção só com os achados (uma vez)
      const highs = (st.review?.findings || []).filter((f) => f.severity === 'high')
      const reds = (st.tests_after?.tests || []).filter((t) => t.status !== 'passed').slice(0, 6)
      const fixable = !ok && state.settings.autonomy !== 'ask' && !st.fix_attempted && !st.fix_of && ((m.reason === 'review_changes' && highs.length) || (m.reason === 'tests_red' && reds.length))
      if (fixable) {
        const problems = m.reason === 'tests_red' ? reds.map((t) => `- prova vermelha ${t.name}: ${(t.message || '').slice(0, 300)}`) : highs.map((f) => `- ${f.file}: ${f.problem} Correção sugerida: ${f.fix}`)
        const fix = { id: `${st.id}f`, title: `Corrigir: ${st.title.slice(0, 56)}`, request: `Os arquivos da parte anterior ("${st.title}") já estão alterados no projeto (não commitados). NÃO refaça a parte: corrija APENAS os problemas abaixo, no código existente. Se uma prova vermelha depende de rede, CLI externa ou ambiente, troque a dependência por um dublê na prova; não apague provas.\n${problems.join('\n')}`, acceptance: (m.reason === 'tests_red' ? reds.map((t) => `A prova "${t.name.slice(0, 100)}" passa`) : highs.map((f) => `Achado corrigido: ${String(f.problem).slice(0, 180)}`)).slice(0, 4), test_hint: m.reason === 'tests_red' ? 'as provas vermelhas listadas já existem; não escreva novas' : 'uma prova que reproduza cada achado (falha hoje) e passe depois da correção', depends_on: [], no_test_phase: m.reason === 'tests_red', scope_paths: st.scope_paths || [], do_not_touch: st.do_not_touch || [], out_of_scope: st.out_of_scope || [], interfaces: st.interfaces || [], fix_of: st.id, state: 'queued', steps: [], round: 0, red_tests: [], tests_after: null, diff: '', review: null, visual: null }
        st.fix_attempted = true; st.state = 'skipped'; st.skipped_reason = `${m.reason === 'tests_red' ? 'provas vermelhas' : 'rejeitada pelo revisor'}; correção na parte ${fix.id}`
        m.stories.splice(i + 1, 0, fix); m.state = 'running'; m.reason = null
        log('engine', `"${st.title}" parou em ${fix.no_test_phase ? 'provas vermelhas' : 'achado grave do revisor'}; o trabalho fica e vira a parte "${fix.title}" com o modelo forte`, 'warn'); broadcast(); continue
      }
      if (!ok && state.settings.unattended && m.reason !== 'budget' && m.reason !== 'engine_error') {
        if (['review_failed', 'review_changes'].includes(m.reason) && st.tests_after?.ok && !(st.review?.findings || []).some((f) => f.severity === 'high')) {
          st.auto_accepted = true; ok = true; log('engine', `modo noturno: ${m.reason} com provas verdes e nada grave; parte aceita`, 'warn')
        } else {
          log('engine', `modo noturno: parada "${m.reason}" sem saída; parte pulada e arquivos dela desfeitos; segue para a próxima`, 'warn')
          if (st.maker_committed) log('engine', `ATENÇÃO: a parte "${st.title}" foi pulada, mas quem escreve tinha feito commit por conta própria; esse commit ficou no histórico SEM revisão. Confira com git log`, 'error')
          st.state = 'skipped'; st.skipped_reason = st.contract_issue ? `contrato errado: ${st.contract_issue}` : m.reason; await gitDiscard(state.project.dir); await refreshProject(); m.state = 'running'; m.reason = null; broadcast()
          // duas partes puladas em sequência = base que as próximas precisam não existe; continuar só queima dinheiro. Pausa e espera você (ADR 0015).
          if (m.stories[i - 1]?.state === 'skipped' && !m.stories[i - 1]?.fix_attempted) { m.state = 'paused'; m.reason = 'skips'; log('engine', 'modo noturno: duas partes seguidas puladas; as próximas dependem delas. Missão pausada para você replanejar.', 'error'); await persistMission().catch(() => {}); return finish() }
          continue
        }
        m.state = 'running'; m.reason = null; st.state = 'running'
      }
      if (!ok) { finish(); return 'stopped' }
      await gitCommit(state.project.dir, `ade: ${st.title.slice(0, 72)}`)
      if (st.tests_after?.tests?.length) m.tests_before = st.tests_after
      await refreshProject()
      log('engine', `commit feito: ${st.title}`)
      st.state = 'done'; broadcast(); await persistMission().catch(() => {})
    }
    if (m.program && m.epic) { // fim de um épico: quem fecha é a fila
      const ep = m.program.epics.find((x) => x.id === m.epic.id) || m.epic; if (ep.state === 'running') closeEpic(ep, m.stories)
      m.current = null; m.epic = null; broadcast(); await persistMission().catch(() => {})
      if (m.program.current != null && m.program.epics.some((e) => ['queued', 'incomplete'].includes(e.state))) return runProgram()
      return 'ok'
    }
    m.state = 'complete'; m.reason = null; m.current = null
    const skipped = m.stories.filter((x) => x.state === 'skipped').length
    log('engine', skipped ? `missão pronta com ${skipped} parte(s) pulada(s) (veja o motivo em cada uma)` : 'missão pronta: todas as stories provadas, revisadas e commitadas', skipped ? 'warn' : 'info')
  } catch (e) { if (e === PAUSE) throw e; m.state = 'awaiting_operator'; m.reason = 'engine_error'; log('engine', `erro do engine: ${e.message}`, 'error'); finish(); return 'stopped' }
  finish(); return 'ok'
}

const MAX_ROUNDS = 6 // rodadas de correção por parte antes de parar e pedir decisão (Erick, 17/09: 4 era pouco)

// ---------- quem escreve: Claude ou Gemini (Antigravity), com escada de subida por falha grave ----------
// Degraus: maker configurado → (Gemini) mesmo modelo em esforço alto → Sonnet alto → modelo do planejador. Sobe um degrau por rodada
// com problema grave a partir da 3ª; parte de correção já nasce no último degrau.
// ponytail: a escada pode cair na mesma empresa do revisor se o revisor for Claude; hoje o revisor é Codex. Validar se isso mudar.
function makerLadder() {
  const mk = { family: state.settings.roles.maker.family || 'claude', model: state.settings.roles.maker.model, effort: effortOf('maker') }, steps = [mk]
  if (mk.family === 'agy' && /^gemini/.test(mk.model) && mk.effort !== 'high') steps.push({ ...mk, effort: 'high' })
  if (mk.family !== 'claude') steps.push({ family: 'claude', model: 'sonnet', effort: 'high' })
  const pl = plannerChoice('light'); steps.push(pl.family !== 'claude' || pl.model === 'fable' ? { family: 'claude', model: 'opus', effort: 'high' } : { family: 'claude', model: pl.model, effort: pl.effort || 'high' }) // Fable planeja; escrever código no Fable é caro demais
  return steps.filter((x, i, a) => a.findIndex((y) => y.family === x.family && y.model === x.model && y.effort === x.effort) === i)
}
function makerStep(st, round, grave) { const l = makerLadder(); const i = st.fix_of ? l.length - 1 : grave ? Math.min(l.length - 1, Math.max(0, round - 2)) : 0; return { ...l[i], step: i } }
async function makerCall(who, opts) { return who.family === 'agy' ? agyMaker({ ...opts, model: who.model, effort: who.effort }) : claudeCall({ ...opts, model: who.model, effort: who.effort }) }
// Antigravity como maker: o prompt é grande demais para a linha de comando do Windows, então vai num arquivo ignorado pelo git.
async function agyMaker({ role, prompt, model, effort }) {
  const m = state.mission, dir = state.project.dir, id = agyModel(model, effort)
  const rel = `${ATTACH_DIR}/prompt-${Date.now().toString(36)}.md`
  await mkdir(path.join(dir, ATTACH_DIR), { recursive: true }); await ensureIgnore(dir); await writeFile(path.join(dir, rel), prompt)
  const status = async () => new Set((await run('git', ['status', '--porcelain'], { cwd: dir })).out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean))
  const before = await status(), t0 = Date.now()
  log('engine', `agy (${role}, ${id})`); setLive({ source: 'agy', kind: 'thinking', text: `${role}: Gemini trabalhando (sem transmissão ao vivo)…` })
  let r; try { r = await run('agy', [`--print=Leia o arquivo ${path.join(dir, rel).split(path.sep).join('/')} e execute exatamente as instruções dele neste projeto. Não altere nem apague esse arquivo. Não use git. Termine com uma frase dizendo o que mudou.`, '--output-format', 'json', '--model', id, '--mode', 'accept-edits', '--dangerously-skip-permissions', '--print-timeout', '20m'], { cwd: dir, timeoutMs: 22 * 60 * 1000 }) }
  finally { setLive(null); await rm(path.join(dir, rel), { force: true }).catch(() => {}) }
  m.cost.calls += 1
  let j = null; try { j = JSON.parse(r.out) } catch {}
  const touched = [...(await status())].filter((f) => !before.has(f) && !f.startsWith(ATTACH_DIR))
  const u = j?.usage || {}
  m.cost.tokens_in += u.input_tokens || 0; m.cost.tokens_out += u.output_tokens || 0; m.cost.cache_read += u.cache_read_tokens || 0
  m.cost.by_model[id] = m.cost.by_model[id] || 0
  journal({ type: 'model_call', family: 'agy', role, model: id, effort, story: m.current, turns: j?.num_turns || 0, usd: 0, tokens_in: u.input_tokens || 0, cache_read: u.cache_read_tokens || 0, tokens_out: u.output_tokens || 0, prompt_chars: prompt.length, wall_ms: Date.now() - t0 }).catch(() => {})
  if (!j || j.status !== 'SUCCESS') {
    const msg = (j?.response || r.err || r.out || '').toString()
    log('engine', `agy falhou (código ${r.code}): ${msg.slice(0, 300)}`, 'error')
    if (/quota reached|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) {
      const t = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(msg) || []
      const wait = ((+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + (+t[3] || 0)) * 1000 || 30 * 60 * 1000
      quotaPause('Gemini', new Date(Date.now() + wait + 60 * 1000).toISOString())
    }
    return null
  }
  const text = String(j.response || '').replace(/\(file:\/\/[^)]*\)/g, '').trim()
  log('agy', text.slice(0, 600), 'text')
  log('engine', `agy terminou · ${Math.round((Date.now() - t0) / 1000)} s · ${Math.round((u.input_tokens || 0) / 1000)}k tokens de entrada · ${touched.length} arquivo(s)`)
  return { result: text, touched, num_turns: j.num_turns || 0, total_cost_usd: 0 }
}

const IS_TEST_FILE = (f, st) => f === st.test_file || /(^|\/)(tests?|__tests__|specs?|fixtures|__fixtures__|__mocks__)\//i.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f) || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(f)
// devolve 'red' (provas novas falham sem o código novo), 'green' (passam sem ele: não provam nada) ou 'skip' (não deu para conferir)
async function redWithoutCode(st, diff, fresh) {
  const dir = state.project.dir
  if (st.base && (await gitHead(dir)) !== st.base) return 'skip' // quem escreve commitou: não há o que guardar de lado
  const code = [...new Set([...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((x) => x[1]))].filter((f) => !IS_TEST_FILE(f, st))
  if (!code.length) return 'skip'
  await run('git', ['reset', '-q'], { cwd: dir }) // tira a "intenção de adicionar" do índice (vem do gitDiff); com ela o stash recusa ("not uptodate")
  const put = await run('git', ['stash', 'push', '-u', '-q', '-m', 'ade-prova-vermelha', '--', ...code], { cwd: dir })
  if (put.code !== 0) { log('engine', `não consegui guardar o código de lado para conferir a prova vermelha (${(put.err || put.out).trim().split('\n')[0]}); sigo sem essa conferência`, 'warn'); return 'skip' }
  let res = null
  try { res = await runTests(state.project) } finally {
    // numa pausa pedida no meio, run() recusa rodar o pop; a parte recomeça do zero de qualquer jeito e a entrada fica em `git stash list`
    const back = await run('git', ['stash', 'pop', '-q'], { cwd: dir }).catch(() => ({ code: -1, err: 'pausa' }))
    if (back.code !== 0 && back.err !== 'pausa') { log('engine', 'NÃO consegui devolver o código guardado de lado; ele está em `git stash list` com o nome ade-prova-vermelha. Rode `git stash pop` na pasta do projeto', 'error'); throw new Error('git stash pop falhou depois da conferência de prova vermelha') }
  }
  if (!res || res.timeout) return 'skip'
  return res.ok ? 'green' : 'red' // arquivo de prova que nem carrega sem o código conta como vermelho
}
function remember(st, r) {
  if (!r) return
  st.files = [...new Set([...(st.files || []), ...(r.touched || [])])]
  if (typeof r.result !== 'string' || !r.result.trim()) return
  st.last_summary = r.result.trim()
  const found = [...st.last_summary.matchAll(/^[\s>*`-]*SUPOSI[ÇC][ÃA]O:\s*(.+)$/gim)].map((x) => x[1].replace(/`+$/, '').trim().slice(0, 300))
  if (found.length) { st.assumptions = [...new Set([...(st.assumptions || []), ...found])].slice(0, 8); for (const a of found) log('engine', `suposição de quem escreve em "${st.title}": ${a}`, 'warn') }
  const wrong = /^[\s>*`-]*CONTRATO ERRADO:\s*(.+)$/im.exec(st.last_summary)
  st.contract_issue = wrong ? wrong[1].replace(/`+$/, '').trim().slice(0, 400) : null // vale a última resposta: alegação não repetida caduca
}
async function runStory(st, round = 1, previousReview = null, previousVisual = null) {
  const m = state.mission
  const stop = (reason) => { m.state = 'awaiting_operator'; m.reason = reason; st.state = 'blocked'; log('engine', `parada: ${reason}`, 'error'); return false }
  if (m.cost.usd > (state.settings.max_usd_per_mission || 60)) return stop('budget')
  st.round = round
  if (round === 1 && st.no_test_phase) { // correção de provas vermelhas: as provas já existem; direto para a implementação
    st.usd_start = m.cost.usd; setStep('test', 'skipped'); setStep('red', 'skipped'); st.base = await gitHead(state.project.dir)
    const now0 = await runTests(state.project); st.red_tests = now0.tests.filter((t) => t.status !== 'passed').map((t) => ({ name: t.name, status: 'failed', message: t.message || '' }))
  } else if (round === 1) {
    if (m.plan.needs_ui && state.settings.visual_gate) st.visual_before = await visualGate()
    if (!st.red_retry || !st.base) st.base = await gitHead(state.project.dir)
    st.usd_start = m.cost.usd
    setStep('test', 'running'); const rt = await makerCall(makerStep(st, 1, false), { role: 'prova', prompt: testPrompt(st, await contextPack(st)), tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'], skipPermissions: m.allow_commands, maxTurns: 20 }); remember(st, rt); await refreshProject(); setStep('test', 'done')
    setStep('red', 'running')
    const after = await runTests(state.project)
    const before = new Set(m.tests_before.tests.map((t) => t.name))
    const generic = after.runner !== 'vitest'
    st.red_tests = generic ? after.tests.filter((t) => t.status !== 'passed') : after.tests.filter((t) => !before.has(t.name) && t.status !== 'passed')
    const regress = generic ? [] : after.tests.filter((t) => before.has(t.name) && t.status !== 'passed')
    log('engine', `prova vermelha: ${st.red_tests.length} vermelha(s)${generic ? ' (runner genérico)' : `, ${regress.length} antiga(s) quebrada(s)`}`)
    if (regress.length > 0) { st.red_regress = regress.map((t) => ({ name: t.name, status: 'failed', message: (t.message || '').slice(0, 400) })); log('engine', `${regress.length} prova(s) antiga(s) quebraram na fase de prova (comum com portão de tipos ou lint: a prova nova cita o que ainda não existe); sigo para a implementação, que tem de deixar tudo verde`, 'warn') }
    if (st.red_tests.length === 0 && regress.length) setStep('red', 'done') // o arquivo de prova nem carrega (import do que não existe): conta como vermelho
    else if (st.red_tests.length === 0) {
      // Sem prova vermelha. (a) quem escreve já implementou junto com a prova (comum no Gemini): provas novas verdes + código alterado → segue para verificação e revisão;
      // (b) não escreveu prova que falha: repete a fase de prova uma vez com o motivo; (c) parte sem comportamento testável (config, docs): implementa sem prova vermelha e o revisor julga.
      const fresh = generic ? [] : after.tests.filter((t) => !before.has(t.name))
      const changed = (await gitDiff(state.project.dir, st.base)).trim()
      if (fresh.length && after.ok && changed) {
        const red = await redWithoutCode(st, changed, fresh)
        if (red === 'green' && !st.red_retry) { st.red_retry = true; setStep('red', 'failed'); log('engine', 'quem escreve implementou junto com a prova, e as provas novas passam MESMO sem o código novo (guardei o código de lado e rodei a suíte): não provam o comportamento. Repetindo a fase de prova uma vez', 'warn'); return runStory(st, 1, null, null) }
        st.early_impl = true; st.red_verified = red === 'red'; setStep('red', red === 'red' ? 'done' : 'skipped')
        log('engine', red === 'red' ? `quem escreve adiantou a implementação junto com a prova (${fresh.length} prova(s) nova(s)); conferi que elas ficam vermelhas sem o código novo (código guardado de lado, suíte rodada, código devolvido). Sigo para verificação e revisão` : `quem escreve adiantou a implementação junto com a prova (${fresh.length} prova(s) nova(s) já verdes) e não deu para conferir o vermelho sem o código; sigo para verificação e revisão, e o revisor julga`, 'warn')
      }
      else if (!st.red_retry) { st.red_retry = true; setStep('red', 'failed'); log('engine', 'nenhuma prova nova ficou vermelha; repetindo a fase de prova uma vez com o motivo', 'warn'); return runStory(st, 1, null, null) }
      else { st.no_red = true; setStep('red', 'skipped'); log('engine', 'sem prova vermelha na segunda tentativa (parte de configuração ou documentação?); implemento assim mesmo e o revisor julga', 'warn') }
    } else setStep('red', 'done')
  }
  // Escalada: só na 3ª rodada em diante E quando sobrou problema grave (achado high do revisor ou prova vermelha). Pedido de cobertura/estilo continua no maker barato.
  const grave = (previousReview?.findings || []).some((f) => f.severity === 'high') || (st.tests_after && !st.tests_after.ok)
  const who = makerStep(st, round, grave), escalate = who.step > 0
  if (escalate) log('engine', `rodada ${round}: ${st.fix_of ? 'parte de correção' : 'problema grave persiste'}; maker sobe para ${who.model} (esforço ${who.effort}, degrau ${who.step + 1} de ${makerLadder().length})`)
  if (st.early_impl && round === 1) setStep('fix', 'skipped', { round })
  else { setStep('fix', 'running', { round }); const rf = await makerCall(who, { role: 'implementação', prompt: fixPrompt(st, round, previousReview, previousVisual, await contextPack(st)), tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'], skipPermissions: m.allow_commands, maxTurns: escalate ? 20 : 30 }); remember(st, rf); await refreshProject(); setStep('fix', 'done', { round }) }
  setStep('tests', 'running'); st.tests_after = await runTests(state.project); st.diff = await gitDiff(state.project.dir, st.base)
  { const head = await gitHead(state.project.dir); if (st.base && head && head !== st.base && !st.maker_committed) { st.maker_committed = true; log('engine', 'quem escreve fez commit por conta própria, contra a instrução; o trabalho continua visível porque o diff da parte é contado desde o começo dela. O commit dele fica; o motor não commita de novo o que já entrou', 'warn') } }
  log('engine', `provas depois: ${st.tests_after.total} no total, ${st.tests_after.failed} vermelha(s)`); setStep('tests', st.tests_after.ok ? 'done' : 'failed')
  if (st.tests_after.timeout) { log('engine', 'a suíte de provas estourou o tempo limite (5 min) e foi interrompida: isso não é prova vermelha. Paro a parte sem gastar rodadas; veja se alguma prova ficou pendurada (processo, servidor, espera sem fim)', 'error'); return stop('tests_timeout') }
  if (!st.diff.trim()) { setStep('checker', 'skipped'); return stop('no_changes') }
  if (!st.tests_after.ok) {
    const spentNow = m.cost.usd - (st.usd_start || 0)
    const redNow = st.tests_after.tests.filter((t) => t.status !== 'passed').map((t) => t.name).sort().join('|')
    if (st.contract_issue && round >= 2) { log('engine', `quem escreve diz que o contrato da parte está errado: ${st.contract_issue}. Paro de gastar rodadas; a parte volta ao planejador com esse motivo`, 'warn'); return stop('contract_wrong') }
    const stuck = round >= 5 && st.last_red === redNow; st.last_red = redNow
    if (stuck) log('engine', 'as mesmas provas seguem vermelhas depois de duas rodadas no modelo mais forte: impasse (provável conflito no plano); paro de gastar rodadas nesta parte', 'warn')
    if (!stuck && round < MAX_ROUNDS && spentNow <= (state.settings.max_usd_per_story || 4)) {
      st.red_tests = st.tests_after.tests.filter((t) => t.status !== 'passed').map((t) => ({ name: t.name, status: 'failed', message: t.message || (st.tests_after.output || '').slice(-300) }))
      log('engine', `provas vermelhas depois da implementação; rodada ${round + 1} com o erro`, 'warn'); return runStory(st, round + 1, previousReview, null)
    }
    return stop('tests_red')
  }
  if (m.plan.needs_ui && state.settings.visual_gate) {
    setStep('visual', 'running'); st.visual = newFindings(await visualGate(), st.visual_before)
    if (!st.visual.available) { setStep('visual', 'skipped'); log('engine', 'portão visual indisponível (Impeccable não encontrado)') }
    else {
      log('engine', `portão visual: ${st.visual.findings.length} achado(s) novo(s)${st.visual.pre_existing ? ` (${st.visual.pre_existing} já existiam antes desta parte)` : ''}`)
      for (const f of st.visual.findings.slice(0, 12)) log('impeccable', `${f.file}${f.line ? ':' + f.line : ''} [${f.rule}] ${f.message}`, 'text')
      // um único retoque visual por story: achado que sobrevive ao retoque vira aviso, não loop
      if (st.visual.findings.length && !st.visual_reworked && (m.cost.usd - (st.usd_start || 0)) <= (state.settings.max_usd_per_story || 4)) { st.visual_reworked = true; setStep('visual', 'failed'); log('engine', 'rodada de retoque visual'); return runStory(st, round + 1, null, st.visual.findings) }
      setStep('visual', st.visual.findings.length ? 'warn' : 'done')
    }
  }
  setStep('checker', 'running'); st.review = await checker(st.diff, st.tests_after, st); setStep('checker', st.review ? (st.review.verdict === 'approve' ? 'done' : 'failed') : 'failed')
  if (st.review?.verdict === 'approve') return true
  const spent = m.cost.usd - (st.usd_start || 0), budget = state.settings.max_usd_per_story || 4
  if (st.review && round < MAX_ROUNDS && spent > budget) log('engine', `orçamento da parte estourado (US$ ${spent.toFixed(2)} > ${budget}); sem novas rodadas`, 'warn')
  if (st.review && round < MAX_ROUNDS && spent <= budget) { log('engine', `revisor pediu mudanças; rodada ${round + 1} automática`); return runStory(st, round + 1, st.review, null) }
  if (st.review && state.settings.autonomy !== 'ask' && st.tests_after.ok && !(st.review.findings || []).some((f) => f.severity === 'high')) {
    st.auto_accepted = true; log('engine', 'autonomia: 6 rodadas, provas verdes e nenhum achado grave; aceita e segue (o pedido do revisor fica registrado na aba Revisão)', 'warn'); return true
  }
  return stop(st.review ? 'review_changes' : 'review_failed')
}

function finish() {
  const m = state.mission
  m.finished_at = now()
  const entry = { id: m.id, project: state.project.dir, request: m.request, title: m.plan?.title || m.request, state: m.state, reason: m.reason, usd: m.cost.usd, calls: m.cost.calls, stories: m.stories.length, done: m.stories.filter((x) => x.state === 'done').length, finished_at: m.finished_at, resumable: ['paused', 'awaiting_plan', 'awaiting_operator'].includes(m.state) }
  const h = state.history.find((x) => x.id === m.id)
  if (h) Object.assign(h, entry); else state.history.unshift(entry)
  saveJson('history.json', state.history.slice(0, 50)).catch(() => {})
  persistMission().catch(() => {})
  journal({ type: 'mission', state: m.state, reason: m.reason }).catch(() => {})
  broadcast()
}

// commit das alterações que o usuário deixou pendentes (com a identidade git dele; se não houver, a da TL-ADE)
async function commitPending(dir, message = 'antes da TL-ADE: alterações pendentes do usuário') {
  await run('git', ['add', '-A', '--', '.'], { cwd: dir })
  let c = await run('git', ['commit', '-q', '-m', message, '--', '.'], { cwd: dir })
  if (c.code !== 0 && /user\.name|user\.email|identity/i.test(c.err)) c = await run('git', ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', message, '--', '.'], { cwd: dir })
  return c.code === 0 ? null : (c.err || c.out).trim().split(String.fromCharCode(10)).slice(-2).join(' ')
}
async function startMission(request, { commitFirst = false } = {}) {
  const p = state.project
  if (!p) return 'Escolha uma pasta primeiro.'
  let fresh = await discover(p.dir)
  if (fresh.error) return fresh.error
  if (!fresh.git) return 'A pasta precisa ser um repositório git: é assim que a ADE mostra e desfaz alterações. Use "Iniciar git nesta pasta".'
  if (fresh.dirty && commitFirst) { const err = await commitPending(fresh.dir); if (err) return `Não deu para commitar: ${err}`; fresh = await discover(fresh.dir); log('operador', 'commitou as alterações pendentes antes de começar') }
  if (fresh.dirty) return { error: 'A pasta tem alterações suas ainda não commitadas. A ADE precisa de um ponto de partida limpo para poder desfazer só o que ela mesma fizer.', code: 'dirty' }
  const s = state.settings
  if (vendorOf(s.roles.maker.family, s.roles.maker.model) === vendorOf(s.roles.checker.family, s.roles.checker.model)) return 'Quem escreve e quem revisa precisam ser de empresas diferentes. Ajuste em Modelos.'
  await ensureIgnore(fresh.dir); state.project = await discover(fresh.dir); state.log = []; state.phase = 'intent'
  if (state.mission?.id) rm(path.join(MISSIONS_DIR, `${state.mission.id}.json`), { force: true }).catch(() => {}) // a conversa anterior desta pasta fica só no histórico
  state.mission = {
    id: 'm-' + Date.now().toString(36), request, attachments: state.attachments.splice(0), state: 'planning', reason: null, current: null,
    allow_commands: !!s.allow_commands, roles: JSON.parse(JSON.stringify(s.roles)),
    plan: null, intent: null, stories: [], skills: { planner: [], maker: [], checker: [], research: [] }, research: null, steps: [], tests_before: null,
    cost: { usd: 0, calls: 0, turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, by_model: {} }, started_at: now(), finished_at: null,
  }
  journal({ type: 'mission_start', request }).catch(() => {})
  log('engine', `missão ${state.mission.id} em ${p.dir}: "${request}"`)
  guard(planMission)
  return null
}

async function decide(option, payload = {}) {
  const m = state.mission
  if (!m) return
  journal({ type: 'decision', option }).catch(() => {})
  if (m.state === 'awaiting_plan') {
    if (option === 'planner' || (m.reason === 'planner_choice' && option === 'start')) {
      const pick = payload.choice === 'recommended' || (option === 'planner' && payload.choice !== 'configured') ? 'recommended' : 'configured'
      m.planner = pick === 'recommended' ? { ...m.planner_options.recommended, source: 'recomendado' } : { ...m.planner_options.configured, source: 'configurado' }
      log('operador', `planejar com ${m.planner.model} (${m.planner.effort}, ${m.planner.source})`); return continuePlanning()
    }
    if (option === 'start' && m.reason === 'questions') { m.answers = (m.plan.questions || []).map((q) => ({ id: q.id, question: q.question, answer: q.options?.[0]?.label || 'não sei' })); log('operador', 'seguiu com as recomendações'); return continuePlanning() }
    if (option === 'start') { log('operador', 'aprovou o plano'); return m.program ? runProgram() : runStories() }
    if ((option === 'answer' || option === 'start') && m.planner_options && !m.planner && payload.planner) { const pick = payload.planner === 'recommended' ? 'recommended' : 'configured'; m.planner = { ...m.planner_options[pick], source: pick === 'recommended' ? 'recomendado' : 'configurado' }; log('operador', `planejar com ${m.planner.model} (${m.planner.effort}, ${m.planner.source})`) }
    if (option === 'answer') {
      m.answers = payload.answers?.length ? payload.answers : [{ id: 'livre', question: 'resposta livre', answer: payload.text || '' }]
      log('operador', `respondeu: ${m.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}`)
      return continuePlanning()
    }
    if (option === 'revise' && payload.text?.trim()) { m.plan_feedback = [...(m.plan_feedback || []), payload.text.trim()]; m.user_feedback = (m.user_feedback || 0) + 1; m.split_tried = false; log('operador', `pediu mudanças no plano: ${payload.text.trim()}`); if (m.program && !m.epic) { m.program = null; return makeProgram() } return makePlan() }
    if (option === 'discard') { m.state = 'discarded'; log('operador', 'descartou o plano'); return finish() }
    return
  }
  if (m.state === 'paused' && option === 'discard') { await gitDiscard(state.project.dir); await refreshProject(); m.state = 'discarded'; log('operador', 'descartou a missão pausada; arquivos restaurados'); return finish() }
  if (m.state !== 'awaiting_operator') return
  const st = story()
  if (option === 'accept') { if (st) { st.state = 'done'; await gitCommit(state.project.dir, `ade: ${st.title.slice(0, 72)} (aceita pelo operador)`); await refreshProject() } log('operador', 'aceitou como está'); m.reason = null; return runStories() }
  if (option === 'retry') {
    if (!st) return
    log('operador', 'pediu mais uma rodada'); m.state = 'running'; st.state = 'running'; broadcast()
    const ok = await runStory(st, (st.round || 1) + 1, st.review, st.visual?.findings)
    if (!ok) return finish()
    await gitCommit(state.project.dir, `ade: ${st.title.slice(0, 72)}`); await refreshProject(); st.state = 'done'; return runStories()
  }
  if (option === 'skip') { if (st) { st.state = 'skipped'; await gitDiscard(state.project.dir); await refreshProject() } log('operador', 'pulou a story'); return runStories() }
  if (option === 'discard') { await gitDiscard(state.project.dir); await refreshProject(); m.state = 'discarded'; log('operador', 'descartou; arquivos restaurados'); return finish() }
}

// ---------- HTTP ----------
async function body(req) { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {} }
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
const busyOf = (e) => !!(e?.mission && ['running', 'planning'].includes(e.mission.state))
// engine alvo do pedido: `dir` no corpo/query → esse; senão o ativo
async function targetEngine(req, url, b) { const dir = b?.dir || url.searchParams.get('dir'); return dir ? engineFor(dir) : activeEngine() }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const origin = req.headers.origin, host = String(req.headers.host || '').split(':')[0]
  const localOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  if (!localOrigin || !['localhost', '127.0.0.1'].includes(host)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'origem não permitida' })) } // página de fora ou DNS rebinding
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(pub())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (url.pathname === '/api/state') return json(res, 200, pub())
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const patch = await body(req)
      state.settings = { ...state.settings, ...patch, roles: { ...state.settings.roles, ...(patch.roles || {}) }, skills: { ...state.settings.skills, ...(patch.skills || {}) } }
      await saveJson('settings.json', state.settings); broadcast(); return json(res, 200, state.settings)
    }
    if (url.pathname === '/api/project' && req.method === 'POST') {
      const { dir } = await body(req)
      if (!String(dir || '').trim()) return json(res, 400, { error: 'Informe o caminho da pasta.' })
      const target = path.resolve(String(dir).trim().replace(/^~/, HOME))
      if (!(await exists(target))) await mkdir(target, { recursive: true })
      const info = await discover(target)
      if (info.error) return json(res, 400, info)
      // cada pasta é um engine próprio; trocar de pasta não mata a missão da outra (ela continua rodando ao fundo)
      const e = engineFor(info.dir); e.project = info; activeDir = path.resolve(info.dir); await saveRecent(info.dir); await persistEngines(); broadcast(); return json(res, 200, info)
    }
    if (url.pathname === '/api/select' && req.method === 'POST') { const { dir } = await body(req); const e = dir && engines.get(path.resolve(dir)); if (!e) return json(res, 404, { error: 'Projeto não aberto.' }); activeDir = path.resolve(dir); broadcast(); return json(res, 200, { ok: true }) }
    if (url.pathname === '/api/close' && req.method === 'POST') {
      // fecha a pasta no painel; missão pausada/esperando continua salva em .ade/missions e volta pelo histórico ("Continuar")
      const { dir } = await body(req); const key = dir && path.resolve(dir); const e = key && engines.get(key)
      if (!e) return json(res, 404, { error: 'Pasta não está aberta.' })
      if (busyOf(e)) return json(res, 409, { error: 'Essa pasta tem um pedido rodando. Pause ou espere terminar antes de fechar.' })
      if (e.mission && ['awaiting_plan', 'awaiting_operator', 'paused'].includes(e.mission.state)) { if (e.mission.state !== 'paused') { e.mission.state = 'paused'; e.mission.reason = null } await withEngine(e, () => persistMission().catch(() => {})) }
      engines.delete(key)
      if (activeDir === key) activeDir = [...engines.keys()].find((k) => engines.get(k).project) || null
      await persistEngines(); broadcast(); return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/pause' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e) return json(res, 400, { error: 'Sem projeto.' }); const err = await withEngine(e, pauseMission); return err ? json(res, 400, { error: err }) : json(res, 202, { ok: true }) }
    if (url.pathname === '/api/resume' && req.method === 'POST') {
      const { id, dir } = await body(req)
      let e = dir ? engines.get(path.resolve(dir)) : null
      if (!e && id) e = [...engines.values()].find((x) => x.mission?.id === id)
      if (!e?.mission) return json(res, 404, { error: 'Missão não encontrada (só missões pausadas neste servidor podem continuar).' })
      if (busyOf(e)) return json(res, 409, { error: 'Essa missão já está rodando.' })
      activeDir = path.resolve(e.project.dir); broadcast()
      withEngine(e, () => guard(resumeMission)); return json(res, 202, { ok: true })
    }
    if (url.pathname === '/api/project/git-init' && req.method === 'POST') {
      const e = activeEngine(); if (!e?.project) return json(res, 400, { error: 'Sem pasta.' })
      return withEngine(e, async () => {
        const d = state.project.dir
        await run('git', ['init', '-q'], { cwd: d }); await run('git', ['add', '-A'], { cwd: d })
        await run('git', ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'base: antes da TL-ADE', '--allow-empty'], { cwd: d })
        state.project = await discover(d); broadcast(); return json(res, 200, state.project)
      })
    }
    if (url.pathname === '/api/project/commit' && req.method === 'POST') {
      const b = await body(req); const e = await targetEngine(req, url, b); if (!e?.project?.git) return json(res, 400, { error: 'Sem repositório git.' })
      return withEngine(e, async () => { const err = await commitPending(state.project.dir, b.message || undefined); if (err) return json(res, 400, { error: err }); state.project = await discover(state.project.dir); log('operador', 'commitou as alterações pendentes'); broadcast(); return json(res, 200, state.project) })
    }
    if (url.pathname === '/api/pick' && req.method === 'POST') { const { kind } = await body(req); const cur = activeEngine()?.project?.dir; return json(res, 200, { paths: await pickNative(kind, cur ? path.dirname(cur) : HOME) }) }
    if (url.pathname === '/api/attach' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, { error: 'Escolha uma pasta primeiro.' }); try { return await withEngine(e, async () => json(res, 200, { added: await addAttachments(b), attachments: state.attachments })) } catch (err) { return json(res, 400, { error: err.message }) } }
    if (url.pathname === '/api/attach/remove' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e) return json(res, 400, {}); return withEngine(e, async () => { const i = state.attachments.findIndex((a) => a.name === b.name); if (i >= 0) { const [a] = state.attachments.splice(i, 1); await rm(path.join(state.project.dir, a.path), { force: true }); broadcast() } return json(res, 200, { attachments: state.attachments }) }) }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const b = await body(req); const request = b.request
      if (!request?.trim()) return json(res, 400, { error: 'Pedido vazio.' })
      const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, { error: 'Escolha uma pasta primeiro.' })
      if (busyOf(e)) return json(res, 409, { error: 'Já há uma missão rodando nesta pasta. Pause-a ou espere; em outra pasta pode rodar em paralelo.' })
      if (e.mission && ['awaiting_plan', 'awaiting_operator', 'paused'].includes(e.mission.state)) {
        if (!b.replace) return json(res, 409, { code: 'pending', error: 'A missão anterior desta pasta está pausada ou esperando você. Continue, descarte, ou guarde o que já foi feito e mande este pedido.' })
        await withEngine(e, async () => { const m = state.mission; await gitDiscard(state.project.dir); await refreshProject(); m.state = 'stopped'; m.reason = 'replaced'; log('operador', `guardou o feito (${m.stories.filter((x) => x.state === 'done').length} parte(s) commitada(s)) e mandou outro pedido; o resto desta missão foi arquivado`); finish() })
      }
      activeDir = path.resolve(e.project.dir)
      const err = await withEngine(e, () => startMission(request.trim(), { commitFirst: !!b.commit_first })); return err ? json(res, 400, typeof err === 'string' ? { error: err } : err) : json(res, 202, { ok: true })
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const b = await body(req); const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, { error: 'Escolha uma pasta primeiro.' })
      if (!b.text?.trim()) return json(res, 400, { error: 'Pergunta vazia.' })
      if (e.chat_busy) return json(res, 409, { error: 'Ainda estou respondendo a anterior.' })
      const family = ['claude', 'codex', 'agy'].includes(b.family) ? b.family : 'claude'
      const model = b.model || (family === 'claude' ? 'sonnet' : family === 'codex' ? 'gpt-5.6-sol' : 'gemini-3.8-flash')
      withEngine(e, () => chatTurn(e, b.text.trim(), { family, model, effort: EFFORTS.includes(b.effort) ? b.effort : 'medium' })).catch((err) => { e.chat_busy = false; log('engine', `conversa falhou: ${err.message}`, 'error') })
      return json(res, 202, { ok: true })
    }
    if (url.pathname === '/api/chat/clear' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, {}); e.chat = []; await saveChat(e.project.dir, []).catch(() => {}); broadcast(); return json(res, 200, { ok: true }) }
    if (url.pathname === '/api/decide' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e) return json(res, 400, {}); withEngine(e, () => guard(() => decide(b.option, { text: b.text, answers: b.answers, choice: b.choice, planner: b.planner }))); return json(res, 202, { ok: true }) }
    if (url.pathname === '/api/skill' && url.searchParams.get('id')) { const c = state.catalog.find((x) => x.id === url.searchParams.get('id')); return c ? json(res, 200, { id: c.id, body: c.body }) : json(res, 404, {}) }
    if (url.pathname === '/api/app' || url.pathname.startsWith('/api/app/')) {
      const e = (url.searchParams.get('dir') && engines.get(path.resolve(url.searchParams.get('dir')))) || activeEngine()
      if (!e?.project) { res.writeHead(404); return res.end('sem projeto') }
      if (url.pathname === '/api/app') { res.writeHead(302, { Location: '/api/app/' }); return res.end() }
      const rel = url.pathname === '/api/app/' ? 'index.html' : decodeURIComponent(url.pathname.slice(9))
      const file = path.join(e.project.dir, rel)
      if (!file.startsWith(e.project.dir) || rel.includes('node_modules')) { res.writeHead(403); return res.end() }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' }
      try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); return res.end(data) }
      catch { res.writeHead(404); return res.end('não encontrado') }
    }
    res.writeHead(404); res.end()
  } catch (e) { json(res, 500, { error: e.message }) }
}).listen(PORT, '127.0.0.1', async () => {
  state.recent = await loadJson('projects.json', [])
  state.history = await loadJson('history.json', [])
  const saved = await loadJson('settings.json', null)
  if (saved) state.settings = { ...DEFAULT_SETTINGS, ...saved, roles: { ...DEFAULT_SETTINGS.roles, ...(saved.roles || {}) }, skills: { ...DEFAULT_SETTINGS.skills, ...(saved.skills || {}) } }
  if (!state.settings.roles.intent) state.settings.roles.intent = DEFAULT_SETTINGS.roles.intent
  for (const [k, d] of Object.entries(DEFAULT_SETTINGS.roles)) {
    const r = state.settings.roles[k]; if (!r) { state.settings.roles[k] = d; continue }
    const mm = /^(gemini-[\d.]+-(?:flash|pro))-(high|medium|low)$/.exec(r.model || ''); if (mm) { r.model = mm[1]; r.effort = mm[2] }
    if (!EFFORTS.includes(r.effort)) r.effort = d.effort
  }
  await loadCatalog()
  await readQuota()
  await loadSavedMissions()
  if (!activeDir) { const first = G.recent[0] || path.join(ROOT, 'example'); const e0 = engineFor(first); if (!e0.project) e0.project = await discover(first); activeDir = path.resolve(first) }
  const e = engines.get(activeDir)
  console.log(`TL-ADE: http://127.0.0.1:${PORT}  projeto: ${e.project.dir}  skills no catálogo: ${G.catalog.length}  missões retomáveis: ${[...engines.values()].filter((x) => x.mission).length}`)
})
