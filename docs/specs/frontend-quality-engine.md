# Spec — Frontend Quality Engine (FQE)

Componente C17 de `architecture.md` §3, entregue na **v0.4a** (D1–D6 + juiz; conjunto bloqueante
calibrado no dogfood — `architecture.md` §11 E37, E39). Esta spec detalha o que a arquitetura fixa em
§3 (linha C17), §7 ("Frontend Quality Engine") e §11; não repete as decisões, só as implementa. Decisão de rumo em
`docs/adr/0010-frontend-quality-engine-impeccable-juiz-2-rodadas.md`; rejeições (pixel-diff, MCP de
browser, avaliador barato, banimento de fontes) em `docs/adr/0019-rejeicoes.md`.

Tese do componente: **~70 % dos guardrails estéticos são determinísticos hoje**
(`landscape-evals-visual.md` §4.3), e o que sobra é um critério só — especificidade. O FQE gasta
código no que é determinístico e gasta modelo uma vez por rodada, no máximo duas rodadas.

---

## 1. Detecção de tarefa com UI

Duas camadas, ambas antes do plano. Nenhuma depende do usuário dizer "isto é frontend".

**Camada 1 — sinais determinísticos do context discovery** (`architecture.md` §5 passo 2). Qualquer
sinal verdadeiro marca `has_ui` candidato:

| Sinal | Como | Peso |
| :--- | :--- | :--- |
| `S1` dependência de framework de UI | `package.json` (`react`, `vue`, `svelte`, `next`, `astro`, `solid`, `@angular/core`) | forte |
| `S2` toolchain de CSS | `tailwind.config.*`, `postcss.config.*`, `*.module.css`, `@font-face` no repo | forte |
| `S3` extensão no escopo | `scope_paths` casa `*.{tsx,jsx,vue,svelte,astro,html,css,scss}` | forte |
| `S4` brief pré-existente | `DESIGN.md` / `PRODUCT.md` na raiz (camadas do Impeccable `init`) | forte |
| `S5` script servível | `dev`/`start`/`preview`/`serve` em `scripts`, ou `visual.serve_command` já em `.ade/config.json` | médio |
| `S6` rota declarada | `visual.routes` não vazio | médio |
| `S7` léxico do pedido | "design", "página", "tela", "botão", "layout", "responsivo", "tema escuro" | fraco |

**Camada 2 — classificador** (`architecture.md` §5 passo 3): a chamada de classificação já devolve
`has_ui: boolean` com `--json-schema`. Ela decide sozinha só quando a camada 1 é ambígua (`S7`
isolado, ou `S1`–`S4` verdadeiros num repo cujo `scope_paths` não toca view).

**Regra de composição:** `has_ui = (S1|S2|S3|S4) ∧ (o escopo toca view) ∨ classificador`. Falso
positivo custa um `design_brief` que ninguém lê; falso negativo entrega slop — a regra é
deliberadamente permissiva.

**Consequência no contrato.** `has_ui` verdadeiro ⇒ `design_brief` obrigatório em `TaskContract`;
ajv recusa a story sem ele (`architecture.md` §5 passo 8). O ciclo insere o loop do FQE entre `gates`
e `review` (§5 passo 10). Story marcada `has_ui` sem `visual.serve_command` nem `visual.url`
resolvível não passa silenciosamente: o Intent Compiler pergunta o comando de serve (é uma das ≤5
perguntas) ou registra a lacuna em `TaskContract.unknowns[]` com `kind: 'repo_fact'`
(`architecture.md` §12 E48 — a incógnita é do contrato, não do plano) e grava `visual_degraded` com
motivo, e o FQE roda em modo degradado (§4.8).

Desligamento explícito: `visual.enabled: false` em `.ade/config.json` (por repositório). Vira
`decision` no journal, nunca default silencioso.

---

## 2. DesignBrief — quatro camadas

Convergência de três fontes primárias (`landscape-evals-visual.md` §4.1; nenhuma usa arquivo único).
Campo `design_brief` do `TaskContract` (`architecture.md` §4). As duas primeiras camadas são
**arquivos do repositório** lidos pelo discovery; as duas últimas nascem no Intent Compiler.

| # | Camada | Onde vive | Vida | Conteúdo |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `product` | `PRODUCT.md` na raiz | durável | produto, público, plataforma, verdade factual (números, nomes, claims que a UI pode afirmar) |
| 2 | `tokens` | `DESIGN.md` na raiz | muda em redesign | paleta como **CSS variables** com uma cor dominante + acentos nomeados, par tipográfico display/corpo, escala de espaçamento, raio, sombra, motion |
| 3 | `surface_mode` | contrato | por superfície | `persuade` \| `operate` \| `read` \| `experience` |
| 4 | `direction` | contrato | por story | `{ name, signature, self_critique }` |

**Camada 2 — regra de redação.** Regras observáveis, nunca subjetivas: *"deixe a tabela de evidência
usar a largura disponível"*, não "menos apertado" (Vercel, `landscape-evals-visual.md` §4.2). O
stylesheet **não entra no contexto do modelo** — o brief é prosa, o CSS carrega no browser. Ausência
de `DESIGN.md` numa story `feature`+ com UI gera um passo de geração (§7) antes do `implement`.

**Camada 3 — o modo escolhe a rubrica.** *"Choose the mode from the requested surface, not the
product"* — a landing de uma ferramenta continua `persuade` (`landscape-evals-visual.md` §4.1). Sem
modo, a rubrica pune dashboard por ser sóbrio e premia landing por ser barulhenta. O modo redistribui
pesos e move uma âncora:

