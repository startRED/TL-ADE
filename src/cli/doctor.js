import { execFile } from 'node:child_process'
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
    doc.skills_suppression = true
    doc.native_skills_suppressed = true
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

function listFilesRec(dir, base = '') {
  if (!existsSync(dir)) return []
  const results = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      const rel = base ? `${base}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        results.push(...listFilesRec(path.join(dir, ent.name), rel))
      } else if (ent.isFile()) {
        results.push(rel)
      }
    }
  } catch {
    // ignore
  }
  return results
}

/**
 * Diagnóstico de habilidades, baseline e controle 11 (memória e configuração de agentes).
 *
 * @param {{ homeDir?: string, repoDir?: string, catalogDir?: string }} [opts]
 * @returns {{ deltas: any[], oversizedDocs: any[], quarantineCount: number, currentHashes: Record<string, string> }}
 */
export function diagnoseSkills({ homeDir = os.homedir(), repoDir = process.cwd(), catalogDir = path.join(homeDir, '.ade', 'catalog') } = {}) {
  const monitoredDirs = [
    path.join(homeDir, '.claude'),
    path.join(repoDir, '.claude'),
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.agents'),
  ]

  const currentHashes = {}
  for (const dir of monitoredDirs) {
    if (existsSync(dir)) {
      const files = listFilesRec(dir)
      for (const rel of files) {
        const full = path.join(dir, rel)
        try {
          const content = readFileSync(full)
          const key = `${path.basename(dir)}/${rel.replace(/\\/g, '/')}`
          currentHashes[key] = createHash('sha256').update(content).digest('hex')
        } catch {
          // ignore
        }
      }
    }
  }

  const baselinePath = path.join(homeDir, '.ade', 'skills-baseline.json')
  const deltas = []
  if (existsSync(baselinePath)) {
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
      for (const [key, hash] of Object.entries(currentHashes)) {
        if (!baseline[key]) {
          deltas.push({ file: key, type: 'added', current: hash })
        } else if (baseline[key] !== hash) {
          deltas.push({ file: key, type: 'modified', current: hash, previous: baseline[key] })
        }
      }
      for (const key of Object.keys(baseline)) {
        if (!currentHashes[key]) {
          deltas.push({ file: key, type: 'removed', previous: baseline[key] })
        }
      }
    } catch {
      // ignore
    }
  } else {
    try {
      mkdirSync(path.dirname(baselinePath), { recursive: true })
      writeFileSync(baselinePath, JSON.stringify(currentHashes, null, 2), 'utf8')
    } catch {
      // ignore
    }
  }

  const oversizedDocs = []
  for (const docName of ['CLAUDE.md', 'AGENTS.md']) {
    for (const d of [repoDir, homeDir]) {
      const p = path.join(d, docName)
      if (existsSync(p)) {
        try {
          const sz = statSync(p).size
          if (sz > 8192) {
            oversizedDocs.push({ file: p, size: sz })
          }
        } catch {
          // ignore
        }
      }
    }
  }

  let quarantineCount = 0
  const indexPath = path.join(catalogDir, 'index.json')
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8'))
      for (const e of idx.entries || []) {
        if (e.trust === 'quarantine') quarantineCount++
      }
    } catch {
      // ignore
    }
  }

  return {
    deltas,
    oversizedDocs,
    quarantineCount,
    currentHashes,
  }
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

  if (argv.includes('--skills')) {
    let repoDir = process.cwd()
    const repoIdx = argv.indexOf('--repo')
    if (repoIdx !== -1 && argv[repoIdx + 1]) {
      repoDir = argv[repoIdx + 1]
    }
    const homeDir = deps.homeDir ?? os.homedir()
    const diag = diagnoseSkills({ homeDir, repoDir })
    stdout.write('Diagnóstico de habilidades e memória do agente:\n')
    stdout.write(`- Deltas de memória/configuração detectados: ${diag.deltas.length}\n`)
    for (const d of diag.deltas) {
      stdout.write(`  [delta] ${d.file} (${d.type})\n`)
    }
    stdout.write(`- Documentos de instrução acima de 8 KB: ${diag.oversizedDocs.length}\n`)
    for (const o of diag.oversizedDocs) {
      stdout.write(`  [oversized] ${o.file} (${o.size} bytes)\n`)
    }
    stdout.write(`- Habilidades em quarentena: ${diag.quarantineCount}\n`)
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
