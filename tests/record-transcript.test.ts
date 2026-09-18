import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import { recordTranscript } from '../scripts/record-transcript.js'
import { deriveTranscripts, main as deriveMain } from '../scripts/derive-transcripts.js'
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

function makeOutDir(prefix: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

const FIXED_STDOUT = '{"format_version":1,"story_id":"rec-ok","note":"café ☕"}'
const FAKE_SCRIPT = `process.stdout.write(${JSON.stringify(FIXED_STDOUT)});process.exit(0)`

describe('record-transcript', () => {
  // AC3: executável falso escreve bytes fixos e sai 0 -> os seis arquivos existem, stdout.json é
  // idêntico byte a byte ao que o processo escreveu e meta.json tem cli_version, model e recorded_at.
  test('recordTranscript_writes_six_files_with_byte_identical_stdout_and_meta_fields', async () => {
    const outDir = makeOutDir('ade-rec-')
    const fixedNow = '2026-09-17T03:00:00.000Z'

    const result = await recordTranscript({
      name: 'teste_ok',
      outDir,
      maxBudgetUsd: 0.25,
      model: 'haiku',
      resolved: { exe: process.execPath, prefixArgs: ['-e', FAKE_SCRIPT, '--'] },
      versionImpl: () => '9.9.9 (Claude Code)',
      now: () => fixedNow,
    })

    const dir = path.join(outDir, 'teste_ok')
    expect(result).toEqual({ dir, exitCode: 0 })

    for (const file of ['argv.json', 'stdin.txt', 'stdout.json', 'stderr.txt', 'exit.txt', 'meta.json']) {
      expect(existsSync(path.join(dir, file)), file + ' deve existir').toBe(true)
    }

    const stdoutBytes = readFileSync(path.join(dir, 'stdout.json'))
    expect(stdoutBytes.equals(Buffer.from(FIXED_STDOUT, 'utf8'))).toBe(true)

    expect(readFileSync(path.join(dir, 'exit.txt'), 'utf8')).toBe('0\n')
    expect(readFileSync(path.join(dir, 'stdin.txt'), 'utf8')).toBe('')

    const argv = JSON.parse(readFileSync(path.join(dir, 'argv.json'), 'utf8'))
    expect(Array.isArray(argv)).toBe(true)
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.25')

    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    expect(meta.cli_version).toBe('9.9.9 (Claude Code)')
    expect(meta.model).toBe('haiku')
    expect(meta.recorded_at).toBe(fixedNow)
  })

  // AC4: 'teste_ok' já gravado -> segunda chamada rejeita com AdeError 'transcript_exists' e a
  // mensagem exata 'transcript já existe: <dir>', sem alterar os arquivos já gravados.
  test('recordTranscript_rejects_second_call_with_same_name_and_keeps_existing_files_untouched', async () => {
    const outDir = makeOutDir('ade-rec-dup-')

    await recordTranscript({
      name: 'teste_ok',
      outDir,
      maxBudgetUsd: 0.25,
      model: 'haiku',
      resolved: { exe: process.execPath, prefixArgs: ['-e', FAKE_SCRIPT, '--'] },
      versionImpl: () => '9.9.9 (Claude Code)',
      now: () => '2026-09-17T03:00:00.000Z',
    })

    const dir = path.join(outDir, 'teste_ok')
    const stdoutBefore = readFileSync(path.join(dir, 'stdout.json'))
    const metaBefore = readFileSync(path.join(dir, 'meta.json'), 'utf8')

    try {
      await recordTranscript({
        name: 'teste_ok',
        outDir,
        maxBudgetUsd: 0.25,
        model: 'haiku',
        resolved: { exe: process.execPath, prefixArgs: ['-e', "process.stdout.write('outro');process.exit(0)"] },
        versionImpl: () => '9.9.9 (Claude Code)',
        now: () => '2026-09-17T04:00:00.000Z',
      })
      expect.unreachable('deveria ter lançado AdeError para transcript já existente')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('transcript_exists')
      expect(adeErr.message).toBe('transcript já existe: ' + dir)
      expect(adeErr.exitCode).toBe(2)
    }

    const stdoutAfter = readFileSync(path.join(dir, 'stdout.json'))
    expect(stdoutAfter.equals(stdoutBefore)).toBe(true)
    expect(readFileSync(path.join(dir, 'meta.json'), 'utf8')).toBe(metaBefore)
  })
  // Revisão: model é obrigatório na gravação; ausente, nulo ou não textual rejeita antes de criar artefatos.
  test('recordTranscript_rejects_missing_null_or_non_string_model_before_writing', async () => {
    const outDir = makeOutDir('ade-rec-model-')

    for (const model of [undefined, null, 42, '']) {
      try {
        await recordTranscript({
          name: 'teste_ok',
          outDir,
          maxBudgetUsd: 0.25,
          model: model as unknown as string,
          resolved: { exe: process.execPath, prefixArgs: ['-e', FAKE_SCRIPT, '--'] },
          versionImpl: () => '9.9.9 (Claude Code)',
          now: () => '2026-09-17T03:00:00.000Z',
        })
        expect.unreachable('deveria ter lançado AdeError para model inválido: ' + String(model))
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_claude_args')
        expect(adeErr.message).toBe('model inválido')
        expect(adeErr.exitCode).toBe(2)
      }
    }
    expect(existsSync(path.join(outDir, 'teste_ok'))).toBe(false)
  })

  // Revisão: `--version` saindo com código != 0 é falha de ambiente (AdeError exit 1), sem transcript.
  test('recordTranscript_rejects_with_environment_error_when_version_query_fails', async () => {
    const outDir = makeOutDir('ade-rec-ver-')

    try {
      await recordTranscript({
        name: 'teste_ok',
        outDir,
        maxBudgetUsd: 0.25,
        model: 'haiku',
        resolved: { exe: process.execPath, prefixArgs: ['-e', 'process.exit(3)', '--'] },
        now: () => '2026-09-17T03:00:00.000Z',
      })
      expect.unreachable('deveria ter lançado AdeError para --version com falha')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('binary_not_found')
      expect(adeErr.exitCode).toBe(1)
    }
    expect(existsSync(path.join(outDir, 'teste_ok'))).toBe(false)
  })

  // Revisão: executável que não inicia vira AdeError de ambiente (exit 1), sem transcript nem pack temporário.
  test('recordTranscript_rejects_with_environment_error_when_process_cannot_start', async () => {
    const outDir = makeOutDir('ade-rec-spawn-')
    const tmpBefore = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ade-record-transcript-')).length

    try {
      await recordTranscript({
        name: 'teste_ok',
        outDir,
        maxBudgetUsd: 0.25,
        model: 'haiku',
        resolved: { exe: path.join(outDir, 'nao-existe.exe'), prefixArgs: [] },
        versionImpl: () => '9.9.9 (Claude Code)',
        now: () => '2026-09-17T03:00:00.000Z',
      })
      expect.unreachable('deveria ter lançado AdeError para executável não iniciável')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('binary_not_found')
      expect(adeErr.exitCode).toBe(1)
    }
    expect(existsSync(path.join(outDir, 'teste_ok'))).toBe(false)
    const tmpAfter = readdirSync(os.tmpdir()).filter((n) => n.startsWith('ade-record-transcript-')).length
    expect(tmpAfter).toBe(tmpBefore)
  })
})

function writeBaseTranscript(baseDir: string, stdoutText: string): string {
  const dir = path.join(baseDir, 'ok_with_structured_output')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(['claude', '-p']))
  writeFileSync(path.join(dir, 'stdin.txt'), '')
  writeFileSync(path.join(dir, 'stderr.txt'), '')
  writeFileSync(path.join(dir, 'exit.txt'), '0\n')
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: 'ok_with_structured_output' }))
  writeFileSync(path.join(dir, 'stdout.json'), stdoutText)
  return dir
}

