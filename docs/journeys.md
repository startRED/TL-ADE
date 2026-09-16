# TL-ADE — As 6 jornadas obrigatórias validadas contra a arquitetura v3

Data: 2026-09-17. Fonte canônica: `docs/architecture.md` (v3). Este documento não redescreve a
arquitetura: percorre os seis pedidos de `PROMPT.md` §5 contra ela e mostra onde cada componente
entra, quanto custa e o que acontece quando dá errado. Nenhuma decisão de `architecture.md` é
alterada aqui; objeções ficam em §10.

## 1. Convenções de custo e de tempo

Aritmética sobre os únicos pisos medidos. Tudo derivado é **[hipótese]** até o dogfood medir.

| Grandeza | Valor | Origem |
| :--- | ---: | :--- |
| Piso de entrada do Codex headless (`--ignore-user-config`) | 19,4k tok | digest #27 |
| Teto do Context Pack | 40k tok | architecture.md §7 (hipótese declarada) |
| Teto do bloco de skills no pack | 7,5k tok | architecture.md §7 |
| Teto de invariantes do repo no pack | 1,5k tok | architecture.md §7 |
| Julgamento visual (screenshot + rubrica) | ~US$ 0,04 | `landscape-evals-visual.md` §anti-padrões |

Packs usados nas contas [hipótese]: `trivial` ~6k (sem skills); `bounded` ~15k; `feature` ~24k;
`subsystem`/`project` ~32k. Saída: Maker 2–4k, Checker ~1,5k, juiz ~0,8k. Chamada de Checker Codex
= 19,4k (piso) + pack.

**Tempo até a primeira edição de fonte** = do `Enter` até o primeiro `local_write` do Maker dentro
de `.ade/wt/<story>/`. Definição única para as seis jornadas (responde `judgment-J2-journeys.md`
§5.1 e §3-B2). Aprovação humana não conta; o relógio pausa em `awaiting_operator`.

---

## 2. Jornada 1 — "Corrija esse botão que não funciona"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `trivial`. Verbo de correção + alvo singular + discovery acha um só componente candidato. Faixa rápida de `architecture.md` §5.4. |
| **Context discovery** | `package.json`, `tsconfig.json`, runner de teste, `rg` pelo rótulo do botão → 1 arquivo (`src/components/LoginButton.tsx`) + 1 teste vizinho; `.ade/config.json`; nenhuma missão anterior tocando o arquivo. |
| **Perguntas** | **Nenhuma.** A faixa rápida não abre entrevista. |
| **Pesquisa** | Não (classe < `feature`). |
| **Skills** | Nenhuma. Seleção é pulada: o bloco de skills do pack fica vazio na faixa rápida. |
| **Papéis** | Classificador: regra determinística → 1 chamada barata com `--json-schema` só se ambígua. Maker: `claude` Sonnet 5. Checker de rodada: **só se o diff tocar mais de N arquivos** (§5, tabela de classes). |
| **Contratos** | 1 story, contrato mínimo. `evals` escritos pelo Maker (`author: 'maker'`) na mesma chamada da correção, com portão `must_fail_before` mantido (enxerto de `judgment-J2-journeys.md` §4). |
| **FQE** | Detector só: `impeccable detect --json` se o arquivo for de UI. Sem build/serve/juiz. |

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
evals: [{ id: E1, kind: "repro", cmd: ["npm","test","--","LoginButton"], expect_exit: 0,
          strictness: { mode: "must_fail_before" }, author: "maker" }]
