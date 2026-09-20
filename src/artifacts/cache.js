import fs from 'node:fs'
import path from 'node:path'
import { digest16 } from '../journal/canonical.js'

/**
 * Computa uma chave determinística de 16 caracteres hex para o artefato.
 * @param {{
 *   producer: string,
 *   producer_version?: string,
 *   input_digest: string,
 *   config_digest?: string,
 *   schema_version?: number
 * }} spec
 * @returns {string}
 */
export function computeArtifactCacheKey(spec) {
  return digest16({
    producer: spec.producer,
    producer_version: spec.producer_version ?? '1.0.0',
    input_digest: spec.input_digest,
    config_digest: spec.config_digest ?? '',
    schema_version: spec.schema_version ?? 1,
  })
}

/**
 * Recupera um artefato do cache ou chama o produtor para gerá-lo e gravá-lo atomicamente.
 * @param {{
 *   producer: string,
 *   producer_version?: string,
 *   input_digest: string,
 *   config_digest?: string,
 *   schema_version?: number,
 *   missionDir?: string,
 *   cacheDir?: string,
 *   journal?: any
 * }} spec
 * @param {() => Promise<any>} producer
 * @returns {Promise<{ artifact: any, cacheHit: boolean }>}
 */
export async function getOrProduceArtifact(spec, producer) {
  const key = computeArtifactCacheKey(spec)
  const baseDir = spec.missionDir ?? spec.cacheDir ?? process.cwd()
  const cacheDir = spec.cacheDir ?? path.join(baseDir, '.ade', 'cache', 'artifacts')
  const cacheFile = path.join(cacheDir, `${key}.json`)

  if (fs.existsSync(cacheFile)) {
    const raw = fs.readFileSync(cacheFile, 'utf8')
    const artifact = JSON.parse(raw)
    if (spec.journal && typeof spec.journal.append === 'function') {
      await spec.journal.append({
        kind: 'cache_hit',
        cache_hit: true,
        data: { key },
      })
    }
    return { artifact, cacheHit: true }
  }

  const artifact = await producer()
  fs.mkdirSync(cacheDir, { recursive: true })
  const tmpFile = path.join(cacheDir, `${key}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  fs.writeFileSync(tmpFile, JSON.stringify(artifact, null, 2), 'utf8')
  fs.renameSync(tmpFile, cacheFile)

  return { artifact, cacheHit: false }
}
