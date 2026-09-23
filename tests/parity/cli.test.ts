import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main as indexMain } from '../../src/cli/index.ts'
import { main as journalMain } from '../../src/cli/journal.ts'
import { projectUnits } from '../../src/cli/project.ts'
import { main as reportMain, renderReport } from '../../src/cli/report.ts'
import { main } from '../../src/cli/status.ts'
import { digest16 } from '../../src/journal/canonical.ts'
import { openJournal } from '../../src/journal/journal.ts'
import { buildRuntimeStamp } from '../../src/journal/stamp.ts'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.ts'

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
  events: Array<Record<string, unknown>>,
  name = 'm1',
): Promise<string> {
  const root = makeTmpDir('ade-cli-test-')
  tmpDirs.push(root)
  const missionDir = path.join(root, name)
  const runtimeStamp = buildRuntimeStamp({
    configDigest: digest16({}),
    capabilitiesDigest: digest16({}),
  })
  const journal = openJournal({ missionDir, runtimeStamp })
  for (const ev of events) {
    await journal.append(ev)
  }
  await journal.close()
  return missionDir
}

describe('ade status', () => {
  // CA1: Dado um journal com story_started e story_done {unit:'ADE-T1', status:'committed', commit:'abc123def4567890'},
  // quando main(['--mission',dir]) de src/cli/status.ts roda, então sai com 0 e o stdout é
  // 'missão <basename> (seq 2)\nADE-T1 committed abc123def456\n'
  // Borda: projectUnits([]) -> []
  test('status_prints_committed_unit', async () => {
    expect(projectUnits([])).toEqual([])

    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'committed',
            commit: 'abc123def4567890',
          },
        },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe('missão m1 (seq 2)\nADE-T1 committed abc123def456\n')
    expect(stderr.text).toBe('')
  })

  // CA2: Dado um journal com story_done {unit:'ADE-T1', status:'awaiting_operator', reason:'gate_failed'},
  // quando main(['--mission',dir]) roda, então sai com 3 e a linha da unidade é
  // 'ADE-T1 awaiting_operator (gate_failed)'
  test('status_exits_3_when_awaiting_operator', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'awaiting_operator',
            reason: 'gate_failed',
          },
        },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(3)
    expect(stdout.text).toBe('missão m1 (seq 2)\nADE-T1 awaiting_operator (gate_failed)\n')
    expect(stderr.text).toBe('')
  })

  // CA3: Dado o mesmo journal de CA1, quando main(['--mission',dir,'--json']) roda,
  // então o stdout é o JSON canônico de {mission, last_seq:2, open_intents:0, units:[{unit:'ADE-T1', status:'committed', reason:null, commit:'abc123def4567890'}]}
  // seguido de '\n'
  test('status_json_is_canonical', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'committed',
            commit: 'abc123def4567890',
          },
        },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main(['--mission', dir, '--json'], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe(
      '{"last_seq":2,"mission":"m1","open_intents":0,"units":[{"commit":"abc123def4567890","reason":null,"status":"committed","unit":"ADE-T1"}]}\n',
    )
    expect(stderr.text).toBe('')
  })

  // CA4: Dado main([], {env:{}}) sem --mission e sem ADE_MISSION_DIR, quando roda,
  // então sai com 4 e o stderr contém 'uso: ade status --mission <pasta> [--json]'
  test('status_without_mission_exits_4', async () => {
    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await main([], { env: {}, stdout, stderr })

    expect(exitCode).toBe(4)
    expect(stderr.text).toContain('uso: ade status --mission <pasta> [--json]')

    // Caso de journal ausente: missionDir informado mas sem journal.jsonl
    const missingDir = path.join(makeTmpDir('ade-cli-test-'), 'missing')
    tmpDirs.push(missingDir)
    const stdout2 = makeSink()
    const stderr2 = makeSink()
    const exitCode2 = await main(['--mission', missingDir], { env: {}, stdout: stdout2, stderr: stderr2 })
    expect(exitCode2).toBe(4)
    expect(stderr2.text).toContain(`journal ausente: ${path.join(missingDir, 'journal.jsonl')}`)
  })

  test('project_units_normalizes_non_string_reason_and_commit', () => {
    const units = projectUnits([
      {
        kind: 'story_done',
        data: {
          unit: 'ADE-T1',
          status: 'committed',
          reason: 7,
          commit: {},
        },
      },
    ])
    expect(units).toEqual([
      {
        unit: 'ADE-T1',
        status: 'committed',
        reason: null,
        commit: null,
      },
    ])
  })
})

