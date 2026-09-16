# TL-ADE — Visão (v3, 2026-09-17)

Documento de intenção. A arquitetura é `docs/architecture.md`; o calendário é `docs/roadmap.md`. Aqui
ficam só três coisas: o que a ADE é, como os 15 princípios do pedido original sobrevivem à
arquitetura, e como se mede se ela funcionou. Nenhuma decisão de arquitetura é tomada neste arquivo.

## 1. North star

Uma **Agentic Development Environment local e universal** que transforma intenção humana simples em
software de alta qualidade com o mínimo de conhecimento operacional do usuário.

"Melhore o design dessa página" não vira prompt cru. Vira, dimensionado à complexidade do pedido:

```
intenção → interpretação → context discovery → pesquisa (se houver incógnita)
        → objetivos → restrições → direção de design → fases/epics/stories (Task Contracts)
        → skills → agentes/modelos → implementação → evals → revisão independente
        → refinamento → evidência → entrega
```

O usuário pode ser preguiçoso. A inteligência operacional mora no harness, não na cabeça dele e não
no prompt. Três consequências que valem como teste de qualquer decisão futura:

1. **O portão substitui o humano; o modelo não.** Orca: ~11k commits em 6 meses, zero revisão
   humana, ~30 portões de CI; Gas City sem malha de portões: ~23 % de CI verde (digest #40). Toda
   afirmação de "pronto" é execução gravada, nunca relato de agente — um `claude -p` reporta sucesso
   depois de ter a ferramenta bloqueada (digest #37).
2. **O gargalo é instruction following, não janela de contexto.** SWE-EVO atribui >60 % das falhas de
   horizonte longo a não seguir o contrato (`docs/research/README.md`, "Confirmações importantes").
   O investimento vai para o Intent Compiler e o Task Contract, não para um orquestrador maior.
3. **A unidade otimizada é atenção humana.** Máximo de software correto por unidade de atenção,
   tempo e custo — não máximo de agentes, não máximo de autonomia.

O que a ADE é, em uma linha: **scheduler durável + compilador de contexto + compilador de intenção**
(architecture.md §1). Todo o resto é consumo de capacidade nativa já medida nos binários instalados.

## 2. Os 15 princípios reconciliados

Ordem e numeração de `PROMPT.md` §3. Para cada um: como a v3 cumpre, o que fica pós-v1, o que foi
reinterpretado.

### 2.1 Menos prompt, mais harness

**Cumpre.** Context Pack com ordem fixa por volatilidade, teto por seção e manifesto como evidência
(architecture.md §7, C10). Hierarquia do princípio virou a ordem literal das seções do pack.
**Reinterpretado:** o *harness doctor* da v1 **só coleta** (ADR 0017). Medir injeção, citação
(`skills_injected[].cited`) e custo por item antes de podar é pré-requisito: podar por intuição é o
mesmo erro que o princípio combate. **Pós-v1:** ablação pareada automática (protocolo Caliper,
`claude plugin eval`), com o ponto cego conhecido do braço Codex.

### 2.2 Evals definem "pronto"

**Cumpre, e endurece.** Eval nasce no contrato, roda **vermelho** contra `tree_before` e verde contra
`tree_after` (ADR 0007). Eval que nasce verde devolve a story ao Intent Compiler, não ao Maker.
**Reinterpretado:** `must_fail_before` não é universal — `strictness.mode: 'additive'` emite aviso
registrado em vez de bloquear, porque trabalho puramente aditivo (jornada 5) não tem vermelho
significativo (judgment-J1-implementability.md §2, falha 3); em troca, `additive` exige no mesmo
cenário um eval `negative` ou um spot-check `mutate` (architecture.md §11 E12). Vermelho só conta
como prova quando `red_reason` é `assertion`: `missing_target`, `compile_error` e `environment`
rebaixam para `additive` com aviso (E12) — salvo em `trivial`, onde o rebaixamento não existe porque
`additive` exigiria um `negative` ou um `mutate` que a classe não tem: a story para em
`awaiting_operator{reason:'red_unproven'}` com o diff pronto, e `ade decide --option accept_unproven`
fecha a story como `complete` com a `decision` gravada (architecture.md §12 E51). Zero teste
executado nunca é verde: o eval runner exige reporter estruturado (`--reporter=json` no Vitest/Jest,
equivalente por runner) e `numTotalTests ≥ 1`, senão o resultado é `red_reason: 'missing_target'`
(§12 E58). A validação de `eval.cmd[0]` contra os `scripts` do projeto acontece no `prepare` de cada
story, por re-discovery no worktree — no plano valida-se só a forma, para que a jornada 5 continue
cabendo numa aprovação única (§12 E63). **Reinterpretado 2:** na faixa rápida o contrato é
aprovado com `evals: []` e o eval é escrito pelo próprio Maker na mesma chamada, com
`author: 'maker'` e `eval_authored_by` gravados como `local_write` (architecture.md §11 E2),
justamente para que a telemetria mostre se a concessão custa defeitos escapados
(judgment-J2-journeys.md §4).

### 2.3 Poder sem caos

**Cumpre parcialmente, por escolha.** Estados explícitos, checkpoints, portões, orçamentos e journal
com write-ahead — sim. **Reinterpretado:** o DAG deixa de ser central. O harness de longa duração da
Anthropic usa lista plana de features com um único campo gravável (digest #22); a v3 trata
`depends_on` como opcional — DAG só quando o plano o declara (C14). O DAG tem de se pagar por classe
de complexidade, não por elegância. **Reinterpretado 2:** o contrato não tem campo gravável nenhum —
`passes` saiu do Task Contract (architecture.md §11 E1): o contrato é imutável após aprovação
(`immutable_digest`), o estado da story vive no journal (`unit_state`) e na projeção `status.json`, e
o veredito vem do `unit-result`.

### 2.4 Capability Registry, não dogma de marca

**Cumpre.** `capability-set.schema.json` por família, `probe_ok/probed_at` **medidos** por `ade
doctor` com chamada real, roteamento por papel com primário + 2 fallbacks (ADR 0005).
**Reinterpretado:** "Claude implementa / Codex revisa / Gemini pesquisa" não sobreviveu inteiro.
CR-bench (digest #5) mostra Claude 32,1 % de pass rate contra 20,1 % do Codex, com o Codex ganhando
em precisão (88 % vs 78 %): daí a separação entre **Checker de rodada** (precisão, Codex) e **Checker
de portão** (cobertura, Claude), ADR 0006. E a família Google é `agy` (Antigravity CLI), não `gemini`
— o binário `antigravity` nunca existiu e o `gemini` exigiria API key (digest #2, #3).
`Maker ≠ Checker` chaveia por `model_id`, não por binário, porque `agy` serve modelos Claude — e vale
para **todo** papel da chamada, não só o executor: a telemetria grava
`models: { role: 'executor' | 'advisor'; model_id }[]`, e `--advisor` só entra na receita quando o
modelo do advisor for observável em `modelUsage` pela sonda do doctor; até lá o Maker roda sem ele
(architecture.md §12 E66).
**Pós-v1:** 4º provider (OpenCode via ACP) custa o princípio "sem chave de API obrigatória"
(digest #36) — fica fora até que esse princípio seja revogado por decisão explícita (architecture.md
§9.3, pendente de confirmação do Erick; §9.2, duas famílias na v1, idem).

### 2.5 Skill Fabric

**Cumpre, com o número corrigido.** "Centenas de skills" vira catálogo curado de 60–80: de ~1.188
SKILL.md brutos sobram ~320 de qualidade e ~60–80 relevantes para a stack (digest #13). O gargalo é o
**índice** (~60k tokens/turno para 1.188 descrições), não o corpo. Seleção externa é requisito, não
otimização: o mecanismo nativo do Claude Code trunca descrições a 1.536 chars.
**Reinterpretado:** "lazy loading" não é possível de forma uniforme — não existe diretório de skills
comum às três CLIs (digest #14); a injeção é bloco fixo do pack ordenado por id estável (cacheável),
com ≤7,5k tokens por skill e soma ≤20k (architecture.md §11 E14).
Supply chain: sanitização estática em build time é a defesa medida (ASR 36 % → 7,2 %, digest #34),
melhor que interceptação em runtime. **Cumpre:** precedência local > catálogo, quarentena, allowlist
por licença, scripts nunca executados pelo engine (ADR 0009). Essa precedência vale dentro do
catálogo: a v1 assume repositórios do próprio operador, e skills em `<repo>/.claude/skills/` não
entram no pack nem são carregadas pela CLI, porque a chamada despachada roda sob `--safe-mode`;
"modo repositório de terceiros" é v0.5 com ADR próprio (architecture.md §12 E56). Cada entrada de
`skills_injected[]` carrega `sha256` do conteúdo injetado e `source` (`catalog@<commit>` ou `local`),
evidência de supply chain no próprio evento (§12 E59).

### 2.6 Intent Compiler

**Cumpre, e é o centro de gravidade da v3.** Task Contract com EARS 1:1 com eval, guardrails,
cenários, imutável após aprovação (ADR 0008; architecture.md §11 E1 — a única exceção de
mutabilidade é E2, o Maker preenchendo `evals` uma vez na faixa rápida). Context discovery determinístico roda
**antes** de qualquer modelo, o que torna detectável a categoria "pergunta respondível pelo repo" —
e a validação recusa essa pergunta. **Reinterpretado:** "≤5 perguntas" é teto, não meta; `trivial`
faz zero e pula a entrevista inteira. **Enxerto:** "não sei" é resposta prevista — grava o default e
promove a incógnita a campo do contrato: `TaskContract.unknowns[]` com `id`, `question`,
`kind ∈ {product_choice, external_fact, repo_fact}` e `resolved_by?`; a incógnita é do contrato, não
do plano (judgment-J2-journeys.md §5.2; architecture.md §12 E48).

### 2.7 Frontend Quality Engine

**Cumpre com números diferentes dos pedidos.** DesignBrief em 4 camadas obrigatório quando há UI — é
a única alavanca com medição causal publicada (−57 % de falhas, Vercel `design.md`). Pipeline:
portões determinísticos D1–D6 primeiro, todos dependentes de render (a11y snapshot custa 200–400
tokens contra milhares por screenshot, digest #21), screenshot só para o juiz. O lint anti-slop
(Oxlint vendorizado) saiu do FQE e virou gate por flag no Gate runner C8 (architecture.md §11 E39),
porque não depende de render.
**Reinterpretado, contra o pedido:** teto de **2** rodadas, não 4 — a fonte normativa (Impeccable
4.3.1) prescreve "bounded passes, not a loop" (digest #16); corte **7,5**, não 8, porque 8 é o teto
da banda calibrada e trabalho bom cairia em `awaiting_operator`; juiz é o **melhor** multimodal de
outra família, não um avaliador barato — economizar centavos no juiz num orçamento dominado por
rework de 10–50× é falso YAGNI (digest #17); o corte tem critério de recalibração publicado
(`escaped_visual_defects` > 10 % em 20 stories → 8,0; `awaiting_operator` em trabalho aprovado à
primeira vista → 7,0) e toda story com UI reserva 1 rodada de rework para o FQE no `prepare`
(architecture.md §11 E39). **Reinterpretado 2:** "fontes genéricas banidas" vira default penalizado,
não veto: o brief vence o guardrail (digest #18). `self_critique` do DesignBrief é obrigatório.
**v0.4a:** D1–D6 + juiz, com o conjunto bloqueante calibrado no dogfood. **Pós-v1:** a etapa dupla
Claude → Codex como flag medida.

### 2.8 Pesquisa como subsistema

**Cumpre na forma mínima.** Step `research` com schema, disparado por incógnita declarada do tipo
`external_fact` (`unknowns[].kind`, §12 E48) — não por classe (architecture.md §11 E19); o teto é que
vem da classe: `bounded` ≤1
consulta sem time, `feature`+ até 3. Achado é **dado**, nunca instrução; empate vira pergunta, nunca
desempate oculto (ADR
0016). **Pós-v1 (v0.5):** time paralelo 2–4 de famílias diferentes, somente-leitura — a evidência é
favorável (+90 % em pesquisa por ~15× tokens) e o critério de paralelização está estabelecido
(somente-leitura, independente, comprimível em sumário), mas o `agy` só entra depois do canário de
isolamento, porque escreveu fora do `--add-dir` sem aviso (digest #38).

### 2.9 Context engineering + token observability

**Cumpre.** Sessão nova por chamada com modelo fixo; estado externo em journal + artifacts; **Tool
Output Firewall** como componente de primeira classe (C11): bruto vira artifact, o modelo recebe
extrato (falha íntegra mas cercada como dado, sucesso resumido) e ponteiro de drill-down via
`ade show <ref>`. Telemetria por `model_call` no journal com tokens, cache, custo e pack por seção —
sem `compaction_events`, que saiu do evento porque sessão nova por chamada, turno único e pack com
teto tornam a compactação impossível de acontecer (architecture.md §12 E67).
**Reinterpretado:** isolamento de contexto é `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
nunca `--bare` (quebra autenticação por assinatura, digest #9); e o custo em USD do Codex não existe
(digest #28), então `cost_source: 'unknown'` é parte do contrato — uso não observado nunca vira
estimativa silenciosa (architecture.md §4, I45) — e nessas famílias o teto de gasto é
`max_model_calls`, porque tetos de token (`max_tokens_in`/`max_tokens_out`) não entram no
`mission_budget` (§12 E61). **[hipótese]** o teto do pack é contado em **bytes** (`limits.max_pack_bytes`,
default 120 000), com seção de rodada própria de 24 000 bytes e diff do Checker em
`review.max_diff_bytes` 60 000 chars (architecture.md §11 E13); "40k tokens" é alvo de projeto por
estimativa, e os tetos por seção (20k skills, ≤7,5k por skill, E70; 6k contexto recuperado; 1,5k
invariantes em forma "Must Always / Must Never") são chute calibrável: o dogfood ajusta por p90. A
seção `contract` do pack tem teto próprio de **32 000 bytes** (≈8k tokens) **[hipótese]**, dentro de
`max_pack_bytes`; estouro é `story_pack_overflow` e reabre a divisão da story (§12 E50).
`unit-result` e `review-result` carregam `sources[]` obrigatório com os digests das seções usadas —
sem isso `cited` é sempre falso (E8). **Pós-v1:** OTel export
(`gen_ai.*` está em Development e não tem tipo de token de cache).

### 2.10 Durabilidade

**Cumpre, por porte literal.** 66 invariantes do runtime v0.17.0 (ADR 0003), journal JSONL com cadeia
de hash e `fsync` por linha, reconciliação por classe de efeito, lease com fingerprint, Git por
worktree desde o dia 1. A matriz de crash × fase (engine, worker, máquina, browser) é **critério de
aceite do slice 1**, não documentação. **Reinterpretado:** o critério de paridade herdado estava
errado — a suíte passa 93/93 no Windows, os 10 supostos falhos vêm de helpers que a ADE não porta
(digest #1); 93/93 é critério da **v0.2**, e o slice 1 fecha um subconjunto nomeado de 44 casos, com
`parity-name-map.json` como artefato de entrada da v0.2 (architecture.md §11 E26). **Trade-off
assumido:** o worker morre com o engine na v1 (Job Object do libuv, digest
#30): perde-se uma chamada paga em crash do engine, ganha-se contenção de árvore de processos de
graça e um único modo de falha (architecture.md §9.5, pendente de confirmação do Erick; a branch
"anexa e espera" de I09 fica dormente e o teste de attach é v0.5+, §11 E21).

### 2.11 Autonomia proporcional ao risco

**Cumpre.** `safe` / `controlled` / `restricted` com política por repositório em `.ade/config.json`
(ADR 0015; as chaves são as de `schemas/ade-config.schema.json`, única fonte — tabelas de
configuração em prosa nos specs são derivadas e não normativas, architecture.md §12 E55);
`restricted` nunca roda desatendido — `dispatch: never` com motivo
`autonomy_requires_operator`, e `ask_operator` é enum fechado mais `note` livre (architecture.md §11
E5). **Reinterpretado:** as flags de modo desatendido são
por família e **medidas**, não declaradas; e a cerca real não é a flag — é o `env` filtrado e o
engine ser o único a rodar `git`/`gh`. O `--disallowedTools` vai em **argumento único separado por
vírgula** (forma medida, architecture.md §11 E24) e é best-effort por glob; o literal canônico da
lista vive em `adapters-capability-registry.md` §2 e os demais documentos citam por referência, sem
repetir (§12 E46). Estendê-lo a `Read`/`Glob`/`Grep` com globs de caminhos negados foi rejeitado —
não é fronteira real, é best-effort do agente sobre si mesmo —, e a contenção de leitura de segredos
na v1 é o `env` filtrado mais a ausência de credencial no processo, registrada como limite conhecido
(§12 E41). A deny-list de caminhos fora do worktree (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) vive no
`env` filtrado, no canário e no doctor, nunca no `contain`, que só vê o diff (E23). E
o sandbox de SO do Claude Code não roda em Windows nativo (digest #8): `contain` é pós-fato sobre a
árvore, com canário de isolamento por família.

### 2.12 Metodologia que escala

**Cumpre.** Cinco classes (`trivial`…`project`), cada uma liberando só o processo necessário
(architecture.md §5). A faixa rápida tem eval próprio
(`fast_lane_trivial_starts_within_30s_zero_questions`, critério de saída da **v0.3**; o slice 1 só
grava `first_source_edit_ms` como baseline — architecture.md §11 E40): ≤30 s até a primeira edição de
arquivo-fonte, 0 perguntas, ≤2 chamadas — e essas ≤2 chamadas incluem o classificador quando ele
roda, porque a classificação começa por regra determinística e só chama modelo com confiança < 0,6
ou classe ≥ `feature` (E18). O ≤30 s sobrevive à instalação de dependências porque o `prepare` cria
junction (Windows) ou symlink de `node_modules` apontando para o checkout base quando o hash do
lockfile do worktree é igual ao do base; se diverge, classe ≥ `bounded` roda o instalador do
discovery como step `prepare` e `trivial` para em `awaiting_operator{reason:'environment'}`
(architecture.md §12 E49). **Reinterpretado:** a jornada 6 ("continue enquanto durmo") **não é classe
de complexidade** — é lote com `autonomy` e orçamento de parede (`max_wall_clock_seconds`,
`max_parked_units`) que retoma sem nova entrevista (judgment-J2-journeys.md §4).

### 2.13 Rotinas autônomas

**Pós-v1, por decisão.** Dead code, cobertura, duplicação, regressão visual e poda de harness não
entram na v1. Motivo: uma rotina é uma missão sem operador pedindo — exatamente o caso em que um
falso positivo custa mais que o achado, e a v1 ainda não tem telemetria calibrada para distinguir.
**Correção:** o mecanismo **não** existe hoje, e não falta "só o agendador". `ade run --unattended`
exige baseline de eval verde e um **backlog já aprovado**, com o conjunto elegível de skills congelado
na aprovação única (architecture.md §10 A5 e §11 E33; `journeys.md` §7: backlog vazio ou story sem
contrato aprovado falha na hora). Uma rotina é exatamente a missão **sem** pedido e **sem** aprovação
prévia: não há caminho para ela produzir um Task Contract aprovado. Portanto a rotina exigirá um
caminho de aprovação novo, e os quatro atributos do pedido (orçamento próprio separado do
`mission_budget`, escopo fixo por rotina com `autonomy: safe` no máximo, evidência — rotina só abre
story se produzir eval vermelho reproduzível — e política de PR: sempre PR, nunca merge, rotina nunca
fecha sozinha) ficam **por decidir em ADR próprio** antes de qualquer implementação pós-v1 — ADR que
não abre agora: rotinas são pós-v1, e ele entra quando elas entrarem no roadmap (architecture.md §12
E52). Sinal de promoção em `roadmap.md` §10-3.

### 2.14 Versionamento da inteligência

**Cumpre parcialmente.** `runtime_stamp` em três partes
(`<core_version>:<config_digest>:<capabilities_digest>`, architecture.md §11 E7) em todo evento; só
`core_version` — constante do núcleo durável C1–C5 e C7 — bloqueia com `stale_workflow_version` numa
intenção aberta, até `ade run --accept-stale-version` (gravado como `decision`); `capabilities_digest`
existe para flagrar upgrade silencioso de CLI (ADR 0021) e não bloqueia `--unattended`: a divergência
vai ao relatório do doctor e ao `mission_summary`, seus dois leitores nomeados (architecture.md §12
E68, E67). Skills pinadas por commit + sha256; Impeccable pinado por `ENGINE_VERSION`, e `ENGINE_VERSION`
divergente do pin é **falha do doctor**, nunca aviso: o FQE entra em modo degradado, stories com UI
param em `awaiting_operator{reason:'fqe_unavailable'}` e as sem UI seguem (§12 E45); modelo e effort
gravados por chamada na telemetria. **Reinterpretado:** "por que a ADE decidiu isso?" é respondido
por **derivação do journal** (`ade report`, `ade journal`), não por um banco de decisões. **Pós-v1:**
comparar versões de harness entre si exige o índice do painel (v0.4b) e a ablação pareada.

### 2.15 Evolução por evidência

**Cumpre na coleta, não na ação.** `~/.ade/routing.jsonl` guarda histórico por papel; a v1 **sugere**
troca de roteamento e o humano aplica (ADR 0005). Sem ML. **Reinterpretado:** a pergunta "quando
multi-agente compensa" não é respondível na v1 porque N=1 na v1 (N>1 é pós-v1; nenhuma classe de complexidade libera N) — fica como hipótese com instrumento
pronto (campo `worktree` em todo evento desde o dia 1, digest #33).

## 3. Métricas (PROMPT.md §7) com definição operacional

Regra: métrica sem fonte no journal não existe. Toda linha abaixo é derivável de `journal.jsonl` ou
do evento `telemetry`; nada exige instrumentação nova fora do que a arquitetura já grava. As contagens
por missão (A1, A3, U2, U3, E4) vêm do evento `telemetry` com `scope: 'mission_summary'` emitido no
fechamento da missão (architecture.md §11 E11), sem varredura do journal inteiro.

| # | Métrica | Definição operacional | Fonte |
| :-- | :--- | :--- | :--- |
| Q1 | Eval pass rate | `eval_run{phase:'green'}` com `expect_exit` satisfeito ÷ total de `eval_run{phase:'green'}` da missão | journal |
| Q2 | Prova vermelha honesta | fração de stories com `eval_run{phase:'red'}` falhando contra `tree_before`; `additive` conta separado | journal |
| Q3 | Defeito escapado | achado `severity ≥ high` de `review-result` no **portão** sobre código que já passou `green` na rodada; e, no dogfood, bug reaberto em story já `complete` | `review-result`, journal |
| Q4 | Nota visual | nota do juiz na 1ª rodada (não a final) por story com UI; e quantas stories fecharam em `awaiting_operator` visual | `visual-eval` inline |
| A1 | Intervenções humanas | contagem de `unit_state → awaiting_operator` por missão, por motivo (orçamento, loop, empate, rede, `target_role:'human'`, skill nova) | `telemetry{scope:'mission_summary'}`, journal |
| A2 | Recuperação | reconciliações bem-sucedidas na retomada ÷ crashes; toda `recovery` é evento | journal |
| A3 | Autonomia efetiva | stories `complete` sem nenhum `awaiting_operator` ÷ stories aprovadas | `telemetry{scope:'mission_summary'}` |
| E1 | Tokens e custo | soma de `tokens_in/out/cache_*` e `cost_usd` por missão, story, papel e família; `cost_source` sempre visível — Codex nunca é `reported` | `telemetry` |
| E2 | Desperdício de contexto | `pack_bytes` por chamada e por seção (`pack_sections[]`); skill injetada com `cited:false` é desperdício nominal | `telemetry` |
| E3 | Tool output contido | `tool_output_raw_bytes` ÷ `tool_output_model_bytes`; razão baixa significa Firewall inútil | `telemetry` |
| E4 | Wall time | `at` do primeiro `step_intent` da story ao `unit_state:'complete'`, descontando intervalos em `awaiting_operator` | `telemetry{scope:'mission_summary'}` |
| R1 | Recuperação de crash | matriz crash × fase (engine, worker, máquina, browser) — verde/vermelho por célula, não porcentagem | suíte do slice 1 |
| R2 | Determinismo dos portões | duas execuções do mesmo gate sobre a mesma árvore dão o mesmo veredito (cache por árvore torna isso barato de checar) | journal |
| U1 | **Tempo até começar** | do `ade run` **até a primeira edição de arquivo-fonte no worktree** — não até a primeira linha do journal, não até o primeiro spawn. Definição operacional única para as seis jornadas: primeiro `local_write` do Maker em caminho sob `.ade/wt/<story>/` que **não** esteja em `evals[].evidence` (inclusive os evals preenchidos pelo Maker na faixa rápida, §11 E2) — isto é, o primeiro arquivo que não é o teste; medido **pelo journal** (`at` do `local_write` contra o `at` do `ade run`), não pelo `mtime` do arquivo. Esta linha é a definição operacional única de `first_source_edit_ms` (architecture.md §12 E54); `operator-surface.md` §14.4, `journeys.md` §1 e `intent-compiler.md` §3 citam por referência | journal |
| U2 | Perguntas ao usuário | perguntas efetivamente apresentadas na entrevista (não as candidatas), por classe; recusadas pelo discovery contam à parte | `telemetry{scope:'mission_summary'}`, `decision{source:'operator'}` |
| U3 | Conhecimento exigido | número de verbos de CLI distintos que o operador digitou numa missão bem-sucedida. **Alvo único**, critério de aceite verificável (não sugestão): jornada 1 = **2** verbos (`ade run`, `ade report`), jornada 6 = **6** verbos, ambos derivados de `telemetry{scope:'mission_summary'}` (verbos de CLI usados) e checados na v0.3 (J1) e na v1 (J6). Substitui o par "alvo 1 / alvo ≤4" de `operator-surface.md` §14.4, que não é alcançável com a superfície que `journeys.md` §7 já descreve | `telemetry{scope:'mission_summary'}` (verbos de CLI usados) |
| U4 | Custo de voltar atrás | comandos para descartar um lote inteiro; alvo: 1 (`ade discard <missão>`). Não há cancelamento de story `running` na v1: Ctrl-C para o lote (lease + reconciliação) e o `ade discard` trata a story depois (architecture.md §12 E62) | definição |

U1 é a métrica que o painel de arquiteturas apontou como incomparável entre propostas (J2 §5.1): as
três definiam "começar" de forma diferente. A definição acima é a única que não pode ser satisfeita
escrevendo metadado. No slice 1 ela é apenas **baseline gravado** (`first_source_edit_ms`); o alvo
completo da faixa rápida (≤30 s, 0 perguntas, ≤2 chamadas) é critério de saída da **v0.3**, no teste
`fast_lane_trivial_starts_within_30s_zero_questions` (architecture.md §11 E40) — e esse teste mede
exatamente o U1 definido na tabela (primeiro `local_write` fora de `evals[].evidence`), não o
primeiro `local_write` qualquer: na faixa rápida a primeira escrita do Maker é o eval, e cronometrar
o eval mediria outra coisa que o alvo.

**[hipótese]** Todos os alvos numéricos além de U1/U4 são calibráveis, não contratuais. A v1 coleta;
a calibragem vem do dogfood.

## 4. Não-objetivos explícitos

Nenhum destes é "ainda não" por falta de tempo; cada um é uma escolha com motivo.

| Não-objetivo | Motivo |
| :--- | :--- |
| Ser um orquestrador multi-agente genérico | O valor está no contrato e no portão, não em rodar N agentes. Cognition "don't build multi-agents" ataca escritores paralelos sem contexto compartilhado — e é esse o modo que a ADE recusa |
| Substituir a CLI do usuário | A ADE **usa** `claude`/`codex`/`agy` headless; quem quiser conversar com o modelo usa `ade takeover` (que imprime o comando e grava `takeover-<story>.cmd`/`.ps1`) e volta com `ade release`; enquanto o takeover está aberto, o `prepare` recusa despachar naquela worktree e a story fica em `awaiting_operator{reason:'takeover_open'}` (architecture.md §12 E42) |
| Exigir chave de API | Tudo roda sobre assinaturas já autenticadas. Consequência aceita: sem 4º provider na v1 (architecture.md §9.3, pendente de confirmação do Erick) |
| Ser um produto multiusuário / SaaS | Local, um usuário, um repositório por vez. Sem servidor, sem auth, sem multi-tenancy |
| Guardar memória por usuário entre missões | Memória implícita destrói determinismo; o estado é o repositório + o journal. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` é decisão, não configuração |
| Regressão visual por pixel-diff | Falso positivo dominante em UI que muda de propósito; a barra é o juiz + portões determinísticos (ADR 0019) |
| CI própria / loop de CI | A ADE entrega até o merge; o que a CI do repositório faz é do repositório |
| Depender de orquestrador de terceiros | Vibe Kanban desligado, Crystal parado, Claude Squad AGPL, RouteLLM abandonado, Aider sem push (digest #24) |
| Autonomia máxima como meta | A meta é atenção humana mínima. `restricted` nunca roda desatendido, e isso não é limitação a remover |
| Suporte a qualquer linguagem/stack na v1 | Portões, skills e FQE são calibrados para a stack do dogfood; generalizar sem medição é slop |

## 5. O que "pronto" significa para a v1

A v1 não está pronta por lista de features implementadas. Está pronta quando **seis afirmações são
demonstráveis num repositório real**, cada uma com evidência gravada:

1. **Jornada 1 é barata.** `ade run "corrija esse botão"` fecha sozinho com U1 ≤30 s, 0 perguntas,
   ≤2 chamadas, eval vermelho→verde gravado. O commit entra na base por merge fast-forward dentro de
   `safe` quando a base não mudou desde o `prepare`; se mudou, ele fica na branch da story e o
   `report.md` imprime o comando de merge — a entrega fecha sem o operador digitar verbo de git
   (architecture.md §12 E64). Se a jornada 1 ficar cara, a arquitetura falhou por
   excesso de processo — e isso é bug, não sofisticação.
2. **Jornada 6 é desatendida em dogfood.** Um lote aprovado à noite, com `autonomy` e orçamento de
   parede, avança sozinho, para em `awaiting_operator` ao esgotar o backlog, e de manhã cabe num
   `ade report` legível. A própria ADE é o repositório do teste.
3. **Nada se perde.** A matriz de crash × fase fecha verde: matar engine, worker, browser ou a
   máquina em qualquer fase não redespacha efeito já feito nem perde trabalho de árvore. 93/93 da
   suíte portada nos dois SOs (critério da v0.2), com `parity-name-map.json` onde o nome ou a semântica
   do caso mudou; o slice 1 fecha o subconjunto nomeado de 44 casos.
4. **Qualidade é provada, não relatada.** Toda story `complete` tem eval vermelho e verde gravados,
   revisão de família diferente por `model_id` (o Checker de rodada recusa `vendor` igual ao do
   Maker), e — quando há UI — nota de juiz pinado por `model_id` ≥7,5 com especificidade ≥7 ou uma
   escolha humana registrada.
5. **O custo é visível e limitado.** Toda missão tem custo por chamada, por papel e por família no
   journal, com `cost_source` honesto, e nenhum estouro de orçamento passa em silêncio.
6. **A superfície mínima basta.** Uma missão completa da jornada 1 exige do operador dois comandos
   (`ade run`, `ade report`) e nenhum conceito de worktree, lease, pack ou família.

Fora dessa lista: Skill Fabric e FQE completos (v0.4a), painel de projeção e SQLite (v0.4b), PTY
embutido (v0.5), N>1, ACP, rotinas, ablação automática — todos
reversíveis porque engine e contratos já carregam os campos (architecture.md §1).

## 6. Divergências resolvidas

As quatro objeções levantadas contra a `architecture.md` foram arbitradas em `architecture.md` §11
(2026-09-17). Decisão por item, com o texto deste documento já refletindo o resultado.

**D1 — Telemetria por `model_call` contra métricas por missão → aceita, architecture.md §11 E11.**
Além de `compaction_events`, `outcome ∈ {ok, retry, rework, park, stop}` e `ttft_ms` por chamada, o
fechamento da missão emite um evento `telemetry` com `scope: 'mission_summary'` (intervenções,
perguntas, wall time, verbos de CLI usados), e eventos `decision` passam a carregar
`source: operator | engine`. A1, A3, U2, U3 e E4 na §3 já apontam para essa fonte.

**D2 — Superfície da CLI contra o north star → aceita, architecture.md §11 E31.** `ade run <pedido>`
é a forma canônica (forma nua só quando o primeiro token não é comando e o pedido tem espaço em
branco; senão exit 4 com sugestão) e o `--help` curto separa a superfície **operacional** (`run`,
`report`, `decide`, `discard`) da avançada.

**D3 — Aprovação visual preguiçosa sem veículo na v1 → aceita, architecture.md §11 E32.** `ade show
<ref> --open` abre no visualizador do SO e o `report.md` emite caminhos absolutos por parada; o
painel de projeção continua sendo v0.4b, e não é pré-requisito da escolha preguiçosa.

**D4 — "Mudar de ideia no meio" → aceita na forma mínima, architecture.md §11 E32.** `ade steer
<missão> "<nota>"` enfileira a intenção, consumida no `prepare` da próxima story. Registrado como
**não** sendo steering intraturno: esse continua adiado (ACP, ADR 0004).

Nenhuma das quatro foi rejeitada. As pendências que sobrevivem à arbitragem estão em §7 e nos itens
de `architecture.md` §9 ainda pendentes de confirmação do Erick.

## 7. Perguntas em aberto

1. **Q3 (defeito escapado) não tem detector fora do dogfood.** Sem produção nem usuários, "escapou"
   só é observável quando a própria ADE reabre uma story. Isso torna Q3 medível apenas no dogfood da
   própria ADE — aceitável na v1, mas a métrica não generaliza para repositórios de terceiros.
2. **U3 saiu do shell history**: os verbos de CLI usados entram no `mission_summary`
   (architecture.md §11 E11). Fica em aberto só se vale gravar o `argv` completo do próprio `ade` no
   evento de abertura de missão, além dos verbos. É dado do operador, não do agente.
3. **Corte 7,5 e teto de 2 rodadas** são calibração declarada como decisão (ADR 0010, pendente de
   confirmação do Erick, architecture.md §9.4), com critério de recalibração publicado em §11 E39.
   A banda veio de uma rubrica de 40 pontos de outra fonte; o gatilho de recalibração usa 20 stories
   de UI **[hipótese]**.
4. **Orçamento default por classe** deixou de ser buraco: `architecture.md` §11 E4 fixa **[hipótese]**
   trivial 3 chamadas/1 rework, bounded 6/2, feature 10/3, subsystem e project 12/3, e §11 E3 põe
   `mission_budget` (8 h e 3 unidades parqueadas por default na jornada 6) no `batch_open`. Em aberto
   fica só a calibragem desses números no dogfood.
5. **"Software de alta qualidade" não tem definição operacional fora de UI.** Para frontend existe
   rubrica e corte; para backend, "qualidade" é hoje só "evals verdes + revisão aprovada". Falta
   decidir se isso basta para a v1 ou se algum portão de qualidade não-visual (complexidade,
   duplicação) entra antes do merge.
