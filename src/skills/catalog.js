// @ts-check
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import canonicalize from 'canonicalize'
import { AdeError } from '../journal/errors.ts'
import { scanSkill } from './skillguard.js'

const ALLOWED_LICENSES = new Set([
  'mit',
  'apache-2.0',
  'apache 2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'unlicense',
  'cc0-1.0',
  '0bsd',
])

/**
 * Verifica se uma licença é bloqueada ou não permitida.
 *
 * @param {string} [lic]
 * @returns {boolean}
 */
export function isBlockedLicense(lic) {
  if (!lic || typeof lic !== 'string') return true
  const lower = lic.trim().toLowerCase()
  if (
    lower === 'proprietary' ||
    lower === 'commercial' ||
    lower === 'none' ||
    lower === 'all rights reserved'
  ) {
    return true
  }
  return !ALLOWED_LICENSES.has(lower)
}

/**
 * Faz o parse de frontmatter YAML e corpo de um arquivo SKILL.md sem dependências externas.
 *
 * @param {string} content
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
export function parseSkillMarkdown(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const rawYaml = match[1]
  const body = match[2]
  /** @type {Record<string, any>} */
  const frontmatter = {}
  /** @type {string | null} */
  let currentKey = null

  for (const line of rawYaml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (line.startsWith('  - ') || line.startsWith('- ')) {
      const item = trimmed.replace(/^-\s*/, '').trim().replace(/^['"]|['"]$/g, '')
      if (currentKey && Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey].push(item)
      }
      continue
    }

    const colonIdx = line.indexOf(':')
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim()
      const val = line.slice(colonIdx + 1).trim()
      currentKey = key

      if (val === '') {
        frontmatter[key] = []
      } else if (val.startsWith('[') && val.endsWith(']')) {
        try {
          frontmatter[key] = JSON.parse(val)
        } catch {
          frontmatter[key] = val
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
        }
      } else if (val === 'true') {
        frontmatter[key] = true
      } else if (val === 'false') {
        frontmatter[key] = false
      } else if (!isNaN(Number(val)) && val !== '') {
        frontmatter[key] = Number(val)
      } else {
        frontmatter[key] = val.replace(/^['"]|['"]$/g, '')
      }
    }
  }

  return { frontmatter, body }
}

/**
 * Verifica se um caminho relativo deve ser materializado sob os paths permitidos.
 *
 * @param {string} filePath
 * @param {string[]} declaredPaths
 * @returns {boolean}
 */
function isPathDeclared(filePath, declaredPaths = ['skills/**']) {
  const norm = filePath.replace(/\\/g, '/')

  if (path.posix.isAbsolute(norm) || norm.split('/').includes('..')) return false

  // Bloqueio duro de segurança: nunca materializar caminhos hostis ou scripts fora de skills
  if (
    norm.startsWith('.github/') ||
    norm.startsWith('.git/') ||
    norm === 'install.sh' ||
    norm.startsWith('install.') ||
    norm.startsWith('hooks/') ||
    norm.startsWith('scripts/')
  ) {
    return false
  }

  for (const pattern of declaredPaths) {
    const pNorm = pattern.replace(/\\/g, '/')
    if (path.posix.isAbsolute(pNorm) || pNorm.split('/').includes('..')) continue
    if (pNorm.endsWith('/**')) {
      const prefix = pNorm.slice(0, -3)
      if (norm === prefix || norm.startsWith(`${prefix}/`)) return true
    } else if (pNorm.endsWith('/*')) {
      const prefix = pNorm.slice(0, -2)
      if (norm.startsWith(`${prefix}/`) && !norm.slice(prefix.length + 1).includes('/')) return true
    } else if (norm === pNorm) {
      return true
    }
  }

  return false
}

/**
 * Coleta recursivamente todos os arquivos sob um diretório.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkDir(dir) {
  /** @type {string[]} */
  const results = []
  if (!fs.existsSync(dir)) return results
  const list = fs.readdirSync(dir, { withFileTypes: true })
  for (const item of list) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      results.push(...walkDir(full))
    } else if (item.isFile()) {
      results.push(full)
    }
  }
  return results
}

/**
 * Sincroniza fontes declaradas no catálogo local ~/.ade/catalog.
 *
 * @param {{
 *   config: { sources?: Array<{ name: string, repo: string, commit?: string, paths?: string[], license?: string }>, trust_default?: string, [key: string]: any },
 *   catalogDir: string,
 *   git?: any,
 *   validator?: any,
 *   journal?: any,
 *   rebuildIndex?: boolean,
 * }} options
 * @returns {Promise<{ indexPath: string, entries: any[], digest: string }>}
 */
