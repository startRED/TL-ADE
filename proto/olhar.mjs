// Navegador de ferramenta para quem escreve e quem revisa: abre a interface num Chromium sem janela, segue passos
// (clicar, digitar, tecla, esperar, foto) e devolve as fotos, os erros do console e o texto da tela. Roda pelo terminal
// da própria IA (o Claude do motor usa --safe-mode, que desliga MCP; o Codex só tem comando), em segundo plano.
//   node olhar.mjs <url | caminho (. = raiz)> [--serve '["node","bin/ade.js","serve",...]'] [--width 390] [--out pasta] [passos...]
//   passos: click:<texto visível> | fill:<seletor css>=<valor> | press:<tecla> | wait:<ms> | shot
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { startPreview } from './shots.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d }
const serve = opt('--serve'), width = Number(opt('--width', 1440)), out = opt('--out', path.join(os.tmpdir(), 'olhar'))
let url = argv.shift()
if (!url) { console.error('uso: node olhar.mjs <url | /caminho> [--serve json] [--width n] [--out pasta] [click:x fill:css=v press:k wait:ms shot]'); process.exit(2) }

const pv = serve ? await startPreview(JSON.parse(serve), { cwd: process.cwd() }) : null
if (pv?.error) { console.log(JSON.stringify({ error: pv.error })); process.exit(1) }
// Caminho relativo ao servidor subido ('.' = raiz). O Git Bash troca '/x' por 'C:/Program Files/Git/x': desfaz.
url = url.replace(/^[A-Za-z]:\/Program Files\/Git\//, '/')
if (pv && !/^https?:/.test(url)) { const u = new URL(url.replace(/^\.?\/?/, '/'), pv.url); u.search = new URL(pv.url).search; url = u.href }
const { chromium } = await import('playwright')
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const shots = [], errors = [], stamp = Date.now().toString(36)
try {
  const page = await browser.newPage({ viewport: { width, height: width > 800 ? 900 : 844 } })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)))
  page.on('requestfailed', (r) => errors.push(`falhou ${r.url().slice(0, 160)}: ${r.failure()?.errorText || ''}`))
  const shot = async () => { const f = path.join(out, `${stamp}-${shots.length + 1}-${width}.png`); await page.screenshot({ path: f, fullPage: true }); shots.push(f) }
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(1500)
  for (const s of argv) {
    const [cmd, ...rest] = s.split(':'), arg = rest.join(':')
    try {
      if (cmd === 'click') await page.getByText(arg).first().click({ timeout: 8000 })
      else if (cmd === 'fill') { const i = arg.indexOf('='); await page.fill(arg.slice(0, i), arg.slice(i + 1), { timeout: 8000 }) }
      else if (cmd === 'press') await page.keyboard.press(arg)
      else if (cmd === 'wait') await page.waitForTimeout(Number(arg) || 1000)
      else if (cmd === 'shot') await shot()
      else errors.push(`passo desconhecido: ${s}`)
      if (cmd !== 'wait' && cmd !== 'shot') await page.waitForTimeout(600)
    } catch (e) { errors.push(`passo ${s} falhou: ${e.message.split('\n')[0].slice(0, 200)}`) }
  }
  await shot()
  const text = (await page.innerText('body').catch(() => '')).slice(0, 1500)
  console.log(JSON.stringify({ url: page.url(), fotos: shots, erros: [...new Set(errors)], texto: text }, null, 1))
} finally { await browser.close(); pv?.stop() }
