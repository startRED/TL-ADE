// uso: node log.mjs <url> <prefixo> — abre a atividade completa da missão e fotografa
import { chromium } from 'playwright'
const [url, out] = process.argv.slice(2)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(2500)
const s = p.locator('summary', { hasText: 'Atividade completa' }); await s.scrollIntoViewIfNeeded(); await s.click(); await p.waitForTimeout(2000)
await s.evaluate((el) => el.scrollIntoView({ block: 'start' })); await p.mouse.wheel(0, -120); await p.waitForTimeout(600)
await p.screenshot({ path: `${out}-0.png` })
console.log(JSON.stringify({ errs, lines: await p.locator('.log-lines li').count() }))
await b.close()