export async function syncCatalog({ config = {}, catalogDir }) {
  if (!config || !Array.isArray(config.sources)) {
    throw new AdeError('catalog_source_not_allowlisted', 'Configuração de fontes ausente ou inválida', 4)
  }

  // Lock de sincronização
  fs.mkdirSync(catalogDir, { recursive: true })
  const lockDir = path.join(catalogDir, '.lock')
  try {
    fs.mkdirSync(lockDir)
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
      throw new AdeError('catalog_sync_locked', 'Outra sincronização do catálogo está em andamento', 3)
    }
    throw err
  }

  try {
    const allEntries = []

    for (const source of config.sources) {
      // Fase 0: resolve
      if (!source || typeof source !== 'object') {
        throw new AdeError('catalog_source_not_allowlisted', 'Fonte do catálogo deve ser um objeto allowlisted', 4)
      }
      if (!source.name || !source.commit) {
        throw new AdeError(
          'catalog_source_not_pinned',
          `Fonte '${source.name || 'desconhecida'}' sem commit fixado`,
          4,
        )
      }

      if (
        typeof source.name !== 'string' ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(source.name) ||
        source.name.includes('..')
      ) {
        throw new AdeError('catalog_source_not_allowlisted', `Nome de fonte inseguro: '${source.name}'`, 4)
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(source.commit)) {
        throw new AdeError('catalog_source_not_pinned', `Fonte '${source.name}' sem hash completo de commit`, 4)
      }
      if (source.paths !== undefined && (!Array.isArray(source.paths) || source.paths.some((item) => typeof item !== 'string'))) {
        throw new AdeError('catalog_path_outside_allowlist', `Lista de caminhos inválida na fonte '${source.name}'`, 4)
      }

      if (source.license && isBlockedLicense(source.license)) {
        throw new AdeError(
          'skill_license_blocked',
          `Fonte '${source.name}' com licença bloqueada: ${source.license}`,
          4,
        )
      }

      // Fase 2: checkout em sources/<name>@<commit>
      const sourceDir = path.join(catalogDir, 'sources', `${source.name}@${source.commit}`)
      fs.mkdirSync(sourceDir, { recursive: true })
      const sourceRoot = path.resolve(sourceDir)

      if (!source.repo || !fs.existsSync(source.repo)) {
        throw new AdeError('catalog_repo_not_found', `Repositório '${source.repo}' não encontrado`, 4)
      }

      // Lista todos os arquivos da árvore do commit via Git
      const lsTreeOut = execFileSync('git', ['ls-tree', '-r', '--name-only', source.commit], {
        cwd: source.repo,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })

      const filesInCommit = lsTreeOut.split(/\r?\n/).filter(Boolean)
      const declaredPaths = source.paths || ['skills/**']

      for (const file of filesInCommit) {
        if (!isPathDeclared(file, declaredPaths)) {
          continue
        }

        const destPath = path.join(sourceDir, file)
        const resolvedDest = path.resolve(destPath)
        if (!resolvedDest.startsWith(`${sourceRoot}${path.sep}`)) {
          throw new AdeError('catalog_path_outside_allowlist', `Caminho inseguro na fonte '${source.name}': ${file}`, 4)
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true })

        const fileContent = execFileSync('git', ['show', `${source.commit}:${file}`], {
          cwd: source.repo,
          maxBuffer: 16 * 1024 * 1024,
        })
        fs.writeFileSync(destPath, fileContent)
      }

      // Fase 3 a 7: escanear skills materializadas
      const skillsRoot = path.join(sourceDir, 'skills')
      if (fs.existsSync(skillsRoot)) {
        const skillDirs = fs
          .readdirSync(skillsRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(skillsRoot, d.name))

        for (const skillDir of skillDirs) {
          const folderName = path.basename(skillDir)
          const skillMdPath = path.join(skillDir, 'SKILL.md')
          if (!fs.existsSync(skillMdPath)) continue

          const rawContent = fs.readFileSync(skillMdPath, 'utf8')
          const { frontmatter: fm, body } = parseSkillMarkdown(rawContent)

          // Fase 5: Validação estrutural (nome igual ao diretório)
          if (!fm.name || fm.name !== folderName) {
            throw new AdeError(
              'skill_invalid_structure',
              `Nome da habilidade '${fm.name || ''}' diverge da pasta '${folderName}'`,
              4,
            )
          }

          // Fase 4: Licença
          const lic = fm.license || source.license
          if (!lic || isBlockedLicense(lic)) {
            throw new AdeError(
              'skill_license_blocked',
              `Licença '${lic || 'ausente'}' bloqueada ou não-permissiva`,
              4,
            )
          }

          // Fase 6: Scan SkillGuard
          const allSkillFiles = walkDir(skillDir)
          /** @type {Record<string, Buffer>} */
          const filesMap = {}
          for (const f of allSkillFiles) {
            const rel = path.relative(skillDir, f).replace(/\\/g, '/')
            filesMap[rel] = fs.readFileSync(f)
          }

          const scanResult = scanSkill({ files: filesMap })
          const fileHashes = Object.fromEntries(Object.entries(scanResult.hashes).sort(([a], [b]) => a.localeCompare(b)))
          const bytes = Object.values(filesMap).reduce((total, value) => total + Buffer.byteLength(value), 0)

          let trust = config.trust_default || 'allowlisted'
          let quarantineReason = undefined
          if (!scanResult.ok || scanResult.hasScripts) {
            trust = 'quarantine'
            quarantineReason = scanResult.hasScripts ? 'has_scripts' : scanResult.findings.join(', ')
          }

          const domains = fm.domains || (fm.metadata?.domains ? fm.metadata.domains : [])
          const languages = fm.languages || (fm.metadata?.languages ? fm.metadata.languages : [])
          const families = fm.families || (fm.metadata?.families ? fm.metadata.families : [])
          const tags = fm.tags || (fm.metadata?.tags ? fm.metadata.tags : [])

          /** @type {any} */
          const entry = {
            id: fm.name,
            name: fm.name,
            source: source.name,
            commit: source.commit,
            sha256: scanResult.hashes['SKILL.md'] || createHash('sha256').update(rawContent).digest('hex'),
            file_hashes: fileHashes,
            bytes,
            license: lic,
            domains: Array.isArray(domains) ? domains : [domains],
            languages: Array.isArray(languages) ? languages : [languages],
            families: Array.isArray(families) ? families : [families],
            tags: Array.isArray(tags) ? tags : [tags],
            body_tokens: Math.ceil(body.length / 4),
            has_scripts: scanResult.hasScripts,
            trust,
            description: fm.description || '',
            when_to_use: fm.when_to_use || '',
            references: Array.isArray(fm.references)
              ? fm.references.filter((ref) => /^references\/[A-Za-z0-9._/-]+\.md$/i.test(String(ref)) && !String(ref).includes('..'))
              : [],
          }

          if (quarantineReason) {
            entry.quarantine_reason = quarantineReason
          }

          allEntries.push(entry)
        }
      }
    }

    allEntries.sort((a, b) => a.id.localeCompare(b.id))

    // Gravação atômica do index.json
    const indexPath = path.join(catalogDir, 'index.json')
    const indexData = {
      format_version: 1,
      built_at: '2026-09-21T00:00:00Z',
      engine_stamp: 'ade-catalog-2026-09',
      entries: allEntries,
    }

    const tempIndexPath = `${indexPath}.${Date.now()}.tmp`
    fs.writeFileSync(tempIndexPath, JSON.stringify(indexData, null, 2), 'utf8')
    fs.renameSync(tempIndexPath, indexPath)

    const digest = createHash('sha256')
      .update(canonicalize(allEntries) || JSON.stringify(allEntries))
      .digest('hex')

    return {
      indexPath,
      entries: allEntries,
      digest,
    }
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * Lista habilidades do catálogo filtrando por domain, trust ou source.
 *
 * @param {{
 *   index: { entries: any[] },
 *   domain?: string,
 *   trust?: string,
 *   source?: string,
 * }} options
 * @returns {any[]}
 */
