# ADR 0011 — Context Pack com tetos, Tool Output Firewall e telemetria por chamada

**Status:** aceito 2026-09-17

## Contexto

O que entra no contexto do modelo é a terceira coisa insubstituível da ADE. Três problemas separados
compartilham a mesma fronteira: montar o contexto de forma determinística e cacheável, impedir que a
saída de ferramenta vire instrução, e medir o que cada byte injetado produziu.

## Decisão

**Pack**: seções em ordem fixa por volatilidade (ferramentas → papel → invariantes do repo ≤1,5k →
skills por id ≤7,5k → contexto recuperado ≤6k → contrato → rodada → tarefa), teto global 40k tokens
**[hipótese]**, ponteiro de drill-down ao estourar teto de seção, redação de segredos **pós-montagem**,
manifesto com digest por seção como evidência. Sempre `{pack_path}`, nunca `{pack_text}`. Isolamento do
processo: `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, nunca `--bare`.

**Firewall**: todo comando passa pelo executor com assinatura `run(argv) → { rawPath, extract }`. O
bruto vira artifact; o modelo recebe extrato — falha **íntegra, mas cercada como dado não confiável**;
sucesso resumido. `ade show <ref>` faz o drill-down. Hooks `PostToolUse` das CLIs são segunda camada,
nunca a única. `max_diff_bytes` herdado (200 000 chars) é reduzido, com ponteiro.

**Telemetria**: um evento por `model_call` com `tokens_in/out`, `cache_read/write`, `cost_usd` +
`cost_source` (`reported` | `estimated` | `unknown`), `pack_bytes`, `pack_sections[]`,
`skills_injected[{name, bytes, cited}]`, `tool_output_raw_bytes` / `tool_output_model_bytes`. Doctor v1
apenas coleta e relata.

## Evidência

- Digest #31: `{pack_text}` com 60k de pack estoura os 32.767 chars de `lpCommandLine` no Windows.
- Digest #9: `--bare` quebra a autenticação por assinatura; o isolamento correto é `--safe-mode` +
  auto memory desligada — ela vem **ligada por padrão** e quebra determinismo.
- `landscape-context-observability.md` §2.1: regra de *losslessness* — sucesso é resumível, **falha nunca
  é resumida**; TDR (`bytes ao modelo / bytes brutos`) com alvos ≤0,2 em verde e 1,0 em falha (§2, §222).
- `judgment-J3-durability-security-cost.md` §4: entregar o log de falha íntegro é "o vetor mais barato
  que existe", e o `redact_secrets` do pack (I59) é **outbound**, não inbound — daí a cerca inbound ser
  obrigatória, não opcional.
- Digest #28: Codex não reporta USD (só tokens, incluindo `cache_write_input_tokens` não documentado);
  Claude reporta `total_cost_usd` com `costBasis: 'list'`; `agy` tem anomalia (`cache_read_tokens` >
  `total_tokens`); OTel `gen_ai.*` está em Development e não tem tipo de token de cache.
- `judgment-J3-durability-security-cost.md` §7: só uma proposta carregava `cited` em contrato — sem esse
  campo, metade da coleta da v1 não coleta. E a ablação por `claude plugin eval` é cega no braço Codex.
- `judgment-J3-durability-security-cost.md` §6 e `runtime-port-map.md` §6: `max_diff_bytes` de 200 000
  chars (~50k tokens) herdado sem revisão nas três propostas, pago por rodada e por Checker.
- Digest #13: corpo de 3 skills ≈6–7k tokens — origem do teto de 7,5k da seção de skills.

## Trade-offs

Os tetos são hipóteses até a telemetria dar p90 por seção; tetos apertados produzem ponteiros que o
modelo talvez não siga. A cerca inbound pode esconder a pista útil dentro de um log de falha hostil —
por isso o bruto fica em `artifacts/` e o drill-down é um comando. Manifesto e artifacts crescem em
disco por missão. Custo do braço Codex fica `estimated` (tabela de preços em `~/.ade/prices.json`), e a
ablação do doctor continua estruturalmente cega em metade do harness — limitação registrada, não
resolvida na v1.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| `{pack_text}` no argv | estoura `lpCommandLine` (#31) |
| `--bare` para contexto limpo | quebra a assinatura (#9) |
| Resumir a saída de falha | perde a evidência que o rework precisa (§2.1) |
| Hooks das CLIs como camada única | só existem no Claude Code; o firewall tem de ser universal |
| Mem0 / Letta como memória | dependência e estado fora do journal (ADR 0019) |
| OTel export na v1 | convenção em Development, sem tipo de cache (#28) |

## Como reverter

Gatilho: p90 medido de uma seção estourando o teto de forma sistemática, ou TDR fora do alvo. Custo:
tetos são config; o manifesto já grava bytes e digest por seção, então a revisão é feita sobre dado
próprio. Exportar OTel depois é aditivo sobre o mesmo evento de telemetria.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (kind `telemetry`), `docs/specs/` (Pack compiler, Firewall,
`ade show`), `~/.ade/prices.json`, ADR 0006 (`max_diff_bytes` do Checker), ADR 0009 (`cited`),
ADR 0017, ADR 0019, ADR 0022.
