import fs from 'node:fs'
import path from 'node:path'

/**
 * Conteúdo determinístico do script de inicialização de dois cliques para Windows (ade.bat).
 */
export const LAUNCHER_BAT_CONTENT = `@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0bin\\ade.js" (
  node "%~dp0bin\\ade.js" serve %*
) else (
  ade serve %*
)
`

/**
 * Gera de forma idempotente o lançador ade.bat na raiz do repositório.
 *
 * @returns Caminho completo do lançador gerado
 */
export function generateLauncher({ repoDir = process.cwd() }: { repoDir?: string } = {}): string {
  const resolvedRepo = path.resolve(repoDir)
  const launcherPath = path.join(resolvedRepo, 'ade.bat')

  fs.writeFileSync(launcherPath, LAUNCHER_BAT_CONTENT, 'utf8')
  return launcherPath
}
