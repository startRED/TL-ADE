import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { main as doctorMain } from '../src/cli/doctor.ts'
import { main as docsMain } from '../src/cli/docs.ts'
import { generateDocProjections, syncDocProjections } from '../src/docs/projection.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

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

function makeSink() {
  let text = ''
  return {
    write: (s: string) => {
      text += s
    },
    get text() {
      return text
    },
  }
}

/** Eventos como o motor os emite (antes de `Journal.append` mover o extra para `data`). */
const CANONICAL_APPENDS: Array<Record<string, unknown>> = [
  { kind: 'story_started', unit: 'U-VAL' },
  { kind: 'step_intent', unit: 'U-VAL', step_id: 'eval:u-val:green:tree1', effect_class: 'eval_run' },
  {
    kind: 'step_result',
    step_id: 'eval:u-val:green:tree1',
    effect_class: 'eval_run',
    status: 'ok',
    result: { eval_id: 'u-val', phase: 'green', verdict: 'green' },
  },
  { kind: 'review_result', unit: 'U-VAL', data: { round: 1, approved: true, verdict: 'approved' } },
  { kind: 'story_done', unit: 'U-VAL', data: { status: 'delivered', reason: null, commit: 'c01111111111' } },

  { kind: 'story_started', unit: 'U-IMP' },
  { kind: 'story_done', unit: 'U-IMP', data: { status: 'delivered', reason: null, commit: 'c02222222222' } },

  { kind: 'story_started', unit: 'U-IND' },
  {
    kind: 'story_done',
    unit: 'U-IND',
    data: { status: 'awaiting_operator', reason: 'family_without_canary', commit: null },
  },

  { kind: 'story_started', unit: 'U-PEN' },
  {
    kind: 'story_done',
    unit: 'U-PEN',
    data: { status: 'awaiting_operator', reason: 'rework_exhausted', commit: null },
  },
]

/**
 * Grava o journal com o próprio `Journal.append` do motor (envelope, cadeia e canonicalização
 * reais) e devolve os eventos relidos por `readJournal`.
 */
async function writeCanonicalJournal(repoDir: string): Promise<Array<Record<string, unknown>>> {
  const missionDir = path.join(repoDir, '.ade', 'missions', 'm-1')
  mkdirSync(missionDir, { recursive: true })
  let minute = 0
  const journal = openJournal({
    missionDir,
    runtimeStamp: '1:aaaaaaaa:bbbbbbbb',
    now: () => new Date(Date.UTC(2026, 8, 20, 10, minute++, 0)),
  })
  for (const ev of CANONICAL_APPENDS) await journal.append(ev)
  await journal.close()
  return readJournal(path.join(missionDir, 'journal.jsonl')).events
}

