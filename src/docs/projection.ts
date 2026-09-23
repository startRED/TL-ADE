import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { projectUnits } from '../cli/project.js'
import { AdeError, JournalCorruptError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { validate } from '../schema/index.ts'

export type UnitProjection = {
  unit: string,
  status: string,
  reason: string | null,
  commit: string | null,
  evalPassed: boolean,
  reviewApproved: boolean,
}

export type ArchitectureRow = {
  id: string,
  component: string,
  responsibility: string,
  milestone: string,
}

export type FileRevision = { commit: string | null, updated_at: string | null }

/** Status de `story_done` em que a unidade já produziu commit revisado. */
const DONE_STATUSES = new Set(['delivered', 'committed'])

/** Motivos de parada que significam capacidade/dependência indisponível, não trabalho pendente. */
const UNAVAILABLE_REASON = /canary|unavailable|indispon|not_found|offline|binary/i

/** Projeções cujo conteúdo é derivado; nunca entram no diagnóstico como fonte. */
const GENERATED_DIRNAME = 'generated'

/**
 * Normaliza caminho com barras normais para comparações portáveis.
 *
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Converte falha de I/O em erro de fonte documental (falha fechado, sem projeção parcial).
 *
 */
function sourceError(target: string, cause: unknown): AdeError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new AdeError('docs_source_unreadable', `fonte documental ilegível: ${target}: ${reason}`, 2, {
    target,
  })
}

/**
 * Parser simples de front-matter YAML no formato chave: valor e listas - item.
 *
 */
function parseSimpleYaml(yamlStr: string): Record<string,any> {
  const result: Record<string,any> = {}
  const lines = yamlStr.split(/\r?\n/)
  let currentArrayKey: string|null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const arrayItemMatch = line.match(/^\s*-\s+(.*)$/)
    if (arrayItemMatch && currentArrayKey) {
      if (!Array.isArray(result[currentArrayKey])) {
        result[currentArrayKey] = []
      }
      result[currentArrayKey].push(arrayItemMatch[1].trim())
      continue
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/)
    if (kvMatch) {
      const key = kvMatch[1].trim()
      const val = kvMatch[2].trim()
      if (val === '') {
        currentArrayKey = key
        result[key] = []
      } else {
        currentArrayKey = null
        result[key] = val
      }
    }
  }

  return result
}

/**
 * Varre recursivamente diretório em busca de arquivos markdown, exceto as projeções geradas.
 * Falha fechado: diretório existente e ilegível é erro, não ausência de evidência.
 *
 */
function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const results: string[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw sourceError(dir, err)
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === GENERATED_DIRNAME) continue
      results.push(...findMarkdownFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath)
    }
  }

  return results
}

/**
 * Lê um arquivo obrigatório já existente, falhando fechado em erro de leitura.
 *
 */
function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw sourceError(file, err)
  }
}

/**
 * Deriva as unidades e suas evidências a partir dos eventos canônicos do motor.
 *
 * Evidência de eval vem de `step_intent`/`step_result` com `effect_class: 'eval_run'`
 * (o `step_result` só carrega `step_id`, a unidade vem do intent correspondente);
 * evidência de revisão vem de `review_result` aprovado.
 *
 */
export function extractUnits(journalEvents: ReadonlyArray<Record<string,any>> = []): UnitProjection[] {
  const events = journalEvents ?? []

  const stepUnits: Map<string,string> = new Map()
  const evalPassed: Set<string> = new Set()
  const reviewApproved: Set<string> = new Set()

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue

    // `Journal.append` move campos fora do envelope para `data`; journals externos
    // podem trazê-los no topo. Ler os dois cobre o formato persistido pelo motor.
    if (ev.kind === 'step_intent' && typeof ev.step_id === 'string') {
      const unit = ev.data?.unit ?? ev.unit
      if (typeof unit === 'string') stepUnits.set(ev.step_id, unit)
      continue
    }

    if (ev.kind === 'step_result' && ev.effect_class === 'eval_run' && ev.status === 'ok') {
      const unit = stepUnits.get(String(ev.step_id))
      const result = ev.data?.result ?? ev.result
      if (unit && result?.phase === 'green' && result?.verdict === 'green') {
        evalPassed.add(unit)
      }
      continue
    }

    if (ev.kind === 'review_result' && (ev.data?.approved === true || ev.approved === true)) {
      const unit = ev.data?.unit ?? ev.unit
      if (typeof unit === 'string') reviewApproved.add(unit)
    }
  }

  return projectUnits(events)
    .map((u) => ({
      ...u,
      evalPassed: evalPassed.has(u.unit),
      reviewApproved: reviewApproved.has(u.unit),
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit))
}

