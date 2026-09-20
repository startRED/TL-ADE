import { execFile } from 'node:child_process'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parseClaudeOutput, parseUsage } from '../adapters/claude/parse.js'
import { AdeError } from '../journal/errors.js'
import { resolveBinary } from '../runner/resolve-binary.js'
import { validate } from '../schema/index.js'
import { diagnoseDocs } from '../docs/projection.js'
import { exitCodeOf } from './exit-codes.js'

const execFileAsync = promisify(execFile)

const DEFAULT_FIXTURE_PATH = new URL('../../fixtures/capabilities/claude-offline.json', import.meta.url)

const PROBE_JSON_SCHEMA = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}'

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
 * @typedef {{ exe: string, prefixArgs: string[] }} ResolvedClaude
 */

/**
 * Resolvedor injetável do `claude`: o contrato é síncrono (como `resolveBinary`); a forma
 * assíncrona também é aceita porque `runDoctor` faz `await` do retorno.
 *
 * @typedef {(cmd: string) => ResolvedClaude | Promise<ResolvedClaude>} ResolveImpl
 */

/**
 * Monta os argumentos da sonda barata do `claude` (regra I45: `--session-id` pré-cunhado e
 * `--json-schema` inline, sem `--bare`).
 *
 * @param {string} uuid
 * @returns {string[]}
 */
function buildProbeArgs(uuid) {
  return [
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
    uuid,
    '--max-budget-usd',
    '0.25',
    '--json-schema',
    PROBE_JSON_SCHEMA,
  ]
}

/**
 * Executa a sonda real do `claude`. Sucesso vira `{stdout, exitCode:0}`; saída não-zero vira
 * `{stdout, exitCode}` (nunca rejeita); qualquer outra falha (spawn, binário ausente) rejeita
 * como `AdeError('doctor_probe_failed', ...)`.
 *
 * @param {{ exe: string, prefixArgs: string[] }} resolved
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, exitCode: number | null }>}
 */
async function defaultProbeImpl(resolved, args) {
  try {
    const { stdout } = await execFileAsync(resolved.exe, [...resolved.prefixArgs, ...args], {
      shell: false,
      maxBuffer: 1024 * 1024,
    })
    return { stdout, exitCode: 0 }
  } catch (err) {
    const code = /** @type {{ code?: unknown, stdout?: unknown, message: string }} */ (err).code
    if (typeof code === 'number') {
      return { stdout: String(/** @type {{ stdout?: unknown }} */ (err).stdout ?? ''), exitCode: code }
    }
    throw new AdeError('doctor_probe_failed', /** @type {Error} */ (err).message, 1)
  }
}

/**
 * Executa `claude --help` como fallback barato quando a sonda real falha. Nunca rejeita.
 *
 * @param {{ exe: string, prefixArgs: string[] }} resolved
 * @returns {Promise<{ exitCode: number | null }>}
 */
async function defaultHelpImpl(resolved) {
  try {
    await execFileAsync(resolved.exe, [...resolved.prefixArgs, '--help'], {
      shell: false,
      maxBuffer: 1024 * 1024,
    })
    return { exitCode: 0 }
  } catch (err) {
    const code = /** @type {{ code?: unknown }} */ (err).code
    return { exitCode: typeof code === 'number' ? code : null }
  }
}

/**
 * Lê e faz parse da fixture de capability-set. Qualquer falha de leitura/parse vira
 * `AdeError('capability_set_invalid', ...)`.
 *
 * @param {string | URL} fixturePath
 * @returns {Record<string, unknown>}
 */