describe('ade journal', () => {
  // CA1: Dado um journal com os eventos seq 1 story_started ADE-T1 e seq 2 story_done ADE-T1,
  // quando main(['--mission',dir]) de src/cli/journal.ts roda, então sai com 0 e o stdout é
  // '1 story_started ADE-T1\n2 story_done ADE-T1\n'
  test('journal_lists_events_in_order', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        { kind: 'story_done', data: { unit: 'ADE-T1' } },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await journalMain(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe('1 story_started ADE-T1\n2 story_done ADE-T1\n')
    expect(stderr.text).toBe('')

    // Exemplo: evento com step_id -> '3 step_result ADE-T1 ADE-T1:commit'
    const dirWithStep = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        { kind: 'story_done', data: { unit: 'ADE-T1' } },
        { kind: 'step_result', unit: 'ADE-T1', step_id: 'ADE-T1:commit' },
      ],
      'm1-step',
    )
    const stdoutStep = makeSink()
    const stderrStep = makeSink()
    const exitCodeStep = await journalMain(['--mission', dirWithStep], {
      env: {},
      stdout: stdoutStep,
      stderr: stderrStep,
    })
    expect(exitCodeStep).toBe(0)
    expect(stdoutStep.text).toBe(
      '1 story_started ADE-T1\n2 story_done ADE-T1\n3 step_result ADE-T1 ADE-T1:commit\n',
    )
    expect(stderrStep.text).toBe('')
  })

  // CA2: Dado o mesmo journal, quando main(['--mission',dir,'--unit','ADE-X9']) roda,
  // então sai com 0 e o stdout é 'nenhum evento\n'
  test('journal_unit_filter_without_match_prints_nothing_found', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        { kind: 'story_done', data: { unit: 'ADE-T1' } },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await journalMain(
      ['--mission', dir, '--unit', 'ADE-X9'],
      { env: {}, stdout, stderr },
    )

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe('nenhum evento\n')
    expect(stderr.text).toBe('')
  })

  // CA3: Dado o journal com um caractere trocado na linha 2,
  // quando o main de src/cli/index.ts recebe ['journal','--mission',dir], então devolve 2
  test('tampered_journal_command_exits_2', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        { kind: 'story_done', data: { unit: 'ADE-T1' } },
        { kind: 'step_result', unit: 'ADE-T1' },
      ],
      'm1',
    )

    const journalPath = path.join(dir, 'journal.jsonl')
    const content = readFileSync(journalPath, 'utf8')
    const lines = content.split('\n')
    // Adulterar trocando um caractere da linha 2
    lines[1] = lines[1].replace('ADE-T1', 'ADE-TX')
    writeFileSync(journalPath, lines.join('\n'), 'utf8')

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await indexMain(['journal', '--mission', dir], {
      env: {},
      stdout,
      stderr,
    })

    expect(exitCode).toBe(2)
  })

  // CA4: Dado env {ADE_MISSION_DIR: dir} e nenhum --mission,
  // quando main([], {env}) de src/cli/journal.ts roda, então sai com 0 e lista os mesmos 2 eventos de CA1
  test('journal_uses_ade_mission_dir_env', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        { kind: 'story_done', data: { unit: 'ADE-T1' } },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await journalMain([], {
      env: { ADE_MISSION_DIR: dir },
      stdout,
      stderr,
    })

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe('1 story_started ADE-T1\n2 story_done ADE-T1\n')
    expect(stderr.text).toBe('')

    // Sem missão: sai com 4 e mensagem de uso no stderr
    const stdoutMissing = makeSink()
    const stderrMissing = makeSink()
    const exitCodeMissing = await journalMain([], {
      env: {},
      stdout: stdoutMissing,
      stderr: stderrMissing,
    })

    expect(exitCodeMissing).toBe(4)
    expect(stderrMissing.text).toContain('uso: ade journal --mission <pasta> [--unit <id>]')

    // Journal inexistente: sai com 4 e 'journal ausente: ...' no stderr
    const missingDir = path.join(makeTmpDir('ade-cli-test-'), 'missing')
    tmpDirs.push(missingDir)
    const stdoutMissingJournal = makeSink()
    const stderrMissingJournal = makeSink()
    const exitCodeMissingJournal = await journalMain(['--mission', missingDir], {
      env: {},
      stdout: stdoutMissingJournal,
      stderr: stderrMissingJournal,
    })
    expect(exitCodeMissingJournal).toBe(4)
    expect(stderrMissingJournal.text).toContain(
      `journal ausente: ${path.join(missingDir, 'journal.jsonl')}`,
    )
  })
})

