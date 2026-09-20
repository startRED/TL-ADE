import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, removeRepo } from './helpers/git-repo.js'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js'
import { openJournal, readJournal } from '../src/journal/journal.js'
import { WorkspacePort } from '../src/workspace/port.js'
import { GitWorkspace } from '../src/workspace/git.js'
import { FolderWorkspace } from '../src/workspace/folder.js'
import { computeArtifactCacheKey, getOrProduceArtifact } from '../src/artifacts/cache.js'
import { recordOrReplay } from '../src/artifacts/recording.js'
import { discoverProject } from '../src/context/discovery.js'
import { buildRepoIr } from '../src/context/repo-ir.js'
import { rankRepoContext } from '../src/context/rank.js'
import { queryCode } from '../src/context/tools.js'
import { sampleInput } from '../src/context/sample.js'
import { compileDomainContext } from '../src/context/domain.js'
import { resolveScopeOwners } from '../src/context/scope-owners.js'

describe('Certificar descoberta e contexto do projeto', () => {
  // Critério 1: Dado um workspace Git ou uma pasta versionada, quando a descoberta for executada duas vezes sem mudança, então produz o mesmo digest, os mesmos fatos e nenhuma nova análise cara.
  test('criterio_1_descoberta_determinismo_mesmo_digest_sem_mudanca', async () => {
    const { dir, git } = makeRepo()
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'sample-project', version: '1.0.0', scripts: { test: 'vitest run' } }),
      )
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export function hello() { return "world"; }')
      git(['add', '-A'])
      git(['commit', '-m', 'initial commit'])

      const gitWs = new GitWorkspace({ worktreeDir: dir })
      const snap1 = await gitWs.snapshot()
      const snap2 = await gitWs.snapshot()

      expect(snap1.digest).toBe(snap2.digest)
      expect(snap1.revision).toBe(snap2.revision)
      expect(snap1.paths).toEqual(snap2.paths)

      let expensiveCalls = 0
      const expensiveProducer = async () => {
        expensiveCalls++
        return { inferences: [] }
      }

      const disc1 = await discoverProject(gitWs, { producer: expensiveProducer })
      const disc2 = await discoverProject(gitWs, { producer: expensiveProducer })

      expect(disc1.digest).toBe(disc2.digest)
      expect(disc1.facts).toEqual(disc2.facts)
      expect(expensiveCalls).toBe(0)

      // Teste idêntico para FolderWorkspace
      const folderDir = makeTmpDir('ade-folder-')
      try {
        fs.writeFileSync(path.join(folderDir, 'README.md'), '# Folder Doc')
        const folderWs = new FolderWorkspace({ rootDir: folderDir })
        const fSnap1 = await folderWs.snapshot()
        const fSnap2 = await folderWs.snapshot()
        expect(fSnap1.digest).toBe(fSnap2.digest)
        expect(fSnap1.paths).toEqual(fSnap2.paths)

        const fDisc1 = await discoverProject(folderWs)
        const fDisc2 = await discoverProject(folderWs)
        expect(fDisc1.digest).toBe(fDisc2.digest)
        expect(fDisc1.facts).toEqual(fDisc2.facts)
      } finally {
        removeTmpDir(folderDir)
      }
    } finally {
      removeRepo(dir)
    }
  })

  // Critério 2: Dado um projeto JavaScript, quando a descoberta for executada, então identifica linguagem, comandos disponíveis, entradas, módulos, símbolos, dependências, testes relacionados, regras de escopo e estado da árvore com referência à fonte.
  test('criterio_2_descoberta_javascript_identifica_elementos_com_fonte', async () => {
    const { dir, git } = makeRepo()
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'js-project',
          main: 'src/main.js',
          scripts: { test: 'vitest run', build: 'tsc' },
          dependencies: { ajv: '^8.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
      )
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(
        path.join(dir, 'src', 'main.js'),
        'export function startApp() {}\nexport class EngineRunner {}\n',
      )
      fs.mkdirSync(path.join(dir, 'tests'))
      fs.writeFileSync(path.join(dir, 'tests', 'main.test.js'), 'import { startApp } from "../src/main.js";')
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents Scope Guide\nsrc/main.js -> engine\n')

      git(['add', '-A'])
      git(['commit', '-m', 'add js project files'])

      const gitWs = new GitWorkspace({ worktreeDir: dir })
      const disc = await discoverProject(gitWs)

      expect(disc.language).toBe('javascript')

      // Comandos com referência à fonte
      expect(disc.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'test', command: 'vitest run', source: expect.stringContaining('package.json') }),
          expect.objectContaining({ name: 'build', command: 'tsc', source: expect.stringContaining('package.json') }),
        ]),
      )

      // Entradas com fonte
      expect(disc.entrypoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'main', path: 'src/main.js', source: expect.stringContaining('package.json') }),
        ]),
      )

      // Módulos
      expect(disc.modules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'src/main.js', source: 'src/main.js' }),
        ]),
      )

      // Símbolos com linha e fonte
      expect(disc.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'startApp', kind: 'function', path: 'src/main.js', line: 1, source: 'src/main.js#L1' }),
          expect.objectContaining({ name: 'EngineRunner', kind: 'class', path: 'src/main.js', line: 2, source: 'src/main.js#L2' }),
        ]),
      )

      // Dependências
      expect(disc.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'ajv', version: '^8.0.0', type: 'prod', source: expect.stringContaining('package.json') }),
          expect.objectContaining({ name: 'vitest', version: '^2.0.0', type: 'dev', source: expect.stringContaining('package.json') }),
        ]),
      )

      // Testes relacionados
      expect(disc.related_tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ testPath: 'tests/main.test.js', targetModule: 'src/main.js', source: 'tests/main.test.js' }),
        ]),
      )

      // Regras de escopo
      expect(disc.scope_rules.length).toBeGreaterThan(0)
      expect(disc.scope_rules[0]).toHaveProperty('source')

      // Estado da árvore
      expect(disc.tree_state).toMatchObject({
        clean: true,
        revision: expect.any(String),
        digest: expect.any(String),
      })
    } finally {
      removeRepo(dir)
    }
  })

  // Critério 3: Dado um fato extraído, inferido ou decidido pelo operador, quando entrar no IR, então sua classe de proveniência permanece separada e inferências carregam confiança e evidências.
  test('criterio_3_ir_proveniencia_separada_inferencia_com_confianca_e_evidencias', async () => {
    const { dir, git } = makeRepo()
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p1' }))
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export function run() {}\nconst mod = require("./dyn" + name);')
      git(['add', '-A'])
      git(['commit', '-m', 'commit'])

      const gitWs = new GitWorkspace({ worktreeDir: dir })
      const discovery = await discoverProject(gitWs)

      const fakeProducer = async (ambiguities: any[]) => {
        return [
          {
            statement: 'mod resolves to src/dyn1.js at runtime',
            confidence: 0.82,
            evidence_refs: ['repo:path:src/app.js#L2'],
          },
        ]
      }

      const operatorDecisions = [
        {
          id: 'op-1',
          decision: 'Use Node 22 ESM runtime',
          source: 'operator',
        },
      ]

      const irArtifact = await buildRepoIr({
        workspace: gitWs,
        discovery,
        producer: fakeProducer,
        operatorDecisions,
      })

      expect(irArtifact.kind).toBe('repo-ir')
      expect(irArtifact.digest).toMatch(/^[0-9a-f]{16}$/)
      expect(irArtifact.provenance).toContain('fact')
      expect(irArtifact.provenance).toContain('inference')

      const data = irArtifact.data as any
      expect(data.facts).toBeDefined()
      expect(Array.isArray(data.facts)).toBe(true)

      expect(data.inferences).toBeDefined()
      expect(data.inferences.length).toBeGreaterThan(0)
      const inf = data.inferences[0]
      expect(inf.confidence).toBe(0.82)
      expect(inf.evidence_refs).toEqual(['repo:path:src/app.js#L2'])
      expect(inf.provenance).toBe('inference')

      expect(data.operator_decisions).toBeDefined()
      expect(data.operator_decisions[0].decision).toBe('Use Node 22 ESM runtime')
      expect(data.operator_decisions[0].provenance).toBe('operator_decision')
    } finally {
      removeRepo(dir)
    }
  })

  // Critério 4: Dado um orçamento de contexto, quando símbolos e relações forem ranqueados, então o resultado respeita o teto, informa estimativa, revisão e referências para aprofundamento.
  test('criterio_4_ranqueamento_sob_orcamento_teto_estimativa_e_revisao', async () => {
    const mockIr = {
      ref: 'art:repo-ir/rev1',
      kind: 'repo-ir',
      digest: '0123456789abcdef',
      revision: 'git-commit-abc',
      data: {
        tree_state: { revision: 'git-commit-abc', digest: 'tree123' },
        symbols: [
          { name: 'authenticateUser', kind: 'function', path: 'src/auth.js', line: 10, source: 'src/auth.js#L10', ref: 'repo:symbol:authenticateUser' },
          { name: 'verifyToken', kind: 'function', path: 'src/auth.js', line: 40, source: 'src/auth.js#L40', ref: 'repo:symbol:verifyToken' },
          { name: 'formatDate', kind: 'function', path: 'src/utils.js', line: 5, source: 'src/utils.js#L5', ref: 'repo:symbol:formatDate' },
          { name: 'renderBanner', kind: 'function', path: 'src/banner.js', line: 12, source: 'src/banner.js#L12', ref: 'repo:symbol:renderBanner' },
        ],
        relations: [
          { from: 'authenticateUser', to: 'verifyToken', kind: 'calls', ref: 'repo:rel:1' },
        ],
      },
    }

    const resSmall = rankRepoContext({
      ir: mockIr as any,
      query: 'authenticate',
      touchedPaths: ['src/auth.js'],
      riskSurfaces: ['auth'],
      maxTokens: 50,
    })

    expect(resSmall.estimated_tokens).toBeLessThanOrEqual(50)
    expect(resSmall.revision).toBe('git-commit-abc')
    expect(resSmall.items.length).toBeGreaterThan(0)
    // Símbolos prioritários de auth devem estar presentes
    expect(resSmall.items[0].name).toMatch(/authenticateUser|verifyToken/)
    // Cada item deve ter referência para aprofundamento
    expect(resSmall.items[0].ref || resSmall.items[0].raw_ref).toBeDefined()

    const resLarge = rankRepoContext({
      ir: mockIr as any,
      query: 'authenticate',
      touchedPaths: ['src/auth.js'],
      riskSurfaces: ['auth'],
      maxTokens: 500,
    })
    expect(resLarge.items.length).toBeGreaterThanOrEqual(resSmall.items.length)
    expect(resLarge.estimated_tokens).toBeLessThanOrEqual(500)
  })

  // Critério 5: Dado código dinâmico ou relação que o IR não resolve, quando uma consulta for feita, então a ferramenta cai para busca ou leitura limitada e mantém raw_ref, sem apresentar inferência como fato.
  test('criterio_5_codigo_dinamico_fallback_busca_leitura_limitada_e_raw_ref', async () => {
    const tmp = makeTmpDir('ade-query-')
    try {
      const filePath = path.join(tmp, 'dynamic.js')
      const lines = [
        '// Dynamic loader',
        'const plugin = eval("require")("./plugin-" + name);',
        'function fallbackService() {',
        '  return plugin.call();',
        '}',
      ]
      fs.writeFileSync(filePath, lines.join('\n'))

      const folderWs = new FolderWorkspace({ rootDir: tmp })
      const ir = { data: { symbols: [] } }

      // Consulta de símbolo inexistente no IR faz fallback para busca no workspace
      const result = await queryCode({
        kind: 'symbol',
        query: 'fallbackService',
        workspace: folderWs,
        ir: ir as any,
        budget: 100,
      })

      expect(result.summary).toBeDefined()
      expect(result.items.length).toBeGreaterThan(0)
      expect(result.raw_ref).toBe('file:dynamic.js#L3')
      expect(result.items[0]).toMatchObject({
        path: 'dynamic.js',
        line: 3,
        text: expect.stringContaining('fallbackService'),
      })

      // Leitura paginada não retorna arquivo inteiro por padrão
      const readResult = await folderWs.read('dynamic.js', { limit: 2 })
      expect(readResult.items.length).toBe(2)
      expect(readResult.next_cursor).toBe(2)
      expect(readResult.raw_ref).toMatch(/^file:dynamic.js/)
    } finally {
      removeTmpDir(tmp)
    }
  })

  // Critério 6: Dado um artefato já produzido com a mesma chave completa, quando o produtor for solicitado novamente, então o cache retorna o resultado sem nova chamada e o journal registra cache_hit com a chave.
  test('criterio_6_cache_artefatos_reproducao_sem_nova_chamada_e_registro_journal', async () => {
    const missionDir = makeTmpDir('ade-mission-')
    try {
      const journal = openJournal({
        missionDir,
        runtimeStamp: '1:abc:def',
      })

      let producerCalls = 0
      const producer = async () => {
        producerCalls++
        return {
          kind: 'sample-analysis',
          data: { analysis: 'complete' },
          confidence: 1.0,
        }
      }

      const spec = {
        producer: 'test-analyzer',
        producer_version: '1.0.0',
        input_digest: '0123456789abcdef',
        config_digest: 'c0ffee',
        schema_version: 1,
        missionDir,
        journal,
      }

      const key = computeArtifactCacheKey(spec)
      expect(key).toMatch(/^[0-9a-f]{16}$/)

      // 1ª execução: chamada real
      const first = await getOrProduceArtifact(spec, producer)
      expect(first.cacheHit).toBe(false)
      expect(first.artifact.kind).toBe('sample-analysis')
      expect(producerCalls).toBe(1)

      // 2ª execução com mesma chave: cache hit, zero chamadas novas
      const second = await getOrProduceArtifact(spec, producer)
      expect(second.cacheHit).toBe(true)
      expect(second.artifact.kind).toBe('sample-analysis')
      expect(producerCalls).toBe(1)

      await journal.close()

      // Conferir registro de cache_hit no journal
      const { events } = readJournal(path.join(missionDir, 'journal.jsonl'))
      const hitEvent = events.find((e) => e.kind === 'cache_hit' || e.data?.cache_hit === true)
      expect(hitEvent).toBeDefined()
      expect(hitEvent?.data?.key ?? hitEvent?.data?.cache_key).toBe(key)

      // Nova execução com input_digest diferente invalida chave e gera nova chamada
      const specDifferent = { ...spec, input_digest: 'fedcba9876543210' }
      const third = await getOrProduceArtifact(specDifferent, producer)
      expect(third.cacheHit).toBe(false)
      expect(producerCalls).toBe(2)
    } finally {
      removeTmpDir(missionDir)
    }
  })

  // Critério 7: Dado log, diff, documentação, histórico, falha de integração ou mídia representada por fixture, quando o contexto for amostrado, então retorna resumo, itens, cursor e raw_ref sem descartar o bruto.
  test('criterio_7_amostradores_resumo_itens_cursor_e_raw_ref_sem_descartar_bruto', async () => {
    // 1. Log
    const rawLog = 'INFO starting\nERROR [E101] DB connection timeout\nWARN slow query\nERROR [E101] DB connection retry failed\n'
    const sampledLog = sampleInput({
      kind: 'log',
      rawRef: 'art:logs/system.log',
      content: rawLog,
      budget: 100,
    })
    expect(sampledLog.raw_ref).toBe('art:logs/system.log')
    expect(sampledLog.summary).toBeDefined()
    expect(sampledLog.items.length).toBeGreaterThan(0)
    expect(sampledLog.next_cursor).toBeDefined()

    // 2. Diff
    const rawDiff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,4 @@\n+export function added() {}\n'
    const sampledDiff = sampleInput({
      kind: 'diff',
      rawRef: 'art:diffs/story1.patch',
      content: rawDiff,
      budget: 100,
    })
    expect(sampledDiff.raw_ref).toBe('art:diffs/story1.patch')
    expect(sampledDiff.summary).toMatch(/diff|altera/i)

    // 3. Documentação
    const rawDoc = '# Title\n## Section 1\nIntro text\n## Section 2\nDetails\n'
    const sampledDoc = sampleInput({
      kind: 'documentation',
      rawRef: 'art:docs/arch.md',
      content: rawDoc,
      budget: 50,
    })
    expect(sampledDoc.raw_ref).toBe('art:docs/arch.md')
    expect(sampledDoc.items).toBeDefined()

    // 4. Falha de integração
    const rawCi = 'Test suite failed:\nAssertionError: expected 200 to be 500\n  at Object.<anonymous> (test.js:15:10)\n'
    const sampledCi = sampleInput({
      kind: 'integration_failure',
      rawRef: 'art:ci/run-42.log',
      content: rawCi,
      budget: 100,
    })
    expect(sampledCi.raw_ref).toBe('art:ci/run-42.log')
    expect(sampledCi.summary).toMatch(/fail|erro/i)
  })

  // Critério 8: Dado dois caminhos com regras de donos diferentes, quando o contexto for compilado, então somente as referências de dono correspondentes ao escopo tocado são incluídas.
  test('criterio_8_dono_por_escopo_somente_referencias_do_escopo_tocado', async () => {
    const rules = [
      { pattern: 'src/journal/**', owner: 'journal.md', ref: 'docs/reference/journal.md' },
      { pattern: 'src/adapters/**', owner: 'adapters.md', ref: 'docs/reference/adapters.md' },
      { pattern: 'src/engine/**', owner: 'engine.md', ref: 'docs/reference/engine.md' },
    ]

    // Tocando apenas src/journal/canonical.js
    const owners1 = resolveScopeOwners({
      paths: ['src/journal/canonical.js'],
      rules,
    })
    expect(owners1.map((o) => o.owner)).toEqual(['journal.md'])
    expect(owners1.map((o) => o.owner)).not.toContain('adapters.md')

    // Compilando contexto de domínio
    const contract = {
      id: 'story-journal',
      task: 'Adicionar funcionalidade ao journal',
      guardrails: {
        scope_paths: ['src/journal/canonical.js'],
        do_not_touch: ['src/adapters/**'],
      },
      risk: { surfaces: ['durability'] },
    }

    const domainArtifact = compileDomainContext({
      contract,
      ir: { data: { symbols: [] }, digest: '1234567890abcdef' } as any,
      domain: 'journal',
      budget: 1000,
      scopeRules: rules,
    })

    expect(domainArtifact.kind).toBe('domain-context')
    const data = domainArtifact.data as any
    expect(data.scope_owners).toBeDefined()
    expect(data.scope_owners.map((o: any) => o.owner)).toContain('journal.md')
    expect(data.scope_owners.map((o: any) => o.owner)).not.toContain('adapters.md')
  })

  // Borda / Falha: Travessia de diretório no workspace deve ser recusada com segurança
  test('borda_leitura_fora_do_workspace_recusa_com_erro', async () => {
    const tmp = makeTmpDir('ade-sec-')
    try {
      const folderWs = new FolderWorkspace({ rootDir: tmp })
      await expect(folderWs.read('../secret.txt')).rejects.toThrow(/fora do workspace|invalid/i)
    } finally {
      removeTmpDir(tmp)
    }
  })
})
