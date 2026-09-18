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

describe('ade doctor - sonda real', () => {
  const FIXED_UUID = 'uuid-fixed-001'
  const FIXED_NOW = '2026-09-18T08:00:00.000Z'

  function makeResolveImpl() {
    return async (_cmd: string) => ({ exe: 'claude', prefixArgs: [] })
  }

  // CA1 (EXEMPLO 1): session_id devolvido bate com o pedido e structured_output é objeto ->
  // probe_ok true, probe_mode 'real', models[0] vem da chave de modelUsage com vendor 'anthropic'.
  test('doctor_real_probe_matches_session_id_records_probe_ok_true_and_model_with_vendor', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const calls: Array<{ resolved: { exe: string; prefixArgs: string[] }; args: string[] }> = []
    const probeImpl = async (resolved: { exe: string; prefixArgs: string[] }, args: string[]) => {
      calls.push({ resolved, args })
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: FIXED_UUID,
          structured_output: { ok: true },
          total_cost_usd: 0.01,
          modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200000 } },
        }),
      }
    }

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    // A sonda recebe o binário resolvido e exatamente os argumentos da receita, com o UUID
    // injetado em --session-id (o dublê não pode "acertar" o session_id sozinho).
    expect(calls).toHaveLength(1)
    expect(calls[0].resolved).toEqual({ exe: 'claude', prefixArgs: [] })
    expect(calls[0].args).toEqual([
      '-p',
      'responda apenas OK',
      '--output-format',
      'json',
      '--model',
      'haiku',
      '--safe-mode',
      '--tools',
      '',
      '--session-id',
      FIXED_UUID,
      '--max-budget-usd',
      '0.25',
      '--json-schema',
      '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}',
    ])
    expect(calls[0].args).not.toContain('--bare')

    expect(result.capabilities.probe_mode).toBe('real')
    expect(result.capabilities.probe_ok).toBe(true)
    expect(result.capabilities.models[0]).toEqual({
      id: 'claude-haiku-4-5-20251001',
      context_window: 200000,
      effort: 'medium',
      vendor: 'anthropic',
    })
    expect(result.capabilities.cost_report).toBe('reported')

    const doc = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(doc.probe_ok).toBe(true)
    const schemaResult = validate('capability-set', doc)
    expect(schemaResult.valid).toBe(true)
  })

  // CA1 (borda): bootstrap_cost_tokens soma usage.input_tokens + usage.cache_creation_input_tokens
  // como inteiros; nenhum dos dois é inventado nem multiplicado.
  test('doctor_real_probe_bootstrap_cost_tokens_sums_input_and_cache_tokens', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        session_id: FIXED_UUID,
        structured_output: { ok: true },
        usage: { input_tokens: 120, cache_creation_input_tokens: 30 },
      }),
    })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.bootstrap_cost_tokens).toBe(150)
  })

  // CA1 (borda, decisão do plano): sem modelUsage no envelope, os models gravados continuam
  // sendo os da fixture (claude-offline.json), nunca uma lista vazia.
  test('doctor_real_probe_keeps_fixture_models_when_modelUsage_absent', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: FIXED_UUID, structured_output: { ok: true } }),
    })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.models).toEqual([
      { id: 'claude-sonnet-5', context_window: 200000, effort: 'medium', vendor: 'anthropic' },
    ])
  })

  // CA1 (borda, regra I45): sem total_cost_usd numérico no envelope, cost_report fica 'unknown',
  // nunca inventado a partir de outro campo.
  test('doctor_real_probe_cost_report_unknown_when_total_cost_usd_absent', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: FIXED_UUID, structured_output: { ok: true } }),
    })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.cost_report).toBe('unknown')
  })

  // CA2 (EXEMPLO 2): session_id devolvido é diferente do pedido, mesmo com exitCode 0 ->
  // probe_ok false, mas probe_mode continua 'real' (a sonda rodou, só não bateu a identidade).
  test('doctor_real_probe_session_id_mismatch_records_probe_ok_false', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: 'outro-session-id', structured_output: { ok: true } }),
    })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.probe_ok).toBe(false)
    expect(result.capabilities.probe_mode).toBe('real')
  })

  // Adverso: exitCode 0 mas stdout não é JSON válido (saída corrompida/maliciosa) -> a sonda não
  // trava; a falta de session_id reconhecível vira probe_ok false, não uma exceção.
  test('doctor_real_probe_malformed_json_with_exit_zero_yields_probe_ok_false', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({ exitCode: 0, stdout: 'isto nao e json { { {' })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.probe_ok).toBe(false)
    expect(result.capabilities.probe_mode).toBe('real')
    const schemaResult = validate('capability-set', result.capabilities)
    expect(schemaResult.valid).toBe(true)
  })

  // CA3 (EXEMPLO 3, via rejeição): probeImpl rejeita -> doctor cai para helpImpl; --help com
  // exitCode 0 grava capability-set válido com probe_ok null e probe_mode 'help_only'.
  test('doctor_real_probe_rejecting_falls_back_to_help_only_capability_set', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => {
      throw new Error('spawn claude ECONNRESET')
    }
    const helpImpl = async () => ({ exitCode: 0 })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      helpImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.probe_ok).toBeNull()
    expect(result.capabilities.probe_mode).toBe('help_only')
    expect(result.capabilities.probed_at).toBe(FIXED_NOW)

    const doc = JSON.parse(readFileSync(result.path, 'utf8'))
    const schemaResult = validate('capability-set', doc)
    expect(schemaResult.valid).toBe(true)
  })

  // CA3 (borda, sem rejeição): probeImpl resolve com exitCode diferente de zero (não rejeita) ->
  // mesmo assim cai para helpImpl, porque a regra é "rejeitar OU exitCode !== 0".
  test('doctor_real_probe_nonzero_exit_falls_back_to_help_only', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({ exitCode: 1, stdout: '' })
    const helpImpl = async () => ({ exitCode: 0 })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      helpImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.probe_ok).toBeNull()
    expect(result.capabilities.probe_mode).toBe('help_only')
  })

  // CA4 (EXEMPLO 4a, direto): sonda falha e --help também falha -> runDoctor lança AdeError
  // doctor_probe_failed com a mensagem fixa da receita, e nada é gravado em disco.
  test('runDoctor_throws_doctor_probe_failed_and_skips_write_when_probe_and_help_both_fail', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({ exitCode: 1, stdout: '' })
    const helpImpl = async () => ({ exitCode: 2 })

    try {
      await runDoctor({
        offline: false,
        homeDir,
        resolveImpl: makeResolveImpl(),
        probeImpl,
        helpImpl,
        randomUUID: () => FIXED_UUID,
        now: () => FIXED_NOW,
      })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('doctor_probe_failed')
      expect(adeErr.message).toBe('doctor_probe_failed: sonda e --help do claude falharam')
      expect(adeErr.exitCode).toBe(1)
    }

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })

  // CA4 (borda): sonda falha e helpImpl REJEITA (em vez de devolver exitCode) -> a rejeição vira
  // AdeError doctor_probe_failed (todo erro do épico é AdeError) e nada é gravado.
  test('runDoctor_wraps_rejecting_helpImpl_as_doctor_probe_failed_and_skips_write', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({ exitCode: 1, stdout: '' })
    const helpImpl = async (): Promise<{ exitCode: number | null }> => {
      throw new Error('spawn EACCES')
    }

    try {
      await runDoctor({
        offline: false,
        homeDir,
        resolveImpl: makeResolveImpl(),
        probeImpl,
        helpImpl,
        randomUUID: () => FIXED_UUID,
        now: () => FIXED_NOW,
      })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('doctor_probe_failed')
      expect(adeErr.message).toBe('doctor_probe_failed: sonda e --help do claude falharam')
      expect(adeErr.exitCode).toBe(1)
    }

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })

  // Contrato: resolveImpl síncrono (como resolveBinary) é aceito tanto quanto o assíncrono.
  test('runDoctor_accepts_synchronous_resolveImpl', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const probeImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ session_id: FIXED_UUID, structured_output: { ok: true } }),
    })

    const result = await runDoctor({
      offline: false,
      homeDir,
      resolveImpl: (_cmd: string) => ({ exe: 'claude', prefixArgs: [] }),
      probeImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
    })

    expect(result.capabilities.probe_ok).toBe(true)
  })

  // CA4 (EXEMPLO 4b, direto): resolveImpl não acha o claude -> AdeError binary_not_found com a
  // mensagem fixa da receita, exitCode 1, nada gravado.
  test('runDoctor_throws_binary_not_found_when_resolveImpl_throws', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const resolveImpl = async () => {
      throw new Error('claude: command not found')
    }

    try {
      await runDoctor({
        offline: false,
        homeDir,
        resolveImpl,
        randomUUID: () => FIXED_UUID,
        now: () => FIXED_NOW,
      })
      expect.unreachable('deveria ter lançado AdeError')
    } catch (err) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('binary_not_found')
      expect(adeErr.message).toBe('claude não encontrado')
      expect(adeErr.exitCode).toBe(1)
    }

    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })

  // CA4 (EXEMPLO 4a, via main): main([]) sem --offline chama o caminho real; sonda e --help
  // falham -> devolve 1 e escreve 'doctor_probe_failed' em stderr, sem gravar capabilities.json.
  test('main_returns_one_and_reports_doctor_probe_failed_when_probe_and_help_both_fail', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const stdout = makeSink()
    const stderr = makeSink()
    const probeImpl = async () => ({ exitCode: 1, stdout: '' })
    const helpImpl = async () => ({ exitCode: 2 })

    const code = await main([], {
      env: {},
      homeDir,
      resolveImpl: makeResolveImpl(),
      probeImpl,
      helpImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
      stdout,
      stderr,
    })

    expect(code).toBe(1)
    expect(stderr.text).toContain('doctor_probe_failed')
    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })

  // CA4 (EXEMPLO 4b, via main): claude não resolvido -> main devolve 1 e escreve
  // 'claude não encontrado' em stderr, sem gravar capabilities.json.
  test('main_returns_one_and_reports_binary_not_found_when_resolveImpl_throws', async () => {
    const homeDir = makeHomeDir('ade-doctor-real-')
    const stdout = makeSink()
    const stderr = makeSink()
    const resolveImpl = async () => {
      throw new Error('claude: command not found')
    }

    const code = await main([], {
      env: {},
      homeDir,
      resolveImpl,
      randomUUID: () => FIXED_UUID,
      now: () => FIXED_NOW,
      stdout,
      stderr,
    })

    expect(code).toBe(1)
    expect(stderr.text).toContain('claude não encontrado')
    const capsPath = path.join(homeDir, '.ade', 'capabilities.json')
    expect(existsSync(capsPath)).toBe(false)
  })
})
