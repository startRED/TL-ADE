import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AdeError } from '../src/journal/errors.js'
import { recordTranscript } from '../scripts/record-transcript.js'
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