/**
 * Classifica uma unidade nas 4 categorias normativas.
 *
 */
export function classifyUnit(u: UnitProjection): 'validado'|'implementado'|'indisponivel'|'pendente' {
  if (DONE_STATUSES.has(u.status)) {
    return u.evalPassed && u.reviewApproved ? 'validado' : 'implementado'
  }

  if (u.status === 'parked' || (typeof u.reason === 'string' && UNAVAILABLE_REASON.test(u.reason))) {
    return 'indisponivel'
  }

  return 'pendente'
}

/**
 * Marca de evidência: o instante do último evento do journal, não o relógio da execução.
 * Sem journal não há evidência e a projeção declara isso em vez de inventar uma data.
 *
 */
function evidenceUpTo(events: ReadonlyArray<Record<string,any>>): string {
  let latest = ''
  for (const ev of events ?? []) {
    // `at` é o campo do envelope do journal; `time` cobre journals externos que usam esse nome.
    const time = ev?.at ?? ev?.time
    if (typeof time === 'string' && time > latest) latest = time
  }
  return latest || 'sem evidência (journal ausente)'
}

/**
 * Formata a lista de unidades de uma categoria.
 *
 */
function formatUnits(list: UnitProjection[]): string {
  if (list.length === 0) return '*(nenhuma unidade nesta categoria)*\n'
  return (
    list
      .map((u) => {
        let extra = ''
        if (u.commit) extra += `, commit: ${u.commit}`
        if (u.reason) extra += `, motivo: ${u.reason}`
        return `- **${u.unit}** (status: ${u.status}${extra})`
      })
      .join('\n') + '\n'
  )
}

/**
 * Extrai a tabela de componentes da seção "Componentes" de `docs/architecture.md`.
 *
 */
export function parseArchitectureComponents(markdown: string): ArchitectureRow[] {
  const rows: ArchitectureRow[] = []
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 5) continue
    if (!/^C\d+$/.test(cells[0])) continue
    rows.push({
      id: cells[0],
      component: cells[1],
      responsibility: cells[2],
      milestone: cells[cells.length - 1],
    })
  }
  return rows
}

/**
 * Gera as projeções documentais a partir de evidências já carregadas.
 * Toda fonte ausente é projetada como indisponível; nada é preenchido por padrão otimista.
 *
 */
