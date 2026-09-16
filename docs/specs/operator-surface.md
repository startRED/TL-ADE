# Spec — Superfície do operador

Data: 2026-09-17. Escopo: tudo que o humano vê, digita e decide. Deriva de `architecture.md` §5 (fluxo),
§7 (autonomia), C20/C21 (painel e takeover) e dos ADRs 0013, 0015, 0012, 0022. Não repete a arquitetura:
descreve a forma concreta da CLI, do resumo de aprovação, da fila de escalação, do takeover, do relatório
e do painel.

Premissa de projeto: **o operador é preguiçoso por contrato**. Cada comando abaixo existe porque remove
uma decisão que o operador não deveria ter de tomar, ou porque é a única saída de emergência de um estado.
Comando que só imprime o que outro já imprime não entra. `judgment-J2-journeys.md` §5 lista cinco furos
que nenhuma proposta do painel resolvia (métrica de UX sem eval, "não sei", descarte do lote, aprovação
visual sem navegador, mudar de ideia no meio); §4–§11 deste documento são a resposta a cada um.

---

## 1. Convenções da CLI

| Aspecto | Regra |
| :--- | :--- |
| Parsing | `node:util parseArgs`, sem dependência (`architecture.md` §3, stack v1) |
| Saída padrão | texto para humano, largura 100 col, sem cor quando `!process.stdout.isTTY` ou `NO_COLOR` |
| Saída de máquina | `--json` em todo comando de leitura (`status`, `report`, `journal`, `show`, `doctor`, `catalog list/inspect`, `validate`); uma linha JSON, nunca prosa misturada |
| Fonte da verdade | todo comando de leitura é **projeção do journal**; nenhum mantém estado próprio |
| Repo | descoberto por `git rev-parse --show-toplevel`; `--repo <path>` sobrescreve |
| Missão | omitida = missão ativa do repo (`.ade/missions/*/status.json` com `state != done`); ambígua = exit 4 listando as candidatas |
| Interatividade | só `plan`/`run` na entrevista e `approve` pedem input; todo o resto é não interativo e roda em script |
| Windows | caminhos impressos com `\`; nenhuma saída depende de shell POSIX (ADR 0022) |

**Exit codes.** Cinco, herdados do runtime de referência — a tabela canônica é a do `master-spec` §4 (E47)
(mapa `{done:0, in_progress:0, stopped:2, blocked:3}` + `Refusal(code=4)`), reproduzida aqui com a reação
esperada. O 5 é fixo pelo porte (I04, `coordinator_conflict`). Não há códigos 1 e 6.

| Código | Significado | Reação esperada |
| ---: | :--- | :--- |
| 0 | ok / idle: o que foi pedido terminou verde, ou executa sem parada | seguir |
| 2 | stop / recusa: trabalho vermelho (eval, gate, contain, canário) com evidência gravada; cadeia de journal quebrada; entrada válida recusada por política | ler `ade report` / corrigir a condição |
| 3 | concluído com paradas: unidades em `awaiting_operator`/`parked`/`blocked` | `ade status` → `ade decide`/`takeover`/`discard` |
| 4 | entrada inválida: schema, campo desconhecido, plano que não valida, uso ambíguo | corrigir o comando ou o plano |
| 5 | conflito de lease (outro `ade` escrevendo neste repo) | esperar ou matar o dono |

Códigos 2 e 3 **não são erro de uso**: são estados legítimos do trabalho. `ade run` nunca devolve 0 com
uma story vermelha — isso é o equivalente CLI da regra "o relato do agente nunca conta" (`architecture.md`
§7, digest #37). O exit 3 vale quando há `awaiting_operator` com `batch_state: in_progress`
(`architecture.md` §11 E31) **só nos comandos que um watchdog consulta** (`ade run`, `ade status`); todo
comando de leitura (`report`, `journal`, `show`, `doctor`, `catalog list/inspect`) sai 0 nesse estado, como
já fixa a coluna de exits do `master-spec` §4 — relatório que "falha" toda manhã treina o operador a
ignorar exit code. Orçamento esgotado (`max_model_calls`, `max_usd`,
`max_wall_clock_seconds`) parqueia a unit, logo também sai 3, não tem código próprio.
`stale_workflow_version` sem `--accept-stale-version` é recusa (2), não código próprio (E7: só
`core_version` bloqueia).

**Forma canônica.** `ade run <pedido>` é a forma canônica (E31); a forma nua (`ade "<pedido>"`) só é
aceita quando o primeiro token não é um comando conhecido **e** o pedido tem espaço em branco — caso
contrário sai 4 com a sugestão do comando correto. `--help` curto separa a superfície operacional
(`run`, `report`, `decide`, `discard`) da avançada (o resto da tabela §2).

---

## 2. Comandos

A lista de flags de cada comando é publicada uma única vez na tabela de `2026-09-17-master-spec.md`
§4, que é a fonte do `--help`; esta seção descreve semântica, não inventa flag nova.

| Comando | Efeito | Exit típico |
| :--- | :--- | ---: |
| `ade run <pedido>` \| `--plan <arquivo>` | compila intenção (ou carrega plano), aprova, executa até acabar ou parar | 0/2/3/4/5 |
| `ade plan <pedido> [--from <missão>]` | compila intenção e grava `plan.json`; **não** executa | 0/2/4 |
| `ade approve <missão>` | aprova um plano já compilado | 0/2/4 |
| `ade validate <plan>` | valida um `plan.json` contra os schemas, sem tocar no repo | 0/4 |
| `ade status` | fila de escalação + estado de cada story | 0/3 |
| `ade report [missão]` | relatório da manhã | 0 |
| `ade journal [--unit <id>]` | eventos do journal, filtrados e legíveis | 0 |
| `ade decide <unit> --option retry\|skip\|discard\|pick\|accept_unproven --value <id>` | resolve um item da fila (E32; `accept_unproven` vem de E51) | 0/4/5 |
| `ade takeover <story>` | imprime o comando de retomada, grava `.cmd` e `.ps1`, e para o engine naquela story | 0/4 |
| `ade release <story>` | devolve a story ao engine | 0/2/4/5 |
| `ade discard <missão>` | descarta a missão inteira para `refs/ade/discarded/` | 0/4/5 |
| `ade show <ref> [--open]` | drill-down de um artifact do Firewall; `--open` usa o visualizador do SO | 0/4 |
| `ade steer <missão> "<nota>"` | enfileira intenção consumida no `prepare` da próxima story (não é steering intraturno) | 0/4 |
| `ade eval <story>` | roda os evals do contrato (dono: C9) sem Maker | 0/2/4 |
| `ade doctor` | sonda capacidades, ambiente e órfãos | 0/2 |
| `ade catalog sync\|list\|inspect` | catálogo de skills | 0/2/4 |
| *(v0.4b)* `ade serve`, `ade index --rebuild` | painel e reconstrução do índice | 0 |

### 2.1 `ade run`

```
ade run "corrija o botão de login que não envia o formulário"
ade run --plan .ade/missions/M07/plan.json
ade run --autonomy safe|controlled|restricted --max-usd 3 --unattended --yes
ade run --accept-stale-version
```

Sem `--plan`, roda `plan` + `approve` + execução no mesmo processo. A faixa rápida da classe `trivial`
**não depende de flag**: auto-aprovação é propriedade do par (`trivial`, `autonomy: safe`), gravada como
`decision{kind:'auto_approved', class:'trivial'}` (`architecture.md` §5.4; `intent-compiler.md` §3), logo
`ade run "<pedido>"` puro já não pergunta nada — a jornada 1 é dois comandos e nenhuma flag
(`vision.md` §5.6). `--yes` existe só para `--unattended` e `ade discard`, onde há confirmação a pular.
`--unattended` liga os orçamentos de parede de
`plan.mission_budget` (`max_wall_clock_seconds`, `max_parked_units`; defaults da jornada 6: 8 h e 3
[hipótese] — E3) e obriga `--yes`; `restricted` recusa `--unattended` com exit 2, nunca com aviso
(`dispatch: never`, `autonomy_requires_operator`, E5; `operations` §7) — recusa é 2 na tabela única de
exit codes, o 3 é reservado a "concluído com paradas" (E47). Não existem tetos de tokens em
`mission_budget` (E61): `--max-usd` + `prices.json` cobrem as famílias que reportam custo e nas demais o
teto é `max_model_calls`.

`--unattended` também recusa com exit 2 quando falta qualquer precondição dura da jornada 6 (A5):
(a) gates ativos, (b) baseline de eval verde, (c) caminho de rollback em `refs/ade/`, (d) isolamento por
worktree verificado pelo canário. `--accept-stale-version` aceita `runtime_stamp` divergente e grava a
aceitação como evento `decision` (E7: só `core_version` bloqueia).

Saída durante a execução: uma linha por transição de step, prefixada pelo id da story, sem spinner e sem
redesenho (o log precisa ser legível depois de `ade run > log.txt 2>&1`).

```
M07/S01  prepare      worktree .ade\wt\S01  skills: frontend-design, forms-a11y
M07/S01  eval:red     2 evals vermelhos contra tree_before  ok
M07/S01  implement    claude sonnet-5  38s  $0.11  3 arquivos
M07/S01  contain      ok
M07/S01  gates        typecheck ok  lint ok
M07/S01  eval:green   2/2 verdes
M07/S01  review       codex  changes_requested  1 high
M07/S01  rework 1/2   claude sonnet-5  22s  $0.07
M07/S01  review       codex  approved
M07/S01  commit       a1b9f2c  "fix(login): submit handler"
M07  concluída  1 story  $0.31  4m12s   ade report
```

### 2.2 `ade plan` / `ade approve` / `ade validate`

`ade plan <pedido>` faz discovery → classificação → (pesquisa) → entrevista → plano, grava
`.ade/missions/<id>/plan.json` e imprime o **resumo de aprovação** (§3). Termina em `awaiting_approval`.
`--non-interactive` recusa qualquer pergunta: se a entrevista seria necessária, sai 3 com a lista de
perguntas em JSON — é o modo usado pelo painel (v0.4) e por scripts.

`ade approve <missão>` congela o plano: grava `decision` no journal com o digest canônico (JCS) do
`plan.json`. Aprovar plano cujo digest mudou desde a impressão do resumo é recusa, exit 2. `--reject "<motivo>"`
devolve ao Intent Compiler.

`ade validate <plan>` é o único comando que roda fora de um repo com `.ade/`. Valida contra
`plan.schema.json`, `task-contract.schema.json` e `eval.schema.json` e aplica as recusas semânticas de
`architecture.md` §5.8 (story sem eval por cenário, sem `do_not_touch`, sem classe, UI sem `design_brief`,
`checker.model_id == maker.model_id` — e também `vendor` igual ao do Maker, E10 —, story acima do teto de
pack em bytes `limits.max_pack_bytes`). A regra Maker ≠ Checker por `model_id` e por `vendor` vale para
**todo** papel da chamada, incluindo o advisor registrado em `telemetry.models[]` (E66). O teto da seção
`contract` do pack é 32 000 bytes [hipótese], dentro de `limits.max_pack_bytes`; estouro é
`story_pack_overflow` e reabre a divisão da story (E50). O que **não** é validado aqui: `eval.cmd[0]`
contra os `scripts` do projeto — no plano valida-se só a forma, e a existência do runner é verificada no
`prepare` de cada story por re-discovery no worktree (E63), que é o que deixa uma missão multifase caber
numa única aprovação. Imprime uma linha por violação com JSON Pointer.

```
$ ade validate plan.json
/stories/2/evals            story sem eval; todo cenário precisa de ≥1 (architecture §5.8)
/stories/4/roles/checker_round  model_id igual ao do maker (Maker ≠ Checker)
2 violações   exit 4
```

### 2.3 `ade status`

Primeira tela da manhã e única visão do que está parado. Ordem: fila de escalação primeiro, estado
depois — o que exige ação vem antes do que informa.

```
$ ade status
missão M07  "billing com Stripe"  feature  8 stories  autonomy: controlled
  $4.18 de $8.00   2h03 de parede

