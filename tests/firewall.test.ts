import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { run } from '../src/pack/firewall.ts'
import { main, openerCommand, resolveRef } from '../src/cli/show.ts'
import { AdeError } from '../src/journal/errors.ts'

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

/** Escreve um artefato bruto diretamente em <missionDir>/artifacts/<rel>.log para preparar cenários de show. */
function seedArtifact(missionDir: string, rel: string, text: string): string {
  const filePath = path.join(missionDir, 'artifacts', ...rel.split('/')) + '.log'
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, 'utf8')
  return filePath
}

/** Fabrica um coletor de stdout/stderr falso que acumula texto escrito, como main() espera receber. */
function makeSink(): { write: (s: string) => void; text: string } {
  const sink = { text: '', write(s: string) { sink.text += s } }
  return sink
}

describe('firewall run', () => {
  // CA1: comando real que imprime 20000 bytes em stdout e sai com código 1 -> rawPath tem
  // os 20000 bytes, extract tem só as 5 chaves esperadas, status 'error', raw_ref 'art:fw/<id>'
  // e o summary respeita o teto de 8192 + 64 bytes.
  test('run_captures_stdout_and_builds_error_extract_on_nonzero_exit', async () => {
    const missionDir = makeMissionDir('ade-fw-')
    const argv = [process.execPath, '-e', "process.stdout.write('a'.repeat(20000));process.exit(1)"]

    const result = await run(argv, { missionDir, id: 't1', cwd: missionDir })

    expect(existsSync(result.rawPath), 'artefato bruto deve existir').toBe(true)
    const rawText = readFileSync(result.rawPath, 'utf8')
    expect(Buffer.byteLength(rawText, 'utf8')).toBeGreaterThanOrEqual(20000)
    expect(rawText.startsWith('a'.repeat(20000))).toBe(true)

    expect(Object.keys(result.extract).sort()).toEqual(['artifacts', 'next_actions', 'raw_ref', 'status', 'summary'])
    expect(result.extract.status).toBe('error')
    expect(result.extract.raw_ref).toBe('art:fw/t1')
    expect(Buffer.byteLength(result.extract.summary, 'utf8')).toBeLessThanOrEqual(8192 + 64)
    expect(Array.isArray(result.extract.next_actions)).toBe(true)
    expect(Array.isArray(result.extract.artifacts)).toBe(true)
  })

  // Borda: argv que não é array não vazio de strings deve recusar antes de qualquer spawn.
  test('run_rejects_invalid_argv_before_spawning', async () => {
    const missionDir = makeMissionDir('ade-fw-badargv-')

    await expect(run([], { missionDir, id: 't2', cwd: missionDir })).rejects.toThrow(AdeError)
    await expect(run('not-an-array' as unknown as string[], { missionDir, id: 't2', cwd: missionDir })).rejects.toThrow(
      AdeError,
    )
    await expect(run([1, 2] as unknown as string[], { missionDir, id: 't2', cwd: missionDir })).rejects.toThrow(AdeError)

    try {
      await run(null as unknown as string[], { missionDir, id: 't2', cwd: missionDir })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_argument')
      expect(adeErr.message).toBe('argv inválido')
      expect(adeErr.exitCode).toBe(2)
    }
  })

  // Borda: opts ausente ou com campos obrigatórios inválidos recusa com AdeError, nunca TypeError nativo.
  test('run_rejects_invalid_opts_with_ade_error', async () => {
    const missionDir = makeMissionDir('ade-fw-badopts-')
    const argv = [process.execPath, '-e', '0']
    const bad = [
      undefined,
      null,
      { id: 't3', cwd: missionDir },
      { missionDir, cwd: missionDir },
      { missionDir, id: '', cwd: missionDir },
      { missionDir, id: 't3' },
      { missionDir, id: 't3', cwd: missionDir, timeoutS: -1 },
      { missionDir, id: 't3', cwd: missionDir, kind: 5 },
    ]
    for (const opts of bad) {
      try {
        await run(argv, opts as unknown as Parameters<typeof run>[1])
        expect.unreachable('deveria ter lançado AdeError')
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_argument')
        expect(adeErr.message).toBe('opts inválido')
        expect(adeErr.exitCode).toBe(2)
      }
    }
  })
})

