import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { openJournal, readJournal } from '../src/journal/journal.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      removeRepo(dir)
    } catch {
      try {
        removeTmpDir(dir)
      } catch {
        // ignora falhas de limpeza no teardown
      }
    }
  }
  tmpDirs = []
})

// Carrega o módulo sob teste dinamicamente para garantir registro e execução das provas nesta fase
async function getStoryContextModule() {
  try {
    return await import('../src/context/story.ts')
  } catch {
    return null
  }
}

describe('Montar contexto compacto por story', () => {
  // Critério 1: Dada uma story aprovada, quando seu workspace é preparado, então o pacote contém
  // somente o contrato, as regras, os símbolos, os testes, os riscos e as skills relevantes ao seu escopo,
  // com referências para consultar a evidência completa.
  test('criterio_1_story_aprovada_pacote_contem_apenas_escopo_relevante_com_referencias', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { buildStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    // Prepara arquivos no workspace em escopos distintos
    fs.mkdirSync(path.join(repo.dir, 'src', 'auth'), { recursive: true })
    fs.mkdirSync(path.join(repo.dir, 'src', 'billing'), { recursive: true })
    fs.mkdirSync(path.join(repo.dir, 'tests', 'auth'), { recursive: true })
    fs.mkdirSync(path.join(repo.dir, 'tests', 'billing'), { recursive: true })

    fs.writeFileSync(path.join(repo.dir, 'src', 'auth', 'login.js'), 'export function login(user) { return true; }\n')
    fs.writeFileSync(path.join(repo.dir, 'src', 'billing', 'invoice.js'), 'export function invoice() { return 100; }\n')
    fs.writeFileSync(path.join(repo.dir, 'tests', 'auth', 'login.test.js'), 'import { login } from "../../src/auth/login.js";\n')
    fs.writeFileSync(path.join(repo.dir, 'tests', 'billing', 'invoice.test.js'), 'import { invoice } from "../../src/billing/invoice.js";\n')
    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'vitest run' } }))

    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'initial commit'])

    const story = {
      id: 's1-auth',
      task: 'Implementar autenticação de login',
      spec_revision: '01dc2ec',
      guardrails: {
        scope_paths: ['src/auth/**'],
        do_not_touch: ['src/billing/**'],
      },
      risk: {
        surfaces: ['auth'],
        evidence: ['repo:path:src/auth/login.js'],
      },
      requirements: [
        { id: 'R1', ears: 'WHEN user credentials valid THE SYSTEM SHALL login' },
      ],
      scenarios: [
        { id: 'C1', given: 'valid user', when: 'login called', then: 'token returned', verifiers: ['V1'] },
      ],
    }

    const loaded = {
      plan: {
        id: 'plan-1',
        budget: { max_model_calls: 3 },
        authorization: { allowed_paths: ['src/auth/**'] },
        approved_skills: ['skill-auth-jwt'],
      },
      missionBudget: { max_usd: 10 },
    }

    const scopeRules = [
      { pattern: 'src/auth/**', owner: 'auth.md', ref: 'docs/reference/auth.md' },
      { pattern: 'src/billing/**', owner: 'billing.md', ref: 'docs/reference/billing.md' },
    ]

    const knownSkills = [
      { name: 'skill-auth-jwt', domain: 'auth', language: 'javascript', source: 'catalog@01dc2ec', sha256: 'a'.repeat(64), bytes: 150, content: 'export function jwt() {}' },
      { name: 'skill-billing-tax', domain: 'billing', language: 'javascript', source: 'catalog@01dc2ec', sha256: 'b'.repeat(64), bytes: 200, content: 'export function tax() {}' },
    ]

    const contextResult = await buildStoryContext(
      {
        loaded,
        story,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes: [],
      },
      {
        scopeRules,
        eligibleSkills: knownSkills,
      },
    )

    expect(contextResult).toHaveProperty('sections')
    expect(contextResult).toHaveProperty('artifactRefs')
    expect(contextResult).toHaveProperty('selectedSkills')
    expect(contextResult).toHaveProperty('bytes')
    expect(contextResult).toHaveProperty('cacheHit')

    const { sections, selectedSkills, artifactRefs } = contextResult
    expect(sections.contract).toBeDefined()
    expect(sections.contract).toContain('s1-auth')

    // Regras e símbolos de billing NÃO devem entrar
    expect(JSON.stringify(sections)).not.toContain('src/billing/invoice.js')
    expect(JSON.stringify(sections)).not.toContain('billing.md')

    // Apenas skill relevante ao escopo aprovado entra
    expect(selectedSkills.map((s: any) => s.name || s)).toEqual(['skill-auth-jwt'])
    expect(selectedSkills.map((s: any) => s.name || s)).not.toContain('skill-billing-tax')

    // Referências para evidência completa
    expect(artifactRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^repo:|^art:|^docs:/),
      ]),
    )
  })

  // Critério 2: Dadas várias skills conhecidas, quando o contexto é montado, então no máximo
  // três correspondências determinísticas de domínio e linguagem são incluídas, nenhuma skill fora do
  // conjunto aprovado entra e cada inclusão registra origem, resumo criptográfico e tamanho.
  test('criterio_2_skills_conhecidas_selecao_deterministica_ate_tres_skills_aprovadas_com_metadados', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { selectEligibleSkills, buildStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'vitest run' } }))
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base'])

    const story = {
      id: 's2-skills',
      domain: 'auth',
      language: 'javascript',
      guardrails: { scope_paths: ['src/**'] },
    }

    const knownSkills = [
      { name: 'skill-alpha-auth', domain: 'auth', language: 'javascript', source: 'catalog@01dc2ec', sha256: '1'.repeat(64), bytes: 100, content: 'skill alpha' },
      { name: 'skill-beta-auth', domain: 'auth', language: 'javascript', source: 'catalog@01dc2ec', sha256: '2'.repeat(64), bytes: 200, content: 'skill beta' },
      { name: 'skill-gamma-auth', domain: 'auth', language: 'javascript', source: 'catalog@01dc2ec', sha256: '3'.repeat(64), bytes: 300, content: 'skill gamma' },
      { name: 'skill-delta-auth', domain: 'auth', language: 'javascript', source: 'catalog@01dc2ec', sha256: '4'.repeat(64), bytes: 400, content: 'skill delta' },
      { name: 'skill-unapproved-malicious', domain: 'auth', language: 'javascript', source: 'local', sha256: '5'.repeat(64), bytes: 500, content: 'evil skill' },
    ]

    const approvedSkills = ['skill-alpha-auth', 'skill-beta-auth', 'skill-gamma-auth', 'skill-delta-auth']

    const loaded = {
      plan: {
        id: 'plan-2',
        approved_skills: approvedSkills,
      },
    }

    // Seleção contida de skills
    const selected = selectEligibleSkills({
      story,
      eligibleSkills: knownSkills,
      approvedSkills,
    })

    expect(selected.length).toBeLessThanOrEqual(4)
    expect(selected.length).toBe(4)
    expect(selected).not.toContain('skill-unapproved-malicious')

    // Contexto com metadados verificáveis de cada skill (E59)
    const contextResult = await buildStoryContext(
      {
        loaded,
        story,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes: [],
      },
      {
        eligibleSkills: knownSkills,
      },
    )

    expect(contextResult.selectedSkills.length).toBeLessThanOrEqual(4)
    for (const skill of contextResult.selectedSkills) {
      expect(skill).toHaveProperty('name')
      expect(skill).toHaveProperty('source')
      expect(skill.source).toMatch(/^catalog@|^local/)
      expect(skill).toHaveProperty('sha256')
      expect(skill.sha256).toMatch(/^[0-9a-fA-F]{64}$/)
      expect(skill).toHaveProperty('bytes')
      expect(typeof skill.bytes).toBe('number')
      expect(skill.bytes).toBeGreaterThan(0)
      expect(approvedSkills).toContain(skill.name)
    }
  })

  // Critério 3: Dada a mesma árvore, contrato e configuração, quando o contexto é solicitado novamente,
  // então o artefato certificado é reutilizado e nenhuma análise cara é repetida.
  test('criterio_3_mesma_arvore_contrato_e_configuracao_reutiliza_artefato_sem_analise_cara', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { buildStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-cache', scripts: { test: 'vitest run' } }))
    fs.writeFileSync(path.join(repo.dir, 'index.js'), 'export const v = 1;\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base commit'])

    const story = {
      id: 's3-cache',
      task: 'Validar cache do contexto',
      spec_revision: '01dc2ec',
      guardrails: { scope_paths: ['index.js'] },
    }

    const loaded = {
      plan: { id: 'plan-3', approved_skills: [] },
    }

    let expensiveProducerCalls = 0
    const expensiveProducer = async () => {
      expensiveProducerCalls++
      return {
        symbols: [{ name: 'v', kind: 'const', path: 'index.js', line: 1 }],
        relations: [],
      }
    }

    const journal = openJournal({ missionDir, runtimeStamp: '1:abc:def' })

    const first = await buildStoryContext(
      {
        loaded,
        story,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes: [],
      },
      {
        producer: expensiveProducer,
        journal,
      },
    )

    expect(first.cacheHit).toBe(false)
    expect(expensiveProducerCalls).toBe(1)

    const second = await buildStoryContext(
      {
        loaded,
        story,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes: [],
      },
      {
        producer: expensiveProducer,
        journal,
      },
    )

    expect(second.cacheHit).toBe(true)
    expect(expensiveProducerCalls).toBe(1)
    expect(second.bytes).toBe(first.bytes)
    expect(second.sections).toEqual(first.sections)

    await journal.close()

    const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
    const hitEvent = events.find((e) => e.kind === 'cache_hit' || e.data?.cache_hit === true)
    expect(hitEvent).toBeDefined()
  })

  // Critério 4: Dadas notas de orientação enfileiradas, quando a próxima story é preparada,
  // então até 600 bytes das notas mais recentes entram como contexto, a fila é drenada uma única vez
  // e o contrato aprovado não é alterado.
  test('criterio_4_notas_operador_ate_600_bytes_drenadas_uma_vez_preservando_contrato', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { buildStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-notes' }))
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base'])

    const originalStory = {
      id: 's4-notes',
      task: 'Tarefa original da story',
      requirements: [{ id: 'R1', ears: 'THE SYSTEM SHALL remain unchanged' }],
      guardrails: { scope_paths: ['src/**'] },
    }
    const storyCopy = JSON.parse(JSON.stringify(originalStory))

    const loaded = {
      plan: { id: 'plan-4', approved_skills: [] },
    }

    const noteOld = 'Nota antiga: priorizar estabilidade.'
    const noteRecent = 'Nota recente: ' + 'Z'.repeat(700)
    const operatorNotes = [noteOld, noteRecent]

    const firstResult = await buildStoryContext(
      {
        loaded,
        story: storyCopy,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes,
      },
    )

    const taskSection = firstResult.sections.story || JSON.stringify(firstResult.sections)
    expect(taskSection).toContain('Nota recente')
    const notesMatch = taskSection.match(/operator_notes:?([\s\S]*?)(?:===|$)/i) || [taskSection, taskSection]
    const notesLength = Buffer.byteLength(notesMatch[1] || notesMatch[0], 'utf8')
    expect(notesLength).toBeLessThanOrEqual(600)

    // Fila drenada uma única vez
    expect(operatorNotes.length).toBe(0)

    // Contrato aprovado permanece inalterado
    expect(storyCopy.task).toBe(originalStory.task)
    expect(storyCopy.requirements).toEqual(originalStory.requirements)
    expect(storyCopy).toEqual(originalStory)

    // Próxima story com fila drenada não reinjeta notas
    const secondResult = await buildStoryContext(
      {
        loaded,
        story: storyCopy,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes,
      },
    )
    const secondSection = secondResult.sections.story || JSON.stringify(secondResult.sections)
    expect(secondSection).not.toContain(noteRecent.slice(0, 50))
  })

  // Critério 5: Dado contexto recuperado maior que o limite, quando o pacote é medido,
  // então conteúdo recuperável é reduzido com referência ao original; se o próprio contrato continuar
  // acima de 32.000 bytes, a story retorna story_pack_overflow para divisão e nenhum modelo é despachado.
  test('criterio_5_contexto_recuperavel_reduzido_e_contrato_acima_32000_retorna_story_pack_overflow', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { buildStoryContext, prepareStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'test-overflow' }))
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'base'])

    // Caso A: Contexto recuperável grande com contrato pequeno
    const smallContractStory = {
      id: 's5-small-contract',
      task: 'Tarefa curta',
      guardrails: { scope_paths: ['src/**'] },
    }

    const hugeRecoverableIr = {
      digest: 'abcdef1234567890',
      data: {
        symbols: Array.from({ length: 500 }, (_, i) => ({
          name: `func_${i}_${'X'.repeat(80)}`,
          kind: 'function',
          path: `src/mod_${i}.js`,
          line: i,
          ref: `repo:symbol:func_${i}`,
        })),
        relations: [],
      },
    }

    const loaded = { plan: { id: 'plan-5', approved_skills: [] } }

    const reducedResult = await buildStoryContext(
      {
        loaded,
        story: smallContractStory,
        worktreeDir: repo.dir,
        missionDir,
        operatorNotes: [],
      },
      {
        ir: hugeRecoverableIr,
        limits: { max_pack_bytes: 24000 },
      },
    )

    expect(reducedResult.bytes).toBeLessThanOrEqual(24000)
    expect(reducedResult.artifactRefs.length).toBeGreaterThan(0)
    expect(reducedResult.artifactRefs).toContainEqual(expect.stringMatching(/^art:|^repo:/))

    // Caso B: O contrato em si excede 32.000 bytes (E50) -> story_pack_overflow e zero despacho
    const hugeContractStory = {
      id: 's5-huge-contract',
      task: 'Contrato enorme ' + 'W'.repeat(33000),
      guardrails: { scope_paths: ['src/**'] },
      requirements: [
        { id: 'R1', ears: 'E'.repeat(33000) },
      ],
    }

    let modelDispatched = false
    let quotaReserved = false

    const fakeDeps = {
      quotaPort: {
        reserveQuota: async () => { quotaReserved = true },
        readReceipt: () => ({ status: 'ok' }),
      },
      dispatcher: async () => {
        modelDispatched = true
        return { status: 'ok' }
      },
    }

    let overflowOutcome: any = null
    try {
      overflowOutcome = await prepareStoryContext(
        {
          loaded,
          story: hugeContractStory,
          worktreeDir: repo.dir,
          missionDir,
          operatorNotes: [],
        },
        fakeDeps,
      )
    } catch (err: any) {
      overflowOutcome = { status: err.code || err.message, error: err }
    }

    const statusOrReason = overflowOutcome?.status || overflowOutcome?.reason || overflowOutcome?.error?.code
    expect(statusOrReason).toBe('story_pack_overflow')

    // Zero despacho e zero reserva
    expect(modelDispatched).toBe(false)
    expect(quotaReserved).toBe(false)
  })

  // Critério 6: Dado um verificador cujo comando não existe na descoberta atual do workspace,
  // quando a story é preparada, então ela é recusada antes de reservar cota ou iniciar o agente.
  test('criterio_6_verificador_com_comando_ausente_no_workspace_recusado_antes_de_cota_ou_agente', async () => {
    const mod = await getStoryContextModule()
    expect(mod, 'módulo src/context/story.ts deve ser importável').not.toBeNull()
    const { prepareStoryContext } = mod!

    const repo = makeRepo()
    tmpDirs.push(repo.dir)
    const missionDir = makeTmpDir('ade-mission-')
    tmpDirs.push(missionDir)

    fs.writeFileSync(
      path.join(repo.dir, 'package.json'),
      JSON.stringify({
        name: 'test-verifier-check',
        scripts: {
          test: 'vitest run',
        },
      }, null, 2),
    )
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'initial commit'])

    const storyWithMissingVerifier = {
      id: 's6-missing-verifier',
      task: 'Story com verificador ausente',
      guardrails: { scope_paths: ['src/**'] },
      scenarios: [
        {
          id: 'C1',
          given: 'ambiente inicial',
          when: 'executa verificação',
          then: 'deve passar',
          eval: {
            cmd: ['nonexistent-runner', 'tests/foo.test.js'],
          },
          verifiers: ['V_MISSING'],
        },
      ],
    }

    const loaded = {
      plan: {
        id: 'plan-6',
        budget: { max_model_calls: 3 },
        approved_skills: [],
      },
    }

    let quotaReserved = false
    let agentStarted = false

    const fakeDeps = {
      quotaPort: {
        reserveQuota: async () => { quotaReserved = true },
        readReceipt: () => ({ status: 'ok' }),
      },
      dispatcher: async () => {
        agentStarted = true
        return { status: 'ok' }
      },
    }

    let result: any = null
    try {
      result = await prepareStoryContext(
        {
          loaded,
          story: storyWithMissingVerifier,
          worktreeDir: repo.dir,
          missionDir,
          operatorNotes: [],
        },
        fakeDeps,
      )
    } catch (err: any) {
      result = { status: 'refused', reason: err.code || err.message, error: err }
    }

    expect(['refused', 'eval_cmd_unknown', 'verifier_command_missing']).toContain(result.status || result.reason)
    expect(result.reason || result.status).toMatch(/eval_cmd_unknown|verifier_command_missing|refused/)

    // Recusada antes de reservar cota ou iniciar o agente
    expect(quotaReserved).toBe(false)
    expect(agentStarted).toBe(false)
  })
})

