import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { projectUnits } from '../../src/cli/project.js'
import { main } from '../../src/cli/status.js'
import { digest16 } from '../../src/journal/canonical.js'
import { openJournal } from '../../src/journal/journal.js'
import { buildRuntimeStamp } from '../../src/journal/stamp.js'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'

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
  // quando main(['--mission',dir]) de src/cli/status.js roda, então sai com 0 e o stdout é
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

