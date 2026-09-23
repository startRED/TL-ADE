import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url))
const BUILD_NAME = /^[A-Za-z0-9_-]+$/

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export interface WebBuildFsOps {
  /** Grava por arquivo temporário + rename: substitui o ponteiro de forma atômica, também no Windows. */
  writeFileAtomic: (filePath: string, content: string) => void
  removeDir: (dir: string) => void
}

const defaultFsOps: WebBuildFsOps = {
  writeFileAtomic(filePath, content) {
    const tmpPath = `${filePath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmpPath, content, 'utf8')
    fs.renameSync(tmpPath, filePath)
  },
  removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true })
  },
}

function runNode(args: string[], cwd: string, step: string): void {
  const result = spawnSync(process.execPath, args, { cwd, shell: false, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${step} falhou (saída ${result.status}):\n${`${result.stdout}\n${result.stderr}`.trim().slice(-4000)}`)
  }
}

/** Checagem de tipos e vite build do painel, gravando em outDir. */
export async function runWebBuild(webDir: string, outDir: string): Promise<void> {
  const bin = (...parts: string[]) => path.join(PACKAGE_DIR, 'node_modules', ...parts)
  runNode([bin('typescript', 'bin', 'tsc'), '-p', path.join(webDir, 'tsconfig.json')], webDir, 'checagem de tipos')
  runNode([bin('vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], webDir, 'vite build')
}

/**
 * Pasta do build promovido apontada por <webDistRoot>/current.json, ou null sem build promovido válido.
 */
export function resolveCurrentBuild(webDistRoot: string): string | null {
  let pointer: unknown
  try {
    pointer = JSON.parse(fs.readFileSync(path.join(webDistRoot, 'current.json'), 'utf8'))
  } catch (err) {
    // Ponteiro ausente ou ilegível não é build promovido: o servidor cai no index.html da raiz.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return null
    throw err
  }
  const name = (pointer as { build?: unknown } | null)?.build
  if (typeof name !== 'string' || !BUILD_NAME.test(name)) return null
  const dir = path.join(webDistRoot, 'builds', name)
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null
}

/**
 * Compila o painel numa pasta nova e só a promove (ponteiro atômico) depois de o build passar.
 * Falha em qualquer passo remove só a pasta nova; o build servido continua intacto.
 */
export async function buildWebPanel({
  webDir,
  distRoot = path.join(webDir, 'dist'),
  runBuild = (outDir: string) => runWebBuild(webDir, outDir),
  fsOps = {},
}: {
  webDir: string
  distRoot?: string
  runBuild?: (outDir: string) => Promise<void>
  fsOps?: Partial<WebBuildFsOps>
}): Promise<{ promoted: boolean; distDir: string; error?: string }> {
  const ops = { ...defaultFsOps, ...fsOps }
  let previous: string | null
  try {
    previous = resolveCurrentBuild(distRoot)
  } catch (err) {
    return { promoted: false, distDir: '', error: `Ponteiro do build atual ilegível: ${messageOf(err)}` }
  }
  const buildsDir = path.join(distRoot, 'builds')
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const outDir = path.join(buildsDir, name)

  try {
    fs.mkdirSync(buildsDir, { recursive: true })
    await runBuild(outDir)
    if (!fs.existsSync(path.join(outDir, 'index.html'))) throw new Error(`build sem index.html em ${outDir}`)
    ops.writeFileAtomic(path.join(distRoot, 'current.json'), JSON.stringify({ build: name }))
  } catch (err) {
    // Remover a pasta nova que falhou não pode esconder a falha original nem trocar o resultado.
    let error = messageOf(err)
    try {
      ops.removeDir(outDir)
    } catch (cleanupErr) {
      error += `\nA pasta do build que falhou não foi apagada (${outDir}): ${messageOf(cleanupErr)}`
    }
    return { promoted: false, distDir: previous ?? '', error }
  }

  // Só depois da troca: guarda o atual e o anterior, apaga os mais velhos.
  // ponytail: builds simultâneos na mesma pasta podem apagar um ao outro; trava se isso virar uso real.
  // Falha na limpeza não desfaz a promoção: o build novo já está servido e o aviso volta em error.
  const keep = new Set([name, previous && path.basename(previous)])
  const leftovers: string[] = []
  try {
    for (const entry of fs.readdirSync(buildsDir)) {
      if (keep.has(entry)) continue
      try {
        ops.removeDir(path.join(buildsDir, entry))
      } catch (err) {
        leftovers.push(`${entry}: ${messageOf(err)}`)
      }
    }
  } catch (err) {
    leftovers.push(`${buildsDir}: ${messageOf(err)}`)
  }
  return leftovers.length === 0
    ? { promoted: true, distDir: outDir }
    : { promoted: true, distDir: outDir, error: `Build promovido, mas builds antigos não foram apagados:\n${leftovers.join('\n')}` }
}
