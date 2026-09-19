// Partes em paralelo por antecipação. Enquanto o laço roda a parte atual na pasta do projeto, as próximas partes independentes
// rodam em trilhos: cópias git isoladas (worktree) com o mesmo objeto de missão, mas pasta, parte atual e parada próprias.
// Na vez de cada uma, o diff do trilho é aplicado na pasta do projeto e o laço segue igual (commit, correção, modo noturno).
// Patch que não aplica ou suíte que quebra depois de aplicar: a parte é refeita do jeito normal. Qualidade igual à sequencial.
import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// uma pasta por instância (abrir.bat 2 roda outra ADE na 4318): a limpeza no boot de uma não apaga os trilhos da outra
export const LANES_DIR = path.join(os.tmpdir(), 'ade-lanes', process.env.ADE_PORT || '4317')
// dependências instaladas fora do git que o trilho enxerga por junction; apagar o trilho remove só o link (conferido no Windows)
const DEP_DIRS = ['node_modules', '.venv', 'vendor', '.ade-attachments']

// Contratos conflitam quando o prefixo fixo (antes do primeiro curinga) de um é prefixo do outro. Conservador de propósito:
// 'src/a' contra 'src/ab.js' conta como conflito; glob que começa com curinga conflita com tudo.
const fixed = (g) => String(g).replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?[{]/)[0]
export function overlaps(a, b) { return a.some((x) => b.some((y) => { const p = fixed(x), q = fixed(y); return !p || !q || p.startsWith(q) || q.startsWith(p) })) }
const paths = (st) => [...(st.scope_paths || []), st.test_file].filter(Boolean)

// Até max partes à frente de i que podem rodar já: na fila, dependências prontas, contrato sem arquivo em comum com as partes
// em andamento (busy) nem entre si. Parte de correção e parte sem contrato nunca vão para trilho.
export function laneCandidates(stories, i, busy, max) {
  const done = (id) => stories.some((x) => x.state === 'done' && (x.id === id || x.fix_of === id))
  const out = []
  for (let k = i + 1; k < stories.length && out.length < max; k++) {
    const st = stories[k]
    if (st.state !== 'queued' || st.lane || st.fix_of || !(st.scope_paths || []).length) continue
    if (!(st.depends_on || []).every(done)) continue
    if ([...busy, ...out].some((o) => overlaps(paths(st), paths(o)))) continue
    out.push(st)
  }
  return out
}

// Trilho: worktree do HEAD atual em pasta temporária, com junction das dependências instaladas na pasta de cada suíte.
export async function createLane(run, project, id) {
  const root = project.root || project.dir, rel = path.relative(root, project.dir)
  await mkdir(LANES_DIR, { recursive: true })
  const dir = path.join(LANES_DIR, `${path.basename(root).replace(/\W+/g, '_').slice(0, 20)}-${id}-${Date.now().toString(36)}`)
  const r = await run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: root })
  if (r.code !== 0) throw new Error(`git worktree add falhou: ${(r.err || r.out).trim().split('\n')[0]}`)
  const base = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).out.trim()
  const projectDir = path.join(dir, rel), links = []
  for (const cwd of new Set(['', ...(project.suites || []).map((s) => s.cwd)])) {
    for (const d of DEP_DIRS) {
      const src = path.join(project.dir, cwd, d), dst = path.join(projectDir, cwd, d)
      if (existsSync(src) && !existsSync(dst)) { await symlink(src, dst, 'junction'); links.push(path.join(rel, cwd, d).split(path.sep).join('/')) }
    }
  }
  return { dir, root, base, projectDir, links }
}

// Tudo o que o trilho mudou desde o começo dele (arquivo novo e binário incluídos; commit indevido de quem escreve também).
// Link já ignorado pelo .gitignore fica fora sozinho (excluí-lo por pathspec faz o git add sair com erro); o não ignorado sai por pathspec.
const gitError = (r) => (r.err || r.out).trim().split('\n').filter((l) => l && !/^warning:/i.test(l)).pop() || `código ${r.code}`
export async function lanePatch(run, lane) {
  const ex = []
  for (const l of lane.links) if ((await run('git', ['check-ignore', '-q', l], { cwd: lane.dir })).code !== 0) ex.push(`:(exclude)${l}`)
  const a = await run('git', ['add', '-A', '--', '.', ...ex], { cwd: lane.dir })
  if (a.code !== 0) throw new Error(`git add do trilho falhou: ${gitError(a)}`)
  const d = await run('git', ['diff', '--cached', '--binary', lane.base, '--', '.', ...ex], { cwd: lane.dir })
  if (d.code !== 0) throw new Error(`diff do trilho falhou: ${gitError(d)}`)
  return d.out
}

// git apply é tudo ou nada; reverse desfaz exatamente o que foi aplicado.
export async function applyPatch(run, root, patch, { reverse = false } = {}) {
  if (!patch.trim()) return { ok: true }
  const file = path.join(LANES_DIR, `patch-${process.pid}-${Date.now().toString(36)}.diff`)
  await mkdir(LANES_DIR, { recursive: true }); await writeFile(file, patch)
  try {
    const r = await run('git', ['apply', '--binary', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), file], { cwd: root })
    return { ok: r.code === 0, error: (r.err || r.out).trim().split('\n')[0] }
  } finally { await rm(file, { force: true }).catch(() => {}) }
}

export async function removeLane(run, lane) {
  await rm(lane.dir, { recursive: true, force: true }).catch(() => {}) // junction: sai só o link
  await run('git', ['worktree', 'prune'], { cwd: lane.root })
}

// Motor do trilho: o mesmo motor (log, cota, filhos para a pausa matar), com pasta, fase e parte atual próprias. A missão é a
// mesma; só `current` (a parte do trilho, achada por identidade: correção inserida no meio não desloca), `state`/`reason`
// (parada do trilho não para a missão) e `pause_requested` (abortar só o trilho) são locais.
export function laneEngine(parent, st) {
  const local = { project: null, phase: null, state: null, reason: null, aborted: false, kids: new Set() }
  const mission = new Proxy(parent.mission, {
    get(t, k) {
      if (k === 'current') return t.stories.indexOf(st)
      if (k === 'state' || k === 'reason') return local[k] ?? t[k]
      if (k === 'pause_requested') return local.aborted || t.pause_requested
      return t[k]
    },
    set(t, k, v) { if (k === 'state' || k === 'reason') local[k] = v; else if (k !== 'current') t[k] = v; return true },
  })
  const eng = new Proxy(parent, {
    get(t, k) { if (k === 'project' || k === 'phase') return local[k]; if (k === 'mission') return mission; if (k === 'parent') return t; if (k === 'laneKids') return local.kids; return t[k] },
    set(t, k, v) { if (k === 'project' || k === 'phase') local[k] = v; else if (k !== 'mission') t[k] = v; return true },
  })
  return { eng, local }
}
