# TL-ADE — As 6 jornadas obrigatórias validadas contra a arquitetura v3

Data: 2026-09-17. Fonte canônica: `docs/architecture.md` (v3). Este documento não redescreve a
arquitetura: percorre os seis pedidos de `PROMPT.md` §5 contra ela e mostra onde cada componente
entra, quanto custa e o que acontece quando dá errado. Nenhuma decisão de `architecture.md` é
alterada aqui; as objeções levantadas na primeira escrita foram arbitradas em `architecture.md` §11
e o resultado está em §10.

## 1. Convenções de custo e de tempo

Aritmética sobre os únicos pisos medidos. Tudo derivado é **[hipótese]** até o dogfood medir.

| Grandeza | Valor | Origem |
| :--- | ---: | :--- |
| Piso de entrada do Codex headless (`--ignore-user-config`) | 19,4k tok | digest #27 |
| Corte duro do Context Pack | 120 000 bytes | architecture.md §11 E13 (`limits.max_pack_bytes`, [hipótese], calibrar por p90) |
| Alvo de projeto do pack, por estimativa | 40k tok | architecture.md §7 |
| Teto da seção de rodada no pack | 24 000 bytes | architecture.md §11 E13 |
| Teto da seção `contract` no pack | 32 000 bytes | architecture.md §12 E50 ([hipótese]; estouro é `story_pack_overflow` e reabre a divisão da story) |
| Diff entregue ao Checker | 60 000 chars | architecture.md §11 E13 (`review.max_diff_bytes`) |
| Teto do bloco de skills no pack | ≤7,5k tok por skill, soma ≤20k | architecture.md §11 E14 |
| Teto de invariantes do repo no pack | 1,5k tok | architecture.md §7, §10 A11 |
| Julgamento visual (screenshot + rubrica) | ~US$ 0,04 | `landscape-evals-visual.md` §anti-padrões |

Packs usados nas contas [hipótese]: `trivial` ~6k (sem skills); `bounded` ~15k; `feature` ~24k;
`subsystem`/`project` ~32k. Saída: Maker 2–4k, Checker ~1,5k, juiz ~0,8k. Chamada de Checker Codex
= 19,4k (piso) + pack.

**Tempo até a primeira edição de fonte** = a métrica U1, `first_source_edit_ms`: do `ade run` até o
primeiro `local_write` em arquivo fora de `.ade/` que não seja arquivo de eval, medido pelo journal. A
definição operacional única vive em `vision.md` §3 e esta seção a cita por referência (§12 E54); vale
igual para as seis jornadas (responde `judgment-J2-journeys.md` §5.1 e §3-B2). Aprovação humana não
conta; o relógio pausa em `awaiting_operator`.

---

## 2. Jornada 1 — "Corrija esse botão que não funciona"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `trivial`. Verbo de correção + alvo singular + discovery acha um só componente candidato. Faixa rápida de `architecture.md` §5.4. |
| **Context discovery** | `package.json`, `tsconfig.json`, runner de teste, `rg` pelo rótulo do botão → 1 arquivo (`src/components/LoginButton.tsx`) + 1 teste vizinho; `.ade/config.json`; nenhuma missão anterior tocando o arquivo. |
| **Perguntas** | **Nenhuma.** A faixa rápida não abre entrevista. |
| **Pesquisa** | Não (classe < `feature`). |
| **Skills** | Nenhuma. Seleção é pulada: o bloco de skills do pack fica vazio na faixa rápida. |
| **Papéis** | Classificador: regra determinística primeiro (1 arquivo tocado no discovery + verbo de correção); chamada de modelo só com confiança < 0,6 (§11 E18) e, quando roda, conta no teto de ≤2 chamadas. Maker: `claude` Sonnet 5. Checker de rodada: **só se o diff tocar mais de 1 arquivo-fonte** (`fast_lane.checker_threshold_files`, §5, tabela de classes). |
| **Contratos** | 1 story, contrato mínimo com `evals: []` na aprovação — exceção única de mutabilidade (§11 E2). O Maker preenche `evals` uma vez (`author: 'maker'`) na mesma chamada da correção, gravado como step `local_write` com `eval_authored_by`; o vermelho diferido (`must_fail_before`) é condição de validade. |
| **FQE** | Detector só: `impeccable detect --json` se o arquivo for de UI. Sem build/serve/juiz. `ENGINE_VERSION` do Impeccable divergente do pin é **falha do doctor** (fail-closed, nunca aviso): o FQE entra em modo degradado e a story com UI para em `awaiting_operator{reason:'fqe_unavailable'}`, enquanto story sem UI segue (§12 E45). |

Contrato (essencial):

