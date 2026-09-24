import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { makeRepo, removeRepo } from './helpers/git-repo.ts'
import { makeTmpDir } from './helpers/tmp-dir.ts'

// A fonte do catálogo declara o motivo da escolha (`reason`) e o sinal de uso da comunidade
// (`community_signal`); o sync copia os dois para cada entrada e `ade catalog inspect` mostra.

const REASON = 'Formato canônico de TDD, revisado e sem scripts'
const SIGNAL = '12k estrelas no GitHub, citada em awesome-claude-skills'

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

/** Repositório git local com as skills dadas em skills/<nome>/SKILL.md. */
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

async function inspect(catalogDir: string, id: string) {
  const { main } = await import('../src/cli/catalog.ts')
  const stdout = sink()
  const stderr = sink()
  const code = await main(['inspect', id, '--catalog-dir', catalogDir], { stdout, stderr, catalogDir })
  return { code, out: stdout.text, err: stderr.text }
}

describe('proveniência da fonte no índice do catálogo', () => {
  test('C1.1 cada skill da fonte leva o motivo e o sinal da comunidade para o índice', async () => {
    const { syncCatalog } = await import('../src/skills/catalog.ts')
    const catalogDir = tmp('ade-catalog-')
    const up = upstreamWith(['tdd', 'code-review'])
    const source = { name: 'mattpocock', repo: up.dir, commit: up.commit, license: 'MIT', paths: ['skills/**'], reason: REASON, community_signal: SIGNAL }

    const result = await syncCatalog({
      config: {
        sources: [source],
        trust_default: 'allowlisted',
      },
      catalogDir,
    })

    expect(result.entries.map((e) => e.id)).toEqual(['code-review', 'tdd'])
    for (const entry of result.entries) {
      expect(entry.reason).toBe(REASON)
      expect(entry.community_signal).toBe(SIGNAL)
    }
    const index = JSON.parse(fs.readFileSync(result.indexPath, 'utf8'))
    for (const entry of index.entries) {
      expect(entry).toMatchObject({ source: 'mattpocock', commit: up.commit, license: 'MIT', reason: REASON, community_signal: SIGNAL })
    }
  })

  test('C1.2 inspect mostra origem, commit, licença, motivo da escolha e sinal da comunidade', async () => {
    const { syncCatalog } = await import('../src/skills/catalog.ts')
    const catalogDir = tmp('ade-catalog-')
    const up = upstreamWith(['tdd'])
    const source = { name: 'mattpocock', repo: up.dir, commit: up.commit, license: 'MIT', reason: REASON, community_signal: SIGNAL }
    await syncCatalog({
      config: {
        sources: [source],
        trust_default: 'allowlisted',
      },
      catalogDir,
    })

    const { code, out, err } = await inspect(catalogDir, 'tdd')

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('Origem: mattpocock')
    expect(out).toContain(`Commit: ${up.commit}`)
    expect(out).toContain('Licença: MIT')
    expect(out).toContain(`Motivo da escolha: ${REASON}`)
    expect(out).toContain(`Sinal da comunidade: ${SIGNAL}`)
  })

  test('C1.3 fonte sem motivo nem sinal sincroniza como antes e inspect não inventa esses dados', async () => {
    const { syncCatalog } = await import('../src/skills/catalog.ts')
    const catalogDir = tmp('ade-catalog-')
    const up = upstreamWith(['tdd'])
    const result = await syncCatalog({
      config: { sources: [{ name: 'simples', repo: up.dir, commit: up.commit, license: 'MIT' }], trust_default: 'allowlisted' },
      catalogDir,
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ id: 'tdd', source: 'simples', commit: up.commit, license: 'MIT', trust: 'allowlisted' })
    expect(result.entries[0]).not.toHaveProperty('reason')
    expect(result.entries[0]).not.toHaveProperty('community_signal')

    const { code, out } = await inspect(catalogDir, 'tdd')
    expect(code).toBe(0)
    expect(out).toContain('Origem: simples')
    expect(out).toContain(`Commit: ${up.commit}`)
    expect(out).toContain('Licença: MIT')
    expect(out).not.toMatch(/undefined|null/)
    expect(out).not.toContain('Motivo da escolha:')
    expect(out).not.toContain('Sinal da comunidade:')
  })

  test('C1.4 motivo declarado não libera licença proprietária nem commit abreviado', async () => {
    const { syncCatalog } = await import('../src/skills/catalog.ts')
    const { main } = await import('../src/cli/catalog.ts')
    const catalogDir = tmp('ade-catalog-')
    const up = upstreamWith(['segredo'], 'Proprietary')
    const extra = { reason: REASON, community_signal: SIGNAL }

    const proprietary = { name: 'prop', repo: up.dir, commit: up.commit, license: 'Proprietary', ...extra }
    await expect(syncCatalog({ config: { sources: [proprietary] }, catalogDir })).rejects.toMatchObject({
      code: 'skill_license_blocked',
      exitCode: 4,
      message: "Fonte 'prop' com licença bloqueada: Proprietary",
    })

    const short = { name: 'curto', repo: up.dir, commit: up.commit.slice(0, 7), license: 'MIT', ...extra }
    await expect(syncCatalog({ config: { sources: [short] }, catalogDir })).rejects.toMatchObject({
      code: 'catalog_source_not_pinned',
      exitCode: 4,
      message: "Fonte 'curto' sem hash completo de commit",
    })

    // Pelo comando: mesma mensagem e código de saída 4, e nada entra no índice.
    for (const [source, message] of [
      [proprietary, "Fonte 'prop' com licença bloqueada: Proprietary"],
      [short, "Fonte 'curto' sem hash completo de commit"],
    ] as const) {
      const repoDir = tmp('ade-repo-')
      fs.mkdirSync(path.join(repoDir, '.ade'), { recursive: true })
      fs.writeFileSync(path.join(repoDir, '.ade', 'config.json'), JSON.stringify({ catalog: { sources: [source] } }), 'utf8')
      const stdout = sink()
      const stderr = sink()
      const code = await main(['sync'], { stdout, stderr, repoDir, catalogDir })
      expect(code).toBe(4)
      expect(stderr.text).toBe(`${message}\n`)
      expect(fs.existsSync(path.join(catalogDir, 'index.json'))).toBe(false)
    }
  })
})
