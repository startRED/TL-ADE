// node --test proto/rounds.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { AGY_NO_TESTS, agyPrompt, brokeGreen, climbLast, putBack, diffArgs, expandImports, importsOf, inheritedFiles, loosenedTimeouts, makerTurns, preexistingReds, truncated } from './rounds.mjs'

test('parte de correção herda os arquivos que a parte anterior já tinha alterado', () => {
  const stories = [{ id: 'R2', diff: 'diff --git a/src/lease/process-info.js b/src/lease/process-info.js\n', files: ['src\\adapters\\claude\\index.js'] }]
  assert.deepEqual(inheritedFiles({ fix_of: 'R2' }, stories), ['src/lease/process-info.js', 'src/adapters/claude/index.js'])
})

test('parte normal não herda nada', () => {
  assert.deepEqual(inheritedFiles({ id: 'R3' }, [{ id: 'R2', files: ['a.js'] }]), [])
  assert.deepEqual(inheritedFiles({ fix_of: 'sumiu' }, []), [])
})

const t = (name, status, message = '') => ({ name, status, message })

test('vermelha antiga é reconhecida mesmo misturada com vermelha nova', () => {
  const before = [t('a', 'failed'), t('b', 'passed'), t('c', 'passed')]
  const after = { tests: [t('a', 'failed'), t('b', 'failed', 'Test timed out in 5000ms'), t('c', 'passed')] }
  assert.deepEqual(preexistingReds(after, before), ['a'])
})

test('sem vermelha antiga devolve lista vazia', () => {
  assert.deepEqual(preexistingReds({ tests: [t('b', 'failed')] }, [t('b', 'passed')]), [])
  assert.deepEqual(preexistingReds({ tests: [] }, [t('a', 'failed')]), [])
  assert.deepEqual(preexistingReds(null, [t('a', 'failed')]), [])
})

test('sem ponto de partida não acusa nada', () => {
  assert.deepEqual(preexistingReds({ tests: [t('a', 'failed')] }, []), [])
})

test('erro de teto de turnos é corte, não defeito', () => {
  assert.equal(truncated({ subtype: 'error_max_turns', num_turns: 21 }, 20), true)
})

test('chamada que gastou o teto conta como corte mesmo sem o subtype (codex, agy)', () => {
  assert.equal(truncated({ num_turns: 30 }, 30), true)
  assert.equal(truncated({ num_turns: 12 }, 30), false)
})

test('chamada sem resultado ou sem teto não é corte', () => {
  assert.equal(truncated(null, 30), false)
  assert.equal(truncated({ num_turns: 0 }, 0), false)
})

test('escalar nunca dá menos turnos que a rodada normal', () => {
  assert.ok(makerTurns({ escalate: true }) >= makerTurns({}))
})

test('quem foi cortado repete com folga', () => {
  assert.ok(makerTurns({ wasTruncated: true }) > makerTurns({ escalate: true }))
})

test('afrouxar tempo limite em arquivo de prova é detectado; produção e remoção não', () => {
  const diff = [
    'diff --git a/tests/prepare.test.ts b/tests/prepare.test.ts',
    "+describe('prepare', { timeout: 30000 }, () => {",
    '-  const old = 1',
    'diff --git a/src/engine.js b/src/engine.js',
    '+  const timeoutMs = 900000',
    'diff --git a/tests/ok.test.ts b/tests/ok.test.ts',
    "+  assert.equal(a, b)",
  ].join('\n')
  const hits = loosenedTimeouts(diff, (f) => f.startsWith('tests/'))
  assert.equal(hits.length, 1)
  assert.match(hits[0], /^tests\/prepare\.test\.ts: describe/)
})

test('diff vazio não acusa nada', () => {
  assert.deepEqual(loosenedTimeouts('', () => true), [])
  assert.deepEqual(loosenedTimeouts(null, () => true), [])
})

