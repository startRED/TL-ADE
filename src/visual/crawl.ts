interface CrawlDefect {
    id: string
    severity: 'critical' | 'major' | 'minor'
    criterion: string
    where: string
    fix: string
}

interface Target {
    selector: string
    kind: 'click' | 'fill' | 'select'
    label: string
}

// Nunca clicados: ação destrutiva de texto óbvio. crawl.skip soma a esta lista.
const DESTRUCTIVE = /\b(excluir|apagar|delete|remov\w*|sair|logout|log ?out|sign ?out)\b/i
const XSS_MARK = 'ade-xss'
const FILL_VALUES = ['', 'a'.repeat(5000), '😀🔥 ção', `<script>alert('${XSS_MARK}')</script><img src=x onerror="alert('${XSS_MARK}')">`]
const ACTION_TIMEOUT_MS = 2000

/**
 * Portão D7: clica em todo botão e link da mesma origem, abre menus e preenche campos da página já capturada.
 * Reporta exceção sem tratamento, erro no console, 4xx/5xx fora da allowlist, tela em branco e XSS refletido.
 * Falha do próprio crawl vira `skipped` e nunca reprova a tela.
 */
export async function crawlPage(params: {
        page: any
        route: string
        width: number
        networkAllowlist?: RegExp[]
        consoleAllowlist?: RegExp[]
        maxActions?: number
        maxMs?: number
        skip?: string
    }): Promise<{ defects: CrawlDefect[]; actions: number; truncated?: string; skipped?: string }> {
  const { page, route, width, networkAllowlist = [], consoleAllowlist = [], maxActions = 40, maxMs = 20_000 } = params
  if (typeof page?.evaluate !== 'function' || typeof page?.locator !== 'function' || typeof page?.on !== 'function') {
    return { defects: [], actions: 0, skipped: 'página sem API do Playwright' }
  }
  const skipRe = params.skip ? new RegExp(params.skip, 'i') : null
  const defects: CrawlDefect[] = []
  const seenErrors = new Set<string>()
  let current = ''
  const report = (id: string, message: string, severity: CrawlDefect['severity'] = 'critical') => {
    // o mesmo erro disparado por ações diferentes chega uma vez, com a primeira ação que o causou
    const key = `${id} ${message.replace(/\d+/g, '#')}`
    if (seenErrors.has(key)) return
    seenErrors.add(key)
    const selector = current.split(' ')[0]
    defects.push({ id, severity, criterion: 'hierarchy', where: `${route} [${width}px] (${selector})`, fix: `Ação: ${current} → ${message.slice(0, 300)}` })
  }

  const onPageError = (err: Error) => report('D7-page-error', `exceção sem tratamento: ${err.message}`)
  const onConsole = (msg: any) => {
    const text = msg.text()
    // recurso com status de erro já sai como D7-network-error
    if (msg.type() !== 'error' || /Failed to load resource/.test(text) || consoleAllowlist.some((re) => re.test(text))) return
    report('D7-console-error', `erro no console: ${text}`)
  }
  const onResponse = (res: any) => {
    const status = res.status()
    if (status >= 400 && !networkAllowlist.some((re) => re.test(res.url()))) report('D7-network-error', `${res.url()} respondeu ${status}`)
  }
  const onDialog = (dialog: any) => {
    if (dialog.message().includes(XSS_MARK)) report('D7-xss', 'o valor digitado executou script (XSS)')
    dialog.dismiss().catch(() => {})
  }
  const onPopup = (popup: any) => { popup.close().catch(() => {}) }

  const startUrl = page.url()
  const origin = new URL(startUrl).origin
  const deadline = Date.now() + maxMs
  let actions = 0
  let truncated: string | undefined
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('response', onResponse)
  page.on('dialog', onDialog)
  page.context?.().on?.('page', onPopup)
  try {
    const wasBlank = await isBlank(page)
    const queue: Target[] = []
    const seen = new Set<string>()
    const enqueue = async () => {
      for (const t of await listTargets(page, origin)) {
        if (seen.has(t.selector)) continue
        seen.add(t.selector)
        if (DESTRUCTIVE.test(t.label) || skipRe?.test(t.label)) continue
        queue.push(t)
      }
    }
    await enqueue()
    while (queue.length > 0) {
      const target = queue.shift() as Target
      const values = target.kind === 'fill' ? FILL_VALUES : [null]
      for (const value of values) {
        if (actions >= maxActions) { truncated = `limite de ${maxActions} ações`; break }
        if (Date.now() > deadline) { truncated = `limite de ${maxMs} ms`; break }
        actions++
        current = value === null ? `${target.selector} clicar "${target.label.slice(0, 40)}"` : `${target.selector} preencher "${value.slice(0, 60)}${value.length > 60 ? `…(${value.length})` : ''}"`
        const el = page.locator(target.selector).first()
        try {
          if (target.kind === 'click') await el.click({ timeout: ACTION_TIMEOUT_MS })
          else if (target.kind === 'select') await el.selectOption({ index: 0 }, { timeout: ACTION_TIMEOUT_MS })
          else {
            await el.fill(value as string, { timeout: ACTION_TIMEOUT_MS })
            await el.press('Enter', { timeout: ACTION_TIMEOUT_MS })
          }
        } catch {
          // alvo sumiu ou ficou coberto depois de outra ação: não é defeito da tela
          continue
        }
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(100)
        if (!wasBlank && (await isBlank(page))) report('D7-blank-after-action', 'a tela ficou em branco')
        if (page.url() !== startUrl) await page.goto(startUrl, { waitUntil: 'load', timeout: 15_000 })
      }
      if (truncated) break
      // menu aberto pela ação mostra alvos novos
      await enqueue()
    }
    return { defects, actions, ...(truncated ? { truncated } : {}) }
  } catch (err) {
    return { defects, actions, skipped: `crawl falhou: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    page.off?.('pageerror', onPageError)
    page.off?.('console', onConsole)
    page.off?.('response', onResponse)
    page.off?.('dialog', onDialog)
    page.context?.().off?.('page', onPopup)
    // o crawl muda o DOM; quem vem depois recebe a página como foi carregada
    await page.goto(startUrl, { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
  }
}

async function isBlank(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.body
    if (!body) return true
    if (body.innerText.trim() !== '') return false
    return !body.querySelector('img, svg, canvas, video, input, button, textarea, select')
  })
}

/** Alvos visíveis e habilitados, com seletor estável: id, data-testid ou caminho nth-of-type. */
async function listTargets(page: any, origin: string): Promise<Target[]> {
  return page.evaluate((pageOrigin: string) => {
    const selectorOf = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`
      const testId = el.getAttribute('data-testid')
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`
      const parts: string[] = []
      let node: Element | null = el
      while (node && node !== document.body) {
        const tag = node.tagName.toLowerCase()
        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName) : []
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
        node = node.parentElement
      }
      return `body > ${parts.join(' > ')}`
    }
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const out: Array<{ selector: string; kind: string; label: string }> = []
    const all = document.querySelectorAll('button, [role=button], [role=menuitem], [role=tab], [aria-haspopup], summary, a[href], input, textarea, select')
    for (const el of Array.from(all)) {
      if (!visible(el) || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
      const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), (el as HTMLInputElement).value].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      const tag = el.tagName
      if (tag === 'A') {
        const a = el as HTMLAnchorElement
        if (a.target === '_blank' || a.hasAttribute('download')) continue
        let url: URL
        try { url = new URL(a.href, location.href) } catch { continue }
        if (url.origin !== pageOrigin) continue
      }
      let kind = 'click'
      if (tag === 'SELECT') kind = 'select'
      else if (tag === 'TEXTAREA') kind = 'fill'
      else if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type
        if (['hidden', 'file', 'image', 'reset', 'color', 'range', 'date', 'datetime-local', 'month', 'time', 'week'].includes(type)) continue
        kind = ['checkbox', 'radio', 'button', 'submit'].includes(type) ? 'click' : 'fill'
      }
      out.push({ selector: selectorOf(el), kind, label })
    }
    return out
  }, origin)
}
