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
  test('codex_falha_e_vale_a_opiniao_do_claude_lendo_as_capturas', async () => {
    const { dir, captures, deps } = setup()
    const codex = fakeCli(dir, 'codex', 'process.stderr.write("usage limit"); process.exit(1)')
    const claude = fakeCli(dir, 'claude', `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: ${JSON.stringify(RESULT)} }))`)
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, deps,
      judges: [{ family: 'codex', model_id: 'gpt-6-sol', resolved: codex }, { family: 'claude', model_id: 'claude-opus-5-5', resolved: claude }],
    })
    expect(evaluation.verdict).toBe('pass')
    expect(evaluation.judge).toEqual({ family: 'claude', model_id: 'claude-opus-5-5' })
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'claude.args.json'), 'utf8'))
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read', '--add-dir', path.dirname(captures[0].path), '--model', 'claude-opus-5-5']))
  })

  test('codex_recebe_as_capturas_anexadas', async () => {
    const { dir, captures, deps } = setup()
    // o resultado vai no arquivo de -o, como no codex real
    const codex = fakeCli(dir, 'codex', `const a = process.argv.slice(2); fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify(${JSON.stringify(RESULT)}))`)
    const evaluation = await judgeVisual({ captures, task: 't', designBrief: {}, deps, judges: [{ family: 'codex', model_id: 'gpt-6-sol', resolved: codex }] })
    expect(evaluation.verdict).toBe('pass')
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'codex.args.json'), 'utf8'))
    expect(args).toContain(`--image=${path.resolve(captures[0].path)}`)
  })

  // Julgar imagem não é revisar o próprio código: os dois juízes olham a mesma tela e as opiniões se cruzam
  test('dois_juizes_cruzam_media_por_criterio_e_juntam_defeitos', async () => {
    const { dir, captures, deps } = setup()
    const withScore = (score: number, defects: any[]) => ({ criteria: RESULT.criteria.map((c) => ({ ...c, score: c.score === null ? null : score })), defects })
    const codex = fakeCli(dir, 'codex', `const a = process.argv.slice(2); fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify(${JSON.stringify(withScore(8, [{ id: 'd1', severity: 'minor', criterion: 'typography', where: 'x', fix: 'fonte 15px' }]))}))`)
    const claude = fakeCli(dir, 'claude', `process.stdout.write(JSON.stringify({ is_error: false, structured_output: ${JSON.stringify(withScore(6, [{ id: 'd1', severity: 'major', criterion: 'typography', where: 'x', fix: 'fonte 16px' }, { id: 'd2', severity: 'critical', criterion: 'color', where: 'y', fix: 'tema escuro' }]))} }))`)
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, deps,
      judges: [{ family: 'claude', model_id: 'claude-opus-5-5', resolved: claude }, { family: 'codex', model_id: 'gpt-6-sol', resolved: codex }],
    })
    expect(evaluation.judge).toEqual({ family: 'claude+codex', model_id: 'claude-opus-5-5+gpt-6-sol' })
    expect(evaluation.criteria.find((c) => c.id === 'hierarchy')!.score).toBe(7)
    expect(evaluation.criteria.find((c) => c.id === 'hierarchy')!.note).toContain('(notas claude 6, codex 8)')
    // o que os dois viram no mesmo critério vem primeiro; cada defeito diz quem apontou
    expect(evaluation.defects.map((d) => d.id)).toEqual(['claude:d1', 'codex:d1', 'claude:d2'])
    expect(evaluation.verdict).toBe('rework')
  })

  // um juiz fora do ar não tira o veredito; os dois fora dão "sem veredito" com o motivo de cada um. O Gemini não julga.
  test('gemini_nunca_julga_e_todos_falhando_da_sem_veredito', async () => {
    const { dir, captures, deps } = setup()
    const fail = fakeCli(dir, 'codex', 'process.exit(2)')
    const gemini = fakeCli(dir, 'agy', 'process.exit(0)')
    const evaluation = await judgeVisual({
      captures, task: 't', designBrief: {}, deps,
      judges: [{ family: 'agy', model_id: 'gemini-3.1-pro', resolved: gemini }, { family: 'codex', model_id: 'gpt-6-sol', resolved: fail }],
    })
    expect(fs.existsSync(path.join(dir, 'agy.args.json'))).toBe(false)
    expect(evaluation.verdict).toBe('unknown')
    expect(evaluation.defects[0].fix).toMatch(/^Nenhum juiz respondeu: codex: juiz visual encerrou com 2/)
  })

  // rubrica v2: a nota é base 5 mais os ajustes observados, e cada ponto fica escrito na nota gravada
  test('nota_vem_da_base_mais_ajustes_e_cada_ponto_fica_na_nota', async () => {
    const { dir, captures, deps } = setup()
    const raw = {
      criteria: RESULT.criteria.map((c) => c.id === 'typography'
        ? { ...c, score: 9, adjustments: [{ delta: 1.5, observation: 'escala com 3 tamanhos bem separados' }, { delta: -1, observation: 'ajuda com 12px em 390px' }] }
        : { ...c, adjustments: c.score === null ? [] : [{ delta: 3, observation: 'bom' }] }),
      defects: [],
    }
    const claude = fakeCli(dir, 'claude', `process.stdout.write(JSON.stringify({ is_error: false, structured_output: ${JSON.stringify(raw)} }))`)
    const evaluation = await judgeVisual({ captures, task: 't', designBrief: {}, deps, judges: [{ family: 'claude', model_id: 'claude-opus-5-5', effort: 'high', resolved: claude }] })
    const typography = evaluation.criteria.find((c) => c.id === 'typography')!
    expect(typography.score).toBe(5.5)
    expect(typography.note).toContain('+1.5 escala com 3 tamanhos bem separados; -1 ajuda com 12px em 390px')
    expect(evaluation.criteria.find((c) => c.id === 'motion')!.score).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'claude.args.json'), 'utf8'))).toEqual(expect.arrayContaining(['--effort', 'high']))
    expect(fs.existsSync(path.join(dir, 'visual-judge-raw-r1-claude.json'))).toBe(true)
  })
})
