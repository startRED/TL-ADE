import path from 'node:path'
import { digest16 } from '../journal/canonical.js'
import { AdeError } from '../journal/errors.js'
import { getOrProduceArtifact } from '../artifacts/cache.js'

/**
 * Sinaliza manifesto do projeto ilegível durante a descoberta.
 */
export class DiscoveryManifestError extends AdeError {
  /**
   * @param {string} relPath
   * @param {string} reason
   */
  constructor(relPath, reason) {
    super('discovery_manifest_invalid', `manifesto inválido ${relPath}: ${reason}`, 4, {
      path: relPath,
      reason,
    })
  }
}

/**
 * Lê o conteúdo completo de um arquivo pela leitura contida da porta de workspace.
 *
 * @param {import('../workspace/port.js').WorkspacePort} workspace
 * @param {string} relPath
 * @returns {Promise<string>}
 */
async function readText(workspace, relPath) {
  const res = await workspace.read(relPath)
  return res.items.join('\n')
}

/**
 * Executa a descoberta determinística do projeto sobre o workspace.
 *
 * @param {import('../workspace/port.js').WorkspacePort} workspace
 * @param {{
 *   producer?: (ambiguities: any[]) => Promise<any>,
 *   producerVersion?: string,
 *   configDigest?: string,
 *   cacheDir?: string,
 *   journal?: any,
 * }} [options]
 * @returns {Promise<{
 *   language: string,
 *   commands: Array<{ name: string, command: string, source: string }>,
 *   entrypoints: Array<{ name: string, path: string, source: string }>,
 *   modules: Array<{ path: string, source: string }>,
 *   symbols: Array<{ name: string, kind: string, path: string, line: number, source: string, ref: string }>,
 *   dependencies: Array<{ name: string, version: string, type: string, source: string }>,
 *   related_tests: Array<{ testPath: string, targetModule: string, source: string }>,
 *   scope_rules: Array<{ pattern: string, owner: string, source: string }>,
 *   tree_state: { clean: boolean, revision: string, digest: string },
 *   ambiguities: any[],
 *   analysis: any,
 *   facts: any[],
 *   digest: string,
 * }>}
 */
