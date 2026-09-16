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
significativo (judgment-J1-implementability.md §2, falha 3). **Reinterpretado 2:** na faixa rápida o
eval é escrito pelo próprio Maker na mesma chamada, com `author: 'maker'` gravado, justamente para
que a telemetria mostre se a concessão custa defeitos escapados (judgment-J2-journeys.md §4).

### 2.3 Poder sem caos

**Cumpre parcialmente, por escolha.** Estados explícitos, checkpoints, portões, orçamentos e journal
com write-ahead — sim. **Reinterpretado:** o DAG deixa de ser central. O harness de longa duração da
Anthropic usa lista plana de features com um único campo gravável (digest #22); a v3 adota `passes`
como único campo gravável pelo agente e trata `depends_on` como opcional — DAG só quando o plano o
declara (C14). O DAG tem de se pagar por classe de complexidade, não por elegância.

### 2.4 Capability Registry, não dogma de marca

**Cumpre.** `capability-set.schema.json` por família, `probe_ok/probed_at` **medidos** por `ade
doctor` com chamada real, roteamento por papel com primário + 2 fallbacks (ADR 0005).
**Reinterpretado:** "Claude implementa / Codex revisa / Gemini pesquisa" não sobreviveu inteiro.
CR-bench (digest #5) mostra Claude 32,1 % de pass rate contra 20,1 % do Codex, com o Codex ganhando
em precisão (88 % vs 78 %): daí a separação entre **Checker de rodada** (precisão, Codex) e **Checker
de portão** (cobertura, Claude), ADR 0006. E a família Google é `agy` (Antigravity CLI), não `gemini`
— o binário `antigravity` nunca existiu e o `gemini` exigiria API key (digest #2, #3).
`Maker ≠ Checker` chaveia por `model_id`, não por binário, porque `agy` serve modelos Claude.
**Pós-v1:** 4º provider (OpenCode via ACP) custa o princípio "sem chave de API obrigatória"
(digest #36) — fica fora até que esse princípio seja revogado por decisão explícita.

### 2.5 Skill Fabric

**Cumpre, com o número corrigido.** "Centenas de skills" vira catálogo curado de 60–80: de ~1.188
SKILL.md brutos sobram ~320 de qualidade e ~60–80 relevantes para a stack (digest #13). O gargalo é o
**índice** (~60k tokens/turno para 1.188 descrições), não o corpo. Seleção externa é requisito, não
otimização: o mecanismo nativo do Claude Code trunca descrições a 1.536 chars.
**Reinterpretado:** "lazy loading" não é possível de forma uniforme — não existe diretório de skills
comum às três CLIs (digest #14); a injeção é bloco fixo do pack ordenado por id estável (cacheável).
Supply chain: sanitização estática em build time é a defesa medida (ASR 36 % → 7,2 %, digest #34),
melhor que interceptação em runtime. **Cumpre:** precedência local > catálogo, quarentena, allowlist
por licença, scripts nunca executados pelo engine (ADR 0009).

### 2.6 Intent Compiler

**Cumpre, e é o centro de gravidade da v3.** Task Contract com EARS 1:1 com eval, guardrails,
cenários, `passes` como único campo gravável (ADR 0008). Context discovery determinístico roda
**antes** de qualquer modelo, o que torna detectável a categoria "pergunta respondível pelo repo" —
e a validação recusa essa pergunta. **Reinterpretado:** "≤5 perguntas" é teto, não meta; `trivial`
faz zero e pula a entrevista inteira. **Enxerto:** "não sei" é resposta prevista — grava o default e
promove a incógnita a campo do contrato (judgment-J2-journeys.md §5.2).

### 2.7 Frontend Quality Engine

**Cumpre com números diferentes dos pedidos.** DesignBrief em 4 camadas obrigatório quando há UI — é
a única alavanca com medição causal publicada (−57 % de falhas, Vercel `design.md`). Pipeline:
portões determinísticos D1–D7 primeiro (a11y snapshot custa 200–400 tokens contra milhares por
screenshot, digest #21), screenshot só para o juiz.
**Reinterpretado, contra o pedido:** teto de **2** rodadas, não 4 — a fonte normativa (Impeccable
4.3.1) prescreve "bounded passes, not a loop" (digest #16); corte **7,5**, não 8, porque 8 é o teto
da banda calibrada e trabalho bom cairia em `awaiting_operator`; juiz é o **melhor** multimodal de
outra família, não um avaliador barato — economizar centavos no juiz num orçamento dominado por
rework de 10–50× é falso YAGNI (digest #17). **Reinterpretado 2:** "fontes genéricas banidas" vira
default penalizado, não veto: o brief vence o guardrail (digest #18).
**Pós-v1:** D6/D7 completos e a etapa dupla Claude → Codex como flag medida.

### 2.8 Pesquisa como subsistema

**Cumpre na forma mínima.** Step `research` com schema por incógnita declarada, só em classe ≥
`feature`; achado é **dado**, nunca instrução; empate vira pergunta, nunca desempate oculto (ADR
0016). **Pós-v1 (v0.5):** time paralelo 2–4 de famílias diferentes, somente-leitura — a evidência é
favorável (+90 % em pesquisa por ~15× tokens) e o critério de paralelização está estabelecido
(somente-leitura, independente, comprimível em sumário), mas o `agy` só entra depois do canário de
isolamento, porque escreveu fora do `--add-dir` sem aviso (digest #38).

### 2.9 Context engineering + token observability

**Cumpre.** Sessão nova por chamada com modelo fixo; estado externo em journal + artifacts; **Tool
Output Firewall** como componente de primeira classe (C11): bruto vira artifact, o modelo recebe
extrato (falha íntegra mas cercada como dado, sucesso resumido) e ponteiro de drill-down via
`ade show <ref>`. Telemetria por `model_call` no journal com tokens, cache, custo e pack por seção.
**Reinterpretado:** isolamento de contexto é `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
nunca `--bare` (quebra autenticação por assinatura, digest #9); e o custo em USD do Codex não existe
(digest #28), então `cost_source: 'estimated'` por tabela de preços é parte do contrato, não
imprecisão tolerada. **[hipótese]** os tetos do pack (40k global; 7,5k skills; 6k contexto
recuperado; 1,5k invariantes) são chute calibrável: o dogfood ajusta por p90. **Pós-v1:** OTel export
(`gen_ai.*` está em Development e não tem tipo de token de cache).

### 2.10 Durabilidade

**Cumpre, por porte literal.** 66 invariantes do runtime v0.17.0 (ADR 0003), journal JSONL com cadeia
de hash e `fsync` por linha, reconciliação por classe de efeito, lease com fingerprint, Git por
worktree desde o dia 1. A matriz de crash × fase (engine, worker, máquina, browser) é **critério de
aceite do slice 1**, não documentação. **Reinterpretado:** o critério de paridade herdado estava
errado — a suíte passa 93/93 no Windows, os 10 supostos falhos vêm de helpers que a ADE não porta
(digest #1). **Trade-off assumido:** o worker morre com o engine na v1 (Job Object do libuv, digest
#30): perde-se uma chamada paga em crash do engine, ganha-se contenção de árvore de processos de
graça e um único modo de falha.

### 2.11 Autonomia proporcional ao risco

**Cumpre.** `safe` / `controlled` / `restricted` com política por repositório em `.ade/config.json`
(ADR 0015); `restricted` nunca roda desatendido. **Reinterpretado:** as flags de modo desatendido são
por família e **medidas**, não declaradas; e a cerca real não é a flag — é o `env` filtrado e o
engine ser o único a rodar `git`/`gh`. O `--disallowedTools "Bash(git *)"` é best-effort por glob, e
o sandbox de SO do Claude Code não roda em Windows nativo (digest #8): `contain` é pós-fato sobre a
árvore, com canário de isolamento por família.

### 2.12 Metodologia que escala

**Cumpre.** Cinco classes (`trivial`…`project`), cada uma liberando só o processo necessário
(architecture.md §5). A faixa rápida tem eval próprio: ≤30 s até a primeira edição de arquivo-fonte,
0 perguntas, ≤2 chamadas. **Reinterpretado:** a jornada 6 ("continue enquanto durmo") **não é classe
de complexidade** — é lote com `autonomy` e orçamento de parede (`max_wall_clock_seconds`,
`max_parked_units`) que retoma sem nova entrevista (judgment-J2-journeys.md §4).

### 2.13 Rotinas autônomas

**Pós-v1, por decisão.** Dead code, cobertura, duplicação, regressão visual e poda de harness não
entram na v1. Motivo: uma rotina é uma missão sem operador pedindo — exatamente o caso em que um
falso positivo custa mais que o achado, e a v1 ainda não tem telemetria calibrada para distinguir.
O mecanismo existe (missão desatendida com orçamento de parede); falta só o agendador.

### 2.14 Versionamento da inteligência

**Cumpre parcialmente.** `runtime_stamp` (`<versão do engine>:<digest da config>`) em todo evento;
divergência numa intenção aberta vira `stale_workflow_version` até `--accept-stale-version` (ADR
0021). Skills pinadas por commit + sha256; Impeccable pinado por `ENGINE_VERSION`; modelo e effort
gravados por chamada na telemetria. **Reinterpretado:** "por que a ADE decidiu isso?" é respondido
por **derivação do journal** (`ade report`, `ade journal`), não por um banco de decisões. **Pós-v1:**
comparar versões de harness entre si exige o índice do painel (v0.4) e a ablação pareada.

### 2.15 Evolução por evidência

**Cumpre na coleta, não na ação.** `~/.ade/routing.jsonl` guarda histórico por papel; a v1 **sugere**
troca de roteamento e o humano aplica (ADR 0005). Sem ML. **Reinterpretado:** a pergunta "quando
multi-agente compensa" não é respondível na v1 porque N=1 — fica como hipótese com instrumento
pronto (campo `worktree` em todo evento desde o dia 1, digest #33).

## 3. Métricas (PROMPT.md §7) com definição operacional

Regra: métrica sem fonte no journal não existe. Toda linha abaixo é derivável de `journal.jsonl` ou
do evento `telemetry`; nada exige instrumentação nova fora do que a arquitetura já grava.

| # | Métrica | Definição operacional | Fonte |
| :-- | :--- | :--- | :--- |
| Q1 | Eval pass rate | `eval_run{phase:'green'}` com `expect_exit` satisfeito ÷ total de `eval_run{phase:'green'}` da missão | journal |
| Q2 | Prova vermelha honesta | fração de stories com `eval_run{phase:'red'}` falhando contra `tree_before`; `additive` conta separado | journal |
| Q3 | Defeito escapado | achado `severity ≥ high` de `review-result` no **portão** sobre código que já passou `green` na rodada; e, no dogfood, bug reaberto em story já `complete` | `review-result`, journal |
| Q4 | Nota visual | nota do juiz na 1ª rodada (não a final) por story com UI; e quantas stories fecharam em `awaiting_operator` visual | `visual-eval` inline |
| A1 | Intervenções humanas | contagem de `unit_state → awaiting_operator` por missão, por motivo (orçamento, loop, empate, rede, `target_role:'human'`, skill nova) | journal |
| A2 | Recuperação | reconciliações bem-sucedidas na retomada ÷ crashes; toda `recovery` é evento | journal |
| A3 | Autonomia efetiva | stories `complete` sem nenhum `awaiting_operator` ÷ stories aprovadas | journal |
| E1 | Tokens e custo | soma de `tokens_in/out/cache_*` e `cost_usd` por missão, story, papel e família; `cost_source` sempre visível — Codex nunca é `reported` | `telemetry` |
| E2 | Desperdício de contexto | `pack_bytes` por chamada e por seção (`pack_sections[]`); skill injetada com `cited:false` é desperdício nominal | `telemetry` |
| E3 | Tool output contido | `tool_output_raw_bytes` ÷ `tool_output_model_bytes`; razão baixa significa Firewall inútil | `telemetry` |
| E4 | Wall time | `at` do primeiro `step_intent` da story ao `unit_state:'complete'`, descontando intervalos em `awaiting_operator` | journal |
| R1 | Recuperação de crash | matriz crash × fase (engine, worker, máquina, browser) — verde/vermelho por célula, não porcentagem | suíte do slice 1 |
| R2 | Determinismo dos portões | duas execuções do mesmo gate sobre a mesma árvore dão o mesmo veredito (cache por árvore torna isso barato de checar) | journal |
| U1 | **Tempo até começar** | do `ade run` **até a primeira edição de arquivo-fonte no worktree** — não até a primeira linha do journal, não até o primeiro spawn. Medido por `mtime` do primeiro caminho fora de `.ade/` observado em `dirty_paths` | journal + worktree |
| U2 | Perguntas ao usuário | perguntas efetivamente apresentadas na entrevista (não as candidatas), por classe; recusadas pelo discovery contam à parte | journal (`decision`) |
| U3 | Conhecimento exigido | número de comandos e flags distintos que o operador digitou numa missão bem-sucedida; alvo v1: `ade run` + `ade report` cobrindo a jornada 1 inteira | journal (`decision`), shell history do dogfood |
| U4 | Custo de voltar atrás | comandos para descartar um lote inteiro; alvo: 1 (`ade discard <missão>`) | definição |

U1 é a métrica que o painel de arquiteturas apontou como incomparável entre propostas (J2 §5.1): as
três definiam "começar" de forma diferente. A definição acima é a única que não pode ser satisfeita
escrevendo metadado. Ela é **critério de aceite do slice 1** na faixa rápida: ≤30 s, 0 perguntas,
≤2 chamadas.

**[hipótese]** Todos os alvos numéricos além de U1/U4 são calibráveis, não contratuais. A v1 coleta;
a calibragem vem do dogfood.

## 4. Não-objetivos explícitos

Nenhum destes é "ainda não" por falta de tempo; cada um é uma escolha com motivo.

| Não-objetivo | Motivo |
| :--- | :--- |
| Ser um orquestrador multi-agente genérico | O valor está no contrato e no portão, não em rodar N agentes. Cognition "don't build multi-agents" ataca escritores paralelos sem contexto compartilhado — e é esse o modo que a ADE recusa |
| Substituir a CLI do usuário | A ADE **usa** `claude`/`codex`/`agy` headless; quem quiser conversar com o modelo usa `ade takeover` e volta |
| Exigir chave de API | Tudo roda sobre assinaturas já autenticadas. Consequência aceita: sem 4º provider na v1 |
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
   ≤2 chamadas, eval vermelho→verde gravado. Se a jornada 1 ficar cara, a arquitetura falhou por
   excesso de processo — e isso é bug, não sofisticação.
2. **Jornada 6 é desatendida em dogfood.** Um lote aprovado à noite, com `autonomy` e orçamento de
   parede, avança sozinho, para em `awaiting_operator` ao esgotar o backlog, e de manhã cabe num
   `ade report` legível. A própria ADE é o repositório do teste.
3. **Nada se perde.** A matriz de crash × fase fecha verde: matar engine, worker, browser ou a
   máquina em qualquer fase não redespacha efeito já feito nem perde trabalho de árvore. 93/93 da
   suíte portada nos dois SOs, com tabela de mapeamento onde o nome do caso mudou.
4. **Qualidade é provada, não relatada.** Toda story `complete` tem eval vermelho e verde gravados,
   revisão de família diferente por `model_id`, e — quando há UI — nota de juiz ≥7,5 com
   especificidade ≥7 ou uma escolha humana registrada.
5. **O custo é visível e limitado.** Toda missão tem custo por chamada, por papel e por família no
   journal, com `cost_source` honesto, e nenhum estouro de orçamento passa em silêncio.
6. **A superfície mínima basta.** Uma missão completa da jornada 1 exige do operador dois comandos
   (`ade run`, `ade report`) e nenhum conceito de worktree, lease, pack ou família.

Fora dessa lista: painel (v0.4), PTY embutido (v0.5), N>1, ACP, rotinas, ablação automática — todos
reversíveis porque engine e contratos já carregam os campos (architecture.md §1).

## 6. Divergências propostas

Objeções à `architecture.md` para a revisão adversarial decidir. Nenhuma altera decisão aqui.

**D1 — Telemetria é por `model_call`; as métricas de §7 são por missão.** `architecture.md` §4 define
`Telemetry` com `mission_id/story_id/step_id` mas só emite um evento por chamada de modelo. As
métricas A1, A3, U2, U3 e E4 exigem varrer o journal inteiro e reconstruir estado — barato hoje,
caro quando o dogfood tiver centenas de missões, e frágil porque "intervenção humana" e "pergunta
apresentada" não têm evento canônico (hoje caem em `decision`, que é genérico). **Proposta:** um
evento `kind:'telemetry'` de forma `mission_summary` emitido no fechamento da missão, com contagens
já derivadas. Evidência: judgment-J2-journeys.md §5.1 ("nenhuma métrica de UX do PROMPT §7 tem
eval"); `architecture.md` §4, `interface Telemetry`. Custo: ~30 linhas e um campo no schema
`journal-event`, antes do primeiro commit — depois é migração de `format_version`.

**D2 — A superfície da CLI contradiz o north star.** São 17 comandos na v1 (`ade run`…`ade catalog`).
O critério U3 pede que a jornada 1 caiba em dois. **Proposta:** marcar explicitamente em
`docs/architecture.md` §CLI e no `--help` a divisão entre superfície **operacional** (`run`, `report`,
`decide`, `discard`) e **avançada** (o resto), com o `--help` curto listando só a primeira. Evidência:
`PROMPT.md` §7 ("conhecimento exigido do operador"); judgment-J2-journeys.md §0, critério J2-3
(nenhuma proposta pontuou acima de 7 nesse critério). Custo: zero de engine, só apresentação.

**D3 — Aprovação visual preguiçosa não tem veículo na v1.** `architecture.md` §7 promete
"`awaiting_operator` com screenshots lado a lado para escolha preguiçosa", mas na v1 o veículo é
`report.md` e o painel só chega na v0.4: o operador teria de abrir PNGs à mão a partir de caminhos do
journal. **Proposta:** `ade show <ref> --open` abrindo o comparativo no visualizador padrão do SO
(uma chamada a `start`/`xdg-open`), ou um HTML estático de uma página gerado junto do `report.md`.
Evidência: judgment-J2-journeys.md §5.4 (item "o que nenhuma proposta resolve"). Custo: ~20 linhas.

**D4 — "Mudar de ideia no meio" segue sem resposta na v1.** Steering é adiado para o ACP (ADR 0004) e
até lá o usuário espera o turno fechar ou assume o terminal. Numa missão desatendida de jornada 6
isso significa que uma correção de rumo às 2h só vale de manhã. **Proposta:** `ade steer <missão>
"<nota>"` gravando um evento `note` consumido pelo `prepare` da próxima story (entra no pack como
seção "rodada"), sem tocar em turno em andamento. Não é steering real e não deve ser chamado assim;
é enfileiramento de intenção entre stories. Evidência: judgment-J2-journeys.md §5.5. Custo: um
comando, um tipo de nota, uma seção de pack já existente.

## 7. Perguntas em aberto

1. **Q3 (defeito escapado) não tem detector fora do dogfood.** Sem produção nem usuários, "escapou"
   só é observável quando a própria ADE reabre uma story. Isso torna Q3 medível apenas no dogfood da
   própria ADE — aceitável na v1, mas a métrica não generaliza para repositórios de terceiros.
2. **U3 depende de shell history** para a parte "flags distintas digitadas". Há um instrumento mais
   honesto (o engine registra o `argv` que recebeu) — vale gravar `argv` do próprio `ade` no evento
   de abertura de missão? É dado do operador, não do agente.
3. **Corte 7,5 e teto de 2 rodadas** são calibração declarada como decisão (ADR 0010), mas a banda foi
   derivada de uma rubrica de 40 pontos de outra fonte. Quantas stories de UI o dogfood precisa
   produzir antes de a calibragem valer? **[hipótese]** ~20.
4. **Orçamento default por classe** não está fixado em lugar nenhum (`budget` é campo obrigatório do
   contrato, mas quem escolhe o número na faixa rápida?). Sem default, `trivial` depende do Intent
   Compiler inventar um teto — e um teto inventado alto é o modo de falha caro da jornada 6.
5. **"Software de alta qualidade" não tem definição operacional fora de UI.** Para frontend existe
   rubrica e corte; para backend, "qualidade" é hoje só "evals verdes + revisão aprovada". Falta
   decidir se isso basta para a v1 ou se algum portão de qualidade não-visual (complexidade,
   duplicação) entra antes do merge.
