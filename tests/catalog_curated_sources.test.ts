import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isBlockedLicense } from '../src/skills/catalog.ts'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir } from './helpers/tmp-dir.ts'

// Lista curada das coleções famosas (`docs/catalog/fontes-curadas.json`) e `ade catalog sync --sources <arquivo>`:
// a lista do arquivo substitui `catalog.sources` do `.ade/config.json`.

const CURATED = path.resolve(import.meta.dirname, '..', 'docs', 'catalog', 'fontes-curadas.json')

// Skills já pinadas pelas fontes ativas de `docs/catalog-sources.md` §1.1.
const ACTIVE_IDS = [
  'tdd', 'code-review', 'codebase-design', 'frontend-ui-engineering', 'tidy', 'ui-design',
  'deliver-acceptance-criteria', 'deliver-edge-cases', 'react-expert', 'test-master', 'code-reviewer',
  'typescript-advanced-types', 'javascript-testing-patterns', 'nodejs-backend-patterns',
  'error-handling-patterns', 'accessibility-compliance', 'debugging-methodology', 'vitest',
]

const REASON = 'Método de TDD revisado, sem scripts'
const SIGNAL = '1k estrelas no GitHub (medido em 2026-09-24)'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) removeRepo(dir)
  dirs = []
})

const tmp = (prefix: string) => {
  const dir = makeTmpDir(prefix)
  dirs.push(dir)
  return dir
}

