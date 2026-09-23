import {
  AdeError,
  CoordinatorConflictError,
  JournalCorruptError,
  StateIntegrityError,
} from '../journal/errors.ts'

type ExitCode = 1 | 2 | 3 | 4 | 5

const EXIT_CODES: readonly ExitCode[] = [1, 2, 3, 4, 5]

/**
 * Mapeia um erro para o código de saída da CLI. Um `AdeError` com exit code fora de 1..5 cai em 1.
 */
export function exitCodeOf(err: unknown): ExitCode {
  if (err instanceof CoordinatorConflictError) {
    return 5
  }
  if (err instanceof JournalCorruptError || err instanceof StateIntegrityError) {
    return 2
  }
  if (err instanceof AdeError) {
    const code = EXIT_CODES.find((c) => c === err.exitCode)
    return code ?? 1
  }
  return 1
}
