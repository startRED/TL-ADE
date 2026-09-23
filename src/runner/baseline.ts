import type { TestResult } from './test-reports.ts'

// Limite por prova na repetição de um vermelho que era só estouro de tempo: a máquina roda motor, modelo e suíte juntos.
export const SLOW_TEST_MS = 120 * 1000

const red = (t: TestResult): boolean => t.status === 'failed' || t.status === 'timeout'

/**
 * Vermelhas de `after` cobradas da parte: as que já estavam vermelhas na largada (`baseline`) não contam, uma a uma.
 * Prova que não existia na largada é da parte e conta.
 */
export function chargeableReds(baseline: TestResult[], after: TestResult[]): TestResult[] {
  const redBefore = new Set(baseline.filter(red).map((t) => t.id))
  return after.filter((t) => red(t) && !redBefore.has(t.id))
}

/**
 * Roda a suíte e julga contra a largada. Se o que sobra cobrado é só estouro de tempo, repete uma vez com limite folgado
 * por prova antes de abrir rodada. Vale para a parte e para a suíte de fim de épico (com a largada do épico).
 */
export async function judgeSuite(
  run: (testTimeoutMs?: number) => Promise<TestResult[]>,
  baseline: TestResult[],
): Promise<{ ok: boolean; reds: TestResult[]; retried: boolean; results: TestResult[] }> {
  let results = await run()
  let reds = chargeableReds(baseline, results)
  const retried = reds.length > 0 && reds.every((t) => t.status === 'timeout')
  if (retried) {
    results = await run(SLOW_TEST_MS)
    reds = chargeableReds(baseline, results)
  }
  return { ok: reds.length === 0, reds, retried, results }
}