export function generateDocProjections(options: {
journalEvents?: ReadonlyArray<Record<string,any>>
capabilities?: Record<string,any>|null
architecture?: ArchitectureRow[]|null
schemas?: string[]|null
diagnosis?: ReturnType<typeof diagnoseDocs>|null
} = {}): Record<string,string> {
  const events = options.journalEvents ?? []
  const units = extractUnits(events)
  const stamp = evidenceUpTo(events)

  const validado = units.filter((u) => classifyUnit(u) === 'validado')
  const implementado = units.filter((u) => classifyUnit(u) === 'implementado')
  const indisponivel = units.filter((u) => classifyUnit(u) === 'indisponivel')
  const pendente = units.filter((u) => classifyUnit(u) === 'pendente')

  const currentStatusContent = `# Estado Atual do Projeto

Evidência até: ${stamp}

## Unidades Validadas (validado)
${formatUnits(validado)}
## Unidades Implementadas (implementado)
${formatUnits(implementado)}
## Unidades Indisponíveis (indisponível)
${formatUnits(indisponivel)}
## Unidades Pendentes (pendente)
${formatUnits(pendente)}`

  // capabilities.md — sem `.ade/capabilities.json` a capacidade é indisponível, não homologada.
  const caps = options.capabilities ?? null
  let capabilitiesBody
  if (!caps) {
    capabilitiesBody = `## Diagnóstico de Provedores
- **Fonte:** indisponível (\`.ade/capabilities.json\` ausente; rode \`ade doctor\`)

## Modelos Homologados
*(indisponível: sem capability set medido)*
`
  } else {
    const models = Array.isArray(caps.models) ? [...caps.models] : []
    models.sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))
    const modelsList =
      models.length === 0
        ? '*(nenhum modelo registrado)*\n'
        : models
            .map(
              (m) =>
                `- **${m.id}** (vendor: ${m.vendor ?? 'desconhecido'}, sonda: ${
                  m.probe_ok === true ? 'OK' : m.probe_ok === false ? 'falhou' : 'não verificada'
                })`,
            )
            .join('\n') + '\n'

    capabilitiesBody = `## Diagnóstico de Provedores
- **Versão do formato:** ${caps.format_version ?? 'não declarada'}
- **Medido em:** ${caps.probed_at ?? 'não declarado'}

## Modelos Homologados
${modelsList}`
  }

  const capabilitiesContent = `# Capacidades de Modelos e Execução

Evidência até: ${stamp}

${capabilitiesBody}`

  // architecture-map.md — projetado de docs/architecture.md e dos schemas realmente publicados.
  const rows = options.architecture ?? null
  const schemas = options.schemas ?? null
  const table =
    rows === null
      ? '*(indisponível: `docs/architecture.md` ausente)*\n'
      : rows.length === 0
        ? '*(nenhum componente declarado)*\n'
        : `| ID | Componente | Marco declarado |
| :-- | :--- | :-- |
${rows.map((r) => `| ${r.id} | ${r.component} | ${r.milestone} |`).join('\n')}
`

  const schemaList =
    schemas === null
      ? '*(indisponível: diretório `schemas/` ausente)*\n'
      : schemas.length === 0
        ? '*(nenhum schema publicado)*\n'
        : schemas.map((s) => `- \`${s}\``).join('\n') + '\n'

  const architectureMapContent = `# Mapa de Componentes de Arquitetura

Evidência até: ${stamp}
Fonte: \`docs/architecture.md\` (seção Componentes) e \`schemas/\`.

${table}
## Schemas publicados
${schemaList}`

  // quality-report.md
  const diagnosis = options.diagnosis ?? null
  const diagnosisBody = diagnosis
    ? `- **Documentos escaneados:** ${diagnosis.summary.scanned_files}
- **Referências inválidas:** ${diagnosis.summary.invalid_count}
- **Documentos com evidência antiga:** ${diagnosis.summary.stale_count}
`
    : '*(diagnóstico não executado)*\n'

  const qualityReportContent = `# Relatório de Qualidade e Governança

Evidência até: ${stamp}

## Resumo de Execução
- **Total de unidades monitoradas:** ${units.length}
- **Validadas:** ${validado.length}
- **Implementadas:** ${implementado.length}
- **Indisponíveis:** ${indisponivel.length}
- **Pendentes:** ${pendente.length}

## Evidência por Unidade
- **Com eval verde registrado:** ${units.filter((u) => u.evalPassed).length}
- **Com revisão independente aprovada:** ${units.filter((u) => u.reviewApproved).length}

## Diagnóstico Documental
${diagnosisBody}`

  return {
    'current-status.md': currentStatusContent,
    'capabilities.md': capabilitiesContent,
    'architecture-map.md': architectureMapContent,
    'quality-report.md': qualityReportContent,
  }
}

/**
 * Revisão e data de um caminho citado, obtidas do Git e, fora de um repositório, do mtime.
 *
 * ponytail: uma chamada `git log` por caminho citado; agrupar por commit só se o diagnóstico
 * começar a pesar em repositórios com muitas citações.
 *
 */
function fileRevision(repoDir: string, relPath: string): FileRevision|null {
  const abs = path.resolve(repoDir, relPath)
  if (!fs.existsSync(abs)) return null

  try {
    const out = execFileSync('git', ['-C', repoDir, 'log', '-1', '--format=%H%x09%cI', '--', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) {
      const [commit, updatedAt] = out.split('\t')
      return { commit, updated_at: updatedAt ?? null }
    }
  } catch {
    // Fora de um repositório Git (ou caminho não rastreado) a data do sistema de arquivos
    // ainda é evidência válida de "mudou depois da verificação".
  }

  return { commit: null, updated_at: fs.statSync(abs).mtime.toISOString() }
}

/**
 * Diz se a revisão do caminho citado é posterior à verificação declarada no documento.
 * Hash diferente não é sinal de nada: compara datas e, sem elas, ancestralidade no Git.
 * Sem evidência de que mudou depois, o documento não é acusado de desatualizado.
 *
 * @returns descrição da mudança posterior, ou '' quando não há
 */
function describeChangeAfterVerification(repoDir: string, revision: { commit?: string|null; updated_at?: string|null }, frontMatter: Record<string,any>): string {
  if (revision.updated_at && frontMatter.verified_at) {
    const changedAt = new Date(revision.updated_at).getTime()
    const verifiedAt = new Date(frontMatter.verified_at).getTime()
    if (Number.isNaN(changedAt) || Number.isNaN(verifiedAt)) return ''
    return changedAt > verifiedAt
      ? `mudou em ${revision.updated_at}, verificado em ${frontMatter.verified_at}`
      : ''
  }

  if (revision.commit && frontMatter.verified) {
    const verified = String(frontMatter.verified)
    try {
      execFileSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', revision.commit, verified], {
        stdio: 'ignore',
      })
      return ''
    } catch {
      // Saída não-zero: ou a revisão é posterior ao commit verificado, ou o Git não resolve
      // um dos dois. Só acusamos quando ambos existem no repositório.
      return commitExists(repoDir, revision.commit) && commitExists(repoDir, verified)
        ? `está em ${revision.commit}, posterior ao commit verificado ${verified}`
        : ''
    }
  }

  return ''
}

