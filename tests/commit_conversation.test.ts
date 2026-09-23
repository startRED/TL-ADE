import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main as showMain } from '../src/cli/show.ts'
import { openJournal } from '../src/journal/journal.ts'
import { formatMeasureTrailers, formatProvenanceTrailers, makerCallOf, provenanceOfCommit, storyMeasure } from '../src/telemetry/cost.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'
const DIGEST = '0123456789abcdef'

function telemetry(storyId: string, stepId: string, model: string, role = 'maker') {
  return buildModelTelemetry({
    mission_id: 'm-abc',
    story_id: storyId,
    step_id: stepId,
    family: 'claude',
    role,
    effort: 'default',
    models: [{ role: 'executor', model_id: model }],
    duration_ms: 60_000,
    tokens: { source: 'reported', input: 10, output: 5, cache_read: 0, cache_write: 0, usd: 0.25 },
    usage: undefined,
    pack: { sections: [{ section: 'contract', bytes: 10, digest: '1111111111111111' }], bytes: 10 },
    skills: [],
    sources: [],
    outcome: 'ok',
    ttft_ms: null,
    approval_decisions: 0,
    network_attempts: 0,
    files_touched: 1,
    tool_output_raw_bytes: 0,
    tool_output_model_bytes: 0,
  })
}

const COMMIT_OK = 'a'.repeat(40)
const COMMIT_USER = 'b'.repeat(40)
const COMMIT_MISSING = 'c'.repeat(40)
const COMMIT_SEM_ARTEFATO = 'd'.repeat(40)

const PROVENANCE = 'ADE-Missao: m-abc\nADE-Parte: S2\nADE-Rodada: 2\nADE-Modelo: claude-opus-5-5\nADE-Chamada: 418'

// Dublê da fronteira do git: devolve a mensagem de cada sha; sha desconhecido sai com 128.
function gitDouble(messages: Record<string, string>) {
  const calls: string[][] = []
  return {
    calls,
    gitPortFor: () => ({
      run: async (args: string[], options?: { okCodes?: number[] }) => {
        calls.push(args)
        const sha = args.at(-1) as string
        const text = messages[sha]
        const code = text === undefined ? 128 : 0
        if (!(options?.okCodes ?? [0]).includes(code)) throw new Error(`git saiu com ${code}`)
        return { code, stdout: Buffer.from(text ?? ''), stderr: text === undefined ? 'fatal: bad object' : '', text: (text ?? '').trim() }
      },
    }),
  }
}

let tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

// Missão com journal real: a chamada do maker S2 na rodada 2, com step_result e pack gravados.
async function missionRepo({ withPack = true, withResponse = true } = {}) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-commit-conv-'))
  tmpDirs.push(repoDir)
  const missionDir = path.join(repoDir, '.ade', 'missions', 'm-abc')
  const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
  await journal.append({ kind: 'story_started', unit: 'S2', data: { unit: 'S2', criteria: 1 } })
  await journal.append({ kind: 'telemetry', unit: 'S2', data: telemetry('S2', 'S2:r1:maker', 'claude-sonnet-5') })
  if (withResponse) {
    await journal.append({ kind: 'step_result', step_id: 'S2:r2:maker', effect_class: 'model_call', input_digest: DIGEST, status: 'ok', result: { result_text: 'RESPOSTA-DO-MAKER-R2', unit_result: { summary: 'feito' } }, criticality: 'core' })
  }
  const call = await journal.append({ kind: 'telemetry', unit: 'S2', data: telemetry('S2', 'S2:r2:maker', 'claude-opus-5-5') })
  if (withPack) {
    const packDir = path.join(missionDir, 'artifacts', 'packs', 'S2_r2_pack')
    fs.mkdirSync(packDir, { recursive: true })
    fs.writeFileSync(path.join(packDir, 'pack.md'), 'PACOTE-DA-RODADA-2\n', 'utf8')
  }
  const seq = Number(call.seq)
  return { repoDir, seq, message: `ade(S2): Parte dois\n\nADE-Criterios: 1\nADE-Arquivos: 1\nADE-Rodadas: 2\nADE-USD: 0.50\n${formatProvenanceTrailers({ mission: 'm-abc', story: 'S2', round: 2, model: 'claude-opus-5-5', callSeq: seq })}\n` }
}

function capture() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    out: () => out,
    err: () => err,
  }
}