test('diffArgs: sem commit-base o diff vai contra HEAD, para o que está no índice contar', () => {
  assert.deepEqual(diffArgs(null, ['.'], [':(exclude)proto']), ['diff', 'HEAD', '--', '.', ':(exclude)proto'])
})

test('diffArgs: com commit-base usa o commit-base', () => {
  assert.deepEqual(diffArgs('abc123', ['src/a.js']), ['diff', 'abc123', '--', 'src/a.js'])
})

test('brokeGreen: prova NOVA vermelha não é gravidade', () => {
  const before = { tests: [{ name: 'antiga', status: 'passed' }] }
  const after = { ok: false, tests: [{ name: 'antiga', status: 'passed' }, { name: 'nova', status: 'failed' }] }
  assert.equal(brokeGreen(after, before), false)
})

test('brokeGreen: quebrar prova que estava verde na largada é gravidade', () => {
  const before = { tests: [{ name: 'antiga', status: 'passed' }] }
  const after = { ok: false, tests: [{ name: 'antiga', status: 'failed' }] }
  assert.equal(brokeGreen(after, before), true)
})

test('brokeGreen: vermelha já vermelha na largada não conta', () => {
  const before = { tests: [{ name: 'antiga', status: 'failed' }] }
  const after = { ok: false, tests: [{ name: 'antiga', status: 'failed' }] }
  assert.equal(brokeGreen(after, before), false)
})

test('expandImports: linha @arquivo vira o conteúdo do arquivo', () => {
  assert.deepEqual(importsOf('@AGENTS.md\n'), ['AGENTS.md'])
  assert.equal(expandImports('@AGENTS.md', { 'AGENTS.md': '# regras' }), '# regras')
})

test('expandImports: import desconhecido fica como estava, e @ no meio da frase não é import', () => {
  assert.equal(expandImports('@sumiu.md', {}), '@sumiu.md')
  assert.deepEqual(importsOf('fale com @erick sobre isso'), [])
})

test('agyPrompt: tira as instruções de rodar provas e acrescenta a proibição', () => {
  const p = agyPrompt('Implemente X.\nAo rodar provas, rode só o arquivo.\nCONTRATO: src/a.js', 20, ['Ao rodar provas'])
  assert.equal(p.includes('Ao rodar provas'), false)
  assert.equal(p.includes('CONTRATO: src/a.js'), true)
  assert.equal(p.endsWith(AGY_NO_TESTS), true)
})

test('agyPrompt: o teto dito é o de verdade, em minutos', () => {
  assert.equal(agyPrompt('você tem no máximo 30 ações e a chamada é cortada nesse número.', 20), `você tem no máximo 20 minutos e a chamada é cortada nesse tempo.\n${AGY_NO_TESTS}`)
})

// Remendo feito por script Python escreveu "\b" como backspace (0x08) dentro de regex, duas vezes: `tsc\b` nunca casava.
test('server.mjs não tem caractere de controle perdido', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(src), false)
})

test('climbLast: a escada não sobe para degrau de reserva', () => {
  assert.equal(climbLast([{ model: 'sol' }, { model: 'opus' }, { model: 'flash', reserve: true }]), 1)
  assert.equal(climbLast([{ model: 'sol' }, { model: 'opus' }]), 1)
  assert.equal(climbLast([{ model: 'flash', reserve: true }]), 0)
  assert.equal(climbLast([]), 0)
})

test('putBack: recria a pasta que o git apagou e devolve o arquivo', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const os = await import('node:os'), path = await import('node:path')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'putback-'))
  const novo = path.join(dir, 'src', 'skills', 'catalog.js')
  const lost = await putBack([[novo, Buffer.from('export const x = 1\n')], [path.join(dir, 'fora.js'), null]])
  assert.deepEqual(lost, [])
  assert.equal(await readFile(novo, 'utf8'), 'export const x = 1\n')
  await rm(dir, { recursive: true, force: true })
})
