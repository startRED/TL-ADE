// Olho na tela: o motor sobe a interface do projeto e fotografa num navegador sem janela (Chromium do Playwright), em
// segundo plano, sem abrir nem tocar no navegador do usuário. As fotos vão para o revisor e para quem escreve.
// Antes ninguém via a tela: o portão visual lia o código e o revisor lia o diff, e o painel da TL-ADE real ficou preso em
// "Carregando missão…" sem ninguém notar (m-mud7qppy, 23/09).
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const URL_RX = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s'"<>)]*/

// Sobe o comando de pré-visualização e espera ele imprimir a primeira URL local. Devolve { url, stop }.
export function startPreview(argv, { cwd, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' } })
    let out = '', done = false
    const stop = () => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGTERM') } catch {} }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { stop(); finish({ error: `a pré-visualização não imprimiu URL em ${timeoutMs / 1000} s: ${out.slice(-300)}` }) }, timeoutMs)
    const onData = (d) => { out += d; const m = URL_RX.exec(out.replace(/\x1b\[[0-9;]*m/g, '')); if (m) finish({ url: m[0].replace('0.0.0.0', '127.0.0.1'), stop }) }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('error', (e) => finish({ error: e.message }))
    child.on('close', (code) => finish({ error: `a pré-visualização saiu com código ${code}: ${out.slice(-300)}` }))
  })
}

// Fotografa a URL no computador e no celular; guarda os erros do console e das requisições que falharam.
export async function takeShots(url, { outDir, name, widths = [1440, 390], waitMs = 2500 } = {}) {
  const { chromium } = await import('playwright')
  await mkdir(outDir, { recursive: true })
  const browser = await chromium.launch()
  const shots = []
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: width > 800 ? 900 : 844 } })
      const errors = []
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
      page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)))
      page.on('requestfailed', (r) => errors.push(`falhou ${r.url().slice(0, 160)}: ${r.failure()?.errorText || ''}`))
      await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((e) => errors.push(`não abriu: ${e.message.slice(0, 200)}`))
      await page.waitForTimeout(waitMs)
      const file = path.join(outDir, `${name}-${width}.png`)
      await page.screenshot({ path: file, fullPage: true }).catch((e) => errors.push(`foto falhou: ${e.message.slice(0, 200)}`))
      shots.push({ file, width, errors: [...new Set(errors)].slice(0, 12), text: (await page.innerText('body').catch(() => '')).slice(0, 400) })
      await page.close()
    }
  } finally { await browser.close() }
  return shots
}
