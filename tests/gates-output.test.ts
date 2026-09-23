import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { buildExtract, EXTRACT_CAPS, MAX_RAW_REF_BYTES, safeId, writeRawArtifact } from '../src/gates/output.ts'

describe('gates output and raw artifacts', () => {
  // CA1: Dado writeRawArtifact({missionDir, ref:'gates/lint/abc123', text:'x'.repeat(50)}),
  // quando roda, então o arquivo <missionDir>/artifacts/gates/lint/abc123.log existe com 50 bytes
  // e o retorno traz rawPath e bytes:50.
  test('raw_artifact_is_written_under_mission_dir', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ade-gate-out-'))
    try {
      const text = 'x'.repeat(50)
      const res = writeRawArtifact({
        missionDir: tmp,
        ref: 'gates/lint/abc123',
        text,
      })

      const expectedPath = path.join(tmp, 'artifacts', 'gates', 'lint', 'abc123.log')
      expect(existsSync(expectedPath), 'arquivo de artefato bruto deve existir').toBe(true)
      expect(readFileSync(expectedPath, 'utf8')).toBe(text)
      expect(res).toEqual({
        rawPath: expectedPath,
        bytes: 50,
      })

      // safeId troca tudo fora de [A-Za-z0-9._-] por '_'
      expect(safeId('gates/lint:abc?123')).toBe('gates_lint_abc_123')
      expect(safeId('valid.name_123-test')).toBe('valid.name_123-test')
      expect(safeId('foo bar@baz')).toBe('foo_bar_baz')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Teste de segurança para escape e travessia de caminho em writeRawArtifact
  test('writeRawArtifact rejects path traversal and escape attempts', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ade-gate-escape-'))
    try {
      const invalidRefs = [
        '../../escape',
        '../escape',
        'gates/../../escape',
        'gates/../escape',
        'gates\\..\\escape',
        'gates\\lint',
        '/absolute/path',
        'gates/lint/',
        '/gates/lint',
        '',
        'gates/./abc',
        'gates//abc',
        'C:/escape',
        // Windows remove espaços e pontos finais de cada segmento ao materializar o
        // caminho no sistema de arquivos, então estes viram '..' na prática mesmo
        // passando pela checagem lexical de path.resolve/path.relative do Node.
        'gates/.. /../escape',
        'gates/.../escape',
        'gates/foo. /escape',
        'gates/foo ./escape',
      ]

      for (const badRef of invalidRefs) {
        expect(() => {
          writeRawArtifact({
            missionDir: tmp,
            ref: badRef,
            text: 'forbidden',
          })
        }, `deve rejeitar ref '${badRef}'`).toThrow(TypeError)
      }

      const outsideFile = path.join(tmp, 'escape.log')
      expect(existsSync(outsideFile)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Teste de segurança: fuga física por link simbólico/junção, que a checagem lexical não vê.
  test('writeRawArtifact refuses to follow symlinks or junctions out of the mission dir', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ade-gate-link-'))
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      // Caso 1: <missionDir>/artifacts é, ele mesmo, um link para fora da missão.
      const outsideA = path.join(tmp, 'outside-a')
      const missionA = path.join(tmp, 'mission-a')
      mkdirSync(outsideA, { recursive: true })
      mkdirSync(missionA, { recursive: true })
      let linked = true
      try {
        symlinkSync(outsideA, path.join(missionA, 'artifacts'), linkType)
      } catch {
        // Sem privilégio para criar link neste ambiente: nada a provar aqui.
        linked = false
      }
      if (linked) {
        expect(() => {
          writeRawArtifact({ missionDir: missionA, ref: 'gates/lint/abc123', text: 'forbidden' })
        }, 'deve recusar artifacts que é link para fora').toThrow(TypeError)
        expect(existsSync(path.join(outsideA, 'gates'))).toBe(false)
      }

      // Caso 2: um diretório intermediário dentro de artifacts é um link para fora.
      const outsideB = path.join(tmp, 'outside-b')
      const missionB = path.join(tmp, 'mission-b')
      mkdirSync(outsideB, { recursive: true })
      mkdirSync(path.join(missionB, 'artifacts'), { recursive: true })
      let linkedB = true
      try {
        symlinkSync(outsideB, path.join(missionB, 'artifacts', 'gates'), linkType)
      } catch {
        linkedB = false
      }
      if (linkedB) {
        expect(() => {
          writeRawArtifact({ missionDir: missionB, ref: 'gates/lint/abc123', text: 'forbidden' })
        }, 'deve recusar diretório intermediário que é link para fora').toThrow(TypeError)
        expect(existsSync(path.join(outsideB, 'lint'))).toBe(false)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Teste de corrida: o diretório é trocado por um link para fora DEPOIS da validação,
  // no instante da abertura do arquivo. Nenhum arquivo pode sobrar fora da missão.
  test('writeRawArtifact discards the file when a directory is swapped after validation', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ade-gate-race-'))
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      const outside = path.join(tmp, 'outside')
      const mission = path.join(tmp, 'mission')
      mkdirSync(outside, { recursive: true })
      mkdirSync(mission, { recursive: true })

      const leaf = path.join(mission, 'artifacts', 'gates', 'lint')
      const realOpen = fs.openSync
      let swapped = false
      let linked = false
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        if (!swapped) {
          swapped = true
          // Toda a cadeia já foi criada e conferida como diretório real; aqui ela é
          // trocada por uma junção para fora, exatamente na janela entre conferir e abrir.
          rmSync(leaf, { recursive: true, force: true })
          try {
            symlinkSync(outside, leaf, linkType)
            linked = true
          } catch {
            // Sem privilégio para criar link neste ambiente: restaura o diretório real.
            mkdirSync(leaf, { recursive: true })
          }
        }
        return realOpen(...args)
      })

      let caught: unknown = null
      try {
        writeRawArtifact({ missionDir: mission, ref: 'gates/lint/abc123', text: 'forbidden' })
      } catch (err) {
        caught = err
      } finally {
        spy.mockRestore()
      }

      if (linked) {
        expect(caught, 'troca após a validação deve ser recusada').toBeInstanceOf(TypeError)
        expect(existsSync(path.join(outside, 'abc123.log'))).toBe(false)
        expect(readdirSync(outside)).toEqual([])
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // CA2 & CA3:
  // (2) Dado buildExtract com kind:'test', exitCode:0, expectExit:0 e 100 KB de stdout,
  // quando roda, então status é 'success', next_actions é vazio, artifacts contém o raw_ref e bytes_model é no máximo 8192.
  // (3) Dado buildExtract com kind:'lint', exitCode:1, expectExit:0 e 100 KB de stderr começando com src/a.js:1:1 erro,
  // quando roda, então status é 'error', o excerpt começa por src/a.js:1:1 erro, termina com a marca [...cortado: <N> bytes em art:gates/lint/abc123],
  // bytes_model é no máximo 8192 e next_actions cita ade show art:gates/lint/abc123.
  test('gate_output_extract_is_bounded_and_points_to_raw', () => {
    expect(EXTRACT_CAPS).toEqual({
      test: 8192,
      lint: 8192,
      typecheck: 8192,
      build: 8192,
      git: 4096,
    })

    // [CA2] Sucesso com 100 KB de stdout
    const successResult = buildExtract({
      kind: 'test',
      exitCode: 0,
      expectExit: 0,
      stdout: 'y'.repeat(100000),
      stderr: '',
      rawRef: 'art:gates/test/abc',
      bytesRaw: 100000,
    })

    expect(successResult.status).toBe('success')
    expect(successResult.next_actions).toEqual([])
    expect(successResult.artifacts).toEqual(['art:gates/test/abc'])
    expect(successResult.raw_ref).toBe('art:gates/test/abc')
    expect(successResult.bytes_raw).toBe(100000)
    expect(successResult.bytes_model).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(successResult.excerpt)).toBe(successResult.bytes_model)
    expect(successResult.summary).toBe('test exit=0 esperado=0 bytes=100000')
    // No sucesso, os últimos 600 bytes de stdout
    expect(successResult.excerpt).toBe('y'.repeat(600))
    expect(successResult.bytes_model).toBe(600)

    // [CA3] Erro com 100 KB de stderr
    const errResult = buildExtract({
      kind: 'lint',
      exitCode: 1,
      expectExit: 0,
      stdout: '',
      stderr: 'src/a.js:1:1 erro' + 'z'.repeat(100000),
      rawRef: 'art:gates/lint/abc123',
      bytesRaw: 100017,
    })

    expect(errResult.status).toBe('error')
    expect(errResult.next_actions).toEqual(['ade show art:gates/lint/abc123'])
    expect(errResult.artifacts).toEqual(['art:gates/lint/abc123'])
    expect(errResult.raw_ref).toBe('art:gates/lint/abc123')
    expect(errResult.bytes_raw).toBe(100017)
    expect(errResult.bytes_model).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(errResult.excerpt)).toBe(errResult.bytes_model)
    expect(errResult.excerpt.startsWith('src/a.js:1:1 erro')).toBe(true)
    expect(errResult.excerpt).toMatch(/\[\.\.\.cortado: \d+ bytes em art:gates\/lint\/abc123\]$/)
    expect(errResult.summary).toBe('lint exit=1 esperado=0 bytes=100017')

    // Borda: warning quando exitCode bate mas contém warning
    const warnResult = buildExtract({
      kind: 'build',
      exitCode: 0,
      expectExit: 0,
      stdout: 'compiled with 1 warning',
      stderr: '',
      rawRef: 'art:gates/build/w',
      bytesRaw: 24,
    })
    expect(warnResult.status).toBe('warning')
    expect(warnResult.next_actions).toEqual([])

    // Borda: saída abaixo do cap não inclui marca de corte
    const smallErrResult = buildExtract({
      kind: 'test',
      exitCode: 1,
      expectExit: 0,
      stdout: 'some stdout',
      stderr: 'small error',
      rawRef: 'art:gates/test/small',
      bytesRaw: 22,
    })
    expect(smallErrResult.status).toBe('error')
    expect(smallErrResult.excerpt).toBe('small error\nsome stdout')
    expect(smallErrResult.bytes_model).toBe(Buffer.byteLength('small error\nsome stdout'))
    expect(smallErrResult.excerpt).not.toContain('[...cortado:')

    // Borda: kind git com teto de 4096
    const gitErrResult = buildExtract({
      kind: 'git',
      exitCode: 1,
      expectExit: 0,
      stdout: '',
      stderr: 'fatal: ' + 'g'.repeat(10000),
      rawRef: 'art:gates/git/err',
      bytesRaw: 10007,
    })
    expect(gitErrResult.status).toBe('error')
    expect(gitErrResult.bytes_model).toBeLessThanOrEqual(4096)
    expect(Buffer.byteLength(gitErrResult.excerpt)).toBe(gitErrResult.bytes_model)
    expect(gitErrResult.excerpt).toMatch(/\[\.\.\.cortado: \d+ bytes em art:gates\/git\/err\]$/)
  })

  // Teste de borda: limite para rawRef e garantia estrita de bytes_model <= cap
  test('buildExtract bounds rawRef and guarantees excerpt never exceeds cap', () => {
    const hugeRawRef = 'art:gates/' + 'x'.repeat(MAX_RAW_REF_BYTES + 10)
    expect(() => {
      buildExtract({
        kind: 'lint',
        exitCode: 1,
        expectExit: 0,
        stdout: '',
        stderr: 'error text',
        rawRef: hugeRawRef,
        bytesRaw: 10,
      })
    }).toThrow(TypeError)

    const maxRawRef = 'art:gates/' + 'r'.repeat(MAX_RAW_REF_BYTES - 10)
    const res = buildExtract({
      kind: 'git',
      exitCode: 1,
      expectExit: 0,
      stdout: '',
      stderr: 'error '.repeat(1000),
      rawRef: maxRawRef,
      bytesRaw: 6000,
    })

    expect(res.bytes_model).toBeLessThanOrEqual(4096)
    expect(Buffer.byteLength(res.excerpt)).toBe(res.bytes_model)
    expect(res.excerpt).toContain(maxRawRef)
    expect(res.excerpt).toMatch(/\[\.\.\.cortado: \d+ bytes em art:gates\/r+\]$/)
  })
})