AGUARDANDO VOCÊ (2)
  S04  budget_exhausted   14 chamadas de 12 autorizadas; 2 evals ainda vermelhos
       retry  skip  takeover  discard
  S06  visual_choice      juiz 7.1 (<7,5) em 2 rodadas; escolher rodada 1 ou 2
       ade show visual:M07/S06  →  ade decide M07/S06 --option ...

STORIES
  S01 done      S02 done      S03 done
  S04 parked    S05 blocked (depends_on S04)   S06 awaiting_operator
  S07 ready     S08 ready
```

`--json` devolve `{mission, budget, queue:[{unit, reason, options, evidence}], stories:[...]}`.
Exit 3 quando a fila não está vazia: um script de watchdog não precisa parsear nada.

### 2.4 `ade journal` e `ade show`

`ade journal [--unit <id>] [--kind ...] [--since ...] [--raw]` renderiza o JSONL em uma linha por evento
com `seq`, hora, kind, `effect_class` e o campo que importa para aquele kind. `--raw` imprime as linhas
originais (é a saída que se cola num bug report: preserva `prev`, logo preserva a cadeia). `--verify`
recomputa a cadeia de hash e sai 2 na primeira quebra, apontando o `seq`.

`ade show <ref>` é o drill-down do Tool Output Firewall (`architecture.md` §7): o extrato entregue ao
modelo carrega `{ref}`, e `ade show` imprime o bruto correspondente de `artifacts/`.

**Gramática de `<ref>`**, publicada aqui uma vez e única fonte para quem emite ponteiro:

| Forma | Exemplo | Emitido por |
| :--- | :--- | :--- |
| `art:<ref>` | `art:M07/S04/gates/typecheck` | Firewall, seções 5 e 7 do pack (`context-firewall-telemetry.md` §1.1) |
| `diff:<story>#<arquivo>` | `diff:S04#src/pay.ts` | corte de `review.max_diff_bytes` (E13) |
| `skill:<id>` | `skill:forms-a11y` | seção 4 do pack |
| `contract:<story>` | `contract:S04` | seção 6 do pack |
| `repo:invariants` | `repo:invariants` | seção 3 do pack |
| `visual:<story>` | `visual:M07/S06` | FQE, índice de imagens (§8) |
| *(legado)* caminho de `artifacts/` ou sha256 | `M07/S04/gates/typecheck`, `9e21c4…` | digitação humana |

