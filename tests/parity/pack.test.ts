import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../helpers/tmp-dir.js'
import { compilePack, SECTION_CAPS } from '../../src/pack/pack.js'

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

function extractSectionBody(packText: string, section: string): string {
  const marker = `=== ade:section ${section} ===\n`
  const start = packText.indexOf(marker)
  const bodyStart = start + marker.length
  const nextHeaderIdx = packText.indexOf('=== ade:section ', bodyStart)
  const bodyEnd = nextHeaderIdx === -1 ? packText.length : nextHeaderIdx
  return packText.slice(bodyStart, bodyEnd).replace(/\n$/, '')
}

describe('pack truncation and redaction parity', () => {
  // O ponteiro de truncagem tem de caber no teto em bytes UTF-8 mesmo quando o corte cai
  // no meio de um caractere multibyte: o corte precisa recuar até a fronteira do caractere,
  // nunca produzir bytes UTF-8 inválidos, e o total final nunca passa do teto da seção.
  test('excerpt_is_bounded', () => {
    const missionDir = makeMissionDir('ade-pack-parity-')
    // 'é' ocupa 2 bytes em UTF-8; 15000 caracteres = 30000 bytes, acima do teto de story (24000).
    const story = 'é'.repeat(15000)

    const result = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: {
        contract: 'C',
        policy: 'P',
        story,
      },
    })

    const packText = readFileSync(result.pack_path, 'utf8')
    const storyBody = extractSectionBody(packText, 'story')

    expect(Buffer.byteLength(storyBody)).toBeLessThanOrEqual(SECTION_CAPS.story)

    // O ponteiro começa com quebra de linha (literal das decisões), separando-o do prefixo cortado.
    const pointer = '\n[... truncated, 15000 chars total; full content on demand at art:packs/s1-r1/story]'
    expect(storyBody.endsWith(pointer)).toBe(true)

    const prefix = storyBody.slice(0, storyBody.length - pointer.length)
    // O prefixo cortado só pode conter caracteres 'é' inteiros: nenhum byte solto de um
    // caractere multibyte partido ao meio, e nenhum caractere de substituição (U+FFFD).
    expect(prefix).toMatch(/^é*$/)
    expect(Buffer.from(prefix, 'utf8').toString('utf8')).toBe(prefix)

    const storyManifestEntry = result.manifest.sections.find((s) => s.section === 'story')
    expect(storyManifestEntry?.bytes).toBeLessThanOrEqual(SECTION_CAPS.story)
  })

  // O pack reusa exatamente os mesmos SECRET_PATTERNS do containment (src/contain/secrets.js):
  // uma saída de gate realista (linha de status + trecho de erro) com um github_token embutido
  // tem de sair redigida tanto do pack quanto do artefato bruto salvo em disco.
  test('gate_output_secret_is_redacted_from_packs', () => {
    const missionDir = makeMissionDir('ade-pack-parity-')
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const gateOutput =
      'lint exit=1 esperado=0 bytes=120\n' + `src/service.js:12:4 error: found ${token} in code\n`

    const result = compilePack({
      missionDir,
      stepId: 's1-r1',
      sections: {
        contract: 'C',
        policy: 'P',
        story: gateOutput,
      },
    })

    const packText = readFileSync(result.pack_path, 'utf8')
    expect(packText).toContain('[REDACTED:github_token]')
    expect(packText).not.toContain(token)

    const rawLogPath = path.join(missionDir, 'artifacts', 'packs', 's1-r1', 'story.log')
    const rawStory = readFileSync(rawLogPath, 'utf8')
    expect(rawStory).toContain('[REDACTED:github_token]')
    expect(rawStory).not.toContain(token)

    expect(result.manifest.redactions).toEqual([{ pattern: 'github_token', count: 1 }])
  })
})
