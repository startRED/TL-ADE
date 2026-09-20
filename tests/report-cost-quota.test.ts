import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main, renderReport, sumQuotaUsage, sumTokensByRole } from '../src/cli/report.js'
import { digest16 } from '../src/journal/canonical.js'
import { openJournal } from '../src/journal/journal.js'
import { buildRuntimeStamp } from '../src/journal/stamp.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir)
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tmpDirs = []
})

function makeSink(): { (s: string): void; write: (s: string) => void; readonly text: string } {
  let text = ''
  const fn = (s: string) => {
    text += s
  }
  fn.write = (s: string) => {
    text += s
  }
  Object.defineProperty(fn, 'text', {
    get() {
      return text
    },
  })
  return fn as { (s: string): void; write: (s: string) => void; readonly text: string }
}

async function makeJournal(
  events: Array<{ event: Record<string, unknown>; at?: Date | string }>,
  name = 'm1',
): Promise<string> {
  const root = makeTmpDir('ade-quota-test-')
  tmpDirs.push(root)
  const missionDir = path.join(root, name)
  let currentTime = new Date('2026-09-20T12:00:00.000Z')
  const runtimeStamp = buildRuntimeStamp({
    configDigest: digest16({}),
    capabilitiesDigest: digest16({}),
  })
  const journal = openJournal({
    missionDir,
    runtimeStamp,
    now: () => currentTime,
  })
  for (const item of events) {
    if (item.at) {
      currentTime = typeof item.at === 'string' ? new Date(item.at) : item.at
    }
    const cleanEvent = { ...item.event }
    delete (cleanEvent as Record<string, unknown>).at
    await journal.append(cleanEvent)
  }
  await journal.close()
  return missionDir
}