describe('derive transcripts', () => {
  const CA1_STDOUT =
    '{"type":"result","total_cost_usd":0.01,"modelUsage":{"m":{"costUSD":0.01}},"structured_output":{}}'

  // CA1: base presente -> devolve os quatro nomes na ordem de VARIANTS, e cada meta.json aponta
  // derived_from:'ok_with_structured_output' e transform igual ao nome da pasta.
  test('deriveTranscripts_returns_variant_names_in_order_with_derived_from_and_transform_in_meta', async () => {
    const baseDir = makeOutDir('ade-derive-ca1-')
    writeBaseTranscript(baseDir, CA1_STDOUT)

    const names = await deriveTranscripts({ baseDir })

    expect(names).toEqual(['ok_without_cost', 'unknown_fields', 'truncated_json', 'ansi_noise'])

    for (const name of names) {
      const meta = JSON.parse(readFileSync(path.join(baseDir, name, 'meta.json'), 'utf8'))
      expect(meta.derived_from).toBe('ok_with_structured_output')
      expect(meta.transform).toBe(name)
    }
  })

  // CA1: cada variante copia argv/stdin/stderr/exit da base, byte a byte, sem alteração.
  test('deriveTranscripts_copies_argv_stdin_stderr_exit_unchanged_from_base_into_every_variant', async () => {
    const baseDir = makeOutDir('ade-derive-copy-')
    const base = writeBaseTranscript(baseDir, CA1_STDOUT)
    const argvBefore = readFileSync(path.join(base, 'argv.json'), 'utf8')
    const stdinBefore = readFileSync(path.join(base, 'stdin.txt'), 'utf8')
    const stderrBefore = readFileSync(path.join(base, 'stderr.txt'), 'utf8')
    const exitBefore = readFileSync(path.join(base, 'exit.txt'), 'utf8')

    const names = await deriveTranscripts({ baseDir })

    for (const name of names) {
      const dir = path.join(baseDir, name)
      expect(readFileSync(path.join(dir, 'argv.json'), 'utf8')).toBe(argvBefore)
      expect(readFileSync(path.join(dir, 'stdin.txt'), 'utf8')).toBe(stdinBefore)
      expect(readFileSync(path.join(dir, 'stderr.txt'), 'utf8')).toBe(stderrBefore)
      expect(readFileSync(path.join(dir, 'exit.txt'), 'utf8')).toBe(exitBefore)
    }
  })

  // CA2: total_cost_usd no topo e costUSD por model em modelUsage somem em ok_without_cost, com o
  // resto do objeto preservado; string final exatamente igual ao exemplo da story.
  test('deriveTranscripts_ok_without_cost_strips_total_cost_usd_and_per_model_cost_fields', async () => {
    const baseDir = makeOutDir('ade-derive-ca2-')
    writeBaseTranscript(baseDir, '{"total_cost_usd":0.01,"modelUsage":{"m":{"costUSD":0.01}}}')

    await deriveTranscripts({ baseDir })

    const stdout = readFileSync(path.join(baseDir, 'ok_without_cost', 'stdout.json'), 'utf8')
    expect(stdout).toBe('{"modelUsage":{"m":{}}}')
  })

  // CA2: unknown_fields acrescenta ade_unknown_field aninhado no topo e em cada modelUsage,
  // sem remover os campos originais.
  test('deriveTranscripts_unknown_fields_adds_ade_unknown_field_at_top_and_per_model', async () => {
    const baseDir = makeOutDir('ade-derive-unknown-')
    writeBaseTranscript(baseDir, '{"total_cost_usd":0.01,"modelUsage":{"m":{"costUSD":0.01}}}')

    await deriveTranscripts({ baseDir })

    const parsed = JSON.parse(readFileSync(path.join(baseDir, 'unknown_fields', 'stdout.json'), 'utf8'))
    expect(parsed.ade_unknown_field).toEqual({ nested: true })
    expect(parsed.modelUsage.m.ade_unknown_field).toEqual({ nested: true })
    expect(parsed.modelUsage.m.costUSD).toBe(0.01)
    expect(parsed.total_cost_usd).toBe(0.01)
  })

  // CA3: truncated_json corta o stdout base exatamente pela metade em bytes (floor), e o
  // resultado não é JSON válido.
  test('deriveTranscripts_truncated_json_has_exactly_half_the_byte_length_and_fails_to_parse', async () => {
    const baseDir = makeOutDir('ade-derive-ca3-')
    const baseStdout = JSON.stringify({ story_id: 'rec-ok', note: 'café ☕ com noventa bytes de conteúdo x' })
    const baseBytes = Buffer.byteLength(baseStdout, 'utf8')
    writeBaseTranscript(baseDir, baseStdout)

    await deriveTranscripts({ baseDir })

    const truncatedBuf = readFileSync(path.join(baseDir, 'truncated_json', 'stdout.json'))
    expect(truncatedBuf.length).toBe(Math.floor(baseBytes / 2))
    expect(() => JSON.parse(truncatedBuf.toString('utf8'))).toThrow()
  })

  // CA3: ansi_noise mantém o stdout original embutido, mas começa com o código ANSI de limpeza
  // de linha, simulando ruído de terminal antes do JSON.
  test('deriveTranscripts_ansi_noise_prefixes_stdout_with_ansi_clear_line_sequence', async () => {
    const baseDir = makeOutDir('ade-derive-ansi-')
    writeBaseTranscript(baseDir, CA1_STDOUT)

    await deriveTranscripts({ baseDir })

    const ansiBuf = readFileSync(path.join(baseDir, 'ansi_noise', 'stdout.json'))
    expect(ansiBuf.subarray(0, 4).toString('utf8')).toBe('[2K')
    expect(ansiBuf.includes(Buffer.from(CA1_STDOUT, 'utf8'))).toBe(true)
  })

  // CA4: baseDir sem ok_with_structured_output -> AdeError 'transcript_missing' com a mensagem
  // exata, código de saída 2, e nenhuma pasta de variante é criada.
  test('deriveTranscripts_rejects_missing_base_with_transcript_missing_and_creates_nothing', async () => {
    const baseDir = makeOutDir('ade-derive-missing-')
    const missingDir = path.join(baseDir, 'ok_with_structured_output')

    try {
      await deriveTranscripts({ baseDir })
      expect.unreachable('deveria ter lançado AdeError para base ausente')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('transcript_missing')
      expect(adeErr.message).toBe('transcript base ausente: ' + missingDir)
      expect(adeErr.exitCode).toBe(2)
    }

    for (const name of ['ok_without_cost', 'unknown_fields', 'truncated_json', 'ansi_noise']) {
      expect(existsSync(path.join(baseDir, name))).toBe(false)
    }
  })

  // Revisão: baseDir ausente, nulo, não textual ou vazio é entrada inválida -> AdeError
  // 'invalid_argument' exit 2, nunca TypeError nativo.
  test('deriveTranscripts_rejects_non_string_or_empty_baseDir_with_invalid_argument', async () => {
    for (const baseDir of [undefined, null, 42, '']) {
      try {
        await deriveTranscripts({ baseDir: baseDir as unknown as string })
        expect.unreachable('deveria ter lançado AdeError para baseDir inválido: ' + String(baseDir))
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_argument')
        expect(adeErr.message).toBe('baseDir inválido')
        expect(adeErr.exitCode).toBe(2)
      }
    }
  })

  // Revisão: `--base-dir` sem valor é entrada inválida na CLI (exit 2), e não cai no diretório padrão.
  test('derive_main_rejects_base_dir_flag_without_value_with_exit_2_and_writes_nothing', async () => {
    const writes: string[] = []
    const stderr = { write: (s: string) => void writes.push(s) }

    for (const argv of [['--base-dir'], ['--base-dir', '']]) {
      writes.length = 0
      const code = await deriveMain(argv, { stderr })
      expect(code).toBe(2)
      expect(writes.join('')).toBe('--base-dir exige um valor\n')
    }
  })
})

