import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'
import { main, runDoctor } from '../src/cli/doctor.js'
import { validate } from '../src/schema/index.js'
import { AdeError } from '../src/journal/errors.js'

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

function makeHomeDir(prefix: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

/** Fabrica um coletor de stdout/stderr falso que acumula texto escrito, como main() espera receber. */
function makeSink(): { write: (s: string) => void; text: string } {
  const sink = { text: '', write(s: string) { sink.text += s } }
  return sink
}

/** Escreve um JSON de fixture de capability-set em disco, faltando os campos indicados. */
function writeCapabilitySetFixture(dir: string, name: string, omit: string[] = []): string {
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  const doc: Record<string, unknown> = {
    format_version: 1,
    launch: ['claude'],
    transport: 'cli',
    models: [{ id: 'claude-sonnet-5', context_window: 200000, effort: 'medium', vendor: 'anthropic' }],
    resume: true,
    fork: false,
    preminted_session_id: true,
    structured_output: true,
    budget_cap_native: true,
    image_in: false,
    image_out: false,
    sandbox: 'none',
    cost_report: 'reported',
    advisor: false,
    unattended_flags: ['--safe-mode'],
    probe_ok: null,
    probe_mode: 'fixture',
    bootstrap_cost_tokens: 0,
    probed_at: '1970-01-01T00:00:00.000Z',
  }
  for (const key of omit) delete doc[key]
  writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8')
  return filePath
}

describe('ade doctor - modo offline', () => {
  // CA1 (EXEMPLO): main(['--offline'], {homeDir, now}) -> 0; capabilities.json com probe_ok:null,
  // probe_mode:'fixture' e probed_at igual ao relógio injetado, aceito por validate('capability-set').
  test('doctor_offline_writes_fixture_capability_set', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['--offline'], {
      homeDir,
      now: () => '2026-09-17T12:00:00.000Z',
      stdout,
      stderr,
    })

    expect(code).toBe(0)

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(true)

    const doc = JSON.parse(readFileSync(capsPath, 'utf8'))
    expect(doc.probe_ok).toBeNull()
    expect(doc.probe_mode).toBe('fixture')
    expect(doc.probed_at).toBe('2026-09-17T12:00:00.000Z')

    const result = validate('capability-set', doc)
    expect(result.valid).toBe(true)

    expect(stdout.text).toContain(capsPath)
    expect(stderr.text).toBe('')
  })

  // Borda: sem --offline mas com env.CI='true', main também entra em modo offline (recipe passo 6).
  test('main_treats_ci_env_as_offline_mode', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main([], {
      env: { CI: 'true' },
      homeDir,
      now: () => '2026-09-17T12:00:00.000Z',
      stdout,
      stderr,
    })

    expect(code).toBe(0)
    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(true)
  })

  // CA2 (EXEMPLO 1): gitConfigImpl -> 'false', platform 'win32' -> longpaths 'false' e aviso presente.
  test('doctor_warns_when_longpaths_not_enabled_on_windows', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')

    const result = await runDoctor({
      offline: true,
      homeDir,
      platform: 'win32',
      gitConfigImpl: async () => 'false',
      now: () => '2026-09-17T12:00:00.000Z',
    })

    expect(result.longpaths).toBe('false')
    expect(result.warnings).toContain(
      'aviso: core.longpaths não está ligado; rode git config --global core.longpaths true',
    )
  })

  // CA2 (EXEMPLO 2): gitConfigImpl -> 'true', platform 'win32' -> warnings vazio.
  test('doctor_no_warning_when_longpaths_enabled_on_windows', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')

    const result = await runDoctor({
      offline: true,
      homeDir,
      platform: 'win32',
      gitConfigImpl: async () => 'true',
      now: () => '2026-09-17T12:00:00.000Z',
    })

    expect(result.longpaths).toBe('true')
    expect(result.warnings).toEqual([])
  })

  // Borda: fora do win32 o aviso de longpaths nunca aparece, mesmo com core.longpaths desligado
  // (a instrução só manda avisar "em win32").
  test('doctor_no_warning_for_longpaths_on_non_windows_platform', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')

    const result = await runDoctor({
      offline: true,
      homeDir,
      platform: 'linux',
      gitConfigImpl: async () => 'false',
      now: () => '2026-09-17T12:00:00.000Z',
    })

    expect(result.longpaths).toBe('false')
    expect(result.warnings).toEqual([])
  })

  // Integração: main escreve cada warning em stderr e o caminho gravado em stdout (recipe passo 6).
  test('main_writes_warnings_to_stderr_and_path_to_stdout', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')
    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['--offline'], {
      homeDir,
      platform: 'win32',
      gitConfigImpl: async () => 'false',
      now: () => '2026-09-17T12:00:00.000Z',
      stdout,
      stderr,
    })

    expect(code).toBe(0)
    expect(stderr.text).toContain(
      'aviso: core.longpaths não está ligado; rode git config --global core.longpaths true',
    )
    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(stdout.text).toContain(capsPath)
  })

  // CA3 (EXEMPLO): fixturePath sem probe_mode -> main devolve 1, stderr contém 'capability-set
  // inválido' e capabilities.json não é gravado.
  test('main_returns_one_and_skips_write_when_capability_set_fixture_is_invalid', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')
    const fixtureDir = makeHomeDir('ade-doctor-fixture-')
    const fixturePath = writeCapabilitySetFixture(fixtureDir, 'sem-probe-mode.json', ['probe_mode'])

    const stdout = makeSink()
    const stderr = makeSink()

    const code = await main(['--offline'], { homeDir, fixturePath, stdout, stderr })

    expect(code).toBe(1)
    expect(stderr.text).toContain('capability-set inválido')

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })

  // CA3 (direto): runDoctor lança AdeError capability_set_invalid com code/message/exitCode
  // corretos para a mesma fixture sem probe_mode (decisão do plano: todo erro novo é AdeError).
  test('runDoctor_throws_capability_set_invalid_with_code_and_message_for_bad_fixture', async () => {
    const homeDir = makeHomeDir('ade-doctor-home-')
    const fixtureDir = makeHomeDir('ade-doctor-fixture-direct-')
    const fixturePath = writeCapabilitySetFixture(fixtureDir, 'sem-probe-mode.json', ['probe_mode'])

    try {
      await runDoctor({ offline: true, homeDir, fixturePath, now: () => '2026-09-17T12:00:00.000Z' })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('capability_set_invalid')
      expect(adeErr.message).toBe('capability-set inválido')
      expect(adeErr.exitCode).toBe(1)
    }

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })
})