describe('ade show', () => {
  // CA2: artefato já gravado em artifacts/fw/t1.log -> main devolve 0 e escreve o conteúdo na saída.
  test('main_prints_artifact_content_and_returns_zero', async () => {
    const missionDir = makeMissionDir('ade-show-')
    seedArtifact(missionDir, 'fw/t1', 'conteúdo do artefato de teste')

    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['art:fw/t1', '--mission', missionDir], { stdout, stderr })

    expect(code).toBe(0)
    expect(stdout.text).toContain('conteúdo do artefato de teste')
    expect(stderr.text).toBe('')
  })

  // CA3 (parte 1): resolveRef recusa ref com travessia de diretório com AdeError invalid_argument
  // e a mensagem exata 'ref inválida: art:../segredo'.
  test('resolveRef_rejects_path_traversal_ref', () => {
    const missionDir = makeMissionDir('ade-show-escape-')

    expect(() => resolveRef(missionDir, 'art:../segredo')).toThrow(AdeError)

    try {
      resolveRef(missionDir, 'art:../segredo')
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('invalid_argument')
      expect(adeErr.message).toBe('ref inválida: art:../segredo')
      expect(adeErr.exitCode).toBe(2)
    }
  })

  // CA3 (parte 2): main com a mesma ref inválida devolve código 2 e reporta a mensagem no stderr.
  test('main_returns_two_for_invalid_ref', async () => {
    const missionDir = makeMissionDir('ade-show-escape-main-')
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['art:../segredo', '--mission', missionDir], { stdout, stderr })

    expect(code).toBe(2)
    expect(stderr.text).toContain('ref inválida: art:../segredo')
  })

  // CA3 (parte 3): ref bem formada mas sem artefato no disco -> main devolve 1 com mensagem própria.
  test('main_returns_one_for_missing_artifact', async () => {
    const missionDir = makeMissionDir('ade-show-missing-')
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['art:fw/nao-existe', '--mission', missionDir], { stdout, stderr })

    expect(code).toBe(1)
    expect(stderr.text).toContain('ref não encontrada: art:fw/nao-existe')
  })

  // Borda: sem --mission e sem ADE_MISSION_DIR no ambiente, main recusa com código 2.
  test('main_returns_two_when_mission_dir_is_missing', async () => {
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['art:fw/t1'], { env: {}, stdout, stderr })

    expect(code).toBe(2)
    expect(stderr.text).toContain('missão ausente: use --mission')
  })

  // CA4: com --open e um abridor injetado, main chama o abridor com o caminho absoluto do .log e devolve 0.
  test('main_calls_injected_opener_with_absolute_path_when_open_flag_is_set', async () => {
    const missionDir = makeMissionDir('ade-show-open-')
    const expectedPath = seedArtifact(missionDir, 'fw/t1', 'conteúdo aberto pelo sistema')

    const stdout = makeSink()
    const stderr = makeSink()
    const openedPaths: string[] = []
    const opener = (p: string) => {
      openedPaths.push(p)
    }

    const code = await main(['art:fw/t1', '--open', '--mission', missionDir], { stdout, stderr, opener })

    expect(code).toBe(0)
    expect(openedPaths).toEqual([expectedPath])
    expect(path.isAbsolute(openedPaths[0])).toBe(true)
  })

  // Borda: missão informada por caminho relativo resolve para caminho absoluto (o mesmo que main
  // entrega ao abridor com --open), sem depender de o diretório existir.
  test('resolveRef_returns_absolute_path_for_relative_mission', () => {
    const relMission = path.join('missao-relativa', 'm1')

    const resolved = resolveRef(relMission, 'art:fw/t1')

    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(path.resolve(relMission, 'artifacts', 'fw', 't1') + '.log')
  })

  // Borda: missionDir que não é string não vazia recusa com AdeError, nunca TypeError nativo.
  test('resolveRef_rejects_invalid_mission_dir_with_ade_error', () => {
    for (const bad of [undefined, null, '', 42]) {
      try {
        resolveRef(bad as unknown as string, 'art:fw/t1')
        expect.unreachable('deveria ter lançado AdeError')
      } catch (err) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('invalid_argument')
        expect(adeErr.message).toBe('missão inválida')
        expect(adeErr.exitCode).toBe(2)
      }
    }
  })

  // Segurança: no Windows o abridor padrão não passa pelo cmd, então metacaracteres no caminho
  // da missão (&, |, ^, %) chegam como um único argumento literal e nunca viram comando.
  test('openerCommand_never_routes_path_through_cmd_shell', () => {
    const p = 'C:\\missao&calc|x^y%PATH%\\artifacts\\fw\\t1.log'
    const win = openerCommand('win32', p)
    expect(win).toEqual({ command: 'explorer.exe', args: [p] })
    expect(openerCommand('darwin', p)).toEqual({ command: 'open', args: [p] })
    expect(openerCommand('linux', p)).toEqual({ command: 'xdg-open', args: [p] })
  })
})
