// Protótipo descartável da TL-ADE. Orquestra Claude Code (maker) e Codex (revisor)
// sobre QUALQUER pasta escolhida pelo operador e publica o estado ao vivo por SSE.
// Sem durabilidade real: o estado vive em memória; o journal é só um registro.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, appendFile, rm, stat, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ADE_DIR = path.join(ROOT, '.ade')
const SCHEMA = path.join(ROOT, 'review.schema.json')
const PORT = 4317
const IS_WIN = process.platform === 'win32'

// ---------- estado ----------
const state = { project: null, mission: null, log: [], history: [], live: null, recent: [] }
let currentPhase = null
let pending = null
const clients = new Set()

function now() { return new Date().toISOString() }
function broadcast() { const data = `data: ${JSON.stringify(state)}\n\n`; for (const res of clients) res.write(data) }
function broadcastSoon() { if (pending) return; pending = setTimeout(() => { pending = null; broadcast() }, 150) }
function setLive(live) { state.live = live; broadcastSoon() }

async function journal(event) {
  await mkdir(ADE_DIR, { recursive: true })
  await appendFile(path.join(ADE_DIR, 'journal.jsonl'), JSON.stringify({ ts: now(), project: state.project?.dir, ...event }) + '\n')
}

function log(source, text, kind = 'info') {
  const line = { ts: now(), source, text: String(text).slice(0, 4000), kind, phase: currentPhase }
  state.log.push(line)
  if (state.log.length > 500) state.log.shift()
  journal({ type: 'log', ...line }).catch(() => {})
  broadcast()
}

function setStep(name, status, extra = {}) {
  const m = state.mission
  const step = m.steps.find((s) => s.name === name)
  const stamp = status === 'running' ? { started_at: now() } : { finished_at: now() }
  if (status === 'running') currentPhase = name
  if (step) Object.assign(step, { status, ...stamp, ...extra })
  else m.steps.push({ name, status, ...stamp, ...extra })
  journal({ type: 'step', name, status }).catch(() => {})
  broadcast()
}

// ---------- processos ----------
function run(cmd, args, { cwd, stdin, onLine, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: IS_WIN, env: process.env, windowsHide: true })
    let out = '', err = '', buf = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (!onLine) return
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const l of lines) if (l.trim()) onLine(l)
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); if (onLine && buf.trim()) onLine(buf); resolve({ code, out, err }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }) })
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end() } else child.stdin.end()
  })
}
const exists = (p) => access(p).then(() => true, () => false)

// ---------- projeto ----------
async function loadRecent() {
  try { state.recent = JSON.parse(await readFile(path.join(ADE_DIR, 'projects.json'), 'utf8')) } catch { state.recent = [] }
}
async function saveRecent(dir) {
  state.recent = [dir, ...state.recent.filter((d) => d !== dir)].slice(0, 8)
  await mkdir(ADE_DIR, { recursive: true })
  await writeFile(path.join(ADE_DIR, 'projects.json'), JSON.stringify(state.recent, null, 2))
}

// Descobre como o projeto roda provas. Só o suficiente para o protótipo.
async function discover(dir) {
  const info = { dir, name: path.basename(dir), git: false, dirty: false, branch: null, runner: 'none', test_cmd: null, has_index: false, language: null }
  const st = await stat(dir).catch(() => null)
  if (!st?.isDirectory()) return { ...info, error: 'A pasta não existe.' }
  const g = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
  info.git = g.code === 0 && g.out.trim() === 'true'
  if (info.git) {
    info.dirty = (await run('git', ['status', '--porcelain'], { cwd: dir })).out.trim().length > 0
    info.branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).out.trim() || null
  }
  info.has_index = await exists(path.join(dir, 'index.html'))
  const pkgPath = path.join(dir, 'package.json')
  if (await exists(pkgPath)) {
    info.language = 'js'
    let pkg = {}; try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')) } catch {}
    if (await exists(path.join(dir, 'node_modules', 'vitest'))) { info.runner = 'vitest'; info.test_cmd = 'node node_modules/vitest/vitest.mjs run' }
    else if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) { info.runner = 'npm'; info.test_cmd = 'npm test' }
  } else if (await exists(path.join(dir, 'pyproject.toml')) || await exists(path.join(dir, 'pytest.ini')) || await exists(path.join(dir, 'requirements.txt'))) {
    info.language = 'python'; info.runner = 'pytest'; info.test_cmd = 'python -m pytest -q'
  }
  return info
}

