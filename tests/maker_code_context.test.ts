import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.ts'
import { codeMap, symbolExcerpts } from '../src/context/code-map.ts'
import { buildStoryContext } from '../src/context/story.ts'
import { compilePack } from '../src/pack/pack.ts'

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) removeTmpDir(tmpDirs.pop()!)
})

function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

/** Grava um arquivo de `total` linhas com as declarações dadas nas linhas (1-based) indicadas. */
function writeLines(dir: string, rel: string, total: number, at: Record<number, string>, filler = '// ...'): void {
  const lines = Array.from({ length: total }, (_, i) => at[i + 1] ?? filler)
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), lines.join('\n'))
}

/** Journal dublê: guarda os eventos em memória. */
function fakeJournal() {
  const events: Record<string, unknown>[] = []
  return { events, append: async (event: Record<string, unknown>) => { events.push(event); return event } }
}

async function storyContext(dir: string, story: Record<string, unknown>) {
  const missionDir = tmp('ade-mission-')
  return buildStoryContext(
    { loaded: { plan: { id: 'plan-1', authorization: {} } }, story, worktreeDir: dir, missionDir, operatorNotes: [] },
    { journal: fakeJournal() },
  )
}

describe('mapa do código do maker', () => {
  test('exemplo: TypeScript de 160 linhas vira caminho, total de linhas e nome@linha', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'src/engine/deliver.ts', 160, {
      12: 'export async function deliverStory(opts: Opts): Promise<void> {',
      130: 'export const withDeliveryFlag = (value: boolean) => value',
    })
    const map = await codeMap(dir, ['src/engine/deliver.ts'])
    expect(map).toContain('src/engine/deliver.ts (160 linhas): deliverStory@12, withDeliveryFlag@130')
  })

  test('exemplo: Rust de 90 linhas', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'lib.rs', 90, {
      3: 'pub struct Config {',
      18: 'pub fn parse(input: &str) -> Config {',
      40: 'pub struct Parser {',
    })
    expect(await codeMap(dir, ['lib.rs'])).toContain('lib.rs (90 linhas): Config@3, parse@18, Parser@40')
  })

  test('exemplo: Markdown de 120 linhas', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'README.md', 120, { 5: '## Instalação', 30: '## Uso' }, 'texto corrido')
    expect(await codeMap(dir, ['README.md'])).toContain('README.md (120 linhas): Instalação@5, Uso@30')
  })

  test('C1: TypeScript de 200 linhas no escopo aparece na seção retrieved com caminho, linhas e nome@linha', async () => {
    const dir = tmp('ade-wt-')
    writeLines(dir, 'src/engine/deliver.ts', 200, {
      12: 'export async function deliverStory(opts: Opts): Promise<void> {',
      130: 'function withDeliveryFlag(value: boolean) {',
      170: 'export class DeliveryError extends Error {',
    })
    const ctx = await storyContext(dir, { id: 's1', task: 't', guardrails: { scope_paths: ['src/engine/deliver.ts'] } })
    expect(ctx.sections.retrieved).toContain('src/engine/deliver.ts (200 linhas): deliverStory@12, withDeliveryFlag@130, DeliveryError@170')
  })

  test('C2: interface do contrato que nomeia função do escopo traz o trecho em volta da declaração, numerado', async () => {
    const dir = tmp('ade-wt-')
    writeLines(dir, 'src/engine/deliver.ts', 200, {
      12: 'export async function deliverStory(opts: Opts): Promise<void> {',
      13: '  return entregar(opts)',
      130: 'function withDeliveryFlag(value: boolean) {',
    })
    const direct = await symbolExcerpts(dir, ['src/engine/deliver.ts'], ['deliverStory'], { radius: 3 })
    expect(direct).toContain('src/engine/deliver.ts linhas 9-15 (deliverStory)')
    expect(direct).toContain('12: export async function deliverStory(opts: Opts): Promise<void> {')
    expect(direct).toContain('13:   return entregar(opts)')
    expect(direct).not.toContain('withDeliveryFlag')

    const ctx = await storyContext(dir, {
      id: 's1',
      task: 't',
      guardrails: { scope_paths: ['src/engine/**'] },
      interfaces: ['deliverStory(opts) → Promise<void>'],
    })
    expect(ctx.sections.retrieved).toContain('12: export async function deliverStory(opts: Opts): Promise<void> {')
    expect(ctx.sections.retrieved).not.toContain('130: function withDeliveryFlag')
  })

  test('C3: arquivo com menos de 40 linhas entra inteiro em vez de mapeado', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'src/small.ts', 10, { 2: 'export function tiny() {', 3: '  return 42' })
    const map = await codeMap(dir, ['src/small.ts'])
    expect(map).not.toContain('tiny@2')
    expect(map).toContain('src/small.ts (10 linhas, inteiro)')
    expect(map).toContain('export function tiny() {\n  return 42')
  })

  test('C4: arquivo acima de 400 mil caracteres fica fora do mapa e dos trechos; os demais aparecem', async () => {
    const dir = tmp('ade-map-')
    const huge = ['export function giant() {', ...Array.from({ length: 50 }, () => 'x'.repeat(8100))].join('\n')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src/huge.ts'), huge)
    expect(huge.length).toBeGreaterThan(400000)
    writeLines(dir, 'src/ok.ts', 50, { 7: 'export function giant() {' })
    const files = ['src/huge.ts', 'src/ok.ts']
    const map = await codeMap(dir, files)
    expect(map).not.toContain('src/huge.ts')
    expect(map).toContain('src/ok.ts (50 linhas): giant@7')
    const excerpts = await symbolExcerpts(dir, files, ['giant'])
    expect(excerpts).not.toContain('src/huge.ts')
    expect(excerpts).toContain('src/ok.ts linhas')
  })

  test('C5: arquivo com 60 declarações mostra no máximo 40 símbolos', async () => {
    const dir = tmp('ade-map-')
    const at: Record<number, string> = {}
    for (let i = 1; i <= 60; i++) at[i * 2] = `export function f${i}() {}`
    writeLines(dir, 'src/many.ts', 130, at)
    const map = await codeMap(dir, ['src/many.ts'])
    const line = map.split('\n').find((l) => l.startsWith('src/many.ts'))!
    expect(line.match(/@\d+/g)).toHaveLength(40)
    expect(line).toContain('f40@80')
    expect(line).not.toContain('f41@')
  })

  test('C6: mapa e trechos acima do teto de retrieved são cortados com marca e o pacote continua válido', async () => {
    const dir = tmp('ade-wt-')
    for (let f = 0; f < 30; f++) {
      const at: Record<number, string> = {}
      for (let i = 1; i <= 40; i++) at[i * 2] = `export function symbol_${f}_${i}() {}`
      writeLines(dir, `src/mod${f}.ts`, 90, at)
    }
    const ctx = await storyContext(dir, { id: 's1', task: 't', guardrails: { scope_paths: ['src/**'] } })
    expect(Buffer.byteLength(ctx.sections.retrieved)).toBeGreaterThan(6000)
    const missionDir = tmp('ade-pack-')
    const pack = compilePack({ missionDir, stepId: 's1:r1:maker', sections: ctx.sections })
    const retrieved = pack.manifest.sections.find((s) => s.section === 'retrieved')!
    expect(retrieved.truncated).toBe(true)
    expect(retrieved.bytes).toBeLessThanOrEqual(6000)
    const text = fs.readFileSync(pack.pack_path, 'utf8')
    expect(text).toContain('[... truncated')
    expect(text).toContain('=== ade:section skills ===')
  })

  test('C7: arquivo ainda inexistente ou binário é ignorado sem erro', async () => {
    const dir = tmp('ade-map-')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]))
    fs.writeFileSync(path.join(dir, 'src/blob.ts'), Buffer.concat([Buffer.from('export function blob() {}\n'), Buffer.alloc(64)]))
    writeLines(dir, 'src/real.ts', 50, { 3: 'export function real() {' })
    const files = ['src/novo.ts', 'src/logo.png', 'src/blob.ts', 'src/real.ts']
    const map = await codeMap(dir, files)
    expect(map).toContain('src/real.ts (50 linhas): real@3')
    for (const skipped of ['src/novo.ts', 'src/logo.png', 'src/blob.ts']) expect(map).not.toContain(skipped)
    expect(await symbolExcerpts(dir, files, ['blob', 'novo'])).toBe('')
  })

  test('C8: Python def/class e Go func/type viram símbolos com a linha certa', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'app.py', 60, {
      2: 'class Loja:',
      5: '    def total(self):',
      20: 'async def buscar(url):',
    }, '# ...')
    writeLines(dir, 'main.go', 60, {
      4: 'type Server struct {',
      10: 'func (s *Server) Start() error {',
      30: 'func main() {',
    })
    const map = await codeMap(dir, ['app.py', 'main.go'])
    expect(map).toContain('app.py (60 linhas): Loja@2, total@5, buscar@20')
    expect(map).toContain('main.go (60 linhas): Server@4, Start@10, main@30')
  })

  test('C9: Rust fn, struct, enum, trait e impl viram símbolos com a linha certa', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'src/lib.rs', 70, {
      1: 'pub struct Token {',
      8: 'enum Kind {',
      15: 'pub trait Lexer {',
      22: 'impl Token {',
      25: '    pub(crate) fn new() -> Self {',
      40: 'async fn run() {',
    })
    expect(await codeMap(dir, ['src/lib.rs'])).toContain('src/lib.rs (70 linhas): Token@1, Kind@8, Lexer@15, Token@22, new@25, run@40')
  })

  test('C10: Java e Ruby pela regra genérica de palavra-chave', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'App.java', 60, {
      3: 'public class App {',
      6: '    public static void main(String[] args) {',
      20: '    private int soma(int a, int b) {',
      40: 'interface Servico {',
    })
    writeLines(dir, 'loja.rb', 50, {
      1: 'module Vendas',
      2: '  class Carrinho',
      4: '    def adicionar(item)',
      9: '    def self.vazio',
    }, '# ...')
    const map = await codeMap(dir, ['App.java', 'loja.rb'])
    expect(map).toContain('App.java (60 linhas): App@3, main@6, soma@20, Servico@40')
    expect(map).toContain('loja.rb (50 linhas): Vendas@1, Carrinho@2, adicionar@4, self.vazio@9')
  })

  test('C11: CSS: seletores de regra e at-rules de topo', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'style.css', 50, {
      1: ':root {',
      2: '  --cor: #333;',
      5: '.card, .painel {',
      10: '@media (max-width: 600px) {',
      11: '  .card {',
      20: '@import url("base.css");',
    }, '  color: red;')
    expect(await codeMap(dir, ['style.css'])).toContain('style.css (50 linhas): :root@1, .card, .painel@5, @media (max-width: 600px)@10, @import url("base.css")@20')
  })

  test('C12: HTML: elementos com id e marcos de estrutura', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'index.html', 50, {
      3: '<header class="topo">',
      5: '  <div id="app"></div>',
      8: '<main>',
      12: '  <section id="planos">',
      30: '<footer>',
    }, '  <p>texto</p>')
    expect(await codeMap(dir, ['index.html'])).toContain('index.html (50 linhas): header@3, app@5, main@8, planos@12, footer@30')
  })

  test('C13: Markdown: títulos viram símbolos', async () => {
    const dir = tmp('ade-map-')
    writeLines(dir, 'docs/guia.md', 45, { 1: '# Guia', 10: '### Passo a passo', 40: '#### Anexo' }, 'texto')
    expect(await codeMap(dir, ['docs/guia.md'])).toContain('docs/guia.md (45 linhas): Guia@1, Passo a passo@10, Anexo@40')
  })

  test('C14: sem arquivo legível no escopo a seção retrieved fica vazia e o pacote não a inclui', async () => {
    const dir = tmp('ade-wt-')
    const ctx = await storyContext(dir, { id: 's1', task: 't', guardrails: { scope_paths: ['src/novo.ts'] } })
    expect(ctx.sections.retrieved).toBe('')
    const pack = compilePack({ missionDir: tmp('ade-pack-'), stepId: 's1:r1:maker', sections: ctx.sections })
    expect(pack.manifest.sections.map((s) => s.section)).toEqual(['contract', 'policy', 'story', 'skills'])
  })
})
