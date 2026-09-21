// @ts-check
import { createHash } from 'node:crypto'
import http from 'node:http'
import { recommendDesign, compareDesign, loadDesignCatalog } from './design-retrieval.js'

const APPROVED_TOOL_NAMES = [
  'recommend_design',
  'compare_design',
  'get_macrostructure',
  'get_component_reference',
  'get_palette_tokens',
  'get_spacing_tokens',
  'get_typography_ramp',
  'slop_test',
  'pre_critique',
]

/**
 * Cria servidor local de ferramentas de design limitado ao perfil aprovado da chamada para o Maker.
 *
 * @param {{
 *   recommend?: typeof recommendDesign,
 *   compare?: typeof compareDesign,
 *   catalog?: any,
 *   port?: number,
 *   toolNames?: string[],
 * }} [options]
 * @returns {Promise<{
 *   port: number,
 *   url: string,
 *   tools: Array<{ name: string, description: string }>,
 *   manifest: { role: 'maker', tools: string[], digest: string },
 *   close: () => Promise<void>,
 * }>}
 */
export async function createDesignToolServer(options = {}) {
  const recommendFn = options.recommend ?? recommendDesign
  const compareFn = options.compare ?? compareDesign
  const catalog = loadDesignCatalog(options.catalog)

  const tools = [
    { name: 'recommend_design', description: 'Recomenda macroestruturas, componentes e paletas com base no brief' },
    { name: 'compare_design', description: 'Compara duas variantes de design contra o brief' },
    { name: 'get_macrostructure', description: 'Retorna opções de macroestrutura do catálogo local' },
    { name: 'get_component_reference', description: 'Retorna componentes de referência com regras CSS' },
    { name: 'get_palette_tokens', description: 'Retorna paletas de tokens semânticos' },
    { name: 'get_spacing_tokens', description: 'Retorna orientações de espaçamento e ritmo vertical' },
    { name: 'get_typography_ramp', description: 'Retorna rampa tipográfica display e corpo' },
    { name: 'slop_test', description: 'Verifica se o markup/estilo possui anti-patterns conhecidos' },
    { name: 'pre_critique', description: 'Gera pré-crítica em 6 eixos antes do despacho visual' },
  ]

  const requested = options.toolNames || APPROVED_TOOL_NAMES
  if (requested.some((name) => !APPROVED_TOOL_NAMES.includes(name))) {
    throw new TypeError('perfil de ferramentas de design contém item não aprovado')
  }
  const selectedTools = tools.filter((tool) => requested.includes(tool.name))
  const toolNames = selectedTools.map((t) => t.name).sort()
  const digest = `sha256:${createHash('sha256').update(toolNames.join(',')).digest('hex')}`
  const manifest = {
    role: /** @type {const} */ ('maker'),
    tools: toolNames,
    digest,
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}')
          if (payload.method === 'initialize') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ade-design', version: '1.0.0' } } }))
            return
          }
          if (payload.method === 'notifications/initialized') {
            res.writeHead(202).end()
            return
          }
          if (payload.method === 'tools/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: selectedTools.map((tool) => ({ ...tool, inputSchema: { type: 'object' } })) } }))
            return
          }
          const tool = payload.method === 'tools/call' ? payload.params?.name : payload.tool
          const params = payload.method === 'tools/call' ? payload.params?.arguments : payload.params
          if (!toolNames.includes(tool)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `Ferramenta desconhecida: ${tool}` }))
            return
          }

          let result = null
          if (tool === 'recommend_design') {
            result = recommendFn({ brief: params?.brief, catalog })
          } else if (tool === 'compare_design') {
            result = compareFn({ candidateA: params?.candidateA, candidateB: params?.candidateB, brief: params?.brief })
          } else if (tool === 'get_macrostructure') {
            result = catalog.macrostructures || []
          } else if (tool === 'get_component_reference') {
            result = catalog.components || []
          } else if (tool === 'get_palette_tokens') {
            result = catalog.palettes || []
          } else if (tool === 'get_spacing_tokens') {
            result = catalog.guidance?.spacingGuidance || '80-160 px entre seções'
          } else if (tool === 'get_typography_ramp') {
            result = { display: 'Fraunces/Newsreader', body: 'Plus Jakarta Sans/Inter' }
          } else if (tool === 'slop_test') {
            const code = String(params?.code || '')
            const fails = []
            if (/kicker/i.test(code)) fails.push('kicker-above-heading')
            if (/outline:\s*none/i.test(code) && !/:focus-visible/i.test(code)) fails.push('outline-none-without-focus')
            result = { passed: fails.length === 0, violations: fails }
          } else if (tool === 'pre_critique') {
            result = {
              scores: { philosophy: 4, hierarchy: 4, execution: 4, specificity: 4, restraint: 4, variety: 4 },
              stamp: '/* pre-emit critique: ok */',
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload.jsonrpc
            ? { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }
            : { ok: true, result }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', tools: toolNames }))
    }
  })

  await new Promise((resolve, reject) => {
    server.listen(options.port || 0, '127.0.0.1', () => resolve(undefined))
    server.once('error', reject)
  })

  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  const port = addr.port
  const url = `http://127.0.0.1:${port}`

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve(undefined))
    })

  return {
    port,
    url,
    tools: selectedTools,
    manifest,
    close,
  }
}