async function runTests(project) {
  const dir = project.dir
  if (project.runner === 'vitest') {
    const outFile = path.join(dir, '.ade-vitest.json')
    await rm(outFile, { force: true })
    const r = await run('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${outFile}`], { cwd: dir, timeoutMs: 5 * 60 * 1000 })
    try {
      const j = JSON.parse(await readFile(outFile, 'utf8'))
      await rm(outFile, { force: true })
      const tests = j.testResults.flatMap((f) => {
        // Arquivo de prova que nem chega a rodar (importa módulo que ainda não existe) conta como prova vermelha "alvo ausente" (E12).
        if (f.assertionResults.length === 0 && f.status === 'failed') return [{ name: `${path.basename(f.name)} (arquivo ainda não roda)`, status: 'failed', message: (f.message || '').split('\n')[0].slice(0, 200) }]
        return f.assertionResults.map((a) => ({ name: a.fullName, status: a.status, message: (a.failureMessages || [])[0]?.split('\n')[0] || '' }))
      })
      const failed = tests.filter((t) => t.status !== 'passed').length
      return { ok: failed === 0 && tests.length > 0, total: tests.length, failed, tests, runner: 'vitest' }
    } catch { return { ok: false, total: 0, failed: 0, tests: [], runner: 'vitest', error: (r.err || r.out).slice(-600) } }
  }
  if (project.runner === 'npm' || project.runner === 'pytest') {
    const [cmd, ...args] = project.test_cmd.split(' ')
    const r = await run(cmd, args, { cwd: dir, timeoutMs: 5 * 60 * 1000 })
    const tail = (r.out + '\n' + r.err).trim().split('\n').slice(-12).join('\n')
    // Runner genérico: a "prova" é o comando inteiro; vermelho = saiu com erro.
    return { ok: r.code === 0, total: 1, failed: r.code === 0 ? 0 : 1, tests: [{ name: project.test_cmd, status: r.code === 0 ? 'passed' : 'failed', message: r.code === 0 ? '' : tail.slice(-300) }], runner: project.runner, output: tail }
  }
  return { ok: false, total: 0, failed: 0, tests: [], runner: 'none' }
}

async function gitDiff(dir) {
  await run('git', ['add', '-N', '.'], { cwd: dir })
  return (await run('git', ['diff', '--', '.'], { cwd: dir })).out
}
async function gitDiscard(dir) {
  // Seguro porque a missão só começa com a árvore limpa: desfaz apenas o que a missão criou.
  await run('git', ['reset', '-q', '--', '.'], { cwd: dir })
  await run('git', ['checkout', '--', '.'], { cwd: dir })
  await run('git', ['clean', '-fd', '.'], { cwd: dir })
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

// ---------- maker: Claude Code ----------
async function maker(prompt) {
  const m = state.mission, dir = state.project.dir
  // --safe-mode: sem CLAUDE.md/hooks/skills/MCP do usuário (isolamento, architecture.md E15).
  // Prompt vai por stdin, então nada é engolido pela flag variádica (E24).
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--max-turns', '40', '--model', m.model]
  if (m.allow_commands) args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', 'acceptEdits', '--tools', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep')
  log('engine', `claude ${args.join(' ')}`)
  let result = null, liveBuf = null
  const r = await run('claude', args, {
    cwd: dir, stdin: prompt,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'system' && ev.subtype === 'init') log('claude', `sessão iniciada · modelo ${ev.model}`)
      if (ev.type === 'stream_event') {
        const e = ev.event
        if (e?.type === 'content_block_start') liveBuf = { kind: e.content_block?.type === 'thinking' ? 'thinking' : e.content_block?.type === 'tool_use' ? 'tool' : 'text', text: e.content_block?.name ? `${e.content_block.name} ` : '' }
        if (e?.type === 'content_block_delta' && liveBuf) {
          const d = e.delta || {}
          liveBuf.text += d.thinking_delta ?? d.thinking ?? d.text ?? d.partial_json ?? ''
          setLive({ source: 'claude', kind: liveBuf.kind, text: liveBuf.text.slice(-1200) })
        }
        if (e?.type === 'content_block_stop') { liveBuf = null; setLive(null) }
      }
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'thinking' && c.thinking?.trim()) log('claude', c.thinking.trim(), 'thinking')
          if (c.type === 'text' && c.text.trim()) log('claude', c.text.trim(), 'text')
          if (c.type === 'tool_use') log('claude', describeTool(c, dir), 'tool')
        }
      }
      if (ev.type === 'user') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_result') {
            const body = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')
            const first = body.trim().split('\n').slice(0, 3).join('\n')
            if (first) log('claude', first.slice(0, 240), c.is_error ? 'error' : 'result')
          }
        }
      }
      if (ev.type === 'result') result = ev
    },
  })
  setLive(null)
  if (result) {
    m.cost.usd += result.total_cost_usd || 0
    m.cost.calls += 1
    m.cost.turns += result.num_turns || 0
    m.cost.tokens_in += (result.usage?.input_tokens || 0) + (result.usage?.cache_creation_input_tokens || 0)
    m.cost.cache_read += result.usage?.cache_read_input_tokens || 0
    m.cost.tokens_out += result.usage?.output_tokens || 0
    log('engine', `claude terminou · ${result.num_turns} turnos · US$ ${(result.total_cost_usd || 0).toFixed(3)} · ${Math.round((result.duration_ms || 0) / 1000)} s`)
    if (result.is_error) log('engine', `claude reportou erro: ${result.result || result.subtype}`, 'error')
  } else {
    log('engine', `claude saiu com código ${r.code}: ${(r.err || r.out).slice(0, 300)}`, 'error')
  }
  return result
}

