# ADR 0004 — Transporte bespoke headless na v1; ACP como migração por família

**Status:** aceito 2026-09-17, pendente de confirmação do Erick (o gatilho "4º provider" depende de
`architecture.md` §9.3: sem chave de API obrigatória, logo sem 4º provider)

## Contexto

Existe um protocolo padrão para clientes de agentes (ACP) com implementações para as três famílias, e
adotá-lo eliminaria a casca por CLI. Mas o write-ahead do journal (ADR 0002) depende de três garantias
concretas antes do spawn, e o ACP v1 não fornece nenhuma delas.

## Decisão

Na v1 os adapters falam com as CLIs em modo headless, por flags nativas: `claude -p --json-schema
--session-id --max-budget-usd --safe-mode` e `codex exec --json --output-schema --sandbox
--ignore-user-config`. Chamada curta no Codex usa a receita completa `--ignore-user-config
--ignore-rules --ephemeral -c skills.max_context_tokens=0`, com `AGENTS.md` ≤2 KB escrito pelo engine
no worktree (E16). O adapter é casca fina: flags + parser tolerante a campos desconhecidos + CLI falsa
por família para teste. O `CapabilitySet` carrega `transport: 'cli' | 'acp'`, `probe_ok: boolean |
null`, `probe_mode: 'real' | 'help_only' | 'fixture'`, `bootstrap_cost_tokens` e `models[].vendor`
(E10); o `JournalEvent` carrega `session_ref: string | null` (`null` quando o transporte não pré-cunha
id), de modo que a migração seja por família e honesta no journal. `ade doctor --offline` é o default
em CI; `probe_ok: null` fora de CI **recusa despacho**, nunca degrada. Gatilho declarado para ACP:
steering no meio do turno (RFD `session/inject` estável) ou entrada de um 4º provider — que hoje está
descartado pelo princípio "sem chave de API obrigatória" (§9.3).

## Evidência

- Digest #11: `--session-id <uuid>` permite cunhar o id **antes** do spawn — exatamente o que o
  write-ahead precisa; `session/new` do ACP não permite. `--max-budget-usd` e `--max-turns` dão teto a
  priori.
- Digest #10: saída por schema já é nativa (`claude -p --json-schema`, `codex exec --output-schema`,
  `agy --json-schema`). O "protocolo de saída estruturada" por prompt da spec v2 §7 é desnecessário.
- Digest #35 / `addendum-adapter-transport-acp-vs-cli.md`: claude-agent-acp 0.78 emite
  `usage_update.cost` em USD (medido), codex-acp 1.12 não emite custo (medido), a sessão ACP do Claude é
  a mesma que `claude --resume <id>` abre (verificado). O ACP **cobre** resume/fork, imagens, effort
  (`thought_level`) e permissões roteadas ao cliente; **não cobre** structured output, id pré-cunhado,
  allowlist, sandbox e PTY.
- Digest #27: chamadas curtas no Codex precisam de `--ignore-user-config` (piso ~19,4k tokens de
  entrada) — controle que o transporte precisa expor.

## Trade-offs

Uma casca por família significa que atualização de CLI é risco recorrente; mitigação é o parser
tolerante, fixtures gravadas por versão, `ade doctor` com chamada real e o `capabilities_digest` do
`runtime_stamp` (E7), que faz upgrade silencioso de CLI aparecer no journal. Perde-se de graça o que o ACP
já resolve (resume/fork uniforme, imagens, permissões roteadas) e paga-se isso em código próprio por
família. O `session_ref: null` documenta a assimetria em vez de escondê-la.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| ACP na v1 | perde as três garantias do write-ahead (id pré-cunhado, schema, teto de orçamento) — digest #11, #10, #35 |
| Protocolo de saída estruturada por prompt (spec v2 §7) | schema nativo existe e coage melhor (digest #10) |
| MCP como transporte de agente | MCP é protocolo de ferramenta, não de sessão; e MCP de browser está rejeitado (ADR 0019) |
| Transporte único abstrato "adapter genérico" desde já | abstração sem segunda implementação; a variação real está nas flags |

## Como reverter

Gatilho: `session/inject` estável a montante, ou 4º provider que só fale ACP (hoje bloqueado por §9.3).
Custo: um adapter novo por
família mais preenchimento de `transport: 'acp'` e `session_ref`; nenhum schema publicado muda, porque
os campos já existem desde a v1.

## Consequências para outros documentos

`schemas/capability-set.schema.json` e `schemas/journal-event.schema.json` (campos já previstos),
`docs/specs/` (adapters), ADR 0005 (famílias), ADR 0006 (comandos do Checker), ADR 0021 (o
`runtime_stamp` inclui a config que fixa o transporte).
