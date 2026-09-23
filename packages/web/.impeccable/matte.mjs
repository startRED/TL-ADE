// Tinta da gravura vira alfa: luminância -> opacidade, cor fixa na tinta da Partitura. Tira o halo cinza do gerador.
// uso: node matte.mjs <entrada.png> <saida.webp> [largura]
import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
const [src, out, w = '1400'] = process.argv.slice(2)
const b = await chromium.launch(); const p = await b.newPage()
const data = 'data:image/png;base64,' + (await readFile(src)).toString('base64')
const res = await p.evaluate(async ({ data, w }) => {
  const img = new Image(); img.src = data; await img.decode()
  const scale = Math.min(1, w / img.width), W = Math.round(img.width * scale), H = Math.round(img.height * scale)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H)
  const d = x.getImageData(0, 0, W, H), px = d.data
  let lo = 1, hi = 0
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) { const a = px[i*4+3] / 255; const l = (0.2126*px[i*4] + 0.7152*px[i*4+1] + 0.0722*px[i*4+2]) / 255 * a; lum[i] = l }
  // halo do gerador fica abaixo de ~0.35; o traço da gravura fica acima
  const t0 = 0.34, t1 = 0.86
  for (let i = 0; i < W * H; i++) { const v = Math.min(1, Math.max(0, (lum[i] - t0) / (t1 - t0))); px[i*4] = 236; px[i*4+1] = 235; px[i*4+2] = 232; px[i*4+3] = Math.round(Math.pow(v, 0.9) * 255) }
  x.putImageData(d, 0, 0)
  return c.toDataURL('image/webp', 0.9)
}, { data, w: Number(w) })
await writeFile(out, Buffer.from(res.split(',')[1], 'base64'))
await b.close()
console.log(out)
