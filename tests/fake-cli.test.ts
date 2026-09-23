import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AdeError } from '../src/journal/errors.ts'
import { bumpCounter, readCounter, runFakeCli } from '../src/adapters/fake/cli.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PATH = path.join(ROOT, 'src/adapters/fake/cli.ts')

type EngineSpawnSyncOptions = SpawnSyncOptionsWithStringEncoding & {
  detached?: boolean
}

describe('fake-cli', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('ade-runner-')
  })

  afterEach(() => {
    removeTmpDir(tmpDir)
  })

  // AC1: Dado um roteiro de três ações e três invocações em processos separados,
  // quando cada processo roda, então cada um consome a ação seguinte e a quarta invocação repete a última ação.
  test('fake_cli_counter_survives_engine_restart', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/counter-restart')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack inicial\n')

    const baseEnv = {
      ...process.env,
      ADE_FAKE_SCENARIO: scenarioDest,
      ADE_FAKE_ROLE: 'maker',
      ADE_FAKE_RESULT_FILE: resultFile,
    }

    // Invocação 1
    const res1 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: baseEnv,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res1.status).toBe(0)
    expect(res1.stdout).toBe('um')

    // Invocação 2 (processo frio novo)
    const res2 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: baseEnv,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res2.status).toBe(0)
    expect(res2.stdout).toBe('dois')

    // Invocação 3 (processo frio novo)
    const res3 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: baseEnv,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res3.status).toBe(0)
    expect(res3.stdout).toBe('tres')

    // Invocação 4 (lista acabou; repete última ação)
    const res4 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: baseEnv,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res4.status).toBe(0)
    expect(res4.stdout).toBe('tres')

    // Contador em disco após a 4ª invocação
    const countFile = path.join(scenarioDest, 'maker.count')
    expect(existsSync(countFile)).toBe(true)
    expect(readFileSync(countFile, 'utf8')).toBe('4\n')
  }, 20000)

  // AC2: Dado duas invocações com packs diferentes, quando cada uma roda,
  // então existem capturas numeradas a partir de zero com o conteúdo exato do pack,
  // a lista ordenada de chaves de ambiente e a lista de argumentos recebidos.
  test('fake_cli_captures_pack_and_env_per_call', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/capture-pack')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packA = path.join(tmpDir, 'pack-a.md')
    writeFileSync(packA, '# pack A')
    const packB = path.join(tmpDir, 'pack-b.md')
    writeFileSync(packB, '# pack B')

    const customEnv1: Record<string, string> = {
      ...process.env,
      ADE_FAKE_SCENARIO: scenarioDest,
      ADE_FAKE_ROLE: 'maker',
      ADE_FAKE_RESULT_FILE: resultFile,
      TEST_VAR_B: 'beta',
      TEST_VAR_A: 'alpha',
    }

    // Invocação 0
    const res1 = spawnSync(process.execPath, [CLI_PATH, packA, '--extra-arg'], {
      cwd: tmpDir,
      env: customEnv1,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res1.status).toBe(0)
    expect(res1.stdout).toBe('primeira')

    const packCaptured0 = path.join(scenarioDest, 'maker-0.pack.md')
    expect(existsSync(packCaptured0)).toBe(true)
    expect(readFileSync(packCaptured0, 'utf8')).toBe('# pack A')

    const argvCaptured0 = path.join(scenarioDest, 'maker-0.argv.json')
    expect(existsSync(argvCaptured0)).toBe(true)
    expect(JSON.parse(readFileSync(argvCaptured0, 'utf8'))).toEqual([packA, '--extra-arg'])

    const envCaptured0 = path.join(scenarioDest, 'maker-0.env.json')
    expect(existsSync(envCaptured0)).toBe(true)
    expect(JSON.parse(readFileSync(envCaptured0, 'utf8'))).toEqual(Object.keys(customEnv1).sort())

    // Invocação 1
    const customEnv2: Record<string, string> = {
      ...process.env,
      ADE_FAKE_SCENARIO: scenarioDest,
      ADE_FAKE_ROLE: 'maker',
      ADE_FAKE_RESULT_FILE: resultFile,
      TEST_VAR_Z: 'zeta',
    }

    const res2 = spawnSync(process.execPath, [CLI_PATH, packB], {
      cwd: tmpDir,
      env: customEnv2,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res2.status).toBe(0)
    expect(res2.stdout).toBe('segunda')

    const packCaptured1 = path.join(scenarioDest, 'maker-1.pack.md')
    expect(existsSync(packCaptured1)).toBe(true)
    expect(readFileSync(packCaptured1, 'utf8')).toBe('# pack B')

    const argvCaptured1 = path.join(scenarioDest, 'maker-1.argv.json')
    expect(existsSync(argvCaptured1)).toBe(true)
    expect(JSON.parse(readFileSync(argvCaptured1, 'utf8'))).toEqual([packB])

    const envCaptured1 = path.join(scenarioDest, 'maker-1.env.json')
    expect(existsSync(envCaptured1)).toBe(true)
    expect(JSON.parse(readFileSync(envCaptured1, 'utf8'))).toEqual(Object.keys(customEnv2).sort())
  }, 20000)

  // AC3: Dada uma invocação bem-sucedida, quando ela termina,
  // então o arquivo de resultado apontado pelo ambiente existe com um objeto de sucesso que identifica o papel e o número da chamada.
  test('fake_cli_writes_default_result_file', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/counter-restart')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result-def.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(res.status).toBe(0)

    expect(existsSync(resultFile)).toBe(true)
    const parsedResult = JSON.parse(readFileSync(resultFile, 'utf8'))
    expect(parsedResult).toEqual({ status: 'ok', role: 'maker', call: 0 })
  }, 20000)

  // AC4: Dada a ausência de qualquer uma das duas variáveis obrigatórias, quando a CLI roda,
  // então ela sai com código 2, explica em erro padrão qual variável falta e o contador em disco não avança.
  test('fake_cli_requires_result_file_env', async () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/counter-restart')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const cleanEnv: Record<string, string | undefined> = { ...process.env }
    delete cleanEnv.ADE_FAKE_SCENARIO
    delete cleanEnv.ADE_FAKE_RESULT_FILE

    // Chamada direta runFakeCli sem ADE_FAKE_SCENARIO
    const stderrSpy1 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const exitCode1 = await runFakeCli(['x'], cleanEnv)
      expect(exitCode1).toBe(2)
      expect(stderrSpy1).toHaveBeenCalledWith('ADE_FAKE_SCENARIO ausente\n')
    } finally {
      stderrSpy1.mockRestore()
    }

    // Chamada direta runFakeCli sem ADE_FAKE_RESULT_FILE
    const stderrSpy2 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const exitCode2 = await runFakeCli(['x'], {
        ...cleanEnv,
        ADE_FAKE_SCENARIO: scenarioDest,
      })
      expect(exitCode2).toBe(2)
      expect(stderrSpy2).toHaveBeenCalledWith('ADE_FAKE_RESULT_FILE ausente\n')
      expect(existsSync(path.join(scenarioDest, 'maker.count'))).toBe(false)
    } finally {
      stderrSpy2.mockRestore()
    }

    // Processos externos novos para validar saída real de processo
    const resNoScenario = spawnSync(process.execPath, [CLI_PATH, 'x'], {
      cwd: tmpDir,
      env: cleanEnv as Record<string, string>,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(resNoScenario.status).toBe(2)
    expect(resNoScenario.stderr).toContain('ADE_FAKE_SCENARIO ausente')

    const resNoResult = spawnSync(process.execPath, [CLI_PATH, 'x'], {
      cwd: tmpDir,
      env: { ...cleanEnv, ADE_FAKE_SCENARIO: scenarioDest } as Record<string, string>,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)
    expect(resNoResult.status).toBe(2)
    expect(resNoResult.stderr).toContain('ADE_FAKE_RESULT_FILE ausente')
    expect(existsSync(path.join(scenarioDest, 'maker.count'))).toBe(false)
  }, 20000)

  test('fake_cli_validates_scenario_format', async () => {
    // Cenário vazio [] deve lançar AdeError 'fake_scenario_invalid' com exitCode 2
    const emptyDir = path.join(tmpDir, 'empty-scenario')
    mkdirSync(emptyDir, { recursive: true })
    const emptyFile = path.join(emptyDir, 'maker.json')
    writeFileSync(emptyFile, '[]\n')

    try {
      await runFakeCli(['x'], {
        ADE_FAKE_SCENARIO: emptyDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: path.join(tmpDir, 'out.json'),
      })
      expect.unreachable('deve lançar AdeError com cenário vazio')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('fake_scenario_invalid')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.message).toContain('cenário inválido')
    }

    // readCounter e bumpCounter
    expect(readCounter(tmpDir, 'maker')).toBe(0)

    const c0 = bumpCounter(tmpDir, 'maker')
    expect(c0).toBe(0)
    expect(readFileSync(path.join(tmpDir, 'maker.count'), 'utf8')).toBe('1\n')
    expect(readCounter(tmpDir, 'maker')).toBe(1)

    const c1 = bumpCounter(tmpDir, 'maker')
    expect(c1).toBe(1)
    expect(readFileSync(path.join(tmpDir, 'maker.count'), 'utf8')).toBe('2\n')
    expect(readCounter(tmpDir, 'maker')).toBe(2)

    // Contador corrompido em disco
    writeFileSync(path.join(tmpDir, 'maker.count'), 'invalido\n')
    expect(() => readCounter(tmpDir, 'maker')).toThrow(new TypeError('contador inválido'))

    writeFileSync(path.join(tmpDir, 'maker.count'), '-5\n')
    expect(() => readCounter(tmpDir, 'maker')).toThrow(new TypeError('contador inválido'))
  })

  test('fake_cli_validates_interface_arguments', async () => {
    // argv inválido
    await expect(runFakeCli(null as any, {})).rejects.toThrow(new TypeError('argv inválido'))
    await expect(runFakeCli('not-array' as any, {})).rejects.toThrow(new TypeError('argv inválido'))
    await expect(runFakeCli(['ok', 123 as any], {})).rejects.toThrow(new TypeError('argv inválido'))

    // env inválido
    await expect(runFakeCli([], null as any)).rejects.toThrow(new TypeError('env inválido'))
    await expect(runFakeCli([], 'not-object' as any)).rejects.toThrow(new TypeError('env inválido'))
    await expect(runFakeCli([], [] as any)).rejects.toThrow(new TypeError('env inválido'))
    await expect(
      runFakeCli([], { ADE_FAKE_SCENARIO: null as any, ADE_FAKE_RESULT_FILE: 'x' }),
    ).rejects.toThrow(new TypeError('env inválido'))
    await expect(
      runFakeCli([], { ADE_FAKE_SCENARIO: 123 as any, ADE_FAKE_RESULT_FILE: 'x' }),
    ).rejects.toThrow(new TypeError('env inválido'))

    // deps inválido
    await expect(runFakeCli([], {}, null as any)).rejects.toThrow(new TypeError('deps inválido'))
    await expect(runFakeCli([], {}, 'not-object' as any)).rejects.toThrow(new TypeError('deps inválido'))
    await expect(runFakeCli([], {}, [] as any)).rejects.toThrow(new TypeError('deps inválido'))
    await expect(runFakeCli([], {}, { cwd: '' })).rejects.toThrow(new TypeError('cwd inválido'))
    await expect(runFakeCli([], {}, { cwd: 123 as any })).rejects.toThrow(new TypeError('cwd inválido'))
    await expect(runFakeCli([], {}, { now: 'not-fn' as any })).rejects.toThrow(new TypeError('now inválido'))
  })

  test('fake_cli_rejects_non_string_env_values_without_advancing_counter', async () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/counter-restart')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')

    await expect(
      runFakeCli(['x'], {
        ADE_FAKE_SCENARIO: null as any,
        ADE_FAKE_RESULT_FILE: resultFile,
      }),
    ).rejects.toThrow(new TypeError('env inválido'))
    expect(existsSync(path.join(scenarioDest, 'maker.count'))).toBe(false)

    await expect(
      runFakeCli(['x'], {
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_RESULT_FILE: 42 as any,
      }),
    ).rejects.toThrow(new TypeError('env inválido'))
    expect(existsSync(path.join(scenarioDest, 'maker.count'))).toBe(false)
  })

  test('fake_cli_rejects_malformed_actions_without_advancing_counter', async () => {
    const invalidScenarios = [
      { name: 'null-action', content: '[null]\n' },
      { name: 'primitive-action', content: '["acao-string"]\n' },
      { name: 'array-action', content: '[[{"stdout":"x"}]]\n' },
      { name: 'unknown-key', content: '[{"stdout":"ok","unknown_field":true}]\n' },
      { name: 'invalid-stdout', content: '[{"stdout":123}]\n' },
      { name: 'invalid-stderr', content: '[{"stderr":true}]\n' },
      { name: 'invalid-exit-string', content: '[{"exit":"0"}]\n' },
      { name: 'invalid-exit-negative', content: '[{"exit":-1}]\n' },
      { name: 'invalid-exit-float', content: '[{"exit":1.5}]\n' },
      { name: 'invalid-result-string', content: '[{"result":"not-an-object"}]\n' },
      { name: 'invalid-result-array', content: '[{"result":[1,2]}]\n' },
      { name: 'invalid-result-null', content: '[{"result":null}]\n' },
    ]

    for (const { name, content } of invalidScenarios) {
      const scenarioDir = path.join(tmpDir, `scenario-${name}`)
      mkdirSync(scenarioDir, { recursive: true })
      writeFileSync(path.join(scenarioDir, 'maker.json'), content)

      const resultFile = path.join(tmpDir, `out-${name}.json`)
      const env = {
        ADE_FAKE_SCENARIO: scenarioDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      }

      // Chamada direta via runFakeCli
      try {
        await runFakeCli(['x'], env)
        expect.unreachable(`cenário ${name} deveria falhar`)
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AdeError)
        const adeErr = err as AdeError
        expect(adeErr.code).toBe('fake_scenario_invalid')
        expect(adeErr.exitCode).toBe(2)
        expect(adeErr.message).toContain('cenário inválido')
      }

      // Contador em disco não pode ter sido criado/avançado
      expect(existsSync(path.join(scenarioDir, 'maker.count'))).toBe(false)

      // Execução como subprocesso real
      const res = spawnSync(process.execPath, [CLI_PATH, 'x'], {
        cwd: tmpDir,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        maxBuffer: 1 << 26,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      } as EngineSpawnSyncOptions)
      expect(res.status).toBe(2)
      expect(existsSync(path.join(scenarioDir, 'maker.count'))).toBe(false)
    }
  }, 20000)

  // AC1: Dada uma ação que declara arquivos a criar e caminhos a apagar, quando a invocação roda,
  // então os arquivos aparecem com o conteúdo exato relativos ao diretório de trabalho e os caminhos pedidos somem.
  test('fake_cli_writes_and_deletes_files_per_action', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/file-actions')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const workdir = path.join(tmpDir, 'work')
    mkdirSync(workdir, { recursive: true })
    const alvoFile = path.join(workdir, 'alvo.txt')
    writeFileSync(alvoFile, 'apagar preexistente\n')

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: workdir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('feito')
    expect(existsSync(path.join(workdir, 'novo/a.txt'))).toBe(true)
    expect(readFileSync(path.join(workdir, 'novo/a.txt'), 'utf8')).toBe('conteudo A')
    expect(existsSync(alvoFile)).toBe(false)
  }, 20000)

  // AC2: Dada uma ação de fuga apontando para fora do diretório de trabalho, quando a invocação roda,
  // então o arquivo é criado lá fora mesmo assim e o desfecho continua bem-sucedido.
  test('fake_cli_escape_writes_outside_workdir', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/escape-action')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const workdir = path.join(tmpDir, 'work')
    mkdirSync(workdir, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: workdir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('fugiu')
    const foraFile = path.join(tmpDir, 'fora.txt')
    expect(existsSync(foraFile)).toBe(true)
    expect(readFileSync(foraFile, 'utf8')).toBe('ade-escape\n')
  }, 20000)

  // AC3: Dada uma ação que pede para não gravar resultado, quando a invocação roda sem a variável de resultado,
  // então nenhum arquivo de resultado é criado e a saída é bem-sucedida; e uma ação de queda com código próprio termina com esse código e sem resultado.
  test('fake_cli_no_result_and_crash_exit_codes', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/no-result-crash')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const envWithoutResult: Record<string, string | undefined> = {
      ...process.env,
      ADE_FAKE_SCENARIO: scenarioDest,
      ADE_FAKE_ROLE: 'maker',
    }
    delete envWithoutResult.ADE_FAKE_RESULT_FILE

    // Ação 0: {"no_result":true,"stdout":"sem resultado"} sem ADE_FAKE_RESULT_FILE
    const res1 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: envWithoutResult as Record<string, string>,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res1.status).toBe(0)
    expect(res1.stdout).toBe('sem resultado')
    expect(existsSync(resultFile)).toBe(false)

    // Ação 1: {"crash":true,"exit":3,"stderr":"boom"}
    const res2 = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: envWithoutResult as Record<string, string>,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res2.status).toBe(3)
    expect(res2.stderr).toBe('boom')
    expect(existsSync(resultFile)).toBe(false)
  }, 20000)

  // AC4: Dada uma ação que manda rodar um comando que não existe, quando a invocação roda,
  // então a falha é ignorada, a saída padrão e o código de saída são os da ação e o resultado é gravado normalmente.
  test('fake_cli_ignores_failing_argv_command', () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/bad-argv')
    const scenarioDest = path.join(tmpDir, 'scenario')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('seguiu')
    expect(res.stderr).toBe('')
    expect(existsSync(resultFile)).toBe(true)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
      status: 'ok',
      role: 'maker',
      call: 0,
    })
  }, 20000)

  test('fake_cli_replays_recorded_stdout', async () => {
    const scenarioSrc = path.join(ROOT, 'fixtures/scenarios/replay-stdout')
    const scenarioDest = path.join(tmpDir, 'scenarios/replay-stdout')
    cpSync(scenarioSrc, scenarioDest, { recursive: true })

    const transcriptSrc = path.join(ROOT, 'fixtures/transcripts/hello')
    const transcriptDest = path.join(tmpDir, 'transcripts/hello')
    cpSync(transcriptSrc, transcriptDest, { recursive: true })

    const resultFile = path.join(tmpDir, 'result.json')
    const packFile = path.join(tmpDir, 'pack.md')
    writeFileSync(packFile, '# pack\n')

    const expectedStdout = readFileSync(path.join(transcriptDest, 'stdout.json'), 'utf8')

    const res = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: scenarioDest,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(res.status).toBe(0)
    expect(res.stdout).toBe(expectedStdout)
    expect(res.stdout).not.toContain('ignorado')

    // Transcript ausente: lança AdeError 'fake_scenario_invalid' e sai 2
    const missingScenarioDir = path.join(tmpDir, 'scenarios/missing-transcript')
    mkdirSync(missingScenarioDir, { recursive: true })
    writeFileSync(
      path.join(missingScenarioDir, 'maker.json'),
      JSON.stringify([{ stdout_from: 'transcripts/nao-existe' }]),
    )

    try {
      await runFakeCli([packFile], {
        ADE_FAKE_SCENARIO: missingScenarioDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      })
      expect.unreachable('deve lançar AdeError para transcript ausente')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AdeError)
      const adeErr = err as AdeError
      expect(adeErr.code).toBe('fake_scenario_invalid')
      expect(adeErr.exitCode).toBe(2)
      expect(adeErr.message).toContain('transcript ausente')
    }

    const resMissing = spawnSync(process.execPath, [CLI_PATH, packFile], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ADE_FAKE_SCENARIO: missingScenarioDir,
        ADE_FAKE_ROLE: 'maker',
        ADE_FAKE_RESULT_FILE: resultFile,
      },
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as EngineSpawnSyncOptions)

    expect(resMissing.status).toBe(2)
    expect(resMissing.stderr).toContain('transcript ausente')
  }, 20000)
})
