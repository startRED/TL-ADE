import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Seleciona os testes a serem incluídos e excluídos com base nas variáveis de ambiente.
 * Quando ADE_PROBES for '1', inclui apenas os testes de probes.
 * Caso contrário, executa a suíte padrão excluindo os testes de probes.
 *
 * @param {Record<string, string | undefined>} env - Variáveis de ambiente
 * @returns {{ include: string[], exclude: string[], minWorkers?: number, maxWorkers?: number }} Padrões de include e exclude
 */
export function selectTests(env) {
  if (env && env.ADE_PARITY === '1') {
    return {
      include: ['tests/parity/**/*.test.ts'],
      exclude: ['tests/probes/**'],
      minWorkers: 4,
      maxWorkers: 4,
    }
  }

  if (env && env.ADE_PROBES === '1') {
    return {
      include: ['tests/probes/**/*.test.ts'],
      exclude: [...configDefaults.exclude],
    }
  }

  return {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/probes/**'],
  }
}

export default defineConfig({
  test: {
    ...selectTests(process.env),
    minWorkers: process.env.ADE_PARITY === '1' ? 4 : undefined,
    maxWorkers: process.env.ADE_PARITY === '1' ? 4 : undefined,
    coverage: {
      provider: 'v8',
      include: [
        'src/journal/**/*.{js,ts}',
        'src/step/**/*.{js,ts}',
        'src/lease/**/*.{js,ts}',
        'src/git/**/*.{js,ts}',
        'src/runner/**/*.{js,ts}',
        'src/contain/**/*.{js,ts}',
      ],
    },
  },
})
