import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { getOrProduceArtifact } from '../artifacts/cache.ts'
import { discoverProject } from './discovery.ts'
import { codeMap, symbolExcerpts } from './code-map.ts'
import { resolveScopeOwners } from './scope-owners.ts'
import { GitWorkspace } from '../workspace/git.ts'
import { FolderWorkspace } from '../workspace/folder.ts'
import { measurePackBytes, SECTION_CAPS } from '../pack/pack.ts'
export { compileDomainContext } from './domain.ts'

const EXECUTABLE_REFERENCE = /(?:^|[\\/])(?:scripts?|hooks?)(?:[\\/]|$)|(?:^|[\\/])install\.(?:sh|bash|py|js|mjs|bat|cmd|ps1)\b|\.(?:sh|bash|py|js|mjs|exe|bat|cmd|ps1)\b/i
// total de tokens de skills que cabe na seção skills do pack (4 bytes por token, com folga para cabeçalho)
const SKILL_TOKENS_TOTAL = Math.floor((SECTION_CAPS.skills as number) / 4) - 2000

/** Skill de revisão vai para o revisor, não para o maker (ponytail-review, code-review-and-quality, security-review). */
export function isReviewSkill(id: string): boolean {
  return /(^|-)review(er)?(-|$)/.test(id) && id !== 'receiving-code-review'
}

/** Skill de teste vai também para quem escreve a prova (tdd, test-driven-development, javascript-testing-patterns). */
export function isTestSkill(id: string): boolean {
  return /(^|-)(tdd|tests?|testing|vitest|e2e)(-|$)|test-driven/.test(id)
}

const ROLE_SKILLS = {
  review: { keep: isReviewSkill, header: 'Guias de revisão para esta parte. Valem como critério extra de leitura; o contrato, a política e as regras de evidência acima sempre valem mais.' },
  proof: { keep: isTestSkill, header: 'Guias de teste para esta parte. A missão roda sem humano: onde um guia mandar perguntar, decida pelo contrato; o contrato e a política acima sempre valem mais.' },
}

/**
 * Seção de skills do pack de um papel além do maker: o revisor recebe as de revisão e quem escreve a prova, as de
 * teste, entre as que o plano escolheu para a parte. Sem teto por skill.
 */
export function roleSkillsSection(role: keyof typeof ROLE_SKILLS, contractSkills: unknown, eligibleSkills: any[] = []): { section: string; skills: Array<{ name: string; source: string; sha256: string; bytes: number }> } {
  const { keep, header } = ROLE_SKILLS[role]
  const wanted = (Array.isArray(contractSkills) ? contractSkills : []).filter((id): id is string => typeof id === 'string' && keep(id))
  const picked = wanted.map((id) => eligibleSkills.find((s) => s.name === id)).filter(Boolean)
  const bodies = picked.map((s: any) => ({ s, body: sanitizeSkillText(s.content || '') })).filter((x) => x.body)
  if (bodies.length === 0) return { section: '', skills: [] }
  return {
    section: [header, ...bodies.map((x) => `### Skill: ${x.s.name}\n\n${x.body}`)].join('\n\n'),
    skills: bodies.map((x) => ({ name: x.s.name, source: x.s.source || '', sha256: x.s.sha256 || '', bytes: Buffer.byteLength(x.body) })),
  }
}

function sanitizeSkillText(text: string) {
  let body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  body = body.replace(/```[\s\S]*?```/g, (block) => EXECUTABLE_REFERENCE.test(block) ? '' : block)
  return body
    .split(/\r?\n/)
    .filter((line) => !EXECUTABLE_REFERENCE.test(line))
    .join('\n')
    .trim()
}

/**
 * Converte um padrão glob simples em expressão regular.
 */
function patternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Verifica se um caminho relativo está dentro do escopo permitido e fora do do_not_touch.
 */
function isPathInScope(filePath: string, scopePaths: string[] = ['src/**'], doNotTouch: string[] = []): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  for (const dnt of doNotTouch) {
    if (patternToRegex(dnt).test(normalized)) return false
  }
  for (const sp of scopePaths) {
    if (patternToRegex(sp).test(normalized)) return true
  }
  return false
}

/**
 * Seleciona determinísticamente até quatro skills aprovadas correspondentes ao domínio e linguagem da story.
 */