export async function discoverProject(workspace, options = {}) {
  const snap = await workspace.snapshot()
  const rootDir = /** @type {any} */ (workspace).worktreeDir || /** @type {any} */ (workspace).rootDir || process.cwd()

  // 1. Estado da árvore
  let clean = true
  const gitPort = /** @type {any} */ (workspace).gitPort
  if (gitPort && typeof gitPort.dirtyPaths === 'function') {
    const dirty = await gitPort.dirtyPaths()
    clean = dirty.length === 0
  }
  const tree_state = {
    clean,
    revision: snap.revision || 'unknown',
    digest: snap.digest || 'unknown',
  }

  // 2. Linguagem
  let language = 'unknown'
  const isJs = snap.paths.some((p) => /\.(m?[jt]sx?)$/.test(p)) || snap.paths.includes('package.json')
  if (isJs) {
    language = 'javascript'
  }

  // 3. Manifest de comandos, entradas e dependências (package.json)
  const commands = []
  const entrypoints = []
  const dependencies = []

  if (snap.paths.includes('package.json')) {
    const pkgRaw = await readText(workspace, 'package.json')
    /** @type {any} */
    let pkg
    try {
      pkg = JSON.parse(pkgRaw)
    } catch (err) {
      throw new DiscoveryManifestError('package.json', /** @type {Error} */ (err).message)
    }
    {
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        for (const [name, cmd] of Object.entries(pkg.scripts)) {
          commands.push({
            name,
            command: String(cmd),
            source: `package.json:scripts.${name}`,
          })
        }
      }

      if (pkg.main && typeof pkg.main === 'string') {
        entrypoints.push({
          name: 'main',
          path: pkg.main.replace(/\\/g, '/'),
          source: 'package.json:main',
        })
      }

      if (pkg.dependencies && typeof pkg.dependencies === 'object') {
        for (const [dep, ver] of Object.entries(pkg.dependencies)) {
          dependencies.push({
            name: dep,
            version: String(ver),
            type: 'prod',
            source: `package.json:dependencies.${dep}`,
          })
        }
      }

      if (pkg.devDependencies && typeof pkg.devDependencies === 'object') {
        for (const [dep, ver] of Object.entries(pkg.devDependencies)) {
          dependencies.push({
            name: dep,
            version: String(ver),
            type: 'dev',
            source: `package.json:devDependencies.${dep}`,
          })
        }
      }
    }
  }

  // 4. Módulos e Símbolos
  const modules = []
  const symbols = []
  /** @type {any[]} */
  const ambiguities = []

  for (const relPath of snap.paths) {
    if (relPath.startsWith('src/') && /\.(m?[jt]sx?)$/.test(relPath)) {
      modules.push({ path: relPath, source: relPath })

      {
        const lines = (await readText(workspace, relPath)).split('\n')
        for (let i = 0; i < lines.length; i++) {
          const lineNum = i + 1
          const line = lines[i]

          // Extração determinística de símbolos (funções e classes exportadas ou declaradas)
          const exportFuncMatch = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/)
          if (exportFuncMatch) {
            symbols.push({
              name: exportFuncMatch[1],
              kind: 'function',
              path: relPath,
              line: lineNum,
              source: `${relPath}#L${lineNum}`,
              ref: `repo:symbol:${exportFuncMatch[1]}`,
            })
            continue
          }

          const exportClassMatch = line.match(/export\s+class\s+([a-zA-Z0-9_$]+)/)
          if (exportClassMatch) {
            symbols.push({
              name: exportClassMatch[1],
              kind: 'class',
              path: relPath,
              line: lineNum,
              source: `${relPath}#L${lineNum}`,
              ref: `repo:symbol:${exportClassMatch[1]}`,
            })
            continue
          }

          // Checa ambiguidade dinâmica (require ou import dinâmico)
          if (/require\s*\(\s*[^'")\s]+/.test(line) || /import\s*\(\s*[^'")\s]+/.test(line)) {
            ambiguities.push({
              file: relPath,
              line: lineNum,
              statement: line.trim(),
              source: `${relPath}#L${lineNum}`,
            })
          }
        }
      }
    }
  }

  // 5. Testes relacionados
  const related_tests = []
  for (const relPath of snap.paths) {
    if (relPath.startsWith('tests/') || relPath.includes('.test.') || relPath.includes('.spec.')) {
      {
        const content = await readText(workspace, relPath)
        const importMatches = content.matchAll(/(?:from\s+['"]|require\(['"])([^'"]+)['"]/g)
        for (const match of importMatches) {
          const rawImport = match[1]
          if (rawImport.startsWith('.')) {
            const dir = path.posix.dirname(relPath)
            const resolved = path.posix.normalize(path.posix.join(dir, rawImport))
            if (modules.some((m) => m.path === resolved)) {
              related_tests.push({
                testPath: relPath,
                targetModule: resolved,
                source: relPath,
              })
            } else if (modules.some((m) => m.path === `${resolved}.js`)) {
              related_tests.push({
                testPath: relPath,
                targetModule: `${resolved}.js`,
                source: relPath,
              })
            }
          }
        }
      }
    }
  }

  // 6. Regras de escopo (AGENTS.md / docs)
  const scope_rules = []
  if (snap.paths.includes('AGENTS.md')) {
    const lines = (await readText(workspace, 'AGENTS.md')).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const match = line.match(/^([a-zA-Z0-9_/*.-]+)\s*(?:->|:|=)\s*([a-zA-Z0-9_.-]+)/)
      if (match) {
        scope_rules.push({
          pattern: match[1],
          owner: match[2],
          source: `AGENTS.md#L${i + 1}`,
        })
      }
    }
  }
  if (scope_rules.length === 0) {
    scope_rules.push({
      pattern: 'src/**',
      owner: 'core',
      source: 'default-scope-rule',
    })
  }

  // 7. Análise cara endereçada pela chave completa: só é chamada quando snapshot,
  // ambiguidades ou configuração mudam; senão é reproduzida do cache de artefatos.
  let analysis = null
  const producer = options.producer
  if (producer && ambiguities.length > 0) {
    const { artifact } = await getOrProduceArtifact(
      {
        producer: 'discovery-ambiguity-analysis',
        producer_version: options.producerVersion ?? '1.0.0',
        input_digest: digest16({ snapshot: snap.digest, ambiguities }),
        config_digest: options.configDigest ?? '',
        cacheDir: options.cacheDir ?? path.join(rootDir, '.ade', 'cache', 'artifacts'),
        journal: options.journal,
      },
      () => Promise.resolve(producer(ambiguities)),
    )
    analysis = artifact
  }

  // 8. Fatos compilados
  const facts = [
    { type: 'language', value: language, source: 'workspace' },
    ...commands.map((c) => ({ type: 'command', ...c })),
    ...entrypoints.map((e) => ({ type: 'entrypoint', ...e })),
    ...modules.map((m) => ({ type: 'module', ...m })),
    ...symbols.map((s) => ({ type: 'symbol', ...s })),
    ...dependencies.map((d) => ({ ...d, fact_kind: 'dependency' })),
    ...related_tests.map((t) => ({ type: 'related_test', ...t })),
    ...scope_rules.map((r) => ({ type: 'scope_rule', ...r })),
  ]

  const digest = digest16({
    tree_state,
    language,
    commands,
    entrypoints,
    modules,
    symbols,
    dependencies,
    related_tests,
    scope_rules,
  })

  return {
    language,
    commands,
    entrypoints,
    modules,
    symbols,
    dependencies,
    related_tests,
    scope_rules,
    tree_state,
    ambiguities,
    analysis,
    facts,
    digest,
  }
}
