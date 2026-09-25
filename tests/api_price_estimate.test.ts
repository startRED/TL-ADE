import { expect, test } from 'vitest'
import { parseCodexStreamUsage } from '../src/adapters/codex/parse.ts'
import { listPriceUsd } from '../src/telemetry/cost.ts'
import { buildModelTelemetry } from '../src/telemetry/telemetry.ts'

// 25/09: o painel somava só o US$ do Claude; Codex e Gemini não informam dólar e ficavam em US$ 0,00. O custo
// equivalente de API sai dos tokens vezes o preço de lista de cada modelo, marcado como estimado.
test('codex_informa_tokens_na_volta_final_e_o_cache_lido_sai_da_entrada', () => {
  const stdout = [
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":19586,"cached_input_tokens":8192,"cache_write_input_tokens":0,"output_tokens":5}}',
  ].join('\n')
  expect(parseCodexStreamUsage(stdout)).toEqual({ input: 11394, output: 5, cache_read: 8192, cache_write: 0, usd: null, source: 'reported' })
  expect(parseCodexStreamUsage('{"type":"thread.started"}')).toBeNull()
})

test('preco_de_lista_de_codex_e_gemini_inclusive_com_esforco_no_nome', () => {
  // gpt-6-sol: 2 entrada, 10 saída, 0,2 cache lido por milhão
  expect(listPriceUsd('gpt-6-sol', { input: 1_000_000, output: 100_000, cache_read: 1_000_000 })).toBeCloseTo(3.2)
  // o agy manda o esforço no nome do modelo
  expect(listPriceUsd('gemini-3.8-flash-medium', { input: 527_307, output: 50_925, cache_read: 8_322_717, cache_write: 0 })).toBeCloseTo(1.2107, 3)
  expect(listPriceUsd('modelo-sem-preco', { input: 1, output: 1 })).toBeNull()
  expect(listPriceUsd('gpt-6-sol', { input: null, output: 1 })).toBeNull()
})

test('telemetria_sem_dolar_do_cli_grava_o_preco_de_lista_como_estimado', () => {
  const t = buildModelTelemetry({
    mission_id: 'm', story_id: 'S1', step_id: 'S1:r1:checker', family: 'codex', role: 'checker_round', effort: 'high',
    models: [{ role: 'executor', model_id: 'gpt-6-sol' }], duration_ms: 1000,
    tokens: { source: 'reported', input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, usd: null },
    pack: { bytes: 0, sections: [] }, skills: [], sources: [], outcome: 'ok', ttft_ms: null,
    approval_decisions: 0, network_attempts: 0, files_touched: 0, tool_output_raw_bytes: 0, tool_output_model_bytes: 0,
  })
  expect(t).toMatchObject({ cost_usd: 2, cost_source: 'estimated' })
})