describe('ade report', () => {
  // CA1: Dado um journal na missão 'm1' com ADE-T1 committed (commit 'abc123def4567890'),
  // quando main(['--mission',dir]) de src/cli/report.ts roda, então sai com 0 e <dir>/report.md
  // contém a linha '| ADE-T1 | committed | - | abc123def456 |' e a linha '- ADE-T1: git merge --ff-only ade/m1/ADE-T1'
  test('report_lists_units_and_merge_command', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'committed',
            commit: 'abc123def4567890',
          },
        },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await reportMain(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    const reportPath = path.join(dir, 'report.md')
    const content = readFileSync(reportPath, 'utf8')
    expect(content).toContain('| ADE-T1 | committed | - | abc123def456 |')
    expect(content).toContain('- ADE-T1: git merge --ff-only ade/m1/ADE-T1')
    expect(stdout.text).toBe(`relatório: ${reportPath}\n`)
    expect(stderr.text).toBe('')
  })

  // CA2: Dado ADE-T2 em awaiting_operator com reason 'gate_failed',
  // quando o report roda, então o arquivo contém '| ADE-T2 | awaiting_operator | gate_failed | - |'
  // e '- ADE-T2: resolver awaiting_operator (gate_failed)'
  test('report_explains_awaiting_operator', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T2' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T2',
            status: 'awaiting_operator',
            reason: 'gate_failed',
          },
        },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await reportMain(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    const reportPath = path.join(dir, 'report.md')
    const content = readFileSync(reportPath, 'utf8')
    expect(content).toContain('| ADE-T2 | awaiting_operator | gate_failed | - |')
    expect(content).toContain('- ADE-T2: resolver awaiting_operator (gate_failed)')
    expect(stderr.text).toBe('')
  })

  // CA3: Dado env {ADE_MISSION_DIR: dir} sem --mission e `--out <tmp>/saida.md`,
  // quando main(['--out', saida], {env}) roda, então o arquivo é gravado nesse caminho
  // e o stdout é 'relatório: <caminho absoluto de saida.md>\n'
  test('report_uses_ade_mission_dir_env_and_out_path', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'committed',
            commit: 'abc123def4567890',
          },
        },
      ],
      'm1',
    )

    const outDir = makeTmpDir('ade-cli-report-')
    tmpDirs.push(outDir)
    const outPath = path.join(outDir, 'saida.md')

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await reportMain(['--out', outPath], {
      env: { ADE_MISSION_DIR: dir },
      stdout,
      stderr,
    })

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe(`relatório: ${path.resolve(outPath)}\n`)
    expect(readFileSync(outPath, 'utf8')).toContain('| ADE-T1 | committed | - | abc123def456 |')
    expect(stderr.text).toBe('')

    // Borda: sem missão sai com 4 e stderr 'uso: ade report --mission <pasta> [--out <arquivo>]'
    const stdoutMissing = makeSink()
    const stderrMissing = makeSink()
    const exitMissing = await reportMain([], {
      env: {},
      stdout: stdoutMissing,
      stderr: stderrMissing,
    })
    expect(exitMissing).toBe(4)
    expect(stderrMissing.text).toContain('uso: ade report --mission <pasta> [--out <arquivo>]')

    // Borda: journal inexistente sai com 4 e stderr 'journal ausente: <caminho>'
    const missingDir = path.join(makeTmpDir('ade-cli-report-'), 'missing')
    tmpDirs.push(missingDir)
    const stdoutNoJournal = makeSink()
    const stderrNoJournal = makeSink()
    const exitNoJournal = await reportMain(['--mission', missingDir], {
      env: {},
      stdout: stdoutNoJournal,
      stderr: stderrNoJournal,
    })
    expect(exitNoJournal).toBe(4)
    expect(stderrNoJournal.text).toContain(
      `journal ausente: ${path.join(missingDir, 'journal.jsonl')}`,
    )
  })

  // CA4: Dado um journal sem nenhuma unidade (só eventos sem unit),
  // quando o report roda, então o arquivo contém 'Nenhuma unidade registrada.'
  // e não contém '## Próximos passos'
  test('report_without_units_says_so', async () => {
    expect(renderReport('m1', [])).toBe(
      '# Relatório da missão m1\n\nNenhuma unidade registrada.\n',
    )

    const dir = await makeJournal(
      [
        { kind: 'random_event', data: { foo: 'bar' } },
      ],
      'm1',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await reportMain(['--mission', dir], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    const reportPath = path.join(dir, 'report.md')
    const content = readFileSync(reportPath, 'utf8')
    expect(content).toContain('Nenhuma unidade registrada.')
    expect(content).not.toContain('## Próximos passos')
    expect(stdout.text).toBe(`relatório: ${reportPath}\n`)
    expect(stderr.text).toBe('')
  })

  test('report_with_quota_flag_adds_quota_sections_compatibly', async () => {
    const dir = await makeJournal(
      [
        { kind: 'story_started', data: { unit: 'ADE-T1' } },
        {
          kind: 'telemetry',
          data: {
            family: 'claude',
            role: 'maker',
            tokens: { input: 100, cache_read: 200, output: 50, source: 'reported' },
          },
        },
        {
          kind: 'story_done',
          data: {
            unit: 'ADE-T1',
            status: 'committed',
            commit: 'abc123def4567890',
          },
        },
      ],
      'm1-quota',
    )

    const stdout = makeSink()
    const stderr = makeSink()
    const exitCode = await reportMain(['--mission', dir, '--quota'], { env: {}, stdout, stderr })

    expect(exitCode).toBe(0)
    const reportPath = path.join(dir, 'report.md')
    const content = readFileSync(reportPath, 'utf8')
    expect(content).toContain('| ADE-T1 | committed | - | abc123def456 |')
    expect(content).toContain('## Cota por dia UTC')
    expect(content).toContain('## Janelas de cota')
    expect(content).toContain('## Recibos oficiais')
    expect(stdout.text).toBe(`relatório: ${reportPath}\n`)
    expect(stderr.text).toBe('')
  })
})
