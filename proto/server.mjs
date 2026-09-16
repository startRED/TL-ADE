// Protótipo descartável da TL-ADE. Orquestra Claude Code (maker) e Codex (revisor)
// sobre o projeto em ./example e publica o estado ao vivo por SSE.
// Sem durabilidade real: o estado vive em memória; o journal é só um registro.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.join(ROOT, 'example')
const ADE_DIR = path.join(ROOT, '.ade')
const SCHEMA = path.join(ROOT, 'review.schema.json')
const PORT = 4317
const IS_WIN = process.platform === 'win32'

// ---------- estado ----------
const state = { mission: null, log: [], history: [], live: null }
let pending = null
function broadcastSoon() { if (pending) return; pending = setTimeout(() => { pending = null; broadcast() }, 150) }
function setLive(live) { state.live = live; broadcastSoon() }
const clients = new Set()

function now() { return new Date().toISOString() }

async function journal(event) {
  await mkdir(ADE_DIR, { recursive: true })
  await appendFile(path.join(ADE_DIR, 'journal.jsonl'), JSON.stringify({ ts: now(), ...event }) + '\n')
}

function log(source, text, kind = 'info') {
  const line = { ts: now(), source, text: String(text).slice(0, 4000), kind }
  state.log.push(line)
  if (state.log.length > 400) state.log.shift()
  journal({ type: 'log', ...line }).catch(() => {})
  broadcast()
}

function setStep(name, status, extra = {}) {
  const m = state.mission
  const step = m.steps.find((s) => s.name === name)
  const stamp = status === 'running' ? { started_at: now() } : { finished_at: now() }
  if (step) Object.assign(step, { status, ...stamp, ...extra })
  else m.steps.push({ name, status, ...stamp, ...extra })
  journal({ type: 'step', name, status }).catch(() => {})
  broadcast()
}

function broadcast() {
  const data = `data: ${JSON.stringify(state)}\n\n`
  for (const res of clients) res.write(data)
}

// ---------- processos ----------
function run(cmd, args, { cwd, stdin, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: IS_WIN, env: process.env, windowsHide: true })
    let out = '', err = '', buf = ''
    child.stdout.on('data', (d) => {
      out += d
      if (!onLine) return
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const l of lines) if (l.trim()) onLine(l)
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { if (onLine && buf.trim()) onLine(buf); resolve({ code, out, err }) })
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end() } else child.stdin.end()
  })
}