export function selectEligibleSkills({ story, eligibleSkills = [], approvedSkills }: {
        story: any
        eligibleSkills?: Array<{ name: string; domain?: string; language?: string; source?: string; sha256?: string; bytes?: number; content?: string }>
        approvedSkills?: string[]
    }): string[] {
  // Allowlist estrita: sem conjunto aprovado declarado nenhuma skill entra.
  const approvedList = approvedSkills ?? story?.approved_skills ?? []
  if (!Array.isArray(approvedList) || approvedList.length === 0) {
    return []
  }
  const storyDomain = (story?.domain || '').toLowerCase()
  const storyLang = (story?.language || '').toLowerCase()

  const storyId = (story?.id || '').toLowerCase()
  const storyTask = (story?.task || '').toLowerCase()
  const surfaces =  ((story?.risk?.surfaces || []) as unknown[]).map((s) => String(s).toLowerCase())
  const scopePaths =  ((story?.guardrails?.scope_paths || []) as unknown[]).map((p) => String(p).toLowerCase())

  const filtered = eligibleSkills.filter((skill) => {
    // Nenhuma skill fora do conjunto aprovado entra; a de revisão vai para o revisor
    if (!approvedList.includes(skill.name) || isReviewSkill(skill.name)) {
      return false
    }

    const skillDomain = (skill.domain || '').toLowerCase()
    const skillLang = (skill.language || '').toLowerCase()

    // Correspondência de domínio
    if (storyDomain) {
      if (skillDomain && skillDomain !== storyDomain) return false
    } else if (skillDomain) {
      const domainRelevant =
        storyId.includes(skillDomain) ||
        storyTask.includes(skillDomain) ||
        surfaces.some((s) => s.includes(skillDomain)) ||
        scopePaths.some((p) => p.includes(skillDomain))
      if (!domainRelevant) return false
    }

    // Correspondência de linguagem
    if (storyLang && skillLang && skillLang !== storyLang) {
      return false
    }

    return true
  })

  // Ordenação determinística por nome
  filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  // Sem número fixo: o plano escolhe quantas a parte pede; o teto é o espaço da seção de skills do pack.
  return filtered.map((s) => s.name)
}

/**
 * Formata notas de operador mais recentes consumindo até 600 bytes.
 */
function extractRecentOperatorNotes(operatorNotes?: string[]): string {
  if (!Array.isArray(operatorNotes) || operatorNotes.length === 0) {
    return ''
  }

  // Drena a fila in-place
  const notes = operatorNotes.splice(0, operatorNotes.length)

  // Orçamento máximo de 580 bytes para o corpo das notas
  const maxBytes = 580
  const selected = []
  let budget = maxBytes

  for (let i = notes.length - 1; i >= 0; i--) {
    const note = String(notes[i])
    const noteBytes = Buffer.byteLength(note, 'utf8')
    if (noteBytes <= budget) {
      selected.unshift(note)
      budget -= noteBytes
    } else if (budget > 0) {
      let truncated = ''
      for (const ch of note) {
        if (Buffer.byteLength(truncated + ch, 'utf8') <= budget) {
          truncated += ch
        } else {
          break
        }
      }
      if (truncated.length > 0) {
        selected.unshift(truncated)
      }
      break
    }
  }

  return selected.join('\n')
}

/**
 * Monta o contexto compacto por story.
 */