function commitExists(repoDir: string, rev: string): boolean {
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', `${rev}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Diagnostica integridade da documentação: referências inválidas e evidências desatualizadas.
 *
 */
export function diagnoseDocs(options: {
repoDir?: string
fileCommits?: Record<string,{ commit?: string|null; updated_at?: string|null }>
} = {}): {
summary: { scanned_files: number; invalid_count: number; stale_count: number }
invalid_references: Array<{ file: string; target: string }>
stale_documents: Array<{ file: string; reason: string }>
} {
  const repoDir = path.resolve(options.repoDir ?? process.cwd())
  const docsDir = path.join(repoDir, 'docs')
  const override = options.fileCommits ?? null

  const mdFiles = findMarkdownFiles(docsDir)

  const invalidReferences: Array<{ file: string; target: string }> = []
  const staleDocuments: Array<{ file: string; reason: string }> = []

  const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g

  for (const absFile of mdFiles) {
    const relFile = normalizePath(path.relative(repoDir, absFile))
    const content = readTextFile(absFile)

    // 1. Front-matter: evidência citada que mudou depois da verificação declarada.
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fmMatch) {
      const frontMatter = parseSimpleYaml(fmMatch[1])
      for (const cite of Array.isArray(frontMatter.cites) ? frontMatter.cites : []) {
        const normCite = normalizePath(String(cite))
        const revision =
          override?.[normCite] ?? override?.[path.basename(normCite)] ?? fileRevision(repoDir, normCite)
        if (!revision) continue

        const change = describeChangeAfterVerification(repoDir, revision, frontMatter)
        const reason = change ? `Evidência desatualizada (stale): ${normCite} ${change}` : ''

        if (reason) {
          staleDocuments.push({ file: relFile, reason })
          break
        }
      }
    }

    // 2. Links locais que não resolvem para nenhum arquivo.
    for (const match of content.matchAll(LINK_REGEX)) {
      const rawTarget = match[2].trim()
      if (!rawTarget || /^(#|https?:|mailto:)/.test(rawTarget)) continue

      const cleanTarget = rawTarget.split('#')[0].split('?')[0].trim()
      if (!cleanTarget) continue

      const resolvedFromDoc = path.resolve(path.dirname(absFile), cleanTarget)
      const resolvedFromRepo = path.resolve(repoDir, cleanTarget)

      if (!fs.existsSync(resolvedFromDoc) && !fs.existsSync(resolvedFromRepo)) {
        invalidReferences.push({ file: relFile, target: cleanTarget })
      }
    }
  }

  return {
    summary: {
      scanned_files: mdFiles.length,
      invalid_count: invalidReferences.length,
      stale_count: staleDocuments.length,
    },
    invalid_references: invalidReferences,
    stale_documents: staleDocuments,
  }
}

/**
 * Sugere limpeza e correção de documentos sem apagar nenhum arquivo.
 *
 */
export function gcDocs(options: { repoDir?: string } = {}): { suggestions: Array<{ action: string; file: string; detail: string }> } {
  const diagnosis = diagnoseDocs({ repoDir: options.repoDir })
  const suggestions: Array<{ action: string; file: string; detail: string }> = []

  for (const inv of diagnosis.invalid_references) {
    suggestions.push({
      action: 'limpar',
      file: inv.file,
      detail: `Referência quebrada para '${inv.target}'`,
    })
  }

  for (const st of diagnosis.stale_documents) {
    suggestions.push({ action: 'revisar', file: st.file, detail: st.reason })
  }

  return { suggestions }
}

/**
 * Carrega os eventos do journal da missão indicada (ou da mais recente).
 * Journal presente e ilegível ou malformado é erro, não ausência de evidência.
 *
 */
function loadJournalEvents(repoDir: string, missionDir?: string): Array<Record<string,any>> {
  let journalPath = ''
  if (missionDir) {
    const direct = path.join(missionDir, 'journal.jsonl')
    const nested = path.join(repoDir, missionDir, 'journal.jsonl')
    journalPath = fs.existsSync(direct) ? direct : nested
    if (!fs.existsSync(journalPath)) {
      throw new AdeError('docs_source_missing', `journal não encontrado para a missão ${missionDir}`, 4, {
        missionDir,
      })
    }
  } else {
    const missionsRoot = path.join(repoDir, '.ade', 'missions')
    if (!fs.existsSync(missionsRoot)) return []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(missionsRoot, { withFileTypes: true })
    } catch (err) {
      throw sourceError(missionsRoot, err)
    }
    const dirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    for (const name of [...dirs].reverse()) {
      const candidate = path.join(missionsRoot, name, 'journal.jsonl')
      if (fs.existsSync(candidate)) {
        journalPath = candidate
        break
      }
    }
    if (!journalPath) return []
  }

  // Leitura íntegra do motor: schema, sequência, cadeia `prev` e canonicalização.
  const { events, tornTail } = readJournal(journalPath)
  if (tornTail) {
    // Cauda truncada é evidência incompleta: reconciliar é do motor, não da projeção.
    throw new JournalCorruptError(tornTail.line, 'torn_tail')
  }
  return events
}

/**
 * Carrega o capability set medido pelo doctor. Ausente devolve `null` (indisponível);
 * presente e inválido é erro.
 *
 */
function loadCapabilities(repoDir: string): Record<string,any>|null {
  const capsPath = path.join(repoDir, '.ade', 'capabilities.json')
  if (!fs.existsSync(capsPath)) return null

  const raw = readTextFile(capsPath)
  try {
    const parsed = JSON.parse(raw)
    const result = validate('capability-set', parsed)
    if (!result.valid) {
      throw new TypeError(
        `viola capability-set.schema.json: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      )
    }
    return parsed
  } catch (err) {
    throw new AdeError(
      'docs_source_invalid',
      `capability set inválido: ${capsPath}: ${err instanceof Error ? err.message : String(err)}`,
      2,
      { target: capsPath },
    )
  }
}

/**
 * Lista os schemas publicados. Diretório ausente devolve `null` (indisponível).
 *
 */
function loadSchemas(repoDir: string): string[]|null {
  const schemasDir = path.join(repoDir, 'schemas')
  if (!fs.existsSync(schemasDir)) return null
  try {
    return fs
      .readdirSync(schemasDir)
      .filter((f) => f.endsWith('.schema.json'))
      .sort()
  } catch (err) {
    throw sourceError(schemasDir, err)
  }
}

/**
 * Sincroniza as projeções documentais em `docs/generated/`.
 * Gera tudo antes de escrever: uma fonte inválida aborta sem deixar projeção parcial.
 *
 */
export function syncDocProjections(options: { repoDir?: string; missionDir?: string } = {}): string[] {
  const repoDir = path.resolve(options.repoDir ?? process.cwd())

  const projections = generateDocProjections({
    journalEvents: loadJournalEvents(repoDir, options.missionDir),
    capabilities: loadCapabilities(repoDir),
    architecture: (() => {
      const archPath = path.join(repoDir, 'docs', 'architecture.md')
      return fs.existsSync(archPath) ? parseArchitectureComponents(readTextFile(archPath)) : null
    })(),
    schemas: loadSchemas(repoDir),
    diagnosis: diagnoseDocs({ repoDir }),
  })

  const generatedDir = path.join(repoDir, 'docs', GENERATED_DIRNAME)
  fs.mkdirSync(generatedDir, { recursive: true })

  const writtenPaths: string[] = []
  for (const [filename, content] of Object.entries(projections)) {
    const dest = path.join(generatedDir, filename)
    fs.writeFileSync(dest, content, 'utf8')
    writtenPaths.push(dest)
  }

  return writtenPaths
}
