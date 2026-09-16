# ADR 0019 — Rejeições: o que a ADE não adota e o que mudaria isso

**Status:** aceito 2026-09-17

## Contexto

A rodada de pesquisa avaliou dezenas de projetos, produtos e técnicas como candidatos a dependência,
método ou passo do ciclo. Uma rejeição sem motivo escrito volta como proposta a cada revisão. Este ADR
fixa doze rejeições e, para cada uma, o sinal concreto que abriria reavaliação.

## Decisão

Nenhum dos itens abaixo entra na v1. Cada linha é uma rejeição com gatilho de reavaliação declarado.

| Item | O que é | Por que rejeitado | O que promoveria reavaliação |
| :--- | :--- | :--- | :--- |
| **BMAD Method v6** | Método spec-driven completo (PRD → épicos → stories, `bmad-loop`) | ~1,76 MB em 29 skills, ordem de grandeza acima de todos os concorrentes; a spec da ADE já existe e é melhor que o que o template geraria (`landscape-dev-workflows.md` (a)) | Nada — a lição ("cerimônia proporcional ao tamanho da mudança", v6.12) já foi absorvida nas classes de complexidade (ADR 0008) |
| **Vibe Kanban** | Board com workspace, branch e terminal por agente | README abre com "Vibe Kanban is sunsetting" (2026-04-10); última release 2026-04-24; 540 issues abertas (#24) | Nada. Mas **diff review com comentário inline devolvido ao agente** é feature candidata ao painel v0.4+ |
| **Claude Squad** | TUI Go, tmux + worktree por agente | **AGPL-3.0** (#24); e tmux exige WSL/MSYS2 no Windows | Relicenciamento. O par tmux+worktree segue como design de referência, não como código |
| **RouteLLM** | Roteador treinado forte/fraco | Abandonado, último push 2024-08-10 (#24; `landscape-routing-skills-terminal.md` §2) | Nada como dependência. O paper vale como prova de que roteamento binário funciona — a ADE roteia por papel com fallbacks (ADR 0005) |
| **`alibaba/open-code-review`** | Pipeline de revisão de código multi-agente | REJECT total, revogando um ADAPT anterior de `ref-tools.md` (`addendum-checker-contract-review-result.md` §9) | Perde a razão de ser: o Checker já é `codex exec --output-schema` com `review-result` (ADR 0006) |
| **ComposioHQ/awesome-claude-skills** | "Lista curada" de skills | Não é curada: vendoriza 864 SKILL.md, 832 dos quais são wrappers templatados do Rube MCP (#12) | Curadoria real com licença declarada por skill |
| **MCP de browser no caminho automático** | Playwright MCP / Chrome DevTools MCP | 58–70 ferramentas injetadas no contexto por chamada (#21); a ADE usa Playwright como **biblioteca** no engine | Nada no caminho automático. MCP segue disponível para uso manual do operador no takeover |
| **Pixel-diff como portão de story** | `toHaveScreenshot`, Lost Pixel | Não existe baseline numa tela que acabou de nascer; rubrica responde "isto é bom?", pixel-diff responde "isto mudou?" (`landscape-evals-visual.md`). Lost Pixel **arquivado** em 2026-04-22 (#24) | Modo manutenção/rotinas: capturas do último `complete` viram goldens candidatos, e o diff liga só quando o operador aprova a tela |
| **Mem0 / Letta (MemGPT) / Zep** | Memória de agente como serviço | Números são do próprio fornecedor e há **disputa pública de metodologia entre eles**; Letta tem p95 de busca de 59,82 s, inviável para o loop (`landscape-context-observability.md` §3.3) | Benchmark independente. A memória da ADE é o journal + o Context Pack, que são auditáveis |
| **`codex review` como Checker** | Subcomando de revisão do Codex | Não tem `--json`/`--output-schema`; `codex exec review` **aceita `--output-schema` e o ignora em silêncio** (medido, #6) | Suporte real a schema no subcomando `review` |
| **`--bare`** | Flag de isolamento do Claude Code | Quebra a autenticação por assinatura (#9). O isolamento correto é `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `--bare` deixar de quebrar a assinatura |
| **Avaliador visual em modelo barato** | Juiz de rubrica num modelo menor | Economiza centavos num orçamento dominado pelo rework (10–50×); o juiz deve ser o melhor multimodal de família diferente (#17). O teto de custo vale para o rework, não para o juiz | Medição mostrando concordância do modelo barato com o forte dentro da banda da rubrica (ADR 0010) |

## Evidência

Digests #6, #9, #12, #17, #21, #24; `landscape-dev-workflows.md` (a) e b5;
`landscape-harnesses.md` §186–190, §286–287, §307; `landscape-evals-visual.md` §485–487;
`landscape-context-observability.md` §3.3; `landscape-routing-skills-terminal.md` §2 e §4.4;
`addendum-checker-contract-review-result.md` §9 e §595; `ref-skill-sources.md`.

Fora desta tabela e igualmente rejeitados por documentos próprios: Gas Town (22,7 % de CI verde medido
pelo próprio org, ADR 0014), Conductor (macOS, fechado), Crystal/Nimbalyst (parado ~7 meses),
Taskmaster (~5 meses sem push), OpenCode como 4º provider (custa o princípio "sem chave de API",
ADR 0004/0005).

## Trade-offs

Rejeitar em bloco significa reimplementar coisas que existem — seleção de skills, revisão, memória. A
troca é deliberada: `architecture.md` §1 lista três coisas insubstituíveis e trata o resto como consumo
de capacidade nativa. Dependência de terceiro no caminho crítico é superfície de manutenção; e o
levantamento mostra que a metade desses projetos morreu ou mudou de dono dentro do período da pesquisa.

## Alternativas rejeitadas

A alternativa global — adotar um orquestrador de terceiros como base (Gas Town, Conductor, Vibe Kanban,
Claude Squad) — é rejeitada por licença (AGPL), plataforma (macOS-only), abandono (sunsetting, parado) ou
resultado medido (22,7 % de CI verde). Nenhum orquestrador de terceiros entra como dependência (#24).

## Como reverter

Cada linha carrega seu próprio gatilho. Regra comum: reavaliação exige **fonte primária nova** (release,
licença, medição independente), nunca argumento de popularidade. Custo de reverter uma linha isolada é
local — nenhuma dessas rejeições está codificada em contrato ou schema, só em qual código a ADE escreve.

## Consequências para outros documentos

`docs/catalog-sources.md` e `docs/research/ref-tools.md` (marcar `alibaba/open-code-review` como
`REJECT (revogado)`; `ComposioHQ/awesome-claude-skills` fora da allowlist),
`docs/research/landscape-harnesses.md` (nenhum texto da ADE pode citar Vibe Kanban, Crystal/Nimbalyst ou
Gas Town como estado da arte vivo), `docs/specs/` (Playwright como biblioteca, nunca MCP no caminho
automático), ADR 0004, ADR 0005, ADR 0006, ADR 0009, ADR 0010, ADR 0011, ADR 0014, ADR 0018, ADR 0020.

## Emendas (2026-09-17)

Fonte: `architecture.md` §12 (revisão adversarial). Sete rejeições novas, com o mesmo formato desta ADR
(rejeição + gatilho de reavaliação onde aplicável).

- **E41** REJ Estender `--disallowedTools` a `Read`/`Glob`/`Grep` com globs de caminhos negados: não é
  fronteira real (best-effort sobre o próprio agente). Fica registrado como limite conhecido em security
  §11; a contenção de leitura de segredos na v1 continua sendo o `env` filtrado (I49) + ausência de
  credencial no processo.
- **E52** REJ ADR de rotinas autônomas (`routine_budget`, `scope_paths`, política de PR). Rotinas são
  pós-v1 (vision §2.13); o ADR abre quando entrarem no roadmap.
- **E57** REJ Recalcular agora os totais de duração de E37. A medição da semana 1 do slice 1 replaneja os
  números; até lá ficam [hipótese].
- **E60** REJ Purga de segredo em blob na v1. Mantido o quarentenamento em `refs/ade/quarantine/`, nunca
  empurrado, com alerta do doctor; purga é comando manual pós-v1.
- **E61** REJ `max_tokens_in`/`max_tokens_out` em `mission_budget`. `max_usd` + `prices.json` cobrem as
  famílias com custo reportado; nas demais o teto é `max_model_calls`.
- **E62** REJ Cancelar story `running` (`operator_cancel`). Ctrl-C para o lote inteiro (lease +
  reconciliação) e `ade discard` trata a story depois; sem transição nova (ver também ADR 0013).
- **E69** REJ Contadores de cota por família no doctor. Subsistema de medição novo, fora da v1 (ver
  também ADR 0017).
