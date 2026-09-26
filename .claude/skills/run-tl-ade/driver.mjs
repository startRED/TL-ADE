#!/usr/bin/env node
// Driver do painel da TL-ADE para agentes: sobe um servidor isolado (repositório e ~/.ade de rascunho,
// sem chamar modelos nem ler cota) ou se liga a um painel já aberto, abre o Chromium do Playwright
// e executa comandos lidos da entrada padrão, um por linha. Funciona com heredoc ou digitando.
//
//   node .claude/skills/run-tl-ade/driver.mjs [--url http://127.0.0.1:4173/] [--repo <pasta git>] [--out <pasta>]
//
// Comandos: goto <caminho> | click <nome> | fill <rótulo> = <texto> | paste-image <rótulo>
//           shot <nome> | text | eval <js> | wait <ms> | quit
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { values: opt } = parseArgs({ options: { url: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
const outDir = path.resolve(opt.out ?? path.join(os.tmpdir(), 'tl-ade-shots'))
mkdirSync(outDir, { recursive: true })

const cleanups = []
let url = opt.url
if (!url) {
  const { startServer } = await import(new URL('../../../src/panel/server.ts', import.meta.url).href)
  const home = mkdtempSync(path.join(os.tmpdir(), 'tl-ade-driver-home-'))
  let repo = opt.repo && path.resolve(opt.repo)
  if (!repo) {
    repo = mkdtempSync(path.join(os.tmpdir(), 'tl-ade-driver-repo-'))
    const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 20, stdio: 'ignore' })
    git('init', '-q')
    writeFileSync(path.join(repo, 'README.md'), '# projeto de rascunho\n')
    git('add', '.')
    git('-c', 'user.name=driver', '-c', 'user.email=driver@local', 'commit', '-qm', 'inicio')
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }))
  }
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const server = await startServer({
    repoDir: repo, port, openBrowser: false, webDistDir: path.join(ROOT, 'packages/web/dist'),
    deps: {
      stdout: () => {}, homeDir: home,
      // pedido enviado vira entrevista de uma pergunta, sem gastar cota de modelo
      intent: { async compile() { return { questions: [{ id: 'Q1', text: 'Confirmar?', options: [{ id: 'sim', label: 'Sim' }] }] } } },
    },
  })
  url = server.url
  cleanups.push(() => server.close(), () => rmSync(home, { recursive: true, force: true }))
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log(`[erro na página] ${e.message}`))
await page.goto(url)
console.log(`pronto ${url} (capturas em ${outDir})`)

const byName = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true })).or(page.getByRole('tab', { name, exact: true })).first()
const commands = {
  goto: (arg) => page.goto(new URL(arg || '/', url).href),
  click: (arg) => byName(arg).click({ timeout: 10_000 }),
  fill: (arg) => { const [label, ...text] = arg.split(' = '); return page.getByLabel(label.trim(), { exact: true }).fill(text.join(' = ').replace(/\\n/g, '\n')) },
  // print colado: PNG gerado no próprio navegador, mesmo caminho do Ctrl+V
  'paste-image': (arg) => page.getByLabel(arg || 'Pedido', { exact: true }).evaluate(async (el) => {
    const c = Object.assign(document.createElement('canvas'), { width: 240, height: 150 })
    const g = c.getContext('2d'); g.fillStyle = '#1428c8'; g.fillRect(0, 0, 240, 150); g.fillStyle = '#fff'; g.font = '24px monospace'; g.fillText('print', 90, 85)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }),
  shot: async (arg) => { const file = path.join(outDir, `${arg || Date.now()}.png`); await page.screenshot({ path: file }); console.log(file) },
  text: async () => console.log((await page.locator('body').innerText()).slice(0, 3000)),
  eval: async (arg) => console.log(JSON.stringify(await page.evaluate(arg))),
  wait: (arg) => page.waitForTimeout(Number(arg) || 500),
}

async function finish() {
  await browser.close()
  for (const f of cleanups.reverse()) await f()
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin })
for await (const raw of rl) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const [cmd, ...rest] = line.split(' ')
  if (cmd === 'quit') break
  const run = commands[cmd]
  if (!run) { console.log(`? comando desconhecido: ${cmd}`); continue }
  try { await run(rest.join(' ')); console.log(`ok ${cmd}`) } catch (err) { console.log(`falhou ${cmd}: ${err instanceof Error ? err.message.split('\n')[0] : err}`) }
}
await finish()
