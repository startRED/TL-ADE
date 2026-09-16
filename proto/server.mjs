// TL-ADE — demonstração (incompleta, mas real). Orquestra Claude Code, Codex e Antigravity (agy)
// sobre qualquer pasta escolhida pelo operador: pedido -> plano com stories -> skills automáticas ->
// prova vermelha -> implementação -> provas verdes -> portão visual -> revisão por outra família.
// Sem durabilidade de verdade (estado em memória; journal só registra). Esse é o slice 1.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, appendFile, rm, stat, access, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ADE_DIR = path.join(ROOT, '.ade')
const REVIEW_SCHEMA = path.join(ROOT, 'review.schema.json')
const RESEARCH_SCHEMA = path.join(ROOT, 'research.schema.json')
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
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', note: 'padrão para pesquisa' },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', note: '' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', note: 'rápido' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', note: 'o mais barato' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 via Google', note: 'conta como família Claude' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', note: 'quarta opinião' },
  ] },
}
const vendorOf = (family, model) => family === 'agy' && /^claude/.test(model) ? 'anthropic' : family === 'agy' && /^gpt/.test(model) ? 'openai' : family === 'claude' ? 'anthropic' : family === 'codex' ? 'openai' : 'google'

const DEFAULT_SETTINGS = {
  roles: {
    intent: { family: 'claude', model: 'sonnet' },
    planner: { family: 'claude', model: 'opus' },
    maker: { family: 'claude', model: 'sonnet' },
    checker: { family: 'codex', model: 'gpt-5.6-terra' },
    research: { family: 'agy', model: 'gemini-3.1-pro-high' },
  },
  allow_commands: true,
  research_enabled: true,
  visual_gate: true,
  fast_lane: true, // faixa rápida (ADR 0008 / E18): pedido curto de correção num projeto existente pula entrevista e plano no Opus
  max_usd_per_story: 4, // orçamento por parte (spec E4): estourou com provas verdes → aceita; sem provas verdes → para
  autonomy: 'auto', // auto: após 4 rodadas com provas verdes e sem achado grave do revisor, aceita e segue; ask: para e pergunta
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
function newEngine(project) { return { project, mission: null, log: [], live: null, attachments: [], phase: null, children: new Set() } }
function engineFor(dir) { const key = path.resolve(dir); if (!engines.has(key)) engines.set(key, newEngine(null)); return engines.get(key) }
function activeEngine() { if (!activeDir) return null; return engines.get(activeDir) || null }
function currentEngine() { return als.getStore() || activeEngine() || (activeDir = 'sem-projeto', engines.set('sem-projeto', newEngine(null)), engines.get('sem-projeto')) }
const withEngine = (e, fn) => als.run(e, fn)
const state = new Proxy({}, {
  get(_, k) { if (k in G) return G[k]; return currentEngine()[k] },
  set(_, k, v) { if (k in G) G[k] = v; else currentEngine()[k] = v; return true },
})

// ---------- anexos e diálogos do Explorer ----------
const ATTACH_DIR = '.ade-attachments'
async function pickNative(kind) {
  // Diálogo nativo do Explorer. O dono (form invisível, TopMost) precisa estar MOSTRADO: com um form nunca exibido o ShowDialog devolvia Cancel na hora, sem abrir nada.
  // Pasta: truque do OpenFileDialog (Explorer moderno, com "Nova pasta"); a pasta é o diretório do nome escolhido.
  const owner = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; Opacity = 0; ShowInTaskbar = $false; Width = 1; Height = 1; StartPosition = 'CenterScreen' }; $f.Show(); $f.Activate(); "
  const script = kind === 'folder'
    ? owner + "$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Escolha a pasta do projeto (entre nela e clique em Abrir; pode criar uma nova)'; $d.ValidateNames = $false; $d.CheckFileExists = $false; $d.CheckPathExists = $true; $d.FileName = 'Selecionar esta pasta'; $d.Filter = 'Pasta|*.pasta'; $r = $d.ShowDialog($f); $f.Close(); if ($r -eq 'OK') { [Console]::Out.Write([System.IO.Path]::GetDirectoryName($d.FileName)) }"
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
function engineView(e, dir, full) { return { dir, project: e.project, mission: e.mission, live: e.live, attachments: e.attachments, log: full ? e.log : undefined, busy: !!(e.mission && ['running', 'planning'].includes(e.mission.state)) } }
function pub() {
  const a = activeEngine() || newEngine(null)
  return {
    ...engineView(a, activeDir, true),
    engines: [...engines.entries()].filter(([, e]) => e.project).map(([dir, e]) => ({ ...engineView(e, dir, false), active: dir === activeDir })),
    history: G.history, recent: G.recent, settings: G.settings, registry: G.registry, quota: G.quota, catalog: G.catalog.map(({ body, ...c }) => c),
  }
}
function broadcast() { const data = `data: ${JSON.stringify(pub())}\n\n`; for (const res of clients) res.write(data) }
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
    const child = spawn(cmd, quoted, { cwd, shell: IS_WIN, env: { ...process.env, ...env }, windowsHide: true })
    if (eng) eng.children.add(child)
    let out = '', err = '', buf = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (!onLine) return
      buf += d
      const lines = buf.split(/\r?\n/); buf = lines.pop()
      for (const l of lines) if (l.trim()) onLine(l)
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); if (eng) eng.children.delete(child); if (onLine && buf.trim()) onLine(buf); if (eng?.mission?.pause_requested) return reject(PAUSE); resolve({ code, out, err }) })
    child.on('error', (e) => { clearTimeout(timer); if (eng) eng.children.delete(child); resolve({ code: -1, out, err: String(e) }) })
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end() } else child.stdin.end()
  })
}
const exists = (p) => access(p).then(() => true, () => false)
// mata a árvore inteira (shell:true no Windows: cmd.exe → claude/codex/node); só child.kill() deixaria o neto vivo
function killTree(child) { try { if (IS_WIN) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM') } catch {} }

// ---------- pausar / continuar / persistir ----------
const MISSIONS_DIR = path.join(ADE_DIR, 'missions')
async function persistMission() {
  const e = currentEngine(); const m = e.mission; if (!m || !e.project) return
  await mkdir(MISSIONS_DIR, { recursive: true })
  await writeFile(path.join(MISSIONS_DIR, `${m.id}.json`), JSON.stringify({ dir: e.project.dir, mission: m, log: e.log.slice(-300), saved_at: now() }))
}
// guard: toda cadeia do motor passa por aqui. PAUSE vira estado 'paused' (parte em andamento volta para a fila); outro erro vira parada.
async function guard(fn) {
  try { return await fn() } catch (err) {
    const m = state.mission; if (!m) return
    if (err === PAUSE) {
      m.pause_requested = false; m.state = 'paused'; m.reason = null
      if (m.current != null && m.stories[m.current] && m.stories[m.current].state !== 'done') { const st = m.stories[m.current]; Object.assign(st, { state: 'queued', round: 0, steps: [], red_tests: [], tests_after: null, diff: '', review: null, visual: null }); if (state.project) await gitDiscard(state.project.dir).catch(() => {}); await refreshProject().catch(() => {}) }
      state.live = null; log('operador', 'pausou; a parte em andamento volta do começo quando continuar')
      await persistMission().catch(() => {}); return finish()
    }
    m.state = 'awaiting_operator'; m.reason = 'engine_error'; log('engine', `erro do engine: ${err.message}`, 'error'); await persistMission().catch(() => {}); return finish()
  }
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
  state.project = await discover(fresh.dir); m.finished_at = null; log('operador', 'continuou a missão')
  if (!m.plan || !m.stories.length) { m.state = 'planning'; m.steps = []; return guard(planMission) }
  return guard(runStories)
}
async function loadSavedMissions() {
  let files = []; try { files = await readdir(MISSIONS_DIR) } catch { return }
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(path.join(MISSIONS_DIR, f), 'utf8')); const m = j.mission
      if (!['paused', 'awaiting_plan', 'awaiting_operator'].includes(m.state)) continue
      if (m.state !== 'paused') { m.state = 'paused'; m.reason = null } // estava esperando você quando o servidor caiu: continua do mesmo ponto ao retomar
      const e = engineFor(j.dir); e.project = await discover(j.dir); if (e.project.error) continue
      e.mission = m; e.log = j.log || []
    } catch {}
  }
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
    } catch { return { ok: false, total: 0, failed: 0, tests: [], runner: 'vitest', error: (r.err || r.out).slice(-600) } }
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
async function gitDiff(dir) {
  const a = await run('git', ['add', '-N', '--', '.'], { cwd: dir }) // ignorados pelo .gitignore ficam fora sozinhos; pathspec de exclusão aqui faz o git reclamar
  const d = await run('git', ['diff', '--', '.', ...DIFF_EXCLUDES], { cwd: dir })
  if (a.code !== 0 || d.code !== 0) throw new Error(`git diff falhou: ${(a.err || d.err).trim().split('\n')[0]}`)
  return d.out
}
async function gitDiscard(dir) { await run('git', ['reset', '-q', '--', '.'], { cwd: dir }); await run('git', ['checkout', '--', '.'], { cwd: dir }); await run('git', ['clean', '-fd', '.'], { cwd: dir }) }
async function gitCommit(dir, msg) {
  await run('git', ['add', '-A', '--', '.'], { cwd: dir })
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
async function claudeCall({ role, prompt, model, tools, skipPermissions, schema, maxTurns = 40 }) {
  const m = state.mission, dir = state.project.dir
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--max-turns', String(maxTurns), '--model', model]
  // shell:true no Windows concatena argumentos: aspas internas precisam de escape estilo MSVC.
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  if (skipPermissions) args.push('--dangerously-skip-permissions')
  else { args.push('--permission-mode', 'acceptEdits'); if (tools) args.push('--tools', ...tools) }
  log('engine', `claude (${role}, ${model})${schema ? ' com saída estruturada' : ''}`)
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
    journal({ type: 'model_call', family: 'claude', role, model, story: m.current, turns: result.num_turns || 0, usd: result.total_cost_usd || 0, tokens_in: result.usage?.input_tokens || 0, cache_write: result.usage?.cache_creation_input_tokens || 0, cache_read: result.usage?.cache_read_input_tokens || 0, tokens_out: result.usage?.output_tokens || 0, prompt_chars: prompt.length, wall_ms: Date.now() - t0, max_turns: maxTurns }).catch(() => {})
    readQuota().then(broadcastSoon)
    if (result.is_error) log('engine', `claude reportou erro: ${result.result || result.subtype}`, 'error')
  } else log('engine', `claude saiu com código ${r.code}: ${(r.err || r.out).slice(0, 300)}`, 'error')
  return result
}

