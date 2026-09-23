import fs from 'node:fs'
import path from 'node:path'
import { AdeError } from '../journal/errors.ts'
import { writeJsonAtomic } from './plan-lifecycle.ts'

// Níveis do ADR 0015, os mesmos do enum `autonomy` dos schemas.
export const AUTONOMY_LEVELS = ['safe', 'controlled', 'restricted'] as const

/** Opções de missão de um projeto; `usd_informative` só é mostrado, nunca bloqueia (ADR 0032). */
export interface MissionOptions {
  autonomy: (typeof AUTONOMY_LEVELS)[number]
  ceilings: { max_turns: number | null; max_rounds: number | null; usd_informative: number | null }
  fast_lane: boolean
  visual_gate: boolean
  images: boolean
  research: boolean
}

export const DEFAULT_MISSION_OPTIONS: MissionOptions = {
  autonomy: 'safe',
  ceilings: { max_turns: null, max_rounds: null, usd_informative: null },
  fast_lane: true,
  visual_gate: false,
  images: true,
  research: false,
}

const FLAGS = ['fast_lane', 'visual_gate', 'images', 'research'] as const
const MISSION_OPTIONS_FILE = 'mission-options.json'

const invalid = (message: string) => new AdeError('opcoes_invalidas', message, 2)
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function assertKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const unknown = Object.keys(value).find((k) => !keys.includes(k))
  if (unknown) throw invalid(`Campo desconhecido em ${where}: ${unknown}.`)
  const missing = keys.find((k) => !(k in value))
  if (missing) throw invalid(`Falta o campo ${missing} em ${where}.`)
}

/** Teto nulo (sem teto) ou inteiro positivo. */
function ceiling(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid(`${name} deve ser um inteiro maior que zero ou vazio.`)
  return value
}

/** Valida a forma inteira das opções; campo a mais, a menos ou fora do domínio é erro. */
export function validateMissionOptions(value: unknown): MissionOptions {
  if (!isPlainObject(value)) throw invalid('As opções devem ser um objeto JSON.')
  assertKeys(value, ['autonomy', 'ceilings', ...FLAGS], 'opções')
  if (!AUTONOMY_LEVELS.includes(value.autonomy as MissionOptions['autonomy'])) {
    throw invalid(`Autonomia deve ser uma de ${AUTONOMY_LEVELS.join(', ')} (ADR 0015).`)
  }
  for (const flag of FLAGS) if (typeof value[flag] !== 'boolean') throw invalid(`${flag} deve ser verdadeiro ou falso.`)
  const ceilings = value.ceilings
  if (!isPlainObject(ceilings)) throw invalid('ceilings deve ser um objeto.')
  assertKeys(ceilings, ['max_turns', 'max_rounds', 'usd_informative'], 'ceilings')
  const usd = ceilings.usd_informative
  if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) throw invalid('usd_informative deve ser um valor não negativo ou vazio.')
  return {
    autonomy: value.autonomy as MissionOptions['autonomy'],
    ceilings: { max_turns: ceiling(ceilings.max_turns, 'max_turns'), max_rounds: ceiling(ceilings.max_rounds, 'max_rounds'), usd_informative: usd },
    fast_lane: value.fast_lane as boolean,
    visual_gate: value.visual_gate as boolean,
    images: value.images as boolean,
    research: value.research as boolean,
  }
}

export function writeMissionOptions(missionDir: string, options: MissionOptions): void {
  writeJsonAtomic(path.join(missionDir, MISSION_OPTIONS_FILE), validateMissionOptions(options))
}

/** Opções fixadas na aprovação, na pasta do plano; sem o arquivo, null (motor segue como antes). */
export function readMissionOptionsBesidePlan(planPath: string): MissionOptions | null {
  const file = path.join(path.dirname(planPath), MISSION_OPTIONS_FILE)
  if (!fs.existsSync(file)) return null
  return validateMissionOptions(JSON.parse(fs.readFileSync(file, 'utf8')))
}