| Modo | Especif. | Hierarq. | Tipogr. | Cor | Estados | Movim. | Âncora que muda |
| :--- | --: | --: | --: | --: | --: | --: | :--- |
| `persuade` (base) | 3,0 | 2,0 | 2,0 | 1,5 | 1,0 | 0,5 | densidade alta sem ritmo vertical vira defeito |
| `operate` | 2,0 | 2,5 | 2,0 | 1,5 | 1,5 | 0,5 | sobriedade **não** é defeito; expressão decorativa é |
| `read` | 2,5 | 2,0 | 3,0 | 1,0 | 1,0 | 0,5 | medida fora de 65–75ch vira defeito `major` |
| `experience` | 3,0 | 1,5 | 1,5 | 1,5 | 1,5 | 1,0 | ausência de um momento autorado vira defeito `major` |

Os pesos por modo são **[hipótese]**: a fonte normativa não os mede e a própria pesquisa registra
isso como pergunta aberta (`landscape-evals-visual.md` §9.7). Calibração no dogfood (§9).

**Camada 4 — direção com assinatura e auto-crítica.** `signature` é o único elemento memorável da
tela (frontend-design da Anthropic). `self_critique` é a exigência que a spec v2 não tinha: *"if any
part of it reads like the generic default you would produce for any similar page… revise that part,
say what you changed and why"*. O campo é texto e é **obrigatório** por decisão canônica
(`architecture.md` §11 E39): `minLength` em `task-contract.schema.json`, brief com `self_critique`
vazio é recusado por ajv. Ele é a única parte do brief que o juiz lê como promessa a cobrar.

### 2.1 O brief vence os guardrails

`guardrails_default` são **defaults penalizados quando o eixo está livre**, não vetos. As duas fontes
primárias de design convergem no oposto do banimento: *"the brief's own words always win"*
(`addendum-frontend-engine-anchor.md` §3, citação confirmada em `craft-floor.md`).

| Default penalizado | Detector (regra do Impeccable) | Liberado quando |
| :--- | :--- | :--- |
| fontes genéricas (Inter, Roboto, Arial, Space Grotesk) | `overused-font` (`--all-values` ignora) | `tokens` ou `direction` fixa a fonte |
| paleta clichê de IA (creme+serifada+terracota; near-black+acento ácido; broadsheet de fio 1px) | `ai-color-palette` | `tokens` fixa a paleta |
| cinzas tímidos sobre superfície colorida | `gray-on-color` | nunca na prática |
| gradiente em texto | `gradient-text` | `direction` nomeia o efeito |
| halo/glow sem offset | `dark-glow` | `tokens` define sombra com glow |
| hierarquia tipográfica plana | `flat-type-hierarchy` | nunca |
| numeração 01/02/03 decorativa, pilha ícone+título+texto | `checkNumberedSectionLabels`, `icon-tile-stack` | `direction` nomeia o padrão |
| movimento espalhado em vez de um momento autorado | — (critério 6 do juiz) | nunca |
| **kicker/eyebrow acima de heading** | `kicker-above-heading`, `hero-eyebrow-chip` | **nunca — é banimento literal** |

O último é a única exceção e é literal na fonte: *"This one is a ban, not a default: no brief earns
it back"* (`addendum-frontend-engine-anchor.md` §3, citação verificada em `craft-floor.md`).

**Mecanismo de liberação.** Quando o brief fixa um eixo, o `prepare` escreve `guardrails_default`
sem aquele item **e** registra a regra correspondente em `impeccable ignores` com escopo da missão
(o subcomando existe: `ignores list`, `ignores --help`, `addendum-frontend-engine-anchor.md` §1).
A liberação é um evento `decision` no journal; o banimento do kicker nunca é liberável.

---

## 3. Pipeline

```
gates verdes (build de produção)
  └─► serve            visual.serve_command → readiness em visual.url (timeout visual.ready_timeout_s)
       └─► capture     Playwright como BIBLIOTECA, nunca MCP
            rotas × {1280, 390} × {claro, escuro}:
              a11y snapshot · console · rede · estilos computados
       └─► D1…D6       portões determinísticos (todos dependentes de render)
                        ──reprovou?──► rework SEM chamar o juiz
       └─► screenshots viewport (fullPage: false), só agora, só para o juiz
       └─► juiz        família ≠ Maker, model_id pinado, sub-agente isolado
       └─► decisão     pass → review · rework ≤2 rodadas · esgotou → awaiting_operator
```

**Dependências antes do serve.** O serve só sobe depois que o `prepare` da story resolve
`node_modules`: junction (Windows) ou symlink para o checkout base quando o hash do lockfile do
worktree é igual ao do base; lockfile divergente em classe ≥ `bounded` roda o instalador do discovery
como step `prepare`, com `prepare_dependency_ms` na telemetria, e em `trivial` para em
`awaiting_operator{reason:'environment'}` (`architecture.md` §12 E49).

