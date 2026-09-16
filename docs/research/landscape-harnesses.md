# Landscape — harnesses de coding agentico e orquestracao multi-agente (2025–2026)

Data da pesquisa: 2026-09-16. Escopo: decidir a arquitetura de execucao da TL-ADE (spec v2,
`docs/specs/2026-09-16-ade-design.md`). Cada secao responde uma decisao; o que nao move decisao ficou de fora.

Classificacao usada em toda a pagina: **[verificado: fonte]** = afirmado na fonte primaria citada;
**[inferido]** = conclusao minha a partir de fontes verificadas; **[hipotese]** = plausivel, sem evidencia.

---

## 1. Padrao de controle para missoes de muitas horas

### 1.1 O que as fontes primarias dizem

| Fonte | Data | Afirmacao relevante |
| :--- | :--- | :--- |
| Anthropic, *Building effective agents* | 2024-12-19 | "**Workflows** are systems where LLMs and tools are orchestrated through predefined code paths. **Agents** [...] dynamically direct their own processes"; "workflows offer predictability and consistency for well-defined tasks"; autonomia traz "higher costs, and the potential for compounding errors" [verificado] |
| Anthropic, *Effective harnesses for long-running agents* | 2025-11-26 | Harness = **initializer agent** (uma vez) + **coding agent** (cada sessao). Artefatos: `init.sh`, `claude-progress.txt`, repo git com commit inicial, `feature_list.json`. Regra por sessao: "Read the features list file at the beginning of a session. Choose a **single** feature to start working on." Orientacao fixa de abertura: `pwd`, ler git log + progress file, subir `init.sh`, rodar e2e basico. Fim de sessao: codigo em estado mergeavel, "no major bugs, the code is orderly and well-documented" [verificado] |
| Anthropic, *Effective context engineering for AI agents* | 2025-09-29 | **Context rot**: "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases". Objetivo: "smallest set of high-signal tokens". Tres tecnicas de longo horizonte: compaction, structured note-taking (memoria externa em arquivo), sub-agentes com contexto limpo [verificado] |
| Cognition (Walden Yan), *Don't build multi-agents* | 2025-06-12 | Dois principios: "Share context, and share full agent traces, not just individual messages"; "Actions carry implicit decisions, and conflicting decisions carry bad results". Recomenda "single-threaded linear agent"; compressao por LLM dedicado "is hard to get right" [verificado] |
| OpenAI Agents SDK, *Orchestrating multiple agents* | doc viva 2026 | "orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance"; padroes de codigo: chaining, evaluator loop em `while`, paralelismo com `asyncio.gather` [verificado] |
| Google ADK, *Workflow agents* | doc viva 2026 | `SequentialAgent`/`ParallelAgent`/`LoopAgent` determinam a ordem "without consulting an AI model for assistance with the orchestration", dando "deterministic and predictable execution patterns". Nota: os workflow agents de template foram "superseded by more flexible workflow structures, **including graph-based workflows**" [verificado] |
| Geoffrey Huntley, *Ralph Wiggum as a software engineer* | 2025-07-14 | `while :; do cat PROMPT.md \| claude-code ; done`. Estado fora do agente: `PROMPT.md`, `fix_plan.md`, `specs/`, `AGENT.md`. Regra: "only one thing per loop". Escopo: "There's no way in heck would I use Ralph in an existing code base" — greenfield, ~90% de completude [verificado] |
| SWE-EVO (arXiv 2512.18470v5) | 2026-04-04 | 48 tarefas de *evolucao de software* (media 21 arquivos, 610+ linhas, 874 testes). Melhor modelo: **25% resolved rate**, contra 72.80% do mesmo tipo de modelo em SWE-bench Verified. >60% das falhas dos modelos fortes sao **instruction following** (interpretar mal o requisito), nao sintaxe [verificado] |

### 1.2 Leitura

Nenhuma fonte primaria de 2025–2026 defende **sessao unica longa com compaction** como *design*. A compaction
aparece sempre como mitigacao de ultimo recurso, ao lado de nota estruturada e sub-agente — e o proprio artigo de
context engineering trata perda de fidelidade com o crescimento do contexto como fato arquitetural, nao como bug a
ser espremido [verificado: Anthropic 2025-09-29]. O harness que a Anthropic publica para trabalho de muitas horas
**nao e uma sessao longa**: e uma sequencia de sessoes curtas, cada uma lendo o estado de arquivos versionados e
entregando a arvore limpa [verificado: Anthropic 2025-11-26].

