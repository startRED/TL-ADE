# Spec — Intent Compiler (C15)

Data: 2026-09-17. Escopo: o caminho `pedido → Plan de Task Contracts aprovado`. Depois da aprovação o
documento acaba: execução em `docs/specs/engine-durability.md`, montagem do prompt em
`docs/specs/context-firewall-telemetry.md`, seleção de skills em `docs/specs/skill-fabric.md`, UI em
`docs/specs/frontend-quality-engine.md`. Decisões fixas em `architecture.md` §3 (C15, C18), §4, §5 e
ADR `0008-intent-compiler-task-contract-classes-faixa-rapida`, `0007-eval-first-prova-vermelha-strictness`,
`0016-pesquisa-como-subsistema`. Entrega na v0.3 (`docs/roadmap.md`); o Slice 1 consome `plan.json`
escrito à mão, sem compilador.

Invariante do subsistema: **o compilador produz contrato, nunca código, e nunca decide sozinho o que o
repositório já responde**. Toda etapa de modelo é coagida por `--json-schema` / `--output-schema`
(digest #10) e validada por ajv; a saída do modelo não é fonte da verdade, o schema é.

---

## 1. Context discovery determinístico

Roda antes de qualquer chamada de modelo, sempre, em todas as classes. Custo de modelo: **zero**.
É o que torna detectável a regra "pergunta respondível pelo repo é recusada" (`architecture.md` §5.7)
e o que alimenta o fallback do classificador.

| Coletor | Comando/fonte | Teto | Uso |
| :--- | :--- | :--- | :--- |
| `repo` | `git rev-parse`, `git status -z`, `git log -n 50 --format`, branch atual, remoto | — | worktree base, sujeira pré-existente, convenção de commit |
| `manifests` | `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj` (profundidade ≤3) | 20 arquivos | linguagens, scripts (`test`, `build`, `lint`, `dev`), gerenciador |
| `tests` | globs por linguagem + `rg` pelos runners declarados no manifest | 200 caminhos | existe suíte? comando de eval candidato |
| `ci` + `docs_vivos` | `.github/workflows/*.yml`; `DESIGN.md`, `PRODUCT.md`, `AGENTS.md`, `README.md`, `docs/adr/` | 18 arquivos, 4 KB cada | portões já existentes; tokens de design, público, invariantes citáveis |
| `ui` | rotas por convenção (`app/`, `pages/`, `routes/`, `src/routes`), `index.html`, dependências de framework | 300 rotas | liga `has_ui` → DesignBrief obrigatório |
| `symbols` | `rg --json` com os termos do pedido (lemas ≥4 chars, stopwords PT/EN removidas) | 40 hits | ancoragem: arquivo provável, símbolo provável |
| `ade` | `.ade/config.json`, últimas 5 missões (`status.json`, `report.md`), skills locais do repo | — | autonomia default, orçamentos, reincidência |

A v1 assume repositórios do próprio operador: `catalog.sources` fica no `.ade/config.json` do
repositório e as skills de `<repo>/.claude/skills/` são inventário do discovery, nunca entram no pack
(só o catálogo curado) e não são carregadas pela CLI despachada (E56).

Graft, quando instalado, substitui o coletor `symbols` por consulta a grafo com fallback silencioso
para `rg` (ADR `0018-graft-opcional`); o mapa não muda de forma.

**Formato do mapa** (`.ade/missions/<id>/discovery.json`, não é schema publicado — projeção interna):

```jsonc
{ "digest": "sha256:…",            // entra no input_digest do step de classificação
  "repo": { "head": "b7ea3df", "dirty": false, "remote": true, "default_branch": "main" },
  "languages": [{ "name": "typescript", "files": 412, "share": 0.81 }],
  "scripts": { "test": "vitest run", "build": "tsc -b", "lint": "oxlint" },
  "tests": { "framework": "vitest", "count": 93, "dirs": ["packages/core/test"] },
  "ui": { "present": true, "framework": "react", "routes": ["/", "/login"], "design_md": true },
  "anchors": [{ "term": "login", "path": "src/ui/LoginButton.tsx", "line": 42, "kind": "symbol" }],
  "answerable": ["qual runner de teste", "existe tema escuro", "onde fica a rota /login"],
  "budget_hints": { "prior_missions": 3, "autonomy_default": "safe" } }
```

`answerable[]` é o campo operacional: cada item é uma pergunta **normalizada** (lowercase, sem
pontuação, stemming simples) que a entrevista vai recusar por similaridade (§7). O mapa inteiro tem
teto de 8 KB; o que exceder vira ponteiro para `artifacts/`, como qualquer seção do pack
(`architecture.md` §7).

Orçamento: p95 ≤ 3 s em repositório de até 5k arquivos [hipótese — medir no dogfood]. Estourou, o
coletor `symbols` degrada primeiro (é o único com custo linear no pedido).

---

## 2. Classificador de complexidade

**Regra determinística primeiro** (`architecture.md` §11 E18): a regra dos itens 1–5 abaixo roda
sempre, com custo zero, e decide sozinha em candidatos a `trivial` (1 arquivo tocado no discovery +
verbo de correção). A chamada barata com schema (`architecture.md` §5.3) é escalada — só com
`confidence < 0,6` ou classe ≥ `feature` — nunca o caminho default. Saída (JSON Schema inline; vira
publicado só se ganhar um segundo consumidor):

```ts
interface Classification {
  complexity: 'trivial' | 'bounded' | 'feature' | 'subsystem' | 'project'
  confidence: number                       // 0–1
  domains: string[]                         // 'ui' | 'api' | 'data' | 'build' | 'infra' | 'docs' | 'test'
  has_ui: boolean
  unknowns: { id: string; question: string; kind: 'external_fact' | 'product_choice' | 'repo_fact' }[]
  estimated_files: number                   // ordem de grandeza, não promessa
  rationale: string                         // ≤300 chars, para o journal
  source: 'model' | 'deterministic'
}
```

**Critérios por classe** (tabela normativa; a maior evidência disparada vence):

| Classe | Sinal dominante | Arquivos estimados | Superfície pública | Incógnita |
| :--- | :--- | :--- | :--- | :--- |
| `trivial` | um comportamento errado, alvo ancorado no discovery, sem API nova | 1–2 | nenhuma | nenhuma |
| `bounded` | um comportamento novo ou alterado dentro de módulo existente | 3–8 | interna | nenhuma ou `repo_fact` |
| `feature` | fluxo de usuário ponta a ponta, contrato novo com terceiro | 9–25 | 1 superfície nova | até 2, qualquer tipo |
| `subsystem` | vários fluxos, migração de dados, mudança de arquitetura | 26–80 | várias | ≥1 `external_fact` |
| `project` | repositório novo ou reescrita; sem baseline no discovery | >80 ou repo vazio | tudo | estrutural |

**Medição de custo por chamada.** Obrigatória, por evento `telemetry` (`architecture.md` §4), porque o
custo de uma chamada "barata" não é observável a priori: duas medições na mesma máquina divergem —
`capabilities-claude-code.md` §7 mediu US$ 0,06284 com `canonicalModel: claude-haiku-4-5`, e
`addendum-checker-contract-review-result.md` §3 mediu US$ 0,3736 faturado como `claude-sonnet-5`
(digest #26). Anomalia não explicada, não fato estabelecido: a própria §9 do addendum a lista como
pergunta aberta, e a reconciliação é sonda obrigatória do `ade doctor` (grava `bootstrap_cost_tokens`
e `canonicalModel` por chamada). E18 se sustenta sem ela — a regra determinística cobre o candidato a
`trivial` a custo zero. Regra dura: o engine mantém média móvel de 20 chamadas do papel `classifier` em
`~/.ade/routing.jsonl`; se `p50(cost_usd) > 0,02` **ou** `p50(duration_ms) > 4000`, a escalada é
desligada (`source: 'deterministic'` sempre) e grava `decision{kind:'classifier_demoted'}`. Promoção
de volta só por `ade doctor` com sondagem real. Codex nunca é classificador: piso de ~19,4k tokens de
entrada (digest #27).

**Regra determinística** (primeiro passo, sempre; também é o único caminho quando não há família
disponível e o controle nas fixtures do §12):

1. `anchors` ≥1 **e** pedido com verbo de correção (`corrig|conserta|quebrad|não funciona|fix|broken`)
   **e** ≤2 arquivos candidatos → `trivial`.
2. Repositório sem `HEAD` ou sem manifesto → `project`.
3. Contagem de rotas/símbolos casados: ≤8 → `bounded`; ≤25 → `feature`; ≤80 → `subsystem`; acima →
   `project`.
4. Menção a terceiro não presente nos manifestos (ex.: `stripe`, `auth0`) → sobe uma classe e cria
   `unknown{kind:'external_fact'}`.
5. `has_ui` vem do discovery, nunca do modelo.

Escalada para o modelo só quando a regra devolve `confidence < 0,6` ou classe ≥ `feature` — onde o
custo relativo da chamada é irrelevante. Desacordo entre modelo e regra de **duas ou mais classes** não escolhe em silêncio: vale a classe
**maior** e grava `note{kind:'classifier_disagreement'}` com os dois valores — degradação segura, o
custo de processo a mais é menor que o de contrato a menos.

---

## 3. Faixa rápida `trivial`

Requisito com eval próprio: **≤30 s até a primeira edição de arquivo-fonte, 0 perguntas, ≤2 chamadas
de modelo** (`architecture.md` §5.4, judgment-J2 §6). O teste
`fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da **v0.3**; o Slice 1 grava
só `first_source_edit_ms` como baseline (`architecture.md` §11 E40). "Começar" não é redefinido aqui:
U1 (`first_source_edit_ms`) tem definição operacional única em `vision.md` §3, citada por referência
(E54) — a métrica que J2 §1 mostrou ser incomparável entre as propostas.

Orçamento das 2 chamadas: Maker (1) + classificador (1) **quando ele escala**. Com a regra
determinística decidindo — o default depois de E18 — a faixa rápida gasta **uma** chamada e sobra
folga para um retry dentro do orçamento default da classe (3 chamadas / 1 rework, `architecture.md`
§11 E4 [hipótese]).

**Quem escreve o eval.** O Maker, na mesma chamada da correção, com `author: 'maker'` gravado no
contrato e no journal (enxerto de judgment-J2 §4). É a **exceção única de mutabilidade** do contrato
(`architecture.md` §11 E2): em `trivial` com `evals: []` na aprovação, `evals` é preenchido uma só
vez, gravado como step `local_write` com `eval_authored_by: 'maker'`. O portão `must_fail_before` é
mantido por um **vermelho diferido**, executado pelo engine, não pelo modelo:

| # | Ator | Ação |
| :-- | :--- | :--- |
| 1 | engine | `prepare`: worktree, contrato mínimo, pack sem skills; grava `tree_before` |
| 2 | Maker | uma chamada: escreve o(s) arquivo(s) de eval **e** a correção |
| 3 | engine | checkpoint de `tree_after` em `refs/ade/…` |
| 4 | engine | restaura `tree_before` ∪ `{arquivos declarados como eval}` → `eval_run{phase:'red'}`; exige `exit != 0` com `red_reason: 'assertion'`. Em `trivial` os demais motivos (`missing_target`/`compile_error`/`environment`) **não** rebaixam para `additive`, que exigiria `negative`/`mutate` inexistentes na classe: a story para em `awaiting_operator{reason:'red_unproven'}` com o diff pronto e `ade decide --option accept_unproven` fecha como `complete` com `decision` gravada (E51, emenda a E12) |
| 5 | engine | restaura `tree_after` → `eval_run{phase:'green'}`; exige `exit == 0` |
| 6 | engine | vermelho que não falha ⇒ `eval_born_green` ⇒ story volta ao compilador (ADR 0007), nunca ao Maker |

Os dois `eval_run` exigem reporter estruturado (`--reporter=json` no Vitest/Jest, equivalente por
runner) e `numTotalTests ≥ 1`: zero testes executados é `red_reason: 'missing_target'`, nunca verde
(E58).

O passo 4 é o único ponto onde a faixa rápida difere do ciclo normal; custa duas restaurações de
árvore e zero chamadas de modelo. `eval_author: 'maker'` na telemetria é o que permite medir se a
concessão custa defeitos escapados (judgment-J2 §4).

**Quando o Checker entra**, na `trivial`: (a) diff toca > N arquivos-fonte (**`N = 1`**, chave
`fast_lane.checker_threshold_files` em `ade-config` — valor canônico em `architecture.md` §5, tabela
de classes); (b) diff toca `sensitive_paths`; (c) segundo `eval_run{phase:'green'}` falho na mesma
story; (d) `contain` disparou qualquer violação. Fora disso, `trivial` fecha sem Checker LLM, com
commit local e sem PR; em `autonomy: 'safe'` o engine ainda faz o `local_merge` fast-forward da branch
da story na base quando a base não mudou desde o `prepare` (ff-only, ref de origem em `refs/ade/`), e
se a base mudou o `report.md` imprime o comando de merge (E64). Auto-aprovação só com
`autonomy: 'safe'`, registrada como
`decision{kind:'auto_approved', class:'trivial'}`.

---

## 4. Expansão em camadas (`bounded`+)

Uma chamada forte com `--json-schema` produz as sete camadas de uma vez; o schema é o único contrato
de forma. A ordem importa porque cada camada é validável contra a anterior:

| # | Camada | Produz | Validação de fechamento |
| :-- | :--- | :--- | :--- |
| 1 | intenção | 1 frase, o porquê | não contém "como" (sem nome de arquivo, sem nome de função) |
| 2 | resultados observáveis | 1–5 frases no presente, do ponto de vista de quem usa | cada uma referenciada por ≥1 requisito |
| 3 | restrições | `scope_paths`, `do_not_touch`, `sensitive_paths`, invariantes citáveis | vêm do discovery e da config; modelo só **seleciona**, não inventa caminho inexistente |
| 4 | requisitos EARS | `requirements[]` | forma validada por regra (§5) |
| 5 | cenários | `scenarios[]` given/when/then | ≥1 por requisito; cobertura 1:1 verificada por id |
| 6 | evals | `evals[]` | ≥1 por cenário; no plano valida-se só a **forma** de `cmd` — a existência de `cmd[0]` nos `scripts` é conferida no `prepare` de cada story, com re-discovery no worktree (E63) |
| 7 | DesignBrief | 4 camadas | obrigatório sse `has_ui`; `direction.self_critique` não vazio |

Camada que não fecha não volta ao modelo em texto livre: volta com o **erro de ajv mais o item
específico**, uma única vez (`max_repair_rounds = 1`). Segunda falha ⇒ `awaiting_operator` com o
diagnóstico, nunca um plano meio-válido.

---

## 5. EARS — guia e regra de validação de forma

Forma canônica (Kiro, via `landscape-harnesses.md` §4): `WHEN <evento/condição observável> THE SYSTEM
SHALL <comportamento observável>`. Variantes aceitas: `WHILE <estado>`, `IF <condição> THEN`,
`WHERE <característica>`. Um requisito = um teste com nome derivado do requisito.

| Ruim | Por quê | Bom |
| :--- | :--- | :--- |
| `THE SYSTEM SHALL work correctly` | sem gatilho, sem comportamento observável, adjetivo vago | `WHEN the user clicks "Entrar" with valid credentials THE SYSTEM SHALL navigate to /dashboard within 2 s` |
| `THE SYSTEM SHALL be fast and user-friendly` | dois requisitos, nenhum mensurável | `WHEN the product list exceeds 500 items THE SYSTEM SHALL render the first paint in under 1,5 s on a 4× CPU throttle` |
| `WHEN the webhook arrives THE SYSTEM SHALL handle it properly` | "handle/properly" não é observável | `WHEN a Stripe webhook arrives with an invalid signature THE SYSTEM SHALL respond 400 and SHALL NOT mutate the subscription` |
| `THE SYSTEM SHALL use React Query for caching` | é o "como", não o quê | `WHEN the same product is requested twice within 60 s THE SYSTEM SHALL serve the second request without a network call` |
| `WHEN the button is broken THE SYSTEM SHALL fix it` | descreve a tarefa, não o comportamento | `WHEN the user clicks "Entrar" THE SYSTEM SHALL submit the form exactly once` |

**Regra de validação de forma** (determinística, roda em ajv + verificador próprio; recusa é dura):

1. Casa `/^(WHEN|WHILE|IF|WHERE)\b.+\bTHE SYSTEM SHALL\b.+/` (um `SHALL` principal; `SHALL NOT`
   adicional permitido na mesma frase).
2. Comprimento 40–240 chars; exatamente uma sentença.
3. Sem adjetivos de lista fechada sem métrica ao lado: `correct(ly)`, `proper(ly)`, `fast`, `robust`,
   `secure`, `user-friendly`, `good`, `better`, `nice`, `optimal`, `seamless`, `intuitive`,
   `gracefully` — a menos que seguidos de número + unidade.
4. Sem conjunção que esconda dois requisitos: ` and ` no trecho após `SHALL`, salvo se ambos os lados
   forem cobertos por cenários distintos.
5. Sem caminho de arquivo, nome de símbolo, nome de biblioteca ou versão no trecho após `SHALL`
   (isso é "como"; mora em `task`/`guardrails`).
6. Verbo do comportamento na lista de verbos observáveis (`display`, `return`, `respond`, `persist`,
   `navigate`, `reject`, `emit`, `retry`, `log`, `render`, `expose`, `remove`, `disable`, …) —
   lista aberta em `ade-config`, mas não vazia.
7. `id` único, estável, `R<n>`; referenciado por ≥1 `scenario`.

Recusa produz `ears_form_rejected` com a regra violada e o trecho. O Checker recebe cenário e eval
juntos (proposal-C §10 nomeia o risco: forma válida, substância vazia) — a regra de forma não pretende
resolver substância, só barrar o caso barato.

---

## 6. Entrevista

Máximo 5 perguntas, sempre múltipla escolha, **recomendação primeiro** e marcada como tal.
`trivial` = 0; `bounded` ≤2; `feature`+ ≤5 (`architecture.md` §5, tabela de classes).

Forma de cada pergunta:

```jsonc
{ "id": "Q1", "unknown_ref": "U1", "kind": "product_choice",
  "text": "Qual moeda o checkout aceita na v1?",
  "options": [
    { "id": "a", "label": "BRL apenas", "recommended": true, "why": "mercado atual do repo (i18n pt-BR)" },
    { "id": "b", "label": "BRL + USD" },
    { "id": "c", "label": "Não sei" } ],
  "default_if_unknown": "a" }
```

Regras:

- **Recusa por discovery**: se a normalização da pergunta casa com qualquer item de `answerable[]`
  (similaridade por trigramas ≥0,75) a pergunta é descartada antes de chegar ao operador e o valor é
  preenchido do mapa. Grava `note{kind:'question_refused', reason:'answerable_by_discovery'}`.
- **Recusa por irreversibilidade nula**: pergunta cuja escolha errada é corrigível dentro da mesma
  story sem retrabalho externo é descartada; o default entra.
- **"Não sei"** é opção obrigatória em toda pergunta. Escolhida: grava o default em
  `decision{kind:'default_assumed'}`, registra a incógnita em `TaskContract.unknowns[]` (campo do
  contrato, não do plano) e o resumo de aprovação a lista explicitamente.
- **Incógnita vira pesquisa** quando: `kind: 'external_fact'` **e** o default assumido tem efeito
  externo (rede, dinheiro, dado de terceiro) ou contradiz o discovery — gatilho por incógnita, não por
  classe (`architecture.md` §11 E19). A classe fixa só o teto de custo (§7). Caso contrário permanece
  como default registrado, visível no `ade report`.
- Duas perguntas com a mesma `unknown_ref` são fundidas. Orçamento estourado (>5) ⇒ as perguntas
  restantes viram defaults registrados, nunca perguntas extras.

---

## 7. Pesquisa como subsistema (C18)

Gatilho, não default de classe: **incógnita declarada** com `kind: 'external_fact'`
(`architecture.md` §11 E19). A classe define apenas o teto: `bounded` no máximo **uma** consulta e sem
time paralelo; `feature`+ até **três**. O time paralelo tem **papéis distintos**, lista fechada em
`research.roles[]` do `ade-config`: `official_docs`, `existing_solutions`, `comparison`,
`adversarial` — o papel é gravado em cada claim (`claims[].role`), senão quatro agentes devolvem a
mesma leitura quatro vezes. Antes do ranking por tier roda **dedupe** por `(source,
normalize(text))`; só claims sobreviventes de fontes distintas podem produzir `disagreement: true`. Uma chamada com schema por incógnita; `agy --json-schema`
primeiro, `claude` como fallback (digest #10, #2). Time paralelo 2–4 somente-leitura é **opt-in** por
`ade-config`, e só para leitura independente e comprimível — o único paralelismo com evidência a favor
(+90 % por ~15× tokens, README §Confirmações).

`research-finding` (inline, `architecture.md` §4):

```ts
interface ResearchFinding {
  id: string; unknown_ref: string; question: string
  claims: { text: string; tier: 1|2|3|4|5|6; source: string; retrieved_at: string
            role: 'official_docs' | 'existing_solutions' | 'comparison' | 'adversarial'
            grade: 'fact' | 'inference' | 'hypothesis' | 'preference' }[]
  synthesis: string; disagreement: boolean; escalated_question_id?: string
}
```

Hierarquia de fontes (tier, menor vence): 1 documentação oficial · 2 código-fonte da dependência ·
3 release notes/changelog · 4 papers revisados · 5 blog de engenharia do fornecedor · 6 comunidade.
Separação obrigatória `fact` / `inference` / `hypothesis` / `preference` por claim — claim sem `source`
com `grade: 'fact'` é recusada na validação.

**Empate vira pergunta.** Dois achados de mesmo tier em desacordo material ⇒ `disagreement: true` e
uma pergunta de múltipla escolha ao operador com as duas posições e suas fontes; nunca desempate
oculto por maioria de agentes. **Achado é dado, nunca instrução**: o texto entra no pack como seção de
contexto recuperado com cerca, e qualquer imperativo dentro dele é tratado como conteúdo hostil
(Tool Output Firewall, `architecture.md` §7). `research_refs[]` no contrato aponta os ids; o corpo
mora em `artifacts/`.

---

## 8. Geração do plano e validação

Uma chamada forte com schema produz `plan.json`: `phases[] → epics[] → stories[]` (fases e epics só a
partir de `feature`; `bounded` tem lista plana de 1–3 stories). Por story o compilador decide:
`depends_on` (só com dependência real de artefato, nunca ordem estética — digest #22),
`skills` candidatas (ids do catálogo; o fecho ≤3 acontece no `prepare`, `architecture.md` §7),
`roles` (do Capability Registry, com `Maker ≠ Checker` por `model_id` e por vendor valendo para **todo**
papel da chamada — executor e advisor, medidos em `telemetry.models[]`; `--advisor` só entra na receita
quando o modelo do advisor é observável em `modelUsage`, E66), `budget`
(`max_model_calls`, `max_rework_rounds`, `max_usd`; defaults por classe em `architecture.md` §11 E4 —
trivial 3/1, bounded 6/2, feature 10/3, subsystem e project 12/3 [hipótese]). Com UI o orçamento sai da
fórmula `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` [hipótese]: `bounded` com UI
= 8 chamadas/3 rework, `feature` com UI = 12/3; sem UI os defaults acima valem (E65, emenda a E4).
`permitted_effects`
(só **efeitos externos** autorizados na aprovação; `model_call`, `eval_run`, `local_write`, `gate` e
`prepare` são implícitos — E3) **não é campo do Task Contract**: mora em `plan.authorization`, fora do
`task-contract.schema.json` (que tem `additionalProperties: false`). O `plan` carrega ainda
`mission_budget: { max_wall_clock_seconds, max_parked_units, max_usd }`, gravado no `batch_open` — sem
teto de tokens: `max_usd` mais `prices.json` cobrem as famílias que reportam custo e nas demais o teto
é `max_model_calls` (E61).

**Recusas do validador** (ajv + regras próprias; cada uma com código, mensagem acionável e o item
culpado). Recusa é do plano inteiro, não parcial:

| Código | Condição |
| :--- | :--- |
| `story_without_eval` | cenário sem ≥1 eval que o referencie |
| `eval_without_scenario` | eval órfão |
| `requirement_without_scenario` | requisito sem cenário |
| `ears_form_rejected` | §5, regras 1–7 |
| `missing_do_not_touch` | `guardrails.do_not_touch` vazio |
| `missing_complexity` | story sem `complexity` |
| `missing_design_brief` | `has_ui` e sem `design_brief` (ou brief sem `direction.self_critique`) |
| `scope_outside_repo` | `scope_paths` fora do worktree ou casando `sensitive_paths` |
| `eval_cmd_unknown` | `cmd` mal formado (vetor vazio, `cmd[0]` vazio ou com shell embutido). A conferência contra os `scripts` é do `prepare`, não do plano (E63); `story.provides_runner` não existe |
| `strictness_default_abused` | `mode: 'additive'` sem `note` justificando (ADR 0007), ou sem um eval `negative` / spot-check `mutate` no mesmo cenário (E12) |
| `cyclic_depends_on` | ciclo no DAG |
| `role_same_model` | `maker.model_id == checker_round.model_id`, ou `vendor` igual entre os dois (E10); vale para todo papel da chamada, inclusive advisor (E66) |
| `budget_missing` | story sem `budget.max_model_calls` |
| `story_pack_overflow` | §9 |
| `unknown_unresolved` | incógnita `external_fact` sem `research_refs` nem `default_assumed` |

Plano recusado volta ao modelo **uma vez** com os códigos; segunda recusa ⇒ `awaiting_operator`.

---

## 9. Teto de pack por story e divisão

O corte efetivo do pack é em **bytes** (`limits.max_pack_bytes`, default 120 000 [hipótese], calibrar
por p90 — `architecture.md` §11 E13); "40k tokens" é alvo de projeto por estimativa. As seções não
pertencentes à story consomem um piso previsível; o que sobra é o orçamento da story:

| Seção | Teto | Dono |
| :--- | :--- | :--- |
| ferramentas + papel | ~1,0k | engine |
| invariantes do repo | 1,5k ("Must Always / Must Never") | repo |
| skills (≤3) | ≤7,5k por skill, soma ≤20k (E14, E70) | Skill Fabric |
| contexto recuperado | 6,0k | prepare |
| rodada (achados, falhas, checkpoint) | teto próprio de 24 000 bytes com ponteiro (E13) | ciclo |
| **contrato + tarefa** | **32 000 bytes** (≈8k tokens) [hipótese] — `limits.max_contract_bytes` (E50) | **story** |

A divergência está arbitrada: o teto da seção `contract` do pack é **32 000 bytes** (≈8k tokens)
[hipótese], dentro de `max_pack_bytes`, e substitui os dois valores que circularam — os 2 000 tokens da
tabela de seções de `context-firewall-telemetry.md` §1.1 e os "≤18k tokens" desta spec (E50). Estouro é
`story_pack_overflow` e reabre a divisão da story. As chaves de configuração citadas aqui são derivadas
de `schemas/ade-config.schema.json`, única fonte normativa das chaves (E55).

`estimate_story_tokens = bytes(contract JSON)/3,6 + Σ evals + brief + Σ(anchors citados)`. Acima de
`limits.max_contract_bytes` ⇒ `story_pack_overflow`, e o compilador **divide**: quebra por cenário em stories com `depends_on`
em cadeia, mantendo cada requisito inteiro (requisito nunca é dividido). Divisão que ainda estoura
⇒ `awaiting_operator` com a sugestão de recortar escopo. Segunda verificação, agora com números reais,
acontece no `prepare` (o pack só é montável lá); estouro nesse ponto poda o contexto recuperado antes
de tocar no contrato, e grava `note{kind:'pack_trimmed'}`.

---

## 10. Resumo de aprovação (conteúdo exato)

Uma tela, uma decisão (`architecture.md` §5.9). Ordem fixa, campos obrigatórios:

1. **Pedido**, verbatim, e a **intenção** compilada em 1 frase.
2. **Classe** e quem a decidiu (`model` / `deterministic`), com `rationale`.
3. **Será feito**: uma linha por story — `id`, título, classe, arquivos-alvo (top 3 + "… +N").
4. **Não será feito**: `do_not_touch` consolidado e as exclusões explícitas do pedido.
5. **Como será provado**: número de evals por tipo e os comandos distintos que serão executados.
6. **Perguntas e defaults**: cada resposta, e cada "não sei" com o default assumido, marcado.
7. **Incógnitas abertas**: as que viraram pesquisa (com fonte e tier) e as que ficaram como default.
8. **Skills novas neste projeto**: nome, origem, commit, `trust` — cada injeção posterior grava
   `sha256` do conteúdo e `source` (`catalog@<commit>` ou `local`) em `skills_injected[]` (E59);
   primeira aparição exige aprovação
   (em lote desatendido: `awaiting_operator`). A aprovação **congela o conjunto elegível da missão**
   (união do top-8 por story); só skill fora do conjunto parqueia em lote desatendido (E33).
9. **Efeitos externos autorizados**: subconjunto de `push`, `pull_request`, `pull_request_merge`,
   `ci_rerun`, instalação de dependência. Ausente = proibido. Classes internas não entram na lista (E3).
10. **Custo estimado**: USD por família com `cost_source` explícito (`reported` | `unknown`, sem
    `estimated` — `architecture.md` §4; Codex não reporta USD, digest #28) e teto `max_usd` do lote.
11. **Autonomia**: `safe` | `controlled` | `restricted`; `restricted` exibe "nunca roda desatendido"
    (`dispatch: never`, motivo `autonomy_requires_operator` — E5).
12. **Digest do plano** (JCS + sha256, 16 hex) — é o que a aprovação assina e o que o engine confere
    antes de cada story (divergência ⇒ `stale_plan`).

`ade approve <missão>` grava `decision{kind:'approved', plan_digest, permitted_effects}`. Contrato é
imutável depois disso, salvo os campos que o §11 marca como preenchíveis na execução.

---

## 11. Task Contract campo a campo

Forma normativa em `architecture.md` §4. Aqui o que cada campo significa para quem preenche:

| Campo | Quem escreve | Quando | Regra |
| :--- | :--- | :--- | :--- |
| `id`, `title` | compilador | plano | `id` estável; ordena o journal |
| `complexity` | classificador | plano | herda da missão, pode ser menor na story |
| `task` | compilador | plano | o quê e por quê; nunca o como; ≤600 chars. A seção `task` do pack recebe ainda os `operator_notes` do `ade steer` (≤600 bytes, mais recente primeiro, fila drenada no `prepare` da story seguinte): nota é contexto, não requisito, e o contrato segue imutável (E53) |
| `guardrails.scope_paths` | discovery + compilador | plano | globs existentes; base do `contain` |
| `guardrails.do_not_touch` | config + compilador | plano | obrigatório não-vazio |
| `guardrails.sensitive_paths` | config | plano | segredos, migrations, infra |
| `guardrails.autonomy` | operador/config | aprovação | `ask_operator` é enum fechado (E5); `restricted` ⇒ `dispatch: never` (`autonomy_requires_operator`) |
| `requirements[]` | compilador | plano | EARS §5; 1:1 com cenário |
| `scenarios[]` | compilador | plano | given/when/then; cita `evals[]` |
| `evals[]` | compilador (`author`) ou Maker na faixa rápida | plano / implement | `strictness.mode` default `must_fail_before`; preenchimento pelo Maker é a exceção única de mutabilidade (E2) |
| `skills[]` | compilador propõe; `prepare` fecha | prepare | ≤3, ids do catálogo |
| `roles` | Capability Registry | plano | `Maker ≠ Checker` por `model_id` |
| `design_brief` | compilador | plano | obrigatório sse `has_ui` |
| `research_refs[]` | pesquisa | plano | ids de `research-finding` |
| `unknowns[]` | entrevista | plano | campo do contrato, não do plano (E48): `id`, `question`, `kind ∈ {product_choice, external_fact, repo_fact}`, `resolved_by?` ∈ `{operator, research, discovery}`; o default assumido vive na `decision{kind:'default_assumed'}` |
| `depends_on[]` | compilador | plano | só dependência real |
| `budget` | compilador | plano | reservado pelo scheduler; defaults por classe (E4) |

`permitted_effects` também não é campo do contrato (mora em `plan.authorization`, §8). `passes`
**não existe mais no contrato** (`architecture.md` §11 E1): o contrato é imutável após a
aprovação (coberto por `immutable_digest`), o estado da story vive no journal (`unit_state`) e na
projeção `status.json`, e o veredito é carregado pelo `unit-result` — que traz `sources[]`
obrigatório (E8).

**Exemplo — jornada 1 (`trivial`)**

```jsonc
{ "id": "S1", "title": "Botão Entrar não envia o formulário", "complexity": "trivial",
  "task": "O clique em \"Entrar\" não submete o formulário de login; o usuário fica na mesma tela sem erro.",
  "guardrails": { "scope_paths": ["src/ui/LoginButton.tsx", "src/ui/__tests__/**"],
                  "do_not_touch": ["src/auth/**", ".github/**"], "autonomy": "safe" },
  "requirements": [{ "id": "R1", "ears": "WHEN the user clicks \"Entrar\" with a filled form THE SYSTEM SHALL submit the form exactly once" }],
  "scenarios": [{ "id": "C1", "given": "form with valid email and password", "when": "user clicks Entrar",
                  "then": "onSubmit is called once and the request is issued", "evals": ["E1"] }],
  "evals": [{ "id": "E1", "kind": "test", "cmd": ["npx","vitest","run","src/ui/__tests__/LoginButton.test.tsx"],
              "expect_exit": 0, "timeout_s": 120, "max_output_bytes": 65536,
              "evidence": ["src/ui/__tests__/LoginButton.test.tsx"],
              "strictness": { "mode": "must_fail_before" }, "author": "maker" }],
  "skills": [], "roles": { "maker": { "family": "claude", "model_id": "claude-sonnet-5" },
                           "checker_round": { "family": "codex", "model_id": "gpt-5.5-codex", "conditional": "diff_files>1" } },
  "budget": { "max_model_calls": 3, "max_rework_rounds": 1 } }
```

**Exemplo — jornada 4 (`feature` com pesquisa), 1 de 4 stories**

```jsonc
{ "id": "S2", "title": "Webhook do Stripe valida assinatura e é idempotente", "complexity": "feature",
  "task": "Receber eventos de assinatura do Stripe com verificação de assinatura e reprocessamento seguro, porque hoje não existe endpoint de webhook.",
  "guardrails": { "scope_paths": ["src/billing/**","test/billing/**"],
                  "do_not_touch": ["src/auth/**","infra/**"], "sensitive_paths": ["src/config/secrets.ts"],
                  "autonomy": "controlled", "ask_operator": ["dependency_add"] },
  "requirements": [
    { "id": "R1", "ears": "WHEN a webhook arrives with an invalid signature THE SYSTEM SHALL respond 400 and SHALL NOT change any subscription" },
    { "id": "R2", "ears": "WHEN the same event id arrives twice THE SYSTEM SHALL apply it once and respond 200 on both calls" }],
  "scenarios": [
    { "id": "C1", "given": "payload with tampered signature", "when": "POST /webhooks/stripe", "then": "400 and zero writes", "evals": ["E1"] },
    { "id": "C2", "given": "valid event already processed", "when": "POST repeated", "then": "200 and single row", "evals": ["E2"] }],
  "evals": [
    { "id": "E1", "kind": "negative", "cmd": ["npx","vitest","run","test/billing/webhook.signature.test.ts"],
      "expect_exit": 0, "timeout_s": 180, "max_output_bytes": 65536, "evidence": ["test/billing/**"],
      "strictness": { "mode": "must_fail_before" }, "author": "intent_compiler" },
    { "id": "E2", "kind": "contract", "cmd": ["npx","vitest","run","test/billing/webhook.idempotency.test.ts"],
      "expect_exit": 0, "timeout_s": 180, "max_output_bytes": 65536, "evidence": ["test/billing/**"],
      "strictness": { "mode": "must_fail_before" }, "author": "intent_compiler" }],
  "skills": ["api-design","backend-patterns"],
  "roles": { "maker": { "family": "claude", "model_id": "claude-sonnet-5" },
             "checker_round": { "family": "codex", "model_id": "gpt-5.5-codex" },
             "checker_gate": { "family": "claude", "model_id": "claude-opus-5" } },
  "research_refs": ["RF1"],
  "unknowns": [{ "id": "U2", "question": "moeda do checkout", "kind": "product_choice", "resolved_by": "operator" }],
  "depends_on": ["S1"],
  "budget": { "max_model_calls": 10, "max_rework_rounds": 3, "max_usd": 4.0 } }
```

---

## 12. Fixtures de intenção — evals do próprio compilador

Vitest, repositórios sintéticos em `test/fixtures/repos/`, CLI falsa por família (sem rede, sem custo).
Cada fixture é `pedido + repo → asserções sobre o plano`, não comparação de texto.

| Fixture | Pedido | Repo | Asserções |
| :--- | :--- | :--- | :--- |
| `F1-trivial` | "o botão de login não funciona" | react + vitest, `LoginButton.tsx` | `complexity=trivial`; 1 story; 0 perguntas; `eval.author='maker'`; ≤2 chamadas |
| `F2-answerable` | "melhore a página inicial" | repo com `DESIGN.md` | nenhuma pergunta sobre paleta/tipografia; `question_refused` no journal |
| `F3-ui-brief` | "melhore o design dessa página" | react com rotas | `has_ui=true`; `design_brief` presente com `self_critique`; recusa se ausente |
| `F4-external` | "adicione billing com Stripe" | node sem `stripe` nos manifestos | classe ≥ `feature`; `unknown.kind='external_fact'`; `research_refs` não vazio |
| `F5-ears-bad` | plano injetado com `THE SYSTEM SHALL work correctly` | — | `ears_form_rejected` com a regra 3 |
| `F6-orphan-eval` | plano com eval sem cenário | — | `eval_without_scenario` |
| `F7-overflow` | "reescreva o app inteiro" | 400 arquivos | ≥1 `story_pack_overflow` seguido de divisão; nenhum requisito partido |
| `F8-dont-know` | entrevista respondida com "não sei" ×3 | — | 3 `default_assumed`; 3 `unknowns[]`; resumo de aprovação lista os 3 |
| `F9-tie` | pesquisa com 2 achados tier 1 opostos | fixtures de finding | `disagreement=true` e pergunta gerada; nenhum desempate silencioso |
| `F10-degraded` | escalada do classificador indisponível | — | `source='deterministic'`; plano válido; `classifier_demoted` no journal |
| `F11-disagree` | regra diz `feature`, modelo diz `trivial` | — | vence `feature`; `classifier_disagreement` gravado |
| `F12-same-model` | registry com uma só família | — | `role_same_model` recusado; `no_checker_family_available` ⇒ `parked` |

Critério de pronto da v0.3: 12/12 verdes nos dois SOs, com o mesmo nome de teste no Windows e no
Linux (ADR 0003).

---

## 13. Custo e latência alvo por classe [hipótese]

Nenhum número abaixo é medição; todos são alvos para o dogfood calibrar. Chamadas contam só o
compilador (planejamento), não a execução.

| Classe | Chamadas | Tokens in/out | Custo alvo | Tempo até a 1ª edição de fonte | Teto de planejamento |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `trivial` | 1–2 | ~12k / 2k | ≤ US$ 0,10 | **≤30 s** (aceite) | ≤10 % do custo da missão |
| `bounded` | 2–3 | ~25k / 6k | ≤ US$ 0,40 | ≤90 s | ≤12 % |
| `feature` | 3–5 (+1–2 pesquisa) | ~60k / 15k | ≤ US$ 1,50 | ≤4 min | ≤15 % |
| `subsystem` | 5–8 (+2–3 pesquisa) | ~140k / 35k | ≤ US$ 4,00 | ≤8 min | ≤15 % |
| `project` | 6–10 (+time de pesquisa) | ~250k / 60k | ≤ US$ 9,00 | ≤15 min | ≤18 % |

Alarme (proposal-C §11 R1): planejamento > o teto da linha por duas missões consecutivas da mesma
classe ⇒ `note{kind:'planner_over_budget'}` e rebaixamento do classificador (§2); persistindo,
`bounded` passa a usar o caminho por template determinístico e o compilador completo fica em
`feature`+. O ponto de reversão é a função de despacho por classe, não uma reescrita.

---

## Divergências resolvidas

Arbitragem em `architecture.md` §11 (2026-09-17); o corpo deste documento já reflete as decisões.

- **D1 → aceita**, `architecture.md` §11 E18: regra determinística primeiro em candidatos a `trivial`;
  chamada de modelo só com `confidence < 0,6` ou classe ≥ `feature`. As ≤2 chamadas da faixa rápida
  incluem o classificador quando ele escala. Aplicado no §2 e no §3.
- **D2 → aceita**, `architecture.md` §11 E2: exceção única de mutabilidade — em `trivial` com
  `evals: []` na aprovação o Maker preenche `evals` uma vez (`author: 'maker'`), gravado como step
  `local_write` com `eval_authored_by`, e o vermelho diferido é condição de validade. Aplicado no §3 e
  no §11. Nota: E1 remove `passes` do contrato, então a formulação original de D2 ("`passes` é o único
  campo gravável") não vale mais.
- **D3 → aceita**, `architecture.md` §11 E19: gatilho de pesquisa é a incógnita `external_fact`, não a
  classe; a classe fixa só o teto (`bounded` ≤1 consulta sem time, `feature`+ até 3). Aplicado no §6 e
  no §7.
- **D4 → aceita**, `architecture.md` §11 E20: duas verificações nomeadas — estimativa no plano (divide
  por cenário) e medição no `prepare` (poda contexto recuperado, nunca o contrato; reabre divisão se o
  contrato sozinho estourar). Aplicado no §9; o ADR 0008 registra a mesma dupla.

O texto original das objeções fica abaixo como registro.

**D1 — O classificador deveria ser determinístico por padrão, com o modelo como escalada.**
`architecture.md` §5.3 fixa "uma chamada barata com `--json-schema` … fallback para regra
determinística". Evidência contra a ordem: (a) digest #26 — `--model haiku` faturou como
`claude-sonnet-5`, US$ 0,37 por 200 bytes, isto é, o "barato" não é observável a priori; (b) o
orçamento da faixa rápida é ≤2 chamadas (`architecture.md` §5.4) e o classificador consome metade
dele, sem sobra para retry; (c) judgment-J2 §1 registra que a proposta centrada em compilar intenção é
a que mais paga na jornada onde compilar intenção não agrega. Proposta: regra determinística primeiro
(§2, itens 1–5); chamada de modelo só quando a regra devolve `confidence < 0,6` ou classe ≥ `feature`
— onde o custo relativo é irrelevante. Custo da mudança: zero de engine (é a mesma função de
despacho, com ordem invertida).

**D2 — `TaskContract` "imutável após aprovação" e eval escrito pelo Maker são incompatíveis como
escritos.** `architecture.md` §4 diz "imutável após aprovação" e "`passes` … ÚNICO campo gravável pelo
agente"; §5.4 manda o Maker escrever o eval da faixa rápida (`author: 'maker'`). Na `trivial` o
contrato aprovado nasce com `evals: []` e ganha conteúdo depois da aprovação, escrito pelo agente.
Proposta: tornar a exceção explícita no schema — `evals` aceita ser preenchido uma única vez quando
`complexity == 'trivial'` e `evals.length == 0` na aprovação, com o preenchimento gravado como
`step_result{effect_class:'local_write', eval_authored_by:'maker'}` e o vermelho diferido do §3 como
condição de validade. Sem isso, ou a `trivial` viola a imutabilidade, ou precisa de uma terceira
chamada (violando ≤2).

**D3 — Pesquisa travada em classe ≥ `feature` deixa `bounded` sem saída para fato externo.**
`architecture.md` §5.6 condiciona pesquisa à classe; proposal-C §7 é explícita em sentido contrário:
"dispara por ausência de evidência declarada pelo Intent Compiler, **nunca por default de classe**".
Caso concreto: `bounded` "atualize a integração para a API nova do provedor X" gera `external_fact`,
não pode pesquisar, e a entrevista só oferece default assumido — isto é, o plano fecha sobre um fato
possivelmente falso. Proposta: manter o teto de custo por classe (`bounded` = no máximo **uma**
consulta, sem time paralelo) e trocar o gatilho de classe por gatilho de `kind` + efeito externo do
default. Reversível por config.

**D4 — A recusa `story_pack_overflow` no tempo de validação do plano é estruturalmente aproximada.**
`architecture.md` §5.8 fixa a recusa por teto de pack no validador do plano, mas o pack só é montável
no `prepare` (skills fechadas, contexto recuperado, seção de rodada) — `architecture.md` §7. O
validador só pode estimar (§9). Proposta: nomear as duas verificações no ADR 0008 — estimativa no
plano (divide) e medição no `prepare` (poda contexto, nunca contrato, e reabre divisão se o contrato
sozinho estourar) — para que a recusa não seja lida como garantia dura onde ela é heurística.

---

## Referências cruzadas

`architecture.md` §3 (C15, C18), §4, §5, §7, §12 (E48, E50, E51, E53–E56, E58, E59, E61, E63–E66) ·
ADR 0007, 0008, 0016, 0018, 0019 ·
`docs/specs/engine-durability.md` (ciclo, journal, reconciliação) ·
`docs/specs/context-firewall-telemetry.md` (tetos, ordem, manifesto) ·
`docs/specs/skill-fabric.md` (fecho ≤3 no `prepare`) ·
`docs/specs/frontend-quality-engine.md` (DesignBrief, D1–D6) ·
`docs/specs/adapters-capability-registry.md`
(roles, fallbacks) · `schemas/plan.schema.json`, `schemas/task-contract.schema.json`,
`schemas/eval.schema.json`, `schemas/ade-config.schema.json` · §12 deste documento (F1–F12) ·
`docs/roadmap.md` (v0.3).
Evidência: digest #10, #22, #26, #27, #28, #2 · `landscape-harnesses.md` §3–4 ·
`landscape-dev-workflows.md` (a1, c2) · `design-panel/proposal-C-intent.md` §4, §7, §11 ·
`design-panel/judgment-J2-journeys.md` §1, §4, §5.
