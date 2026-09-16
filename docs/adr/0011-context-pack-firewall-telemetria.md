# ADR 0011 — Context Pack com tetos, Tool Output Firewall e telemetria por chamada

**Status:** aceito 2026-09-17

## Contexto

O que entra no contexto do modelo é a terceira coisa insubstituível da ADE. Três problemas separados
compartilham a mesma fronteira: montar o contexto de forma determinística e cacheável, impedir que a
saída de ferramenta vire instrução, e medir o que cada byte injetado produziu.

## Decisão

**Pack**: seções em ordem fixa por volatilidade (ferramentas → papel → invariantes do repo ≤1,5k, em
forma canônica "Must Always / Must Never", imperativo curto (A11) → skills por id, ≤7,5k por skill e soma
≤15k (E14) → contexto recuperado ≤6k → contrato → rodada → tarefa). O **corte é em bytes**:
`limits.max_pack_bytes`, default **120 000** **[hipótese]**, calibrado por p90; "40k tokens" continua
como alvo de projeto por estimativa, não como portão. A seção de rodada (achados, falhas de gate,
checkpoint) tem teto próprio de **24 000 bytes** com ponteiro (E13). Ponteiro de drill-down ao estourar
teto de seção, redação de segredos **pós-montagem**, manifesto com digest por seção como evidência —
os digests usados voltam em `sources[]` de `unit-result` e `review-result`, sem os quais `cited` é
sempre falso (E8). Sempre `{pack_path}`, nunca `{pack_text}`. Isolamento do processo: `--safe-mode` +
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, nunca `--bare`. Medir `--system-prompt` como veículo do pack
contra o prompt de usuário é **[hipótese]** do harness doctor; o pack continua vindo de arquivo (A9).

**Firewall**: todo comando passa pelo executor com assinatura `run(argv) → { rawPath, extract }`. O
bruto vira artifact; o extrato tem **forma fixa** `{status: success | warning | error, summary,
next_actions[], artifacts[], raw_ref}` (schema inline), nunca texto livre (A1) — falha **íntegra, mas
cercada como dado não confiável**; sucesso resumido. `ade show <ref>` faz o drill-down. Hooks
`PostToolUse` das CLIs são segunda camada, nunca a única. O `max_diff_bytes` herdado (200 000 chars)
cai para `review.max_diff_bytes` = **60 000 chars**, por arquivo em ordem de relevância de escopo, com
ponteiro `ade show diff:<story>#<arquivo>` (E13).

**Telemetria**: um evento por `model_call` com `tokens_in/out`, `cache_read/write`, `cost_usd` +
`cost_source` (`reported` | `estimated` | `unknown`), `ttft_ms`, `pack_bytes`, `pack_sections[]`,
`skills_injected[{name, bytes, cited}]`, `tool_output_raw_bytes` / `tool_output_model_bytes`,
`compaction_events`, `outcome ∈ {ok, retry, rework, park, stop}`, `approval_decisions`,
`network_attempts`, `files_touched` (A2, E11); agregados `pass@k` e `pass^k` por classe de
complexidade; um evento `scope: 'mission_summary'` no fechamento (intervenções, perguntas, wall time,
verbos de CLI usados) e `source: operator | engine` nos eventos `decision`. O benefício de cache é
**[hipótese]**: `cache_read / (tokens_in + cache_read)` por papel é a primeira métrica do harness
doctor (E17). Doctor v1 apenas coleta e relata.

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
  chars (~50k tokens) herdado sem revisão nas três propostas, pago por rodada e por Checker — daí os
  60 000 chars de E13.
- `ref-affaan-mustafa-ecc.md` (A1, A2): extrato de ferramenta com forma fixa e telemetria com
  `approval_decisions` / `network_attempts` / `files_touched` vêm dos guias do ECC, lidos como
  referência pinada por commit, nunca como dependência de runtime.
- Digest #13: corpo de 3 skills ≈6–7k tokens — origem do teto original de 7,5k da seção de skills (elevado a 15k por E70).

## Trade-offs

Os tetos são hipóteses até a telemetria dar p90 por seção; tetos apertados produzem ponteiros que o
modelo talvez não siga. Cortar em bytes é operacional e auditável, mas desalinha do que a CLI cobra em
tokens: a conversão fica como estimativa declarada, não como verdade. A cerca inbound pode esconder a pista útil dentro de um log de falha hostil —
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
| Extrato do Firewall em texto livre | sem forma fixa não há como o engine decidir nem medir (A1) |
| Teto de pack contado só em tokens | o executor corta bytes; token é estimativa por família (E13) |
| Hooks das CLIs como camada única | só existem no Claude Code; o firewall tem de ser universal |
| Mem0 / Letta como memória | dependência e estado fora do journal (ADR 0019) |
| OTel export na v1 | convenção em Development, sem tipo de cache (#28) |

## Como reverter

Gatilho: p90 medido de uma seção estourando o teto de forma sistemática, TDR fora do alvo, ou razão de
cache por papel que desminta o benefício suposto (E17). Custo: tetos são config (`limits.max_pack_bytes`,
`review.max_diff_bytes`); o manifesto já grava bytes e digest por seção, então a revisão é feita sobre dado
próprio. Exportar OTel depois é aditivo sobre o mesmo evento de telemetria.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (kind `telemetry`), `schemas/unit-result.schema.json` e
`schemas/review-result.schema.json` (`sources[]`), `docs/specs/` (Pack compiler, Firewall, `ade show`),
`~/.ade/prices.json`, ADR 0006 (`review.max_diff_bytes` do Checker), ADR 0009 (`cited` e o teto de
skills), ADR 0017, ADR 0019, ADR 0022.

## Emendas (2026-09-17)

- E50: teto da seção `contract` do pack fixado em 32 000 bytes (≈8k tokens) [hipótese], dentro de `max_pack_bytes`; estouro é `story_pack_overflow` e reabre a divisão da story. Substitui os valores divergentes citados alhures (2 000 tok em context §1.1; 18 000 tok em intent-compiler §9).
- E53: `ade steer` ganha consumidor — a seção `task` do pack recebe `operator_notes` (≤600 bytes, mais recente primeiro), fila drenada no `prepare` da story seguinte; a nota é contexto, não requisito, e o contrato continua imutável.
- E59: `skills_injected[]` ganha `sha256` (do conteúdo injetado) e `source` (`catalog@<commit>` ou `local`).
- E66: o campo `model` da telemetria de `model_call` vira `models: { role: 'executor' | 'advisor'; model_id }[]`.
- E67: `compaction_events` sai da telemetria (sessão nova por chamada, turno único, pack com teto: nunca há compactação); `capabilities_digest` passa a ter dois leitores nomeados — relatório do doctor e `mission_summary`.
