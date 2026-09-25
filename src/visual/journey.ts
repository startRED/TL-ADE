// Jornadas de usuário (26/09). Prints parados não pegavam botão que não faz nada, tela que quebra depois de enviar ou
// estado de erro nunca visto. A prova de parte com tela escreve um roteiro declarativo derivado dos critérios de aceite
// (abrir a rota, clicar, digitar, conferir) e o motor o roda no Playwright antes dos portões D1–D6 e dos juízes.
// Roteiro declarativo e não código livre: o motor valida os passos, sabe dizer qual quebrou e não executa código do modelo.
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium, withServedApp } from './browser.ts'

export type Target = { role: string; name?: string } | { label: string } | { text: string } | { testid: string }
export type JourneyStep =
  | { goto: string }
  | { click: Target }
  | { fill: Target; value: string }
  | { press: string; target?: Target }
  | { upload: Target; files: string[] }
  | { expect_text: string }
  | { expect_visible: Target }
  | { expect_hidden: Target }
  | { expect_url: string }
export type Journey = { criterio: string; needs_data?: boolean; steps: JourneyStep[] }

export type JourneyFailure = {
  criterio: string
  step_index: number
  step: JourneyStep
  error: string
  console: string[]
  failed_requests: string[]
  dom: string
  screenshot: string
  trace: string
  url: string
}
export type JourneyResult =
  | { status: 'pass'; needs_data: string[] }
  | { status: 'fail'; failure: JourneyFailure; needs_data: string[] }
  | { status: 'skipped'; reason: 'no_script' | 'invalid_script' | 'needs_data' | 'browser_failed' | 'no_serve' | 'serve_failed'; errors?: string[]; needs_data?: string[] }

/** Formato que a prova recebe na política (o mesmo que validateJourney aceita). */
export const JOURNEY_FORMAT = [
  'Roteiro de navegador em .ade/journey.json: {"journeys":[{"criterio":"C1","steps":[...]}]}, uma jornada por critério que se vê na tela.',
  'Passos: {"goto":"/rota"}, {"click":ALVO}, {"fill":ALVO,"value":"texto"}, {"press":"Enter"} ou {"press":"Enter","target":ALVO}, {"upload":ALVO,"files":["imagem.png"]} (ALVO é o campo de arquivo ou o botão que abre o seletor; amostras: imagem.png, texto.txt, documento.pdf), {"expect_text":"texto"}, {"expect_visible":ALVO}, {"expect_hidden":ALVO}, {"expect_url":"trecho"}.',
  'ALVO é o que o usuário vê: {"role":"button","name":"Enviar"}, {"label":"Nome"}, {"text":"Salvo"} ou {"testid":"x"}. Comece por goto.',
  'A tela sobe vazia, sem dados. Se o critério depende de dados, crie-os primeiro pela própria interface; se não der, use {"criterio":"Cx","needs_data":true,"steps":[]}.',
].join('\n')

