// uso: node history.mjs <url> <prefixo> — rola até o histórico, abre a missão anterior e fotografa
import { chromium } from 'playwright'
const [url, out] = process.argv.slice(2)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(2500)
await p.getByRole('heading', { name: 'Missões deste projeto' }).scrollIntoViewIfNeeded(); await p.waitForTimeout(800)
await p.screenshot({ path: `${out}-0.png` })
await p.getByRole('button', { name: 'Abrir' }).first().click(); await p.waitForTimeout(2500)
await p.screenshot({ path: `${out}-1.png` })
await p.getByRole('button', { name: 'Voltar à missão atual' }).click(); await p.waitForTimeout(1500)
console.log(JSON.stringify({ errs, back: await p.getByText('Missão anterior:').count() === 0 }))
await b.close()
