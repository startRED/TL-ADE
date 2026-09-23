import { createHash } from 'node:crypto'
import canonicalizeJcs from 'canonicalize'

function hasLoneSurrogate(str: string) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function assertNoLoneSurrogate(value: unknown) {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new TypeError('canonicalize: lone surrogate is not a valid Unicode scalar value')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoLoneSurrogate(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    const record = (value as Record<string, unknown>)
    for (const key of Object.keys(record)) {
      assertNoLoneSurrogate(key)
      assertNoLoneSurrogate(record[key])
    }
  }
}

// RFC 8785 (JCS) sobre `canonicalize` (Apache-2.0, zero deps): nunca reimplementar JCS à mão.
export function canonicalize(value: unknown): string {
  assertNoLoneSurrogate(value)
  const result = canonicalizeJcs(value)
  if (result === undefined) {
    throw new TypeError('canonicalize: value cannot be represented as JSON')
  }
  return result
}

// Devolve os 16 primeiros caracteres hex do SHA-256 do texto canônico em UTF-8.
export function digest16(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex').slice(0, 16)
}