function readFixtureDoc(fixturePath) {
  try {
    const raw = readFileSync(fixturePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    throw new AdeError('capability_set_invalid', 'capability-set inválido', 1, { cause: err })
  }
}

/**
 * Valida um documento contra o schema `capability-set`, lançando `AdeError` se inválido.
 *
 * @param {Record<string, unknown>} doc
 * @returns {void}
 */
function validateCapabilitySet(doc) {
  const result = validate('capability-set', doc)
  if (!result.valid) {
    throw new AdeError('capability_set_invalid', 'capability-set inválido', 1, { errors: result.errors })
  }
}

/**
 * Grava `capabilities.json` em `<homeDir>/.ade` via tmp + rename.
 *
 * @param {string} homeDir
 * @param {Record<string, unknown>} doc
 * @returns {string}
 */
function writeCapabilitiesFile(homeDir, doc) {
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
  return capsPath
}

/**
 * Consulta `core.longpaths` e monta os avisos aplicáveis (só em win32).
 *
 * @param {string} platform
 * @param {() => Promise<string | null>} gitConfigImpl
 * @returns {Promise<{ longpaths: string | null, warnings: string[] }>}
 */
async function computeLongpathsWarnings(platform, gitConfigImpl) {
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
  return { longpaths, warnings }
}

/**
 * Roda o `ade doctor`. No modo offline, lê a fixture de capabilities, atualiza `probed_at`,
 * valida contra o schema `capability-set` e grava em `<homeDir>/.ade/capabilities.json`.
 * No modo real, resolve o `claude`, faz a sonda barata com `--session-id`/`--json-schema` e cai
 * para `--help` (probe_mode `help_only`) quando a sonda falha ou o binário não é encontrado.
 *
 * @param {{
 *   offline: boolean,
 *   homeDir?: string,
 *   platform?: string,
 *   fixturePath?: string | URL,
 *   gitConfigImpl?: () => Promise<string | null>,
 *   now?: () => string,
 *   resolveImpl?: ResolveImpl,
 *   probeImpl?: (resolved: { exe: string, prefixArgs: string[] }, args: string[]) => Promise<{ stdout: string, exitCode: number | null }>,
 *   helpImpl?: (resolved: { exe: string, prefixArgs: string[] }) => Promise<{ exitCode: number | null }>,
 *   randomUUID?: () => string,
 * }} opts
 * @returns {Promise<{ capabilities: Record<string, any>, path: string, longpaths: string | null, warnings: string[] }>}
 */
export async function runDoctor(opts) {
  const {
    offline,
    homeDir = os.homedir(),
    platform = process.platform,
    fixturePath = DEFAULT_FIXTURE_PATH,
    gitConfigImpl = defaultGitConfigImpl,
    now = () => new Date().toISOString(),
    resolveImpl = resolveBinary,
    probeImpl = defaultProbeImpl,
    helpImpl = defaultHelpImpl,
    randomUUID = nodeRandomUUID,
  } = opts ?? {}

  /** @type {Record<string, unknown>} */
  let doc

  if (offline) {
    doc = readFixtureDoc(fixturePath)
    doc.probed_at = now()
  } else {
    /** @type {{ exe: string, prefixArgs: string[] }} */
    let resolved
    try {
      resolved = await resolveImpl('claude')
    } catch {
      throw new AdeError('binary_not_found', 'claude não encontrado', 1)
    }

    const uuid = randomUUID()
    const args = buildProbeArgs(uuid)

    /** @type {{ stdout: string, exitCode: number | null } | null} */
    let probeResult = null
    let probeFailed = false
    try {
      probeResult = await probeImpl(resolved, args)
      if (probeResult.exitCode !== 0) probeFailed = true
    } catch {
      probeFailed = true
    }

    if (probeFailed) {
      /** @type {number | null} */
      let helpExitCode
      try {
        helpExitCode = (await helpImpl(resolved)).exitCode
      } catch (err) {
        throw new AdeError('doctor_probe_failed', 'doctor_probe_failed: sonda e --help do claude falharam', 1, {
          cause: err,
        })
      }
      if (helpExitCode !== 0) {
        throw new AdeError('doctor_probe_failed', 'doctor_probe_failed: sonda e --help do claude falharam', 1)
      }
      doc = readFixtureDoc(fixturePath)
      doc.probe_ok = null
      doc.probe_mode = 'help_only'
      doc.probed_at = now()
    } else {
      doc = readFixtureDoc(fixturePath)
      const { envelope } = parseClaudeOutput(/** @type {{ stdout: string }} */ (probeResult).stdout)

      doc.probe_ok =
        envelope?.session_id === uuid &&
        typeof envelope?.structured_output === 'object' &&
        envelope?.structured_output !== null
      doc.probe_mode = 'real'
      doc.probed_at = now()

      const usage = /** @type {{ input_tokens?: unknown, cache_creation_input_tokens?: unknown } | undefined} */ (
        envelope?.usage
      )
      const inputTokens = Number.isInteger(usage?.input_tokens) ? /** @type {number} */ (usage?.input_tokens) : 0
      const cacheTokens = Number.isInteger(usage?.cache_creation_input_tokens)
        ? /** @type {number} */ (usage?.cache_creation_input_tokens)
        : 0
      doc.bootstrap_cost_tokens = inputTokens + cacheTokens

      const modelUsage =
        /** @type {Record<string, { contextWindow?: unknown }> | undefined} */ (envelope?.modelUsage) ?? {}
      const modelIds = Object.keys(modelUsage).sort()
      if (modelIds.length > 0) {
        doc.models = modelIds.map((id) => ({
          id,
          context_window: Number.isInteger(modelUsage[id]?.contextWindow) ? modelUsage[id].contextWindow : 0,
          effort: 'medium',
          vendor: 'anthropic',
        }))
      }

      doc.cost_report = parseUsage(envelope ?? null).cost_source
    }
  }

  validateCapabilitySet(doc)
  const capsPath = writeCapabilitiesFile(homeDir, doc)
  const { longpaths, warnings } = await computeLongpathsWarnings(platform, gitConfigImpl)

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
 *   resolveImpl?: ResolveImpl,
 *   probeImpl?: (resolved: { exe: string, prefixArgs: string[] }, args: string[]) => Promise<{ stdout: string, exitCode: number | null }>,
 *   helpImpl?: (resolved: { exe: string, prefixArgs: string[] }) => Promise<{ exitCode: number | null }>,
 *   randomUUID?: () => string,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  if (argv.includes('--docs')) {
    let repoDir = process.cwd()
    const repoIdx = argv.indexOf('--repo')
    if (repoIdx !== -1 && argv[repoIdx + 1]) {
      repoDir = argv[repoIdx + 1]
    }
    /** @type {ReturnType<typeof diagnoseDocs>} */
    let diagnosis
    try {
      diagnosis = diagnoseDocs({ repoDir })
    } catch (err) {
      stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
      return exitCodeOf(err)
    }
    stdout.write(`Diagnóstico de documentação:\n`)
    stdout.write(`- Arquivos escaneados: ${diagnosis.summary.scanned_files}\n`)
    stdout.write(`- Referências inválidas: ${diagnosis.summary.invalid_count}\n`)
    stdout.write(`- Documentos desatualizados: ${diagnosis.summary.stale_count}\n`)
    for (const inv of diagnosis.invalid_references) {
      stdout.write(`  [inválido] ${inv.file} -> ${inv.target}\n`)
    }
    for (const st of diagnosis.stale_documents) {
      stdout.write(`  [desatualizado] ${st.file} (${st.reason})\n`)
    }
    return 0
  }

  const offline = argv.includes('--offline') || env.CI === 'true'

  try {
    const result = await runDoctor({
      offline,
      homeDir: deps.homeDir,
      platform: deps.platform,
      fixturePath: deps.fixturePath,
      gitConfigImpl: deps.gitConfigImpl,
      now: deps.now,
      resolveImpl: deps.resolveImpl,
      probeImpl: deps.probeImpl,
      helpImpl: deps.helpImpl,
      randomUUID: deps.randomUUID,
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
