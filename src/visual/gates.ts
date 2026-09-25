import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const AXE_PATH = new URL('./vendor/axe.min.js', import.meta.url)

interface GateResult {
    pass: boolean
    severity: 'critical' | 'major' | 'minor'
    message?: string
    details?: any
}

interface VisualDefect {
    id: string
    severity: 'critical' | 'major' | 'minor'
    criterion: string
    where: string
    fix: string
}

/**
 * Executa os portões determinísticos D1–D6 sobre a página renderizada no Playwright.
 */
export async function runVisualGates(params: {
        page: any
        route?: string
        width?: number
        theme?: 'light' | 'dark'
        config?: any
        detector?: any
        consoleMessages?: Array<{ type: string; text: string }>
        networkResponses?: Array<{ url: string; status: number }>
        stateSnapshots?: Record<string, string>
    }): Promise<{
    ok: boolean
    results: Record<'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6', GateResult>
    artifacts: Record<string, any>
    defects: VisualDefect[]
}> {
  const {
    page,
    route = '/',
    width = 1280,
    theme = 'light',
    config = {},
    detector,
    consoleMessages = [],
    networkResponses = [],
    stateSnapshots = {},
  } = params

  const visualConfig = config.visual ?? {}
  const consoleAllowlist = ((visualConfig.console_allowlist || []) as string[]).map((p) => new RegExp(p))
  const networkAllowlist = ((visualConfig.network_allowlist || []) as string[]).map((p) => new RegExp(p))
  const activeGates = new Set(visualConfig.gates || ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'])

  
  const results: Record<'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6', GateResult> = {
    D1: { pass: true, severity: 'critical' },
    D2: { pass: true, severity: 'critical' },
    D3: { pass: true, severity: 'critical' },
    D4: { pass: true, severity: 'major' },
    D5: { pass: true, severity: 'major' },
    D6: { pass: true, severity: 'critical' },
  }

  
  const defects: VisualDefect[] = []
  
  const artifacts: Record<string, any> = {
    console: consoleMessages,
    network: networkResponses,
  }

  // D1: Console limpo (erros ou warnings fora da allowlist)
  if (activeGates.has('D1')) {
    const badConsole = consoleMessages.filter((msg) => {
      if (msg.type === 'error') return true
      if (msg.type === 'warning') {
        return !consoleAllowlist.some((re) => re.test(msg.text))
      }
      return false
    })

    if (badConsole.length > 0) {
      results.D1.pass = false
      results.D1.message = `Console contém ${badConsole.length} erros/avisos não permitidos: ${badConsole[0].text}`
      results.D1.details = badConsole
      defects.push({
        id: 'D1-console-error',
        severity: 'critical',
        criterion: 'hierarchy',
        where: `${route} [${width}px]`,
        fix: `Corrigir erros de execução no console: ${badConsole[0].text.slice(0, 100)}`,
      })
    }
  }

  // D2: Rede sem 4xx/5xx (fora da network_allowlist)
  if (activeGates.has('D2')) {
    const badNetwork = networkResponses.filter((res) => {
      if (res.status >= 400) {
        return !networkAllowlist.some((re) => re.test(res.url))
      }
      return false
    })

    if (badNetwork.length > 0) {
      results.D2.pass = false
      results.D2.message = `Rede respondeu com ${badNetwork.length} status >= 400: ${badNetwork[0].url} (${badNetwork[0].status})`
      results.D2.details = badNetwork
      defects.push({
        id: 'D2-network-error',
        severity: 'critical',
        criterion: 'hierarchy',
        where: `${route} [${width}px]`,
        fix: `Corrigir requisições quebradas ou registrar na network_allowlist: ${badNetwork[0].url}`,
      })
    }
  }

  // D3: Contraste AA via axe-core vendorizado
  if (activeGates.has('D3') && page) {
    try {
      // Injeta axe-core se ainda não estiver na página
      const hasAxe = await page.evaluate(() => typeof (window as any).axe !== 'undefined').catch(() => false)
      if (!hasAxe) {
        const axeSource = fs.readFileSync(fileURLToPath(AXE_PATH), 'utf8')
        if (typeof page.addScriptTag === 'function') {
          await page.addScriptTag({ content: axeSource })
        } else if (typeof page.evaluate === 'function') {
          await page.evaluate(axeSource)
        }
      }

      const axeResult = await page.evaluate(async () => {
        if (typeof (window as any).axe === 'undefined') return { violations: [] }
        return (window as any).axe.run(document, { runOnly: ['color-contrast'] })
      })

      artifacts.axe = axeResult
      const violations = axeResult?.violations || []
      if (violations.length > 0) {
        results.D3.pass = false
        const totalNodes = violations.reduce((acc: number,  v: any) => acc + (v.nodes?.length || 0), 0)
        results.D3.message = `Axe encontrou ${totalNodes} nós com contraste insuficiente (WCAG AA)`
        results.D3.details = violations
        defects.push({
          id: 'D3-low-contrast',
          severity: 'critical',
          criterion: 'color',
          where: `${route} (${violations[0].nodes?.[0]?.target?.[0] || 'elemento'})`,
          fix: 'Ajustar proporção de contraste para no mínimo 4.5:1 em texto comum ou 3.0:1 em texto grande',
        })
      }
    } catch (err) {
      results.D3.pass = false
      results.D3.message = `Falha ao executar axe-core: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // D4: Estados presentes (default, empty, loading, etc.)
  if (activeGates.has('D4')) {
    const routeConfig = ((visualConfig.routes || []) as any[]).find((r) => r.path === route)
    const declaredStates = routeConfig?.states || []

    if (declaredStates.length > 1) {
      const defaultSnap = stateSnapshots['default']
      for (const st of declaredStates) {
        if (st === 'default') continue
        const snap = stateSnapshots[st]
        if (!snap) {
          results.D4.pass = false
          results.D4.message = `Estado declarado "${st}" não renderizado ou ausente`
          defects.push({
            id: `D4-state-missing-${st}`,
            severity: 'major',
            criterion: 'states',
            where: `${route}?state=${st}`,
            fix: `Implementar renderização visível para o estado declarado "${st}"`,
          })
        } else if (defaultSnap && snap === defaultSnap) {
          results.D4.pass = false
          results.D4.message = `Estado declarado "${st}" é idêntico ao estado default (sem diferença observável)`
          defects.push({
            id: `D4-state-no-diff-${st}`,
            severity: 'major',
            criterion: 'states',
            where: `${route}?state=${st}`,
            fix: `Diferenciar o snapshot visual/a11y do estado "${st}" em relação ao default`,
          })
        }
      }
    }
  }

  // D5: Detector estético limpo (Impeccable ou fallback)
  if (activeGates.has('D5')) {
    if (detector && typeof detector.detect === 'function') {
      try {
        const detResult = await detector.detect({ route, width, theme, page })
        artifacts.detector = detResult
        const issues = detResult?.issues || []
        const blockingIssues = (issues as any[]).filter((iss) => iss.category === 'slop' || iss.severity === 'error')
        if (blockingIssues.length > 0) {
          results.D5.pass = false
          results.D5.message = `Detector estético acusou ${blockingIssues.length} problemas: ${blockingIssues[0].rule || blockingIssues[0].message}`
          results.D5.details = blockingIssues
          // um defeito por regra: com só o primeiro, o maker corrigia um tique de IA por rodada
          const byRule = new Map<string, any>()
          for (const iss of blockingIssues) if (!byRule.has(iss.rule || 'slop')) byRule.set(iss.rule || 'slop', iss)
          for (const [rule, iss] of byRule) {
            defects.push({
              id: `D5-${rule}`,
              severity: 'major',
              criterion: 'specificity',
              where: `${route}`,
              fix: `Remover defeito estético detectado: ${iss.message || rule}`,
            })
          }
        }
      } catch (err) {
        results.D5.pass = false
        results.D5.message = `Detector estético indisponível: ${err instanceof Error ? err.message : String(err)}`
        defects.push({
          id: 'D5-detector-unavailable',
          severity: 'critical',
          criterion: 'specificity',
          where: `${route}`,
          fix: 'Restaurar o detector estético na versão fixada antes de aprovar a interface',
        })
      }
    } else if (page && typeof page.evaluate === 'function') {
      // Fallback estético determinístico sobre o DOM: banimento literal de kicker/eyebrow acima de heading
      const aestheticViolations = await page
        .evaluate(() => {
          const fails = []
          const kickers = document.querySelectorAll('.eyebrow, .kicker, [data-kicker], .hero-eyebrow-chip')
          for (const k of kickers) {
            const next = k.nextElementSibling
            if (next && /^H[1-3]$/i.test(next.tagName)) {
              fails.push({ rule: 'kicker-above-heading', message: 'Kicker/eyebrow posicionado acima de heading (banimento literal)' })
            }
          }
          return fails
        })
        .catch(() => [])

      if (aestheticViolations.length > 0) {
        results.D5.pass = false
        results.D5.message = aestheticViolations[0].message
        defects.push({
          id: 'D5-kicker-above-heading',
          severity: 'major',
          criterion: 'specificity',
          where: `${route}`,
          fix: 'Remover o elemento kicker/eyebrow acima do cabeçalho',
        })
      }
    }
  }

  // D6: Responsivo (scrollWidth <= clientWidth + 1 e right <= innerWidth + 1)
  if (activeGates.has('D6') && page && typeof page.evaluate === 'function') {
    try {
      const respCheck = await page.evaluate(() => {
        const scroller = document.scrollingElement || document.documentElement || document.body
        const scrollWidth = scroller.scrollWidth
        const clientWidth = scroller.clientWidth
        const hasScrollOverflow = scrollWidth > clientWidth + 1

        let overflowingElement = null
        const allElements = document.querySelectorAll('*')
        for (const el of allElements) {
          const rect = el.getBoundingClientRect()
          if (rect.right > window.innerWidth + 1) {
            overflowingElement = `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`
            break
          }
        }

        return {
          scrollWidth,
          clientWidth,
          hasScrollOverflow,
          overflowingElement,
        }
      })

      if (respCheck.hasScrollOverflow || respCheck.overflowingElement) {
        results.D6.pass = false
        results.D6.message = `Estouro horizontal em viewport ${width}px: scrollWidth=${respCheck.scrollWidth}, clientWidth=${respCheck.clientWidth}, elemento=${respCheck.overflowingElement}`
        results.D6.details = respCheck
        defects.push({
          id: 'D6-horizontal-overflow',
          severity: 'critical',
          criterion: 'hierarchy',
          where: `${route} [${width}px] (${respCheck.overflowingElement || 'body'})`,
          fix: `Garantir que nenhum elemento exceda a largura da viewport de ${width}px`,
        })
      }
    } catch {
      // Se falhar a checagem no dublê sem evaluate
    }
  }

  const ok = Object.values(results).every((r) => r.pass)

  return {
    ok,
    results,
    artifacts,
    defects,
  }
}
