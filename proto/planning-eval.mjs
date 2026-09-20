// Avalia o prompt real sem importar/iniciar o servidor nem executar as stories.
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLANNING_POLICY, planIssues, versionProgram } from './planning.mjs'

export async function planningSamples() {
  const source = await fs.readFile(new URL('./server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function planPrompt(')
  const end = source.indexOf('// ---------- pacote de contexto', start)
  const samples = [
    { id: 'pequena', request: 'Corrija total(itens): hoje soma só preco, mas precisa multiplicar por qtd. Preserve qtd ausente como 1.', difficulty: 'easy', map: 'src/precos.js exporta total(itens). tests/precos.test.js usa node:test. A função atual usa itens.reduce((s,i) => s + i.preco, 0).' },
    { id: 'media', request: 'Adicionar tarefas com título, conclusão, filtro por estado e persistência no localStorage no aplicativo existente. Incluir testes e atualizar o README.', difficulty: 'normal', map: 'src/App.jsx contém a tela; src/tasks.js contém operações de tarefas; src/storage.js envolve localStorage; tests/tasks.test.js usa vitest. Sem servidor nem login.' },
    { id: 'grande', request: 'Concluir v0.2: retomada durável sem duplicar efeitos após crash, paridade de testes, preflight e orçamento antes de chamadas, revisão independente e entrega em remoto Git local de teste. Preservar APIs e proibir push externo.', difficulty: 'hard', map: 'Já existem src/journal, src/step, src/engine.js, src/gates e src/adapters. Testes em tests/parity. Faltam integração do preflight, cenários de recuperação e revisão. Os comandos obrigatórios são vitest, tsc --noEmit e lint. Não alterar schemas públicos.' },
  ]
  let schema
  for (const sample of samples) {
    const context = vm.createContext({ PLANNING_POLICY,
      BRIEF_QUESTIONS: { type: 'array', items: { type: 'string' } },
      attachBlock: () => '', scoutBlock: () => '', skillsBlock: () => '',
      state: { settings: { assets_enabled: false }, toolchains: ['node'],
        project: { name: sample.id, dir: '.', files: 20, language: 'js', runner: 'node', test_cmd: 'node --test', has_index: false },
        mission: { request: sample.request, intent: { summary: sample.request, domains: ['backend'], difficulty: sample.difficulty }, map: sample.map, skills: { planner: [] } } },
    })
    vm.runInContext(source.slice(start, end) + '\nglobalThis.prompt = planPrompt(); globalThis.schema = PLAN_JSON_SCHEMA;', context)
    sample.prompt = context.prompt
    schema = JSON.parse(JSON.stringify(context.schema))
  }
  return { samples, schema }
}

async function main() {
  const batch = await planningSamples()
  const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7)
  const samples = batch.samples.filter(s => !selected || s.id === selected), schema = batch.schema
  if (!samples.length) throw new Error('Caso de avaliação desconhecido')
  const root = fileURLToPath(new URL('./.ade/planning-eval/', import.meta.url))
  await fs.mkdir(root, { recursive: true })
  const batchSchema = { type: 'object', additionalProperties: false, properties: Object.fromEntries(samples.map(s => [s.id, schema])), required: samples.map(s => s.id) }
  await fs.writeFile(path.join(root, 'schema.json'), JSON.stringify(batchSchema))
  const prompt = 'Avaliação de planejamento, sem executar código nem usar ferramentas. Os mapas abaixo são fixtures suficientes, não caminhos a explorar. Produza um plano completo por caso, seguindo seu prompt. Retorne apenas o JSON solicitado.\n' + samples.map(s => `CASO ${s.id}\n${s.prompt}`).join('\n\n')
  await fs.writeFile(path.join(root, 'prompt.txt'), prompt)
  if (!process.argv.includes('--live')) { console.log(JSON.stringify({ samples: samples.map(s => ({ id: s.id, prompt_chars: s.prompt.length })), live: false })); return }
  const binary = process.env.CODEX_BINARY
  if (!binary) throw new Error('Defina CODEX_BINARY com o executável nativo do Codex')
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-planning-eval-'))
  const started = Date.now()
  const result = await new Promise((resolve, reject) => {
    const child = execFile(binary, ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-c', 'skills.max_context_tokens=1', '-c', 'model_reasoning_effort="medium"', '-m', 'gpt-5.6-luna', '--output-schema', path.join(root, 'schema.json'), '-'], { cwd, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr.slice(-1000)}`)) : resolve(stdout))
    child.stdin.end(prompt)
  })
  const events = result.trim().split('\n').map(l => JSON.parse(l))
  const message = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text
  const plans = JSON.parse(message)
  const findings = samples.map(s => ({ id: s.id, stories: plans[s.id]?.stories?.length, issues: planIssues(plans[s.id]), titles: plans[s.id]?.stories?.map(st => st.title) }))
  const report = { at: new Date().toISOString(), model: 'gpt-5.6-luna', wall_ms: Date.now() - started, usage: events.find(e => e.type === 'turn.completed')?.usage, findings, plans,
    versions: ['v0.2', 'v0.3', 'v0.4a', 'v0.4b', 'v0.5', 'v1'].map(name => versionProgram({ versions: [{ name, goal: `Entregar ${name}`, includes: [`Aceite de ${name}`] }] })) }
  await fs.writeFile(path.join(root, selected ? `result-${selected}.json` : 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ wall_ms: report.wall_ms, usage: report.usage, findings }))
  if (findings.some(f => f.issues.length)) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
