import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { judgeVisual } from '../src/visual/judge.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-judge-')); dirs.push(d); return d }

const RESULT = {
  criteria: ['specificity', 'hierarchy', 'typography', 'color', 'states', 'motion'].map((id) => ({ id, score: id === 'motion' ? null : 8, note: 'ok' })),
  defects: [],
}

/** CLI falsa: grava os argumentos recebidos e responde como a empresa responderia (ou falha). */
function fakeCli(dir: string, name: string, body: string) {
  const script = path.join(dir, `${name}.mjs`)
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(path.join(dir, `${name}.args.json`))}, JSON.stringify(process.argv.slice(2)))\n${body}\n`)
  return { exe: process.execPath, prefixArgs: [script] }
}

function setup() {
  const dir = tmp()
  const shot = path.join(dir, 'artifacts', 'visual', 't', '_-390-light.png')
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  fs.writeFileSync(shot, 'png')
  const captures = [{ path: shot, route: '/', width: 390, theme: 'light', sha256: 'x' }]
  return { dir, captures, deps: { cwd: dir, missionDir: dir, requireDispatch: true } }
}

describe('juiz visual de qualquer empresa', () => {
  // 25/09: o juiz só podia ser Codex; sem Codex (cota, binário) a avaliação visual não tinha veredito
  test('codex_falha_e_o_claude_julga_lendo_as_capturas', async () => {
    const { dir, captures, deps } = setup()
    const codex = fakeCli(dir, 'codex', 'process.stderr.write("usage limit"); process.exit(1)')
    const claude = fakeCli(dir, 'claude', `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: ${JSON.stringify(RESULT)} }))`)
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, makerFamily: 'agy', deps,
      judges: [{ family: 'codex', model_id: 'gpt-6-sol', resolved: codex }, { family: 'claude', model_id: 'claude-opus-5-5', resolved: claude }],
    })
    expect(evaluation.verdict).toBe('pass')
    expect(evaluation.judge).toEqual({ family: 'claude', model_id: 'claude-opus-5-5' })
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'claude.args.json'), 'utf8'))
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read', '--add-dir', path.dirname(captures[0].path), '--model', 'claude-opus-5-5']))
  })

  test('gemini_julga_pela_resposta_em_texto_do_agy', async () => {
    const { dir, captures, deps } = setup()
    const agy = fakeCli(dir, 'agy', `process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: '\`\`\`json\\n' + JSON.stringify(${JSON.stringify(RESULT)}) + '\\n\`\`\`' }))`)
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, makerFamily: 'claude', deps,
      judges: [{ family: 'agy', model_id: 'gemini-3.1-pro-high', resolved: agy }],
    })
    expect(evaluation.verdict).toBe('pass')
    expect(evaluation.judge.family).toBe('agy')
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'agy.args.json'), 'utf8'))
    expect(args).toEqual(expect.arrayContaining(['--mode', 'plan', '--model', 'gemini-3.1-pro-high']))
  })

  test('codex_recebe_as_capturas_anexadas', async () => {
    const { dir, captures, deps } = setup()
    // o resultado vai no arquivo de -o, como no codex real
    const codex = fakeCli(dir, 'codex', `const a = process.argv.slice(2); fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify(${JSON.stringify(RESULT)}))`)
    const evaluation = await judgeVisual({ captures, task: 't', designBrief: {}, makerFamily: 'claude', deps, judges: [{ family: 'codex', model_id: 'gpt-6-sol', resolved: codex }] })
    expect(evaluation.verdict).toBe('pass')
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'codex.args.json'), 'utf8'))
    expect(args).toContain(`--image=${path.resolve(captures[0].path)}`)
  })

  test('empresa_que_escreveu_a_tela_nunca_julga_e_todos_falhando_da_sem_veredito', async () => {
    const { dir, captures, deps } = setup()
    const fail = fakeCli(dir, 'agy', 'process.exit(2)')
    const claude = fakeCli(dir, 'claude', 'process.exit(0)')
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, makerFamily: 'claude', deps,
      judges: [{ family: 'claude', model_id: 'claude-opus-5-5', resolved: claude }, { family: 'agy', model_id: 'gemini-3.1-pro', resolved: fail }],
    })
    expect(fs.existsSync(path.join(dir, 'claude.args.json'))).toBe(false)
    expect(evaluation.verdict).toBe('unknown')
    expect(evaluation.defects[0].fix).toMatch(/Nenhum juiz respondeu: agy: juiz visual encerrou com 2/)
  })
})
