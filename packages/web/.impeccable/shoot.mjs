// uso: node shoot.mjs <url> <saida-prefixo> <dark|light> [clique-texto...]
import { chromium } from 'playwright'
const [url, out, scheme = 'dark', ...clicks] = process.argv.slice(2)
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
const errs = []; p.on('console', (m) => m.type() === 'error' && errs.push(m.text())); p.on('pageerror', (e) => errs.push(e.message))
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(3500)
await p.screenshot({ path: `${out}-0.png` })
let i = 1
for (const c of clicks) { await p.getByText(c, { exact: false }).first().click(); await p.waitForTimeout(2200); await p.screenshot({ path: `${out}-${i++}.png`, fullPage: true }) }
console.log(JSON.stringify({ errs }))
await b.close()
