// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AdeError } from '../journal/errors.js'

/** @param {string} filePath @returns {{format_version: number, projects: Array<{id: string, name: string, path: string, registered_at: string}>}} */
function readProjectsFile(filePath) {
  if (!fs.existsSync(filePath)) return { format_version: 1, projects: [] }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new AdeError('projects_invalid', `Registro de projetos inválido em ${filePath}`, 2, { cause: err })
  }
  if (
    doc?.format_version !== 1 ||
    !Array.isArray(doc.projects) ||
    doc.projects.some((/** @type {any} */ item) =>
      !item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
      typeof item.path !== 'string' || typeof item.registered_at !== 'string')
  ) {
    throw new AdeError('projects_invalid', `Formato do registro de projetos inválido em ${filePath}`, 2)
  }
  return doc
}

/**
 * Retorna o caminho do arquivo de registro de projetos do usuário (~/.ade/projects.json).
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function getProjectsFilePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.ade', 'projects.json')
}

/**
 * Lista todos os projetos registrados na máquina do operador.
 *
 * @param {{ homeDir?: string, repoDir?: string }} [options]
 * @returns {Array<{ id: string, name: string, path: string, registered_at: string }>}
 */
export function listProjects({ homeDir = os.homedir(), repoDir } = {}) {
  const filePath = getProjectsFilePath(homeDir)
  const projects = readProjectsFile(filePath).projects

  // Se repoDir fornecido e não estiver na lista, inclui temporariamente
  if (repoDir) {
    const resolved = path.resolve(repoDir)
    const exists = projects.some((p) => path.resolve(p.path) === resolved)
    if (!exists) {
      projects.push({
        id: path.basename(resolved),
        name: path.basename(resolved),
        path: resolved,
        registered_at: new Date().toISOString(),
      })
    }
  }

  return projects
}

/**
 * Registra idempotentemente um repositório como projeto conhecido da TL-ADE.
 *
 * @param {{ repoDir?: string, homeDir?: string }} [options]
 * @returns {{ id: string, name: string, path: string, registered_at: string }}
 */
export function registerProject({ repoDir = process.cwd(), homeDir = os.homedir() } = {}) {
  const resolvedRepo = path.resolve(repoDir)
  const filePath = getProjectsFilePath(homeDir)
  const adeDir = path.dirname(filePath)
  fs.mkdirSync(adeDir, { recursive: true })

  const doc = readProjectsFile(filePath)

  const existingIdx = doc.projects.findIndex((p) => path.resolve(p.path) === resolvedRepo)
  const id = path.basename(resolvedRepo)
  const entry = {
    id,
    name: id,
    path: resolvedRepo,
    registered_at: existingIdx >= 0 ? doc.projects[existingIdx].registered_at : new Date().toISOString(),
  }

  if (existingIdx >= 0) {
    doc.projects[existingIdx] = entry
  } else {
    doc.projects.push(entry)
  }

  const tmpPath = `${filePath}.tmp.${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)

  return entry
}
