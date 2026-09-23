// Tipos de portão compartilhados por command.ts e gates.ts.

export interface GateSpec {
  id: string
  kind?: string
  when?: 'always' | 'by_flag'
  flag?: string
  argv?: string[]
  script?: string
  expect_exit?: number
  timeout_s?: number
  idempotent?: boolean
}

export interface PackageJsonSpec {
  scripts?: Record<string, string>
}
