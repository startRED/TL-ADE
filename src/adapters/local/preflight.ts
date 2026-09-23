// @ts-check
import { execFile as defaultExecFile } from 'node:child_process'
import nodeFs from 'node:fs'
import { statfs as defaultStatfs } from 'node:fs/promises'
import path from 'node:path'
import { validate } from '../../schema/index.ts'

interface LocalPreflightOptions {
  repoDir: string
  story: any
  loaded: any
  capabilities?: any
  gitPort?: any
  execFile?: Function
  statfs?: Function
  now?: number | (() => number)
  env?: NodeJS.ProcessEnv
  fs?: any
  credentialRequired?: boolean
}

/**
 * Cria o conjunto de portas locais para o preflight puro.
 */
export function createLocalPreflightPorts(options: LocalPreflightOptions): Record<string, import('../../engine/preflight.ts').PreflightCheckPort> {
  const {
    repoDir,
    story,
    capabilities,
    gitPort,
    execFile = defaultExecFile,
    statfs = defaultStatfs,
    now = Date.now,
    env = process.env,
    fs = nodeFs,
    credentialRequired = true,
  } = options

  return {
    proof_target: {
      check: async () => {
        try {
          const evals = story?.evals ?? []
          for (const item of evals) {
            const evidences = item?.evidence ?? []
            for (const ev of evidences) {
              const fullPath = path.isAbsolute(ev) ? ev : path.join(repoDir, ev)
              if (!fs.existsSync(fullPath)) {
                return { status: 'blocked', reason: 'alvo inexistente' }
              }
            }
          }
          return { status: 'ready', reason: null }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar alvos de prova' }
        }
      },
    },

    dependencies: {
      check: async () => {
        try {
          // Sem manifesto não há dependência declarada para instalar.
          if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
            return { status: 'ready', reason: null }
          }
          // Manifesto sem nenhuma dependência (só scripts, como um app com node --test) não precisa de node_modules.
          const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'))
          const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => Object.keys(pkg?.[k] ?? {}).length > 0)
          if (!declared) return { status: 'ready', reason: null }
          const nmPath = path.join(repoDir, 'node_modules')
          if (!fs.existsSync(nmPath)) {
            return { status: 'blocked', reason: 'dependências ausentes' }
          }
          return { status: 'ready', reason: null }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar dependências' }
        }
      },
    },

    build: {
      check: async () => {
        try {
          const pkgPath = path.join(repoDir, 'package.json')
          if (!fs.existsSync(pkgPath)) {
            return { status: 'ready', reason: null }
          }

          let pkg
          try {
            const raw = fs.readFileSync(pkgPath, 'utf8')
            pkg = JSON.parse(raw)
          } catch {
            return { status: 'blocked', reason: 'falha na execução do build' }
          }

          if (!pkg?.scripts?.build) {
            return { status: 'ready', reason: null }
          }

          const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
          return await new Promise((resolve) => {
            try {
              execFile(
                npmCmd,
                ['run', 'build'],
                {
                  cwd: repoDir,
                  shell: false,
                  maxBuffer: 1048576,
                  timeout: 60000,
                },
                (err: any) => {
                  if (err) {
                    resolve({ status: 'blocked', reason: 'falha na execução do build' })
                  } else {
                    resolve({ status: 'ready', reason: null })
                  }
                },
              )
            } catch {
              resolve({ status: 'blocked', reason: 'falha na execução do build' })
            }
          })
        } catch {
          return { status: 'blocked', reason: 'falha na execução do build' }
        }
      },
    },

    worktree: {
      check: async () => {
        try {
          if (!gitPort || typeof gitPort.dirtyPaths !== 'function') {
            return { status: 'blocked', reason: 'não foi possível verificar estado da worktree' }
          }
          const dirty = await gitPort.dirtyPaths()
          // Artefatos do próprio motor em .ade/ não são alteração pendente do operador.
          const pending = Array.isArray(dirty)
            ? dirty.filter((p) => !String(p).replace(/\\/g, '/').startsWith('.ade/'))
            : dirty
          if (Array.isArray(pending) && pending.length === 0) {
            return { status: 'ready', reason: null }
          }
          return { status: 'blocked', reason: 'worktree com alterações pendentes' }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar estado da worktree' }
        }
      },
    },

    input: {
      check: async () => {
        try {
          const contract = story?.contract
          if (!contract || typeof contract !== 'object') {
            return { status: 'blocked', reason: 'contrato inválido' }
          }
          const validation = validate('task-contract', contract)
          if (validation.valid) {
            return { status: 'ready', reason: null }
          }
          return { status: 'blocked', reason: 'contrato inválido' }
        } catch {
          return { status: 'blocked', reason: 'não foi possível validar contrato' }
        }
      },
    },

    credential: {
      check: async () => {
        try {
          // Sem chamada paga real (CLI falsa ou despacho injetado) não há credencial a exigir.
          if (credentialRequired === false) {
            return { status: 'ready', reason: null }
          }
          const apiKey = env?.ANTHROPIC_API_KEY
          if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
            return { status: 'ready', reason: null }
          }
          // A TL-ADE roda no plano do usuário: o CLI logado que respondeu à sonda real do ade doctor é a credencial.
          if (capabilities?.probe_ok === true && capabilities?.probe_mode === 'real') {
            return { status: 'ready', reason: null }
          }
          return { status: 'blocked', reason: 'credencial ausente ou vazia' }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar credencial' }
        }
      },
    },

    disk: {
      check: async () => {
        try {
          if (typeof statfs !== 'function') {
            return { status: 'blocked', reason: 'consulta de espaço livre indisponível' }
          }
          const stats = await statfs(repoDir)
          const bavail = BigInt(stats.bavail)
          const bsize = BigInt(stats.bsize)
          const freeBytes = bavail * bsize
          if (freeBytes >= 1073741824n) {
            return { status: 'ready', reason: null }
          }
          return { status: 'blocked', reason: 'espaço insuficiente' }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar espaço livre' }
        }
      },
    },

    external_access: {
      check: async () => {
        try {
          if (capabilities?.probe_ok !== true) {
            return { status: 'blocked', reason: 'rode ade doctor sem modo offline para executar uma sonda real de acesso' }
          }

          const nowVal = typeof now === 'function' ? Number(now()) : Number(now ?? Date.now())
          const rawProbedAt = capabilities?.probed_at
          const probedAt =
            typeof rawProbedAt === 'number'
              ? rawProbedAt
              : typeof rawProbedAt === 'string'
                ? Date.parse(rawProbedAt)
                : Number.NaN
          if (
            Number.isFinite(probedAt) &&
            Number.isFinite(nowVal) &&
            nowVal - probedAt >= 0 &&
            nowVal - probedAt <= 86400000
          ) {
            return { status: 'ready', reason: null }
          }
          return { status: 'blocked', reason: 'rode ade doctor sem modo offline para renovar a sonda real de acesso' }
        } catch {
          return { status: 'blocked', reason: 'não foi possível verificar capacidade de acesso' }
        }
      },
    },
  }
}
