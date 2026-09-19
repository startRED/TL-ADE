// node --test proto/lanes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { overlaps, laneCandidates, laneEngine, createLane, lanePatch, applyPatch, removeLane } from './lanes.mjs'

const run = async (cmd, args, { cwd } = {}) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' } }
// autocrlf do Windows: o git apply grava CRLF como o checkout; compara o conteúdo
const text = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' })

test('contratos: mesmo arquivo, pasta que contém arquivo e glob amplo conflitam; arquivos diferentes não', () => {
  assert.equal(overlaps(['src/a.js'], ['src/b.js']), false)
  assert.equal(overlaps(['src/a.js'], ['./src/a.js']), true)
  assert.equal(overlaps(['src/'], ['src/b.js']), true)
  assert.equal(overlaps(['src/**/*.js'], ['src/deep/x.js']), true)
  assert.equal(overlaps(['**/*.ts'], ['docs/x.md']), true)
})

test('candidatos: só na fila, com dependência pronta e sem arquivo em comum com quem está rodando', () => {
  const s = (id, scope, extra = {}) => ({ id, state: 'queued', scope_paths: scope, test_file: `t/${id}.test.js`, depends_on: [], ...extra })
  const stories = [
    s('s1', ['src/a.js'], { state: 'running' }),
    s('s2', ['src/b.js']),
    s('s3', ['src/a.js']), // conflita com s1
    s('s4', ['src/c.js'], { depends_on: ['s1'] }), // s1 não terminou
    s('s5', ['src/b.js', 'src/d.js']), // conflita com s2, já escolhida
    s('s6', ['src/e.js'], { fix_of: 's2' }), // correção nunca vai para trilho
    s('s7', ['src/f.js']),
  ]
  assert.deepEqual(laneCandidates(stories, 0, [stories[0]], 2).map((x) => x.id), ['s2', 's7'])
  assert.deepEqual(laneCandidates(stories, 0, [stories[0]], 1).map((x) => x.id), ['s2'])
})

test('motor do trilho: parte atual por identidade; parada e fase locais; o resto é da missão', () => {
  const a = { id: 's1' }, b = { id: 's2' }
  const parent = { mission: { stories: [a, b], current: 0, state: 'running', reason: null, cost: { usd: 1 } }, log: [], phase: 'fix' }
  const { eng, local } = laneEngine(parent, b)
  assert.equal(eng.mission.current, 1)
  parent.mission.stories.splice(1, 0, { id: 's1f' }) // correção inserida antes do trilho
  assert.equal(eng.mission.current, 2)
  eng.mission.state = 'awaiting_operator'; eng.mission.reason = 'review_changes'; eng.phase = 'checker'
  assert.equal(parent.mission.state, 'running'); assert.equal(parent.phase, 'fix'); assert.equal(local.reason, 'review_changes')
  eng.mission.cost.usd += 2; eng.log.push('x')
  assert.equal(parent.mission.cost.usd, 3); assert.deepEqual(parent.log, ['x'])
  local.aborted = true
  assert.equal(eng.mission.pause_requested, true); assert.equal(parent.mission.pause_requested, undefined)
})

test('trilho: cópia isolada com dependência por junction; patch leva arquivo novo e alterado; apagar não toca a dependência real', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ade-lane-repo-'))
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  writeFileSync(path.join(repo, 'a.txt'), 'um\n'); writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(path.join(repo, 'node_modules', 'pkg', 'i.js'), 'x')
  const lane = await createLane(run, { dir: repo, root: repo, suites: [{ cwd: '' }] }, 's9')
  assert.equal(readFileSync(path.join(lane.projectDir, 'node_modules', 'pkg', 'i.js'), 'utf8'), 'x')
  writeFileSync(path.join(lane.projectDir, 'a.txt'), 'um\ndois\n'); writeFileSync(path.join(lane.projectDir, 'novo.txt'), 'novo\n')
  const patch = await lanePatch(run, lane)
  assert.match(patch, /novo\.txt/); assert.doesNotMatch(patch, /node_modules/)
  writeFileSync(path.join(repo, 'outro.txt'), 'commit do projeto no meio\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'meio')
  assert.equal((await applyPatch(run, repo, patch)).ok, true)
  assert.equal(text(path.join(repo, 'a.txt')), 'um\ndois\n'); assert.equal(existsSync(path.join(repo, 'novo.txt')), true)
  assert.equal((await applyPatch(run, repo, patch, { reverse: true })).ok, true)
  assert.equal(text(path.join(repo, 'a.txt')), 'um\n'); assert.equal(existsSync(path.join(repo, 'novo.txt')), false)
  await removeLane(run, lane)
  assert.equal(existsSync(lane.dir), false); assert.equal(existsSync(path.join(repo, 'node_modules', 'pkg', 'i.js')), true)
  assert.doesNotMatch(git(repo, 'worktree', 'list').stdout, /ade-lanes/)
})

test('patch em conflito não aplica nada', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ade-lane-conf-'))
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  writeFileSync(path.join(repo, 'a.txt'), 'um\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  const lane = await createLane(run, { dir: repo, root: repo, suites: [] }, 'c1')
  writeFileSync(path.join(lane.projectDir, 'a.txt'), 'trilho\n'); writeFileSync(path.join(lane.projectDir, 'b.txt'), 'b\n')
  const patch = await lanePatch(run, lane)
  writeFileSync(path.join(repo, 'a.txt'), 'projeto\n')
  const r = await applyPatch(run, repo, patch)
  assert.equal(r.ok, false); assert.equal(existsSync(path.join(repo, 'b.txt')), false)
  await removeLane(run, lane)
})