Cognition parece contradizer a ADE, mas nao contradiz. O alvo do texto e **decomposicao paralela entre escritores
sem contexto compartilhado** (o exemplo do Flappy Bird: um subagente faz fundo de Super Mario, outro faz um passaro
incompativel). O antidoto proposto — contexto integral e uma linha de decisao so — e exatamente o que um DAG com
concorrencia 1 + Context Pack montado por codigo entrega, com a vantagem de que o "trace compartilhado" vira um
journal deterministico em vez de um resumo produzido por LLM, que o proprio autor classifica como dificil de acertar
[inferido, sobre Cognition 2025-06-12].

SWE-EVO e o dado que mais deve mudar o desenho: o gargalo de horizonte longo em 2026 **nao e tamanho de contexto,
e interpretacao de requisito** — mais de 60% das falhas dos modelos fortes [verificado]. Autonomia extra nao corrige
isso; contrato de tarefa estreito e verificavel corrige. Isso empurra investimento do orquestrador para o Intent
Compiler e para o eval, nao para a janela.

Ralph confirma a forma (loop determinista, estado em arquivo, uma coisa por iteracao) e refuta o uso na ADE como
motor: o proprio autor exclui base de codigo existente, que e o caso universal que a ADE persegue [verificado].
O que sobra de Ralph e o padrao `fix_plan.md` — fila priorizada fora do agente — que a ADE ja tem melhor na forma
de DAG + journal.

### 1.3 Veredito sobre a tese da ADE

**Tese confirmada**: DAG deterministico + journal + sessao nova por story. Convergencia de cinco fontes primarias
independentes (Anthropic harness, Anthropic context engineering, OpenAI Agents SDK, Google ADK, Ralph) sobre o mesmo
formato: **plano de controle em codigo, chamadas de modelo curtas, estado durável fora do modelo** [verificado, cada
uma na sua linha da tabela 1.1].

Ressalvas honestas:

1. Nao existe benchmark publico comparando head-to-head "DAG + sessao nova" contra "sessao longa com compaction" na
   mesma suite. A confirmacao e por convergencia de design das equipes que operam esses agentes em producao, nao por
   medicao [inferido].
2. O harness da Anthropic usa **lista plana de features**, nao DAG [verificado: 2025-11-26]. O DAG e adicao da ADE.
   Ele so se paga quando ha dependencia real entre stories; num lote sem dependencias o scheduler degenera em "proxima
   nao bloqueada". Manter, mas nao gastar complexidade de planejador em dependencia inventada [inferido].
3. Supervisor + workers nao e alternativa concorrente e sim a **forma interna de uma story**: Maker e Checker sao
   exatamente o par evaluator-optimizer de *Building effective agents* [verificado]. A ADE ja faz isso.

---

## 2. Quando multi-agente compensa

### 2.1 Evidencia

| Fonte | Numero / frase | Classificacao |
| :--- | :--- | :--- |
| Anthropic, *How we built our multi-agent research system* (2025-06-13) | Opus 4 lider + Sonnet 4 subagentes "outperformed single-agent Claude Opus 4 by **90.2%**" nas evals internas de pesquisa | [verificado] |
| idem | Agente consome ~4x os tokens de um chat; sistema multi-agente ~**15x** | [verificado] |
| idem | Compensa em "tasks that involve heavy parallelization, information that exceeds single context windows, and interfacing with numerous complex tools" | [verificado] |
| idem | Limite explicito: "most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time" | [verificado] |
| Claude Code, doc de subagentes (2026) | Subagente tem "its own context window with a custom system prompt, specific tool access, and independent permissions"; "the subagent does that work in its own context and returns only the summary". Usar para: preservar contexto, isolar saida volumosa, restringir ferramentas, pesquisa paralela independente. **Nao** usar para "iterative work requiring frequent back-and-forth" | [verificado] |
| Cognition (2025-06-12) | Escritores paralelos sem contexto integral produzem decisoes implicitas conflitantes | [verificado] |
| Anthropic multi-agent (2025-06-13) | Producao: checkpoint de estado para retomar em vez de reiniciar; tracing completo; salvaguardas deterministicas (retry) em volta da parte nao-deterministica | [verificado] |

### 2.2 Criterio que a ADE deve usar

A regra que sai da evidencia e **uma so**, e nao tem a ver com tamanho da tarefa: paralelize quando o trabalho e
**somente-leitura, independente e comprimivel num sumario**; serialize quando ha **escrita na mesma arvore**
[inferido, de Anthropic 2025-06-13 + Claude Code subagents + Cognition]. Custo de 15x so se justifica onde a
paralelizacao compra recall (pesquisa), nunca onde compra risco de merge.