export async function buildStoryContext(input: {
        loaded: any
        story: any
        worktreeDir?: string
        missionDir?: string
        operatorNotes?: string[]
    }, deps: {
    scopeRules?: Array<{ pattern: string; owner: string; ref?: string }>
    eligibleSkills?: any[]
    producer?: () => Promise<any>
    journal?: any
    ir?: any
    limits?: { max_pack_bytes?: number; section_bytes?: Record<string, number> }
} = {}): Promise<{
    sections: { contract: string; policy: string; story: string; retrieved: string; skills: string }
    artifactRefs: string[]
    selectedSkills: Array<{ name: string; source: string; sha256: string; bytes: number; domain?: string; language?: string; content: string; references: any[] }>
    bytes: number
    cacheHit: boolean
}> {
  const { loaded, story, worktreeDir, missionDir, operatorNotes } = input
  // O motor entrega a story normalizada `{ id, contract, spec_revision, evals }`: tarefa, escopo,
  // riscos e skills vivem no contrato aninhado. A forma achatada continua valendo para o planejador.
  const contract = story.contract && typeof story.contract === 'object'
    ? { id: story.id, ...story.contract }
    : story
  const scopePaths = contract.guardrails?.scope_paths || ['src/**']
  const doNotTouch = contract.guardrails?.do_not_touch || []

  // Allowlist fail-closed das skills: com os dois conjuntos declarados só entra quem está nos dois.
  const planApproved = Array.isArray(loaded?.plan?.authorization?.eligible_skills)
    ? loaded.plan.authorization.eligible_skills
    : (Array.isArray(loaded?.plan?.approved_skills) ? loaded.plan.approved_skills : null)
  const contractSkills = Array.isArray(contract.skills) ? contract.skills : null
  const approvedSkills = planApproved && contractSkills
    ? contractSkills.filter((/** */ name: string) => planApproved.includes(name))
    : (planApproved ?? contractSkills ?? [])

  // Conteúdo imutável do contrato: entra na chave do cache e na seção contract.
  const contractSection = typeof story.contract === 'string'
    ? story.contract
    : JSON.stringify(story.contract || story, null, 2)

  // 1. Workspace atual (o snapshot é a identidade da árvore; falha aqui não vira estado "unknown")
  let workspace = null
  if (worktreeDir) {
    if (!fs.existsSync(worktreeDir)) {
      throw new AdeError('invalid_worktree_dir', `worktree inexistente: ${worktreeDir}`, 4)
    }
    workspace = fs.existsSync(path.join(worktreeDir, '.git'))
      ? new GitWorkspace({ worktreeDir })
      : new FolderWorkspace({ rootDir: worktreeDir })
  }

  let snapDigest = 'no-workspace'
  let snapRevision = 'no-workspace'
  let snapPaths: string[] = []
  if (workspace) {
    const snap = await workspace.snapshot()
    snapDigest = snap.digest
    snapRevision = snap.revision
    snapPaths = snap.paths
    if (!snapDigest || !snapRevision) {
      throw new AdeError('invalid_workspace_snapshot', 'snapshot do workspace sem digest ou revisão', 4)
    }
  }

  // 2. Cache da análise cara: mesma árvore, mesmo contrato e mesma configuração reusam o artefato.
  const cacheSpec = {
    producer: 'story-context',
    producer_version: '2.0.0',
    input_digest: digest16({
      treeDigest: snapDigest,
      treeRevision: snapRevision,
      storyId: story.id,
      specRevision: story.spec_revision || '',
      contract: contractSection,
    }),
    config_digest: digest16({
      planId: loaded?.plan?.id || '',
      approvedSkills,
      eligibleSkills: (deps.eligibleSkills || []).map((s) => ({ name: s.name, sha256: s.sha256 ?? null })),
      scopePaths,
      doNotTouch,
      scopeRules: deps.scopeRules ?? null,
      limits: deps.limits ?? null,
      irDigest: deps.ir?.digest ?? deps.ir?.ref ?? null,
      producerProvided: Boolean(deps.producer),
    }),
    schema_version: 1,
    missionDir,
    journal: deps.journal,
  }

  const cacheResult = await getOrProduceArtifact(cacheSpec, async () => {
    // A descoberta do projeto é a análise cara; fica dentro do produtor para não repetir no acerto.
    const discovered = workspace ? await discoverProject(workspace) : null
    const produced = typeof deps.producer === 'function' ? await deps.producer() : null
    return { discovery: discovered, produced }
  })

  const cacheHit = cacheResult.cacheHit
  const cachedData = cacheResult.artifact
  const discovery = cachedData?.discovery ?? null

  // 3. Regras de escopo
  const allRules = deps.scopeRules || discovery?.scope_rules || []
  const matchedRules = resolveScopeOwners({ paths: scopePaths, rules: allRules })

  // 4. Símbolos e relações relevantes
  let rawSymbols = []

  if (cachedData?.produced?.symbols) {
    rawSymbols = cachedData.produced.symbols
  } else if (deps.ir?.data?.symbols) {
    rawSymbols = deps.ir.data.symbols
  } else if (discovery?.symbols) {
    rawSymbols = discovery.symbols
  }

  // Filtra símbolos contidos exclusivamente no escopo
  const inScopeSymbols = rawSymbols.filter((s: any) => {
    if (!s.path) return true
    return isPathInScope(s.path, scopePaths, doNotTouch)
  })

  // Filtra testes contidos no escopo
  const inScopeTests = (discovery?.related_tests || []).filter((t: any) => {
    return isPathInScope(t.targetModule, scopePaths, doNotTouch)
  })

  // 5. Skills aprovadas e selecionadas
  const knownSkills = deps.eligibleSkills || []
  const selectedNames = selectEligibleSkills({
    story: contract,
    eligibleSkills: knownSkills,
    approvedSkills,
  })

  
  const selectedSkills: any[] = []
  for (const name of selectedNames) {
    const sk = knownSkills.find((s) => s.name === name)
    if (sk) {
      selectedSkills.push({
        name: sk.name,
        source: sk.source || 'catalog@01dc2ec',
        sha256: sk.sha256 || createHash('sha256').update(sk.content || sk.name).digest('hex'),
        bytes: typeof sk.bytes === 'number' ? sk.bytes : Buffer.byteLength(sk.content || sk.name, 'utf8'),
        content: sk.content,
        domain: sk.domain,
        language: sk.language,
        references: sk.references || [],
      })
    }
  }

  let skillTokens = 0
  for (const skill of selectedSkills) {
    let content = sanitizeSkillText(skill.content || '')
    for (const reference of skill.references) {
      const cleanReference = sanitizeSkillText(reference.content || '')
      if (!cleanReference) continue
      const candidate = `${content}\n\n#### Referência: ${reference.path}\n\n${cleanReference}`.trim()
      if (skillTokens + Math.ceil(candidate.length / 4) <= SKILL_TOKENS_TOTAL) content = candidate
    }
    // Sem teto por skill (as boas são pesadas); só o total precisa caber na seção de skills do pack.
    const tokens = Math.ceil(content.length / 4)
    if (skillTokens + tokens > SKILL_TOKENS_TOTAL) {
      throw new AdeError('skill_budget_exceeded', `Habilidade '${skill.name}' excede o orçamento de contexto`, 4)
    }
    skill.content = content
    skill.bytes = Buffer.byteLength(content, 'utf8')
    skillTokens += tokens
  }

  // 6. Registro de notas do operador (até 600 bytes, drenadas da fila)
  const recentNotes = extractRecentOperatorNotes(operatorNotes)

  // 7. Referências de artefatos
  const artifactRefs = []

  if (deps.ir?.ref) {
    artifactRefs.push(deps.ir.ref)
  } else if (deps.ir?.digest) {
    artifactRefs.push(`art:repo-ir/${deps.ir.digest}`)
  }

  for (const rule of matchedRules) {
    if (rule.ref) artifactRefs.push(rule.ref)
  }

  for (const ref of contract.risk?.evidence || []) {
    artifactRefs.push(ref)
  }

  for (const sym of inScopeSymbols) {
    if (sym.ref) {
      artifactRefs.push(sym.ref)
    } else if (sym.name) {
      artifactRefs.push(`repo:symbol:${sym.name}`)
    }
  }

  for (const test of inScopeTests) {
    artifactRefs.push(`repo:path:${test.testPath}`)
  }

  // Registra no journal os artefatos usados e metadados das skills injetadas
  if (deps.journal && typeof deps.journal.append === 'function' && selectedSkills.length > 0) {
    await deps.journal.append({
      kind: 'skills_injected',
      unit: story.id,
      data: {
        skills: selectedSkills.map((s) => ({
          name: s.name,
          source: s.source,
          sha256: s.sha256,
          bytes: s.bytes,
          cited: false,
        })),
        artifact_refs: artifactRefs,
      },
    })
  }

  // 8. Construção das seções
  const policySection = JSON.stringify(loaded?.plan?.authorization ?? {}, null, 2)

  // Sanitização das skills para injeção no pack (sem frontmatter)
  const skillBodies = []
  for (const sk of selectedSkills) {
    const cleanBody = sk.content.trim()
    if (cleanBody) {
      skillBodies.push(`### Skill: ${sk.name}\n\n${cleanBody}`)
    }
  }
  // Skills de terceiros são escritas para sessão com humano; a missão roda desatendida.
  const SKILLS_HEADER = 'Guias de método para esta parte. A missão roda sem humano: onde um guia mandar perguntar ou confirmar com o usuário, decida pelo contrato (escopo, critérios, arquivo de prova) e siga; ignore menções a outras skills, sub-agentes ou comandos que você não tem. O contrato e a política acima sempre valem mais que um guia.'
  const skillsSection = skillBodies.length > 0 ? [SKILLS_HEADER, ...skillBodies].join('\n\n') : ''

  // Mapa símbolo@linha dos arquivos do escopo e trechos dos símbolos que as interfaces do contrato nomeiam.
  const interfaces = story.interfaces ?? contract.interfaces ?? []
  if (!Array.isArray(interfaces) || interfaces.some((item: unknown) => typeof item !== 'string')) {
    throw new AdeError('invalid_story_contract', 'interfaces da story deve ser lista de textos', 4)
  }
  const interfaceNames = interfaces.flatMap((item: string) => [...item.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
  const scopeFiles = snapPaths.filter((p) => isPathInScope(p, scopePaths, doNotTouch))
  // Trechos antes do mapa: o pack corta a seção pelo fim, e os trechos das interfaces valem mais que o mapa.
  const retrievedSection = worktreeDir
    ? [await symbolExcerpts(worktreeDir, scopeFiles, interfaceNames), await codeMap(worktreeDir, scopeFiles)].filter(Boolean).join('\n\n')
    : ''

  const maxPackBytes = deps.limits?.max_pack_bytes ?? 400000

  // Função auxiliar para renderizar a seção story
  const renderStorySection = (symbolsCount: number) => {
    const parts = [
      `story_id: ${story.id}`,
      `task: ${contract.task || ''}`,
      `scope_paths: ${JSON.stringify(scopePaths)}`,
    ]

    if (matchedRules.length > 0) {
      parts.push(`scope_rules: ${JSON.stringify(matchedRules.map((r) => ({ owner: r.owner, pattern: r.pattern })))}`)
    }

    if (contract.risk) {
      parts.push(`risk: ${JSON.stringify(contract.risk)}`)
    }

    if (selectedSkills.length > 0) {
      parts.push(`skills: ${JSON.stringify(selectedSkills.map((s) => ({ name: s.name, source: s.source, sha256: s.sha256 })))}`)
    }

    if (inScopeTests.length > 0) {
      parts.push(`related_tests: ${JSON.stringify(inScopeTests.map((t: any) => t.testPath))}`)
    }

    const displayedSymbols = inScopeSymbols.slice(0, symbolsCount)
    if (displayedSymbols.length > 0) {
      parts.push(`symbols: ${JSON.stringify(displayedSymbols.map((s: any) => ({ name: s.name, kind: s.kind, path: s.path, line: s.line })))}`)
    }

    if (symbolsCount < inScopeSymbols.length) {
      const irRef = deps.ir?.ref || (deps.ir?.digest ? `art:repo-ir/${deps.ir.digest}` : 'art:repo-ir')
      parts.push(`[... recoverable symbols reduced; full symbols at ${irRef}]`)
    }

    if (recentNotes) {
      parts.push(`operator_notes:\n${recentNotes}`)
    }

    return parts.join('\n\n')
  }

  let symbolsCount = inScopeSymbols.length
  let storySection = renderStorySection(symbolsCount)
  let currentSections = {
    contract: contractSection,
    policy: policySection,
    story: storySection,
    retrieved: retrievedSection,
    skills: skillsSection,
  }
  let totalBytes = measurePackBytes(currentSections)

  // Redução de conteúdo recuperável (símbolos) se exceder o limite
  if (totalBytes > maxPackBytes && symbolsCount > 0) {
    let low = 0
    let high = symbolsCount
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2)
      const testStory = renderStorySection(mid)
      const testBytes = measurePackBytes({ ...currentSections, story: testStory })
      if (testBytes <= maxPackBytes) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    symbolsCount = low
    storySection = renderStorySection(symbolsCount)
    currentSections.story = storySection
    totalBytes = measurePackBytes(currentSections)

    const irRef = deps.ir?.ref || (deps.ir?.digest ? `art:repo-ir/${deps.ir.digest}` : 'art:repo-ir')
    if (!artifactRefs.includes(irRef)) {
      artifactRefs.unshift(irRef)
    }
  }

  return {
    sections: currentSections,
    artifactRefs,
    selectedSkills,
    bytes: totalBytes,
    cacheHit,
  }
}

/** Teto do conteúdo imutável do contrato, em bytes UTF-8. */
const CONTRACT_MAX_BYTES = 32000

/** `npx` baixa e executa pacote arbitrário: proibido como verificador. */
const FORBIDDEN_EXECUTABLES = new Set(['npx', 'npx.cmd'])

/**
 * Resolve o executável como o executor resolveria: caminho dentro do workspace preparado,
 * binário de node_modules/.bin ou entrada real do PATH. Script de package.json não é executável.
 */
function resolvesToExecutable(execName: string, workspaceDir?: string): boolean {
  if (execName.includes('/') || execName.includes('\\')) {
    const candidate = path.isAbsolute(execName)
      ? execName
      : workspaceDir
        ? path.join(workspaceDir, execName)
        : null
    return candidate !== null && fs.existsSync(candidate)
  }

  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']

  const dirs = []
  if (workspaceDir) dirs.push(path.join(workspaceDir, 'node_modules', '.bin'))
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir)
  }

  for (const dir of dirs) {
    for (const ext of extensions) {
      if (fs.existsSync(path.join(dir, execName + ext))) return true
    }
  }
  return false
}