// ---------- checker: Codex ----------
async function checker(diff, tests) {
  const m = state.mission, dir = state.project.dir
  const prompt = [
    'Você é o revisor. Outra IA (Claude) fez a alteração abaixo no projeto. Não escreva código; só avalie.',
    'Regras: toda mudança de comportamento vem com uma prova (teste) que falha antes e passa depois; sem mudanças fora do escopo do pedido; sem quebrar acessibilidade; sem segredos em código.',
    `Pedido do usuário: ${m.request}`,
    `Resultado das provas após a alteração: ${tests.failed} falharam de ${tests.total} (runner: ${tests.runner}).`,
    'Responda em português no formato JSON exigido. verdict = "approve" só se não houver achado high.',
    '--- DIFF ---', diff.slice(0, 60000),
  ].join('\n')
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', dir, '--output-schema', SCHEMA, '-']
  log('engine', `codex ${args.slice(0, 5).join(' ')} …`)
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
  try { review = JSON.parse(lastMessage) } catch { log('engine', `codex não devolveu JSON válido (código ${r.code}): ${(lastMessage || r.err || r.out).slice(0, 300)}`, 'error') }
  m.cost.calls += 1
  if (usage) { m.cost.tokens_in += usage.input_tokens || 0; m.cost.tokens_out += usage.output_tokens || 0 }
  if (review) log('codex', `${review.verdict === 'approve' ? 'aprovou' : 'pediu mudanças'}: ${review.summary}`, 'text')
  return review
}