Mapeamento por classe de complexidade (proposta — [inferido]; nenhuma fonte publica essa tabela):

| Classe | Forma de execucao | Paralelismo permitido | Checker |
| :--- | :--- | :--- | :--- |
| trivial (1 arquivo, efeito obvio) | 1 chamada Maker, sem DAG, sem pesquisa | nenhum | eval executavel apenas; sem Checker LLM |
| bounded (1 story, escopo fechado) | ciclo padrao da story | nenhum | Checker de outra familia, contexto = diff + spec |
| feature (2–8 stories, dependencias) | DAG, concorrencia 1 | pesquisa (2–4 agentes) na fase de plano | Checker por story |
| subsystem (9–30 stories) | DAG, worktrees concorrentes **so** entre stories com `scope_paths` disjuntos | pesquisa + leitura de base grande (familia de contexto grande) | Checker por story + revisao larga de branch no fim |
| project (greenfield / reescrita) | DAG por epic; initializer separado que gera o feature list antes do primeiro Maker | pesquisa; nunca escrita | Checker por story + portao visual + revisao de branch |

Duas consequencias diretas para a spec v2:

- A regra "concorrencia 1 na v1" (§6) esta **certa por evidencia**, nao so por simplicidade. Documentar o motivo:
  escritores paralelos na mesma arvore e o modo de falha nomeado por Cognition [inferido].
- Concorrencia entre worktrees (backlog v2) deve ganhar precondicao dura: **interseccao vazia de `scope_paths`**,
  verificada pelo engine antes de despachar, nao confianca no planejador [inferido].

---

## 3. Como os melhores harnesses tratam "pronto"