/**
 * Recusa a story antes de montar contexto, reservar cota ou despachar modelo quando o
 * contrato estoura o teto ou quando um verificador aponta para comando que não existe.
 */
export function guardStoryContext({ story, contract, workspaceDir }: { story: any; contract?: any; workspaceDir?: string }): { status: 'ready' } | { status: 'story_pack_overflow'; reason: string; error: AdeError } | { status: 'refused'; reason: string } {
  const contractObj = contract ?? story?.contract ?? story
  const contractStr = typeof contractObj === 'string' ? contractObj : JSON.stringify(contractObj, null, 2)
  const contractBytes = Buffer.byteLength(contractStr, 'utf8')

  if (contractBytes > CONTRACT_MAX_BYTES) {
    return {
      status: ('story_pack_overflow' as const),
      reason: 'story_pack_overflow',
      error: new AdeError(
        'story_pack_overflow',
        `contrato tem ${contractBytes} bytes e excede o teto de ${CONTRACT_MAX_BYTES} bytes`,
        4,
      ),
    }
  }

  // `plan-load` normaliza verificadores de script para `argv`; o contrato bruto ainda usa `cmd`.
  const commands = [
    ...(Array.isArray(story?.evals) ? story.evals : []),
    ...(Array.isArray(contractObj?.evals) ? contractObj.evals : []),
    ...(Array.isArray(contractObj?.verifiers) ? contractObj.verifiers : []),
    ...(Array.isArray(story?.scenarios) ? story.scenarios.map((s: any) => s?.eval) : []),
    ...(Array.isArray(contractObj?.scenarios) ? contractObj.scenarios.map((s: any) => s?.eval) : []),
  ]
    // Só verificador de script executa comando; juiz e schema não têm argv para conferir.
    .filter((item) => item && (item.kind === undefined || item.kind === 'script'))
    .map((item) => item.argv ?? item.cmd)
    .filter((cmd) => cmd !== undefined && cmd !== null)

  for (const cmd of commands) {
    if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== 'string' || !cmd[0].trim()) {
      return { status: ('refused' as const), reason: 'eval_cmd_unknown' }
    }
    const execName = cmd[0].trim()
    if (FORBIDDEN_EXECUTABLES.has(execName.toLowerCase())) {
      return { status: ('refused' as const), reason: 'verifier_command_forbidden' }
    }
    if (!resolvesToExecutable(execName, workspaceDir)) {
      return { status: ('refused' as const), reason: 'verifier_command_missing' }
    }
  }

  return { status: ('ready' as const) }
}

