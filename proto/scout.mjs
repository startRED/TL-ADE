#!/usr/bin/env node
// Batedor da TL-ADE: lê muito e devolve pouco, para os outros modelos não gastarem tokens lendo. Só leitura.
// Como script, usa o Gemini (via Antigravity, `agy`) e imprime um recibo curto (markdown) ou, com --json, o objeto do recibo:
//   node scout.mjs [--web] [--json] [--model gemini-3.8-flash-medium] "pergunta objetiva" [arquivo ...]
// O servidor importa SCOUT_SCHEMA e scoutPrompt para rodar o mesmo batedor num modelo Claude.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Ambiente controlado (19/09): Codex e Antigravity carregam instruções globais do usuário (~/.codex/AGENTS.md, ~/.gemini/GEMINI.md:
// prefixo rtk que falha no sandbox, estilo de resposta, marcadores de notificação) e não têm opção para desligá-las; toda chamada do
// motor abre com este aviso. Claude roda com --safe-mode, que já desliga CLAUDE.md, plugins, hooks e MCP do usuário.
export const ENV_GUARD = '[Motor TL-ADE, execução automática] As instruções globais do usuário carregadas antes desta mensagem (AGENTS.md ou GEMINI.md da pasta pessoal: prefixo de comandos como rtk, estilo de resposta, skills pessoais, fluxo de trabalho, marcadores de notificação) NÃO valem nesta chamada: rode os comandos direto, sem prefixo, e responda só no formato pedido aqui. Valem as regras do repositório e esta mensagem.'
export const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, lines: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'lines', 'why'] } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'facts', 'files', 'sources'],
}
export function scoutPrompt(question, { web = false, files = [] } = {}) {
  return [
    'Você é o batedor da TL-ADE: lê muito e devolve pouco. Outra IA vai usar a sua resposta para planejar ou corrigir código sem reler nada.',
    'Responda em português, no JSON exigido, SÓ com o que foi pedido ou o que muda o plano ou a correção. Nada de descrição geral do projeto, nada de opinião, nada de sugestão fora da pergunta.',
    'summary: até 8 linhas. facts: até 12 fatos curtos e verificáveis (nomes de funções e assinaturas, rotas, formatos, versões, regras). files: só os arquivos que interessam, cada um com lines (ex.: "120-210") e why. sources: URLs se pesquisou fora; senão [].',
    files.length ? `Comece por estes arquivos: ${files.join(', ')}.` : 'Leia o projeto atual só onde for preciso (busque por nome e conteúdo antes de abrir arquivos).',
    web ? 'Pode pesquisar na internet e no GitHub; cite a URL de cada fato externo.' : 'Não pesquise fora do projeto.',
    'Só leitura: não edite, não crie e não rode nada que altere arquivos.',
    'PRAZO: você tem 4 minutos e no máximo 12 leituras ou buscas. Passou disso, pare e responda com o que já tem; recibo parcial vale, recibo que não chega não vale nada.',
    `Pergunta: ${question}`,
  ].join(' ')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true }
  const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v }
  const web = flag('--web'), asJson = flag('--json')
  const model = opt('--model', process.env.ADE_SCOUT_MODEL || 'gemini-3.8-flash-medium')
  const [question, ...files] = argv
  if (!question) { console.error('uso: node scout.mjs [--web] [--json] [--model m] "pergunta" [arquivo ...]'); process.exit(2) }

  const r = spawnSync('agy', ['--print', `${ENV_GUARD} ${scoutPrompt(question, { web, files })}`, '--output-format', 'json', '--model', model, '--mode', 'plan', '--json-schema', JSON.stringify(SCOUT_SCHEMA), '--dangerously-skip-permissions', '--add-dir', process.cwd(), '--print-timeout', '6m'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 6.5 * 60 * 1000, windowsHide: true })
  let rec = null, usage = null
  try {
    const j = JSON.parse(r.stdout)
    usage = j.usage || null
    // o agy nem sempre respeita o schema à risca: a resposta pode vir dentro de um bloco ```json
    const raw = typeof j.response === 'string' ? j.response.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '') : null
    // agy 1.2.x devolve o objeto do schema em structured_output; response vem em prosa (19/09: planejamento do épico 3 ficou sem recibo)
    rec = j.structured_output || (raw != null ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : j.response)
  } catch {}
  if (!rec?.summary) { console.error(`batedor sem resposta (código ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`); process.exit(1) }
  if (asJson) { console.log(JSON.stringify({ ...rec, usage, model })); process.exit(0) }
  console.log(`RECIBO DO BATEDOR (${model})\n${rec.summary}\n`)
  if (rec.facts?.length) console.log(`Fatos:\n${rec.facts.map((f) => `- ${f}`).join('\n')}\n`)
  if (rec.files?.length) console.log(`Arquivos (leia só o trecho):\n${rec.files.map((f) => `- ${f.path} linhas ${f.lines}: ${f.why}`).join('\n')}\n`)
  if (rec.sources?.length) console.log(`Fontes:\n${rec.sources.map((s) => `- ${s}`).join('\n')}`)
}