O compilador de pack só emite refs desta gramática; o teste é
`every_pointer_emitted_resolves` — todo `{ref}` de uma saída truncada tem de resolver por `ade show`,
senão a truncagem com ponteiro é irreparável. `--out <arquivo>` escreve em vez de imprimir;
`--open` entrega o artifact ao visualizador do SO (E32); `ade show visual:M07/S06` abre o índice de
screenshots (§8). `ade show M07 --discarded` é a exceção de escopo de missão (§7), não um `<ref>`.

### 2.5 `ade eval`, `ade doctor`, `ade catalog`

`ade eval <story> [--phase red|green] [--id <eval>]` roda os evals do contrato contra a árvore atual, sem
Maker e sem consumir orçamento de modelo. É o comando que responde "isso ainda passa?" sem acordar o
engine, e o que se usa depois de um takeover antes de `ade release`. Exit 2 com qualquer eval vermelho.
A leitura do resultado exige reporter estruturado (`--reporter=json` no Vitest/Jest, equivalente por
runner) e `numTotalTests ≥ 1`: zero testes executados é `red_reason: 'missing_target'`, nunca verde (E58).

`ade doctor` sonda, não conserta (ADR 0017): resolve o `.exe` real atrás dos shims npm (digest #30), faz
**uma chamada real** por família com `--probe-real` (`probe_ok`/`probed_at`, nunca presença de binário
— digest #2/#3),
confere `core.longpaths`, mede o tamanho do pack p90 (em bytes, contra `limits.max_pack_bytes`), conta
worktrees, `conhost.exe` órfãos e o volume de `refs/ade/discarded/` (E36) e grava
`~/.ade/capabilities.json`. Cada família registra `probe_mode ∈ {real, help_only, fixture}` e
`bootstrap_cost_tokens`; `--offline` é o default em CI e grava `probe_ok: null`, que fora de CI **recusa
despacho** em vez de degradar (E10). O relatório segue as 7 categorias do `/harness-audit` (Tool Coverage,
Context Efficiency, Quality Gates, Memory Persistence, Eval Coverage, Security Guardrails, Cost
Efficiency) com `score`, `checks` com caminho e `top_actions`, pontuadas por telemetria, nunca por presença
de arquivo (A10). `--routing` imprime as sugestões de troca de default
(`landscape-routing-skills-terminal.md` §1.4); aplicá-las é decisão humana na v1. Exit 2 quando um papel
fica sem primário nem fallback e também quando o `ENGINE_VERSION` do Impeccable diverge do pin: é falha
do doctor, nunca aviso (E45) — o FQE entra em modo degradado e as stories com UI param em
`awaiting_operator{reason:'fqe_unavailable'}`, as sem UI seguem. `capabilities_digest` divergente **não**
bloqueia: tem dois leitores nomeados, o relatório do doctor e o evento `mission_summary` (E67, E68).
Contadores de cota por família ficam fora da v1 (E69).

```
$ ade doctor
claude  2.1.271  C:\Users\Erick\AppData\Roaming\npm\node_modules\...\cli.js   probe ok  1.9s  $0.004
codex   0.154.0  ...\codex.exe                                                probe ok  3.1s  tokens
agy     1.2.3    %LOCALAPPDATA%\agy\bin\agy.exe                               probe ok  2.4s  canário de isolamento: FALHOU
        └ escreveu em ~\.gemini\antigravity-cli\scratch\ fora do --add-dir → papel limitado a leitura
git 2.47.0  core.longpaths=true  node v24.16.0  worktrees: 1  conhost órfãos: 0
```

`ade catalog sync` faz fetch + checkout do commit pinado (nunca pull), sha256 por arquivo, sanitização
estática e quarentena; `list` filtra por domínio/linguagem/trust; `inspect <id>` mostra fonte, commit,
hash, licença, flags do SkillGuard e em que stories a skill já foi injetada e **citada** (`cited` da
telemetria), com o `sha256` do conteúdo injetado e a `source` (`catalog@<commit>` ou `local`) de cada
injeção — evidência de supply chain no próprio evento (E59). Mudança de hash de skill já aprovada no
projeto reabre a aprovação (C2 do SkillGuard).
`inspect` marca que scripts de skills de catálogo nunca ficam disponíveis ao agente na v1 — só o corpo do
`SKILL.md` e `references/*.md` como texto (E35). A v1 assume repositório do próprio operador: `catalog.sources`
é lido do `.ade/config.json` do repositório e skills em `<repo>/.claude/skills/` **não** entram no pack nem
são carregadas pela CLI despachada, que roda sob `--safe-mode` (E56, E15).

---

## 3. Resumo de aprovação

Único ponto de aprovação da missão (`architecture.md` §5.9). Formato fixo, sete blocos, nesta ordem; cabe
em uma tela de terminal para `bounded`, uma tela e meia para `feature`. Nada de tabela de stories completa:
o operador aprova **o contorno**, não o plano linha a linha.

```
M07  "adicione billing com Stripe"           classe: feature
─────────────────────────────────────────────────────────────────────────────
VOU FAZER            8 stories, 1 epic
  · checkout com Stripe Checkout (hosted), assinatura mensal única
  · webhook de eventos com verificação de assinatura e idempotência
  · página de billing no app com estados vazio/erro/carregando
NÃO VOU TOCAR        prisma/migrations/*, .env*, src/auth/**   (do_not_touch)
COMO PROVO           17 evals; 3 negativos (webhook sem assinatura é rejeitado)
                     FQE D1–D6 + juiz na story de UI (lint anti-slop é gate do C8)
CUSTO ESTIMADO       $6,40–$9,10  (estimated; Codex não reporta USD — digest #28)
                     teto autorizado: $8,00 e 96 chamadas
SKILLS NOVAS         improve-ui (ibelick/ui-skills@c5bcd86, MIT, sem flags)
                     skill-creator (anthropics/skills@34040c9, Apache-2.0 por skill,
                                    has_scripts → quarentena)
EFEITOS EXTERNOS     commit local, push, PR. Sem merge. Sem migration.
AUTONOMIA            controlled
DEFAULTS ASSUMIDOS   "não sei" em 2 perguntas:
                     · moeda = BRL   · trial = sem trial
                     (gravados em unknowns[] do contrato; mudar exige replanejar)
─────────────────────────────────────────────────────────────────────────────
[a]provar  [r]ecusar  [d]etalhar story  [e]ditar orçamento           M07  digest 4f1c…
```

Regras de conteúdo:

| Bloco | Regra dura |
| :--- | :--- |
| NÃO VOU TOCAR | vem de `guardrails.do_not_touch` literal; ausente = o plano não passou no `validate` |
| COMO PROVO | conta evals por tipo, nunca lista comandos; comando é detalhe de `ade show` |
| CUSTO | sempre com `cost_source`; `estimated` impresso, nunca escondido (digest #28). O teto de chamadas vem de `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` [hipótese]: `bounded` com UI = 8 chamadas/3 rework, sem UI 6/2, `feature` com UI = 12/3 (E65) |
| SKILLS NOVAS | só as que nunca apareceram neste projeto, com fonte, commit e flags do SkillGuard (C7). A fonte é sempre da allowlist de `catalog-sources.md` (registry aberto — `skills.sh`, ClawHub — é controle 1/S1, não chega aqui) e a licença é sempre declarada (ausente é falha dura no ingest, S3: não há skill sem licença para exibir); quarentena aqui só por `has_scripts` ou achado do SkillGuard. A aprovação **congela o conjunto elegível da missão** (união do top-8 por story); só skill fora desse conjunto parqueia em lote desatendido (E33) |
| EFEITOS EXTERNOS | lista fechada e positiva: o que **não** está aqui não é autorizado. O `local_merge` fast-forward da branch da story na base, quando a base não mudou desde o `prepare`, é efeito local e entra em `safe` (E64): não aparece nesta lista e não pede autorização |
| DEFAULTS | todo "não sei" da entrevista vira linha aqui e uma entrada em `TaskContract.unknowns[]`, com `kind ∈ {product_choice, external_fact, repo_fact}` (E48); o furo J2 §5.2 é fechado nesta linha |

`--json` no lugar do prompt devolve o mesmo conteúdo estruturado, para o painel renderizar sem
reimplementar a lógica.

---

## 4. Fila de escalação

Destino único de toda parada (`architecture.md` §5.11). Um item = uma unit em `awaiting_operator` com
`reason` de um conjunto fechado. Gatilhos determinísticos são a maioria; `target_role: 'human'` do
`review-result` é o único semântico.

| `reason` | Origem | Opções oferecidas |
| :--- | :--- | :--- |
| `budget_exhausted` | Scheduler | retry (com novo teto) · skip · discard |
| `loop_detected` | detector de loop (normalização literal, I41) | retry · skip · takeover |
| `stagnation` | 2 rodadas sem mudar `tree_after`, `findings_digest` idêntico (E22) ou assinatura de falha idêntica — hash de stderr/stack normalizado — em 2 tentativas (A6) | takeover · skip |
| `human_action_item` | `review-result.action_items[].target_role = 'human'` | takeover · retry · skip |
| `research_tie` | empate no time de pesquisa | *(pergunta de múltipla escolha)* |
| `visual_choice` | FQE 2 rodadas abaixo de 7,5 | *(escolha entre rodada 1 e rodada 2, §8)* |
| `fqe_unavailable` | `ENGINE_VERSION` do Impeccable divergente do pin: falha do doctor, FQE degradado; só stories com UI param (E45) | takeover · skip |
| `red_unproven` | `trivial` cujo vermelho não foi por `assertion`: o rebaixamento para `additive` de E12 não se aplica à classe (E51) | accept_unproven · retry · takeover |
| `takeover_open` | `prepare` recusa worktree com `takeover.json` presente; `--option retry` devolve a mesma parada (E42) | release · discard |
| `environment` | `prepare` de story `trivial` com hash de lockfile divergente do checkout base, onde não cabe rodar o instalador (E49) | retry · takeover · skip |
| `skill_first_use` | SkillGuard C7 em lote desatendido, só para skill fora do conjunto congelado na aprovação (E33); mesmo valor do enum fechado de `ask_operator` (E5, master-spec §4) | aprovar · negar |
| `worker_heartbeat_lost` | dead-man switch do worker: sem heartbeat por N s o engine mata o grupo de processos e põe o log em quarentena (A3) | retry · takeover · discard |
| `network_unavailable` | push/PR na retomada (nunca retry automático) | retry · skip |
| `no_checker_family_available` | Capability Registry | retry · takeover |
| `isolation_canary_failed` | canário de contenção da família | takeover · discard |
| `stale_branch` / `unexpected_tree_state` | GitPort | takeover · discard |

`ade decide <unit> --option retry|skip|discard|pick|accept_unproven --value <id>` grava um evento `decision` (com
`source: operator`, E11) e devolve a unit ao scheduler (`retry`), a marca `failed` — `skipped` não existe em
`UNIT_STATES` (master-spec §6), então as stories que dependem dela caem em `blocked` por dependência em
estado terminal não-`completed` e só as **independentes** seguem, com `continue_independent_after_block` —, joga a story fora para `refs/ade/discarded/<missão>/<n>`
(`discard`, escopo de uma unit — §13 D1), registra a direção visual escolhida (`pick`, §8) ou fecha uma
story `trivial` como `complete` com o vermelho não provado assumido por escrito (`accept_unproven`, só em
`red_unproven`, E51). `--note "<motivo>"` é opcional e vai para o relatório. `takeover` continua sendo comando próprio porque muda o
dono da árvore; `ade discard <missão>` continua operando no lote inteiro (§7). Decidir unit que não está na fila é exit 4; decidir em
lote (`--all --option skip`) é permitido e registrado item a item.

---

## 5. `ade takeover <story>`

v1 é **uma linha de comando impressa**, não um PTY (ADR 0013; `proposal-A-minimal.md` §5; digest #29). O
comando faz quatro coisas, nesta ordem: para o engine naquela story, grava checkpoint da árvore em
`refs/ade/checkpoints/<missão>/<story>/<n>` (namespace do `GitPort`, `engine-durability.md` §7 I18 — é
essa ref que `human_release` reconcilia), grava `human_takeover` no journal (com `session_ref` e `worktree`) e imprime
o comando de retomada da família que rodou por último naquela story. Enquanto o takeover está aberto, o
`prepare` recusa aquele worktree: a story para em `awaiting_operator{reason:'takeover_open'}` e
`ade decide --option retry` devolve a mesma parada, sem exit code novo (exit 3) — a saída é `ade release`
ou `ade decide --option discard` (E42).

```
$ ade takeover S04
S04 entregue a você.   checkpoint refs/ade/checkpoints/M07/S04/1 (tree 9e21c4)
worktree:  E:\proj\.ade\wt\S04        branch: ade/S04

Cole no seu terminal (ou rode o .cmd / .ps1 gerado):

  claude --resume 0c7b1d3e-5f92-4a11-9a77-2c5e8f014b6d ^
         --add-dir E:\proj\.ade\missions\M07\packs ^
         --settings E:\proj\.ade\missions\M07\settings.json ^
         --permission-mode default

  arquivos: E:\proj\.ade\missions\M07\takeover-S04.cmd
            E:\proj\.ade\missions\M07\takeover-S04.ps1

Quando terminar:  ade release S04      (ou ade decide M07/S04 --option skip)
```

Comando por família:

| Família | Comando impresso | Observação |
| :--- | :--- | :--- |
| claude | `claude --resume <uuid> --add-dir … --settings … --permission-mode default` | headless→interativo funciona **só pelo id**; sessão `-p` fica fora do picker e de `--continue` (`capabilities-claude-code.md` §2) |
| codex | `codex resume <session_id> --include-non-interactive` | `--include-non-interactive` é o que traz a sessão `exec` para o picker (`capabilities-codex.md` §2) |
| agy | `agy --resume <uuid>` no mesmo cwd | `--resume` aceita `latest`, índice ou UUID (`capabilities-gemini-antigravity.md` §2.3); papel de pesquisa, takeover é raro |

Na prática a v1 quase sempre imprime a linha do `claude`: o Maker é Claude por default e o Checker Codex
roda `--sandbox read-only`, logo não há árvore dele para assumir.

**O que o operador pode e não pode fazer**

| Pode | Não pode |
| :--- | :--- |
| editar qualquer arquivo dentro do worktree | commitar (`git commit` na worktree = `unexpected_tree_state` no `release`) |
| rodar `ade eval S04` quantas vezes quiser | mudar de branch ou criar branch |
| conversar com a CLI retomada à vontade | esperar que o que digitou vire contexto do engine |
| abandonar sem fazer nada (`ade release` volta ao checkpoint) | tocar em `.ade/` à mão |

A invariante é uma só: **só a árvore conta**. O que o operador digitou não é interpretado, não é lido, não
entra no pack e não vira instrução — exatamente a mesma regra que trata saída de ferramenta como dado
(`architecture.md` §7, Firewall). É o que torna o takeover robusto apesar de o resume não ser verificável:
nenhuma CLI expõe hash do histórico restaurado (`landscape-routing-skills-terminal.md` §4.3).

**Limites conhecidos do `--resume`** (`capabilities-claude-code.md` §2, digest #25):

| Restaurado | Não restaurado |
| :--- | :--- |
| histórico completo (tool_use/tool_result), modelo, agente, goal, worktree da sessão | `--add-dir`, `--settings`, `--mcp-config`, `--plugin-dir`, `--fallback-model` — por isso são reimpressos |
| — | modo de permissão: `bypassPermissions` e `plan` **nunca** voltam no terminal; por isso `--permission-mode` explícito |
| — | ferramenta que estava rodando quando o processo morreu: não termina nem re-executa |
| — | tarefas Bash/monitor de fundo |

Transcrições em `~/.claude/projects/<project>/<session-id>.jsonl` **não são lidas pela ADE**: o formato é
interno e a própria doc desaconselha parsear. O engine usa `--output-format json`/`stream-json` e o
`transcript_path` dos hooks.

**`ade release <story>`** relê a árvore, calcula `tree_after`, grava `human_release` com o diff contra o
checkpoint, roda `contain` (o operador também é contido: escrita fora de `scope_paths` restaura) e devolve
a story ao ciclo no ponto seguinte — `gates` se a árvore mudou, `review` se o eval verde já estava gravado.
`--discard` volta ao checkpoint e ignora o que foi feito. Exit 2 quando `contain` reprova a árvore humana.

---

## 6. Relatório da manhã — `ade report`

Markdown em `.ade/missions/<id>/report.md`, também impresso. Derivado do journal, reconstruível a
qualquer momento (`--rebuild` reescreve do zero). Sete seções fixas, sempre nesta ordem.

| Seção | Conteúdo |
| :--- | :--- |
| **Feito** | stories concluídas, uma linha cada: título, sha do commit, evals verdes, nota visual quando houve. O fast-forward da branch da story na base é `local_merge` de `safe` quando a base não mudou desde o `prepare`; se mudou, o commit fica na branch da story e esta seção imprime o comando de merge a rodar (E64) |
| **Mudado** | arquivos por story com `+/−`, agrupados por diretório; `dirty_paths -z` com os dois lados de rename |
| **Evidência** | por story: evals (cmd, exit, duração), gates, veredito do Checker com `action_items` críticos, refs para `ade show` |
| **Notas visuais** | por story de UI: screenshots lado a lado (antes \| depois, 2 larguras × claro/escuro), nota do juiz por critério, achados do `impeccable detect`, link `file:///…/artifacts/visual/S06/` |
| **Decisões pendentes** | a fila de escalação do `ade status`, com o comando exato para cada opção |
| **Custo real vs estimado** | por story e total: estimado na aprovação, real, `cost_source`; tokens e cache; destaque quando real > 1,5× estimado |
| **Recovery events** | toda `recovery` do journal: crash do engine, worker `ambiguous`, lease adotado, `stale_workflow_version`, rede indisponível — com o que foi feito automaticamente |
| **O que acontece a seguir** | stories `ready`, orçamento restante, e se a missão retoma sozinha ou espera |

```markdown
## Notas visuais

### S06 — página de billing
| antes | depois |
| :--- | :--- |
| ![](artifacts/visual/S06/r0-1280-light.png) | ![](artifacts/visual/S06/r2-1280-light.png) |
| ![](artifacts/visual/S06/r0-390-dark.png)  | ![](artifacts/visual/S06/r2-390-dark.png)  |

juiz codex-gpt-5.6 · 7,1/10 (corte 7,5) — especificidade 6,5 · hierarquia 8,0 · tipografia 7,0 ·
cor 7,5 · estados 8,0 · movimento 6,0
impeccable: 2 achados (generic-font-stack, flat-elevation)
→ decisão pendente: escolher direção  ·  file:///E:/proj/.ade/missions/M07/artifacts/visual/S06/
```

Os PNGs são referenciados por caminho relativo: o `report.md` aberto em qualquer visualizador de Markdown
mostra as imagens sem servidor. É a forma preguiçosa de "ver o que a noite fez" sem subir o painel.

`--since <missão|data>` cobre várias missões; `--json` devolve a mesma estrutura para o painel.

---

## 7. `ade discard <missão>`

Descarte do **lote inteiro** em um comando — o furo J2 §5.3. Nada é apagado.

```
$ ade discard M07
M07  "billing com Stripe"  8 stories (3 done, 1 parked, 4 ready)
  6 commits locais, 2 branches, 1 PR aberto (#41)

Vai acontecer:
  · 6 commits  →  refs/ade/discarded/M07/<n>   (um <n> por item descartado)
  · árvores sujas de S04, S06  →  refs/ade/discarded/M07/<n>
  · 2 worktrees removidos; branches ade/S0x mantidos sob refs/ade/discarded/
  · PR #41 NÃO é fechado (efeito externo; feche você ou use --close-pr)
  · journal, artifacts e report permanecem em .ade/missions/M07/

Nada é apagado. Recuperar: ade show M07 --discarded
Confirmar [s/N]:
```

`--yes` pula a confirmação; `--close-pr` adiciona o fechamento como step com `effect_class:
pull_request` (é efeito externo, logo passa pelo journal e pela autonomia). O evento `batch_state:
discarded` fecha a missão; retomar uma missão descartada é recusa, exit 2 — o caminho é `ade plan` de novo.

---

## 8. Aprovação visual sem abrir navegador

Furo J2 §5.4. Quando o FQE esgota as 2 rodadas sem atingir 7,5, o engine grava `visual_choice` na fila e
produz um índice de imagens em `artifacts/visual/<story>/`.

**Não são duas direções.** O `DesignBrief` tem uma `direction` só (`architecture.md` §4) e a rodada 2 é
rework da rodada 1 guiado pelos defeitos do juiz e pelas falhas de D1–D6
(`frontend-quality-engine.md` §6) — o que o operador compara é **rodada 1 × rodada 2 da mesma direção**,
que é exatamente o par lado a lado que o FQE já grava. Escolher `r1` significa "a rodada 2 piorou";
gerar duas direções concorrentes seria uma chamada extra de Maker paga no orçamento da classe, e não é v1.

```
$ ade show visual:M07/S06
S06  2 rodadas da mesma direção, corte 7,5

  r1  7,1   artifacts\visual\S06\r1-1280-light.png   r1-390-dark.png
       especificidade 6,5 · hierarquia 8,0 · movimento 6,0
  r2  7,4   artifacts\visual\S06\r2-1280-light.png   r2-390-dark.png
       especificidade 7,5 · hierarquia 7,0 · movimento 7,0

  ade decide M07/S06 --option pick --value r1|r2   escolher e seguir
  ade decide M07/S06 --option retry --note "..."   mais uma rodada com direção sua
  ade decide M07/S06 --option skip                 entregar como está, nota registrada
```

O operador abre dois PNGs no visualizador do Windows (ou lê o `report.md`) e digita uma letra. Nenhum
navegador, nenhum servidor, nenhum julgamento estético pedido por escrito. `--option pick` exige
`--value` e é verbo canônico da CLI desde `architecture.md` §11 E32 (§13, D2 aceita). O `visual_score` do
juiz só é comparável dentro do mesmo `judge` pinado por `model_id` (E9).

`pick --value r1` restaura a árvore da rodada 1, que o rework sobrescreveu: exige **checkpoint por rodada
do FQE** em `refs/ade/checkpoint/<story>/fqe-r<N>`, gravado antes de cada `rework` visual pelo mesmo código
de checkpoint do takeover (§5). [hipótese] custo desprezível (um `git commit-tree` por rodada, ≤2 por
story de UI); sem ele, `pick` só pode oferecer a última rodada e a escolha vira `skip`.

---

## 9. Mudar de ideia no meio

Furo J2 §5.5. Steering no meio do turno depende de `session/inject` estável no ACP (`architecture.md` §7,
ADR 0004): não existe na v1. O que existe é **cancelar no checkpoint e replanejar**, que cobre o caso real
("na verdade, faz diferente") ao custo de esperar o turno corrente fechar — tipicamente 30–120 s.

| Momento | Comando | O que acontece |
| :--- | :--- | :--- |
| durante um turno do Maker | `Ctrl+C` no `ade run` | engine mata a árvore de processos (`taskkill /T /F /PID`), a chamada vira `ambiguous`, a árvore suja vira checkpoint; o próximo `ade run` reconcilia |
| entre stories | `ade decide <unit> --option skip` | pula a story, libera as independentes |
| quero ajustar o rumo sem replanejar | `ade steer M07 "<nota>"` | enfileira a nota; o `prepare` da próxima story a consome. Não é steering intraturno (E32) |

`ade steer` é verbo obrigatório por `architecture.md` §11 E32, mas hoje **não tem consumidor declarado**:
o Context Pack tem 8 seções fixas (`context-firewall-telemetry.md` §1.1) e nenhuma admite intenção do
operador, e o contrato é imutável por `immutable_digest`. Para ser verificável, a nota entra como bloco
`operator_steer` **dentro da seção 7 (`round`)**, sob o teto de 24 000 bytes dela, com a mesma cerca de
dado não confiável de achado de pesquisa e citação obrigatória em `sources[]` do `unit-result` (E8) —
sem isso não é medível se foi lida, e o verbo vira decoração. [hipótese] até a seção existir na spec do
pack: a alternativa honesta já disponível é `ade plan --from` + `takeover`.
| quero outro plano | `ade plan "<novo pedido>" --from M07` | novo plano herdando discovery, respostas da entrevista e stories já `done` de M07; M07 fica `superseded` |
| quero nada disso | `ade discard M07` | §7 |

`--from` é o que evita reentrevistar o operador, que é a regra "não reinicie a entrevista" do PROMPT §1
levada à CLI. `[hipótese]` o custo de replanejar é dominado pelo discovery, que é determinístico e
cacheado por árvore; a medição entra no harness doctor.

---

## 10. Painel v0.4b

Três áreas — **Chat · Missão · Log** — servidas por `ade serve` em `127.0.0.1` (porta em
`.ade/config.json`, sem bind externo; ADR 0013). A autenticação é mínima e obrigatória: **token aleatório
por sessão do `ade serve`, impresso no terminal**, mais checagem de `Origin` (E34) — localhost não é
fronteira de confiança. O painel, o índice SQLite e os npm workspaces entram juntos na v0.4b (E29, E37).

| Área | O que mostra | De onde vem |
| :--- | :--- | :--- |
| Chat | pedido, entrevista, resumo de aprovação, fila de escalação | `plan.json` + eventos `decision`/`note` |
| Missão | stories, estado, diff, evidência, screenshots lado a lado, custo | projeção do journal + `artifacts/` |
| Log | stream de eventos com filtro por unit/kind, drill-down = `ade show` | `journal.jsonl` via tail |

Invariantes do painel:

1. **Sem estado próprio.** Tudo é projeção. O índice é `better-sqlite3` reconstruível por
   `ade index --rebuild` a partir do journal; perder o `.sqlite` não perde nada.
2. **Toda ação vira step.** Aprovar, decidir, assumir, descartar no painel executa o mesmo caminho da CLI
   e grava os mesmos eventos. O painel não tem verbo que a CLI não tenha — é a condição para o painel
   nunca virar a fonte da verdade.
3. **WebSocket só como push do tail.** Reconexão relê do último `seq` conhecido; o cliente não guarda nada
   que não esteja no journal.
4. **Somente-leitura sobre a árvore.** O painel nunca escreve arquivo do repositório; `takeover` no painel
   imprime o mesmo comando da §5 até o PTY chegar.

`ade serve` sai 5 se outro `serve` já tem o lease de leitura do índice, e sai 1 se a porta está ocupada —
nunca escolhe outra porta sozinha.

---

## 11. PTY embutido — v0.5

`node-pty` + `@xterm/xterm` na área Missão, substituindo o comando impresso. Entra com as mitigações
medidas (`landscape-routing-skills-terminal.md` §4.2, digest #29), todas obrigatórias:

| # | Mitigação | Bug coberto |
| :-- | :--- | :--- |
| 1 | pinar `1.2.0-beta.14` (nunca beta.15) | #955 (sai antes do primeiro write) |
| 2 | **nunca** `pty.kill()`; encerrar por `taskkill /T /F /PID` do PID que o engine criou | #967 (mata PID alheio até 5 s depois) |
| 3 | handler de `error` em `conin`/`conout` com try/catch | #960 (derruba o processo hospedeiro) |
| 4 | `useConptyDll` desligado por padrão | #894 (3,5 s de atraso com PowerShell 7) |
| 5 | contagem de `conhost.exe` órfãos no `ade doctor` e no shutdown (reportar, não corrigir) | #965 (vaza um conhost por PTY) |
| 6 | teto de PTYs simultâneos = concorrência | #952/#947 |
| 7 | smoke test por release: abrir, escrever, ler, encerrar, verificar que nenhum PID alheio morreu | regressão de qualquer um acima |
| 8 | nunca `--raw-output`: ANSI de modelo não confiável é vetor de ataque | `landscape-routing…` §4.3 |

Sem a suíte 1–8 verde, o PTY não entra: a alternativa (comando impresso) já funciona e custa zero.

---

## 12. Notificação de sistema

Opcional, desligada por padrão. `.ade/config.json`: `notify: {on: ['awaiting_operator','mission_done','budget_exhausted'], command: [...]}`.
O engine roda o `command` do operador com o evento em JSON no stdin — sem dependência de toast do Windows,
sem serviço, sem rede. Falha de notificação é `note` no journal e nunca falha a missão. Quem não configura
nada descobre o estado por `ade status` de manhã, que é o caso de uso projetado.

---

## 13. Divergências resolvidas

Arbitragem em `architecture.md` §11 (2026-09-17). As quatro propostas foram aceitas e absorvidas no verbo
novo de CLI E32; o texto acima já reflete a decisão.

| # | Decisão |
| :-- | :--- |
| D1 | aceita — `architecture.md` §11 E32: `ade decide <unit> --option retry\|skip\|discard\|pick` |
| D2 | aceita — §11 E32: `--option pick --value <id>` (§8) |
| D3 | aceita — §11 E32: `takeover` grava `.ade/missions/<id>/takeover-<story>.cmd` **e** `.ps1` |
| D4 | aceita — §11 E32: `ade plan <pedido> --from <missão>`; a anterior fica `superseded` |

**D1 — `discard` é opção da fila de escalação mas não tem verbo por unit.** `architecture.md` §5.11 lista
as opções `retry`/`skip`/`takeover`/`discard`, mas a CLI fixada tem `ade decide --option retry|skip` e um
`ade discard <missão>` que opera no lote inteiro. Um operador que quer jogar fora **uma** story parada não
tem comando: `skip` a marca pulada mantendo a árvore e os commits parciais, o que não é o mesmo. Proposta:
`ade decide <unit> --option discard` grava os commits e a árvore daquela story em
`refs/ade/discarded/<missão>/<n>` e libera as dependentes como `skip`. Custo: reuso do mesmo código de
`ade discard`, escopo de uma unit.

**D2 — a escolha visual não é expressável com `retry|skip`.** `architecture.md` §7 (FQE) termina em
`awaiting_operator` "com screenshots lado a lado para escolha preguiçosa", e J2 §5.4 registra que nenhuma
proposta entregou isso. Com o conjunto fechado `retry|skip`, o operador não consegue dizer *qual* direção
escolheu: `retry` significa "de novo", `skip` significa "tanto faz". (Leia-se "direção" como **rodada**:
§8 fixa que o par é r1 × r2 da mesma `direction`.) Proposta: `--option pick --value <id>`
(§8), o único verbo que fecha o furo. Sem ele, o FQE produz duas imagens e descarta a preferência humana —
o gasto de duas rodadas do juiz não vira decisão.

**D3 — o comando de takeover deve ser gerado como arquivo, não só impresso.** A arquitetura diz "imprime o
comando exato". Em Windows o comando carrega dois caminhos absolutos longos (`--add-dir`, `--settings`) e
um UUID; copiar do terminal para o PowerShell quebra em aspas e em continuação de linha (`^` vs `` ` ``),
e é exatamente a queixa de J2 §1 contra a proposta A ("o operador precisa lembrar de `--add-dir`/`--settings`
— é o oposto de preguiçoso"). Proposta: `ade takeover` continua imprimindo, **e** grava
`.ade/missions/<id>/takeover-<story>.cmd` e `.ps1` com o mesmo conteúdo, para o operador executar por caminho em vez
de colar. Custo: uma escrita de arquivo. Risco: nenhum — o `.cmd` vive em `.ade/`, que nunca entra em commit.

**D4 — "mudar de ideia" precisa de `ade plan --from <missão>` para não reentrevistar.** A arquitetura trata
steering como item pós-v1 (ACP) e a v1 fica com "cancelar no checkpoint + replanejar", mas replanejar sem
herdar discovery e respostas da entrevista devolve o operador ao começo — o custo é de atenção humana, que é
a métrica que o PROMPT §7 declara otimizar. Proposta: `--from` como flag de `ade plan` (§9), reusando o
discovery cacheado e as respostas gravadas, com a missão anterior marcada `superseded` em vez de
`discarded`. Custo: um campo no `plan.json` e uma cópia das respostas.

---

## 14. Perguntas em aberto

1. **Retenção de `refs/ade/discarded/`.** Decidido em `architecture.md` §11 E36: os refs acumulam, o
   `ade doctor` reporta o volume e a purga é comando manual pós-v1. Continua na lista de pendências de
   Erick só quanto à política de retenção em si (§11, pendências finais).
2. **`ade report` em HTML.** O Markdown com PNGs relativos cobre a leitura; um `--html` de arquivo único
   (imagens em data: URI) seria mais fácil de mandar para outra pessoa. [hipótese] de valor baixo antes do
   painel; deixado fora até alguém pedir.
3. **Idioma da saída.** Resolvido em `architecture.md` §11 E31: estados, `reason` e `effect_class` em
   inglês (journal e schemas), mensagens humanas em português. A mistura é a decisão, não uma pendência.
4. **Eval da métrica "conhecimento exigido do operador"** (J2 §5.1): a faixa rápida já tem eval de slice
   (≤30 s, 0 perguntas, ≤2 chamadas), mas "conhecimento exigido" continua sem medida. Sugestão barata:
   contar os verbos distintos da CLI que a jornada 1 exige ponta a ponta (alvo: 1) e a jornada 6 (alvo: ≤4)
   como critério de aceite das v0.3/v0.5, mais a asserção de que o `argv` da jornada 1 **não contém flag
   alguma** (§2.1: auto-aprovação é do par `trivial`+`safe`, nunca de `--yes`). Não implementado neste
   documento.
5. **Porta padrão do `ade serve`** e comportamento quando `127.0.0.1` está bloqueado por política
   corporativa. Sem decisão; irrelevante antes da v0.4b.