// ---------- pesquisa: agy ----------
async function research(questions) {
  const m = state.mission, dir = state.project.dir
  const { model } = state.settings.roles.research
  const prompt = `Responda em português, com fontes verificáveis (URL), às perguntas abaixo, no formato JSON exigido. Seja curto e factual; se não souber, diga desconhecido.\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
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

// ---------- revisão: Codex ----------
async function checker(diff, tests, st) {
  const m = state.mission, dir = state.project.dir
  const { model } = state.settings.roles.checker
  const prompt = [
    'Você é o revisor. Outra IA (Claude) fez a alteração abaixo no projeto. Não escreva código; só avalie.',
    'Regras: toda mudança de comportamento vem com uma prova (teste) que falha antes e passa depois; sem mudanças fora do escopo; sem quebrar acessibilidade; sem segredos em código; interface sem cara de template (cores saturadas, gradiente roxo, três cards iguais).',
    `Pedido do usuário: ${m.request}`, `Story em revisão: ${st.title}. Critérios de aceite: ${(st.acceptance || []).join('; ')}`,
    `Skills que o autor tinha de seguir: ${(m.skills.maker || []).map((s) => s.id).join(', ') || 'nenhuma'}.`,
    `O harness JÁ RODOU as provas fora da sandbox: ${tests.failed} falharam de ${tests.total} (runner: ${tests.runner}); a prova nova falhou antes da implementação e passou depois. Não tente rodar provas nem instalar nada (sua sandbox é somente leitura e isso vai falhar); avalie o código e o diff. Arquivos de lock (package-lock.json) e dependências não fazem parte do escopo revisado.`,
    tests.tests?.length ? `Provas que rodaram e passaram (nomes): ${tests.tests.filter((t) => t.status === 'passed').map((t) => t.name).slice(0, 60).join(' | ')}. Um critério coberto por uma dessas provas está provado; não peça prova extra para ele.` : '',
    'Critérios de aceite sobre detalhe decorativo (borda lateral colorida, gradiente, cor exata) cedem ao portão visual (Impeccable): não peça mudanças para reintroduzir isso; avalie a intenção do critério.',
    'Severidade: high = comportamento errado, critério de aceite não atendido, segurança, acessibilidade quebrada, mudança fora do escopo. Cobertura de prova além do necessário, estilo de código, nomes e refatorações são low e NÃO impedem approve: registre como achado low e aprove.',
    'Responda em português no formato JSON exigido. verdict = "approve" só se não houver achado high.',
    '--- DIFF ---', diff.slice(0, 60000),
  ].join('\n') + skillsBlock(m.skills.checker || [])
  // Receita de chamada curta (architecture.md E16): sem config, regras e skills do usuário; sessão efêmera.
  // skills.max_context_tokens=0 é rejeitado ("expected a nonzero usize"); 1 remove todas as skills do usuário. Sem --ephemeral: a sessão gravada em ~/.codex/sessions é de onde a cota é lida.
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-C', dir, '-m', model, '--output-schema', REVIEW_SCHEMA, '-']
  log('engine', `codex (revisão, ${model})`)
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
  if (!review) log('engine', `codex falhou (código ${r.code}): ${(lastMessage || r.err || r.out).trim().slice(0, 300)}`, 'error')
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
    summary: { type: 'string' }, complexity: { type: 'string', enum: ['trivial', 'bounded', 'feature', 'subsystem'] },
    domains: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
    needs_ui: { type: 'boolean' }, needs_backend: { type: 'boolean' },
    research_questions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, question: { type: 'string' }, why: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, hint: { type: 'string' } }, required: ['label', 'hint'] } }, allow_other: { type: 'boolean' } }, required: ['id', 'question', 'why', 'options', 'allow_other'] } },
    skills: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['planner', 'maker', 'checker', 'research'].map((r) => [r, { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } }])), required: ['planner', 'maker', 'checker', 'research'] },
  },
  required: ['summary', 'complexity', 'domains', 'keywords', 'needs_ui', 'needs_backend', 'research_questions', 'questions', 'skills'],
}
function intentPrompt() {
  const p = state.project, s = state.settings
  return [
    'Você é a primeira IA da TL-ADE: entende o pedido do usuário e decide o que cada papel precisa. Responda em português no formato JSON exigido. Não explore o projeto além de 2 leituras; o planejador explora depois.',
    `Pedido: ${state.mission.request}`,
    attachBlock(state.mission.attachments),
    `Projeto: ${p.name}; ${p.files} itens na raiz; linguagem: ${p.language || 'nenhuma'}; runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}; index.html: ${p.has_index ? 'sim' : 'não'}.`,
    `Papéis e modelos: planejador ${s.roles.planner.model} (monta stories); maker ${s.roles.maker.model} (escreve provas e código); revisor ${s.roles.checker.model} (Codex, lê o diff, não escreve); pesquisador ${s.roles.research.model} (Google, só fatos externos).`,
    'Se há anexos, abra-os antes de decidir (uma imagem de referência muda domínios, skills e perguntas).',
    'Escolha, para cada papel, as skills do catálogo abaixo que elevam a qualidade daquele papel neste pedido (ids exatos; até 4 para o maker, até 3 para os outros; lista vazia é válida). Regras fixas: se há interface ou design, o maker recebe design-taste-frontend e impeccable (pode acrescentar frontend-design e accessibility); backend/API recebe backend-patterns e api-design; banco recebe postgres-patterns; o revisor recebe skills de revisão/segurança, não de estilo; o pesquisador raramente precisa de skill.',
    '- summary: 2 frases do que será entregue e das escolhas feitas por você quando o pedido é vago.',
    '- complexity, domains (subconjunto de frontend, design, backend, api, database, testing, python, security, a11y, docs, devops), keywords (5 a 12, pt e en), needs_ui, needs_backend.',
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
function planPrompt() {
  const p = state.project, m = state.mission
  return [
    'Você é o Intent Compiler da TL-ADE. Transforme o pedido do usuário em um plano executável por outra IA, em português, no formato JSON exigido.',
    `Pedido: ${state.mission.request}`,
    attachBlock(m.attachments),
    `Entendimento prévio (outra IA): ${state.mission.intent?.summary || ''} Domínios: ${(state.mission.intent?.domains || []).join(', ')}.`,
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
    '- stories: 1 a 6 stories pequenas e independentes, em ordem de execução. Cada uma: id (s1, s2…), title, request (instrução completa e autossuficiente para a IA que vai implementar, incluindo o estilo visual quando houver interface), acceptance (2 a 4 critérios verificáveis), test_hint (como provar).',
    p.runner === 'none' ? '- Não há runner de provas: a primeira story deve incluir criar o mínimo para rodar provas (JS: package.json + vitest; Python: pytest).' : '',
    '- Se o pedido é visual e não há index.html, uma story deve entregar index.html na raiz funcionando como arquivos estáticos (ES modules, sem build), para abrir no navegador.',
    'Pedidos simples viram 1 ou 2 stories. Não invente escopo além do pedido. questions: normalmente vazio (a entrevista já aconteceu).',
    m.plan_feedback?.length ? `PLANO ANTERIOR (para revisar, não para repetir):\n${JSON.stringify({ title: m.plan.title, summary: m.plan.summary, stories: m.stories.map((s) => ({ id: s.id, title: s.title, request: s.request })) })}` : '',
    m.plan_feedback?.length ? `O usuário pediu estas mudanças no plano, em ordem: ${m.plan_feedback.map((f, i) => `(${i + 1}) ${f}`).join(' ')} Aplique-as e mantenha o resto.` : '',
  ].filter(Boolean).join('\n') + skillsBlock(state.mission.skills.planner || [])
}
const PLAN_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, summary: { type: 'string' }, explanation: { type: 'string' }, complexity: { type: 'string', enum: ['trivial', 'bounded', 'feature', 'subsystem'] },
    domains: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
    needs_ui: { type: 'boolean' }, needs_backend: { type: 'boolean' },
    research_questions: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
    assets_style: { type: 'string' },
    assets: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, prompt: { type: 'string' }, purpose: { type: 'string' } }, required: ['file', 'prompt', 'purpose'] } },
    stories: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string' }, request: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, test_hint: { type: 'string' } }, required: ['id', 'title', 'request', 'acceptance', 'test_hint'] } },
  },
  required: ['title', 'summary', 'explanation', 'complexity', 'domains', 'keywords', 'needs_ui', 'needs_backend', 'research_questions', 'questions', 'assets_style', 'assets', 'stories'],
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
  if (st.last_summary) parts.push(`Resumo da sessão anterior desta parte: ${st.last_summary.slice(0, 1200)}`)
  return parts.join('\n')
}

// ---------- prompts do maker ----------
function common(st) {
  const p = state.project, m = state.mission
  return [
    `Projeto: ${p.name} (${p.language || 'linguagem a definir'}); runner de provas: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}.`,
    `Objetivo da missão: ${m.plan.title}. ${m.plan.summary}`,
    `Story atual: ${st.title}. Instrução: ${st.request}`,
    attachBlock(m.attachments),
    `Critérios de aceite: ${(st.acceptance || []).map((a, i) => `(${i + 1}) ${a}`).join(' ')}`,
    'Trabalhe só dentro do diretório atual; não suba para diretórios acima. Leia antes de escrever.',
    m.allow_commands ? 'Você pode rodar comandos (instalar dependências, inicializar projeto). Não rode servidores que fiquem abertos; não use git.' : 'Você só tem ferramentas de leitura e edição; o harness roda as provas.',
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
    `FASE 1 de 2: escreva APENAS as provas novas (testes automatizados) desta story: uma função de teste por critério de aceite, todas no mesmo arquivo, com nomes que digam o critério. Todas devem FALHAR (ou nem carregar) no código atual, porque o comportamento ainda não existe. Dica de prova: ${st.test_hint}. Não implemente o comportamento ainda.`,
    pack, 'Ao terminar, escreva uma frase com o nome do arquivo de prova e os nomes das provas novas.'].filter(Boolean).join('\n')
}
function fixPrompt(st, round, review, visual, pack) {
  const red = st.red_tests.map((t) => `- ${t.name}: ${t.message}`).join('\n')
  const base = [`Pedido original do usuário: ${state.mission.request}`, ...common(st), pack,
    `FASE 2 de 2: a prova nova está vermelha, como esperado:\n${red}`,
    'Agora implemente o necessário para a prova passar e os critérios de aceite valerem. Não modifique a prova. Não toque em nada fora do escopo da story. Seja direto: você tem no máximo 30 ações; não investigue ferramentas do harness, não reescreva provas antigas, não amplie o escopo.',
    'Ao terminar, escreva uma frase dizendo o que mudou.']
  if (round > 1 && review) { base.push(`Rodada ${round}. O revisor (outra IA) pediu mudanças: ${review.summary}`); for (const f of review.findings) base.push(`- [${f.severity}] ${f.file}: ${f.problem} Correção sugerida: ${f.fix}`) }
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
  return { complexity: 'trivial', summary: request, domains: [...domains], keywords: [], needs_ui: ui, needs_backend: be, research_questions: [], questions: [], skills: { planner: [], maker: [], checker: [], research: [] } }
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
  const ri = await claudeCall({ role: 'entender', prompt: intentPrompt(), model: state.settings.roles.intent.model, tools: ['Read', 'Glob'], schema: INTENT_JSON_SCHEMA, maxTurns: 4 })
  const intent = ri?.structured_output
  if (!intent) { setStep('intent', 'failed'); m.state = 'awaiting_operator'; m.reason = 'plan_failed'; log('engine', 'o entendimento não veio no formato esperado', 'error'); return finish() }
  m.intent = intent
  m.skills = selectSkills(intent)
  setStep('intent', 'done')
  log('engine', `entendido: ${intent.complexity} · ${intent.domains.join(', ')} · skills — planejador: ${m.skills.planner.map((s) => s.id).join(', ') || 'nenhuma'}; maker: ${m.skills.maker.map((s) => s.id).join(', ') || 'nenhuma'}; revisor: ${m.skills.checker.map((s) => s.id).join(', ') || 'nenhuma'}; pesquisa: ${m.skills.research.map((s) => s.id).join(', ') || 'nenhuma'}`)
  if (intent.questions?.length) { m.plan = { title: m.request.slice(0, 60), summary: intent.summary, complexity: intent.complexity, domains: intent.domains, needs_ui: intent.needs_ui, needs_backend: intent.needs_backend, questions: intent.questions, research_questions: [], stories: [] }; m.state = 'awaiting_plan'; m.reason = 'questions'; broadcast(); await persistMission().catch(() => {}); return }
  return continuePlanning()
}
async function continuePlanning() {
  const m = state.mission, intent = m.intent
  m.state = 'planning'; broadcast()
  if (intent.research_questions?.length && state.settings.research_enabled && !m.research) {
    setStep('research', 'running'); m.research = await research(intent.research_questions.slice(0, 3)); setStep('research', m.research ? 'done' : 'failed')
  }
  return makePlan()
}
async function makePlan() {
  const m = state.mission, intent = m.intent
  m.state = 'planning'; setStep('plan', 'running')
  const r = await claudeCall({ role: 'plano', prompt: planPrompt(), model: state.settings.roles.planner.model, tools: ['Read', 'Glob', 'Grep'], schema: PLAN_JSON_SCHEMA, maxTurns: 10 })
  const plan = r?.structured_output
  if (!plan?.stories?.length) { setStep('plan', 'failed'); m.state = 'awaiting_operator'; m.reason = 'plan_failed'; log('engine', 'o plano não veio no formato esperado', 'error'); return finish() }
  m.plan = { ...plan, needs_ui: plan.needs_ui || intent.needs_ui, needs_backend: plan.needs_backend || intent.needs_backend, domains: [...new Set([...(intent.domains || []), ...(plan.domains || [])])] }
  m.stories = plan.stories.map((s) => ({ ...s, state: 'queued', steps: [], round: 0, red_tests: [], tests_after: null, diff: '', review: null, visual: null }))
  setStep('plan', 'done')
  log('engine', `plano: ${plan.title} · ${m.plan.complexity} · ${m.stories.length} story(s)`)
  if (plan.questions?.length) { m.state = 'awaiting_plan'; m.reason = 'questions'; broadcast(); return }
  // depois de um pedido de mudança o usuário sempre confere de novo
  if (m.plan_feedback?.length || m.stories.length > 2 || m.plan.complexity === 'subsystem') { m.state = 'awaiting_plan'; m.reason = 'approve_plan'; broadcast(); await persistMission().catch(() => {}); return }
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
      m.current = i; st.state = 'running'; broadcast()
      const ok = await runStory(st)
      if (!ok) return finish()
      await gitCommit(state.project.dir, `ade: ${st.title.slice(0, 72)}`)
      await refreshProject()
      log('engine', `commit feito: ${st.title}`)
      st.state = 'done'; broadcast(); await persistMission().catch(() => {})
    }
    m.state = 'complete'; m.reason = null; m.current = null
    log('engine', 'missão pronta: todas as stories provadas, revisadas e commitadas')
  } catch (e) { if (e === PAUSE) throw e; m.state = 'awaiting_operator'; m.reason = 'engine_error'; log('engine', `erro do engine: ${e.message}`, 'error') }
  return finish()
}

function remember(st, r) { if (!r) return; st.files = [...new Set([...(st.files || []), ...(r.touched || [])])]; if (typeof r.result === 'string' && r.result.trim()) st.last_summary = r.result.trim() }
async function runStory(st, round = 1, previousReview = null, previousVisual = null) {
  const m = state.mission
  const stop = (reason) => { m.state = 'awaiting_operator'; m.reason = reason; st.state = 'blocked'; log('engine', `parada: ${reason}`, 'error'); return false }
  st.round = round
  if (round === 1) {
    if (m.plan.needs_ui && state.settings.visual_gate) st.visual_before = await visualGate()
    st.usd_start = m.cost.usd
    setStep('test', 'running'); const rt = await claudeCall({ role: 'prova', prompt: testPrompt(st, await contextPack(st)), model: state.settings.roles.maker.model, tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'], skipPermissions: m.allow_commands, maxTurns: 20 }); remember(st, rt); await refreshProject(); setStep('test', 'done')
    setStep('red', 'running')
    const after = await runTests(state.project)
    const before = new Set(m.tests_before.tests.map((t) => t.name))
    const generic = after.runner !== 'vitest'
    st.red_tests = generic ? after.tests.filter((t) => t.status !== 'passed') : after.tests.filter((t) => !before.has(t.name) && t.status !== 'passed')
    const regress = generic ? [] : after.tests.filter((t) => before.has(t.name) && t.status !== 'passed')
    log('engine', `prova vermelha: ${st.red_tests.length} vermelha(s)${generic ? ' (runner genérico)' : `, ${regress.length} antiga(s) quebrada(s)`}`)
    if (st.red_tests.length === 0 || regress.length > 0) { setStep('red', 'failed'); st.tests_after = after; st.diff = await gitDiff(state.project.dir); return stop(regress.length ? 'tests_red' : 'no_red_test') }
    setStep('red', 'done')
  }
  // Escalada: só na 3ª rodada em diante E quando sobrou problema grave (achado high do revisor ou prova vermelha). Pedido de cobertura/estilo continua no maker barato.
  const grave = (previousReview?.findings || []).some((f) => f.severity === 'high') || (st.tests_after && !st.tests_after.ok)
  const escalate = round >= 3 && grave && state.settings.roles.planner.model !== state.settings.roles.maker.model
  const makerModel = escalate ? state.settings.roles.planner.model : state.settings.roles.maker.model
  if (escalate) log('engine', `rodada ${round}: problema grave persiste; maker sobe para ${makerModel} (teto 20 ações)`)
  setStep('fix', 'running', { round }); const rf = await claudeCall({ role: 'implementação', prompt: fixPrompt(st, round, previousReview, previousVisual, await contextPack(st)), model: makerModel, tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'], skipPermissions: m.allow_commands, maxTurns: escalate ? 20 : 30 }); remember(st, rf); await refreshProject(); setStep('fix', 'done', { round })
  setStep('tests', 'running'); st.tests_after = await runTests(state.project); st.diff = await gitDiff(state.project.dir)
  log('engine', `provas depois: ${st.tests_after.total} no total, ${st.tests_after.failed} vermelha(s)`); setStep('tests', st.tests_after.ok ? 'done' : 'failed')
  if (!st.diff.trim()) { setStep('checker', 'skipped'); return stop('no_changes') }
  if (!st.tests_after.ok) {
    const spentNow = m.cost.usd - (st.usd_start || 0)
    if (round < 4 && spentNow <= (state.settings.max_usd_per_story || 4)) {
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
  if (st.review && round < 4 && spent > budget) log('engine', `orçamento da parte estourado (US$ ${spent.toFixed(2)} > ${budget}); sem novas rodadas`, 'warn')
  if (st.review && round < 4 && spent <= budget) { log('engine', `revisor pediu mudanças; rodada ${round + 1} automática`); return runStory(st, round + 1, st.review, null) }
  if (st.review && state.settings.autonomy !== 'ask' && st.tests_after.ok && !(st.review.findings || []).some((f) => f.severity === 'high')) {
    st.auto_accepted = true; log('engine', 'autonomia: 4 rodadas, provas verdes e nenhum achado grave; aceita e segue (o pedido do revisor fica registrado na aba Revisão)', 'warn'); return true
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
  // concluída/descartada: apaga o arquivo de retomada; senão grava (sem correr com o rm)
  if (['complete', 'discarded'].includes(m.state)) rm(path.join(MISSIONS_DIR, `${m.id}.json`), { force: true }).catch(() => {})
  else persistMission().catch(() => {})
  journal({ type: 'mission', state: m.state, reason: m.reason }).catch(() => {})
  broadcast()
}

async function startMission(request) {
  const p = state.project
  if (!p) return 'Escolha uma pasta primeiro.'
  const fresh = await discover(p.dir)
  if (fresh.error) return fresh.error
  if (!fresh.git) return 'A pasta precisa ser um repositório git: é assim que a ADE mostra e desfaz alterações. Use "Iniciar git nesta pasta".'
  if (fresh.dirty) return 'A pasta tem alterações não commitadas. Commite ou descarte antes, para a ADE poder desfazer só o que ela mesma fizer.'
  const s = state.settings
  if (vendorOf(s.roles.maker.family, s.roles.maker.model) === vendorOf(s.roles.checker.family, s.roles.checker.model)) return 'Quem escreve e quem revisa precisam ser de empresas diferentes. Ajuste em Modelos.'
  await ensureIgnore(fresh.dir); state.project = await discover(fresh.dir); state.log = []; state.phase = 'intent'
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
    if (option === 'start' && m.reason === 'questions') { m.answers = (m.plan.questions || []).map((q) => ({ id: q.id, question: q.question, answer: q.options?.[0]?.label || 'não sei' })); log('operador', 'seguiu com as recomendações'); return continuePlanning() }
    if (option === 'start') { log('operador', 'aprovou o plano'); return runStories() }
    if (option === 'answer') {
      m.answers = payload.answers?.length ? payload.answers : [{ id: 'livre', question: 'resposta livre', answer: payload.text || '' }]
      log('operador', `respondeu: ${m.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}`)
      return continuePlanning()
    }
    if (option === 'revise' && payload.text?.trim()) { m.plan_feedback = [...(m.plan_feedback || []), payload.text.trim()]; log('operador', `pediu mudanças no plano: ${payload.text.trim()}`); return makePlan() }
    if (option === 'discard') { m.state = 'discarded'; log('operador', 'descartou o plano'); return finish() }
    return
  }
  if (m.state === 'paused' && option === 'discard') { await gitDiscard(state.project.dir); await refreshProject(); m.state = 'discarded'; log('operador', 'descartou a missão pausada; arquivos restaurados'); return finish() }
  if (m.state !== 'awaiting_operator') return
  const st = story()
  if (option === 'accept') { if (st) { st.state = 'done'; await gitCommit(state.project.dir, `ade: ${st.title.slice(0, 72)} (aceita pelo operador)`); await refreshProject() } log('operador', 'aceitou como está'); return runStories() }
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
  res.setHeader('Access-Control-Allow-Origin', '*')
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
      const e = engineFor(info.dir); e.project = info; activeDir = path.resolve(info.dir); await saveRecent(info.dir); broadcast(); return json(res, 200, info)
    }
    if (url.pathname === '/api/select' && req.method === 'POST') { const { dir } = await body(req); const e = dir && engines.get(path.resolve(dir)); if (!e) return json(res, 404, { error: 'Projeto não aberto.' }); activeDir = path.resolve(dir); broadcast(); return json(res, 200, { ok: true }) }
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
    if (url.pathname === '/api/pick' && req.method === 'POST') { const { kind } = await body(req); return json(res, 200, { paths: await pickNative(kind) }) }
    if (url.pathname === '/api/attach' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, { error: 'Escolha uma pasta primeiro.' }); try { return await withEngine(e, async () => json(res, 200, { added: await addAttachments(b), attachments: state.attachments })) } catch (err) { return json(res, 400, { error: err.message }) } }
    if (url.pathname === '/api/attach/remove' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e) return json(res, 400, {}); return withEngine(e, async () => { const i = state.attachments.findIndex((a) => a.name === b.name); if (i >= 0) { const [a] = state.attachments.splice(i, 1); await rm(path.join(state.project.dir, a.path), { force: true }); broadcast() } return json(res, 200, { attachments: state.attachments }) }) }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const b = await body(req); const request = b.request
      if (!request?.trim()) return json(res, 400, { error: 'Pedido vazio.' })
      const e = await targetEngine(req, url, b); if (!e?.project) return json(res, 400, { error: 'Escolha uma pasta primeiro.' })
      if (busyOf(e)) return json(res, 409, { error: 'Já há uma missão rodando nesta pasta. Pause-a ou espere; em outra pasta pode rodar em paralelo.' })
      if (e.mission && ['awaiting_plan', 'awaiting_operator', 'paused'].includes(e.mission.state)) return json(res, 409, { error: 'A missão anterior desta pasta ainda espera uma decisão sua (continuar ou descartar).' })
      activeDir = path.resolve(e.project.dir)
      const err = await withEngine(e, () => startMission(request.trim())); return err ? json(res, 400, { error: err }) : json(res, 202, { ok: true })
    }
    if (url.pathname === '/api/decide' && req.method === 'POST') { const b = await body(req); const e = await targetEngine(req, url, b); if (!e) return json(res, 400, {}); withEngine(e, () => guard(() => decide(b.option, { text: b.text, answers: b.answers }))); return json(res, 202, { ok: true }) }
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
  await loadCatalog()
  await readQuota()
  await loadSavedMissions()
  const first = G.recent[0] || path.join(ROOT, 'example')
  const e = engineFor(first); if (!e.project) e.project = await discover(first); activeDir = path.resolve(first)
  console.log(`TL-ADE: http://127.0.0.1:${PORT}  projeto: ${e.project.dir}  skills no catálogo: ${G.catalog.length}  missões retomáveis: ${[...engines.values()].filter((x) => x.mission).length}`)
})