describe('derive transcripts: base malformada', () => {
  // Revisão: prefixo que por acaso já é JSON válido (objeto + espaços finais) ainda tem de sair
  // com exatamente Math.floor(n/2) bytes e falhar no JSON.parse.
  test('deriveTranscripts_truncated_json_is_invalid_even_when_half_prefix_is_valid_json', async () => {
    const baseDir = makeOutDir('ade-derive-pad-')
    const baseStdout = '{"a":1}' + ' '.repeat(20)
    writeBaseTranscript(baseDir, baseStdout)
    expect(() => JSON.parse(baseStdout.slice(0, Math.floor(baseStdout.length / 2)))).not.toThrow()

    await deriveTranscripts({ baseDir })

    const truncatedBuf = readFileSync(path.join(baseDir, 'truncated_json', 'stdout.json'))
    expect(truncatedBuf.length).toBe(Math.floor(Buffer.byteLength(baseStdout, 'utf8') / 2))
    expect(() => JSON.parse(truncatedBuf.toString('utf8'))).toThrow()
  })

  // Revisão: base existente sem um dos arquivos -> AdeError 'transcript_missing' exit 2 citando o
  // arquivo, nunca ENOENT nativo, e nenhuma variante criada.
  test('deriveTranscripts_rejects_incomplete_base_with_transcript_missing_and_creates_nothing', async () => {
    for (const file of ['argv.json', 'stdin.txt', 'stderr.txt', 'exit.txt', 'stdout.json', 'meta.json']) {
      const baseDir = makeOutDir('ade-derive-incomplete-')
      const base = writeBaseTranscript(baseDir, '{"a":1}')
      rmSync(path.join(base, file))

      try {
        await deriveTranscripts({ baseDir })
        expect.unreachable('deveria ter lançado AdeError sem ' + file)
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('transcript_missing')
        expect(adeErr.message).toBe('transcript base ausente: ' + path.join(base, file))
        expect(adeErr.exitCode).toBe(2)
      }

      for (const name of ['ok_without_cost', 'unknown_fields', 'truncated_json', 'ansi_noise']) {
        expect(existsSync(path.join(baseDir, name))).toBe(false)
      }
    }
  })

  // Revisão: meta.json ou stdout.json que não são JSON -> AdeError 'invalid_argument' exit 2,
  // nunca SyntaxError nativo, e nenhuma variante criada.
  test('deriveTranscripts_rejects_malformed_base_json_with_invalid_argument_and_creates_nothing', async () => {
    for (const file of ['meta.json', 'stdout.json']) {
      const baseDir = makeOutDir('ade-derive-malformed-')
      const base = writeBaseTranscript(baseDir, '{"a":1}')
      writeFileSync(path.join(base, file), '{nao json')

      try {
        await deriveTranscripts({ baseDir })
        expect.unreachable('deveria ter lançado AdeError com ' + file + ' malformado')
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_argument')
        expect(adeErr.message.startsWith('transcript base inválido: ' + path.join(base, file) + ': ')).toBe(true)
        expect(adeErr.exitCode).toBe(2)
      }

      for (const name of ['ok_without_cost', 'unknown_fields', 'truncated_json', 'ansi_noise']) {
        expect(existsSync(path.join(baseDir, name))).toBe(false)
      }
    }
  })
})
