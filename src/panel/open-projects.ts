import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { acquireServeLease } from './serve-lease.ts'
import { rebuildProjection } from './sqlite-index.ts'

export type ActivityKind = 'mission' | 'chat'

export interface OpenProject {
  id: string
  name: string
  path: string
  lease: { release: () => void }
  indexPath: string
  activities: Set<symbol>
}

/**
 * Recusa na fronteira um caminho que não existe ou não é raiz de repositório git.
 */
export function assertProjectPath(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new AdeError('project_path_invalid', 'Caminho da pasta inválido: informe o caminho de um repositório git.', 2)
  }
  const resolved = path.resolve(candidate)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new AdeError('project_path_missing', `A pasta ${resolved} não existe.`, 2)
  }
  // Um .git vazio ou quebrado não basta: o git precisa reconhecer a pasta como raiz do repositório.
  const git = spawnSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { shell: false, encoding: 'utf8', maxBuffer: 1 << 20 })
  if (git.error) throw git.error
  if (git.status !== 0 || fs.realpathSync(git.stdout.trim()) !== fs.realpathSync(resolved)) {
    throw new AdeError('project_not_git', `A pasta ${resolved} não é um repositório git.`, 2)
  }
  return resolved
}

/**
 * Conjunto de projetos abertos por um servidor: cada um com o próprio serve-lease e o registro
 * das atividades em execução (missão ou turno de chat), que impede o fechamento enquanto houver alguma.
 */
export function createOpenProjects() {
  const projects = new Map<string, OpenProject>()
  let activeId: string | null = null

  function get(id: string): OpenProject {
    const project = projects.get(id)
    if (!project) throw new AdeError('project_not_found', `Projeto ${id} não está aberto.`, 2)
    return project
  }

  function uniqueId(name: string): string {
    let id = name
    for (let n = 2; projects.has(id); n++) id = `${name}-${n}`
    return id
  }

  return {
    /** Abre (ou devolve, se já aberto) o projeto; o primeiro aberto vira o ativo. */
    async open(repoDir: string): Promise<OpenProject> {
      const resolved = path.resolve(repoDir)
      const existing = [...projects.values()].find((p) => p.path === resolved)
      if (existing) return existing

      const lease = acquireServeLease({ repoDir: resolved })
      const indexPath = path.join(resolved, '.ade', 'index.sqlite')
      try {
        // Missões rodadas com o painel fechado (ou vistas pelo vigia errado) não estão no índice: refaz ao abrir.
        // Com índice anterior, journal ruim não impede abrir: a reconstrução preserva o índice válido e o erro
        // reaparece no próximo evento do vigia.
        if (!fs.existsSync(indexPath)) await rebuildProjection({ repoDir: resolved, indexPath })
        else await rebuildProjection({ repoDir: resolved, indexPath }).catch(() => undefined)
      } catch (err) {
        lease.release()
        throw err
      }
      // Pedidos simultâneos para a mesma pasta: o segundo já esbarrou no lease acima.
      const name = path.basename(resolved)
      const project: OpenProject = { id: uniqueId(name), name, path: resolved, lease, indexPath, activities: new Set() }
      projects.set(project.id, project)
      activeId ??= project.id
      return project
    },

    close(id: string): void {
      const project = get(id)
      if (project.activities.size > 0) {
        throw new AdeError('project_busy', `O projeto ${project.name} tem missão ou chat em execução; espere terminar antes de fechar.`, 5)
      }
      project.lease.release()
      projects.delete(id)
      if (activeId === id) activeId = projects.keys().next().value ?? null
    },

    select(id: string): void {
      activeId = get(id).id
    },

    get,

    get activeId(): string | null {
      return activeId
    },

    list(): Array<{ id: string; name: string; path: string; active: boolean }> {
      return [...projects.values()].map((p) => ({ id: p.id, name: p.name, path: p.path, active: p.id === activeId }))
    },

    /** Registra uma atividade em execução; release() é idempotente. */
    beginActivity(projectId: string, kind: ActivityKind): () => void {
      const token = Symbol(kind)
      get(projectId).activities.add(token)
      return () => {
        projects.get(projectId)?.activities.delete(token)
      }
    },

    /** Há atividade em execução no projeto (de qualquer tipo, ou só do tipo pedido)? */
    hasActivity(projectId: string, kind?: ActivityKind): boolean {
      return [...(projects.get(projectId)?.activities ?? [])].some((token) => !kind || token.description === kind)
    },

    closeAll(): void {
      for (const project of projects.values()) project.lease.release()
      projects.clear()
      activeId = null
    },
  }
}

export type OpenProjects = ReturnType<typeof createOpenProjects>