budget: { max_model_calls: 2, max_rework_rounds: 1 }
```

**DAG**: linear, sem `depends_on`. `prepare` → `implement` (Maker escreve eval + correção) →
`eval_run:red` contra `tree_before` → `eval_run:green` contra `tree_after` → `contain` + canário →
`gates` → `commit` local.

**Resultado e evidência**: 1 commit local em `.ade/wt/s1`, `EvalRecord` vermelho e verde no journal,
extrato do teste em `artifacts/`, `report.md` de 15 linhas.

**Custo** [hipótese]: 1–2 chamadas. Maker ~6k in + 2k out; classificador ambíguo, +2k in. Total
≈ 8k in / 2,5k out — uma ordem de grandeza abaixo de qualquer chamada Codex (19,4k só de piso).

**Tempo até a primeira edição de fonte**: ≤30 s (critério de aceite do slice 1, `architecture.md` §5.4).

**Intervenção e falha**: nenhuma no caminho feliz. Eval que nasce verde → story volta ao Intent
Compiler, não ao Maker (§7 Eval-first): o bug não estava onde o discovery achou. Eval verde após
rework 1 e ainda errado → `ade eval s1` manual ou `ade discard <missão>`. Não há escalação
automática porque não há Checker: a concessão é explícita e fica medida por `eval_author: 'maker'`.

---

## 3. Jornada 2 — "Melhore o design dessa página"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `bounded`. Escopo espacial fechado (uma rota), sem novo comportamento, mas com julgamento estético → 1–3 stories. |
| **Context discovery** | Rota e componentes da página; `DESIGN.md`/`PRODUCT.md` (presente ou ausente decide a pergunta 2); framework de estilo; script de build e de dev server; `impeccable` instalado; Playwright presente. |
| **Pesquisa** | Não (classe < `feature` e nenhuma incógnita declarada). |
| **Skills** | ≤3, após filtro duro (domínio `frontend`, linguagem `ts`) → BM25 top-8 → seletor barato: `frontend-design` (local, vence por nome), `improve-ui` (`ibelick/ui-skills`), `accessibility`. |
| **Papéis** | Intent Compiler: `claude` forte. Maker: `claude` Sonnet 5. Checker de rodada: `codex exec --json --output-schema review-result.schema.json --sandbox read-only`. Juiz visual: `codex` (multimodal por `-i, --image`, `capabilities-codex.md` §6) — família diferente do Maker, como §7 exige. |

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
por peso, não por cor", self_critique: "risco de monotonia; um acento só no estado ativo" }`;
`guardrails_default` = fontes genéricas e gradiente roxo penalizados, **não vetados** (digest #18).

**DAG**: s1 (tokens + layout) → s2 (estados e motion, `depends_on: [s1]`). Serial.

**Gates e Checker**: `gates` (typecheck, lint, build) → **FQE** entre `gates` e `review`
(`architecture.md` §5.10): build verde → serve → a11y snapshot + console + rede +
`impeccable detect --json` contra a URL renderizada → D1–D7 → screenshots 2 larguras × claro/escuro
→ juiz Codex com rubrica de 6 critérios, corte 7,5 com especificidade ≥7, ≤2 rodadas →
Checker de rodada Codex sobre o diff.

**Custo** [hipótese]: 2 stories × (Maker 1 + juiz 1,4 + Checker 1 + rework 0,5) ≈ 8 chamadas, mais
classificação 1 e expansão 1 = **10 chamadas**. Tokens: Claude ~15k×3,5 ≈ 53k in; Codex
(2 Checkers + 3 juízes) ≈ 5 × (19,4k + 15k) ≈ 172k in. Total ≈ 225k in / ~18k out.

**Tempo até a primeira edição de fonte**: ~2–4 min (discovery + 2 chamadas + a espera pela resposta
das 2 perguntas e pela aprovação única, que não contam no relógio).

**Intervenção e falha**: entrevista, aprovação única, e `awaiting_operator` do FQE após 2 rodadas
com nota <7,5 — entregue como **escolha preguiçosa**: screenshots das duas rodadas lado a lado em
`report.md` e `ade decide s1 --option retry|skip`. Nota 7,4 na rodada 2 é o caso comum: a story
`parked` não bloqueia a irmã sem `depends_on`. Se o operador odiar as duas versões: `ade discard`.

---

## 4. Jornada 3 — "Refaça todo o frontend para parecer produto profissional"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `subsystem` (9–20 stories, epics). Escopo = todas as rotas; risco de regressão em fluxo existente; UI em toda story. Não é `project`: não há produto novo nem backend novo. |
| **Context discovery** | Inventário de rotas (roteador ou `pages/`/`app/`), componentes compartilhados, `DESIGN.md`, testes e2e existentes, CI, dependências de UI, contagem de arquivos por rota (alimenta o corte de story por teto de pack). |
| **Pesquisa** | Sim, uma chamada com schema: "qual é a linguagem visual atual do produto e o que o público espera do setor" — só se `PRODUCT.md` não responder. Achado é dado, nunca instrução (§5.6). |
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
~14 stories. Story maior que o teto de pack é recusada na validação com pedido de divisão (§5.8).

**DAG**: s1 (tokens/`DESIGN.md`) → s2, s3 (primitivos) → 10 stories de rota com
`depends_on: [s2, s3]` e **sem** dependência entre si → s14 (varredura de consistência,
`depends_on` de todas). N=1 na v1: o scheduler tem o conjunto `next_ready`, executa um por vez.

**Gates**: por story, `gates` + FQE completo (D1–D7 + juiz). Por epic, `checker_gate`
(cobertura, Claude) antes do merge. `contain` + canário de isolamento em toda story.

**Custo** [hipótese]: 14 stories × (Maker 1 + juiz 1,4 + Checker rodada 1 + rework 0,6) ≈ 56;
+ 3 `checker_gate`; + 1 pesquisa; + 3 de planejamento ≈ **63 chamadas**.
Tokens: Claude ~25 chamadas × 32k ≈ 800k in; Codex ~34 × (19,4k + 32k) ≈ 1,75M in.
Total ≈ 2,55M in / ~90k out. Juízes visuais: ~20 × US$ 0,04 ≈ US$ 0,8 do total.

**Tempo até a primeira edição de fonte**: ~12–20 min (discovery grande + pesquisa + plano forte).
O relógio pausa na aprovação única.

**Intervenção e falha**: entrevista, aprovação única e paradas visuais por story.
`ade takeover <story>` imprime `claude --resume <uuid> --add-dir ... --settings ...` (a v1 reimprime
as flags que `--resume` não restaura) e grava `human_takeover`; `ade release <story>` faz checkpoint
e devolve ao ciclo. Rework ≤N por story; estagnação e loop são gatilhos determinísticos → `parked`;
`target_role: 'human'` é o único gatilho semântico. Descarte de uma rota:
`ade decide s7 --option skip`; do redesign inteiro: `ade discard <missão>`.

---

## 5. Jornada 4 — "Adicione billing com Stripe"

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | `feature` (4–8 stories, 1 epic). Comportamento novo, superfície limitada, incógnita externa declarada (versão de API e modelo de cobrança) → libera pesquisa. |
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
budget: { max_model_calls: 6, max_rework_rounds: 2, max_usd: 4 }
```

**DAG**: s1 → s2 → {s3, s4} → s5 → s6. s3 e s4 são irmãs independentes.

**Gates e Checker**: `gates` (typecheck, lint, build, migration dry-run) → Checker de rodada Codex
com `--sandbox read-only` → rework ≤2 → `checker_gate` Claude com foco em segredo no diff e
cobertura dos 3 EARS → `commit` → `push`/`pull_request` (v0.2+, autonomia `controlled`) → `merge`.
`contain` roda o diff integral contra padrões de segredo **antes** de `scope_paths` (§3 C7).

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
| **Pesquisa** | **Time paralelo (2–4, famílias diferentes, somente-leitura, opt-in por config)**: stack e hospedagem, concorrentes e precificação, requisitos regulatórios do domínio, riscos de implementação. Empate vira pergunta. |
| **Skills** | Por fase: `market-research` e `deep-research` na fase 0; `api-design`, `backend-patterns`, `postgres-patterns`, `database-migrations` na fase 1; `frontend-design`, `design-system`, `accessibility` na fase 2; `e2e-testing`, `deployment-patterns` na fase 3. Sempre ≤3 por story. |
| **Papéis** | Intent Compiler `claude` forte; pesquisa `agy` → `claude` (v0.5, com canário de isolamento; digest #38); Maker `claude` Opus; Checker de rodada `codex`; Checker de portão `claude`; juiz `codex`. |

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

**Estrutura**: 4 fases, ~7 epics, ~30 stories. O plano inteiro é validado por ajv e aprovado numa
única aprovação; fases posteriores herdam a aprovação e o orçamento reservado pelo scheduler.

**DAG**: fase 0 (esquema de dados + contratos de API, 4 stories serial) → fase 1 (backend, 9 stories
com 2 frentes independentes) → fase 2 (UI, 11 stories, todas com `design_brief`, dependendo de s1 de
tokens) → fase 3 (e2e, deploy, observabilidade, 6 stories). N=1 na v1.

**Gates**: idênticos à J4 por story; `checker_gate` por epic; FQE completo em toda story da fase 2;
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
orçamento de parede (`max_wall_clock_seconds`, `max_parked_units`) sobre um **backlog já aprovado**,
que retoma sem nova entrevista e para em `awaiting_operator` ao esgotá-lo.

| Campo | Valor |
| :--- | :--- |
| **Interpretação** | Missão desatendida. Herda as classes das stories que já estão no plano aprovado — não reclassifica nada. |
| **Context discovery** | Só o delta: `git log` desde o último `complete`, stories `ready`/`parked`, orçamento restante, `capabilities.json` com `probe_ok` fresco. |
| **Perguntas** | **Nenhuma.** Se o backlog estiver vazio ou tiver story sem contrato aprovado, o comando falha na hora com a lista, em vez de abrir entrevista de madrugada. |
| **Pesquisa** | Só a já declarada nos contratos existentes; nenhuma pesquisa nova é iniciada sem operador. |
| **Skills** | Só as já aprovadas para o projeto. Skill nova = `awaiting_operator` (§7 Skill Fabric) — ver §10-3. |
| **Papéis** | Iguais aos das stories no plano. `no_checker_family_available` → `parked`, nunca aprovado sem revisão. |

**Comando e forma**: `ade run --plan .ade/missions/<id>/plan.json` com `autonomy: 'safe'` (ou
`controlled` se push/PR foram autorizados na aprovação única) e o par de orçamentos de parede.
`restricted` nunca roda desatendido (`ask_operator: ['*']`).

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

**Manhã**: `ade status` (uma tela), `ade report <missão>` derivado do journal — feito, mudado,
evidência, screenshots lado a lado das paradas visuais, decisões pendentes, custo com `cost_source`.
`ade journal --unit <story>` para o porquê. `ade decide <unit> --option retry|skip` resolve a fila.
`ade discard <missão>` descarta a noite inteira em um comando, com tudo preservado em
`refs/ade/discarded/`.

**Quando é ruim**: o caso que importa é "acordei e odiei tudo". A resposta é `ade discard` + o
`report.md` como resumo legível; nada é apagado e o `journal.jsonl` continua auditável.

---

## 8. Tabela comparativa

| | J1 botão | J2 página | J3 frontend | J4 Stripe | J5 SaaS | J6 noite |
| :--- | :-- | :-- | :-- | :-- | :-- | :-- |
| Classe | trivial | bounded | subsystem | feature | project | — (missão) |
| Perguntas | 0 | 2 | 3–4 | 2–3 | 5 | 0 |
| Pesquisa | não | não | 1 chamada | 1 chamada | time 2–4 | não |
| Plano | contrato mínimo | 2 stories | ~14 stories, 3 epics | 6 stories, 1 epic | ~30 stories, 4 fases | herdado |
| Skills/story | 0 | ≤3 | ≤3 | ≤3 | ≤3 | herdadas |
| Maker | Sonnet 5 | Sonnet 5 | Opus | Sonnet 5 | Opus | herdado |
| Checker rodada | condicional | Codex | Codex | Codex | Codex | herdado |
| Checker portão | não | não | por epic | 1 | por epic | obrigatório |
| FQE | detector | D1–D7 + juiz | completo, 14× | 1 story | 11 stories | herdado |
| Chamadas [hip.] | 1–2 | ~10 | ~63 | ~22 | ~116 | ~30/noite |
| Tokens in [hip.] | ~8k | ~225k | ~2,55M | ~655k | ~4,9M | ~1,1M |
| 1ª edição de fonte | ≤30 s | 2–4 min | 12–20 min | 6–10 min | 30–50 min | ~10 s |
| Aprovações humanas | 0 | 1 | 1 | 1 | 1 | 0 (a da missão) |
| Saída | commit local | commit + screenshots | PRs por epic | PR | PRs por fase | fila + `report.md` |

---

## 9. Os cinco "missing everywhere" do `judgment-J2-journeys.md` §5

| # | Buraco | Resposta nesta arquitetura |
| :-- | :--- | :--- |
| 1 | **Métricas de UX sem eval** | §1 define "tempo até a primeira edição de fonte" uma vez para as seis jornadas, e a J1 vira eval executável do slice 1 (`architecture.md` §5.4: ≤30 s, 0 perguntas, ≤2 chamadas). Perguntas e chamadas são contáveis no journal (`kind: 'decision'` e `effect_class: 'model_call'`), então as três métricas do `PROMPT.md` §7 são derivadas, não declaradas. Falta fixar N da faixa rápida (§10-1). |
| 2 | **"não sei"** | Resposta de primeira classe em todas as jornadas: grava o default recomendado, registra a incógnita no contrato, aparece no resumo de aprovação e no `report.md`. Em classe ≥ `feature` promove a incógnita a `research_refs` e o `checker_gate` verifica a decisão contra o achado. Em `project`, 2+ "não sei" nas perguntas estruturantes fazem nascer uma fase 0 de validação. |
| 3 | **Descarte do lote + resumo humano** | `ade discard <missão>` é um comando e move tudo para `refs/ade/discarded/` (nada é apagado). `ade report <missão>` é o resumo legível derivado do journal, com evidência e custo. As duas coisas existem na v1. |
| 4 | **Aprovação visual sem navegador** | O FQE captura 2 larguras × claro/escuro por rodada; a parada por nota <7,5 entrega os pares lado a lado dentro do `report.md`, e a escolha é `ade decide <unit> --option retry|skip`. O operador abre um markdown, não um navegador. Ressalva em §10-5. |
| 5 | **Mudar de ideia no meio** | Honestamente parcial na v1. Três saídas: (a) `ade takeover <story>` assume a sessão exata com o comando impresso e `ade release` devolve; (b) `ade decide <unit> --option skip` mata a story em curso no próximo ponto de checkpoint; (c) `ade discard`. Steering no meio do turno é o gatilho declarado para ACP (`architecture.md` §7), não v1. |

---

## 10. Divergências propostas

Objeções a `architecture.md`, com evidência. Nenhuma decisão foi alterada acima.

1. **`N` da faixa rápida não está definido.** §5 (tabela de classes) condiciona o Checker de rodada
   em `trivial` a "diff > N arquivos" sem fixar N. Sem valor, o critério de aceite "≤2 chamadas" do
   slice 1 não é falsificável e a J1 é indeterminada. Proposta: `N = 1` arquivo de fonte
   (excluindo arquivos de teste), publicado em `ade-config.schema.json` com default. Evidência:
   `judgment-J2-journeys.md` §5.1 (métricas de UX sem eval) e §3-A1 (a J1 declara 2 chamadas sem
   dizer quem escreve o eval — resolvido, mas o gatilho do Checker não).

2. **O classificador barato consome metade do orçamento de chamadas da J1.** §5.3 põe a chamada de
   classificação como caminho primário e a regra determinística como fallback. Na faixa rápida isso
   gasta 1 das 2 chamadas em metadados, e o digest #26 mediu `claude -p --model haiku` faturando
   como `claude-sonnet-5` (US$ 0,37 para ecoar 200 bytes): a chamada "barata" não é barata nem
   previsível. Proposta: inverter a ordem só em candidatos a `trivial` (heurística determinística
   primeiro — 1 arquivo tocado no discovery + verbo de correção; modelo só no empate), mantendo o
   caminho atual para `bounded`+. Evidência: digest #26; `architecture.md` §5.4.

3. **Skill nova mata a noite da J6.** §7 (Skill Fabric) exige aprovação na primeira aparição de uma
   skill no projeto e, em lote desatendido, `awaiting_operator`. §5.9 já lista "skills novas no
   projeto" no resumo da aprovação única, mas o texto não diz que essa aprovação **cobre o backlog
   inteiro**. Como está, uma story cujo seletor escolhe uma skill ainda não usada para a noite
   inteira às 00h20. Proposta: tornar explícito que a aprovação única congela o conjunto de skills
   elegíveis da missão (união das candidatas top-8 por story, não só as ≤3 finais) e que apenas
   skill **fora desse conjunto** parqueia. Evidência: `architecture.md` §5.9 vs §7;
   `judgment-J2-journeys.md` §4 ("skill nova de madrugada → awaiting_operator" como enxerto de A —
   correto como regra, insuficiente como projeto de jornada).

4. **Orçamento de parede não tem casa em nenhum dos 8 schemas.** §4 publica `plan` e `task-contract`;
   `budget` só existe no contrato (`max_model_calls`, `max_rework_rounds`, `max_usd`). §5 (final)
   define a J6 por `max_wall_clock_seconds` e `max_parked_units`, que são propriedades de **missão**.
   Sem campo no `plan.schema.json`, a J6 não é validável por ajv e o limite vira flag de CLI não
   auditável. Proposta: `plan.mission_budget: { max_wall_clock_seconds, max_parked_units, max_usd }`,
   gravado no `batch_open` do journal. Evidência: `architecture.md` §4 e §5 (parágrafo final).

5. **"Screenshots lado a lado no `report.md`" pressupõe um visualizador de markdown.** §5.12 promete
   "notas visuais lado a lado" e o buraco #4 do J2 pede aprovação sem abrir navegador. `report.md`
   com `![](artifacts/...png)` só é lado a lado em quem renderiza markdown; num terminal é uma lista
   de caminhos. Proposta: `ade show <ref> --open` abrindo o visualizador do SO para o par de
   imagens, e o `report.md` emitindo um par de caminhos absolutos por parada. Custo: ~10 linhas.
   Evidência: `judgment-J2-journeys.md` §5.4; `architecture.md` §5.12.

6. **A J3 não exercita a rotação de juiz que a v1 promete.** §7 (FQE) exige juiz "de família
   diferente do Maker". Com duas famílias e Maker sempre `claude`, o juiz é sempre `codex` — o que
   funciona (`-i, --image` existe, `capabilities-codex.md` §6), mas significa que 20 julgamentos
   visuais da J3 vêm do mesmo modelo, sem nenhuma medida de viés. Não é defeito de projeto; é um
   ponto cego que a telemetria da v1 não cobre. Proposta: registrar `judge_family` no `visual-eval`
   e tratar "juiz único" como hipótese explícita na tabela de §7 do `README.md` da pesquisa.
   Evidência: `judgment-J2-journeys.md` §3-A2 (a mesma contradição apontada na proposta A).