describe('commit ligado à conversa que o gerou', () => {
  test('criterio_1_commit_da_rodada_2_traz_missao_parte_rodada_modelo_e_chamada_do_maker_alem_da_medida', () => {
    expect(formatProvenanceTrailers({ mission: 'm-abc', story: 'S2', round: 2, model: 'claude-opus-5-5', callSeq: 418 })).toBe(PROVENANCE)

    const events = [
      { seq: 1, kind: 'story_started', unit: 'S2', data: { unit: 'S2', criteria: 3 } },
      { seq: 10, kind: 'telemetry', unit: 'S2', data: telemetry('S2', 'S2:r1:maker', 'claude-sonnet-5') },
      { seq: 20, kind: 'review_result', unit: 'S2', data: { round: 1, approved: false } },
      { seq: 418, kind: 'telemetry', unit: 'S2', data: telemetry('S2', 'S2:r2:maker', 'claude-opus-5-5') },
      { seq: 419, kind: 'telemetry', unit: 'S2', data: telemetry('S2', 'S2:r2:checker', 'gpt-5.5', 'checker_round') },
      { seq: 420, kind: 'telemetry', unit: 'S3', data: telemetry('S3', 'S3:r1:maker', 'claude-haiku-4-5') },
      { seq: 421, kind: 'review_result', unit: 'S2', data: { round: 2, approved: true } },
    ]
    const call = makerCallOf(events, 'S2')
    expect(call).toEqual({ callSeq: 418, model: 'claude-opus-5-5' })

    const message = `ade(S2): Parte\n\n${formatMeasureTrailers(storyMeasure(events, 'S2'))}\n${formatProvenanceTrailers({ mission: 'm-abc', story: 'S2', round: 2, ...(call as { callSeq: number; model: string }) })}`
    expect(message).toContain('ADE-Criterios: 3\nADE-Arquivos: desconhecido\nADE-Rodadas: 2\nADE-USD: 0.75\n')
    expect(message.endsWith(PROVENANCE)).toBe(true)
    expect(provenanceOfCommit(message)).toEqual({ mission: 'm-abc', story: 'S2', round: 2, model: 'claude-opus-5-5', callSeq: 418 })
    expect(makerCallOf(events, 'S9')).toBeNull()
  })

  test('criterio_2_show_commit_mostra_missao_parte_rodada_modelo_pacote_e_resposta_da_chamada', async () => {
    const { repoDir, seq, message } = await missionRepo()
    const git = gitDouble({ [COMMIT_OK]: message })
    const io = capture()

    const code = await showMain(['--commit', COMMIT_OK], { ...io, cwd: repoDir, gitPortFor: git.gitPortFor })

    expect(io.err()).toBe('')
    expect(code).toBe(0)
    const out = io.out()
    expect(out).toContain('missão: m-abc')
    expect(out).toContain('parte: S2')
    expect(out).toContain('rodada: 2')
    expect(out).toContain('modelo: claude-opus-5-5')
    expect(out).toContain(`chamada: ${seq}`)
    expect(out).toContain('PACOTE-DA-RODADA-2')
    expect(out).toContain('RESPOSTA-DO-MAKER-R2')
    expect(out).not.toContain('ausente')
  })

  test('criterio_3_commit_do_usuario_sem_trailers_sai_com_erro_dizendo_que_nao_foi_o_motor', async () => {
    const { repoDir } = await missionRepo()
    const git = gitDouble({ [COMMIT_USER]: 'conserta o botão\n\nSigned-off-by: Erick <e@x>\n' })
    const io = capture()

    const code = await showMain(['--commit', COMMIT_USER], { ...io, cwd: repoDir, gitPortFor: git.gitPortFor })

    expect(code).not.toBe(0)
    expect(io.err()).toMatch(/não foi feito pelo motor/)
    expect(io.out()).toBe('')
    expect(provenanceOfCommit('conserta o botão\n\nSigned-off-by: Erick <e@x>\n')).toBeNull()
  })

  test('criterio_4_chamada_sem_pacote_ou_resposta_mostra_o_que_existe_e_diz_o_que_falta', async () => {
    const { repoDir, seq, message } = await missionRepo({ withPack: false, withResponse: false })
    const git = gitDouble({ [COMMIT_SEM_ARTEFATO]: message })
    const io = capture()

    const code = await showMain(['--commit', COMMIT_SEM_ARTEFATO], { ...io, cwd: repoDir, gitPortFor: git.gitPortFor })

    expect(code).toBe(0)
    const out = io.out()
    expect(out).toContain('missão: m-abc')
    expect(out).toContain(`chamada: ${seq}`)
    expect(out).toMatch(/pacote enviado: ausente/)
    expect(out).toMatch(/resposta gravada: ausente/)
  })

  test('criterio_5_sha_inexistente_sai_com_erro_nao_zero', async () => {
    const { repoDir } = await missionRepo()
    const git = gitDouble({})
    const io = capture()

    const code = await showMain(['--commit', COMMIT_MISSING], { ...io, cwd: repoDir, gitPortFor: git.gitPortFor })

    expect(code).not.toBe(0)
    expect(io.err()).toMatch(/commit não encontrado/)
    expect(io.out()).toBe('')

    // sha malformado nem chega ao git
    const io2 = capture()
    const code2 = await showMain(['--commit', '--open'], { ...io2, cwd: repoDir, gitPortFor: git.gitPortFor })
    expect(code2).not.toBe(0)
    expect(git.calls).toHaveLength(1)
  })

  test('borda_rodape_do_motor_incompleto_ou_com_missao_que_escapa_da_pasta_e_recusado', () => {
    expect(() => provenanceOfCommit('x\n\nADE-Missao: m-abc\nADE-Parte: S2\n')).toThrow(/rodapé/)
    expect(() => provenanceOfCommit(`x\n\n${PROVENANCE.replace('m-abc', '../fora')}`)).toThrow(/rodapé/)
    expect(() => provenanceOfCommit(`x\n\n${PROVENANCE.replace('ADE-Rodada: 2', 'ADE-Rodada: dois')}`)).toThrow(/rodapé/)
  })
})
