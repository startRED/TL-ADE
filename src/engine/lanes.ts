import os from 'node:os'
import path from 'node:path'
import { resolveRealPathAllowingMissing } from '../contain/canary.ts'
import { digest16 } from '../journal/canonical.ts'
import { AdeError } from '../journal/errors.ts'
import { getStoryDeps, isBlocked, isCompleted, validateGraph } from './schedule.ts'

type LaneStory = { id: string; depends_on?: string[]; contract?: Record<string, any> }

// Prefixo fixo do glob (antes do primeiro curinga). Glob que começa com curinga tem prefixo vazio e conflita com tudo.
// Em maiúsculas em qualquer sistema: no Windows e no macOS src/Foo.ts e src/foo.ts são o mesmo arquivo, e maiúsculas
// (não minúsculas) igualam também ı e ſ a i e s, como a comparação do Windows.
const fixedPrefix = (glob: string) => String(glob).replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?[{]/)[0].toUpperCase()

/**
 * Escopos conflitam quando o prefixo fixo de um é prefixo do outro. Conservador de propósito:
 * 'src/a' contra 'src/ab.ts' conta como conflito, e 'src/Foo.ts' contra 'src/foo.ts' também, até no Linux.
 */
export function overlaps(pathsA: string[], pathsB: string[]): boolean {
  return pathsA.some((a) => pathsB.some((b) => {
    const p = fixedPrefix(a)
    const q = fixedPrefix(b)
    return !p || !q || p.startsWith(q) || q.startsWith(p)
  }))
}

// O arquivo de prova de cada eval fica dentro de scope_paths (plan-load recusa o contrário): mesmo test_file é sobreposição.
const scopeOf = (story: LaneStory): string[] => story.contract?.guardrails?.scope_paths ?? []

// Parte sem escopo declarado não sabe o que toca: nunca divide trilho com outra.
const conflicts = (a: LaneStory, b: LaneStory) => {
  const pa = scopeOf(a)
  const pb = scopeOf(b)
  return !pa.length || !pb.length || overlaps(pa, pb)
}

/**
 * Partes prontas para rodar já, em ordem de id, até `max` trilhos contando os ocupados (`busy`): dependências
 * concluídas, sem escopo em comum com os trilhos em andamento nem entre si. Com `max` 1 e nada ocupado escolhe
 * a mesma parte que `nextReady`.
 */
export function laneCandidates<S extends LaneStory>(stories: S[], states: Record<string, any>, busy: LaneStory[], max: number): S[] {
  if (!Number.isInteger(max) || max < 1) throw new AdeError('invalid_lane_limit', `limite de trilhos inválido: ${max}`, 4)
  validateGraph(stories, new Set(Object.keys(states).filter((k) => isCompleted(states[k]))))
  const busyIds = new Set(busy.map((s) => s.id))
  const out: S[] = []
  for (const story of [...stories].sort((a, b) => a.id.localeCompare(b.id))) {
    if (busy.length + out.length >= max) break
    if (busyIds.has(story.id) || isCompleted(states[story.id]) || isBlocked(states[story.id])) continue
    if (!getStoryDeps(story).every((dep) => isCompleted(states[dep]))) continue
    if ([...busy, ...out].some((other) => conflicts(story, other))) continue
    out.push(story)
  }
  return out
}

/**
 * Limite de trilhos simultâneos (`ADE_MAX_LANES`); ausente vale 1, o N=1 do ADR 0014.
 */
export function laneLimit(env: Record<string, string | undefined> = {}): number {
  const raw = env.ADE_MAX_LANES
  if (raw === undefined) return 1
  if (!/^[1-9]\d*$/.test(raw)) throw new AdeError('invalid_lane_limit', `ADE_MAX_LANES inválido: ${JSON.stringify(raw)}`, 4)
  return Number(raw)
}

/**
 * Pasta das worktrees dos trilhos: fora da raiz do projeto, para o dev server que serve a raiz (ou uma
 * pasta dentro dela) não enxergar cópias do projeto. Uma por projeto, sob ADE_HOME como o resto do estado local.
 */
export function lanesDir(repoDir: string, env: Record<string, string | undefined> = {}): string {
  const root = path.resolve(repoDir)
  const dir = path.join(path.resolve(env.ADE_HOME ?? os.homedir()), '.ade', 'lanes', digest16(root))
  // Confere também os caminhos reais: ADE_HOME (ou ancestral) que é link/junction para dentro do projeto engana o texto.
  const pairs = [[root, dir], [resolveRealPathAllowingMissing(root), resolveRealPathAllowingMissing(dir)]]
  for (const [r, d] of pairs) {
    const rel = path.relative(r, d)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new AdeError('lanes_dir_inside_project', `pasta de trilhos dentro do projeto: ${d}`, 4)
    }
  }
  return dir
}
