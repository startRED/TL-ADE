import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { writeJsonAtomic } from '../mission/plan-lifecycle.ts'
import { DEFAULT_MISSION_OPTIONS, validateMissionOptions, type MissionOptions } from '../mission/options.ts'
import { inspectCatalog, listCatalog, loadApprovedSkills } from '../skills/catalog.ts'
import { selectStorySkills } from '../skills/select.ts'

export interface SkillSummary { id: string; domain: string | null; trust: string; source: string; summary: string }

const optionsPath = (repoDir: string) => path.join(repoDir, '.ade', 'options.json')
const pluginsPath = (repoDir: string) => path.join(repoDir, '.ade', 'plugins.json')

/** Opções do projeto; sem o arquivo, as padrão. Arquivo inválido é erro, não padrão calado. */
export function readProjectOptions(repoDir: string): MissionOptions {
  const file = optionsPath(repoDir)
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_MISSION_OPTIONS)
  return validateMissionOptions(JSON.parse(fs.readFileSync(file, 'utf8')))
}

export function saveProjectOptions(repoDir: string, body: unknown): MissionOptions {
  const options = validateMissionOptions(body)
  writeJsonAtomic(optionsPath(repoDir), options)
  return options
}

/** Índice do catálogo sincronizado; sem sincronização, catálogo vazio. */
function readIndex(catalogDir: string): { entries: any[] } {
  const file = path.join(catalogDir, 'index.json')
  if (!fs.existsSync(file)) return { entries: [] }
  const index = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(index?.entries)) throw new AdeError('catalog_invalid', `${file} não tem a lista entries.`, 2)
  return index
}

export function listSkills(catalogDir: string, filters: { domain?: string; trust?: string; source?: string } = {}): SkillSummary[] {
  return listCatalog({ index: readIndex(catalogDir), ...filters }).map((e) => ({
    id: e.id,
    domain: e.domains?.[0] ?? null,
    trust: e.trust,
    source: e.source,
    summary: e.description ?? '',
  }))
}

export function readSkill(catalogDir: string, id: string): { id: string; body: string } {
  const { entry, body } = inspectCatalog({ index: readIndex(catalogDir), id, includeBody: true, catalogDir })
  return { id: entry.id, body: body ?? '' }
}

/** Fontes desligadas no projeto (plugins são as fontes do catálogo). */
function disabledSources(repoDir: string): string[] {
  const file = pluginsPath(repoDir)
  if (!fs.existsSync(file)) return []
  const disabled = JSON.parse(fs.readFileSync(file, 'utf8'))?.disabled
  if (!Array.isArray(disabled) || disabled.some((s) => typeof s !== 'string')) throw new AdeError('plugins_invalidos', `${file} deve ter a lista disabled.`, 2)
  return disabled
}

export function listPlugins(catalogDir: string, repoDir: string): Array<{ source: string; enabled: boolean; skills: number }> {
  const off = new Set(disabledSources(repoDir))
  const counts = new Map<string, number>()
  for (const skill of listSkills(catalogDir)) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([source, skills]) => ({ source, enabled: !off.has(source), skills }))
}

export function setPlugin(catalogDir: string, repoDir: string, body: unknown): void {
  const { source, enabled } = (body ?? {}) as { source?: unknown; enabled?: unknown }
  if (typeof enabled !== 'boolean') throw new AdeError('plugin_invalido', 'enabled deve ser verdadeiro ou falso.', 2)
  if (typeof source !== 'string' || !listPlugins(catalogDir, repoDir).some((p) => p.source === source)) {
    throw new AdeError('plugin_invalido', `A fonte ${String(source)} não está no catálogo.`, 2)
  }
  const off = new Set(disabledSources(repoDir))
  if (enabled) off.delete(source)
  else off.add(source)
  writeJsonAtomic(pluginsPath(repoDir), { disabled: [...off].sort() })
}

/** Placar BM25 mínimo para uma skill entrar numa pergunta do chat; abaixo disso a pergunta vai sem skill. */
export const CHAT_SKILL_MIN_SCORE = 4

/**
 * Skills de uma pergunta do chat (o "interceptador" determinístico): elegíveis no projeto, sem scripts,
 * ranqueadas por BM25 contra a pergunta, no máximo 2, e lidas conferindo os bytes contra o índice.
 */
export function chatSkills(catalogDir: string, repoDir: string, prompt: string): Array<{ id: string; content: string }> {
  const off = new Set(disabledSources(repoDir))
  const candidates = readIndex(catalogDir).entries.filter((e) => e.trust !== 'quarantine' && !e.has_scripts && !off.has(e.source))
  const picked = selectStorySkills({ story: { task: prompt }, candidates, budget: { maxSkills: 2, maxTotalTokens: 12000 } })
    .filter((s) => s.score >= CHAT_SKILL_MIN_SCORE)
  if (picked.length === 0) return []
  return loadApprovedSkills({ catalogDir, approvedSkills: picked.map((s) => s.id) }).skills.map((s) => ({ id: s.id, content: s.content }))
}

/** Skills que o próximo pedido pode usar: fora da quarentena e de fonte ligada no projeto. */
export function eligibleSkills(catalogDir: string, repoDir: string): SkillSummary[] {
  const off = new Set(disabledSources(repoDir))
  return listSkills(catalogDir).filter((s) => s.trust !== 'quarantine' && !off.has(s.source))
}
