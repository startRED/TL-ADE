import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { syncCatalog, listCatalog, inspectCatalog } from '../skills/catalog.ts'
import { AdeError } from '../journal/errors.ts'
import { exitCodeOf } from './exit-codes.ts'

/**
 * Lê a lista de fontes de `--sources <arquivo>` (mesmo formato de `catalog.sources`). `repo` ausente ou com `~/`
 * aponta para o clone local em `~/.ade/catalog-repos/<nome>`; caminho relativo é resolvido a partir do arquivo.
 */
function readSourcesFile(file: string, homeDir: string): any[] {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new AdeError('catalog_sources_file_invalid', `Arquivo de fontes não encontrado: ${file}`, 4)
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new AdeError('catalog_sources_file_invalid', `Arquivo de fontes com JSON inválido: ${file} (${why})`, 4)
  }
  const list = Array.isArray(raw) ? raw : (raw as { sources?: unknown } | null)?.sources
  if (!Array.isArray(list)) {
    throw new AdeError('catalog_sources_file_invalid', `Arquivo de fontes deve conter uma lista de fontes: ${file}`, 4)
  }
  return list.map((source) => {
    if (!source || typeof source !== 'object' || typeof source.name !== 'string') return source
    const repo = typeof source.repo === 'string' && source.repo.trim() ? source.repo : `~/.ade/catalog-repos/${source.name}`
    const resolved = /^~[\\/]/.test(repo) ? path.join(homeDir, repo.slice(2)) : path.resolve(path.dirname(file), repo)
    return { ...source, repo: resolved }
  })
}

/**
 * Ponto de entrada do comando `ade catalog`.
 */
export async function main(argv: string[], deps: {
    stdout?: { write: (s: string) => void }
    stderr?: { write: (s: string) => void }
    repoDir?: string
    catalogDir?: string
    homeDir?: string
} = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  const repoDir = deps.repoDir || process.cwd()
  const homeDir = deps.homeDir || os.homedir()
  const defaultCatalogDir = path.join(homeDir, '.ade', 'catalog')
  const catalogDir = deps.catalogDir || defaultCatalogDir

  const [subcommand, ...subcommandArgv] = argv

  if (!subcommand || !['sync', 'list', 'inspect'].includes(subcommand)) {
    stderr.write('uso: ade catalog <sync|list|inspect> ...\n')
    return 4
  }

  try {
    if (subcommand === 'sync') {
      const parsed = parseArgs({
        args: subcommandArgv,
        allowPositionals: false,
        strict: true,
        options: {
          'rebuild-index': { type: 'boolean' },
          'catalog-dir': { type: 'string' },
          sources: { type: 'string' },
        },
      })

      const targetCatalogDir = parsed.values['catalog-dir'] || catalogDir

      // Lê catalog.sources de .ade/config.json se existir
      let config: { sources: any[]; [key: string]: any } = { sources: [] }
      const configPath = path.join(repoDir, '.ade', 'config.json')
      if (fs.existsSync(configPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
          if (raw.catalog) config = raw.catalog
        } catch {
          // ignore
        }
      }

      // `--sources` substitui só a lista de fontes; o resto de `catalog` (trust_default) segue o do projeto
      if (parsed.values.sources) {
        config = { ...config, sources: readSourcesFile(path.resolve(repoDir, parsed.values.sources), homeDir) }
      }

      const result = await syncCatalog({
        config,
        catalogDir: targetCatalogDir,
        rebuildIndex: Boolean(parsed.values['rebuild-index']),
      })

      stdout.write(`Catálogo sincronizado: ${result.entries.length} habilidades indexadas (digest: ${result.digest})\n`)
      return 0
    }

    if (subcommand === 'list') {
      const parsed = parseArgs({
        args: subcommandArgv,
        allowPositionals: false,
        strict: true,
        options: {
          domain: { type: 'string' },
          trust: { type: 'string' },
          source: { type: 'string' },
          'catalog-dir': { type: 'string' },
        },
      })

      const targetCatalogDir = parsed.values['catalog-dir'] || catalogDir
      const indexPath = path.join(targetCatalogDir, 'index.json')
      if (!fs.existsSync(indexPath)) {
        stderr.write('Catálogo não sincronizado. Execute `ade catalog sync` primeiro.\n')
        return 1
      }

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      const entries = listCatalog({
        index,
        domain: parsed.values.domain,
        trust: parsed.values.trust,
        source: parsed.values.source,
      })

      for (const e of entries) {
        const scriptsFlag = e.has_scripts ? '[scripts]' : ''
        stdout.write(`${e.id.padEnd(25)} ${e.trust.padEnd(12)} ${e.license.padEnd(12)} ${scriptsFlag}\n`)
      }
      return 0
    }

    if (subcommand === 'inspect') {
      const parsed = parseArgs({
        args: subcommandArgv,
        allowPositionals: true,
        strict: true,
        options: {
          body: { type: 'boolean' },
          'catalog-dir': { type: 'string' },
        },
      })

      const id = parsed.positionals[0]
      if (!id) {
        stderr.write('uso: ade catalog inspect <id> [--body]\n')
        return 4
      }

      const targetCatalogDir = parsed.values['catalog-dir'] || catalogDir
      const indexPath = path.join(targetCatalogDir, 'index.json')
      if (!fs.existsSync(indexPath)) {
        stderr.write('Catálogo não sincronizado. Execute `ade catalog sync` primeiro.\n')
        return 1
      }

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      const inspection = inspectCatalog({
        index,
        id,
        includeBody: Boolean(parsed.values.body),
        catalogDir: targetCatalogDir,
      })

      stdout.write(`Habilidade: ${inspection.entry.id}\n`)
      stdout.write(`Origem: ${inspection.entry.source}\n`)
      stdout.write(`Commit: ${inspection.entry.commit}\n`)
      stdout.write(`Licença: ${inspection.entry.license}\n`)
      if (inspection.entry.reason) {
        stdout.write(`Motivo da escolha: ${inspection.entry.reason}\n`)
      }
      if (inspection.entry.community_signal) {
        stdout.write(`Sinal da comunidade: ${inspection.entry.community_signal}\n`)
      }
      stdout.write(`Confiança: ${inspection.entry.trust}\n`)
      if (inspection.quarantineReason) {
        stdout.write(`Motivo da quarentena: ${inspection.quarantineReason}\n`)
      }
      if (inspection.body) {
        stdout.write(`\n--- Corpo ---\n${inspection.body}\n`)
      }
      return 0
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr.write(msg + '\n')
    return exitCodeOf(err)
  }
}