describe('relatório de custo e cota (ade report --quota)', () => {
  // CA1: Dados dois relatos de custo do papel maker, um de US$ 0,0123 e outro de US$ 0,02,
  // mais uma chamada sem relato, quando o relatório é gerado,
  // então a linha de custo mostra 3 chamadas, 1 sem relato e US$ 0,0323.
  test('ca1_custos_conhecidos_e_desconhecidos_na_linha_de_custo', async () => {
    const rawEvents = [
      {
        kind: 'telemetry',
        data: {
          role: 'maker',
          step_id: 's1:r1:maker',
          tokens: {
            input: 100,
            cache_write: 20,
            cache_read: 500,
            output: 40,
            usd: 0.0123,
            source: 'reported',
          },
        },
      },
      {
        kind: 'telemetry',
        data: {
          role: 'maker',
          step_id: 's1:r2:maker',
          tokens: {
            input: 200,
            cache_write: 0,
            cache_read: 0,
            output: 60,
            usd: 0.02,
            source: 'reported',
          },
        },
      },
      {
        kind: 'telemetry',
        data: {
          role: 'maker',
          step_id: 's1:r3:maker',
          tokens: {
            source: 'unavailable',
          },
        },
      },
    ]

    const costs = sumTokensByRole(rawEvents)
    expect(costs).toEqual([
      {
        role: 'maker',
        calls: 3,
        unavailable_calls: 1,
        input: 300,
        cache_write: 20,
        cache_read: 500,
        output: 100,
        usd: expect.closeTo(0.0323, 4),
      },
    ])

    const dir = await makeJournal([
      { event: { kind: 'story_started', data: { unit: 'ADE-T1' } } },
      { event: rawEvents[0] },
      { event: rawEvents[1] },
      { event: rawEvents[2] },
      { event: { kind: 'story_done', data: { unit: 'ADE-T1', status: 'committed', commit: 'c12345678901' } } },
    ])

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir], { env: {}, stdout, stderr })
    expect(exitCode).toBe(0)

    const reportContent = readFileSync(path.join(dir, 'report.md'), 'utf8')
    expect(reportContent).toContain('## Custo por papel')
    expect(reportContent).toMatch(/\|\s*maker\s*\|\s*3\s*\|\s*1\s*\|.*\|\s*0\.0323\s*\|/)
    expect(stderr.text).toBe('')
  })

  // CA2: Dada telemetria claude/maker com input 100, cache_write 20, cache_read 500 e output 40,
  // quando --quota é usado, então o consumo exibido é 640 tokens, identificado por família, papel e dia UTC.
  test('ca2_consumo_de_cota_ignora_cache_write_e_agrupa_por_dia_familia_papel', async () => {
    const fixedTime = '2026-09-20T10:00:00.000Z'
    const telemetryEvent = {
      kind: 'telemetry',
      data: {
        family: 'claude',
        role: 'maker',
        tokens: {
          input: 100,
          cache_write: 20,
          cache_read: 500,
          output: 40,
          source: 'reported',
        },
      },
    }

    const dir = await makeJournal([
      { event: { kind: 'story_started', data: { unit: 'ADE-T2' } }, at: fixedTime },
      { event: telemetryEvent, at: fixedTime },
      { event: { kind: 'story_done', data: { unit: 'ADE-T2', status: 'committed', commit: 'c23456789012' } }, at: fixedTime },
    ])

    const eventsWithAt = [
      {
        ...telemetryEvent,
        at: fixedTime,
      },
    ]

    const quotaUsage = sumQuotaUsage(eventsWithAt, new Date(fixedTime).getTime())
    expect(quotaUsage.daily).toEqual([
      {
        day: '2026-09-20',
        family: 'claude',
        role: 'maker',
        quota_tokens: 640,
        unavailable_calls: 0,
      },
    ])

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir, '--quota'], {
      env: {},
      stdout,
      stderr,
      now: () => new Date(fixedTime).getTime(),
    })
    expect(exitCode).toBe(0)

    const reportContent = readFileSync(path.join(dir, 'report.md'), 'utf8')
    expect(reportContent).toContain('2026-09-20')
    expect(reportContent).toContain('claude')
    expect(reportContent).toContain('maker')
    expect(reportContent).toContain('640')
    expect(reportContent).not.toContain('660') // 100+500+40 = 640; não pode somar cache_write (20)
  })

  // CA3: Dados eventos dentro e fora das janelas em relação a 2026-09-20T12:00:00.000Z,
  // quando --quota é usado, então os totais das últimas 5 horas e dos últimos 7 dias incluem somente os eventos pertencentes a cada janela.
  // Exemplo: evento com 4 horas -> entra em 5 h e 7 dias; evento com 8 dias -> não entra em nenhuma janela.
  test('ca3_janelas_de_5_horas_e_7_dias_incluem_apenas_eventos_do_periodo', async () => {
    const nowMs = new Date('2026-09-20T12:00:00.000Z').getTime()
    const at0h = '2026-09-20T12:00:00.000Z'
    const at4h = '2026-09-20T08:00:00.000Z'
    const at8d = '2026-09-12T12:00:00.000Z'

    const events = [
      {
        kind: 'telemetry',
        at: at0h,
        data: {
          family: 'claude',
          role: 'maker',
          tokens: { input: 100, cache_read: 0, output: 0, source: 'reported' },
        },
      },
      {
        kind: 'telemetry',
        at: at4h,
        data: {
          family: 'claude',
          role: 'maker',
          tokens: { input: 200, cache_read: 0, output: 0, source: 'reported' },
        },
      },
      {
        kind: 'telemetry',
        at: at8d,
        data: {
          family: 'claude',
          role: 'maker',
          tokens: { input: 400, cache_read: 0, output: 0, source: 'reported' },
        },
      },
    ]

    const quotaUsage = sumQuotaUsage(events, nowMs)
    expect(quotaUsage.windows).toEqual([
      {
        family: 'claude',
        role: 'maker',
        last_5h: 300, // 100 (em 12:00) + 200 (em 08:00, 4h atrás)
        last_7d: 300, // 100 + 200; 400 (8 dias atrás) fica fora de ambas
      },
    ])

    const dir = await makeJournal([
      { event: { kind: 'story_started', data: { unit: 'ADE-T3' } }, at: at8d },
      { event: events[2], at: at8d },
      { event: events[1], at: at4h },
      { event: events[0], at: at0h },
      { event: { kind: 'story_done', data: { unit: 'ADE-T3', status: 'committed', commit: 'c34567890123' } }, at: at0h },
    ])

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir, '--quota'], {
      env: {},
      stdout,
      stderr,
      now: () => nowMs,
    })
    expect(exitCode).toBe(0)

    const reportContent = readFileSync(path.join(dir, 'report.md'), 'utf8')
    expect(reportContent).toMatch(/\|\s*claude\s*\|\s*maker\s*\|\s*300\s*\|\s*300\s*\|/)
    const windowSection = reportContent.slice(reportContent.indexOf('## Janelas de cota'))
    expect(windowSection).not.toContain('700')
  })

  // CA4: Dado um recibo oficial mais recente com 20% usados, 10% reservados e reinício em 2026-09-27T00:00:00.000Z,
  // quando --quota é usado, então esses valores aparecem como medição oficial;
  // chamadas com tokens indisponíveis aparecem como indisponíveis e não aumentam totais numéricos.
  test('ca4_recibo_oficial_mais_recente_e_telemetria_indisponivel', async () => {
    const fixedNow = new Date('2026-09-20T12:00:00.000Z').getTime()
    const events = [
      {
        kind: 'budget_reserved',
        at: '2026-09-19T00:00:00.000Z',
        data: {
          family: 'claude',
          quota_receipt: {
            source: 'official',
            family: 'claude',
            used_percent: 15,
            reserved_percent: 5,
            observed_at: '2026-09-19T00:00:00.000Z',
            weekly_reset_at: '2026-09-27T00:00:00.000Z',
          },
        },
      },
      {
        kind: 'budget_reserved',
        at: '2026-09-20T00:00:00.000Z',
        data: {
          family: 'claude',
          quota_receipt: {
            source: 'official',
            family: 'claude',
            used_percent: 20,
            reserved_percent: 10,
            observed_at: '2026-09-20T00:00:00.000Z',
            weekly_reset_at: '2026-09-27T00:00:00.000Z',
          },
        },
      },
      {
        kind: 'telemetry',
        at: '2026-09-20T08:00:00.000Z',
        data: {
          family: 'claude',
          role: 'maker',
          tokens: {
            source: 'unavailable',
          },
        },
      },
    ]

    const quotaUsage = sumQuotaUsage(events, fixedNow)
    // O recibo mais recente deve ser preservado literalmente
    expect(quotaUsage.receipts).toEqual([
      {
        family: 'claude',
        used_percent: 20,
        reserved_percent: 10,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      },
    ])
    // Telemetria indisponível não aumenta totais numéricos
    expect(quotaUsage.daily).toEqual([
      {
        day: '2026-09-20',
        family: 'claude',
        role: 'maker',
        quota_tokens: 0,
        unavailable_calls: 1,
      },
    ])

    const dir = await makeJournal([
      { event: { kind: 'story_started', data: { unit: 'ADE-T4' } }, at: '2026-09-19T00:00:00.000Z' },
      { event: events[0], at: '2026-09-19T00:00:00.000Z' },
      { event: events[1], at: '2026-09-20T00:00:00.000Z' },
      { event: events[2], at: '2026-09-20T08:00:00.000Z' },
      { event: { kind: 'story_done', data: { unit: 'ADE-T4', status: 'committed', commit: 'c45678901234' } }, at: '2026-09-20T08:00:00.000Z' },
    ])

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir, '--quota'], {
      env: {},
      stdout,
      stderr,
      now: () => fixedNow,
    })
    expect(exitCode).toBe(0)

    const reportContent = readFileSync(path.join(dir, 'report.md'), 'utf8')
    expect(reportContent).toContain('20%')
    expect(reportContent).toContain('10%')
    expect(reportContent).toContain('2026-09-27T00:00:00.000Z')
    expect(reportContent).toContain('indisponível')
  })

  test('recibo_oficial_ordem_inversa_seleciona_observed_at_mais_recente', async () => {
    const fixedNow = new Date('2026-09-20T12:00:00.000Z').getTime()
    const events = [
      {
        kind: 'budget_reserved',
        at: '2026-09-20T00:00:00.000Z',
        data: {
          family: 'claude',
          quota_receipt: {
            source: 'official',
            family: 'claude',
            used_percent: 25,
            reserved_percent: 12,
            observed_at: '2026-09-20T00:00:00.000Z',
            weekly_reset_at: '2026-09-27T00:00:00.000Z',
          },
        },
      },
      {
        kind: 'budget_reserved',
        at: '2026-09-20T01:00:00.000Z',
        data: {
          family: 'claude',
          quota_receipt: {
            source: 'official',
            family: 'claude',
            used_percent: 15,
            reserved_percent: 5,
            observed_at: '2026-09-18T00:00:00.000Z',
            weekly_reset_at: '2026-09-27T00:00:00.000Z',
          },
        },
      },
    ]

    const quotaUsage = sumQuotaUsage(events, fixedNow)
    expect(quotaUsage.receipts).toEqual([
      {
        family: 'claude',
        used_percent: 25,
        reserved_percent: 12,
        observed_at: '2026-09-20T00:00:00.000Z',
        weekly_reset_at: '2026-09-27T00:00:00.000Z',
      },
    ])
  })

  test('relatorio_renderiza_custo_e_cota_quando_journal_nao_possui_unidades', async () => {
    const fixedNow = new Date('2026-09-20T12:00:00.000Z').getTime()
    const dir = await makeJournal([
      {
        event: {
          kind: 'budget_reserved',
          data: {
            family: 'claude',
            quota_receipt: {
              source: 'official',
              family: 'claude',
              used_percent: 20,
              reserved_percent: 10,
              observed_at: '2026-09-20T00:00:00.000Z',
              weekly_reset_at: '2026-09-27T00:00:00.000Z',
            },
          },
        },
        at: '2026-09-20T00:00:00.000Z',
      },
      {
        event: {
          kind: 'telemetry',
          data: {
            family: 'claude',
            role: 'maker',
            tokens: {
              input: 100,
              cache_write: 0,
              cache_read: 200,
              output: 50,
              usd: 0.015,
              source: 'reported',
            },
          },
        },
        at: '2026-09-20T10:00:00.000Z',
      },
    ])

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir, '--quota'], {
      env: {},
      stdout,
      stderr,
      now: () => fixedNow,
    })
    expect(exitCode).toBe(0)

    const directRender = renderReport('m1', [], [{ role: 'maker', calls: 1, unavailable_calls: 0, input: 100, cache_write: 0, cache_read: 200, output: 50, usd: 0.015 }])
    expect(directRender).toContain('Nenhuma unidade registrada.')
    expect(directRender).toContain('## Custo por papel')

    const reportContent = readFileSync(path.join(dir, 'report.md'), 'utf8')
    expect(reportContent).toContain('Nenhuma unidade registrada.')
    expect(reportContent).not.toContain('## Próximos passos')
    expect(reportContent).toContain('## Custo por papel')
    expect(reportContent).toContain('| maker | 1 | 0 | 100 | 0 | 200 | 50 | 0.0150 |')
    expect(reportContent).toContain('## Cota por dia UTC')
    expect(reportContent).toContain('| 2026-09-20 | claude | maker | 350 | 0 |')
    expect(reportContent).toContain('## Janelas de cota')
    expect(reportContent).toContain('| claude | maker | 350 | 350 |')
    expect(reportContent).toContain('## Recibos oficiais')
    expect(reportContent).toContain('| claude | 20% | 10% | 2026-09-20T00:00:00.000Z | 2026-09-27T00:00:00.000Z |')
  })
})