```
id: s1  complexity: trivial
task: "o botão de login não dispara o submit"
guardrails: { scope_paths: ["src/components/LoginButton.tsx","src/**/*.test.tsx"],
              do_not_touch: ["src/auth/session.ts"], autonomy: "safe" }
requirements: [{ id: R1, ears: "WHEN o usuário clica em Entrar com credenciais válidas
                                THE SYSTEM SHALL submeter o formulário de login" }]
scenarios:  [{ id: C1, given: "formulário preenchido", when: "clique em Entrar",
               then: "onSubmit é chamado uma vez", evals: ["E1"] }]
evals: []        # vazio na aprovação; preenchido uma vez pelo Maker (§11 E2):
                 # { id: E1, kind: "repro", cmd: ["npm","test","--","LoginButton"], expect_exit: 0,
                 #   strictness: { mode: "must_fail_before" }, author: "maker" }
budget: { max_model_calls: 6, max_rework_rounds: 1 }   # §12 E65 emenda §11 E4: max_model_calls =
                 # 2 + 2·visual_rounds + 2·(max_rework_rounds + 1) [hipótese]; a meta da faixa rápida
                 # continua ≤2 chamadas, o teto é que subiu
```

**DAG**: linear, sem `depends_on`. `prepare` → `implement` (Maker escreve eval + correção) →
`eval_run:red` contra `tree_before` → `eval_run:green` contra `tree_after` → `contain` + canário →
`gates` → `commit` local → `local_merge` fast-forward na base quando ela não mudou (§12 E64).

**Resultado e evidência**: 1 commit local na branch da story em `.ade/wt/s1`, `EvalRecord` vermelho e
verde no journal, extrato do teste em `artifacts/`, `report.md` de 15 linhas. `safe` autoriza commit
local **e** o `local_merge` fast-forward da branch da story na branch base quando a base não mudou
desde o `prepare` (ff-only, ref de origem preservada em `refs/ade/`, §12 E64) — é isso que fecha a
jornada 1 sem deixar um verbo de git para o operador; push, PR e merge remoto continuam fora da v1
(C22; v0.2). Se a base mudou, o commit fica na branch da story e o `report.md` imprime o comando de
merge, como o takeover imprime o comando de sessão.

**Custo** [hipótese]: 1–2 chamadas. Maker ~6k in + 2k out; classificador ambíguo, +2k in. Total
≈ 8k in / 2,5k out — uma ordem de grandeza abaixo de qualquer chamada Codex (19,4k só de piso).

**Tempo até a primeira edição de fonte**: ≤30 s. O `prepare` liga `node_modules` do worktree ao
checkout base por junction (Windows) quando o hash do lockfile bate — é o que mantém os ≤30 s; com
lockfile divergente, classe ≥ `bounded` roda o instalador do discovery como step `prepare`
(`prepare_dependency_ms` na telemetria) e `trivial` para em `awaiting_operator{reason:'environment'}`
(§12 E49). O teste
`fast_lane_trivial_starts_within_30s_zero_questions` é critério de saída da **v0.3** (§11 E40); o
slice 1 só grava `first_source_edit_ms` como baseline.

**Intervenção e falha**: nenhuma no caminho feliz. Eval que nasce verde → story volta ao Intent
Compiler, não ao Maker (§7 Eval-first): o bug não estava onde o discovery achou. Vermelho por
`missing_target`, `compile_error` ou `environment` não conta como vermelho válido e, em `trivial`,
**não** rebaixa para `additive` (que exigiria um eval `negative` ou um spot-check `mutate`,
inexistentes nesta classe): a story para em `awaiting_operator{reason:'red_unproven'}` com o diff
pronto, e `ade decide s1 --option accept_unproven` a fecha como `complete` com a `decision` gravada
(§12 E51, emendando §11 E12). Suíte que executa zero teste é `missing_target`, nunca verde: o C9 exige
reporter estruturado (`--reporter=json` no Vitest/Jest, equivalente por runner) e `numTotalTests ≥ 1`
(§12 E58). Eval verde após rework 1 e ainda errado → `ade eval s1` (§11 E38) ou
`ade discard <missão>`. Não há escalação automática porque não há Checker: a concessão é explícita e
fica medida por `eval_authored_by: 'maker'`.

---

## 3. Jornada 2 — "Melhore o design dessa página"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `bounded`. Escopo espacial fechado (uma rota), sem novo comportamento, mas com julgamento estético → 1–3 stories. |
| **Context discovery** | Rota e componentes da página; `DESIGN.md`/`PRODUCT.md` (presente ou ausente decide a pergunta 2); framework de estilo; script de build e de dev server; `impeccable` instalado; Playwright presente. |
| **Pesquisa** | Não: nenhuma incógnita `external_fact` declarada (o gatilho é a incógnita, não a classe — §11 E19; em `bounded` o teto seria ≤1 consulta sem time). |
| **Skills** | ≤3, após filtro duro (domínio `frontend`, linguagem `ts`) → BM25 top-8 → seletor barato: `frontend-design` (local, vence por nome), `improve-ui` (`ibelick/ui-skills`), `accessibility`. Soma ≤20k tokens, cada skill ≤7,5k (§11 E14, §12 E70); o filtro duro não elimina por tamanho antes do BM25. |
| **Papéis** | Intent Compiler: `claude` forte. Maker: `claude` Sonnet 5. Checker de rodada: `codex exec --json --output-schema review-result.schema.json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0` (§11 E16), vendor diferente do Maker (§11 E10). Juiz visual: `codex` (multimodal por `-i, --image`, `capabilities-codex.md` §6) — família diferente do Maker, pinado por `model_id` no contrato (§11 E9). |

