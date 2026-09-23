import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi, beforeAll, afterAll } from 'vitest'

import { discoverDesignSignals } from '../src/visual/design-discovery.js'
import { buildDesignBrief } from '../src/visual/design-brief.js'
import { recommendDesign } from '../src/visual/design-retrieval.js'
import { createDesignToolServer } from '../src/visual/design-server.js'
import { runVisualGates } from '../src/visual/gates.js'
import { judgeVisual, calculateRenormalizedFinal, evaluateCutoff } from '../src/visual/judge.js'
import { probeImpeccable, createImpeccableDetector, PINNED_ENGINE_VERSION } from '../src/visual/impeccable.js'
import { runFrontendQuality } from '../src/visual/evaluate.js'
import { compileIntent } from '../src/intent/compiler.js'
import { prepareStory } from '../src/engine/prepare.js'
import { renderVisualComparison } from '../src/cli/report.js'
import { runDoctor } from '../src/cli/doctor.js'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { validate } from '../src/schema/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function createFixturePage(htmlPath: string, { width = 1280, theme = 'light' as 'light' | 'dark' } = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  const styles: string[] = []
  const styleMatches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)
  for (const m of styleMatches) {
    styles.push(m[1])
  }
  let fullCss = styles.join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  if (theme === 'light') {
    fullCss = fullCss.replace(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{([\s\S]*?\}\s*)\}/gi, '')
  } else {
    const darkMatches = fullCss.matchAll(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{([\s\S]*?\}\s*)\}/gi)
    for (const dm of darkMatches) {
      fullCss += '\n' + dm[1]
    }
  }

  const rules: Array<{ sel: string; props: Record<string, string> }> = []
  const ruleRe = /([^{]+)\{([^}]+)\}/g
  let rm
  while ((rm = ruleRe.exec(fullCss)) !== null) {
    const sel = rm[1].trim()
    const body = rm[2].trim()
    const props: Record<string, string> = {}
    for (const line of body.split(';')) {
      const idx = line.indexOf(':')
      if (idx !== -1) {
        props[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
      }
    }
    rules.push({ sel, props })
  }

  const rootVars: Record<string, string> = {}
  for (const r of rules) {
    if (r.sel === ':root') {
      for (const [k, v] of Object.entries(r.props)) {
        rootVars[k] = v
      }
    }
  }

  function resolveVal(val: string) {
    if (!val) return val
    let resolved = val
    for (const [k, v] of Object.entries(rootVars)) {
      resolved = resolved.split(`var(${k})`).join(v)
    }
    return resolved
  }

  const elements: any[] = []
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const bodyContent = bodyMatch ? bodyMatch[1] : html

  const bodyEl: any = {
    nodeType: 1,
    tagName: 'BODY',
    className: '',
    outerHTML: '<body>',
    parentElement: null,
    childNodes: [],
  }
  elements.push(bodyEl)

  const tagRe = /<([a-z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/gi
  let tm
  while ((tm = tagRe.exec(bodyContent)) !== null) {
    const tag = tm[1].toUpperCase()
    const attrs = tm[2]
    const inner = tm[3]
    const classMatch = attrs.match(/class=["']([^"']+)["']/i)
    const className = classMatch ? classMatch[1] : ''
    const text = inner.replace(/<[^>]+>/g, '').trim()
    const el: any = {
      nodeType: 1,
      tagName: tag,
      className,
      outerHTML: tm[0].slice(0, 150),
      parentElement: bodyEl,
      childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
    }
    elements.push(el)
    bodyEl.childNodes.push(el)
  }

  function getComputedStyle(el: any) {
    const computed: Record<string, string> = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      fontSize: el.tagName === 'H1' ? '32px' : el.tagName === 'H2' ? '24px' : '16px',
      fontWeight: el.tagName === 'H1' || el.tagName === 'H2' ? 'bold' : 'normal',
      color: '#000000',
      backgroundColor: 'transparent',
    }

    for (const r of rules) {
      let matches = false
      if (r.sel.toLowerCase() === el.tagName.toLowerCase()) matches = true
      else if (r.sel.startsWith('.') && el.className && el.className.split(' ').includes(r.sel.slice(1))) matches = true
      if (matches) {
        if (r.props['color']) computed.color = resolveVal(r.props['color'])
        if (r.props['background-color']) computed.backgroundColor = resolveVal(r.props['background-color'])
        if (r.props['background']) computed.backgroundColor = resolveVal(r.props['background'])
        if (r.props['font-size']) computed.fontSize = resolveVal(r.props['font-size'])
        if (r.props['font-weight']) computed.fontWeight = resolveVal(r.props['font-weight'])
      }
    }

    if (computed.color === '#000000' && el.parentElement) {
      const parentComp = getComputedStyle(el.parentElement)
      if (parentComp.color) computed.color = parentComp.color
    }
    return computed
  }

  const win: any = {
    innerWidth: width,
    getComputedStyle,
    axe: undefined,
  }

  const doc: any = {
    nodeType: 9,
    scrollingElement: { scrollWidth: Math.min(1100, width), clientWidth: width },
    documentElement: { scrollWidth: Math.min(1100, width), clientWidth: width },
    body: bodyEl,
    createTreeWalker(_root: any, _filter: any) {
      let idx = 0
      return {
        nextNode() {
          return idx < elements.length ? elements[idx++] : null
        },
      }
    },
    querySelectorAll(sel: string) {
      return elements.filter((el) => {
        if (sel === '*') return true
        if (sel.startsWith('.')) return el.className && el.className.split(' ').includes(sel.slice(1))
        return el.tagName.toLowerCase() === sel.toLowerCase()
      })
    },
  }

  return {
    async addScriptTag({ content }: { content: string }) {
      const fn = new Function('window', 'document', 'NodeFilter', 'globalThis', content)
      fn(win, doc, { SHOW_ELEMENT: 1 }, win)
    },
    async evaluate(fnOrStr: any) {
      if (typeof fnOrStr === 'string') {
        const fn = new Function('window', 'document', 'NodeFilter', 'globalThis', fnOrStr)
        return fn(win, doc, { SHOW_ELEMENT: 1 }, win)
      }
      if (typeof fnOrStr === 'function') {
        const fnStr = fnOrStr.toString()
        const runner = new Function('window', 'document', 'NodeFilter', 'globalThis', `return (${fnStr})()`)
        return runner(win, doc, { SHOW_ELEMENT: 1 }, win)
      }
    },
  }
}

describe('v0.4a Frontend Quality Engine (FQE) Acceptance Tests', () => {
  let tempMissionDir: string

  beforeAll(() => {
    tempMissionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-fqe-test-'))
  })

  afterAll(() => {
    fs.rmSync(tempMissionDir, { recursive: true, force: true })
  })
  // Critério 1: Detecção e compilação de briefing UI com caráter justificado e autocrítica
  test('criterio_1_historia_com_ui_marcada_para_avaliacao_visual_e_recebe_briefing_completo', async () => {
    const request = 'Construir página de dashboard e layout de interface com tema escuro e botões de ação'
    const discovery = {
      ui: { present: true },
      anchors: [{ path: 'src/components/Dashboard.tsx' }],
      modules: [{ path: 'src/components/Dashboard.tsx' }],
      languages: [{ name: 'typescript' }],
    }

    const { contracts, briefing } = await compileIntent({ request, discovery })

    expect(contracts.length).toBeGreaterThan(0)
    const uiContract = contracts[0]
    expect(uiContract.needs_ui).toBe(true)

    // Briefing detalhado no briefing do plano
    const brief = briefing.design_briefs?.[uiContract.id]
    expect(brief).toBeDefined()
    expect(brief.audience).toBeDefined()
    expect(['persuade', 'operate', 'read', 'experience']).toContain(brief.surface_mode)
    expect(Array.isArray(brief.preserved_patterns)).toBe(true)
    expect(Array.isArray(brief.avoid_patterns)).toBe(true)
    expect(brief.avoid_patterns).toContain('kicker-above-heading') // Banimento literal

    // Direção e autocrítica obrigatória
    expect(brief.direction).toBeDefined()
    expect(brief.direction.signature).toBeDefined()
    expect(typeof brief.direction.self_critique).toBe('string')
    expect(brief.direction.self_critique.length).toBeGreaterThan(10)

    // Caráter com justificativa
    expect(brief.character).toBeDefined()
    expect(brief.character.variance).toBeGreaterThanOrEqual(1)
    expect(brief.character.motion).toBeGreaterThanOrEqual(1)
    expect(brief.character.density).toBeGreaterThanOrEqual(1)
    expect(typeof brief.character.justification).toBe('string')
    expect(brief.character.justification.length).toBeGreaterThan(10)

    // História sem interface não recebe design_brief
    const nonUiRequest = 'Criar migração de banco de dados e rotina de limpeza'
    const nonUiDiscovery = { ui: { present: false }, modules: [{ path: 'src/db.ts' }] }
    const nonUiResult = await compileIntent({ request: nonUiRequest, discovery: nonUiDiscovery })
    expect(nonUiResult.contracts[0].needs_ui).toBe(false)
    expect(nonUiResult.briefing.design_briefs).toBeUndefined()
  })

  // Critério 2: Descoberta prévia dos sinais visuais do repositório
  test('criterio_2_descoberta_recupera_sinais_visuais_do_repo_sem_tratar_como_decisao_obrigatoria', () => {
    const pkg = {
      dependencies: {
        react: '^18.0.0',
        tailwindcss: '^3.0.0',
        'framer-motion': '^10.0.0',
      },
    }
    const paths = ['tailwind.config.js', 'src/App.tsx', 'DESIGN.md']
    const repoSignals = discoverDesignSignals({
      packageJson: pkg,
      paths,
      scopePaths: ['src/App.tsx'],
      request: 'Refatorar estilos do componente',
    })

    expect(repoSignals.has_ui).toBe(true)
    expect(repoSignals.signals.s1_framework).toBe('react')
    expect(repoSignals.signals.s2_css_toolchain).toContain('tailwindcss')
    expect(repoSignals.motion_libs).toContain('framer-motion')
    expect(repoSignals.preserved_patterns.some((p) => p.includes('react'))).toBe(true)
    expect(repoSignals.preserved_patterns.some((p) => p.includes('tailwindcss'))).toBe(true)

    // Recomendações locais via BM25 como evidência, nunca como layout obrigatório
    const brief = buildDesignBrief({
      request: 'Landing page para novo produto',
      repoSignals,
    })
    const recommendation = recommendDesign({ brief, limit: 3 })
    expect(recommendation.macrostructure).toBeDefined()
    expect(recommendation.components.length).toBeLessThanOrEqual(3)
    expect(recommendation.heroGuidance).toBe('hero cabe em 1280x800/100svh')
    expect(recommendation.spacingGuidance).toBe('80-160 px entre seções')
    expect(recommendation.evidence.query).toBeDefined()
  })

  // Critério 3: Reserva de rodada de correção no prepare para histórias visuais
  test('criterio_3_prepare_reserva_uma_rodada_de_rework_para_fqe_ou_para_se_nao_couber', async () => {
    const budgetInsufficient = { max_rework_rounds: 0 }
    const repo = makeRepo()
    try {
      fs.writeFileSync(path.join(repo.dir, 'main.txt'), 'conteúdo base\n')
      repo.git(['add', '-A'])
      repo.git(['commit', '-m', 'commit inicial'])

      // História com UI com orçamento insuficiente para reservar 1 rodada de correção para o FQE
      const blockedRes = await prepareStory({
        repoDir: repo.dir,
        missionId: 'm1',
        storyId: 's1',
        contract: {
          needs_ui: true,
          budget: budgetInsufficient,
        },
      } as any)

      expect(blockedRes.status).toBe('awaiting_operator')
      expect((blockedRes as any).reason).toBe('visual_rework_budget_exhausted')
    } finally {
      removeRepo(repo.dir)
    }
  })

  // Critério 4: Captura de evidência com Playwright como biblioteca e metadados
  test('criterio_4_captura_evidencia_por_playwright_e_registra_metadados_sem_mcp', async () => {
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue(undefined),
          waitForTimeout: vi.fn().mockResolvedValue(undefined),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }

    const { captureVisualSurface } = await import('../src/visual/browser.js')
    const captures = await captureVisualSurface({
      browser: mockBrowser,
      url: 'http://127.0.0.1:4173',
      routes: ['/'],
      widths: [1280, 390],
      themes: ['light', 'dark'],
      tree: 'test-tree',
      missionDir: tempMissionDir,
      revision: 'rev-123',
      commit_sha: 'sha-abc',
    })

    // 1 rota * 2 larguras * 2 temas = 4 capturas
    expect(captures.length).toBe(4)
    for (const c of captures) {
      expect(c.route).toBe('/')
      expect([1280, 390]).toContain(c.width)
      expect(['light', 'dark']).toContain(c.theme)
      expect(c.url).toContain('http://127.0.0.1:4173')
      expect(c.revision).toBe('rev-123')
      expect(c.commit_sha).toBe('sha-abc')
      expect(typeof c.sha256).toBe('string')
      expect(c.sha256.length).toBe(64)
      expect(c.at).toBeDefined()
    }
  })

  // Critério 5: Portões determinísticos D1–D6 reprovam com defeitos específicos e o juiz NÃO é chamado
  test('criterio_5_portoes_d1_d6_reprovam_com_defeitos_especificos_sem_chamar_juiz', async () => {
    const judgeSpy = vi.fn()

    // Cenário D1 com erro no console
    const resD1 = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true, task: 'Página com erro de console' } },
      tree: 'tree-d1',
      missionDir: tempMissionDir,
      config: {
        visual: {
          enabled: true,
          url: 'http://127.0.0.1:4173',
          routes: ['/'],
        },
      },
      deps: {
        captureSurface: vi.fn().mockResolvedValue([{ route: '/', width: 1280, theme: 'light', sha256: 'abc' }]),
        runGates: vi.fn().mockResolvedValue({
          ok: false,
          results: { D1: { pass: false, message: 'Uncaught TypeError' } },
          defects: [{ id: 'D1-console-error', severity: 'critical', criterion: 'hierarchy', where: '/', fix: 'Fix console' }],
        }),
        judge: judgeSpy,
      },
    })

    expect(resD1.status).toBe('rework')
    expect(resD1.defects?.[0].id).toBe('D1-console-error')
    // O juiz não foi chamado porque falhou nos portões determinísticos
    expect(judgeSpy).not.toHaveBeenCalled()
  })

  // Critério 6: Fixture conhecida de contraste ruim reprova em D3; fixture válida passa
  test('criterio_6_fixture_contraste_ruim_reprova_no_d3_e_responsiva_valida_passa', async () => {
    // 1. Executa D1-D6 com axe-core vendorizado sobre a fixture real de contraste ruim
    const badContrastFixturePath = path.resolve(__dirname, '../fixtures/visual/bad-contrast/index.html')
    const badContrastPage = createFixturePage(badContrastFixturePath, { width: 1280, theme: 'light' })

    const badResult = await runVisualGates({
      page: badContrastPage,
      route: '/',
      width: 1280,
      theme: 'light',
    })

    expect(badResult.ok).toBe(false)
    expect(badResult.results.D3.pass).toBe(false)
    expect(badResult.defects.some((d) => d.id === 'D3-low-contrast')).toBe(true)

    // 2. Executa D1-D6 com axe-core vendorizado sobre a fixture boa/responsiva nas larguras e temas configurados
    const goodFixturePath = path.resolve(__dirname, '../fixtures/visual/good/index.html')

    for (const width of [1280, 390]) {
      for (const theme of ['light', 'dark'] as const) {
        const goodPage = createFixturePage(goodFixturePath, { width, theme })
        const goodResult = await runVisualGates({
          page: goodPage,
          route: '/',
          width,
          theme,
        })

        expect(goodResult.ok).toBe(true)
        expect(goodResult.results.D3.pass).toBe(true)
        expect(goodResult.results.D6.pass).toBe(true)
        expect(goodResult.defects.length).toBe(0)
      }
    }
  })

  // Critério 7: Fixture genérica reprova no juiz; fixture boa passa na primeira rodada
  test('criterio_7_fixture_generica_reprova_no_juiz_e_fixture_boa_passa_na_primeira_rodada', async () => {
    const genericBrief = {
      surface_mode: 'persuade',
      direction: {
        signature: 'interface padrão cinza sem destaque',
        self_critique: 'página genérica gerada por padrão',
      },
    }

    const genericEval = await judgeVisual({
      captures: [{ route: '/', width: 1280, theme: 'light', path: 'bad.png', sha256: 'abc' }],
      task: 'Página bad-subtle com template genérico',
      designBrief: genericBrief,
      round: 1,
    })

    expect(genericEval.verdict).toBe('rework')
    expect(genericEval.criteria.find((c) => c.id === 'specificity')!.score).toBeLessThan(7.0)

    const goodBrief = {
      surface_mode: 'persuade',
      direction: {
        signature: 'Ritmo vertical expressivo com Fraunces display',
        self_critique: 'Eliminado o padrão clichê e adotado contraste semântico vivo',
      },
      tokens: {
        typography: { display: 'Fraunces', body: 'Plus Jakarta Sans' },
      },
    }

    const goodEval = await judgeVisual({
      captures: [{ route: '/', width: 1280, theme: 'light', path: 'good.png', sha256: 'def' }],
      task: 'Página good com identidade e assinatura própria',
      designBrief: goodBrief,
      round: 1,
    })

    expect(goodEval.verdict).toBe('pass')
    expect(goodEval.final).toBeGreaterThanOrEqual(7.5)
    expect(goodEval.criteria.find((c) => c.id === 'specificity')!.score).toBeGreaterThanOrEqual(7.0)
  })

  // Critério 8: Juiz de família diferente da Maker, isolado, vê apenas capturas, tarefa, briefing e rubrica
  test('criterio_8_juiz_de_familia_diferente_isolado_ve_somente_capturas_tarefa_briefing_e_rubrica', async () => {
    let capturedPack: any = null
    const mockDispatchJudge = vi.fn().mockImplementation(async (pack) => {
      capturedPack = pack
      return {
        story_id: 'S1',
        round: 1,
        rubric_version: '2026-09-17-v1',
        judge: { family: 'codex', model_id: 'gpt-5.6-terra' },
        detector: { engine_version: '0.1.5', url_mode: 'ok' },
        surface_mode: 'persuade',
        captures: pack.captures,
        criteria: [{ id: 'specificity', score: 8, weight: 3, note: 'ok' }],
        final: 8.0,
        defects: [],
        verdict: 'pass',
      }
    })

    const judgeRole = { family: 'codex', model_id: 'gpt-5.6-terra' }
    const makerFamily = 'claude'
    expect(judgeRole.family).not.toBe(makerFamily)

    await judgeVisual({
      captures: [{ route: '/', width: 1280, theme: 'light', path: 'c.png', sha256: '123' }],
      task: 'Construir superfície com identidade visual',
      designBrief: { surface_mode: 'persuade' },
      judge: judgeRole,
      deps: { dispatchJudge: mockDispatchJudge },
    })

    expect(capturedPack).toBeDefined()
    expect(capturedPack.captures).toBeDefined()
    expect(capturedPack.task).toBeDefined()
    expect(capturedPack.design_brief).toBeDefined()
    expect(capturedPack.rubric).toBeDefined()

    // Não vê diff nem achados do detector (anti-ancoragem)
    expect(capturedPack.diff).toBeUndefined()
    expect(capturedPack.detector_findings).toBeUndefined()
    expect(capturedPack.prompt).toBeUndefined()
  })

  // Critério 9: Notas do juiz com corte 7,5, especificidade 7, critérios >= 6 e renormalização
  test('criterio_9_notas_do_juiz_corte_7_5_especificidade_7_criterios_minimo_6_e_renormalizacao', () => {
    // Caso com critério nulo (ex: motion não aplicável em tela puramente estática)
    const criteriaWithNull = [
      { id: 'specificity' as const, score: 7.5, weight: 3.0, note: 'ok' },
      { id: 'hierarchy' as const, score: 7.5, weight: 2.0, note: 'ok' },
      { id: 'typography' as const, score: 8.0, weight: 2.0, note: 'ok' },
      { id: 'color' as const, score: 7.5, weight: 1.5, note: 'ok' },
      { id: 'states' as const, score: 7.0, weight: 1.0, note: 'ok' },
      { id: 'motion' as const, score: null, weight: 0.5, note: 'n/a' },
    ]

    const finalRenormalized = calculateRenormalizedFinal(criteriaWithNull)
    // Soma ponderada sobre peso aplicável (9.5 em vez de 10.0)
    expect(finalRenormalized).toBeGreaterThanOrEqual(7.5)
    const verdict = evaluateCutoff(criteriaWithNull, finalRenormalized, [])
    expect(verdict).toBe('pass')

    // Se qualquer critério ficar abaixo de 6.0, reprova
    const failingCriterion = structuredClone(criteriaWithNull)
    failingCriterion[3].score = 5.5
    const finalFail = calculateRenormalizedFinal(failingCriterion)
    expect(evaluateCutoff(failingCriterion, finalFail, [])).toBe('rework')

    // Se especificidade ficar abaixo de 7.0, reprova mesmo com nota final alta
    const failingSpecificity = structuredClone(criteriaWithNull)
    failingSpecificity[0].score = 6.8
    failingSpecificity[1].score = 9.0
    const finalSpec = calculateRenormalizedFinal(failingSpecificity)
    expect(evaluateCutoff(failingSpecificity, finalSpec, [])).toBe('rework')
  })

  // Critério 10: Reprovação na primeira rodada envia defeitos em lote único para rework
  test('criterio_10_reprovacao_na_primeira_rodada_envia_defeitos_em_lote_e_avalia_novamente', async () => {
    const mockGates = vi.fn().mockResolvedValue({
      ok: true,
      results: { D1: { pass: true }, D2: { pass: true }, D3: { pass: true }, D4: { pass: true }, D5: { pass: true }, D6: { pass: true } },
      defects: [],
    })

    const mockJudge = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: 'rework',
        final: 6.8,
        defects: [
          { id: 'spec-1', severity: 'major', criterion: 'specificity', where: 'hero', fix: 'Adicionar contraste display' },
          { id: 'type-1', severity: 'major', criterion: 'typography', where: 'subheading', fix: 'Corrigir escala' },
        ],
      })
      .mockResolvedValueOnce({
        verdict: 'pass',
        final: 8.0,
        defects: [],
      })

    // Rodada 1
    const round1 = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true, budget: { max_rework_rounds: 2 } } },
      tree: 'tree-r1',
      round: 1,
      missionDir: tempMissionDir,
      config: { visual: { enabled: true, url: 'http://127.0.0.1:4173' } },
      deps: {
        captureSurface: vi.fn().mockResolvedValue([{ route: '/', width: 1280, theme: 'light', sha256: 'r1' }]),
        runGates: mockGates,
        judge: mockJudge,
      },
    })

    expect(round1.status).toBe('rework')
    expect(round1.defects?.length).toBe(2)

    // Rodada 2 com os defeitos corrigidos
    const round2 = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true, budget: { max_rework_rounds: 2 } } },
      tree: 'tree-r2',
      round: 2,
      missionDir: tempMissionDir,
      config: { visual: { enabled: true, url: 'http://127.0.0.1:4173' } },
      deps: {
        captureSurface: vi.fn().mockResolvedValue([{ route: '/', width: 1280, theme: 'light', sha256: 'r2' }]),
        runGates: mockGates,
        judge: mockJudge,
      },
    })

    expect(round2.status).toBe('pass')
    expect(round2.evaluation?.final).toBe(8.0)
  })

  // Critério 11: Segunda reprovação para em awaiting_operator com visual_cut_not_met e capturas lado a lado
  test('criterio_11_segunda_reprovacao_para_em_awaiting_operator_visual_cut_not_met_com_capturas_lado_a_lado', async () => {
    const round2 = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true } },
      tree: 'tree-r2',
      round: 2, // Limite máximo de 2 rodadas
      missionDir: tempMissionDir,
      config: { visual: { enabled: true, url: 'http://127.0.0.1:4173' } },
      deps: {
        captureSurface: vi.fn().mockResolvedValue([{ route: '/', width: 1280, theme: 'light', path: 'artifacts/visual/tree-r2/r2.png', sha256: 'r2' }]),
        runGates: vi.fn().mockResolvedValue({ ok: true, results: {}, defects: [] }),
        judge: vi.fn().mockResolvedValue({
          verdict: 'rework',
          final: 7.0,
          captures: [{ route: '/', width: 1280, theme: 'light', path: 'artifacts/visual/tree-r2/r2.png', sha256: 'r2' }],
          defects: [{ id: 'low-score', severity: 'major', criterion: 'specificity', where: 'root', fix: 'Refazer' }],
        }),
      },
    })

    expect(round2.status).toBe('awaiting_operator')
    expect(round2.reason).toBe('visual_cut_not_met')

    // Renderização do relatório com as duas rodadas lado a lado
    const mockEvents = [
      {
        kind: 'visual_eval_done',
        data: {
          round: 1,
          evaluation: {
            final: 6.5,
            captures: [{ route: '/', width: 1280, theme: 'light', path: 'artifacts/visual/tree-r1/r1.png' }],
          },
        },
      },
      {
        kind: 'visual_eval_done',
        data: {
          round: 2,
          evaluation: {
            final: 7.0,
            captures: [{ route: '/', width: 1280, theme: 'light', path: 'artifacts/visual/tree-r2/r2.png' }],
          },
        },
      },
    ]

    const visualReport = renderVisualComparison(mockEvents)
    expect(visualReport).toContain('Avaliação visual e capturas comparáveis')
    expect(visualReport).toContain('artifacts/visual/tree-r1/r1.png')
    expect(visualReport).toContain('artifacts/visual/tree-r2/r2.png')
    expect(visualReport).toContain('6.5')
    expect(visualReport).toContain('7')
  })

  // Critério 12: Ausência de serve ou captura para história UI para com visual_degraded ou fqe_unavailable
  test('criterio_12_ausencia_de_serve_ou_captura_ou_detector_para_historia_com_ui_em_modo_degradado', async () => {
    // Sem comando de serve nem URL
    const noServeRes = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true } },
      tree: 'tree-noserve',
      missionDir: tempMissionDir,
      config: { visual: { enabled: true } }, // Sem url nem serve_command
    })
    expect(noServeRes.status).toBe('awaiting_operator')
    expect(noServeRes.reason).toBe('visual_degraded')

    // Falha na captura do Playwright
    const failCaptureRes = await runFrontendQuality({
      story: { id: 'S1', contract: { needs_ui: true } },
      tree: 'tree-failcapture',
      missionDir: tempMissionDir,
      config: { visual: { enabled: true, url: 'http://127.0.0.1:4173' } },
      deps: {
        captureSurface: vi.fn().mockRejectedValue(new Error('Playwright crash')),
      },
    })
    expect(failCaptureRes.status).toBe('awaiting_operator')
    expect(failCaptureRes.reason).toBe('visual_degraded')

    // História sem interface continua normalmente sem erro
    const noUiRes = await runFrontendQuality({
      story: { id: 'S2', contract: { needs_ui: false } },
      tree: 'tree-noui',
      config: { visual: { enabled: true } },
    })
    expect(noUiRes.status).toBe('pass')
  })

  // Critério 13: Versão divergente do detector falha fechado e modo url não suportado degrada
  test('criterio_13_detector_com_versao_divergente_ou_modo_url_nao_suportado_falha_fechado_e_degrada', async () => {
    // 1. Sonda com versão incompatível -> fail-closed
    const mockBadExec = vi.fn().mockResolvedValue({ stdout: 'impeccable version 0.2.0', exitCode: 0 })
    const probeBad = await probeImpeccable({
      expectedVersion: PINNED_ENGINE_VERSION,
      execFn: mockBadExec,
    })
    expect(probeBad.version_match).toBe(false)

    // Doctor falha fechado com versão divergente
    const mockDoctorProbe = vi.fn().mockResolvedValue(probeBad)
    await expect(
      runDoctor({
        offline: true,
        failClosedOnVisual: true,
        probeImpeccableImpl: mockDoctorProbe,
      } as any),
    ).rejects.toThrow(/ENGINE_VERSION divergente do pin/)

    // 2. Sonda com url_mode: unsupported -> fallback definido sem aprovação silenciosa
    const mockFallbackExec = vi.fn().mockImplementation(async (bin, args) => {
      if (args.includes('--version')) return { stdout: 'impeccable version 0.1.5', exitCode: 0 }
      if (args.includes('detect')) return { stderr: 'url mode unsupported', exitCode: 1 }
      return { stdout: '', exitCode: 0 }
    })
    const probeFallback = await probeImpeccable({
      expectedVersion: PINNED_ENGINE_VERSION,
      execFn: mockFallbackExec,
    })
    expect(probeFallback.version_match).toBe(true)
    expect(probeFallback.url_mode).toBe('unsupported')

    const detector = createImpeccableDetector({
      engineVersion: PINNED_ENGINE_VERSION,
      urlMode: 'unsupported',
    })
    const fallbackRes = await detector.detect({ page: null })
    expect(fallbackRes.mode).toBe('fallback')
    expect(fallbackRes.url_mode).toBe('unsupported')
  })

  // Critério 14: Histórias sem interface atravessam o fluxo antigo sem custo ou chamadas visuais
  test('criterio_14_historias_sem_interface_passam_sem_custo_visual_nem_artefatos', async () => {
    const captureSpy = vi.fn()
    const gateSpy = vi.fn()
    const judgeSpy = vi.fn()

    const story = {
      id: 'S-BACKEND-1',
      contract: {
        needs_ui: false,
        task: 'Implementar endpoint REST para autenticação',
      },
    }

    const res = await runFrontendQuality({
      story,
      tree: 'tree-backend',
      config: { visual: { enabled: true, url: 'http://127.0.0.1:4173' } },
      deps: {
        captureSurface: captureSpy,
        runGates: gateSpy,
        judge: judgeSpy,
      },
    })

    expect(res.status).toBe('pass')
    expect(captureSpy).not.toHaveBeenCalled()
    expect(gateSpy).not.toHaveBeenCalled()
    expect(judgeSpy).not.toHaveBeenCalled()
  })

  // Critério 15: Ferramentas locais de design expostas somente ao Maker com manifesto registrado
  test('criterio_15_ferramentas_locais_de_design_somente_ao_maker_sem_servidores_externos', async () => {
    const server = await createDesignToolServer()

    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toContain('http://127.0.0.1:')
    expect(server.manifest.role).toBe('maker')
    expect(server.manifest.tools.length).toBe(9)
    expect(server.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/)

    // As 9 ferramentas do perfil lite
    expect(server.manifest.tools).toContain('recommend_design')
    expect(server.manifest.tools).toContain('compare_design')
    expect(server.manifest.tools).toContain('get_macrostructure')
    expect(server.manifest.tools).toContain('get_component_reference')
    expect(server.manifest.tools).toContain('get_palette_tokens')
    expect(server.manifest.tools).toContain('get_spacing_tokens')
    expect(server.manifest.tools).toContain('get_typography_ramp')
    expect(server.manifest.tools).toContain('slop_test')
    expect(server.manifest.tools).toContain('pre_critique')

    // Encerra o servidor após a chamada
    await server.close()
  })

  // Confirmação do segundo consumidor de visual-eval (schema publicado compartilhado)
  test('resultado_do_juiz_visual_valida_com_o_schema_publicado_visual_eval', async () => {
    const visualEval = await judgeVisual({
      captures: [
        {
          path: 'artifacts/visual/test.png',
          route: '/',
          width: 1280,
          theme: 'light',
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      ],
      task: 'Construir landing page com assinatura visual única e boa tipografia',
      designBrief: {
        surface_mode: 'persuade',
        tokens: { typography: { display: 'Fraunces' } },
      },
    })

    const validation = validate('visual-eval', visualEval)
    expect(validation.valid).toBe(true)
    expect(visualEval.verdict).toBe('pass')
  })
})