/**
 * Prepara o contexto da story validando limites do contrato e comandos de verificadores
 * antes de reservar cota ou despachar modelo.
 */
export async function prepareStoryContext(options: {
        loaded: any
        story: any
        worktreeDir?: string
        missionDir?: string
        operatorNotes?: string[]
    }, deps: any = {}): Promise<any> {
  const { loaded, story, worktreeDir, missionDir, operatorNotes } = options

  // 1 e 2. Teto do contrato e verificadores, antes de qualquer contexto, cota ou despacho.
  const guard = guardStoryContext({ story, workspaceDir: worktreeDir })
  if (guard.status !== 'ready') {
    return guard
  }

  // 3. Monta o contexto da story após workspace preparado
  const context = await buildStoryContext(
    {
      loaded,
      story,
      worktreeDir,
      missionDir,
      operatorNotes,
    },
    deps,
  )

  // 4. Reserva de cota e despacho (somente se validações passaram)
  if (deps?.quotaPort && typeof deps.quotaPort.reserveQuota === 'function') {
    await deps.quotaPort.reserveQuota({ storyId: story.id, contextBytes: context.bytes })
  }

  if (deps?.dispatcher && typeof deps.dispatcher === 'function') {
    return await deps.dispatcher({ story, context })
  }

  return {
    status: 'ready',
    context,
  }
}
