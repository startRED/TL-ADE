# ADR 0006 — Checker de rodada (Codex) vs Checker de portão (Claude), com `review-result` rico

**Status:** aceito 2026-09-17

## Contexto

A spec v2 tratava "Codex é o melhor revisor" como fato e propunha `codex review` como Checker. O
benchmark diz outra coisa, o comando não serve, e o schema `review-result` herdado discorda do runtime
que o produz em dois pontos que quebram escalação.

## Decisão

Dois papéis distintos de revisão:

| Papel | Quando | Comando | Por quê |
| :--- | :--- | :--- | :--- |
| Checker de **rodada** | após `eval_run:green`, gera rework | `codex exec --json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0 --output-schema review-result.schema.json` | precisão |
| Checker de **portão** | antes do merge | `claude -p --json-schema … --permission-mode plan` | cobertura |

O Checker **não escreve**: `--sandbox read-only` e `--permission-mode plan` transformam I28 ("Checker
que edita a árvore") de detecção em impossibilidade. Adota-se a forma **rica** do `review-result`
(`action_items[]` com `severity`/`category`/`target_role`/`location`/`problem`/`evidence`/
`required_action`, mais `deferred` e `rejected`), com `summary` derivado e `sources: string[]`
**obrigatório** — os digests das seções do pack efetivamente usadas; sem ele `cited` é sempre falso
(E8). O diff entregue ao Checker é cortado por `review.max_diff_bytes` (default **60 000 chars**,
E13), por arquivo em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>`. O
pack do Checker inclui obrigatoriamente a seção "invariantes do repo", e o engine escreve um
`AGENTS.md` ≤2 KB no worktree (E16). O Checker de rodada recusa vendor igual ao do Maker (E10).
`no_checker_family_available` → `parked`. `claude ultrareview` é portão opcional pré-merge. `codex
review` nunca é usado.

## Evidência

- Digest #5: CR-bench (arXiv 2603.23448v3, 184 PRs) — Claude Code 32,1 % vs Codex 20,1 % de pass rate;
  Codex ganha em **precisão** (88 % vs 78 %). Rodada ≠ portão é consequência direta.
- Digest #6 / `addendum-checker-contract-review-result.md`: `codex review` não tem `--json` nem
  `--output-schema`; `codex exec review` aceita `--output-schema` e **o ignora em silêncio** (medido).
- Digest #27 e `addendum-checker-contract-review-result.md` §2.1: piso de entrada headless de ~19,4k
  tokens (`usage.input_tokens = 18738` medido) — `--ignore-user-config` é obrigatório, não estético.
- Digest #32: `review-result.schema.json` e o runtime divergem em `classify_dispatch` e
  `Runtime.review`; o efeito é `intent_gap` para humano que nunca escala e `stagnation` disparando
  falso. Adotar a forma rica corrige os dois.
- `judgment-J3-durability-security-cost.md` §5: Checker herdando `--sandbox workspace-write` é "um
  revisor com permissão de escrita", contra I28; e `no_checker_family_available → parked` é o único
  destino aceitável.

## Trade-offs

Duas famílias por story significa dois pisos de entrada por rodada de revisão (≈390k tokens por missão
de 20 stories só no piso do Codex, J3 §6) — pago conscientemente, podado pela receita de chamada curta
e por `review.max_diff_bytes` = 60 000 chars (ADR 0011, E13). `--ignore-user-config --ignore-rules
--ephemeral` descarta AGENTS.md e skills globais do usuário: todo contexto do Checker tem de vir pelo
Context Pack, inclusive os invariantes do repo e o `AGENTS.md` mínimo escrito pelo engine. O corte do
diff pode esconder do Checker um arquivo relevante mal ordenado; o ponteiro de drill-down é a
mitigação, e o p90 de diff por story é [hipótese] até o dogfood. `--permission-mode plan` limita o que o
Checker de portão consegue inspecionar por conta própria.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| `codex review` / `codex exec review` | sem saída estruturada utilizável (digest #6) |
| Checker único para rodada e portão | precisão e cobertura têm vencedores diferentes (digest #5) |
| Modelo barato como revisor | economia marginal num orçamento dominado por rework (digest #17) |
| Checker com escrita (`workspace-write`) | contraria I28; J3 §5 |
| `review-result` no formato herdado | defeito latente mede escalação errada (digest #32) |
| `review-result` sem `sources[]` | sem digests do pack, `cited` nunca é verdadeiro e a telemetria de contexto morre (E8) |

## Como reverter

Gatilho: benchmark novo que inverta precisão/cobertura, ou `codex review` ganhar `--output-schema`.
Custo: linha de roteamento em `~/.ade/routing.jsonl` e config; o `review-result` não muda.

## Consequências para outros documentos

`schemas/review-result.schema.json`, `docs/specs/` (ciclo por story, rework, escalação), ADR 0003
(casos de teste renomeados pela forma rica), ADR 0005, ADR 0015.
