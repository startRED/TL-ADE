import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { AdeError } from '../journal/errors.js'
import { validate } from '../schema/index.js'

const execFileAsync = promisify(execFile)

const DEFAULT_FIXTURE_PATH = new URL('../../fixtures/capabilities/claude-offline.json', import.meta.url)

/**
 * Lê `core.longpaths` do git local. Qualquer falha (git ausente, sem repositório) devolve null.
 *
 * @returns {Promise<string | null>}
 */
async function defaultGitConfigImpl() {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'core.longpaths'], {
      shell: false,
      maxBuffer: 64 * 1024,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Roda o `ade doctor`. No modo offline, lê a fixture de capabilities, atualiza `probed_at`,
 * valida contra o schema `capability-set` e grava em `<homeDir>/.ade/capabilities.json`.
 * O modo real (offline:false) ainda não existe (chega na s8).
 *
 * @param {{
 *   offline: boolean,
 *   homeDir?: string,
 *   platform?: string,
 *   fixturePath?: string | URL,
 *   gitConfigImpl?: () => Promise<string | null>,
 *   now?: () => string,
 * }} opts
 * @returns {Promise<{ capabilities: object, path: string, longpaths: string | null, warnings: string[] }>}
 */
export async function runDoctor(opts) {
  const {
    offline,
    homeDir = os.homedir(),
    platform = process.platform,
    fixturePath = DEFAULT_FIXTURE_PATH,
    gitConfigImpl = defaultGitConfigImpl,
    now = () => new Date().toISOString(),
  } = opts ?? {}

  if (!offline) {
    throw new AdeError('doctor_probe_failed', 'sonda real indisponível', 1)
  }

  /** @type {Record<string, unknown>} */
  let doc
  try {
    const raw = readFileSync(fixturePath, 'utf8')
    doc = JSON.parse(raw)
  } catch (err) {
    throw new AdeError('capability_set_invalid', 'capability-set inválido', 1, { cause: err })
  }
  doc.probed_at = now()

  const result = validate('capability-set', doc)
  if (!result.valid) {
    throw new AdeError('capability_set_invalid', 'capability-set inválido', 1, { errors: result.errors })
  }

  const adeDir = path.join(homeDir, '.ade')
  const capsPath = path.join(adeDir, 'capabilities.json')
  try {
    mkdirSync(adeDir, { recursive: true })
    const tmpPath = `${capsPath}.${process.pid}.tmp`
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2), 'utf8')
    renameSync(tmpPath, capsPath)
  } catch (err) {
    throw new AdeError('doctor_probe_failed', 'falha ao gravar capabilities.json', 1, { cause: err })
  }

  let longpaths
  try {
    longpaths = await gitConfigImpl()
  } catch (err) {
    throw new AdeError('doctor_probe_failed', 'falha ao consultar core.longpaths', 1, { cause: err })
  }
  const warnings = []
  if (platform === 'win32' && longpaths === 'false') {
    warnings.push('aviso: core.longpaths não está ligado; rode git config --global core.longpaths true')
  }

  return { capabilities: doc, path: capsPath, longpaths, warnings }
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   homeDir?: string,
 *   platform?: string,
 *   fixturePath?: string | URL,
 *   gitConfigImpl?: () => Promise<string | null>,
 *   now?: () => string,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  const offline = argv.includes('--offline') || env.CI === 'true'

  try {
    const result = await runDoctor({
      offline,
      homeDir: deps.homeDir,
      platform: deps.platform,
      fixturePath: deps.fixturePath,
      gitConfigImpl: deps.gitConfigImpl,
      now: deps.now,
    })

    for (const warning of result.warnings) {
      stderr.write(warning + '\n')
    }
    stdout.write(result.path + '\n')
    return 0
  } catch (err) {
    if (err instanceof AdeError) {
      stderr.write(err.message + '\n')
      return err.exitCode ?? 1
    }
    throw err
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
