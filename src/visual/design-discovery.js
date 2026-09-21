// @ts-check
import fs from 'node:fs'
import path from 'node:path'

const UI_FRAMEWORKS = ['react', 'vue', 'svelte', 'next', 'astro', 'solid-js', '@angular/core', 'preact']
const MOTION_LIBRARIES = ['framer-motion', 'gsap', 'motion', 'lucide-react', 'lucide-vue-next', '@heroicons/react']
const VIEW_EXTENSIONS = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|less)$/i
const UI_LEXICON = /\b(design|p[aá]gina|tela|bot[aã]o|layout|responsiv[oa]|tema\s+escuro|interface|frontend|ui)\b/i

/**
 * Descobre sinais visuais determinísticos do repositório antes de perguntas ou compilação.
 *
 * @param {{
 *   repoDir?: string,
 *   paths?: string[],
 *   packageJson?: any,
 *   request?: string,
 *   config?: any,
 *   scopePaths?: string[],
 * }} options
 * @returns {{
 *   has_ui: boolean,
 *   signals: {
 *     s1_framework: string | null,
 *     s2_css_toolchain: string[],
 *     s3_scope_view: boolean,
 *     s4_brief_exists: boolean,
 *     s5_servable_script: string | null,
 *     s6_routes_declared: boolean,
 *     s7_lexicon: boolean,
 *   },
 *   fonts: string[],
 *   palette: Record<string, string>,
 *   motion_libs: string[],
 *   preserved_patterns: string[],
 *   existing_design_md: string | null,
 *   existing_product_md: string | null,
 * }}
 */
export function discoverDesignSignals(options = {}) {
  const repoDir = options.repoDir ?? process.cwd()
  const paths = options.paths ?? []
  const request = options.request ?? ''
  const config = options.config ?? {}
  const scopePaths = options.scopePaths ?? []

  let pkg = options.packageJson
  if (!pkg && fs.existsSync(path.join(repoDir, 'package.json'))) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'))
    } catch {
      pkg = null
    }
  }

  const allDeps = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
  }

  // S1: Framework de UI
  let s1Framework = null
  for (const fw of UI_FRAMEWORKS) {
    if (allDeps[fw]) {
      s1Framework = fw
      break
    }
  }

  // S2: Toolchain de CSS e fontes
  const s2Toolchain = []
  /** @type {string[]} */
  const fonts = []
  /** @type {Record<string, string>} */
  const palette = {}
  const motionLibs = []

  for (const lib of MOTION_LIBRARIES) {
    if (allDeps[lib]) {
      motionLibs.push(lib)
    }
  }

  if (allDeps['tailwindcss'] || paths.some((p) => /tailwind\.config\.[cm]?[jt]s$/.test(p)) || fs.existsSync(path.join(repoDir, 'tailwind.config.js')) || fs.existsSync(path.join(repoDir, 'tailwind.config.ts'))) {
    s2Toolchain.push('tailwindcss')
  }
  if (allDeps['postcss'] || paths.some((p) => /postcss\.config\.[cm]?[jt]s$/.test(p)) || fs.existsSync(path.join(repoDir, 'postcss.config.js'))) {
    s2Toolchain.push('postcss')
  }
  if (paths.some((p) => /\.module\.(css|scss)$/i.test(p))) {
    s2Toolchain.push('css-modules')
  }

  // S4: DESIGN.md / PRODUCT.md na raiz
  let existingDesignMd = null
  let existingProductMd = null
  const designPath = path.join(repoDir, 'DESIGN.md')
  if (fs.existsSync(designPath)) {
    try {
      existingDesignMd = fs.readFileSync(designPath, 'utf8')
    } catch {
      existingDesignMd = null
    }
  }
  const productPath = path.join(repoDir, 'PRODUCT.md')
  if (fs.existsSync(productPath)) {
    try {
      existingProductMd = fs.readFileSync(productPath, 'utf8')
    } catch {
      existingProductMd = null
    }
  }

  if (existingDesignMd) {
    // Extrai fontes e tokens se existirem em DESIGN.md
    const fontMatches = existingDesignMd.matchAll(/font(?:-family)?:\s*['"]?([^'";\n]+)['"]?/gi)
    for (const m of fontMatches) {
      const f = m[1].trim()
      if (f && !fonts.includes(f)) fonts.push(f)
    }
    const colorMatches = existingDesignMd.matchAll(/--color-([a-zA-Z0-9_-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/g)
    for (const c of colorMatches) {
      palette[c[1]] = c[2]
    }
  }

  // S3: Escopo toca arquivos de visualização
  const effectiveScope = scopePaths.length > 0 ? scopePaths : paths
  const s3ScopeView = effectiveScope.some((p) => VIEW_EXTENSIONS.test(p))

  // S5: Script servível
  let s5Script = null
  const scripts = pkg?.scripts ?? {}
  for (const candidate of ['dev', 'start', 'preview', 'serve']) {
    if (scripts[candidate]) {
      s5Script = candidate
      break
    }
  }
  if (!s5Script && config?.visual?.serve_command) {
    s5Script = Array.isArray(config.visual.serve_command) ? config.visual.serve_command.join(' ') : String(config.visual.serve_command)
  }

  // S6: Rota declarada
  const s6Routes = Boolean(config?.visual?.routes && config.visual.routes.length > 0)

  // S7: Léxico do pedido
  const s7Lexicon = UI_LEXICON.test(request)

  const s4Exists = Boolean(existingDesignMd || existingProductMd)

  const strongSignal = Boolean(s1Framework || s2Toolchain.length > 0 || s3ScopeView || s4Exists)
  const hasUi = (strongSignal && s3ScopeView) || s7Lexicon || s6Routes || Boolean(config?.visual?.enabled && strongSignal)

  const preservedPatterns = []
  if (s1Framework) preservedPatterns.push(`framework:${s1Framework}`)
  if (s2Toolchain.length > 0) preservedPatterns.push(...s2Toolchain.map((t) => `toolchain:${t}`))
  if (motionLibs.length > 0) preservedPatterns.push(...motionLibs.map((m) => `motion:${m}`))
  if (fonts.length > 0) preservedPatterns.push(...fonts.map((f) => `font:${f}`))

  return {
    has_ui: Boolean(hasUi),
    signals: {
      s1_framework: s1Framework,
      s2_css_toolchain: s2Toolchain,
      s3_scope_view: s3ScopeView,
      s4_brief_exists: s4Exists,
      s5_servable_script: s5Script,
      s6_routes_declared: s6Routes,
      s7_lexicon: s7Lexicon,
    },
    fonts,
    palette,
    motion_libs: motionLibs,
    preserved_patterns: preservedPatterns,
    existing_design_md: existingDesignMd,
    existing_product_md: existingProductMd,
  }
}
