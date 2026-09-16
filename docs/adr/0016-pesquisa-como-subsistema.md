# ADR 0016 — Pesquisa como subsistema: um step, uma incógnita declarada, achado é dado

**Status:** aceito 2026-09-17

## Contexto

O `PROMPT.md` pede um time de pesquisa de 2–4 agentes. Pesquisa é o único trabalho em que paralelismo
comprovadamente compra qualidade — e também o caminho mais curto para queimar o orçamento de uma missão
inteira antes de a primeira linha ser escrita. Além disso, texto trazido da web ou de um repositório de
terceiro entra no pack do Maker: é conteúdo observado, não instrução.

## Decisão

Pesquisa é **um step com classe de efeito própria** (`research`), não um modo de operação.

- **Gatilho duplo:** só roda com incógnita **declarada** no plano **e** classe ≥ `feature`. Classes
  `trivial` e `bounded` nunca pesquisam.
- **Forma v1:** uma chamada com schema (`agy --json-schema` quando o canário de isolamento passar; senão
  `claude`), saída validada contra `research-finding` (JSON Schema inline enquanto houver um consumidor
  só).
- **Time paralelo** de 2–4 agentes, famílias diferentes, **somente-leitura**: opt-in por config, classe
  `subsystem`/`project`. Empate entre achados **vira pergunta ao operador**, nunca voto do modelo.
- **Achado é dado, nunca instrução.** O `research-finding` entra no pack como seção de contexto
  recuperado, sob o mesmo teto (≤6k) e a mesma cerca inbound do Tool Output Firewall (C11); nunca na
  seção de papel ou de invariantes.
- `research_refs` no Task Contract liga o achado à story que o consumiu; o bruto vira artifact, com
  `ade show <ref>` para drill-down.

## Evidência

- Digest #21 / `landscape-harnesses.md` §269: Anthropic mede **+90,2 % em pesquisa ao custo de ~15×
  tokens**, e registra que coding tem pouca paralelização real. O critério adotado é o da fonte:
  paralelo só em leitura.
- `landscape-harnesses.md` §88–91: a regra que sai da evidência é uma só e não tem a ver com tamanho da
  tarefa — paralelize quando o trabalho é **somente-leitura, independente e comprimível num sumário**;
  serialize quando há escrita na mesma árvore (Cognition, verificado).
- Doc de subagentes do Claude Code (`landscape-harnesses.md` §82): subagente serve para pesquisa
  paralela independente e **não** para trabalho iterativo com idas e vindas.
- Digest #10: `agy --json-schema` coage a saída mesmo sob instrução explícita de desobedecer — é o que
  torna `research-finding` confiável como forma, não como conteúdo.
- Digest #38: `agy` escreveu fora do `--add-dir` sem aviso; por isso o papel dele é somente-leitura até
  o canário passar (`architecture.md` §7).
- `judgment-J3` §6, item 3: time de pesquisa ligado por padrão na v1 é um dos quatro maiores
  desperdícios estruturais do painel; só se paga em recall.
- `judgment-J3` §4 e buraco 3: nenhuma proposta cercava conteúdo observado como dado não confiável — a
  regra "achado é dado" só vale se a injeção passar pelo Firewall, não só pela boa intenção do prompt.
- Digest #34: sanitização estática em build time derruba ASR de 36,0 % para 7,2 %; defesa só por system
  prompt fica em 26,6 % — "o prompt diz para não obedecer" não é controle (ADR 0009).

## Trade-offs

Uma chamada única erra mais que quatro em paralelo, e classes `trivial`/`bounded` ficam sem pesquisa
mesmo quando ela ajudaria. Em troca, o custo de pesquisa por missão é limitado pelo número de incógnitas
declaradas — que o Intent Compiler tem de justificar — em vez de pelo apetite do modelo. O empate como
pergunta ao operador custa uma interrupção e evita a pior falha: dois achados contraditórios virando uma
decisão implícita. **[hipótese]** o ganho de recall do time de 2–4 não foi medido na stack da ADE.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Time de 2–4 agentes ligado por padrão na v1 | ~15× tokens sem recall medido nesta stack (#21, J3 §6) |
| Pesquisa livre, sem incógnita declarada | vira exploração aberta; o custo deixa de ter teto |
| Agente de pesquisa com escrita | escritores paralelos na mesma árvore são o modo de falha nomeado (Cognition) e `agy` já escreveu fora do escopo (#38) |
| Achado injetado na seção de papel do pack | conteúdo observado com autoridade de instrução; vetor de injeção (J3 §4) |
| Desempate por votação entre modelos | empate é sinal de que a incógnita foi mal formulada; volta ao operador |

## Como reverter

**Gatilho:** telemetria de missões `subsystem`/`project` mostrar que a chamada única de pesquisa é a
origem dominante de rework ou de `intent_gap`. **Custo:** o time paralelo já está desenhado e é opt-in
por config — ligar é mudar um default, não escrever código; o `research-finding` e a classe de efeito
`research` não mudam. Promover `research-finding` a schema publicado custa um arquivo em `schemas/`
quando aparecer o segundo consumidor.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`effect_class: 'research'` com regra de reconciliação),
`schemas/task-contract.schema.json` (`research_refs`), `research-finding` inline em `docs/specs/`,
`docs/specs/intent-compiler.md` (incógnita declarada como pré-condição), `~/.ade/config.json` (opt-in do
time paralelo), `docs/roadmap.md` (pesquisa como subsistema na v0.5, com canário), ADR 0005 (papel do
`agy`), ADR 0011 (cerca inbound do Firewall), ADR 0017 (`cost_source` no braço `agy`).
