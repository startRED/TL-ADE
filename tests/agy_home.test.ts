import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { agyEnvExtras } from '../src/adapters/agy/home.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'

// O agy lia o ~/.gemini/GEMINI.md do operador como regra global; a casa do motor não tem nada do usuário.
describe('casa do agy (ADR 0045)', () => {
  const tmps: string[] = []
  afterEach(() => { for (const d of tmps.splice(0)) removeTmpDir(d) })

  test('agy_home_is_an_engine_folder_and_never_the_user_home', () => {
    const adeHome = makeTmpDir('ade-agy-home-')
    tmps.push(adeHome)
    const env = agyEnvExtras({ ADE_HOME: adeHome })
    expect(env.USERPROFILE).toBe(path.join(adeHome, '.ade', 'agy-home'))
    expect(env.HOME).toBe(env.USERPROFILE)
    expect(fs.existsSync(env.HOME)).toBe(true)
    expect(env.HOME).not.toBe(os.homedir())
  })
})