// 25/09: skill de revisão (ponytail-review, code-review-and-quality) vai só para o revisor; o maker recebe as outras,
// sem número fixo e sem teto por skill (impeccable e as de taste são pesadas e entram inteiras).
test('skills_de_revisao_vao_para_o_revisor_e_o_maker_recebe_as_outras_sem_numero_fixo', async () => {
  const { selectEligibleSkills, roleSkillsSection } = await import('../src/context/story.ts')
  const heavy = 'regra de interface. '.repeat(3000)
  const skills = ['ponytail', 'ponytail-review', 'impeccable', 'minimalist-ui', 'gpt-taste', 'code-review-and-quality', 'receiving-code-review']
    .map((name) => ({ name, source: 'local', sha256: name, content: name === 'impeccable' ? heavy : `corpo ${name}` }))
  const maker = selectEligibleSkills({ story: {}, eligibleSkills: skills, approvedSkills: skills.map((s) => s.name) })
  expect(maker).toEqual(['gpt-taste', 'impeccable', 'minimalist-ui', 'ponytail', 'receiving-code-review'])
  const review = roleSkillsSection('review', skills.map((s) => s.name), skills)
  expect(review.skills.map((s) => s.name)).toEqual(['ponytail-review', 'code-review-and-quality'])
  expect(review.section).toContain('### Skill: ponytail-review')
  // quem escreve a prova recebe só as de teste; o maker também as recebe
  const withTests = [...skills, ...['test-driven-development', 'javascript-testing-patterns', 'typescript-advanced-types'].map((name) => ({ name, source: 's', sha256: name, content: `corpo ${name}` }))]
  expect(roleSkillsSection('proof', withTests.map((s) => s.name), withTests).skills.map((s) => s.name)).toEqual(['test-driven-development', 'javascript-testing-patterns'])
})
