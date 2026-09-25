// Ponto de virada em modo dublê: painel real, `ade run --plan` real, só a fronteira de modelo trocada.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTurningPointRecord, runTurningPoint } from '../src/evals/turning-point.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXAMPLE = path.join(ROOT, 'examples', 'ponto-de-virada')
const FIXTURES = path.join(ROOT, 'fixtures', 'ponto-de-virada')
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false }).trim()

const tmps: string[] = []
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmps.push(d)
  return d
}

/** Repositório da ADE dublê: git próprio com os planos da página Modelos em .ade/config.json. */
function adeRepo(plans: Record<string, string>): string {
  const dir = tmp('ade-pv-repo-')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'])
  fs.mkdirSync(path.join(dir, '.ade'))
  fs.writeFileSync(path.join(dir, '.ade', 'config.json'), JSON.stringify({ models: { plans } }))
  return dir
}

const exampleTree = () => git(ROOT, ['ls-files', '-s', '--', 'examples/ponto-de-virada']) + git(ROOT, ['diff', '--stat', '--', 'examples/ponto-de-virada'])

describe('ade dogfood: ponto de virada', () => {
  it('caminho_feliz_painel_motor_real_filas_por_plano_revisao_de_outra_empresa', async () => {
    const repo = adeRepo({ claude: 'max20', codex: 'pro20' })
    const out = path.join(tmp('ade-pv-out-'), 'registro.md')
    const before = exampleTree()
    const headBefore = git(repo, ['rev-parse', 'HEAD'])

    const { exitCode, record } = await runTurningPoint({ exampleDir: EXAMPLE, adeRepoDir: repo, outPath: out, mode: 'double' })

    const parsed = parseTurningPointRecord(fs.readFileSync(out, 'utf8'))
    expect(parsed.get('resultado'), JSON.stringify(record)).toBe('entregue')
    expect(exitCode).toBe(0)
    expect(parsed.get('origem')).toBe('dublê')
    expect(parsed.get('estagios')).toBe('interview → briefing → plan → running → concluida')
    expect(Number(parsed.get('perguntas'))).toBeGreaterThan(0)
    expect(parsed.get('resposta_1')).toContain('→')
    expect(parsed.get('story_status')).toMatch(/^(committed|delivered)$/)
    expect(parsed.get('prova_vermelha')).toBe('red_valid')
    expect(parsed.get('prova_verde')).toBe('green')
    expect(parsed.get('fila_origem')).toBe('planos')
    expect(parsed.get('maker')).toBe(parsed.get('fila_impl'))
    expect(parsed.get('checker')).toBe(parsed.get('fila_checker'))
    expect(parsed.get('verdict')).toBe('approved')
    expect(parsed.get('revisor_familia')).not.toBe(parsed.get('maker')?.split('/')[0])
    expect(parsed.get('revisao_outra_empresa')).toBe('sim')
    expect(parsed.get('cadeia')).toBe('valida')
    expect(Number(parsed.get('custo_usd_informativo'))).toBeGreaterThanOrEqual(0)
    expect(parsed.get('remotos')).toBe('nenhum')
    expect(parsed.get('head_ade_inalterado')).toBe('sim')

    const copy = parsed.get('copia') as string
    const branch = parsed.get('branch') as string
    expect(branch).toBe(`ade/${parsed.get('mission_id')}/PV-1`)
    expect(git(copy, ['rev-parse', `refs/heads/${branch}`])).toBe(parsed.get('commit'))
    expect(git(copy, ['show', `${branch}:src/nomes.mjs`])).toContain('export function iniciais')
    expect(git(copy, ['remote'])).toBe('')
    expect(exampleTree()).toBe(before)
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
    tmps.push(path.dirname(copy))
  }, 180_000)

  it('recusa_com_codigo_4_quando_os_planos_cobrem_uma_empresa_so', async () => {
    for (const plans of [{ claude: 'max20' }, {}] as Array<Record<string, string>>) {
      const out = path.join(tmp('ade-pv-out-'), 'registro.md')
      await expect(runTurningPoint({ exampleDir: EXAMPLE, adeRepoDir: adeRepo(plans), outPath: out, mode: 'double' }))
        .rejects.toMatchObject({ exitCode: 4, message: 'a revisão exige outra empresa: configure o plano de uma segunda família na página Modelos' })
      expect(fs.existsSync(out)).toBe(false)
    }
  })

  it('parada_em_awaiting_operator_escreve_registro_e_sai_diferente_de_zero', async () => {
    // Cenário da parada: o Checker pede mudanças de decisão, e a story fica com o operador.
    const scenarioDir = tmp('ade-pv-fixtures-')
    fs.cpSync(FIXTURES, scenarioDir, { recursive: true })
    const checkerFile = path.join(scenarioDir, 'scenario', 'checker.json')
    const checker = JSON.parse(fs.readFileSync(checkerFile, 'utf8'))
    checker[0].result.verdict = 'changes_requested'
    checker[0].result.requested_action = 'decide'
    checker[0].result.handoff.next_action = 'decide'
    checker[0].result.action_items = [{ id: 'A1', severity: 'high', category: 'intent_gap', summary: 'decisão do operador', evidence: 'eval:E1' }]
    fs.writeFileSync(checkerFile, JSON.stringify(checker))
    const out = path.join(tmp('ade-pv-out-'), 'registro.md')

    const { exitCode } = await runTurningPoint({ exampleDir: EXAMPLE, adeRepoDir: adeRepo({ claude: 'max20', codex: 'pro20' }), outPath: out, mode: 'double', scenarioDir })

    const parsed = parseTurningPointRecord(fs.readFileSync(out, 'utf8'))
    expect(parsed.get('resultado')).toBe('parada')
    expect(parsed.get('motivo')).toBeTruthy()
    expect(exitCode).not.toBe(0)
    tmps.push(path.dirname(parsed.get('copia') as string))
  }, 180_000)
})