// ---------- pipeline ----------
// Duas fases de Maker (prova vermelha antes da correção):
//   test: a IA escreve só a prova -> harness roda -> tem de haver prova nova VERMELHA
//   fix:  a IA implementa -> harness roda -> tudo verde -> Codex revisa
function common() {
  const p = state.project
  const lines = [
    `Projeto: ${p.name} (${p.language || 'linguagem a descobrir'}); runner de provas detectado: ${p.runner === 'none' ? 'nenhum' : p.test_cmd}.`,
    'Trabalhe só dentro do diretório atual; não suba para diretórios acima. Leia antes de escrever.',
  ]
  if (state.mission.allow_commands) lines.push('Você pode rodar comandos (instalar dependências, inicializar projeto). Não rode servidores que fiquem abertos; não use git.')
  else lines.push('Você só tem ferramentas de leitura e edição; o harness roda as provas e te devolve o resultado.')
  if (p.runner === 'none') lines.push('Não há runner de provas. Na fase 1, crie o mínimo para rodar provas (em JS: package.json com vitest e `"test": "vitest run"`; em Python: pytest) antes de escrever a prova.')
  if (p.has_index) lines.push('Há um index.html na raiz; se criar algo visual, ligue nele para aparecer na página.')
  return lines
}

function testPrompt() {
  return [
    `Pedido do usuário: ${state.mission.request}`, ...common(),
    'FASE 1 de 2: escreva APENAS uma prova nova (teste automatizado) que descreva o comportamento pedido e que FALHE no código atual, porque o comportamento ainda não existe ou está errado. Não implemente o comportamento ainda.',
    'Ao terminar, escreva uma frase com o nome exato da prova nova e como rodá-la.',
  ].join('\n')
}

function fixPrompt(round, review) {
  const m = state.mission
  const red = m.red_tests.map((t) => `- ${t.name}: ${t.message}`).join('\n')
  const base = [
    `Pedido do usuário: ${m.request}`, ...common(),
    `FASE 2 de 2: o harness rodou as provas e a prova nova está vermelha, como esperado:\n${red}`,
    'Agora implemente o mínimo para a prova passar. Não modifique a prova. Não toque em nada fora do escopo do pedido.',
    'Ao terminar, escreva uma frase dizendo o que mudou.',
  ]
  if (round > 1 && review) {
    base.push(`Esta é a rodada ${round}. O revisor (outra IA) pediu mudanças: ${review.summary}`)
    for (const f of review.findings) base.push(`- [${f.severity}] ${f.file}: ${f.problem} Correção sugerida: ${f.fix}`)
  }
  return base.join('\n')
}