Playwright entra como biblioteca no engine. MCP de browser está fora do caminho automático: Playwright
MCP e Chrome DevTools MCP trazem 70+ e 58 ferramentas de descrição no contexto para capacidade que a
API já dá (digest #21; `docs/adr/0019-rejeicoes.md`). A ordem também é regra de custo: a11y snapshot
custa ~200–400 tokens, screenshot custa milhares (digest #21) — determinístico primeiro, imagem só
quando o julgamento estético é inevitável.

**Quem captura.** O engine, sempre — screenshot do Maker é imagem sem proveniência. Cada captura
grava `{route, width, theme, url, commit_sha, at, sha256}` no step `visual_eval`
(`landscape-evals-visual.md` §3.6.1).

**Classes de efeito.** A rodada visual inteira — serve, captura e portões D1–D6 — é `visual_eval`, com
evidência no conjunto de artefatos em `artifacts/visual/<tree>/` (a11y snapshot, console, rede, saída de
`impeccable detect --json`, screenshots) e cache por árvore, como gate; conjunto ausente ou parcial refaz
a rodada, que é idempotente, e `visual_eval` nunca fica `ambiguous` (`engine-durability.md` §3). D1–D6
**não** passam pelo Eval runner (C9): não têm fase `red`/`green` e por isso não cabem no `EvalRecord` de
`eval_run` (`engine-durability.md` §10). A chamada do juiz é `model_call` própria e segue a regra de
reconciliação de `model_call`: em crash a intenção fica `ambiguous` e a retomada repete a chamada (as
capturas já estão em `artifacts/`; o custo perdido é uma chamada, `architecture.md` §6).
`eval_run{kind: 'visual'}` fica só para o eval de contrato que invoca o FQE por fora
(`tools/ade-fqe.mjs`, `evals/README.md` §3), cujo `cmd[0]` é validado contra os `scripts` no
`prepare` da story — no plano valida-se só a forma (`architecture.md` §12 E63).

---

## 4. Portões determinísticos D1–D6

Todos code-based, todos baratos, todos **dependentes de render**, todos com evidência em
`artifacts/` (`architecture.md` §11 E39). Severidade `critical` bloqueia
sozinha; `major` bloqueia por acúmulo ≥1 também, mas entra no rework em lote.

| ID | Portão | Comando / critério exato | Sev. |
| :-- | :--- | :--- | :--- |
| D1 | console limpo | `page.on('console')`: falha se `type ∈ {error}` ou `type = warning` fora de `visual.console_allowlist` (lista de regex) | critical |
| D2 | rede sem 4xx/5xx | `page.on('response')`: falha se `status ≥ 400` e a URL não casa `visual.network_allowlist` | critical |
| D3 | contraste AA | axe-core vendorizado em `tools/axe/axe.min.js`, injetado por `page.addScriptTag`, `axe.run(document,{runOnly:['color-contrast']})`; falha se `violations.length > 0` (4,5:1 corpo, 3:1 texto grande) | critical |
| D4 | estados presentes | para cada `visual.routes[].states` (`default`,`empty`,`loading`,`error`,`focus`,`disabled`): a rota `?state=<nome>` renderiza e o a11y snapshot difere do `default`; estado declarado que não muda nada é falha | major |
| D5 | detector estético limpo **[hipótese: alvo URL nunca executado, ver abaixo]** | `impeccable detect --json <visual.url + rota>`; exit `0` limpo, `2` com achados, `1` falha operacional. Falha se houver achado `category: slop` ou `severity: error` não presente em `impeccable ignores` | major |
| D6 | responsivo | em 390 e 1280: `document.scrollingElement.scrollWidth ≤ clientWidth + 1` **e** nenhum elemento com `getBoundingClientRect().right > innerWidth + 1` | critical |

> Nota de exit codes: os `0`/`1`/`2` de D5 são do detector Impeccable, não da tabela de exit codes
> do `ade`, que é única e vive em `2026-09-17-master-spec.md` §4 (0 ok/idle; 2 recusa ou parada final;
> 3 concluído com paradas; 4 entrada inválida; 5 lease — não existem 1 nem 6; `architecture.md` §12
> E47).

> Nota de numeração: `landscape-evals-visual.md` §3.2 numera D4 como "sem scroll horizontal" e D7
> como "estados". A numeração canônica é a de `architecture.md` §11 E39 (D4 = estados, D6 =
> responsivo, sem D7) e é a usada em código, schema e journal.

**Lint anti-slop está fora do FQE.** `architecture.md` §11 E39 move o Oxlint vendorizado
(`dmmulroy/anti-slop`) para o Gate runner (C8) com nome próprio `gate:anti-slop`, gate por flag sobre
a árvore do Maker e condicionado a projeto TS/JS detectado no discovery (nas demais linguagens o
portão anti-slop é o linter nativo do projeto): ele
rejeita padrões TS/JS de baixo sinal (`no-array-filter-map`, `no-chained-type-assertions`,
`no-runtime-typeof`), é higiene de código e não depende de render — obrigar o serve e o browser a
subir para reprovar uma asserção de tipo era custo sem contrapartida. `ade doctor` continua copiando
as regras para `tools/oxlint/anti-slop/` do projeto-alvo; `dmmulroy/anti-slop` é explícito: *"This
project is meant to be vendored… There is no official npm package"* (`landscape-evals-visual.md`
§4.3).

**D5 — a limitação que decide o alvo.** No modo de arquivo estático o detector pega um subconjunto
pequeno: contra uma fixture com `background-clip:text`, `nested-cards`, `eyebrow`, `box-shadow` sem
blur e `outline:none` sem `:focus-visible`, só disparou `low-contrast` e `cramped-padding` — 2 de 6
anti-patterns plantados (`addendum-frontend-engine-anchor.md` §1.2). As regras de cor, borda e
composição recebem **valores computados de estilo**, não CSS bruto. Portanto D5 roda contra a **URL
servida**, nunca contra os arquivos do diff. Rodar D5 em modo de arquivo é o modo degradado (§4.8) e
é registrado como tal.

**Rótulo honesto: o alvo URL é [hipótese], não achado confirmado.** A pesquisa executou **só** o modo
de arquivo (`npx --yes impeccable@4.1.0 detect --json bad.html`) e a conclusão sobre a URL é explícita
na fonte como *"[inferido: comportamento observado, não documentado explicitamente na skill]"*
(`addendum-frontend-engine-anchor.md` §1.2). Não há evidência de que `detect` aceite URL como alvo.
Como D5 é o único portão estético determinístico do FQE, o rótulo fica **[hipótese]** até que uma
**sonda do `ade doctor`** execute `impeccable detect --json <url>` contra a fixture `bad-generic/`
servida (§9.1) e compare o conjunto de achados com o do modo de arquivo — é a mesma comparação que a
fixture `detector-mode/` já assere. A sonda grava `impeccable.url_mode ∈ {ok, unsupported}` em
`~/.ade/capabilities.json`. **Fallback definido antes de fechar o escopo da v0.4a:** com
`url_mode: unsupported`, D5 degrada para axe-core (já vendorizado por D3, ruleset completo em vez de
só `color-contrast`) mais as regras próprias que o brief já torna observáveis (§2.1: kicker/eyebrow,
gradiente em texto, hierarquia plana), deixa de ser bloqueante e vira sinal para o juiz; a degradação
é `decision` no journal, nunca silêncio.

### 4.8 Modo degradado

Sem serve resolvível, sem Node ≥ 22.18, ou sem rede na primeira execução do launcher do Impeccable:
D1–D4 e D6 não rodam e D5 cai para modo de arquivo (subconjunto conhecido); `gate:anti-slop` é
indiferente ao modo porque roda no C8, fora do FQE. O juiz
**não** é chamado — julgar sem captura é teatro. A story vai para `awaiting_operator` com motivo
`visual_degraded`: falha fechada, nunca aprovação silenciosa. Quando a causa é `ENGINE_VERSION`
divergente do pin, o doctor falha fechado e o motivo é `fqe_unavailable`; stories sem UI seguem
normalmente (`architecture.md` §12 E45).

---

## 5. Juiz multimodal

**Quem.** Melhor modelo multimodal de **família diferente da do Maker**, escolhido pelo Capability
Registry (`image_in: true`) e **pinado por `model_id`** em `visual.judge`. O pin é requisito de
medição, não preferência: sem ele `visual_score` anda quando o modelo muda, não quando a qualidade
muda (`landscape-evals-visual.md` §5.2). Trocar o pin é `decision` no journal e invalida a série:
`visual_score` só é comparável **dentro do mesmo juiz** (`architecture.md` §11 E9). O `model_id`
pinado vive no contrato e é replicado no registro; `judge_family` é registrado em cada `VisualEval`.
A chamada do juiz grava `models: [{ role: 'executor', model_id }]` na telemetria — a exigência de
família e `model_id` distintos do Maker vale para **todo** papel da chamada — e `--advisor` fica fora
da receita enquanto o modelo do advisor não for observável em `modelUsage` (`architecture.md` §12
E66).
Com duas famílias na v1 e Maker quase sempre Claude, o juiz recai quase sempre em Codex — "juiz único
(Codex) com Maker sempre Claude" fica registrado como **[hipótese]** explícita, não como propriedade
do desenho.

**Barato não entra.** Juiz em modelo mais barato economiza ~US$ 0,14/rodada num orçamento dominado
pelo rework (10–50×) e compra julgamento pior. O teto vale para o rework
(`landscape-evals-visual.md` §3.5; `docs/adr/0019-rejeicoes.md`).

### 5.1 Rubrica

Seis critérios ponderados. Pesos base (modo `persuade`); os demais modos redistribuem por §2.

| # | Critério | Peso base | 0–10 avalia |
| :-- | :--- | --: | :--- |
| 1 | **Especificidade** | 3,0 | a composição, o vocabulário visual e a `signature` são deste produto ou intercambiáveis com qualquer outro |
| 2 | Hierarquia e composição | 2,0 | o que importa domina; agrupamento por proximidade; densidade adequada ao modo |
| 3 | Tipografia | 2,0 | par display/corpo com personalidade; degraus de escala óbvios; medida 65–75ch |
| 4 | Cor e superfície | 1,5 | paleta coesa via tokens; dominante + acentos; tema escuro real, não inversão |
| 5 | Estados e bordas | 1,0 | vazio, carregando, erro, foco, hover, desabilitado — presentes **e desenhados** |
| 6 | Movimento | 0,5 | um momento autorado, não efeitos espalhados; `prefers-reduced-motion` com alternativa real |

**Âncoras de nota** (banda calibrada pela fonte: *"Most real interfaces score 20-32 out of 40"* →
5,0–8,0 em escala 0–10; `addendum-frontend-engine-anchor.md` §3):

| Faixa | Âncora |
| :--- | :--- |
| 0–2 | contradiz o brief, ou defeito `critical` no critério |
| 3–4 | default genérico reconhecível — a tela que qualquer gerador produziria para este pedido |
| 5–6 | correto, sem decisão própria visível (piso da banda de interface real) |
| 7–8 | decisão própria visível e sustentada em toda a tela (topo da banda; **alvo**) |
| 9–10 | raro: a decisão é a razão de lembrar a tela |

**Corte: final ≥ 7,5, critério 1 ≥ 7, nenhum critério < 6, zero defeito `critical`, D1–D6 verdes.**
Rótulo honesto: a rubrica de 6 critérios com estes pesos é **desenho da ADE inspirado no Impeccable,
não derivado dele** — a fonte usa 10 heurísticas de Nielsen num critique dual-agent mais caro
(`addendum-frontend-engine-anchor.md` §3). O 7,5 é compromisso, não medição: **[hipótese]**
(`architecture.md` §9, decisão 4, pendente de confirmação do Erick).

**Critério de recalibração publicado** (`architecture.md` §11 E39) — o número só é revisto por
gatilho escrito, nunca por impressão:

| Gatilho medido no dogfood | Ação sobre `visual.cut` |
| :--- | :--- |
| `escaped_visual_defects` > 10 % em 20 stories com UI | subir para 8,0 |
| `awaiting_operator` por `visual_cut_not_met` em trabalho que o operador aprova à primeira vista | descer para 7,0 |

O ECC (`gan-style-harness`) usa 5–15 rodadas e corte 7,0; a ADE mantém ≤2 e 7,5 por Impeccable
normativo (digest #16) e mede no dogfood (`architecture.md` §10 A14).

**Escape hatch.** Critério não avaliável vira `null` e o total é renormalizado sobre o máximo
aplicável (mecânica que o Impeccable formaliza como `/32` em vez de `/40`). Sem escape hatch o
modelo inventa nota.

### 5.2 Saída — `visual-eval`

Inline enquanto houver um consumidor só (`architecture.md` §4); vira o **9º schema publicado em
`schemas/` na v0.4b**, quando o painel de projeção passa a ser o segundo consumidor
(`architecture.md` §11 E9).

```ts
interface VisualEval {
  story_id: string; round: 1 | 2; rubric_version: string
  judge: { family: string; model_id: string }                 // pinado; igual a visual.judge
  detector: { engine_version: string; url_mode: 'ok' | 'unsupported' }  // ENGINE_VERSION efetivo (§8)
  surface_mode: 'persuade' | 'operate' | 'read' | 'experience'
  captures: { path: string; route: string; width: 1280 | 390
              theme: 'light' | 'dark'; sha256: string }[]
  criteria: { id: 'specificity' | 'hierarchy' | 'typography' | 'color' | 'states' | 'motion'
              score: number | null; weight: number; note: string }[]   // null = n/a → renormaliza
  final: number                                                // ponderado sobre o máximo aplicável
  defects: { id: string; severity: 'critical' | 'major' | 'minor'
             criterion: string; where: string; fix: string }[] // fix = o quê, nunca o como
  verdict: 'pass' | 'rework' | 'unknown'
}
```

`unknown` é veredito legítimo (capturas ilegíveis, rota em branco) e vai para `awaiting_operator`,
não para rework.

### 5.3 Protocolo anti-ancoragem

A regra é literal na fonte: *"Assessment A must finish before detector findings enter the parent
synthesis context. Detector output is deterministic, but it still anchors judgment."*
(`addendum-frontend-engine-anchor.md` §3, verificada em `reference/critique.md`). A arquitetura
ingênua — detector e juiz no mesmo prompt — viola isso.

| Regra | Implementação |
| :--- | :--- |
| julga antes de ver o detector | os achados de D5/D6 só entram no pack **do rework**, nunca no pack do juiz |
| não vê o diff nem o prompt do Maker | o pack do juiz contém: capturas + `design_brief` + `task` + rubrica. Nada mais. A seção `task` carrega os `operator_notes` do `ade steer` drenados no `prepare` (≤600 bytes, mais recente primeiro) — contexto, nunca requisito novo (E53) — e a seção `contract` respeita o teto de 32 000 bytes (E50) |
| sub-agente isolado | sessão nova por chamada, processo próprio, `--safe-mode`, sem `--resume`; nunca inline na sessão do Maker. Turno único: nunca há compactação, e a telemetria não tem `compaction_events` (E67) |
| sem histórico de rodadas | a rodada 2 não recebe o `VisualEval` da rodada 1 (evita deriva de leniência) |
| sem randomização de posição | pontuação absoluta de item único não sofre viés de posição; swap A/B dobraria custo por nada (digest #21 / `landscape-evals-visual.md` §3.6.8) |

---

## 6. Decisão, rodadas e custo

**Teto de 2 rodadas**, com citação primária exata: *"Build fully, inspect once with a batched round
(desktop and mobile together on the web), fix everything it shows in one batch, confirm with at most
one more round, and stop polishing. Open-ended self-QA burns the user's money."* — 1 inspeção em lote
+ 1 confirmação (`addendum-frontend-engine-anchor.md` §3; digest #16).

| Rodada | O que roda | Saída |
| :-- | :--- | :--- |
| 1 | D1–D6 + juiz sobre **todas** as rotas × larguras × temas de uma vez | `pass` → `review`; senão um lote único de defeitos |
| rework | step `rework` do Maker com: defeitos do juiz + falhas de D1–D6 + capturas próprias. Conta no `budget.max_rework_rounds` | árvore nova |
| 2 | D1–D6 + juiz, confirmação | `pass` → `review`; senão `awaiting_operator` |

Reprovação em D1–D6 na rodada 1 **não chama o juiz**: vai direto para rework. Isso corta a maioria
das chamadas de modelo em trabalho obviamente quebrado.

**Orçamento de rework reservado.** Toda story com `has_ui` reserva **1 rodada de rework para o FQE no
`prepare`** (`architecture.md` §11 E39): o balde é o mesmo `budget.max_rework_rounds` do contrato, mas
a reserva impede que uma falha de eval funcional consuma tudo e deixe o loop visual sem a rodada 2.
Esgotar qualquer um dos dois tetos (`budget.max_rework_rounds` ou `visual.max_rounds`) leva a
`awaiting_operator`. O teto de chamadas acompanha a reserva:
`max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)`, o que dá **8 chamadas e 3 rodadas
de rework** para `bounded` com UI (contra 6/2 sem UI) e 12/3 para `feature` com UI — **[hipótese]**
(`architecture.md` §12 E65, emenda a E4).

**Esgotou → `awaiting_operator`** com motivo `visual_cut_not_met`, o `VisualEval` das duas rodadas e
as capturas **lado a lado** (rodada 1 × rodada 2, mesma rota/largura/tema) no `ade report`. É a forma
preguiçosa de aprovar direção estética que o painel J2 apontou faltar nas três propostas
(`design-panel/judgment-J2-journeys.md` §5.4): o operador olha duas imagens e responde
`ade decide <unit> --option retry|skip|discard|pick --value <id>` (`architecture.md` §11 E32) — `pick`
escolhe a captura preferida pelo id do `VisualEval`, sem abrir navegador. `ade show <ref> --open` abre
a captura no visualizador do SO.

**Custo por rodada** — aritmética sobre `tokens ≈ (largura × altura) / 750`
(`landscape-evals-visual.md` §3.5), **[hipótese]** nos valores absolutos (preços de tabela não
verificados em fonte primária):

| Item | Valor |
| :--- | ---: |
| 4 capturas de viewport (1280×800 + 390×844, claro/escuro) | ~3.600 tokens |
| rodada completa (capturas + rubrica + brief + task / saída JSON) | ~6.100 in / ~1.200 out |
| **rodada, preço médio / preço de topo** | **~US$ 0,04 / ~US$ 0,18** |
| rework de implementação multi-arquivo (comparação) | 30–150k tokens = 10–50× |

Duas regras de captura que valem dinheiro real: `fullPage: false` (viewport custa 3–4× menos que
página inteira) e eixo longo ≤ 1024px em rota longa.

Esses tokens são contabilidade de telemetria, não portão: não existe `max_tokens_in`/`max_tokens_out`
no `mission_budget` (`architecture.md` §12 E61). O teto é `max_usd` com `prices.json` nas famílias que
reportam custo e `max_model_calls` nas demais.

---

## 7. Geração de direção e a etapa opcional de duas famílias

**Geração (quando falta `DESIGN.md`).** Um gerador só, por `.ade/config.json`: skill `impeccable`
(`shape`/`craft`, produz `PRODUCT.md`+`DESIGN.md`) **ou** `frontend-design` da Anthropic — os dois no
mesmo passo cobrem o mesmo espaço de decisão por custo dobrado
(`addendum-frontend-engine-anchor.md` §2). O produto do passo é arquivo commitado, não contexto. A
skill vem do catálogo curado: skills em `<repo>/.claude/skills/` não entram no pack nem são carregadas
pela CLI, porque a chamada despachada roda sob `--safe-mode` (`architecture.md` §12 E56), e a injeção
é registrada em `skills_injected[]` com `sha256` do conteúdo injetado e `source`
(`catalog@<commit>` ou `local`) — evidência de supply chain no próprio evento (E59).

**Duas etapas (Claude projeta → Codex estrutura): flag medida, não default.** `visual.two_stage`,
default `false`. Quando ligada, `implement` vira dois steps na mesma árvore: `implement:design`
(Maker Claude com a skill de geração; produz markup, tokens e a `signature`) e `implement:engineer`
(`codex exec` no mesmo worktree; tipagem, extração de componente, fiação de a11y e estados;
**proibido** alterar `DESIGN.md`, tokens ou a `signature` — violação é falha de `contain`). O braço é
gravado na telemetria e medido em A/B pareado sobre as fixtures (§8): `visual_score` e
`rework_rounds` por braço (`architecture.md`, tabela de hipóteses). Hoje é **[hipótese]**.

**`$imagegen` — asset final, nunca referência.** Comando exato, com as duas correções operacionais
que a documentação não menciona (`addendum-frontend-engine-anchor.md` §5):

```
codex exec --json --sandbox workspace-write --skip-git-repo-check --ignore-user-config \
  -C <worktree>/<asset_dir> '$imagegen <descrição do asset>'      # stdin fechado
```

- **stdin fechado é obrigatório** (`stdio: ['ignore','pipe','pipe']` no spawn): sem isso `codex exec`
  pendura em *"Reading additional input from stdin…"* mesmo com o prompt posicional — travamento real
  em pipeline não-interativo.
- **`--skip-git-repo-check` é obrigatório** quando o diretório de trabalho não é repo git (exit 1
  antes de qualquer chamada de modelo, sem ele).
- Saída em `$CODEX_HOME/generated_images/<thread_id>/exec-<uuid>.png`; o engine copia para
  `artifacts/` e só então grava no worktree como `local_write`.
- Caminho embutido (`image_gen`) **não exige `OPENAI_API_KEY`** — consome os limites normais do Codex
  (`capabilities-codex.md` §6.2; verificado em execução, `addendum-frontend-engine-anchor.md` §5).
- Limites: até **16 imagens de entrada**, aresta ≤ 3840 px, ambas as arestas múltiplas de 16, presets
  4K `3840x2160`/`2160x3840`, `--quality low|medium|high|auto`. Modelo `gpt-image-2`.
- **Regra de uso:** asset final (ícone, textura, ilustração de hero), nunca referência de cópia.
  Descrever estilo > anexar inspiração (`PROMPT.md` §3.7). Imagem gerada nunca entra no pack do juiz
  como padrão de comparação.

---

## 8. Impeccable — o que é usado e como é pinado

`pbakaus/impeccable` 4.3.1, instalado como plugin de marketplace em
`~/.claude/plugins/marketplaces/impeccable/`; detector em Rust, Apache-2.0 uniforme nos 16 crates
(`addendum-frontend-engine-anchor.md` §1). A ADE **orquestra o detector, não o reimplementa**: são
~61 regras determinísticas já escritas e testadas (digest #19).

| Peça | Uso na ADE |
| :--- | :--- |
| `detect --json` | **D5**, contra a URL servida. Único uso obrigatório |
| `ignores list` / `ignores` | liberação de eixo fixado pelo brief (§2.1), com escopo de missão |
| skill de geração (`shape`, `craft`, `PRODUCT.md`/`DESIGN.md`) | opção A do passo de geração (§7) |
| hooks `PostToolUse` (tier imediato) / `Stop` (passe profundo) | **reforço** dentro da sessão do Maker, nunca portão. O portão é D5, rodado pelo engine (`architecture.md` §7, Firewall) |
| `live`, `generate`, critique dual-agent | **fora**: a ADE tem juiz e rubrica próprios |

**Pinagem por `ENGINE_VERSION`, nunca por versão npm.** O pacote npm público só chega a `4.1.0`;
`npx impeccable@4.3.1` falha com `ETARGET`. Os três esquemas de versão não coincidem: npm `4.1.0`,
plugin `4.3.1`, engine Rust `ENGINE_VERSION` (hoje `0.1.5`) — este último é o único estável
(`addendum-frontend-engine-anchor.md` §1).

**O pin é exigido pelo launcher, não pelo npm.** `npx impeccable@0.1.5` não existe: numa máquina sem
o plugin, a única via reprodutível é o shim baixando o GitHub Release `engine-v<ENGINE_VERSION>` com
SHA-256 obrigatório (abaixo). `ade doctor` **exige** a versão, não só registra: `ENGINE_VERSION`
lido ≠ `visual.impeccable.engine_version` é falha de doutor (fail-closed), nunca aviso
(`architecture.md` §12 E45): o FQE entra em modo degradado (§4.8), stories com UI param em
`awaiting_operator{reason:'fqe_unavailable'}` e stories sem UI seguem. Sem `IMPECCABLE_BIN` nem
release alcançável vale o mesmo caminho, em vez de rodar D5 contra binário de versão não controlada. **A versão efetiva é dado do resultado:** cada `VisualEval`
grava o `ENGINE_VERSION` que rodou (§5.2) e `visual_score` não é comparável entre engines diferentes,
pela mesma razão que não é entre juízes (§5.2, §9.2) — mudar o pin invalida a série e é `decision` no
journal.

**Instalação.** O shim `cli/bin/cli.js` resolve `$IMPECCABLE_BIN` → `@impeccable/cli-<os>-<arch>` →
cache `~/.impeccable/bin/<versão>/` → GitHub Release `engine-v<versão>` com SHA-256 obrigatório e
recusa fail-closed. Há binário para darwin-arm64/x64, linux-x64/arm64 e windows-x64 — cobre "local e
universal". `ade doctor` sonda `impeccable --version`, grava `ENGINE_VERSION` em
`~/.ade/capabilities.json` e, quando o plugin está na máquina, aponta `IMPECCABLE_BIN` para o binário
do plugin, eliminando o descompasso npm. Sem Node ≥ 22.18 ou sem rede na primeira execução: modo
degradado (§4.8). Passe: ~2,0–2,5 s de parede por invocação via `npx`, desprezível frente a
build+serve+captura+juiz.

---

## 9. Fixtures, evals do FQE e regressão visual

### 9.1 Fixtures (critério de aceite do componente)

Grupo "loop visual" da suíte de dogfood, 4–6 casos, `runs: 3`, reporte em `pass^3`
(`landscape-evals-visual.md` §5.2):

| Fixture | Asserção |
| :--- | :--- |
| `bad-generic/` — kicker, Inter, paleta clichê, `outline:none`, cards aninhados, erro no console | **reprova**: D1 e D5 vermelhos; se passar, o portão está quebrado |
| `bad-subtle/` — sem violação mecânica, visualmente genérica | **reprova no juiz**: especificidade < 7 com D1–D6 verdes. É o caso que prova que o juiz ganha o salário |
| `good-specific/` — brief fixado, `signature` presente, estados desenhados | **passa em 1 rodada**, zero rework |
| `good-pinned-default/` — brief que fixa Inter explicitamente | **passa**: guardrail liberado pelo brief não reprova |
| `ban-kicker/` — brief que pede kicker acima de heading | **reprova mesmo assim**: nenhum brief libera o banimento |
| `detector-mode/` — mesma fixture em modo arquivo e em modo URL | modo URL acha estritamente mais (prova viva da limitação de §4) |

Fixtures são sites estáticos servidos por um servidor de teste do próprio repositório (`node:http`,
~20 linhas) — nenhuma dependência nova (`architecture.md`, stack v1).

### 9.2 Evals do próprio FQE

O FQE é medido, não assumido. Métricas derivadas do journal, sem instrumentação nova
(`landscape-evals-visual.md` §5.1):

| Métrica | Definição | Uso |
| :--- | :--- | :--- |
| `visual_score` | mediana de `VisualEval.final` e % reprovada na rodada 1 | só comparável com juiz pinado |
| `visual_score_by_family` | mesma captura julgada por cada família disponível | vira evidência de roteamento em `~/.ade/routing.jsonl` |
| `escaped_visual_defects` | defeito visual achado após `complete` ÷ stories com UI | gatilho de recalibração do corte (§5.1): > 10 % em 20 stories → 8,0 |
| `rounds_to_pass` | distribuição de rodadas até `pass` | valida (ou derruba) o teto de 2 |
| `gate_vs_judge` | % de reprovações resolvidas por D1–D6 sem chamar o juiz | mede o ganho do determinístico primeiro |

O braço de família fecha a lacuna honesta da pesquisa: **não há medição pública de que juiz
multimodal de outra família com rubrica reduz slop** — a evidência é indireta (*MLLM as a UI Judge*:
alinhamento parcial com percepção humana; revisão cross-vendor: relatos sem paper). A ADE mede em
casa (`landscape-evals-visual.md` §3.6, §9.1). **[hipótese]** até lá.

A única medição causal publicada é sobre o **brief**, não sobre o juiz: Vercel, >200 execuções em
Claude Opus 4.8 e Codex/GPT-5.5, baseline sem o arquivo de design, rubrica cega — 39 falhas com o
arquivo contra 91 sem, **−57 %** (`landscape-evals-visual.md` §4.2). É por isso que o `design_brief`
é obrigatório e o juiz é opcional por classe (`architecture.md` §5, tabela de classes: `trivial` roda
só o detector).

### 9.3 Regressão visual (pixel-diff): fora da v1

Não existe baseline numa tela que acabou de nascer. Rubrica responde "isto é bom?"; pixel-diff
responde "isto mudou?" — problemas diferentes (`docs/adr/0019-rejeicoes.md`). Entra **só no modo
manutenção pós-v1**: capturas do último `complete` da story viram goldens candidatos e o diff só liga
quando o operador aprova a tela. API pronta: `toHaveScreenshot` com `threshold: 0.2` (default),
`animations: 'disabled'`, `caret: 'hide'`, `scale: 'css'`, `maskColor: '#FF00FF'`
(`landscape-evals-visual.md` §6). SaaS de regressão visual (Chromatic, Percy, Argos) fica fora por
conta, custo recorrente e CI externo contra uma ADE local; Lost Pixel está arquivado (digest #24).

---

## 10. Configuração — bloco `visual` de `.ade/config.json`

**Derivado do schema.** `schemas/ade-config.schema.json` (um dos 8 schemas publicados) é a única
fonte das chaves de configuração; este bloco é ilustração derivada e não normativa, e divergência
entre a prosa e o schema resolve-se pelo schema (`architecture.md` §12 E55). O schema é único e tem
`additionalProperties: false` com exit 4 em campo desconhecido (`2026-09-17-master-spec.md` §3, mesma
tabela de exit codes de E47), então nenhum outro documento pode nomear chaves diferentes — o
master-spec §3 referencia esta seção em vez de repetir a lista.

```json
"visual": {
  "enabled": true,
  "serve_command": ["npm", "run", "preview"],
  "url": "http://127.0.0.1:4173",
  "ready_timeout_s": 90,
  "routes": [{ "path": "/", "mode": "persuade",
               "states": ["default", "empty", "loading", "error"] }],
  "widths": [1280, 390],
  "themes": ["light", "dark"],
  "console_allowlist": [], "network_allowlist": [],
  "gates": ["D1", "D2", "D3", "D4", "D5", "D6"],
  "imagegen": true,
  "max_rounds": 2, "cut": 7.5, "specificity_min": 7, "criterion_min": 6,
  "judge": { "family": "codex", "model_id": "<pinado>", "pinned_at": "<iso>" },
  "generator": "impeccable",
  "two_stage": false,
  "impeccable": { "engine_version": "0.1.5", "bin": null }
}
```

`gates` é o **subconjunto bloqueante** de D1–D6 (os seis por default; qual subconjunto fica
bloqueante ao fim da calibração do dogfood é pergunta aberta, §12.6 — [hipótese]). `imagegen`
liga/desliga a geração de asset final do §7. O corte do juiz é `cut` (não `judge_cutoff`) e a versão
pinada do Impeccable é `impeccable.engine_version` (não `impeccable_engine_version`).

---

## 11. Divergências resolvidas

Arbitragem em `architecture.md` §11 (2026-09-17). As quatro divergências foram aceitas; o texto desta
spec já reflete as decisões.

1. **D1 (Oxlint anti-slop fora do FQE) → aceita**, `architecture.md` §11 E39. O lint vendorizado vira
   gate por flag no Gate runner (C8) e o FQE fica com **D1–D6, todos dependentes de render**; o antigo
   D7 (responsivo) passa a ser D6 em código, schema e journal (§4).

2. **D2 (critério de recalibração do corte) → aceita**, `architecture.md` §11 E39. `visual.cut`
   continua 7,5 e o critério de saída do dogfood está publicado em §5.1:
   `escaped_visual_defects` > 10 % em 20 stories com UI → 8,0; `awaiting_operator` em trabalho
   aprovado à primeira vista → 7,0. O 7,5 segue **[hipótese]** e pendente de confirmação do Erick
   (`architecture.md` §9, decisão 4).

3. **D3 (colisão entre `budget.max_rework_rounds` e `visual.max_rounds`) → aceita**,
   `architecture.md` §11 E39, na forma da reserva: toda story com `has_ui` reserva 1 rodada de rework
   para o FQE no `prepare`; o balde é o mesmo e esgotar qualquer um dos tetos leva a
   `awaiting_operator` (§6).

4. **D4 (`self_critique` obrigatório) → aceita**, `architecture.md` §11 E39: `minLength` em
   `task-contract.schema.json` (§2, camada 4).

---

## 12. Perguntas em aberto

1. Pesos por modo (§2) e o corte (§5.1) são **[hipótese]** sem medição — o dogfood decide.
2. Não há medição pública de que juiz de família diferente com rubrica reduz slop (§9.2).
3. `impeccable live` e `generate` (variantes escolhidas no browser) podem substituir parte do rework
   por custo menor que uma rodada completa; não avaliado (`landscape-evals-visual.md` §9.6).
4. Custo de parede do serve+captura em repositório real (build de produção de um app Next típico) não
   medido; o orçamento de parede da jornada 6 depende disso.
5. Reprodutibilidade do pin do Impeccable numa máquina sem o plugin do Claude Code depende do GitHub
   Releases estar acessível na primeira execução — fail-closed por design, mas é ponto único de falha
   para "universal" (`addendum-frontend-engine-anchor.md` §1).
6. ~~Descompasso entre C17 "v1 parcial" e o roadmap.~~ Resolvido: `architecture.md` §3 (C17) e §11
   E37 fixam **D1–D6 + juiz na v0.4a**, com o conjunto bloqueante calibrado no dogfood. Fica em aberto
   só qual subconjunto de D1–D6 é bloqueante ao fim da calibração.
