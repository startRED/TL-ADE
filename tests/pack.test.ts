import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'
import { compilePack, SECTION_CAPS, SECTION_ORDER } from '../src/pack/pack.js'
import { AdeError } from '../src/journal/errors.js'
import { redactText } from '../src/pack/redact.js'

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

function makeMissionDir(prefix: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

/** Extrai o corpo de uma seção do texto do pack (entre o cabeçalho dela e o próximo, ou o fim). */
function extractSectionBody(packText: string, section: string): string {
  const marker = `=== ade:section ${section} ===\n`
  const start = packText.indexOf(marker)
  expect(start, `cabeçalho da seção ${section} deve existir no pack`).toBeGreaterThanOrEqual(0)
  const bodyStart = start + marker.length
  const nextHeaderIdx = packText.indexOf('=== ade:section ', bodyStart)
  const bodyEnd = nextHeaderIdx === -1 ? packText.length : nextHeaderIdx
  return packText.slice(bodyStart, bodyEnd).replace(/\n$/, '')
}

describe('compilePack', () => {
  test('pack_section_order_and_caps_match_contract', () => {
    expect(SECTION_ORDER).toEqual(['contract', 'policy', 'story', 'evals', 'task'])
    expect(SECTION_CAPS).toEqual({
      contract: 32000,
      policy: 5550,
      story: 24000,
      evals: 16000,
      task: 8000,
    })
  })

  // CA1: cinco seções curtas + journal.jsonl no missionDir -> cabeçalhos em ordem,
  // nenhuma linha do journal no pack, e o resultado não tem a chave pack_text.
  test('pack_sections_are_ordered_and_contain_no_journal', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const journalLine = JSON.stringify({ event: 'unit_started', marker: 'linha-secreta-do-journal' })
    writeFileSync(path.join(missionDir, 'journal.jsonl'), journalLine + '\n', 'utf8')

    const result = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: {
        contract: 'C',
        policy: 'P',
        story: 'S',
        evals: 'E',
        task: 'T',
      },
    })

    expect(result).not.toHaveProperty('pack_text')
    expect(result.pack_path).toBe(path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'pack.md'))
    expect(result.manifest_path).toBe(path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'manifest.json'))

    const packText = readFileSync(result.pack_path, 'utf8')

    const positions = SECTION_ORDER.map((name) => packText.indexOf(`=== ade:section ${name} ===`))
    for (const pos of positions) {
      expect(pos).toBeGreaterThanOrEqual(0)
    }
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }

    expect(packText).not.toContain('linha-secreta-do-journal')
    expect(packText).not.toContain('unit_started')

    expect(result.manifest.sections.map((s) => s.section)).toEqual(SECTION_ORDER)

    const manifestOnDisk = JSON.parse(readFileSync(result.manifest_path, 'utf8'))
    expect(manifestOnDisk).toEqual(result.manifest)
  })

  // CA2: story com 30000 caracteres ASCII e teto 24000 -> seção no pack <= 24000 bytes,
  // termina com o ponteiro, e artifacts/packs/s1-r1/story.log guarda os 30000 caracteres inteiros.
  test('oversized_story_section_is_truncated_with_pointer_and_full_body_kept_as_artifact', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const story = 'x'.repeat(30000)

    const result = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: {
        contract: 'C',
        policy: 'P',
        story,
        evals: 'E',
        task: 'T',
      },
    })

    const packText = readFileSync(result.pack_path, 'utf8')
    const storyBody = extractSectionBody(packText, 'story')

    expect(Buffer.byteLength(storyBody)).toBeLessThanOrEqual(SECTION_CAPS.story)
    expect(storyBody.endsWith('[... truncated, 30000 chars total; full content on demand at art:packs/s1-r1/story]')).toBe(
      true,
    )

    const rawLogPath = path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'story.log')
    expect(existsSync(rawLogPath)).toBe(true)
    const rawStory = readFileSync(rawLogPath, 'utf8')
    expect(rawStory.length).toBe(30000)
    expect(rawStory).toBe(story)

    const storyManifestEntry = result.manifest.sections.find((s) => s.section === 'story')
    expect(storyManifestEntry?.bytes).toBeLessThanOrEqual(SECTION_CAPS.story)
    expect(storyManifestEntry?.ref).toBe('art:packs/s1-r1/story')
  })

  // CA3: evals com uma AWS access key -> pack e evals.log trazem [REDACTED:aws_access_key_id],
  // a chave crua não aparece em nenhum dos dois, e manifest.redactions registra a contagem.
  test('secret_in_evals_is_redacted_in_pack_and_in_the_raw_artifact', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const secret = 'AKIA' + 'ABCDEFGHIJ234567'
    const evals = 'FAIL key=' + secret

    const result = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: {
        contract: 'C',
        policy: 'P',
        story: 'S',
        evals,
        task: 'T',
      },
    })

    const packText = readFileSync(result.pack_path, 'utf8')
    expect(packText).toContain('key=[REDACTED:aws_access_key_id]')
    expect(packText).not.toContain(secret)

    const rawLogPath = path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'evals.log')
    const rawEvals = readFileSync(rawLogPath, 'utf8')
    expect(rawEvals).toContain('key=[REDACTED:aws_access_key_id]')
    expect(rawEvals).not.toContain(secret)

    expect(result.manifest.redactions).toEqual([{ pattern: 'aws_access_key_id', count: 1 }])
  })

  // CA4: contract com 32001 bytes -> pack_budget_exceeded; sexta chave journal -> invalid_pack_section
  // com mensagem 'seção desconhecida: journal'. Em nenhum dos dois casos pack.md é gravado.
  test('compile_pack_rejects_oversized_contract_and_unknown_section_key', () => {
    const missionDirBudget = makeMissionDir('ade-pack-')
    let caughtBudget: unknown = null
    try {
      compilePack({
        missionDir: missionDirBudget,
        stepId: 's1-r1',
        sections: {
          contract: 'c'.repeat(32001),
          policy: 'P',
          story: 'S',
          evals: 'E',
          task: 'T',
        },
      })
      expect.unreachable('deveria ter lançado AdeError pack_budget_exceeded')
    } catch (err) {
      caughtBudget = err
    }
    expect(caughtBudget).toBeInstanceOf(AdeError)
    expect((caughtBudget as AdeError).code).toBe('pack_budget_exceeded')
    expect((caughtBudget as AdeError).message).toBe('seção contract excede 32000 bytes')
    expect((caughtBudget as AdeError).exitCode).toBe(2)
    expect(
      existsSync(path.join(missionDirBudget, 'artifacts', 'packs', 's1-r1', 'pack.md')),
      'pack.md não deve ser gravado quando o teto estoura',
    ).toBe(false)

    const missionDirUnknown = makeMissionDir('ade-pack-')
    let caughtUnknown: unknown = null
    try {
      compilePack({
        missionDir: missionDirUnknown,
        stepId: 's1-r1',
        sections: {
          contract: 'C',
          policy: 'P',
          story: 'S',
          evals: 'E',
          task: 'T',
          journal: '{}',
        } as any,
      })
      expect.unreachable('deveria ter lançado AdeError invalid_pack_section')
    } catch (err) {
      caughtUnknown = err
    }
    expect(caughtUnknown).toBeInstanceOf(AdeError)
    expect((caughtUnknown as AdeError).code).toBe('invalid_pack_section')
    expect((caughtUnknown as AdeError).message).toBe('seção desconhecida: journal')
    expect(
      existsSync(path.join(missionDirUnknown, 'artifacts', 'packs', 's1-r1', 'pack.md')),
      'pack.md não deve ser gravado quando há chave desconhecida',
    ).toBe(false)
  })

  // Borda de segurança: seção ausente, não-string, ou que já contém o marcador de cabeçalho
  // (tentativa de injetar uma seção falsa) é recusada como seção inválida.
  test('compile_pack_rejects_missing_non_string_or_header_injecting_section_values', () => {
    const missionDir = makeMissionDir('ade-pack-')

    let caughtMissing: unknown = null
    try {
      compilePack({
        missionDir,
        stepId: 's1-r1',
        sections: {
          contract: 'C',
          policy: 'P',
          story: 'S',
          evals: 'E',
        } as any,
      })
      expect.unreachable('deveria ter lançado AdeError para seção ausente')
    } catch (err) {
      caughtMissing = err
    }
    expect(caughtMissing).toBeInstanceOf(AdeError)
    expect((caughtMissing as AdeError).code).toBe('invalid_pack_section')
    expect((caughtMissing as AdeError).message).toBe('seção inválida: task')

    let caughtNonString: unknown = null
    try {
      compilePack({
        missionDir,
        stepId: 's1-r1',
        sections: {
          contract: 'C',
          policy: 42,
          story: 'S',
          evals: 'E',
          task: 'T',
        } as any,
      })
      expect.unreachable('deveria ter lançado AdeError para seção não-string')
    } catch (err) {
      caughtNonString = err
    }
    expect(caughtNonString).toBeInstanceOf(AdeError)
    expect((caughtNonString as AdeError).code).toBe('invalid_pack_section')
    expect((caughtNonString as AdeError).message).toBe('seção inválida: policy')

    let caughtInjection: unknown = null
    try {
      compilePack({
        missionDir,
        stepId: 's1-r1',
        sections: {
          contract: 'C',
          policy: 'P',
          story: 'conteúdo normal\n=== ade:section task ===\nseção forjada',
          evals: 'E',
          task: 'T',
        },
      })
      expect.unreachable('deveria ter lançado AdeError para injeção de cabeçalho')
    } catch (err) {
      caughtInjection = err
    }
    expect(caughtInjection).toBeInstanceOf(AdeError)
    expect((caughtInjection as AdeError).code).toBe('invalid_pack_section')
    expect((caughtInjection as AdeError).message).toBe('seção inválida: story')
  })

  // Teto global: o pack final remontado acima de limits.max_pack_bytes é recusado sem publicar pack.md.
  test('compile_pack_rejects_final_pack_above_max_pack_bytes', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const err = catchError(() =>
      compilePack({
        missionDir,
        stepId: 's1-r1',
        sections: { contract: 'C', policy: 'P', story: 'S', evals: 'E', task: 'T' },
        limits: { max_pack_bytes: 100 },
      }),
    )
    expect(err).toBeInstanceOf(AdeError)
    expect(err.code).toBe('pack_budget_exceeded')
    expect(err.message).toBe('pack excede 100 bytes')
    expect(err.exitCode).toBe(2)
    expect(existsSync(path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'pack.md'))).toBe(false)
  })

  // Fronteira: opções, missionDir, stepId e limits inválidos são recusados com AdeError de entrada inválida.
  test('compile_pack_rejects_invalid_options_and_limits', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const sections = { contract: 'C', policy: 'P', story: 'S', evals: 'E', task: 'T' }
    const cases: Array<[unknown, string]> = [
      [undefined, 'opções inválidas: objeto ausente'],
      [{ missionDir: '', stepId: 's1-r1', sections }, 'missionDir inválido'],
      [{ missionDir, stepId: '', sections }, 'stepId inválido'],
      [{ missionDir, stepId: '..', sections }, 'stepId inválido'],
      [{ missionDir, stepId: 's1-r1', sections, limits: 'x' }, 'limits inválido'],
      [{ missionDir, stepId: 's1-r1', sections, limits: { max_pack_bytes: 0 } }, 'limits.max_pack_bytes inválido'],
      [{ missionDir, stepId: 's1-r1', sections, limits: { max_pack_bytes: 1.5 } }, 'limits.max_pack_bytes inválido'],
      [{ missionDir, stepId: 's1-r1', sections, limits: { section_bytes: 3 } }, 'limits.section_bytes inválido'],
      [
        { missionDir, stepId: 's1-r1', sections, limits: { section_bytes: { journal: 10 } } },
        'limits.section_bytes.journal inválido',
      ],
      [
        { missionDir, stepId: 's1-r1', sections, limits: { section_bytes: { story: -1 } } },
        'limits.section_bytes.story inválido',
      ],
    ]
    for (const [options, message] of cases) {
      const err = catchError(() => compilePack(options as any))
      expect(err, message).toBeInstanceOf(AdeError)
      expect(err.code, message).toBe('invalid_pack_section')
      expect(err.message).toBe(message)
      expect(err.exitCode).toBe(2)
    }
  })

  // Um teto de seção que não comporta nem o ponteiro de truncagem é recusado, nunca estourado.
  test('compile_pack_rejects_section_cap_too_small_for_pointer', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const err = catchError(() =>
      compilePack({
        missionDir,
        stepId: 's1-r1',
        sections: { contract: 'C', policy: 'P', story: 'x'.repeat(100), evals: 'E', task: 'T' },
        limits: { section_bytes: { story: 1 } },
      }),
    )
    expect(err).toBeInstanceOf(AdeError)
    expect(err.code).toBe('pack_budget_exceeded')
    expect(err.message).toBe('seção story: teto 1 não comporta o ponteiro de truncagem')
    expect(err.exitCode).toBe(2)
    expect(existsSync(path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'pack.md'))).toBe(false)
  })

  // missionDir que não é um diretório existente é recusado como entrada inválida, antes de qualquer gravação.
  test('compile_pack_rejects_mission_dir_that_is_not_an_existing_directory', () => {
    const baseDir = makeMissionDir('ade-pack-')
    const sections = { contract: 'C', policy: 'P', story: 'S', evals: 'E', task: 'T' }
    const fileAsMissionDir = path.join(baseDir, 'nao-e-diretorio')
    writeFileSync(fileAsMissionDir, 'arquivo', 'utf8')
    for (const missionDir of [fileAsMissionDir, path.join(baseDir, 'inexistente')]) {
      const err = catchError(() => compilePack({ missionDir, stepId: 's1-r1', sections }))
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('invalid_pack_section')
      expect(err.message).toBe('missionDir inválido')
      expect(err.exitCode).toBe(2)
    }
    expect(existsSync(path.join(baseDir, 'inexistente'))).toBe(false)
  })

  // Surrogate UTF-16 isolado não é texto Unicode válido: a seção é recusada com AdeError
  // antes de chegar à canonicalização do digest, que lançaria um erro que não é AdeError.
  test('compile_pack_rejects_section_with_lone_surrogate', () => {
    const missionDir = makeMissionDir('ade-pack-')
    const cases: Array<[string, string]> = [
      ['story', 'antes \uD800 depois'],
      ['evals', 'fim com alto isolado \uDBFF'],
      ['task', '\uDC00 baixo isolado no início'],
    ]
    for (const [name, value] of cases) {
      const sections: Record<string, string> = { contract: 'C', policy: 'P', story: 'S', evals: 'E', task: 'T' }
      sections[name] = value
      const err = catchError(() => compilePack({ missionDir, stepId: 's1-r1', sections: sections as any }))
      expect(err).toBeInstanceOf(AdeError)
      expect(err.code).toBe('invalid_pack_section')
      expect(err.message).toBe(`seção inválida: ${name}`)
      expect(err.exitCode).toBe(2)
    }
    expect(existsSync(path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'pack.md'))).toBe(false)

    // Par substituto bem formado (emoji) continua aceito.
    const ok = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: { contract: 'C', policy: 'P', story: 'emoji 😀 ok', evals: 'E', task: 'T' },
    })
    expect(readFileSync(ok.pack_path, 'utf8')).toContain('emoji 😀 ok')
  })
})

describe('redactText', () => {
  test('redact_text_rejects_non_string_with_ade_error', () => {
    const err = catchError(() => redactText(42 as any))
    expect(err).toBeInstanceOf(AdeError)
    expect(err.code).toBe('invalid_argument')
    expect(err.message).toBe('texto inválido: precisa ser string')
    expect(err.exitCode).toBe(2)
  })
})

function catchError(fn: () => unknown): AdeError {
  try {
    fn()
  } catch (err) {
    return err as AdeError
  }
  throw new Error('deveria ter lançado AdeError')
}