/** Devolve o conteúdo da seção de `current-status.md` que contém o rótulo pedido. */
function sectionOf(markdown: string, heading: string): string {
  const parts = markdown.split(/^## /m)
  const found = parts.find((p) => p.startsWith(heading))
  if (!found) throw new Error(`seção ausente: ${heading}`)
  return found
}

describe('projeção documental sobre o journal canônico do motor', () => {
  test('cada unidade cai na seção exata derivada das evidências canônicas', async () => {
    const repoDir = makeTmpDir('ade-docs-canon-')
    tmpDirs.push(repoDir)

    const projections = generateDocProjections({ journalEvents: await writeCanonicalJournal(repoDir) })
    const status = projections['current-status.md']

    expect(sectionOf(status, 'Unidades Validadas')).toContain('U-VAL')
    expect(sectionOf(status, 'Unidades Implementadas')).toContain('U-IMP')
    expect(sectionOf(status, 'Unidades Indisponíveis')).toContain('U-IND')
    expect(sectionOf(status, 'Unidades Pendentes')).toContain('U-PEN')

    // Nenhuma unidade aparece em duas categorias
    expect(sectionOf(status, 'Unidades Validadas')).not.toContain('U-IMP')
    expect(sectionOf(status, 'Unidades Implementadas')).not.toContain('U-VAL')
    expect(sectionOf(status, 'Unidades Pendentes')).not.toContain('U-IND')

    // A marca temporal vem do último evento, não do relógio
    expect(status).toContain('2026-09-20T10:10:00Z')
  })

  test('ade docs sync duas vezes produz bytes idênticos sem injeção de timestamp', async () => {
    const repoDir = makeTmpDir('ade-docs-repro-')
    tmpDirs.push(repoDir)

    await writeCanonicalJournal(repoDir)

    const first = await docsMain(['sync', '--repo', repoDir], { stdout: makeSink(), stderr: makeSink() })
    expect(first).toBe(0)
    const afterFirst = readGenerated(repoDir)

    const second = await docsMain(['sync', '--repo', repoDir], { stdout: makeSink(), stderr: makeSink() })
    expect(second).toBe(0)
    expect(readGenerated(repoDir)).toEqual(afterFirst)
  })

  test('fonte ausente vira indisponível e fonte inválida aborta sem escrever projeção parcial', async () => {
    const repoDir = makeTmpDir('ade-docs-sources-')
    tmpDirs.push(repoDir)

    // Sem .ade/capabilities.json: capacidade é indisponível, nunca homologada por padrão
    syncDocProjections({ repoDir })
    const caps = readFileSync(path.join(repoDir, 'docs', 'generated', 'capabilities.md'), 'utf8')
    expect(caps).toMatch(/indispon[íi]vel/i)
    expect(caps).not.toContain('claude-sonnet-5')

    // capabilities.json corrompido: erro com código de saída, não sucesso silencioso
    mkdirSync(path.join(repoDir, '.ade'), { recursive: true })
    writeFileSync(path.join(repoDir, '.ade', 'capabilities.json'), '{ isto não é json', 'utf8')
    const stderr = makeSink()
    const exit = await docsMain(['sync', '--repo', repoDir], { stdout: makeSink(), stderr })
    expect(exit).toBe(2)
    expect(stderr.text).toMatch(/capability set inválido/i)

    // JSON bem formado mas fora do capability-set.schema.json também é fonte inválida
    writeFileSync(
      path.join(repoDir, '.ade', 'capabilities.json'),
      JSON.stringify({ format_version: 1, models: [] }),
      'utf8',
    )
    const schemaStderr = makeSink()
    const schemaExit = await docsMain(['sync', '--repo', repoDir], {
      stdout: makeSink(),
      stderr: schemaStderr,
    })
    expect(schemaExit).toBe(2)
    expect(schemaStderr.text).toMatch(/capability-set\.schema\.json/)
  })

  test('ade doctor --docs aponta evidência antiga sem injeção programática', async () => {
    const repoDir = makeTmpDir('ade-docs-stale-')
    tmpDirs.push(repoDir)

    const srcFile = path.join(repoDir, 'src', 'feature.js')
    mkdirSync(path.dirname(srcFile), { recursive: true })
    writeFileSync(srcFile, 'export const v = 2\n', 'utf8')

    const docsDir = path.join(repoDir, 'docs')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(
      path.join(docsDir, 'spec.md'),
      `---\nverified_at: 2020-01-01T00:00:00.000Z\ncites:\n  - src/feature.js\n---\n# Spec\n`,
      'utf8',
    )

    const stdout = makeSink()
    const exit = await doctorMain(['--docs', '--repo', repoDir], { stdout, stderr: makeSink(), env: {} })
    expect(exit).toBe(0)
    expect(stdout.text).toMatch(/Documentos desatualizados: 1/)
    expect(stdout.text).toMatch(/src\/feature\.js/)
  })
})

/** Lê as quatro projeções geradas, para comparar execuções byte a byte. */
function readGenerated(repoDir: string): Record<string, string> {
  const dir = path.join(repoDir, 'docs', 'generated')
  const names = ['current-status.md', 'capabilities.md', 'architecture-map.md', 'quality-report.md']
  return Object.fromEntries(names.map((n) => [n, readFileSync(path.join(dir, n), 'utf8')]))
}
