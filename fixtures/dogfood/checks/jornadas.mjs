import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './_caso.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FAKE_CLI = path.join(ROOT, 'src/adapters/fake/cli.js')
const REMOTE = process.env.ADE_DOGFOOD_REMOTE
const RUN = process.env.ADE_DOGFOOD_RUN

// Entrega só em bare temporário e só pelo transporte file: sem isso a jornada não roda.
assert.ok(REMOTE && path.resolve(REMOTE).startsWith(path.resolve(os.tmpdir())), 'ADE_DOGFOOD_REMOTE precisa ser bare temporário')
assert.equal(process.env.GIT_ALLOW_PROTOCOL, 'file')

function run(cmd, args, cwd, env = {}) {
  return spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 24, shell: false })
}

function fakeCli(scenarioDir, cwd) {
  return run(process.execPath, [FAKE_CLI], cwd, { ADE_FAKE_SCENARIO: scenarioDir, ADE_FAKE_RESULT_FILE: path.join(cwd, 'result.json') })
}

async function inTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-dogfood-jornada-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function git(args, cwd) {
  const r = run('git', ['-c', 'user.name=ADE Dogfood', '-c', 'user.email=dogfood@test.local', '-c', 'commit.gpgsign=false', ...args], cwd)
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

function commitWork(dir) {
  git(['init', '-b', 'main', dir], dir)
  writeFileSync(path.join(dir, 'entrega.txt'), `execução ${RUN}\n`)
  git(['add', 'entrega.txt'], dir)
  git(['commit', '-m', 'dogfood: entrega'], dir)
}

await runCase({
  async 'maker-falso-edita-worktree'() {
    await inTmp((dir) => {
      writeFileSync(path.join(dir, 'maker.json'), JSON.stringify([{ files: { 'a.txt': 'oi' }, stdout: 'feito' }]))
      const r = fakeCli(dir, dir)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'oi')
    })
  },
  async 'maker-falso-transitorio-depois-ok'() {
    await inTmp((dir) => {
      cpSync(path.join(ROOT, 'fixtures/scenarios/transient-then-ok'), dir, { recursive: true })
      assert.notEqual(fakeCli(dir, dir).status, 0)
      assert.equal(fakeCli(dir, dir).status, 0)
    })
  },
  async 'entrega-no-bare-temporario'() {
    await inTmp((dir) => {
      commitWork(dir)
      const branch = `dogfood/entrega-${RUN}`
      git(['push', '--force', REMOTE, `HEAD:refs/heads/${branch}`], dir)
      const head = git(['rev-parse', 'HEAD'], dir).trim()
      assert.ok(git(['ls-remote', REMOTE, branch], dir).startsWith(head))
    })
  },
  async 'entrega-sem-rede-recusada'() {
    await inTmp((dir) => {
      commitWork(dir)
      const r = run('git', ['push', 'https://example.invalid/r.git', 'HEAD:refs/heads/main'], dir)
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /transport 'https' not allowed/)
      assert.equal(existsSync(path.join(dir, '.git', 'FETCH_HEAD')), false)
    })
  },
})