export function listCatalog({ index, domain, trust, source }) {
  if (!index || !Array.isArray(index.entries)) return []

  return index.entries.filter((e) => {
    if (domain) {
      const lower = domain.toLowerCase()
      const domains = (e.domains || []).map((/** @type {any} */ d) => String(d).toLowerCase())
      if (!domains.includes(lower)) return false
    }

    if (trust && e.trust !== trust) {
      return false
    }

    if (source && e.source !== source) {
      return false
    }

    return true
  })
}

/**
 * Inspeciona os detalhes e achados de segurança de uma habilidade do catálogo.
 *
 * @param {{
 *   index: { entries: any[] },
 *   id: string,
 *   includeBody?: boolean,
 *   catalogDir?: string,
 * }} options
 * @returns {{
 *   entry: any,
 *   frontmatter: Record<string, any>,
 *   findings: string[],
 *   quarantineReason?: string,
 *   body?: string,
 * }}
 */
export function inspectCatalog({ index, id, includeBody = false, catalogDir }) {
  if (!index || !Array.isArray(index.entries)) {
    throw new AdeError('catalog_not_found', 'índice do catálogo não encontrado', 1)
  }

  const entry = index.entries.find((e) => e.id === id || e.name === id)
  if (!entry) {
    throw new AdeError('skill_not_found', `habilidade '${id}' não encontrada`, 1)
  }

  const frontmatter = {
    name: entry.name,
    description: entry.description,
    license: entry.license,
    when_to_use: entry.when_to_use,
    domains: entry.domains,
    languages: entry.languages,
    families: entry.families,
    tags: entry.tags,
  }

  const findings = []
  if (entry.quarantine_reason) {
    findings.push(entry.quarantine_reason)
  }

  /** @type {any} */
  const result = {
    entry,
    frontmatter,
    findings,
    quarantineReason: entry.quarantine_reason,
    body: undefined,
  }

  if (includeBody) {
    let body = ''
    if (catalogDir) {
      const candidates = [
        path.join(catalogDir, 'sources', `${entry.source}@${entry.commit}`, 'skills', entry.id, 'SKILL.md'),
        path.join(catalogDir, 'sources', entry.source, 'skills', entry.id, 'SKILL.md'),
        path.join(catalogDir, 'quarantine', `${entry.source}@${entry.commit}`, 'skills', entry.id, 'SKILL.md'),
      ]
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8')
          const parsed = parseSkillMarkdown(raw)
          body = parsed.body.trim()
          break
        }
      }
    }
    result.body = body
  }

  return result
}