// Amostras do motor para o verbo upload: o roteiro nunca aponta caminho do disco
const SAMPLES: Record<string, { mimeType: string; buffer: Buffer }> = {
  'imagem.png': { mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') },
  'texto.txt': { mimeType: 'text/plain', buffer: Buffer.from('arquivo de exemplo da jornada\n') },
  'documento.pdf': { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n') },
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' && v.length > 0

function targetError(t: unknown): string | null {
  if (!isObj(t)) return 'alvo deve ser objeto'
  const keys = Object.keys(t)
  if (str(t.role) && keys.every((k) => k === 'role' || (k === 'name' && str(t.name)))) return null
  if (keys.length === 1 && ['label', 'text', 'testid'].includes(keys[0]) && str(t[keys[0]])) return null
  return `alvo inválido ${JSON.stringify(t)}: use role (+name), label, text ou testid`
}

function stepError(s: unknown): string | null {
  if (!isObj(s)) return 'passo deve ser objeto'
  if ('goto' in s) return str(s.goto) ? null : 'goto exige rota'
  if ('click' in s) return targetError(s.click)
  if ('fill' in s) return targetError(s.fill) ?? (typeof s.value === 'string' ? null : 'fill exige value')
  if ('press' in s) return !str(s.press) ? 'press exige tecla' : s.target === undefined ? null : targetError(s.target)
  if ('upload' in s) {
    if (!Array.isArray(s.files) || s.files.length === 0) return 'upload exige files'
    const unknown = s.files.filter((n: unknown) => typeof n !== 'string' || !(n in SAMPLES))
    return unknown.length > 0 ? `upload aceita só as amostras ${Object.keys(SAMPLES).join(', ')}` : targetError(s.upload)
  }
  if ('expect_text' in s) return str(s.expect_text) ? null : 'expect_text exige texto'
  if ('expect_visible' in s) return targetError(s.expect_visible)
  if ('expect_hidden' in s) return targetError(s.expect_hidden)
  if ('expect_url' in s) return str(s.expect_url) ? null : 'expect_url exige trecho'
  return `verbo desconhecido: ${Object.keys(s).join(', ')}`
}

export function validateJourney(doc: unknown): { ok: true; journeys: Journey[] } | { ok: false; errors: string[] } {
  if (!isObj(doc) || !Array.isArray(doc.journeys) || doc.journeys.length === 0) return { ok: false, errors: ['journeys deve ser lista não vazia'] }
  const errors: string[] = []
  doc.journeys.forEach((j: any, ji: number) => {
    if (!isObj(j) || !str(j.criterio) || !Array.isArray(j.steps)) return errors.push(`jornada ${ji + 1}: exige criterio e steps`)
    if (j.needs_data === true) return
    if (j.steps.length === 0) return errors.push(`jornada ${j.criterio}: sem passos`)
    j.steps.forEach((s: unknown, si: number) => {
      const e = stepError(s)
      if (e) errors.push(`jornada ${j.criterio} passo ${si + 1}: ${e}`)
    })
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, journeys: doc.journeys }
}

function locate(page: any, t: any) {
  if ('role' in t) return page.getByRole(t.role, t.name ? { name: t.name } : {})
  if ('label' in t) return page.getByLabel(t.label)
  if ('text' in t) return page.getByText(t.text)
  return page.getByTestId(t.testid)
}

async function runStep(page: any, s: any, url: string, timeout: number) {
  if ('goto' in s) {
    await page.goto(new URL(s.goto, url).href, { waitUntil: 'load', timeout: timeout * 3 })
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
  } else if ('click' in s) await locate(page, s.click).first().click({ timeout })
  else if ('fill' in s) await locate(page, s.fill).first().fill(s.value, { timeout })
  else if ('press' in s) await (s.target ? locate(page, s.target).first().press(s.press, { timeout }) : page.keyboard.press(s.press))
  else if ('upload' in s) {
    const files = s.files.map((name: string) => ({ name, ...SAMPLES[name] }))
    const el = locate(page, s.upload).first()
    const isFileInput = await el.evaluate((n: any) => n.tagName === 'INPUT' && n.type === 'file', undefined, { timeout }).catch(() => false)
    if (isFileInput) await el.setInputFiles(files, { timeout })
    else {
      // botão de clipe que abre o seletor de arquivos do sistema
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout }), el.click({ timeout })])
      await chooser.setFiles(files, { timeout })
    }
  } else if ('expect_text' in s) await page.getByText(s.expect_text).first().waitFor({ state: 'visible', timeout })
  else if ('expect_visible' in s) await locate(page, s.expect_visible).first().waitFor({ state: 'visible', timeout })
  else if ('expect_hidden' in s) await locate(page, s.expect_hidden).first().waitFor({ state: 'hidden', timeout })
  else await page.waitForURL((u: URL) => u.href.includes(s.expect_url), { timeout })
}

/**
 * Roda o roteiro oficial contra a tela já servida em `url`. Grava `journey-<tag>.json` (e, na falha, o print e o trace do
 * Playwright) em `outDir`. Sem roteiro, roteiro inválido, só critérios que dependem de dados ou navegador que não abre:
 * a jornada é pulada com o motivo, nunca trava a missão.
 */