function upstreamWith(names: string[], license = 'MIT') {
  const repo = makeRepo()
  dirs.push(repo.dir)
  for (const name of names) {
    fs.mkdirSync(path.join(repo.dir, 'skills', name), { recursive: true })
    fs.writeFileSync(
      path.join(repo.dir, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} em TypeScript\nlicense: ${license}\n---\nCorpo de ${name}`,
      'utf8',
    )
  }
  repo.git(['add', '-A'])
  repo.git(['commit', '-m', 'feat: skills'])
  return { dir: repo.dir, commit: repo.git(['rev-parse', 'HEAD']).trim() }
}

function sink() {
  let text = ''
  return { write: (s: string) => void (text += s), get text() { return text } }
}

/** Projeto com `.ade/config.json` próprio, para provar que `--sources` o substitui. */
function projectWithConfig(sources: unknown[]) {
  const repoDir = tmp('ade-repo-')
  fs.mkdirSync(path.join(repoDir, '.ade'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.ade', 'config.json'), JSON.stringify({ catalog: { sources, trust_default: 'allowlisted' } }), 'utf8')
  return repoDir
}

async function sync(args: string[], deps: { repoDir: string; catalogDir: string; homeDir?: string }) {
  const { main } = await import('../src/cli/catalog.ts')
  const stdout = sink()
  const stderr = sink()
  const code = await main(['sync', ...args], { stdout, stderr, ...deps })
  return { code, out: stdout.text, err: stderr.text }
}

// Caminho explícito por skill: a pasta inteira (`skills/<id>/**`) ou arquivos/pastas dentro dela.
const skillIdOf = (p: string) => p.match(/^skills\/([^/*]+)\/(?:\*\*$|[^*])/)?.[1]

// Nada executável pode sair do commit fixado: hooks, scripts, instaladores ou código.
const EXECUTABLE = /(^|\/)(hooks|scripts)\/|(^|\/)install\.|\.(sh|py|js|mjs|cjs|ts|ps1|bat|cmd)$/

/** Arquivos materializados sob `sources/<fonte>@<commit>/`, sem o prefixo da fonte. */
function materialized(catalogDir: string): string[] {
  const root = path.join(catalogDir, 'sources')
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => fs.statSync(path.join(root, f)).isFile())
    .map((f) => f.slice(f.indexOf('/') + 1))
}

/** Clones reais das fontes curadas, com o commit fixado presente. */
function clonesReady(home: string, sources: Array<{ name: string; commit: string }>) {
  return sources.every((s) => {
    try {
      const dir = path.join(home, '.ade', 'catalog-repos', s.name)
      return execFileSync('git', ['cat-file', '-t', s.commit], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim() === 'commit'
    } catch {
      return false
    }
  })
}

describe('fontes curadas do catálogo', () => {
  const sources = JSON.parse(fs.readFileSync(CURATED, 'utf8'))

  test('C2.1 cada fonte tem nome seguro, url, commit completo, licença livre, motivo e sinal datado', () => {
    expect(Array.isArray(sources)).toBe(true)
    expect(sources.map((s: { name: string }) => s.name).sort()).toEqual(
      ['addyosmani-agent-skills', 'anthropics-skills', 'everything-claude-code', 'superpowers'],
    )
    for (const s of sources) {
      expect(s.name).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
      expect(s.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(isBlockedLicense(s.license), `${s.name}: ${s.license}`).toBe(false)
      expect(s.repo).toBe(`~/.ade/catalog-repos/${s.name}`)
      expect(typeof s.reason === 'string' && s.reason.trim().length > 0).toBe(true)
      expect(s.community_signal).toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  test('C2.2 caminhos são explícitos por skill e não trazem hooks, scripts, instaladores nem skills vetadas', () => {
    const vetoed = ['docx', 'pdf', 'pptx', 'xlsx', 'brandkit', 'image-to-code', 'image-to-code-skill']
    const seen = new Set<string>(ACTIVE_IDS)
    for (const s of sources) {
      expect(Array.isArray(s.paths)).toBe(true)
      expect(s.paths.length).toBeGreaterThan(0)
      const ids = new Set<string>()
      for (const p of s.paths) {
        expect(p).not.toMatch(/(^|\/)(hooks|scripts)(\/|$)|(^|\/)install\.|\.\./)
        const id = skillIdOf(p)
        expect(id, `caminho não explícito: ${p}`).toBeTruthy()
        expect(vetoed).not.toContain(id)
        expect(id).not.toMatch(/^imagegen-/)
        ids.add(id!)
      }
      for (const id of ids) {
        expect(seen.has(id), `id repetido: ${id}`).toBe(false)
        seen.add(id)
      }
    }
  })

  test('C2.2 caminhos da Anthropic não materializam scripts/ nem eval-viewer/ do skill-creator', async () => {
    const anthropic = sources.find((s: { name: string }) => s.name === 'anthropics-skills')
    const repo = makeRepo()
    dirs.push(repo.dir)
    const put = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true })
      fs.writeFileSync(path.join(repo.dir, file), body, 'utf8')
    }
    // Mesma árvore do skill-creator no commit fixado, mais uma skill vizinha fora da lista.
    put('skills/skill-creator/SKILL.md', '---\nname: skill-creator\ndescription: cria skills\n---\nCorpo')
    put('skills/skill-creator/LICENSE.txt', 'Apache License')
    put('skills/skill-creator/agents/grader.md', '# grader')
    put('skills/skill-creator/references/schemas.md', '# schemas')
    put('skills/skill-creator/assets/eval_review.html', '<html>')
    put('skills/skill-creator/eval-viewer/generate_review.py', 'print(1)')
    put('skills/skill-creator/scripts/run_eval.py', 'print(1)')
    put('skills/doc-coauthoring/SKILL.md', '---\nname: doc-coauthoring\ndescription: docs\n---\nCorpo')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'feat: skills'])
    const commit = repo.git(['rev-parse', 'HEAD']).trim()
    const catalogDir = tmp('ade-catalog-')
    const sourcesFile = path.join(tmp('ade-src-'), 'fontes.json')
    fs.writeFileSync(sourcesFile, JSON.stringify([{ ...anthropic, repo: repo.dir, commit }]), 'utf8')

    const { code, err } = await sync(['--sources', sourcesFile], { repoDir: projectWithConfig([]), catalogDir })

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(materialized(catalogDir).sort()).toEqual([
      'skills/skill-creator/LICENSE.txt',
      'skills/skill-creator/SKILL.md',
      'skills/skill-creator/agents/grader.md',
      'skills/skill-creator/references/schemas.md',
    ])
    const index = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8'))
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['skill-creator'])
    expect(index.entries[0].license).toBe('Apache-2.0')
  })

  // taste-skill fica fora da lista (escolha conservadora, sem mexer no validador fora do escopo): em nenhum commit
  // dele uma skill permitida tem `name` igual à pasta (skills/taste-skill → design-taste-frontend etc.); só brandkit e
  // imagegen-* batem, e essas são vetadas. Entrar com `paths: []` fixaria uma coleção que não contribui nada.
  test('C2.2 taste-skill não entra enquanto nenhuma skill permitida dela passa na validação estrutural', () => {
    expect(sources.map((s: { name: string }) => s.name)).not.toContain('taste-skill')
    expect(JSON.stringify(sources)).not.toContain('Leonxlnx/taste-skill')
  })

  // Com os clones reais em `~/.ade/catalog-repos/<nome>` (ou em ADE_CURATED_HOME), o arquivo curado inteiro
  // sincroniza nos commits fixados sem materializar nada executável. Sem os clones (sem rede) o teste é pulado.
  const curatedHome = process.env.ADE_CURATED_HOME || os.homedir()
  const syncable = sources
  test.skipIf(!clonesReady(curatedHome, syncable))('C2.1/C2.2 fontes curadas sincronizam nos commits fixados sem nada executável', async () => {
    const catalogDir = tmp('ade-catalog-')
    const sourcesFile = path.join(tmp('ade-src-'), 'fontes.json')
    fs.writeFileSync(sourcesFile, JSON.stringify(syncable), 'utf8')

    const { code, err } = await sync(['--sources', sourcesFile], { repoDir: projectWithConfig([]), catalogDir, homeDir: curatedHome })

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(materialized(catalogDir).filter((f) => EXECUTABLE.test(f))).toEqual([])
    const index = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8'))
    const expected = new Set(syncable.flatMap((s: { paths: string[] }) => s.paths.map(skillIdOf)))
    expect(new Set(index.entries.map((e: { id: string }) => e.id))).toEqual(expected)
    for (const entry of index.entries) {
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      expect(entry.community_signal).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(isBlockedLicense(entry.license)).toBe(false)
    }
  }, 120_000)

  test('C2.3 --sources monta o índice a partir do arquivo, não do config do projeto', async () => {
    const fromFile = upstreamWith(['tdd-curada', 'revisao'])
    const fromConfig = upstreamWith(['do-config'])
    const repoDir = projectWithConfig([{ name: 'config', repo: fromConfig.dir, commit: fromConfig.commit, license: 'MIT' }])
    const catalogDir = tmp('ade-catalog-')
    const sourcesFile = path.join(tmp('ade-src-'), 'fontes.json')
    fs.writeFileSync(sourcesFile, JSON.stringify([
      { name: 'curada', url: 'https://github.com/x/y', repo: fromFile.dir, commit: fromFile.commit, license: 'MIT', paths: ['skills/tdd-curada/**', 'skills/revisao/**'], reason: REASON, community_signal: SIGNAL },
    ]), 'utf8')

    const { code, err } = await sync(['--sources', sourcesFile], { repoDir, catalogDir })

    expect(err).toBe('')
    expect(code).toBe(0)
    const index = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8'))
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['revisao', 'tdd-curada'])
    for (const entry of index.entries) {
      expect(entry).toMatchObject({ source: 'curada', commit: fromFile.commit, reason: REASON, community_signal: SIGNAL })
    }
  })

  test('C2.3 fonte com repo ~/.ade/catalog-repos/<nome> lê o clone local da home', async () => {
    const homeDir = tmp('ade-home-')
    const up = upstreamWith(['tdd-curada'])
    fs.mkdirSync(path.join(homeDir, '.ade', 'catalog-repos'), { recursive: true })
    fs.renameSync(up.dir, path.join(homeDir, '.ade', 'catalog-repos', 'curada'))
    const repoDir = projectWithConfig([])
    const catalogDir = tmp('ade-catalog-')
    const sourcesFile = path.join(tmp('ade-src-'), 'fontes.json')
    fs.writeFileSync(sourcesFile, JSON.stringify([
      { name: 'curada', repo: '~/.ade/catalog-repos/curada', commit: up.commit, license: 'MIT', paths: ['skills/tdd-curada/**'], reason: REASON, community_signal: SIGNAL },
    ]), 'utf8')

    const { code, err } = await sync(['--sources', sourcesFile], { repoDir, catalogDir, homeDir })

    expect(err).toBe('')
    expect(code).toBe(0)
    const index = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8'))
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]).toMatchObject({ id: 'tdd-curada', source: 'curada', reason: REASON, community_signal: SIGNAL })
  })

  test('C2.4 arquivo de fontes ausente ou com JSON inválido falha em português, sem gravar índice', async () => {
    const repoDir = projectWithConfig([])
    const dir = tmp('ade-src-')
    const invalid = path.join(dir, 'invalido.json')
    fs.writeFileSync(invalid, '{ "sources": [', 'utf8')
    const notList = path.join(dir, 'objeto.json')
    fs.writeFileSync(notList, JSON.stringify({ nome: 'x' }), 'utf8')

    for (const [file, message] of [
      [path.join(dir, 'nao-existe.json'), 'Arquivo de fontes não encontrado'],
      [invalid, 'Arquivo de fontes com JSON inválido'],
      [notList, 'Arquivo de fontes deve conter uma lista de fontes'],
    ]) {
      const catalogDir = tmp('ade-catalog-')
      const { code, err } = await sync(['--sources', file], { repoDir, catalogDir })
      expect(code).toBe(4)
      expect(err).toContain(message)
      expect(fs.existsSync(path.join(catalogDir, 'index.json'))).toBe(false)
    }
  })

  test('C2.5 fonte com motivo mas licença proprietária é recusada pela checagem de licença', async () => {
    const up = upstreamWith(['segredo'], 'Proprietary')
    const repoDir = projectWithConfig([])
    const catalogDir = tmp('ade-catalog-')
    const sourcesFile = path.join(tmp('ade-src-'), 'fontes.json')
    fs.writeFileSync(sourcesFile, JSON.stringify([
      { name: 'prop', repo: up.dir, commit: up.commit, license: 'Proprietary', paths: ['skills/segredo/**'], reason: REASON, community_signal: SIGNAL },
    ]), 'utf8')

    const { code, err } = await sync(['--sources', sourcesFile], { repoDir, catalogDir })

    expect(code).toBe(4)
    expect(err).toBe("Fonte 'prop' com licença bloqueada: Proprietary\n")
    expect(fs.existsSync(path.join(catalogDir, 'index.json'))).toBe(false)
  })
})
