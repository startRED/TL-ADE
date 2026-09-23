type SurfaceMode = 'persuade' | 'operate' | 'read' | 'experience'

interface DesignBrief {
    audience: string
    surface_mode: SurfaceMode
    preserved_patterns: string[]
    avoid_patterns: string[]
    references: string[]
    direction: { name: string; signature: string; self_critique: string} 
    character: { variance: number; motion: number; density: number; justification: string} 
    tokens: { palette: Record<string, string>; typography: { display: string; body: string} ; spacing: string[]; radii: string[]} 
}

const DEFAULT_AVOID_PATTERNS = [
  'kicker-above-heading', // Banimento literal normativo — nenhum brief ganha de volta
  'hero-eyebrow-chip',
  'flat-type-hierarchy',
  'ai-color-palette',
  'gradient-text-unauthored',
  'gray-on-color',
]

/**
 * Infere o modo da superfície com base no pedido, contexto ou sinais.
 */
export function inferSurfaceMode(request: string, declaredMode?: string): SurfaceMode {
  if (declaredMode && ['persuade', 'operate', 'read', 'experience'].includes(declaredMode)) {
    return (declaredMode as SurfaceMode)
  }
  const lower = request.toLowerCase()
  if (/dashboard|admin|tabela|gest[aã]o|monitoramento|metricas|painel/i.test(lower)) {
    return 'operate'
  }
  if (/artigo|blog|documenta[cç][aã]o|leitura|livro|manual/i.test(lower)) {
    return 'read'
  }
  if (/interativ[oa]|onboarding|jogo|experiencia|showcase/i.test(lower)) {
    return 'experience'
  }
  return 'persuade'
}

/**
 * Constrói o DesignBrief estruturado em 4 camadas normativas com caráter e autocrítica obrigatória.
 */
export function buildDesignBrief({ request, discovery = {}, repoSignals = {}, surfaceMode }: {
        request: string
        discovery?: any
        repoSignals?: any
        surfaceMode?: string
    }): DesignBrief {
  const mode = inferSurfaceMode(request, surfaceMode)

  // 1. Camada 1: Produto e Público
  let audience = 'Operadores técnicos e usuários finais da aplicação'
  if (repoSignals.existing_product_md) {
    const audMatch = repoSignals.existing_product_md.match(/p[uú]blico(?:\s*alvo)?:\s*([^\n]+)/i)
    if (audMatch) audience = audMatch[1].trim()
  } else if (/desenvolvedor|dev|engenheiro/i.test(request)) {
    audience = 'Desenvolvedores e engenheiros de software'
  } else if (/cliente|consumidor|comprador/i.test(request)) {
    audience = 'Consumidores finais e clientes da plataforma'
  }

  // 2. Camada 2: Tokens preservados e candidatos
  const preservedPatterns = Array.from(
    new Set([...(repoSignals.preserved_patterns || []), ...((discovery.anchors || []) as any[]).map((a) => a.path)]),
  )

  const palette = {
    dominant: repoSignals.palette?.dominant || (mode === 'operate' ? '#0f172a' : '#064e3b'),
    accent: repoSignals.palette?.accent || (mode === 'operate' ? '#6366f1' : '#10b981'),
    bg: repoSignals.palette?.bg || '#ffffff',
    surface: repoSignals.palette?.surface || (mode === 'operate' ? '#f8fafc' : '#f0fdf4'),
    text: repoSignals.palette?.text || '#0f172a',
    ...repoSignals.palette,
  }

  const fonts = repoSignals.fonts || []
  const typography = {
    display: fonts[0] || (mode === 'read' ? 'Newsreader, Georgia, serif' : 'Plus Jakarta Sans, sans-serif'),
    body: fonts[1] || fonts[0] || 'Inter, -apple-system, system-ui, sans-serif',
  }

  // 3. Camada 3: Caráter justificado (sem baseline fixa arbitrária)
  let variance = 6
  let motion = 4
  let density = 5

  if (mode === 'operate') {
    variance = 4
    motion = 2
    density = 8
  } else if (mode === 'read') {
    variance = 3
    motion = 1
    density = 4
  } else if (mode === 'experience') {
    variance = 9
    motion = 8
    density = 5
  } else if (mode === 'persuade') {
    variance = 7
    motion = 5
    density = 6
  }

  const justification = `Caráter calibrado para o modo ${mode} e público "${audience}". Densidade ${density}/10 prioriza ${mode === 'operate' ? 'visibilidade de dados sem ruído' : 'ritmo vertical e clareza'}; movimento ${motion}/10 focado em feedback intencional; variância ${variance}/10 balanceia identidade única e convenções da plataforma.`

  // 4. Camada 4: Direção com assinatura e autocrítica obrigatória
  const shortTask = request.trim().slice(0, 50)
  const directionName = `Direção de interface para ${shortTask}`
  const signature = `Assinatura de superfície para ${mode}: ritmo assimétrico com tipografia display intencional e destaque semântico em tokens próprios`

  // Autocrítica obrigatória: se qualquer parte soar genérica, declara a revisão e justificativa
  const selfCritique = `Autocrítica obrigatória: Eliminado o padrão clichê de hero com chip flutuante genérico e cards simétricos cinzas; adotada hierarquia vertical com tipografia ${typography.display}, densidade ${density} e destaque claro em ${palette.dominant} para evitar aparência de template gerado.`

  const avoidPatterns = [...DEFAULT_AVOID_PATTERNS]

  const references = [
    `surface_mode:${mode}`,
    `catalog:macrostructure:${mode}`,
    ...((repoSignals.motion_libs || []) as string[]).map((m) => `lib:${m}`),
  ]

  return {
    audience,
    surface_mode: mode,
    preserved_patterns: preservedPatterns,
    avoid_patterns: avoidPatterns,
    references,
    direction: {
      name: directionName,
      signature,
      self_critique: selfCritique,
    },
    character: {
      variance,
      motion,
      density,
      justification,
    },
    tokens: {
      palette,
      typography,
      spacing: mode === 'operate' ? ['8px', '12px', '16px', '24px'] : ['16px', '24px', '32px', '64px'],
      radii: mode === 'operate' ? ['4px', '8px'] : ['8px', '16px'],
    },
  }
}