async function pipeline(round = 1, previousReview = null) {
  const m = state.mission
  m.state = 'running'; m.round = round
  try {
    if (round === 1) {
      setStep('prepare', 'running')
      m.tests_before = await runTests(state.project)
      log('engine', state.project.runner === 'none' ? 'ponto de partida: sem runner de provas (a IA vai criar um)' : `ponto de partida: ${m.tests_before.total} provas, ${m.tests_before.failed} vermelhas`)
      setStep('prepare', 'done')

      setStep('test', 'running')
      await maker(testPrompt())
      state.project = { ...state.project, ...(await discover(state.project.dir)) }   // runner pode ter nascido agora
      setStep('test', 'done')

      setStep('red', 'running')
      const afterTest = await runTests(state.project)
      const before = new Set(m.tests_before.tests.map((t) => t.name))
      const generic = afterTest.runner !== 'vitest'
      m.red_tests = generic
        ? afterTest.tests.filter((t) => t.status !== 'passed')   // runner genérico: vermelho = comando falhou
        : afterTest.tests.filter((t) => !before.has(t.name) && t.status !== 'passed')
      m.new_tests = generic ? [] : afterTest.tests.filter((t) => !before.has(t.name)).map((t) => t.name)
      const regress = generic ? [] : afterTest.tests.filter((t) => before.has(t.name) && t.status !== 'passed')
      log('engine', `prova vermelha: ${m.red_tests.length} vermelha(s)${generic ? ' (runner genérico)' : `, ${m.new_tests.length} nova(s), ${regress.length} antiga(s) quebrada(s)`}`)
      if (m.red_tests.length === 0 || regress.length > 0) {
        setStep('red', 'failed')
        m.tests_after = afterTest; m.diff = await gitDiff(state.project.dir)
        m.state = 'awaiting_operator'; m.reason = regress.length ? 'tests_red' : 'no_red_test'
        log('engine', `parada: ${m.reason}`, 'error')
        return finish()
      }
      setStep('red', 'done')
    }

    setStep('fix', 'running', { round })
    await maker(fixPrompt(round, previousReview))
    state.project = { ...state.project, ...(await discover(state.project.dir)) }
    setStep('fix', 'done', { round })

    setStep('tests', 'running')
    m.tests_after = await runTests(state.project)
    m.diff = await gitDiff(state.project.dir)
    log('engine', `provas depois: ${m.tests_after.total} no total, ${m.tests_after.failed} vermelha(s)`)
    setStep('tests', m.tests_after.ok ? 'done' : 'failed')

    if (!m.diff.trim()) {
      m.state = 'awaiting_operator'; m.reason = 'no_changes'
      log('engine', 'a IA não alterou nenhum arquivo', 'error')
      setStep('checker', 'skipped'); return finish()
    }

    setStep('checker', 'running')
    m.review = await checker(m.diff, m.tests_after)
    setStep('checker', m.review ? (m.review.verdict === 'approve' ? 'done' : 'failed') : 'failed')

    if (m.tests_after.ok && m.review?.verdict === 'approve') {
      m.state = 'complete'; m.reason = null
      log('engine', 'pronta: prova vermelha antes, verde depois; revisor de outra família aprovou')
    } else {
      m.state = 'awaiting_operator'
      m.reason = !m.tests_after.ok ? 'tests_red' : 'review_changes'
      log('engine', `parada: ${m.reason}`)
    }
  } catch (e) {
    m.state = 'awaiting_operator'; m.reason = 'engine_error'
    log('engine', `erro do engine: ${e.message}`, 'error')
  }
  return finish()
}

function finish() {
  const m = state.mission
  m.finished_at = now()
  const entry = { id: m.id, project: state.project.dir, request: m.request, state: m.state, reason: m.reason, usd: m.cost.usd, finished_at: m.finished_at }
  const h = state.history.find((x) => x.id === m.id)
  if (h) Object.assign(h, entry); else state.history.unshift(entry)
  journal({ type: 'mission', state: m.state, reason: m.reason }).catch(() => {})
  broadcast()
}

async function startMission(request, opts) {
  const p = state.project
  if (!p) return 'Escolha uma pasta primeiro.'
  const fresh = await discover(p.dir)
  if (fresh.error) return fresh.error
  if (!fresh.git) return 'A pasta precisa ser um repositório git: é assim que a ADE mostra e desfaz alterações. Use "Iniciar git nesta pasta".'
  if (fresh.dirty) return 'A pasta tem alterações não commitadas. Commite ou descarte antes, para a ADE poder desfazer só o que ela mesma fizer.'
  state.project = fresh
  state.log = []
  currentPhase = 'prepare'
  state.mission = {
    id: 'm-' + Date.now().toString(36), request, state: 'running', reason: null, round: 0,
    model: opts.model || 'sonnet', allow_commands: !!opts.allow_commands,
    steps: [], tests_before: null, tests_after: null, new_tests: [], red_tests: [], diff: '', review: null,
    cost: { usd: 0, calls: 0, turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 }, started_at: now(), finished_at: null,
  }
  journal({ type: 'mission_start', id: state.mission.id, request }).catch(() => {})
  log('engine', `missão ${state.mission.id} em ${p.dir}: "${request}"`)
  pipeline(1)
  return null
}

