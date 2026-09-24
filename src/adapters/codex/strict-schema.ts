// Saída estruturada da OpenAI em modo estrito (o que `codex exec --output-schema` usa): todo campo de objeto tem de estar
// em `required`, e palavras como `dependencies` e `pattern` com lookahead são recusadas com 400 antes de o modelo rodar.
// Os schemas do projeto ficam como estão; o Codex recebe uma cópia estrita (opcional vira anulável) e, na volta, os
// campos que vieram null saem antes da validação contra o schema original. Mesmo desenho da demo (proto/rounds.mjs).
import fs from 'node:fs'
import path from 'node:path'

// o que o modo estrito recusa ou não precisa; a validação completa continua contra o schema original
const DROP = new Set(['$id', '$schema', 'dependencies', 'pattern', 'minLength', 'maxLength', 'format'])

function nullable(schema: any): any {
  if (typeof schema?.type === 'string') return { ...schema, type: [schema.type, 'null'], ...(schema.enum ? { enum: [...schema.enum, null] } : {}) }
  return { anyOf: [schema, { type: 'null' }] }
}

export function strictSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DROP.has(key)) continue
    if (key === 'definitions') out.$defs = strictSchema(value)
    else if (key === '$ref' && typeof value === 'string') out.$ref = value.replace('#/definitions/', '#/$defs/')
    else if (key === 'const') out.enum = [value]
    else if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value as object).map(([name, sub]) => [name, strictSchema(sub)]))
    else out[key] = strictSchema(value)
  }
  if (out.properties) {
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
    for (const name of Object.keys(out.properties)) if (!required.has(name)) out.properties[name] = nullable(out.properties[name])
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

/** Grava a cópia estrita ao lado do arquivo de resultado e devolve o caminho dela. */
export function strictSchemaFile(schemaPath: string, dir: string): string {
  const file = path.join(dir, `codex-${path.basename(schemaPath)}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(strictSchema(JSON.parse(fs.readFileSync(schemaPath, 'utf8')))))
  return file
}

/** Tira os campos null (opcionais não preenchidos no modo estrito); os schemas do projeto não aceitam null em lugar nenhum. */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T
}

/**
 * Ajusta a resposta do Codex ao schema original naquilo que o modo estrito escondeu dele (dependencies e maxLength), sem
 * mudar o que ela diz: texto acima do limite é encurtado com reticências, e campo booleano false com dependências
 * ausentes sai (false é o mesmo que ausente; `withdrawn: false` sem citação recusava a revisão inteira).
 */
export function fitToSchema<T>(value: T, schema: any, root: any = schema): T {
  const node = typeof schema?.$ref === 'string' ? root?.definitions?.[schema.$ref.replace('#/definitions/', '')] : schema
  if (!node || value === null || value === undefined) return value
  if (typeof value === 'string' && typeof node.maxLength === 'number' && value.length > node.maxLength) {
    return (value.slice(0, node.maxLength - 1) + '…') as T
  }
  if (Array.isArray(value)) return (node.items ? value.map((v) => fitToSchema(v, node.items, root)) : value) as T
  if (typeof value !== 'object') return value
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const [key, sub] of Object.entries(node.properties ?? {})) if (key in out) out[key] = fitToSchema(out[key], sub, root)
  for (const [key, deps] of Object.entries(node.dependencies ?? {})) {
    if (out[key] === false && Array.isArray(deps) && deps.some((d) => !(d in out))) delete out[key]
  }
  return out as T
}
