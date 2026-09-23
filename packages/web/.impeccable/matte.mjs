// A tinta da gravura vira alfa, com cor fixa. Isso tira o halo cinza ou o papel branco que o gerador deixa.
//   escuro: traço claro sobre fundo escuro; alfa = luminância; tinta #ecebe8.
//   claro:  traço preto sobre branco; alfa = 1 - luminância; tinta #17171c.
// uso: node matte.mjs <entrada.png> <saida.webp> [largura] [escuro|claro]
import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
const [src, out, w = '1400', mode = 'escuro'] = process.argv.slice(2)
const b = await chromium.launch(); const p = await b.newPage()
const data = 'data:image/png;base64,' + (await readFile(src)).toString('base64')
const res = await p.evaluate(async ({ data, w, light }) => {
  const img = new Image(); img.src = data; await img.decode()
  const scale = Math.min(1, w / img.width), W = Math.round(img.width * scale), H = Math.round(img.height * scale)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H)
  const d = x.getImageData(0, 0, W, H), px = d.data
  // escuro: o halo do gerador fica abaixo de ~0.34 de luminância. claro: o papel fica acima de ~0.9.
  const [t0, t1] = light ? [0.1, 0.72] : [0.34, 0.86]
  const ink = light ? [23, 23, 28] : [236, 235, 232]
  for (let i = 0; i < W * H; i++) {
    const a = px[i*4+3] / 255
    const l = (0.2126*px[i*4] + 0.7152*px[i*4+1] + 0.0722*px[i*4+2]) / 255
    const v = light ? (1 - l) * a : l * a
    const k = Math.min(1, Math.max(0, (v - t0) / (t1 - t0)))
    px[i*4] = ink[0]; px[i*4+1] = ink[1]; px[i*4+2] = ink[2]; px[i*4+3] = Math.round(Math.pow(k, 0.9) * 255)
  }
  x.putImageData(d, 0, 0)
  return c.toDataURL('image/webp', 0.9)
}, { data, w: Number(w), light: mode === 'claro' })
await writeFile(out, Buffer.from(res.split(',')[1], 'base64'))
await b.close()
console.log(out)