**Perguntas (≤2, múltipla escolha, recomendação primeiro)**

1. "Esta página serve para **operar**, **convencer**, **ler** ou **experimentar**?
   (a) operate — recomendado, o discovery achou tabela e filtros; (b) persuade; (c) read;
   (d) experience; (e) não sei."
2. "Posso alterar os tokens globais do projeto ou só esta página?
   (a) só esta página — recomendado, não há `DESIGN.md`; (b) criar `DESIGN.md` e alterar o projeto
   inteiro; (c) não sei."

**"não sei"** grava a opção recomendada como default, registra `unknown` no contrato (campo
`direction.self_critique` cita o default assumido) e a decisão entra no resumo de aprovação e no
`report.md`. Não vira pesquisa nesta classe.

**DesignBrief** (obrigatório, §4): `product` do `PRODUCT.md` ou 2 linhas do discovery;
`tokens` = paleta dominante + 2 acentos em CSS variables, escala tipográfica, espaçamento;
`surface_mode: 'operate'`; `direction: { name: "Ferramenta densa e calma", signature: "hierarquia
por peso, não por cor", self_critique: "risco de monotonia; um acento só no estado ativo" }` —
`self_critique` é obrigatório (`minLength`, §11 E39);
`guardrails_default` = fontes genéricas e gradiente roxo penalizados, **não vetados** (digest #18).

**DAG**: s1 (tokens + layout) → s2 (estados e motion, `depends_on: [s1]`). Serial.

**Gates e Checker**: `gates` (typecheck, lint, build, lint anti-slop Oxlint por flag — ele vive no
Gate runner C8, não no FQE, §11 E39) → **FQE** entre `gates` e `review`
(`architecture.md` §5.10): build verde → serve → a11y snapshot + console + rede +
`impeccable detect --json` contra a URL renderizada → D1–D5 (todos dependentes de render) →
screenshots 2 larguras × claro/escuro → juiz Codex com rubrica de 6 critérios, corte 7,5 com
especificidade ≥7, ≤2 rodadas (1 rodada de rework reservada no `prepare` por ser story de UI) →
Checker de rodada Codex sobre o diff, cortado em `review.max_diff_bytes` (60 000 chars, por arquivo
em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>`).

**Custo** [hipótese]: 2 stories × (Maker 1 + juiz 1,4 + Checker 1 + rework 0,5) ≈ 8 chamadas, mais
classificação 1 e expansão 1 = **10 chamadas**. Tokens: Claude ~15k×3,5 ≈ 53k in; Codex = 2 Checkers
× (19,4k + 15k) ≈ 69k + 3 juízes × (19,4k + ~3k) ≈ 67k ≈ **136k in** — o pack do juiz é só capturas +
`design_brief` + `task` + rubrica, nada de repositório (`frontend-quality-engine.md` §5), e o juiz usa
a mesma receita curta do Checker (§11 E16). Total ≈ 190k in / ~18k out.

**Tempo até a primeira edição de fonte**: ~2–4 min (discovery + 2 chamadas + a espera pela resposta
das 2 perguntas e pela aprovação única, que não contam no relógio).

**Intervenção e falha**: entrevista, aprovação única, e `awaiting_operator` do FQE após 2 rodadas
com nota <7,5 — entregue como **escolha preguiçosa**: screenshots das duas rodadas lado a lado em
`report.md` (caminhos absolutos por parada) e `ade decide s1 --option retry|skip|discard|pick
--value <id>` (§11 E32). Nota 7,4 na rodada 2 é o caso comum: a story
`parked` não bloqueia a irmã sem `depends_on`. Se o operador odiar as duas versões: `ade discard`.

---

## 4. Jornada 3 — "Refaça todo o frontend para parecer produto profissional"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `subsystem` (9–20 stories, epics). Escopo = todas as rotas; risco de regressão em fluxo existente; UI em toda story. Não é `project`: não há produto novo nem backend novo. |
| **Context discovery** | Inventário de rotas (roteador ou `pages/`/`app/`), componentes compartilhados, `DESIGN.md`, testes e2e existentes, CI, dependências de UI, contagem de arquivos por rota (alimenta o corte de story por teto de pack). |
| **Pesquisa** | **Não.** "O que o público do setor espera da linguagem visual" é `product_choice`, não `external_fact`: não tem fonte tier 1–3 e voltaria como `preference` de tier 5–6 (`intent-compiler.md` §7), e a pergunta 1 da entrevista já a resolve. Como o gatilho é o `kind` da incógnita (§11 E19), não há chamada de pesquisa nesta jornada. |
| **Skills** | `frontend-design` (local), `design-system`, `improve-ui`, `accessibility` — ≤3 por story, variando por story (a de tokens leva `design-system`; as de tela levam `improve-ui`). |
| **Papéis** | Intent Compiler `claude` forte; Maker `claude` **Opus** (classe ≥ `subsystem`, §7 roteamento); Checker de rodada `codex`; Checker de portão `claude --permission-mode plan` por epic; juiz `codex`. |

**Perguntas (3–4)**

1. "Qual direção visual? (a) densa e calma, escala tipográfica forte — recomendado para ferramenta;
   (b) editorial com respiro alto; (c) produto de consumo com cor saturada; (d) não sei."
2. "Posso quebrar a aparência de rotas que hoje ninguém reclama? (a) sim, coerência primeiro —
   recomendado; (b) não, só as 4 rotas principais; (c) não sei."
3. "Posso adicionar dependência de UI (headless components)? (a) não, só CSS e o que já existe —
   recomendado; (b) sim, uma biblioteca headless; (c) não sei."
4. "Há alguma tela que não posso tocar? (texto livre, default: nenhuma)" — só aparece se o discovery
   achar rota marcada como legada.

**Estrutura**: 1 epic de fundação (tokens, primitivos, `DESIGN.md`) + 1 epic por grupo de rotas.
~14 stories. O teto de pack é verificado duas vezes (§11 E20): estimativa no plano, que divide por
cenário e recusa a story grande com pedido de divisão (§5.8), e medição em bytes no `prepare`, que
poda o contexto recuperado — nunca o contrato — e reabre a divisão se o contrato sozinho estourar.

**DAG**: s1 (tokens/`DESIGN.md`) → s2, s3 (primitivos) → 10 stories de rota com
`depends_on: [s2, s3]` e **sem** dependência entre si → s14 (varredura de consistência,
`depends_on` de todas). N=1 na v1: o scheduler tem o conjunto `next_ready`, executa um por vez.

**Gates**: por story, `gates` + FQE completo (D1–D6 dependentes de render + juiz; §11 E39). Por epic, `checker_gate`
(cobertura, Claude) antes do merge. `contain` + canário de isolamento em toda story.

**Custo** [hipótese]: 14 stories × (Maker 1 + juiz 1,4 + Checker rodada 1 + rework 0,6) ≈ 56;
+ 3 `checker_gate`; + 3 de planejamento ≈ **62 chamadas** (sem pesquisa).
Tokens: Claude ~24 chamadas × 32k ≈ 770k in; Codex = 14 Checkers × (19,4k + 32k) ≈ 720k + ~20 juízes
× (19,4k + ~3k) ≈ 450k ≈ 1,17M in (o juiz não carrega pack de repositório,
`frontend-quality-engine.md` §5). Total ≈ 1,95M in / ~90k out. Juízes visuais: ~20 × US$ 0,04 ≈
US$ 0,8 do total.

**Tempo até a primeira edição de fonte**: ~10–16 min (discovery grande + plano forte, sem pesquisa
serializada).
O relógio pausa na aprovação única.

**Intervenção e falha**: entrevista, aprovação única e paradas visuais por story.
`ade takeover <story>` imprime `claude --resume <uuid> --add-dir ... --settings ...` (a v1 reimprime
as flags que `--resume` não restaura), grava `.ade/missions/<id>/takeover-<story>.cmd` e `.ps1`
(§11 E32) e registra `human_takeover`; `ade release <story>` faz checkpoint e devolve ao ciclo.
Rework ≤N por story; estagnação e loop são gatilhos determinísticos → `parked` — inclusive
assinatura de falha idêntica em duas tentativas (`findings_digest`, §10 A6 e §11 E22);
`target_role: 'human'` é o único gatilho semântico. Mudança de rumo sem takeover:
`ade steer <missão> "<nota>"` enfileira a intenção, consumida no `prepare` da próxima story (§11
E32). Descarte de uma rota: `ade decide s7 --option skip`; do redesign inteiro: `ade discard <missão>`.

---

## 5. Jornada 4 — "Adicione billing com Stripe"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `feature` (4–8 stories, 1 epic). Comportamento novo, superfície limitada, incógnita `external_fact` declarada (versão de API e modelo de cobrança) → é ela que dispara a pesquisa, dentro do teto de 3 consultas da classe (§11 E19). |
| **Context discovery** | Framework de backend, ORM/migrations, rotas de API, variáveis de ambiente existentes, teste de integração, `sensitive_paths` (`.env*`, `secrets/`), se já há `stripe` em `package.json`. |
| **Pesquisa** | **Sim**, 1 chamada com schema: versão estável da API do Stripe, Checkout vs Elements para o caso, forma canônica de verificar webhook. Empate entre fontes vira pergunta, nunca desempate oculto. |
| **Skills** | `api-design`, `backend-patterns`, `database-migrations`. `security-review` entra no `checker_gate`, não no pack do Maker. |
| **Papéis** | Maker `claude` Sonnet 5; Checker de rodada `codex` (precisão — CR-bench 88 %, digest #5); Checker de portão `claude` (cobertura) antes do merge; sem juiz visual salvo a story da página de planos. |

**Perguntas (2–3)**

1. "Modelo de cobrança? (a) assinatura mensal com um plano — recomendado, é o que o `PRODUCT.md`
   descreve; (b) assinatura com 2+ planos; (c) pagamento avulso; (d) não sei."
2. "Checkout hospedado pelo Stripe ou formulário embutido? (a) Checkout hospedado — recomendado,
   tira PCI do escopo; (b) Elements embutido; (c) não sei."
3. "Posso rodar migration no banco de desenvolvimento? (a) sim — recomendado; (b) só gerar o arquivo
   e eu aplico; (c) não sei." → autonomia `controlled` (§7).

**"não sei"** aqui é mais caro: grava o default, registra a incógnita **e** anexa o `research_refs`
correspondente ao contrato, de modo que o Checker de portão verifique a decisão contra o achado.

**Contratos**: 6 stories — s1 chaves e cliente; s2 modelo de dados + migration; s3 Checkout session;
s4 webhook com verificação de assinatura; s5 estado de assinatura no app; s6 página de planos (única
com `design_brief`). Exemplo (s4):

```
id: s4  complexity: feature  depends_on: [s2]
task: "receber e aplicar eventos de assinatura do Stripe com segurança"
guardrails: { scope_paths: ["src/api/webhooks/**","src/billing/**","test/**"],
              do_not_touch: ["src/auth/**"], sensitive_paths: [".env",".env.local"],
              autonomy: "controlled", ask_operator: ["dependency_add"] }
requirements:
  - R1 "WHEN um webhook chega com assinatura inválida THE SYSTEM SHALL responder 400 e não alterar estado"
  - R2 "WHEN chega checkout.session.completed com assinatura válida THE SYSTEM SHALL marcar a conta como ativa"
  - R3 "WHEN o mesmo event.id chega duas vezes THE SYSTEM SHALL aplicar o efeito uma única vez"
scenarios:
  - C1 given "payload adulterado" when "POST /webhooks/stripe" then "400 e conta intacta"       evals [E1]
  - C2 given "evento válido de conta trial" when "POST" then "status = active"                  evals [E2]
  - C3 given "evento já processado" when "POST repetido" then "1 linha em subscription_events"  evals [E3]
evals:
  E1 kind: negative   cmd ["npm","test","--","webhook.signature"]   must_fail_before
  E2 kind: test       cmd ["npm","test","--","webhook.activate"]    must_fail_before
  E3 kind: contract   cmd ["npm","test","--","webhook.idempotent"]  must_fail_before
budget: { max_model_calls: 10, max_rework_rounds: 3, max_usd: 4 }   # defaults de classe, §11 E4 [hipótese]
```

**DAG**: s1 → s2 → {s3, s4} → s5 → s6. s3 e s4 são irmãs independentes.

**Gates e Checker**: `gates` (typecheck, lint, build, migration dry-run) → Checker de rodada Codex
com `--sandbox read-only` → rework ≤3 (classe `feature`, §11 E4) → `checker_gate` Claude com foco em segredo no diff e
cobertura dos 3 EARS → `commit` → `push`/`pull_request` (v0.2+, autonomia `controlled`) → `merge`.
`contain` roda o diff integral contra padrões de segredo **antes** de `scope_paths` (§3 C7). A
deny-list de caminhos fora do worktree (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) não vive no `contain`,
que só vê o diff: ela está no `env` filtrado, no canário e no doctor (§11 E23). `unit-result` e
`review-result` desta story carregam `sources[]` com os digests das seções do pack usadas (§11 E8).

**Custo** [hipótese]: 6 stories × (Maker 1 + Checker 1 + rework 0,7) ≈ 16; + pesquisa 1 + plano 2 +
`checker_gate` 1 + s6 juiz 1,4 ≈ **22 chamadas**. Tokens: Claude ~11 × 24k ≈ 264k in; Codex ~9 ×
(19,4k + 24k) ≈ 390k in. Total ≈ 655k in / ~35k out.

**Tempo até a primeira edição de fonte**: ~6–10 min (pesquisa serializada antes do plano).

**Intervenção e falha**: `action_item` com `category: 'bad_spec'` e `target_role: 'planner'` devolve
a story ao Intent Compiler, não ao Maker (caso típico: "o contrato não previu proração").
`intent_gap` + `target_role: 'human'` → `awaiting_operator`. Rede indisponível no `push` →
`awaiting_operator`, nunca retry (§6).

---

## 6. Jornada 5 — "Crie um SaaS novo a partir dessa ideia"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `project`. Fases → epics → stories; repositório vazio ou quase; tudo é incógnita. |
| **Context discovery** | Quase vazio, e isso é informação: sem manifesto, sem testes, sem `DESIGN.md`. O discovery devolve "greenfield" e o Intent Compiler sabe que nenhuma pergunta é respondível pelo repo — as 5 perguntas são legítimas. |
| **Pesquisa** | **Time paralelo (2–4, famílias diferentes, somente-leitura, opt-in por config)**, disparado pelas incógnitas `external_fact` do greenfield (§11 E19): stack e hospedagem, concorrentes e precificação, requisitos regulatórios do domínio, riscos de implementação. Empate vira pergunta. |
| **Skills** | Por fase: `market-research` e `deep-research` na fase 0; `api-design`, `backend-patterns`, `postgres-patterns`, `database-migrations` na fase 1; `frontend-design`, `design-system`, `accessibility` na fase 2; `e2e-testing`, `deployment-patterns` na fase 3. Sempre ≤3 por story. |
| **Papéis** | Intent Compiler `claude` forte; pesquisa `agy` → `claude` (v0.x, somente-leitura até o canário de isolamento passar; `--dangerously-skip-permissions` é a flag desatendida da família Google — o `--approval-mode yolo` é do Gemini CLI, que não faz parte da ADE); Maker `claude` Opus; Checker de rodada `codex` (vendor diferente do Maker, §11 E10 — `agy` serve modelos Claude e por isso não substitui o Checker de um Maker Claude); Checker de portão `claude`; juiz `codex`. |

**Perguntas (5, o teto)**

1. "Quem paga por isto? (a) empresa pequena por assinatura — recomendado; (b) profissional autônomo;
   (c) consumidor final; (d) não sei."
2. "Qual é a única coisa que a v1 tem de fazer bem? (texto livre, ≤140 chars)."
3. "Stack: (a) Next.js + Postgres + Vercel — recomendado, é o que a pesquisa converge; (b) outra que
   eu indico; (c) não sei."
4. "Quem entra: (a) e-mail e senha — recomendado; (b) OAuth de um provedor; (c) não sei."
5. "Dados sensíveis (saúde, financeiro, menores)? (a) não — recomendado; (b) sim, especificar;
   (c) não sei." → resposta (b) força `autonomy: 'restricted'` em stories de dados.

**"não sei"** em uma pergunta de fase 0 promove a incógnita: o default é gravado, a story afetada
ganha `research_refs`, e o `checker_gate` da fase verifica a decisão contra o achado. Duas ou mais
respostas "não sei" nas perguntas 1–3 fazem o plano nascer com **fase 0 de validação** (um protótipo
descartável com eval próprio) antes das fases de construção.

**Estrutura**: 4 fases, ~7 epics, ~30 stories, em **duas aprovações**. No greenfield o discovery não
tem `scripts` nem runner detectado, e a camada 6 do Intent Compiler recusa todo eval cujo `cmd[0]` não
esteja lá (`eval_cmd_unknown`, `intent-compiler.md` §4 e §8): as fases 1–3 não são validáveis por ajv
antes de existir manifesto. Então a **fase 0 é planejada e aprovada sozinha** — ela começa pela story
de scaffold, que cria manifesto, runner de teste e scripts; concluída ela,
`ade plan "<o resto>" --from <missão>` (§11 E32) reroda o discovery, herda respostas e stories
concluídas e produz as fases 1–3 já validáveis contra os `scripts` que passaram a existir, numa
segunda aprovação. As fases seguintes herdam essa aprovação e o orçamento reservado pelo scheduler.

**DAG**: fase 0 (scaffold do manifesto, esquema de dados e contratos de API, 4 stories serial) → fase 1 (backend, 9 stories
com 2 frentes independentes) → fase 2 (UI, 11 stories, todas com `design_brief`, dependendo de s1 de
tokens) → fase 3 (e2e, deploy, observabilidade, 6 stories). N=1 na v1.

**Gates**: idênticos à J4 por story; `checker_gate` por epic; FQE completo (D1–D6 + juiz) em toda story da fase 2, cada uma com 1 rodada de rework reservada no `prepare` (§11 E39);
`contain` com `sensitive_paths` desde a story 1.

**Custo** [hipótese]: 30 stories × (Maker 1 + Checker 1 + rework 0,8) ≈ 84; + 11 FQE × 1,4 ≈ 15
juízes; + 7 `checker_gate`; + 4 de pesquisa; + 6 de planejamento ≈ **116 chamadas**.
Tokens: Claude ~55 × 32k ≈ 1,76M in; Codex ~61 × (19,4k + 32k) ≈ 3,14M in. Total ≈ 4,9M in /
~190k out. Não cabe numa noite: 3–5 missões encadeadas, cada uma retomável.

**Tempo até a primeira edição de fonte**: ~30–50 min. É a jornada onde o tempo até começar não é a
métrica — a métrica é intervenções humanas por story.

**Intervenção e falha**: cada fase termina em `checker_gate`; reprovação de portão para a fase, não
o projeto. `ade discard` descarta o lote da missão; a fase anterior, já mergeada, sobrevive.

---

## 7. Jornada 6 — "Continue desenvolvendo sozinho enquanto durmo"

**Não é classe de complexidade** (`architecture.md` §5, parágrafo final): é missão com `autonomy` e
orçamento de parede sobre um **backlog já aprovado**, que retoma sem nova entrevista e para em
`awaiting_operator` ao esgotá-lo. O orçamento de parede tem casa no schema: `plan.mission_budget:
{ max_wall_clock_seconds, max_parked_units, max_usd }`, gravado no `batch_open` (§11 E3); defaults
da jornada 6: 8 h e 3 unidades parqueadas [hipótese]. `permitted_effects` do plano lista só efeitos
externos; classes internas (`model_call`, `eval_run`, `local_write`, `gate`, `prepare`) são
implícitas.

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | Missão desatendida. Herda as classes das stories que já estão no plano aprovado — não reclassifica nada. |
| **Context discovery** | Só o delta: `git log` desde o último `complete`, stories `ready`/`parked`, orçamento restante, `capabilities.json` com `probe_ok` fresco — `probe_ok: null` fora de CI recusa despacho, nunca degrada (§11 E10). |
| **Perguntas** | **Nenhuma.** Se o backlog estiver vazio ou tiver story sem contrato aprovado, o comando falha na hora com a lista, em vez de abrir entrevista de madrugada. |
| **Pesquisa** | Só a já declarada nos contratos existentes; nenhuma pesquisa nova é iniciada sem operador. |
| **Skills** | A aprovação única congela o conjunto elegível da missão (união do top-8 por story), e só skill **fora desse conjunto** parqueia em lote desatendido (§11 E33). Scripts de skills de catálogo nunca ficam disponíveis ao agente na v1: só o corpo do `SKILL.md` e `references/*.md` como texto (§11 E35). |
| **Papéis** | Iguais aos das stories no plano. `no_checker_family_available` → `parked`, nunca aprovado sem revisão. |

**Comando e forma**: `ade run --unattended --plan .ade/missions/<id>/plan.json` com `autonomy: 'safe'`
(ou `controlled` se push/PR foram autorizados na aprovação única) e o `mission_budget` do plano.
`restricted` não tem bloco de famílias: é `dispatch: never` com motivo `autonomy_requires_operator`
e herda `scope_paths` da story (§11 E5). Precondição dura (§10 A5): `--unattended` recusa sem
(a) gates ativos, (b) baseline de eval verde, (c) caminho de rollback em `refs/ade/`,
(d) isolamento por worktree verificado pelo canário. `runtime_stamp` divergente no `core_version`
bloqueia com `stale_workflow_version` até `ade run --accept-stale-version`, gravado como `decision`
(§11 E7, E32).

**DAG/ordem**: o scheduler pega `next_ready` a cada ciclo; story `parked` **não** bloqueia irmãs sem
`depends_on` — só as dependentes viram `blocked`. É o que mantém a noite viva depois da primeira
parada. Ao atingir `max_parked_units` ou `max_wall_clock_seconds`, a missão fecha em
`awaiting_operator` com motivo.

**Gates**: os mesmos das classes das stories. O `checker_gate` de portão é obrigatório antes de
qualquer `merge` desatendido.

**Custo** [hipótese] para 8 h com stories `bounded`/`feature` e N=1: ~11 stories concluídas,
~30 chamadas, ≈1,1M tok de entrada. O limitante não é o orçamento e sim o wall clock: uma story
`feature` com FQE consome 25–45 min entre build, serve, Playwright e três chamadas.

**Tempo até a primeira edição de fonte**: ~10 s. É a segunda jornada mais rápida do conjunto,
porque não há discovery grande, entrevista nem aprovação — só lease, `prepare` e pack.

**Manhã**: `ade report <missão>` derivado do journal — feito, mudado, evidência, caminhos absolutos
dos screenshots das paradas visuais, decisões pendentes, custo com `cost_source`, mais o evento
`scope: 'mission_summary'` do fechamento (intervenções, perguntas, wall time, verbos de CLI usados;
§11 E11). `ade journal --unit <story>` para o porquê. `ade decide <unit> --option
retry|skip|discard|pick --value <id>` resolve a fila; `ade show <ref> --open` abre o par de imagens
no visualizador do SO. Enquanto houver `awaiting_operator` com `batch_state: in_progress`, os
comandos saem com exit 3 (§11 E31). `ade discard <missão>` descarta a noite inteira em um comando,
com tudo preservado em `refs/ade/discarded/` — que acumula; o volume é reportado por `ade doctor` e
a purga é comando manual pós-v1 (§11 E36).

**Quando é ruim**: o caso que importa é "acordei e odiei tudo". A resposta é `ade discard` + o
`report.md` como resumo legível; nada é apagado e o `journal.jsonl` continua auditável.

---

## 8. Tabela comparativa

| | J1 botão | J2 página | J3 frontend | J4 Stripe | J5 SaaS | J6 noite |
| :--- | :-- | :-- | :-- | :-- | :-- | :-- |
| Classe | trivial | bounded | subsystem | feature | project | — (missão) |
| Perguntas | 0 | 2 | 3–4 | 2–3 | 5 | 0 |
| Pesquisa (por incógnita `external_fact`) | não | não | não (incógnita é `product_choice`) | 1 chamada | time 2–4 | não |
| Plano | contrato mínimo | 2 stories | ~14 stories, 3 epics | 6 stories, 1 epic | ~30 stories, 4 fases | herdado |
| Skills/story | 0 | ≤3 | ≤3 | ≤3 | ≤3 | herdadas |
| Maker | Sonnet 5 | Sonnet 5 | Opus | Sonnet 5 | Opus | herdado |
| Checker rodada | condicional (diff > 1 arquivo-fonte) | Codex | Codex | Codex | Codex | herdado |
| Checker portão | não | não | por epic | 1 | por epic | obrigatório |
| FQE | detector | D1–D5 + juiz | completo (D1–D6), 14× | 1 story | 11 stories | herdado |
| Chamadas [hip.] | 1–2 | ~10 | ~62 | ~22 | ~116 | ~30/noite |
| Tokens in [hip.] | ~8k | ~190k | ~1,95M | ~655k | ~4,9M | ~1,1M |
| 1ª edição de fonte | ≤30 s | 2–4 min | 10–16 min | 6–10 min | 30–50 min | ~10 s |
| Aprovações humanas | 0 | 1 | 1 | 1 | 2 (fase 0, depois o resto) | 0 (a da missão) |
| Saída | commit local | commit + screenshots | PRs por epic | PR | PRs por fase | fila + `report.md` |

---

## 9. Os cinco "missing everywhere" do `judgment-J2-journeys.md` §5

| # | Buraco | Resposta nesta arquitetura |
| :-- | :--- | :--- |
| 1 | **Métricas de UX sem eval** | §1 define "tempo até a primeira edição de fonte" uma vez para as seis jornadas; a J1 vira o teste `fast_lane_trivial_starts_within_30s_zero_questions`, critério de saída da v0.3, e o slice 1 grava `first_source_edit_ms` como baseline (§11 E40). Perguntas e chamadas são contáveis no journal (`kind: 'decision'` com `source`, e `effect_class: 'model_call'`), então as três métricas do `PROMPT.md` §7 são derivadas, não declaradas. O N da faixa rápida está fixado em 1 arquivo-fonte (`fast_lane.checker_threshold_files`). |
| 2 | **"não sei"** | Resposta de primeira classe em todas as jornadas: grava o default recomendado, registra a incógnita no contrato, aparece no resumo de aprovação e no `report.md`. Em classe ≥ `feature` promove a incógnita a `research_refs` e o `checker_gate` verifica a decisão contra o achado. Em `project`, 2+ "não sei" nas perguntas estruturantes fazem nascer uma fase 0 de validação. |
| 3 | **Descarte do lote + resumo humano** | `ade discard <missão>` é um comando e move tudo para `refs/ade/discarded/` (nada é apagado). `ade report <missão>` é o resumo legível derivado do journal, com evidência e custo. As duas coisas existem na v1. |
| 4 | **Aprovação visual sem navegador** | O FQE captura 2 larguras × claro/escuro por rodada; a parada por nota <7,5 entrega os pares dentro do `report.md` com caminhos absolutos, `ade show <ref> --open` abre o par no visualizador do SO e a escolha é `ade decide <unit> --option retry\|skip\|discard\|pick --value <id>` (§11 E32). |
| 5 | **Mudar de ideia no meio** | Honestamente parcial na v1. Quatro saídas: (a) `ade steer <missão> "<nota>"` enfileira uma intenção consumida no `prepare` da próxima story; (b) `ade takeover <story>` assume a sessão exata com o comando impresso (e os arquivos `.cmd`/`.ps1`) e `ade release` devolve; (c) `ade decide <unit> --option skip` pula a story **já parada** em `awaiting_operator` — é o único estado de onde `decide` sai (`master-spec.md` §6; decidir unit fora da fila é exit 1), e matar uma story `running` sem parada não existe na v1: a saída intraturno continua sendo `Ctrl+C`; (d) `ade discard`. Steering no meio do turno continua sendo o gatilho declarado para ACP (`architecture.md` §7), não v1. |

---

## 10. Divergências resolvidas

As seis objeções levantadas contra `architecture.md` foram arbitradas em `architecture.md` §11. O
texto acima já reflete cada decisão.

1. **`N` da faixa rápida** → **aceita**, `architecture.md` §5 (tabela de classes) e §11 E18: N = 1
   arquivo-fonte, publicado como `fast_lane.checker_threshold_files` em `ade-config.schema.json`.
   O critério "≤2 chamadas" passa a ser falsificável e vira o teste de saída da v0.3 (E40).

2. **Classificador determinístico primeiro** → **aceita**, `architecture.md` §11 E18: regra
   determinística primeiro em candidatos a `trivial` (1 arquivo tocado no discovery + verbo de
   correção); chamada de modelo só com confiança < 0,6 ou classe ≥ `feature`, e quando roda conta
   nas ≤2 chamadas da faixa rápida. Caminho atual mantido para `bounded`+.

3. **Skill nova na noite da J6** → **aceita**, `architecture.md` §11 E33: a aprovação única congela
   o conjunto elegível de skills da missão (união do top-8 por story); só skill fora desse conjunto
   parqueia em lote desatendido.

4. **Orçamento de parede sem casa no schema** → **aceita**, `architecture.md` §11 E3:
   `plan.mission_budget: { max_wall_clock_seconds, max_parked_units, max_usd }` gravado no
   `batch_open`, com defaults de 8 h e 3 unidades parqueadas [hipótese] para a jornada 6.

5. **Aprovação visual sem visualizador de markdown** → **aceita**, `architecture.md` §11 E32:
   `ade show <ref> --open` abre o visualizador do SO e o `report.md` emite caminhos absolutos por
   parada.

6. **Juiz único na J3** → **aceita como hipótese registrada**, `architecture.md` §11 E9: `judge`
   pinado por `model_id` no contrato e replicado no registro, `judge_family` gravado no
   `visual-eval` (9º schema publicado na v0.4b), `visual_score` comparável só dentro do mesmo juiz e
   "juiz único (Codex) com Maker sempre Claude" declarado como hipótese explícita. Rotação de juiz
   não entra na v1: continuam duas famílias (`architecture.md` §9-2).