export async function runJourneys(opts: { file: string; url: string; outDir: string; tag: string; browser?: any; stepTimeoutMs?: number }): Promise<JourneyResult> {
  const timeout = opts.stepTimeoutMs ?? 5000
  let doc: unknown
  try {
    doc = JSON.parse(fs.readFileSync(opts.file, 'utf8'))
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { status: 'skipped', reason: 'no_script' } : { status: 'skipped', reason: 'invalid_script', errors: ['JSON ilegível'] }
  }
  const valid = validateJourney(doc)
  if (!valid.ok) return { status: 'skipped', reason: 'invalid_script', errors: valid.errors }
  const needsData = valid.journeys.filter((j) => j.needs_data === true).map((j) => j.criterio)
  const runnable = valid.journeys.filter((j) => j.needs_data !== true)
  if (runnable.length === 0) return { status: 'skipped', reason: 'needs_data', needs_data: needsData }

  let browser = opts.browser
  try {
    browser ??= await launchChromium()
  } catch {
    return { status: 'skipped', reason: 'browser_failed' }
  }
  fs.mkdirSync(opts.outDir, { recursive: true })
  const record = (result: JourneyResult) => {
    fs.writeFileSync(path.join(opts.outDir, `journey-${opts.tag}.json`), JSON.stringify(result, null, 2), 'utf8')
    return result
  }
  try {
    for (const journey of runnable) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const consoleLines: string[] = []
      const failedRequests: string[] = []
      await context.tracing?.start({ screenshots: true, snapshots: true })
      const page = await context.newPage()
      page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`) })
      page.on('pageerror', (e: Error) => consoleLines.push(`pageerror: ${e.message}`))
      page.on('response', (r: any) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
      page.on('requestfailed', (r: any) => failedRequests.push(`falhou ${r.method()} ${r.url()}: ${r.failure()?.errorText ?? ''}`))
      try {
        for (const [i, step] of journey.steps.entries()) {
          try {
            await runStep(page, step, opts.url, timeout)
          } catch (err) {
            const screenshot = path.join(opts.outDir, `journey-${opts.tag}.png`)
            const trace = path.join(opts.outDir, `journey-${opts.tag}-trace.zip`)
            await page.screenshot({ path: screenshot }).catch(() => {})
            await context.tracing?.stop({ path: trace }).catch(() => {})
            const dom = String(await page.evaluate('document.body ? document.body.outerHTML : ""').catch(() => ''))
            return record({
              status: 'fail',
              needs_data: needsData,
              failure: {
                criterio: journey.criterio,
                step_index: i + 1,
                step,
                // só a primeira linha: o resto do erro do Playwright é o log de tentativas, que muda a cada passada
                error: String(err instanceof Error ? err.message : err).split('\n')[0].slice(0, 300),
                console: consoleLines.slice(0, 20),
                failed_requests: failedRequests.slice(0, 20),
                dom: dom.slice(0, 4000),
                screenshot: screenshot.replace(/\\/g, '/'),
                trace: trace.replace(/\\/g, '/'),
                url: page.url(),
              },
            })
          }
        }
        await context.tracing?.stop().catch(() => {})
      } finally {
        await context.close().catch(() => {})
      }
    }
    return record({ status: 'pass', needs_data: needsData })
  } finally {
    if (!opts.browser) await browser.close().catch(() => {})
  }
}

/** Roteiro oficial da parte, fora da worktree: o maker não consegue afrouxá-lo. */
export const journeyFile = (missionDir: string, storyId: string) => path.join(missionDir, 'artifacts', 'journeys', `${storyId}.json`)

/**
 * Move `.ade/journey.json` que a prova escreveu na worktree para a cópia oficial da missão. Sem arquivo, `null`; roteiro
 * inválido não vira cópia oficial e volta com os erros.
 */
export function adoptJourney(worktreeDir: string, missionDir: string, storyId: string): { file: string } | { errors: string[] } | null {
  const written = path.join(worktreeDir, '.ade', 'journey.json')
  let doc: unknown
  try {
    doc = JSON.parse(fs.readFileSync(written, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    doc = null
  } finally {
    fs.rmSync(written, { force: true })
  }
  const valid = validateJourney(doc)
  if (!valid.ok) return { errors: valid.errors }
  const file = journeyFile(missionDir, storyId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return { file }
}

/** Vermelho do roteiro: serve a árvore da prova (antes do maker) e roda a jornada uma vez. */
export async function runJourneyCheck(opts: { file: string; config: any; cwd: string; outDir: string }): Promise<JourneyResult> {
  const visual = opts.config?.visual ?? {}
  if (visual.enabled === false || !(visual.url || visual.serve_command)) return { status: 'skipped', reason: 'no_serve' }
  if (!fs.existsSync(opts.file)) return { status: 'skipped', reason: 'no_script' }
  try {
    return await withServedApp(visual, opts.cwd, (url) => runJourneys({ file: opts.file, url, outDir: opts.outDir, tag: 'red' }))
  } catch {
    return { status: 'skipped', reason: 'serve_failed' }
  }
}
