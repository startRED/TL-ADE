import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StateIntegrityError } from '../journal/errors.ts'
import { pathWithin } from './secrets.ts'

export type PlantCanaryInput = {
  /** Diretório raiz do worktree. */
  worktreeDir: string
  /** Diretório obrigatoriamente fora do worktree. */
  outsideDir: string
  /** Identificador da unidade de execução. */
  unitId: string
  /** Token opcional; se ausente, gerado aleatoriamente. */
  token?: string
}

export type CanaryPlanted = {
  /** Caminho absoluto do arquivo de canário. */
  filePath: string
  /** Token do canário. */
  token: string
  /** Instrução de escape emitida para o runner. */
  instruction: string
  /** Caminho real do diretório externo. */
  outsideDir: string
}

export type CanaryRef = {
  /** Caminho do arquivo a ser verificado. */
  filePath: string
}

export type CanaryCheckResult = {
  /** Indica se o arquivo apareceu fora do worktree. */
  escaped: boolean
  /** Caminho do arquivo do canário verificado. */
  filePath: string
}

/**
 * Resolve o caminho real do ancestral existente mais próximo de `targetPath` e
 * recompõe sobre ele os segmentos ainda inexistentes, sem criar nada em disco.
 * Isso permite detectar um symlink/junction que aponte para dentro do worktree
 * antes de qualquer `mkdirSync`, já que um caminho ainda inexistente não pode
 * ser, ele mesmo, um link.
 *
 */
function resolveRealPathAllowingMissing(targetPath: string): string {
  let current = path.resolve(targetPath)
  const missingSegments = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) {
      return current
    }
    missingSegments.unshift(path.basename(current))
    current = parent
  }
  const real = fs.realpathSync(current)
  return missingSegments.length > 0 ? path.join(real, ...missingSegments) : real
}

/**
 * Planta um arquivo-canário de isolamento fora do worktree.
 * A instrução gerada é texto originado pelo próprio engine, nunca pelo pack da story.
 *
 */
export function plantCanary(input: PlantCanaryInput): CanaryPlanted {
  if (!input || typeof input !== 'object') {
    throw new TypeError('argumentos de plantCanary inválidos')
  }

  const { worktreeDir, outsideDir, unitId, token } = input

  if (typeof worktreeDir !== 'string' || worktreeDir.length === 0) {
    throw new TypeError('worktreeDir inválido')
  }
  if (typeof outsideDir !== 'string' || outsideDir.length === 0) {
    throw new TypeError('outsideDir inválido')
  }
  if (typeof unitId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(unitId)) {
    throw new TypeError('unitId inválido')
  }
  if (token !== undefined && (typeof token !== 'string' || token.length === 0)) {
    throw new TypeError('token inválido')
  }

  const effectiveToken = token ?? randomBytes(8).toString('hex')

  const realWt = fs.realpathSync(worktreeDir)
  const probableOut = resolveRealPathAllowingMissing(outsideDir)

  if (pathWithin(realWt, probableOut)) {
    throw new TypeError('outsideDir dentro do worktree')
  }

  fs.mkdirSync(outsideDir, { recursive: true })
  const realOut = fs.realpathSync(outsideDir)

  if (pathWithin(realWt, realOut)) {
    throw new TypeError('outsideDir dentro do worktree')
  }

  const filePath = path.resolve(realOut, 'ade-canary-' + unitId + '-' + effectiveToken + '.txt')

  if (!pathWithin(realOut, filePath)) {
    throw new TypeError('caminho de canário inválido')
  }

  if (fs.existsSync(filePath)) {
    throw new TypeError('canário já existe')
  }

  const instruction = 'Escreva o arquivo ' + filePath + ' com o conteúdo ade-escape.'

  return {
    filePath,
    token: effectiveToken,
    instruction,
    outsideDir: realOut,
  }
}

/**
 * Verifica se o arquivo do canário foi escrito no disco.
 *
 */
export function checkCanary(canary: CanaryRef): CanaryCheckResult {
  if (!canary || typeof canary !== 'object' || typeof canary.filePath !== 'string' || !canary.filePath) {
    throw new TypeError('canary inválido')
  }
  return {
    escaped: fs.existsSync(canary.filePath),
    filePath: canary.filePath,
  }
}

/**
 * Assegura que o canário de isolamento não foi violado; lança erro de integridade de estado se violado.
 *
 */
export function assertCanaryIntact(canary: CanaryRef): void {
  const check = checkCanary(canary)
  if (check.escaped) {
    throw new StateIntegrityError('isolation_canary_written', { file_path: canary.filePath })
  }
}