async function decide(option) {
  const m = state.mission
  if (!m || m.state !== 'awaiting_operator') return
  journal({ type: 'decision', option }).catch(() => {})
  if (option === 'accept') { m.state = 'complete'; m.reason = 'accepted_by_operator'; log('operador', 'aceitou como está'); finish() }
  if (option === 'retry') { log('operador', 'pediu mais uma rodada'); pipeline(m.round + 1, m.review) }
  if (option === 'discard') { await gitDiscard(state.project.dir); m.state = 'discarded'; log('operador', 'descartou; arquivos restaurados'); finish() }
}

// ---------- HTTP ----------
async function body(req) { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {} }
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('Access-Control-Allow-Origin', '*')
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(state)}\n\n`)
      clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (url.pathname === '/api/state') return json(res, 200, state)
    if (url.pathname === '/api/project' && req.method === 'POST') {
      const { dir } = await body(req)
      if (state.mission?.state === 'running') return json(res, 409, { error: 'Há uma missão rodando.' })
      if (!String(dir || '').trim()) return json(res, 400, { error: 'Informe o caminho da pasta.' })
      const info = await discover(path.resolve(String(dir || '').trim().replace(/^~/, os.homedir())))
      if (info.error) return json(res, 400, info)
      state.project = info; state.mission = null; state.log = []
      await saveRecent(info.dir); broadcast()
      return json(res, 200, info)
    }
    if (url.pathname === '/api/project/git-init' && req.method === 'POST') {
      if (!state.project) return json(res, 400, { error: 'Sem pasta.' })
      const d = state.project.dir
      await run('git', ['init', '-q'], { cwd: d })
      await run('git', ['add', '-A'], { cwd: d })
      await run('git', ['-c', 'user.name=TL-ADE', '-c', 'user.email=ade@local', 'commit', '-q', '-m', 'base: antes da TL-ADE', '--allow-empty'], { cwd: d })
      state.project = await discover(d); broadcast()
      return json(res, 200, state.project)
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const { request, model, allow_commands } = await body(req)
      if (!request?.trim()) return json(res, 400, { error: 'Pedido vazio.' })
      if (state.mission?.state === 'running') return json(res, 409, { error: 'Já há uma missão rodando.' })
      const err = await startMission(request.trim(), { model, allow_commands })
      return err ? json(res, 400, { error: err }) : json(res, 202, { ok: true })
    }
    if (url.pathname === '/api/decide' && req.method === 'POST') { const { option } = await body(req); await decide(option); return json(res, 202, { ok: true }) }
    if (url.pathname === '/api/app' || url.pathname.startsWith('/api/app/')) {
      // Página do projeto alvo (index.html na raiz), servida do disco: ES modules precisam de HTTP.
      if (!state.project) { res.writeHead(404); return res.end('sem projeto') }
      if (url.pathname === '/api/app') { res.writeHead(302, { Location: '/api/app/' }); return res.end() }
      const rel = url.pathname === '/api/app/' ? 'index.html' : decodeURIComponent(url.pathname.slice(9))
      const file = path.join(state.project.dir, rel)
      if (!file.startsWith(state.project.dir) || rel.includes('node_modules')) { res.writeHead(403); return res.end() }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
      try {
        const data = await readFile(file)
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
        return res.end(data)
      } catch { res.writeHead(404); return res.end('não encontrado') }
    }
    res.writeHead(404); res.end()
  } catch (e) { json(res, 500, { error: e.message }) }
}).listen(PORT, '127.0.0.1', async () => {
  await loadRecent()
  const first = state.recent[0] || path.join(ROOT, 'example')
  state.project = await discover(first)
  console.log(`TL-ADE proto: http://127.0.0.1:${PORT}  (projeto: ${state.project.dir})`)
})