/**
 * Carrega exclusivamente habilidades aprovadas, conferindo o índice contra os bytes pinados.
 *
 * @param {{ catalogDir: string, approvedSkills: string[] }} options
 * @returns {{ skills: any[], snapshot: Array<{ id: string, sha256: string }> }}
 */
export function loadApprovedSkills({ catalogDir, approvedSkills }) {
  if (!Array.isArray(approvedSkills)) {
    throw new AdeError('catalog_approval_invalid', 'Lista de habilidades aprovadas inválida', 4)
  }
  if (approvedSkills.length === 0) return { skills: [], snapshot: [] }

  const indexPath = path.join(catalogDir, 'index.json')
  if (!fs.existsSync(indexPath)) {
    throw new AdeError('catalog_not_found', 'Catálogo sincronizado não encontrado', 3)
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const skills = []

  for (const id of [...new Set(approvedSkills)].sort()) {
    const entry = index.entries?.find((/** @type {any} */ candidate) => candidate.id === id)
    if (!entry || entry.trust === 'quarantine' || entry.has_scripts) {
      throw new AdeError('skill_not_eligible', `Habilidade aprovada '${id}' não está elegível`, 3)
    }

    const skillDir = path.join(catalogDir, 'sources', `${entry.source}@${entry.commit}`, 'skills', entry.id)
    const files = walkDir(skillDir)
    const actualHashes = Object.fromEntries(
      files
        .map((file) => {
          const relative = path.relative(skillDir, file).replace(/\\/g, '/')
          return [relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
        })
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
    if ((canonicalize(actualHashes) || '') !== (canonicalize(entry.file_hashes || { 'SKILL.md': entry.sha256 }) || '')) {
      throw new AdeError('skill_catalog_changed', `Habilidade '${id}' divergiu do índice sincronizado`, 3)
    }

    const skillPath = path.join(skillDir, 'SKILL.md')
    const raw = fs.readFileSync(skillPath, 'utf8')
    const parsed = parseSkillMarkdown(raw)
    const references = []
    for (const reference of entry.references || []) {
      const referencePath = path.resolve(skillDir, reference)
      const referencesRoot = path.resolve(skillDir, 'references')
      if (!referencePath.startsWith(`${referencesRoot}${path.sep}`) || !referencePath.toLowerCase().endsWith('.md')) {
        throw new AdeError('skill_invalid_reference', `Referência insegura em '${id}': ${reference}`, 4)
      }
      references.push({ path: reference, content: fs.readFileSync(referencePath, 'utf8') })
    }

    skills.push({
      ...entry,
      name: entry.name || entry.id,
      source: `${entry.source}@${entry.commit}`,
      content: parsed.body,
      references,
      domain: entry.domains?.[0],
      language: entry.languages?.[0],
    })
  }

  return {
    skills,
    snapshot: skills.map((skill) => ({ id: skill.id, sha256: skill.sha256 })),
  }
}