async function runTests() {
  const outFile = path.join(EXAMPLE, '.vitest.json')
  await rm(outFile, { force: true })
  const r = await run('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${outFile}`], { cwd: EXAMPLE })
  try {
    const j = JSON.parse(await readFile(outFile, 'utf8'))
    const tests = j.testResults.flatMap((f) => {
      // Arquivo de prova que nem chega a rodar (importa módulo que ainda não existe, erro de sintaxe)
      // conta como prova vermelha do tipo "alvo ausente" (architecture.md E12), com o nome do arquivo.
      if (f.assertionResults.length === 0 && f.status === 'failed') {
        return [{ name: `${path.basename(f.name)} (arquivo ainda não roda)`, status: 'failed', file: path.basename(f.name), message: (f.message || '').split('\n')[0].slice(0, 200) }]
      }
      return f.assertionResults.map((a) => ({
        name: a.fullName, status: a.status, file: path.basename(f.name), message: (a.failureMessages || [])[0]?.split('\n')[0] || '',
      }))
    })
    const failed = tests.filter((t) => t.status !== 'passed').length
    return { ok: failed === 0 && tests.length > 0, total: tests.length, failed, tests }
  } catch {
    return { ok: false, total: 0, failed: 0, tests: [], error: (r.err || r.out).slice(0, 500) }
  }
}

async function gitDiff() {
  await run('git', ['add', '-N', '.'], { cwd: EXAMPLE })
  const r = await run('git', ['diff', '--', '.'], { cwd: EXAMPLE })
  return r.out
}

async function gitDiscard() {
  await run('git', ['checkout', '--', '.'], { cwd: EXAMPLE })
  await run('git', ['clean', '-fd', '.'], { cwd: EXAMPLE })
}

function describeTool(c) {
  const i = c.input || {}
  const f = i.file_path ? path.relative(EXAMPLE, i.file_path) || path.basename(i.file_path) : ''
  if (c.name === 'Edit') return `Edit ${f}\n- ${(i.old_string || '').split('\n')[0].slice(0, 100)}\n+ ${(i.new_string || '').split('\n')[0].slice(0, 100)}`
  if (c.name === 'MultiEdit') return `MultiEdit ${f} (${(i.edits || []).length} edições)`
  if (c.name === 'Write') return `Write ${f} (${(i.content || '').length} caracteres)`
  if (c.name === 'Read') return `Read ${f}`
  if (c.name === 'Glob') return `Glob ${i.pattern || ''}`
  if (c.name === 'Grep') return `Grep ${i.pattern || ''}`
  return `${c.name} ${f || i.command || ''}`.trim()
}

// ---------- maker: Claude Code ----------
async function maker(prompt) {
  const m = state.mission
  // --safe-mode: sem CLAUDE.md/hooks/skills/MCP do usuário (isolamento, architecture.md E15).
  // --tools: só leitura e edição; o harness roda os testes. Prompt vai por stdin, então nada
  // é engolido pela flag variádica (E24).
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--permission-mode', 'acceptEdits', '--max-turns', '25', '--model', 'sonnet', '--tools', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep']
  log('engine', `claude ${args.join(' ')}`)
  let result = null, liveBuf = null
  const r = await run('claude', args, {
    cwd: EXAMPLE, stdin: prompt,
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
          if (c.type === 'tool_use') log('claude', describeTool(c), 'tool')
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
  const m = state.mission
  const prompt = [
    'Você é o revisor. Outra IA (Claude) fez a alteração abaixo no projeto. Não escreva código; só avalie.',
    'Regras do projeto: toda correção vem com um teste que falha antes e passa depois; sem mudanças fora do escopo do pedido; sem quebrar acessibilidade.',
    `Pedido do usuário: ${m.request}`,
    `Resultado dos testes após a alteração: ${tests.failed} falharam de ${tests.total}.`,
    'Responda em português no formato JSON exigido. verdict = "approve" só se não houver achado high.',
    '--- DIFF ---', diff.slice(0, 60000),
  ].join('\n')
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', EXAMPLE, '--output-schema', SCHEMA, '-']
  log('engine', `codex ${args.slice(0, 5).join(' ')} …`)
  let lastMessage = null, usage = null
  const r = await run('codex', args, {
    cwd: EXAMPLE, stdin: prompt,
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
  try { review = JSON.parse(lastMessage) } catch {
    log('engine', `codex não devolveu JSON válido (código ${r.code}): ${(lastMessage || r.err || r.out).slice(0, 300)}`, 'error')
  }
  m.cost.calls += 1
  if (usage) { m.cost.tokens_in += usage.input_tokens || 0; m.cost.tokens_out += usage.output_tokens || 0 }
  if (review) log('codex', `${review.verdict === 'approve' ? 'aprovou' : 'pediu mudanças'}: ${review.summary}`, 'text')
  return review
}

// ---------- pipeline ----------
// Duas fases de Maker, como na arquitetura (prova vermelha antes da correção):
//   test: a IA escreve só o teste novo -> harness roda -> tem de haver teste novo VERMELHO
//   fix:  a IA corrige o código -> harness roda -> tudo verde -> Codex revisa
const COMMON = [
  'Projeto: JavaScript puro em src/, testes Vitest em src/*.test.js (ambiente happy-dom).',
  'Você só tem ferramentas de leitura e edição; o harness roda os testes e te devolve o resultado. Trabalhe só dentro do diretório atual (src/ já existe: leia antes de escrever); não suba para diretórios acima.',
]

function testPrompt() {
  return [
    `Pedido do usuário: ${state.mission.request}`, ...COMMON,
    'FASE 1 de 2: escreva APENAS um teste novo (em um arquivo src/*.test.js existente ou novo) que descreva o comportamento pedido e que FALHE no código atual, porque o comportamento ainda não existe ou está errado. Não altere nenhum outro arquivo e não implemente nada ainda.',
    'Ao terminar, escreva uma frase com o nome exato do teste novo.',
  ].join('\n')
}

function fixPrompt(round, review) {
  const m = state.mission
  const red = m.red_tests.map((t) => `- ${t.name}: ${t.message}`).join('\n')
  const base = [
    `Pedido do usuário: ${m.request}`, ...COMMON,
    `FASE 2 de 2: o harness rodou os testes e o teste novo está vermelho, como esperado:\n${red}`,
    'Agora escreva o código mínimo em src/ para o teste passar (altere arquivo existente ou crie um novo). Não modifique os testes. Não toque em nada fora do escopo do pedido.',
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
      m.tests_before = await runTests()
      log('engine', `linha de base: ${m.tests_before.total} testes, ${m.tests_before.failed} vermelhos`)
      setStep('prepare', 'done')

      setStep('test', 'running')
      await maker(testPrompt())
      setStep('test', 'done')

      setStep('red', 'running')
      const afterTest = await runTests()
      const before = new Set(m.tests_before.tests.map((t) => t.name))
      m.red_tests = afterTest.tests.filter((t) => !before.has(t.name) && t.status !== 'passed')
      m.new_tests = afterTest.tests.filter((t) => !before.has(t.name)).map((t) => t.name)
      const regress = afterTest.tests.filter((t) => before.has(t.name) && t.status !== 'passed')
      log('engine', `prova vermelha: ${m.new_tests.length} teste(s) novo(s), ${m.red_tests.length} vermelho(s), ${regress.length} antigo(s) quebrado(s)`)
      if (m.red_tests.length === 0 || regress.length > 0) {
        setStep('red', 'failed')
        m.tests_after = afterTest; m.diff = await gitDiff()
        m.state = 'awaiting_operator'; m.reason = regress.length ? 'tests_red' : 'no_red_test'
        log('engine', `parada: ${m.reason}`, 'error')
        return finish()
      }
      setStep('red', 'done')
    }

    setStep('fix', 'running', { round })
    await maker(fixPrompt(round, previousReview))
    setStep('fix', 'done', { round })

    setStep('tests', 'running')
    m.tests_after = await runTests()
    m.diff = await gitDiff()
    log('engine', `testes depois: ${m.tests_after.total} no total, ${m.tests_after.failed} vermelhos`)
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
      log('engine', 'pronta: teste novo ficou vermelho antes e verde depois; revisor de outra família aprovou')
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
  state.mission.finished_at = now()
  const h = state.history.find((x) => x.id === state.mission.id)
  const entry = { id: state.mission.id, request: state.mission.request, state: state.mission.state, reason: state.mission.reason, usd: state.mission.cost.usd, finished_at: state.mission.finished_at }
  if (h) Object.assign(h, entry); else state.history.unshift(entry)
  journal({ type: 'mission', state: state.mission.state, reason: state.mission.reason }).catch(() => {})
  broadcast()
}

async function startMission(request) {
  // A linha de base precisa estar commitada: `git clean` apaga arquivos não rastreados.
  const st = await run('git', ['status', '--porcelain', '--', '.'], { cwd: EXAMPLE })
  if (st.out.trim() && state.mission?.state !== 'complete') {
    log('engine', 'example/ tem alterações não commitadas de uma missão anterior; restaurando a linha de base')
  }
  await gitDiscard()
  state.log = []
  state.mission = {
    id: 'm-' + Date.now().toString(36), request, state: 'running', reason: null, round: 0,
    steps: [], tests_before: null, tests_after: null, new_tests: [], red_tests: [], diff: '', review: null,
    cost: { usd: 0, calls: 0, turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0 }, started_at: now(), finished_at: null,
  }
  journal({ type: 'mission_start', id: state.mission.id, request }).catch(() => {})
  log('engine', `missão ${state.mission.id}: "${request}"`)
  pipeline(1)
}

async function decide(option) {
  const m = state.mission
  if (!m || m.state !== 'awaiting_operator') return
  journal({ type: 'decision', option }).catch(() => {})
  if (option === 'accept') { m.state = 'complete'; m.reason = 'accepted_by_operator'; log('operador', 'aceitou como está'); finish() }
  if (option === 'retry') { log('operador', 'pediu mais uma rodada'); pipeline(m.round + 1, m.review) }
  if (option === 'discard') { await gitDiscard(); m.state = 'discarded'; log('operador', 'descartou; arquivos restaurados'); finish() }
}

// ---------- HTTP ----------
async function body(req) {
  let s = ''; for await (const c of req) s += c
  return s ? JSON.parse(s) : {}
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(state)}\n\n`)
    clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state)) }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    const { request } = await body(req)
    if (!request?.trim()) { res.writeHead(400); return res.end('pedido vazio') }
    if (state.mission?.state === 'running') { res.writeHead(409); return res.end('já há uma missão rodando') }
    startMission(request.trim()); res.writeHead(202); return res.end()
  }
  if (url.pathname === '/api/decide' && req.method === 'POST') {
    const { option } = await body(req); await decide(option); res.writeHead(202); return res.end()
  }
  res.writeHead(404); res.end()
}).listen(PORT, '127.0.0.1', () => console.log(`TL-ADE proto: http://127.0.0.1:${PORT}  (alvo: ${EXAMPLE})`))
