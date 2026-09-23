// Missão de demonstração para olhar o painel: seis partes como a v5 (3 prontas, 1 tocando na rodada 3, 2 na fila).
// uso: node demo-fixture.ts <pasta-destino>
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { compileIntent } from '../../../src/intent/compiler.ts'
import { openJournal } from '../../../src/journal/journal.ts'

const dir = path.resolve(process.argv[2])
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const git = (args: string[]) => execFileSync('git', args, { cwd: dir, maxBuffer: 1 << 26, encoding: 'utf8' })
git(['init', '-b', 'main'])
for (const [k, v] of [['user.name', 'ADE Demo'], ['user.email', 'demo@local'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(['config', k, v])
writeFileSync(path.join(dir, 'app.js'), 'export const soma = (a, b) => a + b\nexport const titulo = "Agenda"\n')
git(['add', '.']); git(['commit', '-m', 'base'])
const base = git(['rev-parse', 'HEAD']).trim()
writeFileSync(path.join(dir, 'app.js'), 'export const soma = (a, b) => a + b\nexport const titulo = "Painel novo"\nexport const versao = 5\n')
git(['add', '.']); git(['commit', '-m', 'ade(V5-1): painel novo'])
const head = git(['rev-parse', 'HEAD']).trim()

const MISSION = 'M-v5-demo'
const DISCOVERY = { repo: { head: 'HEAD', dirty: false }, scripts: { test: 'node --test' }, languages: [{ name: 'javascript', share: 1 }], anchors: [], ui: { present: true } }
const advisor = async () => ({ complexity: 'bounded', confidence: 0.9, domains: ['frontend'], rationale: 'demo', cost: { usd: 0, model_calls: 1, model_id: 'demo' } })
const { plan, contracts } = await compileIntent({ request: 'Painel real faz tudo o que o painel da demo faz, com provas.', discovery: DISCOVERY, advisor, unknowns: [] })
const parts = [
  ['V5-1', 'Painel novo servido do último build'],
  ['V5-2', 'Pedido, entrevista, briefing e plano'],
  ['V5-3', 'Partes com passos, diff e parecer'],
  ['V5-4', 'Chat com cópia e cartão de permissão'],
  ['V5-5', 'Página Modelos com filas e cota'],
  ['V5-6', 'Skills, plugins e opções'],
] as const
const missionDir = path.join(dir, '.ade', 'missions', MISSION)
mkdirSync(path.join(missionDir, 'stories'), { recursive: true })
writeFileSync(path.join(missionDir, 'plan.json'), JSON.stringify({ ...plan, mission_id: MISSION, intent: 'Painel real faz tudo o que a demo faz, com provas', phases: [{ epics: [{ stories: parts.map((p) => p[0]) }] }] }))
for (const [id, title] of parts) writeFileSync(path.join(missionDir, 'stories', `${id}.json`), JSON.stringify({ ...contracts[0], id, title, roles: { ...(contracts[0] as any).roles, maker: { family: 'claude', model_id: 'claude-opus-5-5', effort: 'xhigh' } } }))

const journal = openJournal({ missionDir, runtimeStamp: '1:abc123:def456' })
const step = async (unit: string, id: string, effect: string, status?: string, cost?: number) => {
  await journal.append({ kind: 'step_intent', step_id: id, effect_class: effect, unit })
  if (effect === 'model_call' && status) await journal.append({ kind: 'model_call', unit, data: { unit, cost_usd: cost ?? 0.8 } })
  if (status) await journal.append({ kind: 'step_result', step_id: id, effect_class: effect, status })
}
const review = (unit: string, round: number, approved: boolean, items: Array<{ id: string; severity: string; problem: string }>) =>
  journal.append({ kind: 'review_result', unit, data: { round, approved, verdict: approved ? 'approved' : 'changes_requested', result: { verdict: approved ? 'approved' : 'changes_requested', action_items: items } } })

for (const [i, [id]] of parts.slice(0, 3).entries()) {
  await journal.append({ kind: 'story_started', unit: id, data: { unit: id, base_before: base } })
  await step(id, `${id}:prepare`, 'prepare', 'ok')
  await step(id, `eval:${id}:red:t0`, 'eval_run', 'ok')
  await step(id, `${id}:r1:maker`, 'model_call', 'ok', 2.1 + i)
  await step(id, `eval:${id}:green:t1`, 'eval_run', 'ok')
  await step(id, `${id}:r1:review`, 'model_call', 'ok', 0.6)
  if (i === 1) { await review(id, 1, false, [{ id: 'F1', severity: 'high', problem: 'A recusa do plano não volta para a caixa de pedido.' }]); await step(id, `${id}:r2:maker`, 'model_call', 'ok', 1.4); await step(id, `${id}:r2:review`, 'model_call', 'ok', 0.5) }
  await review(id, i === 1 ? 2 : 1, true, [{ id: 'F9', severity: 'low', problem: 'Um comentário repete o código.' }])
  await step(id, `${id}:deliver`, 'deliver', 'ok')
  await journal.append({ kind: 'story_done', unit: id, data: { unit: id, status: 'delivered', commit: i === 0 ? head : base } })
}
await journal.append({ kind: 'story_started', unit: 'V5-4', data: { unit: 'V5-4', base_before: head } })
await step('V5-4', 'V5-4:prepare', 'prepare', 'ok')
await step('V5-4', 'eval:V5-4:red:t0', 'eval_run', 'ok')
await step('V5-4', 'V5-4:r1:maker', 'model_call', 'ok', 3.4)
await step('V5-4', 'eval:V5-4:green:t1', 'eval_run', 'failed')
await step('V5-4', 'V5-4:r1:review', 'model_call', 'ok', 0.7)
await review('V5-4', 1, false, [{ id: 'F2', severity: 'high', problem: 'O cartão aplica a mudança antes da permissão.' }])
await step('V5-4', 'V5-4:r2:maker', 'model_call', 'ok', 2.2)
await step('V5-4', 'V5-4:r2:review', 'model_call', 'ok', 0.6)
await review('V5-4', 2, false, [{ id: 'F3', severity: 'medium', problem: 'Falta o estado de erro quando a cópia some.' }])
await step('V5-4', 'V5-4:r3:maker', 'model_call')
await journal.close()
console.log(dir)