| Fonte | Mecanismo | Detalhe util |
| :--- | :--- | :--- |
| Anthropic, harness long-running (2025-11-26) | `feature_list.json` | Schema: `{"category": "functional", "description": "...", "steps": [...], "passes": false}`. Regra: "We prompt coding agents to edit this file **only by changing the status**" [verificado] |
| idem | Auto-verificacao | "Self-verify all features. Only mark features as 'passing' after careful testing" — via Puppeteer MCP (e2e de fluxo de usuario), testes unitarios e dev server [verificado] |
| idem | Estado limpo | Fim de sessao = arvore mergeavel + commit descritivo + progress file atualizado [verificado] |
| GitHub Spec Kit (137k estrelas, MIT, ativo 2026-09-15) | `/speckit-converge` | Valida a conclusao e **repete `implement` ate o status "Converged"** — laco de convergencia com estado terminal explicito [verificado] |
| OpenAI Agents SDK | evaluator loop | "in each iteration of a `while` loop, run the task agent to produce an output, then run an evaluator agent to assess" [verificado] |
| Anthropic, *Building effective agents* | evaluator-optimizer | "one LLM call generates a response while another provides evaluation and feedback in a loop" [verificado] |
| *Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering* (arXiv 2606.17799v2, 2026-07-21) | o que medir | Correcao final e metrica insuficiente; propoem medir **praticas de verificacao** (o agente testou? reagiu a falha?) e interacao com o ambiente. Reenquadra "pronto" de "resposta correta" para "solucao verificada e integrada" [verificado] |
| obra/superpowers v6.0.3 (local, MIT) | TDD vermelho/verde + revisor por tarefa | Subagente implementador fresco por tarefa; revisor de tarefa (conformidade com spec + qualidade) depois de cada uma; revisao larga do branch no fim; "Do not pause to check in with your human partner between tasks" [verificado: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.0.3/skills/subagent-driven-development/SKILL.md`] |

### 3.1 Ideias adotaveis para o Intent Compiler e o eval-first

1. **Campo unico gravavel.** O feature list da ADE (plano) deve ser legivel pelo agente e ter **exatamente um campo
   que ele pode alterar**: `passes`. Tudo o mais (descricao, steps, eval, scope) e imutavel para o Maker. Isso elimina
   a falha de "agente reescreve o criterio ate passar" sem precisar de vigilancia do Checker [verificado como pratica:
   Anthropic 2025-11-26; ADOPT].
2. **Prova de falsificabilidade por execucao, nao por julgamento.** A spec v2 (§7) confia no Checker para atestar que
   o eval "falharia sem a mudanca". Trocar por evidencia deterministica: o engine roda o eval **antes** do Maker e
   grava `eval_run{phase:"red", exit!=0}` no journal; depois do Maker grava `eval_run{phase:"green", exit==0}`. Eval
   que nasce verde e recusado automaticamente. Custa uma execucao de comando e substitui uma opiniao de LLM
   [inferido, ancorado em superpowers TDD + posicao do paper 2606.17799; ADOPT].
3. **Estado terminal `converged` explicito.** O ciclo `gates → review → rework(≤N)` da spec ja e um evaluator loop;
   falta o nome do estado de saida e um registro do que convergiu, como o `/speckit-converge` [verificado: Spec Kit;
   ADOPT nominal, baixo custo].
4. **Rotina de orientacao de sessao.** Toda sessao nova de story comeca com os mesmos passos deterministicos
   (verificar cwd, ler o journal resumido da story, subir o dev server declarado, rodar o smoke e2e) — no harness da
   Anthropic isso e prompt; na ADE deve ser **codigo do engine**, nao instrucao, porque o engine ja sabe tudo isso
   [verificado como pratica: Anthropic 2025-11-26; ADAPT].
5. **Medir verificacao, nao so resultado.** O journal ja tem os dados para um indicador barato: por story,
   quantos `eval_run` vermelhos precederam o verde. Story que fecha com zero vermelho e suspeita de eval frouxo — e a
   mesma preocupacao do §16 da spec, agora computavel [inferido; ADOPT].

---

## 4. Spec-driven: o que emprestar para o Task Contract

| Formato | Estrutura | Avaliacao para a ADE |
| :--- | :--- | :--- |
| **Kiro** (AWS) | Tres arquivos por feature: `requirements.md` (user story + criterios em EARS), `design.md` (arquitetura, sequencia, componentes), `tasks.md` (tarefas discretas). Mais `steering/` (`product.md`, `tech.md`, `structure.md`). EARS: `"WHEN [condition/event] THE SYSTEM SHALL [expected behavior]"`; exemplo verbatim: `"WHEN a user submits a form with invalid data THE SYSTEM SHALL display validation errors next to the relevant fields"` [verificado: kiro.dev/docs/specs] | **EARS: ADOPT.** Uma frase por criterio, condicao + comportamento, sem adjetivo. Mapeia 1:1 para nome de teste. Resolve exatamente o modo de falha dominante do SWE-EVO (instruction following). A separacao em tres arquivos: **REJECT** — a ADE ja tem plano+story+journal; tres markdowns por feature sao ceremonia sem leitor |
| **OpenSpec** (68k estrelas, MIT, ativo 2026-09-15) | `openspec/specs/` (verdade corrente) vs `openspec/changes/<id>/` (proposta em voo: `proposal.md`, `specs/`, `design.md`, `tasks.md`). Delta em markdown puro, verbatim: `## ADDED Requirements` → `### Requirement: Theme selection` (texto com SHALL) → `#### Scenario: User toggles dark mode` → `- **WHEN** the user clicks the theme toggle` / `- **THEN** the app switches to dark mode and persists the choice`. Ciclo `/opsx:explore → propose → apply → verify → archive`; `archive` dobra o delta na spec corrente | **Modelo delta+archive: ADOPT (conceitual).** E a peca que falta na ADE: hoje nao existe spec viva do projeto entre lotes, so plano por lote. Cada lote deveria ser um *change* que, ao fechar, arquiva seu delta numa spec acumulada do repo (`.ade/spec/`). Isso da ao classificador e ao tradutor o contexto "o que este projeto ja promete" sem reler o codigo. **Bloco `Scenario` WHEN/THEN: ADOPT** como forma canonica do criterio de aceite — cada cenario e a origem de um eval |
| **GitHub Spec Kit** (137k estrelas, MIT) | `/speckit-constitution` (principios de qualidade/teste), `specify`, `plan`, `tasks`, `implement`, `converge`; artefatos em `.specify/`; "define **what and why** before deciding **how**" | **`constitution`: ADAPT.** Equivale ao `CLAUDE.md`/`AGENTS.md` minimo da §12 + guardrails esteticos da §10; a ideia util e serem *principios versionados e citados pelos portoes*, nao prosa de contexto. **`converge`: ADOPT** (ver 3.3). Resto: coberto |
| **BMAD** (53k estrelas, ativo) | Papeis agile completos (analista, PM, arquiteto, SM, dev, QA) | Mantido como inspiracao, como ja decidido na spec. A ADE nao quer papeis; quer Maker/Checker + portoes [inferido] |
| **obra/superpowers** v6.0.3 | Brainstorm → spec em pedacos revisaveis → plano "claro para um junior sem contexto e com aversao a teste" → execucao subagent-driven | **ADOPT a metrica de qualidade do plano**: o criterio "um junior sem contexto consegue executar" e um teste operacional para o Task Contract da ADE, porque o Maker e literalmente isso: sessao nova sem historico [verificado no SKILL.md local] |

### 4.1 Forma proposta do Task Contract (sintese)

Campos obrigatorios por story, todos ja previstos no `plan.schema.json` exceto os marcados **novo**:

```
id, epic, titulo
intencao        : uma frase, o "por que"
requisitos[]    : EARS — "WHEN <evento/condicao> THE SYSTEM SHALL <comportamento observavel>"   (novo: formato fixo)
cenarios[]      : { when: "...", then: "..." }  — um por requisito verificavel                  (novo)
evals[]         : { cmd, cenario_id }           — cada eval aponta o cenario que prova           (novo: ligacao)
scope_paths[]   : arquivos/diretorios editaveis
do_not_touch[]  : fronteiras invioláveis
skills[]        : ate 3, escolhidas no prepare
familia_maker / familia_checker
passes          : bool — unico campo que o agente pode escrever                                  (novo: regra)
```

A ligacao `cenario → eval` e o que torna a auditoria possivel: um cenario sem eval e recusado na validacao do plano
(regra dura que a spec §7 ja pede, agora com onde ancorar) [inferido].

---

## 5. Orquestracao de terminal/worktree — ha algo ADOPT-avel?

### 5.1 Estado dos projetos (via `gh api`, 2026-09-16)

| Projeto | Licenca | Estrelas | Ultimo push | Estado | O que resolve |
| :--- | :--- | ---: | :--- | :--- | :--- |
| `smtg-ai/claude-squad` | **AGPL-3.0** | 8.483 | 2026-08-20 | ativo | TUI Go; tmux + worktree por tarefa; Claude/Codex/Gemini/Aider; revisao antes de aplicar |
| `BloopAI/vibe-kanban` | Apache-2.0 | 28.092 | 2026-09-15 | **sunsetting** (bloop fechou; anuncio 2026-04-10; servidor desligado, workspaces locais seguem community-led) | Kanban + workspace por agente (branch + terminal + dev server), diff com comentario inline, browser embutido com devtools, PR/merge, 10+ agentes, API HTTP + servidor MCP |
| `stravu/crystal` → Nimbalyst | MIT | 3.120 | 2026-02-26 | renomeado, ~7 meses parado no repo | App desktop; sessoes Claude/Codex paralelas em worktrees; comparar abordagens |
| Conductor (`conductor.build`) | fechado | — | — | ativo | macOS apenas; agentes paralelos em workspaces isolados; sem API publica documentada |
| `dmux` (npm, MIT) | MIT | ~1.600 | 2026-05 (release) | ativo, cadencia caiu | Pane tmux por tarefa, worktree+branch por pane, A/B de dois agentes no mesmo prompt, merge com uma tecla |
| `musistudio/claude-code-router` | MIT | 37.256 | 2026-09-16 | muito ativo | **Nao e orquestrador de worktree**: e control plane de *roteamento de modelo* entre provedores |

### 5.2 O que ja existe nativo nas CLIs instaladas (verificado localmente)

`claude 2.1.271` (`claude --help`, `claude agents --help`) [verificado: execucao local 2026-09-16]:

| Flag / comando | Efeito | Consequencia para a ADE |
| :--- | :--- | :--- |
| `-w, --worktree [name]` | cria worktree git para a sessao | **REJECT**: o engine precisa ser dono do ciclo de vida do worktree (journal referencia o caminho; Codex/Gemini nao tem equivalente). Assimetria entre familias mataria o adapter unico |
| `--tmux` (requer `--worktree`) | cria sessao tmux para o worktree | REJECT, mesmo motivo + painel usa node-pty |
| `--bg, --background` + `claude attach\|logs\|stop\|rm` + `claude agents --json` | gerenciador de sessoes em segundo plano com listagem JSON | REJECT como mecanismo (so Claude), mas **confirma que o modelo "processo destacado + id + log" e o formato certo** |
| `--session-id <uuid>` | a **ADE escolhe** o id da sessao | **ADOPT**: elimina parsing de id na saida; o journal passa a poder gravar o `session_id` antes da chamada (write-ahead de verdade) |
| `--fork-session` (com `--resume`) | retoma criando novo id, sem mutar o original | **ADOPT**: e exatamente o "rework a partir do checkpoint" da §6 — a sessao original fica auditavel |
| `--json-schema <schema>` | valida saida estruturada no proprio CLI | **ADOPT como segunda barreira** para `plan`, `research-finding`, `visual-eval`. Fonte da verdade continua sendo `ajv` no engine |
| `--max-budget-usd <amount>` (so com `--print`) | teto de gasto por chamada | **ADOPT**: transforma o orcamento por story de contabilidade *a posteriori* em limite duro *a priori* |
| `--agents <json>` | define subagentes inline | **ADOPT**: Checker/pesquisador sem escrever arquivo nenhum no worktree do usuario |
| `--tools`, `--allowed`, `--disallowed`, `--permission-mode`, `--restricted` | superficie de ferramentas | Corrige a spec: o nome `--allowedTools` da §5 nao existe nesta versao |
| `--effort <level>` | nivel de esforco por sessao | Ja previsto no adapter |

`codex-cli 0.154.0` (`codex exec --help`) [verificado: execucao local]: subcomandos `resume`, `fork`, **`review`**
(revisao de codigo contra o repo), flags `--json` (JSONL de eventos) e `--output-schema <FILE>`.

### 5.3 Decisao

**Nao adotar nenhum dos orquestradores como biblioteca ou dependencia.** Motivos, em ordem:

1. Nenhum expoe protocolo estavel para ser embutido. O unico com API HTTP + MCP (Vibe Kanban) esta em sunsetting com
   a parte servidora desligada [verificado].
2. Claude Squad e AGPL-3.0 — contaminacao inaceitavel para um pacote npm distribuido [verificado].
3. Crystal/Nimbalyst mudou de nome e o repo esta parado ha ~7 meses [verificado].
4. Conductor e macOS e fechado; a ADE e Windows-first [verificado].
5. Todos resolvem o mesmo subconjunto (worktree por tarefa + PTY + diff/merge) que a ADE precisa **acoplado ao
   journal** — e o acoplamento e justamente o que nenhum deles oferece [inferido].

O que **e** adotavel e mais barato do que qualquer um deles: as flags nativas da secao 5.2. Elas removem quatro
pedacos de codigo previstos na spec (geracao/parsing de session id, tracking de custo *a posteriori* sem teto,
validacao de schema so no engine, arquivos de subagente no worktree). O par `node-pty` + `@xterm/xterm` da §3
continua correto — e o que todos esses projetos usam por baixo, direta ou indiretamente.

Confirmacao convergente do desenho do painel: worktree isolado por tarefa, diff revisavel com comentario inline
devolvido ao agente, dev server e browser por workspace, PR com descricao gerada — a lista de features do Vibe Kanban
e quase a §11 da spec [verificado]. A ADE nao esta inventando o painel; esta reimplementando o consenso, o que e a
decisao certa dado que o consenso nao e reutilizavel.

---

## 6. Surpresas — o que contradiz a spec v2 ou o prompt

1. **§12 "Sem advisor nativo das CLIs" e falso.** `codex exec review` roda revisao de codigo contra o repositorio como
   subcomando nativo [verificado: `codex exec --help`, 0.154.0]. O Checker pode ser esse comando em vez de um prompt
   montado — mais barato e com formato estavel.
2. **§5 usa `--allowedTools`**, que nao existe no `claude` 2.1.271; os nomes sao `--tools`, `--allowed`,
   `--disallowed` [verificado].
3. **Orcamento e schema ja sao nativos.** `--max-budget-usd` e `--json-schema` existem; a spec planeja ambos so no
   engine [verificado].
4. **`claude --worktree` e `--tmux` existem.** A spec nao os menciona; a recomendacao continua sendo nao usa-los, mas
   a decisao precisa ser explicita, nao omissa [verificado].
5. **Vibe Kanban, referencia obvia do painel, esta sendo desligada** (empresa bloop fechou, anuncio 2026-04-10) e
   Crystal virou Nimbalyst com repo parado [verificado]. Qualquer texto da ADE que os cite como "estado da arte vivo"
   precisa de data.
6. **O harness de referencia da Anthropic nao usa DAG**, usa lista plana de features com um campo `passes`
   [verificado]. O DAG e contribuicao da ADE e deve justificar seu custo caso a caso.
7. **A spec confia no Checker para validar que o eval e estrito** (§7, §16). Existe substituto deterministico e mais
   barato: gravar a execucao vermelha antes da mudanca [inferido, secao 3.2].
8. **`google/adk-python` declara os workflow agents de template superados por "graph-based workflows"**
   [verificado: adk.dev]. Ou seja, a industria de framework migrou *para* o DAG no mesmo periodo — reforca a tese, e
   vale olhar o schema de grafo deles antes de inventar o da ADE.

---

## 7. Tabela final

| Projeto | Problema que ataca | Ideia util | Decisao |
| :--- | :--- | :--- | :--- |
| Anthropic — *Building effective agents* | Quando usar workflow vs agente | Workflow = caminho de codigo predefinido, previsivel; agente = flexivel e caro | **ADOPT**: DAG e workflow; autonomia so dentro da story |
| Anthropic — *Effective harnesses for long-running agents* | Agente perde memoria entre sessoes | initializer + coding agent; `feature_list.json` com `passes` como unico campo gravavel; uma feature por sessao; auto-verificacao; arvore limpa no fim | **ADOPT** (nucleo do Intent Compiler e do ciclo de story) |
| Anthropic — *Effective context engineering* | Context rot | Menor conjunto de tokens de alto sinal; nota estruturada; contexto novo por tarefa; compaction so como mitigacao | **ADOPT** (ja e a §12; agora com fonte) |
| Anthropic — *Multi-agent research system* | Quando paralelizar | +90,2% em pesquisa, 15x tokens; coding tem pouca paralelizacao real | **ADOPT o criterio**: paralelo so em leitura/pesquisa |
| Cognition — *Don't build multi-agents* | Escritores paralelos conflitam | Contexto e trace integrais; linha de decisao unica | **ADOPT**: concorrencia 1 por arvore; worktree paralelo so com `scope_paths` disjuntos |
| Ralph Wiggum (Huntley) | Loop autonomo barato | Estado em arquivo, uma coisa por iteracao | **ADAPT** a forma; **REJECT** como motor (autor exclui base existente) |
| OpenAI Agents SDK | Orquestracao | "orchestrating via code makes tasks more deterministic and predictable"; evaluator loop em `while` | **ADOPT** como confirmacao; sem dependencia |
| Codex CLI / SDK | Execucao headless | `codex exec --json`, `--output-schema`, `resume`, `fork`, **`review`** | **ADOPT** no adapter `codex`; `review` como Checker |
| Claude Code CLI 2.1.271 | Execucao headless | `--session-id`, `--fork-session`, `--json-schema`, `--max-budget-usd`, `--agents` | **ADOPT**; `--worktree`/`--tmux`/`--bg`: **REJECT** (engine e dono do ciclo de vida) |
| Google ADK | Fluxo deterministico | Sequential/Parallel/Loop sem consultar modelo; migracao para grafo | **ADOPT** como confirmacao; olhar o schema de grafo |
| SWE-EVO (arXiv) | Horizonte longo real | 25% vs 72,8%; >60% das falhas fortes = instruction following | **ADOPT a consequencia**: investir em contrato de tarefa, nao em janela |
| *Coding Benchmarks Are Misaligned* (arXiv) | O que medir | Medir pratica de verificacao, nao so correcao | **ADOPT**: indicador "evals vermelhos antes do verde" por story |
| Kiro (AWS) | Requisito ambiguo | EARS: `WHEN <cond> THE SYSTEM SHALL <comportamento>` | **ADOPT** EARS no Task Contract; **REJECT** os tres markdowns |
| OpenSpec | Spec viva vs mudanca | `specs/` vs `changes/`, delta `## ADDED Requirements` + `#### Scenario: WHEN/THEN`, `archive` | **ADOPT** cenario WHEN/THEN como origem do eval; **ADOPT** delta+archive para `.ade/spec/` |
| GitHub Spec Kit | Quando parar | `/speckit-converge` repete `implement` ate "Converged" | **ADOPT** estado terminal `converged`; **ADAPT** `constitution` |
| BMAD | Metodo agile completo | Papeis | **REJECT** (ja decidido): Maker/Checker + portoes |
| obra/superpowers 6.0.3 | Execucao de plano | Subagente fresco por tarefa + revisor por tarefa + revisao larga no fim; TDD vermelho/verde; nao pausar entre tarefas | **ADOPT** o criterio "plano executavel por junior sem contexto"; **ADOPT** TDD como prova de eval estrito |
| gstack (Garry Tan) | Solo dev com papeis | 35 slash commands, ciclo Think→Plan→Build→Review→Test→Ship→Reflect; troca de papel mediada por humano | **REJECT**: e prompt-packaging sem estado durável; numeros de produtividade nao auditaveis |
| Claude Squad | Multi-agente no terminal | tmux + worktree por tarefa | **REJECT** (AGPL-3.0); confirma o desenho |
| Vibe Kanban | Painel de agentes | Workspace = branch + terminal + dev server; diff com comentario inline; browser com devtools; API HTTP + MCP | **REJECT como dependencia** (sunsetting); **ADOPT a lista de features** como referencia da §11 |
| Crystal / Nimbalyst | Sessoes paralelas | Comparar abordagens lado a lado | **REJECT** (repo parado ~7 meses) |
| Conductor | Agentes paralelos | Workspaces isolados | **REJECT** (macOS, fechado) |
| dmux | Multiplexador | A/B de dois agentes no mesmo prompt | **REJECT como dependencia**; **ADOPT a ideia de A/B** no backlog de poda (casa com Caliper, §12) |
| Claude Code Router | Roteamento de modelo | Control plane de provedores | **REJECT**: a ADE roteia por familia de CLI, nao por provedor |
| Devin (playbooks) / Cursor background agents / Amp (Oracle) | Trabalho assincrono | Playbook = procedimento multi-step com criterio de sucesso e guardrails; Amp separa Worker (barato) de Oracle (raciocinio, contexto isolado) | **ADAPT**: o par Worker/Oracle e o roteamento de modelo da §12 (Haiku classifica, modelo forte implementa) — confirmacao, sem acao nova |

---

## 8. Perguntas em aberto

1. Nao ha medicao publica head-to-head "DAG + sessao nova por story" vs "sessao longa com compaction". A ADE pode
   produzir a primeira barata no dogfood (§15), rodando o mesmo lote nos dois modos e comparando custo e evals verdes.
2. O que exatamente sao os "graph-based workflows" que superaram os workflow agents do ADK, e se ha schema de grafo
   reaproveitavel antes de a ADE fixar o seu.
3. Situacao real de acesso ao Gemini CLI: o repo `google-gemini/gemini-cli` esta muito ativo (107k estrelas, push em
   2026-09-16), o que nao contradiz a migracao de consumo para Antigravity descrita na §5, mas a frase da spec precisa
   ser reverificada em fonte primaria do Google antes de virar decisao de roteamento.
4. Se `claude --bg` + `claude agents --json` podem substituir parte da supervisao de processo do painel para a familia
   Claude — o ganho seria real, o custo e assimetria entre adapters.
5. OpenSpec **Stores** (beta) para spec viva multi-repo: relevante so se a ADE for operar mais de um repositorio por
   missao. Fora da v1.
6. `alibaba/open-code-review` (catalogo, backlog v2) perde parte da razao de ser se o Checker passar a usar
   `codex exec review`. Reavaliar antes de integrar.

---

## 9. Fontes

Primarias — Anthropic:
- https://www.anthropic.com/engineering/building-effective-agents (2024-12-19)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09-29)
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- https://www.anthropic.com/engineering/multi-agent-research-system (2025-06-13)
- https://code.claude.com/docs/en/sub-agents (doc viva, consultada 2026-09-16)

Primarias — outras plataformas:
- https://openai.github.io/openai-agents-python/multi_agent/
- https://developers.openai.com/codex/sdk
- https://adk.dev/agents/workflow-agents/
- https://github.com/openai/codex
- https://github.com/google-gemini/gemini-cli

Metodo / spec-driven:
- https://kiro.dev/docs/specs/ e https://kiro.dev/docs/specs/feature-specs/
- https://github.com/Fission-AI/OpenSpec e https://openspec.dev/
- https://github.com/github/spec-kit
- https://github.com/bmad-code-org/BMAD-METHOD
- https://github.com/obra/superpowers (v6.0.3 lida localmente em `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.0.3/`)
- https://ghuntley.com/ralph/ (2025-07-14)
- https://cognition.com/blog/dont-build-multi-agents (2025-06-12, Walden Yan)

Orquestradores de terminal/worktree:
- https://github.com/smtg-ai/claude-squad
- https://github.com/BloopAI/vibe-kanban e https://www.vibekanban.com/blog/shutdown
- https://github.com/stravu/crystal (→ https://nimbalyst.com/)
- https://conductor.build/
- https://dmux.ai/
- https://github.com/musistudio/claude-code-router

Papers:
- https://arxiv.org/html/2512.18470v5 — SWE-EVO (2026-04-04)
- https://arxiv.org/pdf/2606.17799 — *Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering* (2026-07-21)
- https://arxiv.org/pdf/2604.18071 — *Architectural Design Decisions in AI Agent Harnesses* (2026-04)
- https://lingming.cs.illinois.edu/publications/fse2025.pdf — Agentless (FSE 2025)

Verificacoes locais (Windows 11, 2026-09-16): `claude --version` → 2.1.271; `claude --help`; `claude agents --help`;
`codex --version` → codex-cli 0.154.0; `codex exec --help`. Metadados de repositorio via `gh api repos/<owner>/<repo>`.
