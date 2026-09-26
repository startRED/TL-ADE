import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { codexEnvExtras, isolatedCodexHome } from '../src/adapters/codex/home.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

// O Codex lê $CODEX_HOME/AGENTS.md (as instruções globais do usuário) mesmo com --ignore-user-config: medido em
// 2026-09-26, o revisor da missão recebia as preferências pessoais do operador. A pasta do motor só tem o login.
describe('CODEX_HOME do motor (ADR 0045)', () => {
  const tmps: string[] = []
  afterEach(() => { for (const d of tmps.splice(0)) removeTmpDir(d) })

  function homes() {
    const root = makeTmpDir('ade-codex-home-')
    tmps.push(root)
    const realHome = path.join(root, 'real')
    const engineHome = path.join(root, 'engine')
    fs.mkdirSync(realHome, { recursive: true })
    fs.writeFileSync(path.join(realHome, 'auth.json'), '{"tokens":"a"}')
    fs.writeFileSync(path.join(realHome, 'AGENTS.md'), '# preferências pessoais')
    fs.writeFileSync(path.join(realHome, 'config.toml'), 'model = "x"')
    fs.mkdirSync(path.join(realHome, 'skills', 'minha'), { recursive: true })
    return { realHome, engineHome }
  }

  test('engine_home_holds_only_the_login_linked_to_the_real_one', () => {
    const { realHome, engineHome } = homes()
    expect(isolatedCodexHome({ realHome, engineHome })).toBe(engineHome)
    expect(fs.readdirSync(engineHome)).toEqual(['auth.json'])
    expect(fs.readFileSync(path.join(engineHome, 'auth.json'), 'utf8')).toBe('{"tokens":"a"}')
  })

  // o Codex renova o token gravando no próprio arquivo (truncate + write): os dois nomes veem a renovação
  test('token_refresh_written_in_place_is_seen_by_both_sides', () => {
    const { realHome, engineHome } = homes()
    isolatedCodexHome({ realHome, engineHome })
    const fd = fs.openSync(path.join(engineHome, 'auth.json'), 'r+')
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, '{"tokens":"renovado"}', 0)
    fs.closeSync(fd)
    expect(fs.readFileSync(path.join(realHome, 'auth.json'), 'utf8')).toBe('{"tokens":"renovado"}')
  })

  // logout + login do usuário troca o arquivo: o link antigo apontaria para o login velho
  test('relinks_when_the_user_logs_in_again', () => {
    const { realHome, engineHome } = homes()
    isolatedCodexHome({ realHome, engineHome })
    fs.rmSync(path.join(realHome, 'auth.json'))
    fs.writeFileSync(path.join(realHome, 'auth.json'), '{"tokens":"novo login"}')
    expect(isolatedCodexHome({ realHome, engineHome })).toBe(engineHome)
    expect(fs.readFileSync(path.join(engineHome, 'auth.json'), 'utf8')).toBe('{"tokens":"novo login"}')
  })

  test('is_idempotent_for_parallel_lanes', () => {
    const { realHome, engineHome } = homes()
    expect(isolatedCodexHome({ realHome, engineHome })).toBe(engineHome)
    expect(isolatedCodexHome({ realHome, engineHome })).toBe(engineHome)
  })

  // login fora de arquivo (keyring) não tem o que ligar: fica a pasta do usuário e o doctor avisa
  test('without_auth_file_there_is_no_engine_home', () => {
    const { realHome, engineHome } = homes()
    fs.rmSync(path.join(realHome, 'auth.json'))
    expect(isolatedCodexHome({ realHome, engineHome })).toBeNull()
    expect(codexEnvExtras({ realHome, engineHome })).toEqual({})
  })

  test('env_extras_point_codex_home_to_the_engine_folder', () => {
    const { realHome, engineHome } = homes()
    expect(codexEnvExtras({ realHome, engineHome })).toEqual({ CODEX_HOME: engineHome })
  })
})

describe('doctor avisa quando o Codex não pode ser isolado', () => {
  test('doctor_warns_when_codex_login_is_not_a_file', async () => {
    const { runDoctor } = await import('../src/cli/doctor.ts')
    const homeDir = makeTmpDir('ade-doctor-codex-')
    try {
      const codexHome = path.join(homeDir, '.codex')
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), '# preferências pessoais')
      const init = { type: 'system', subtype: 'init', plugins: [], mcp_servers: [], skills: [], agents: [], slash_commands: [] }
      const stdout = [JSON.stringify(init), JSON.stringify({ type: 'result', session_id: 'u1', structured_output: { ok: true } })].join('\n')
      const res = await runDoctor({ offline: false, homeDir, codexHome, resolveImpl: () => ({ exe: 'claude', prefixArgs: [] }), probeImpl: async () => ({ exitCode: 0, stdout }), randomUUID: () => 'u1', probeImpeccableImpl: async () => ({ engine_version: 'x', url_mode: 'ok', version_match: true }) as any })
      expect(res.warnings.some((w: string) => w.includes('instruções globais do usuário entram nas chamadas do Codex'))).toBe(true)
      fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}')
      const ok = await runDoctor({ offline: false, homeDir, codexHome, resolveImpl: () => ({ exe: 'claude', prefixArgs: [] }), probeImpl: async () => ({ exitCode: 0, stdout }), randomUUID: () => 'u1', probeImpeccableImpl: async () => ({ engine_version: 'x', url_mode: 'ok', version_match: true }) as any })
      expect(ok.warnings.some((w: string) => w.includes('Codex'))).toBe(false)
    } finally {
      removeTmpDir(homeDir)
    }
  })
})
