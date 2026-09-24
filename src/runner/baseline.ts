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
 * Roda a suíte e julga contra a largada. Com vermelha cobrada, repete uma vez com limite folgado por prova antes de abrir
 * rodada, e só cobra a que falha nas duas execuções: prova instável sob carga (motor, modelo e suíte na mesma máquina)
 * falhava numa e passava na outra e abria rodada sobre código que a parte nem tocou. Vale para a parte e para a suíte de
 * fim de épico (com a largada do épico).
 */
export async function judgeSuite(
  run: (testTimeoutMs?: number) => Promise<TestResult[]>,
  baseline: TestResult[],
): Promise<{ ok: boolean; reds: TestResult[]; retried: boolean; results: TestResult[] }> {
  let results = await run()
  let reds = chargeableReds(baseline, results)
  const retried = reds.length > 0
  if (retried) {
    const first = new Set(reds.map((t) => t.id))
    results = await run(SLOW_TEST_MS)
    reds = chargeableReds(baseline, results).filter((t) => first.has(t.id))
  }
  return { ok: reds.length === 0, reds, retried, results }
}
