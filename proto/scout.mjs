#!/usr/bin/env node
// Batedor da TL-ADE: Gemini (via Antigravity, `agy`) lê muito e devolve pouco, para os outros modelos não gastarem
// tokens lendo. Só leitura. Imprime um recibo curto (markdown) ou, com --json, o objeto do recibo.
//   node scout.mjs [--web] [--json] [--model gemini-3.8-flash-medium] "pergunta objetiva" [arquivo ...]
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true }
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
const web = flag('--web'), asJson = flag('--json')
const model = opt('--model', process.env.ADE_SCOUT_MODEL || 'gemini-3.8-flash-medium')
const [question, ...files] = argv
if (!question) { console.error('uso: node scout.mjs [--web] [--json] [--model m] "pergunta" [arquivo ...]'); process.exit(2) }

const SCHEMA = JSON.stringify({
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, lines: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'lines', 'why'] } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'facts', 'files', 'sources'],
})
const prompt = [
  'Você é o batedor da TL-ADE: lê muito e devolve pouco. Outra IA vai usar a sua resposta para planejar ou corrigir código sem reler nada.',
  'Responda em português, no JSON exigido, SÓ com o que foi pedido ou o que muda o plano ou a correção. Nada de descrição geral do projeto, nada de opinião, nada de sugestão fora da pergunta.',
  'summary: até 8 linhas. facts: até 12 fatos curtos e verificáveis (nomes de funções e assinaturas, rotas, formatos, versões, regras). files: só os arquivos que interessam, cada um com lines (ex.: "120-210") e why. sources: URLs se pesquisou fora; senão [].',
  files.length ? `Comece por estes arquivos: ${files.join(', ')}.` : 'Leia o projeto atual só onde for preciso (busque por nome e conteúdo antes de abrir arquivos).',
  web ? 'Pode pesquisar na internet e no GitHub; cite a URL de cada fato externo.' : 'Não pesquise fora do projeto.',
  'Só leitura: não edite, não crie e não rode nada que altere arquivos.',
  'PRAZO: você tem 4 minutos e no máximo 12 leituras ou buscas. Passou disso, pare e responda com o que já tem; recibo parcial vale, recibo que não chega não vale nada.',
  `Pergunta: ${question}`,
].join(' ')

const r = spawnSync('agy', ['--print', prompt, '--output-format', 'json', '--model', model, '--mode', 'plan', '--json-schema', SCHEMA, '--dangerously-skip-permissions', '--print-timeout', '6m'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 6.5 * 60 * 1000, windowsHide: true })
let rec = null, usage = null
try {
  const j = JSON.parse(r.stdout)
  usage = j.usage || null
  // o agy nem sempre respeita o schema à risca: a resposta pode vir dentro de um bloco ```json
  const raw = typeof j.response === 'string' ? j.response.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '') : null
  rec = raw != null ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : j.response
} catch {}
if (!rec?.summary) { console.error(`batedor sem resposta (código ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`); process.exit(1) }
if (asJson) { console.log(JSON.stringify({ ...rec, usage, model })); process.exit(0) }
console.log(`RECIBO DO BATEDOR (${model})\n${rec.summary}\n`)
if (rec.facts?.length) console.log(`Fatos:\n${rec.facts.map((f) => `- ${f}`).join('\n')}\n`)
if (rec.files?.length) console.log(`Arquivos (leia só o trecho):\n${rec.files.map((f) => `- ${f.path} linhas ${f.lines}: ${f.why}`).join('\n')}\n`)
if (rec.sources?.length) console.log(`Fontes:\n${rec.sources.map((s) => `- ${s}`).join('\n')}`)
