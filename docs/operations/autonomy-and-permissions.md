# Operações — autonomia e permissões

Rodada de rearquitetação, 2026-09-17. Documento operacional: o que cada nível de autonomia permite,
como a política vive em `.ade/config.json`, quais flags de modo desatendido cada família recebe por
papel, o que acontece quando uma ação exigiria aprovação, como a escalação funciona e como o operador
sai de cada estado ruim. Não repete a arquitetura: ver `architecture.md` §7 (Autonomia, Checker,
Contexto/Firewall), §5 (fluxo, passos 9–12), §6 (durabilidade) e `docs/adr/0015-autonomia-niveis-flags-desatendidas.md`.

Máquina alvo: Windows 11 Pro 10.0.26200; CI em Linux. Versões medidas: `claude` 2.1.271, `codex` 0.154.0,
`agy` 1.2.x.

---

## 1. Princípio e precedência

Nenhum mecanismo nativo de permissão é o `contain`. Os cinco mecanismos medidos (permission-mode do
Claude, sandbox do Claude, `auto-mode`, sandbox/execpolicy do Codex, approval-mode do `agy`) são
filtros baratos que o **worker** enxerga; o `contain` é a única camada que o **engine** enxerga, depois
do fato, sobre a árvore git — e a única que sobrevive ao `ade takeover`
(`addendum-autonomia-permissoes-por-repositorio.md` §1, §6.5).

Ordem de precedência, igual nos três níveis (porte de I22–I26; `addendum-autonomia...` §5.1):

1. **Segurança** — segredo no diff integral (`maxBuffer` explícito; o default de 1 MiB do `execFile`
   trunca a varredura em silêncio) → `stop_batch`, antes de qualquer commit.
2. **`sensitive_paths`** → `stop_batch`.
3. **`scope_paths` / `do_not_touch`** → `restore_and_park` (árvore restaurada para `refs/ade/discarded/`).

`safe` não é "menos seguro": é "menos aprovação exigida para efeito permitido". Um segredo no diff para
o lote em `safe` exatamente como pararia em `restricted`.

Duas invariantes fixas em todos os níveis:

- **Efeito externo é sempre do engine.** `push`, `pull_request`, `pull_request_merge`, `deploy` nunca
  aparecem como ferramenta disponível ao worker em nível nenhum. O nível não decide se o worker pode:
  decide se o **engine**, depois de `gates` e `review`, está autorizado (`permitted_effects`, porte de I55).
- **Ambiente do worker é filtrado** (I49). PAT de push, `GH_TOKEN`, chave de produção nunca entram no
  `env` do worker em nível nenhum — só o processo do engine que executa `git push`/`gh` as tem.
  `--disallowedTools` é glob de string best-effort, em **um** argumento com regras separadas por vírgula
  (`"Bash(git push*),Bash(gh pr*)"`, forma medida; `architecture.md` §11 E24; string normativa única em
  `specs/adapters-capability-registry.md` §2) — `git -C <dir> push`, um
  alias, um script de repo passam (judgment-J3 §5): a cerca real é o `env` filtrado mais o engine ser o
  único a rodar git/gh.

---

## 2. Níveis

| Ação / efeito | `safe` | `controlled` | `restricted` |
| :--- | :-: | :-: | :-: |
| ler repo, rodar `rg`/manifests | sim | sim | sim |
| editar dentro de `scope_paths` | sim | sim | sim |
| rodar testes, lint, typecheck, build (gates) | sim | sim | sim |
| criar branch `ade/<missão>/<story>` | sim | sim | sim |
| `local_commit` | sim | sim | sim |
| `local_merge` (integração de dependência) | sim | sim | sim |
| `push` | não | **engine** | não |
| `pull_request` (create) | não | **engine** | não |
| `pull_request_merge` | não | `ask_operator` | não |
| instalar dependência no worktree | não | sim | não |
| rodar migration | não | sim (DDL destrutivo → `ask_operator`) | não |
| deploy, publish, release | não | não | `ask_operator` |
| ler segredo / `.env` / credential store | não | não | `ask_operator` |
| destrutivo local fora de `refs/ade/` | não | não | `ask_operator` |
| skill nova no projeto (1ª aparição) | `ask_operator` | `ask_operator` | `ask_operator` |
| roda desatendido | sim | sim | **nunca** |

`restricted` não é "mais permissivo para coisas perigosas com aprovação": é o nível em que **tudo o que
sai do worktree vira pergunta**. `ask_operator: ['*']` é obrigatório no contrato, o nível herda os
`scope_paths` da story (como os demais) e não tem bloco de famílias: `dispatch: never` — o engine recusa
despachar um worker desatendido numa story `restricted` (`autonomy_requires_operator`, exit 3). Uma
missão com qualquer story `restricted` não é elegível ao modo noturno (§6).

### `ask_operator`

Campo do `TaskContract` (`architecture.md` §4). Vocabulário **fechado** — o engine precisa avaliá-lo
sem modelo. Valores: `push`, `pull_request`, `pull_request_merge`, `dependency_add`,
`dependency_major_bump`, `migration_destructive`, `deploy`, `secrets_read`, `destructive_local`,
`skill_first_use`, `*`. O resumo de aprovação (`architecture.md` §5.9) mostra o nível e a lista
resultante por story: o operador aprova o **nível**, não uma lista de comandos.

---

## 3. Política por repositório — `<repo>/.ade/config.json`

Bloco `autonomy` validado por `ade-config.schema.json`. Forma (campos, não sintaxe de JSONC):

| Campo | Tipo | Efeito |
| :--- | :--- | :--- |
| `autonomy.default` | `safe\|controlled\|restricted` | nível quando a story não declara um; default do `ade init`: `safe` |
| `autonomy.operator_can_raise` | bool | o resumo de aprovação pode elevar o nível de uma story |
| `autonomy.permitted_effects` | `EffectClass[]` | forma única em todo o sistema (master-spec §5, `architecture.md` §4): **array** de `effect_class`, nunca mapa efeito→bool. Só efeitos **externos** entram; classes internas (`model_call`, `eval_run`, `local_write`, `gate`, `prepare`) são implícitas (E3). O valor daqui é o teto do repositório; o subconjunto efetivo é congelado em `plan.authorization.permitted_effects` na aprovação única, e é esse que o engine checa por passo (porte de I55) |
| `sensitive_paths` | glob[] | precedência 2; `stop_batch` |
| `secrets.patterns` | regex[] | acrescenta aos embutidos; varredura sobre o diff integral com `maxBuffer` explícito (`1<<31`). **Não existe teto configurável da varredura**: o operador não pode baixar o que é varrido, e truncagem detectada é `unexpected_tree_state`, nunca aviso (engine §8, I24). `review.max_diff_bytes` vale só para o pack do Checker |
| `gates.always` / `gates.on_flag` | argv[] | portões sobre a árvore do Maker (inclui o lint anti-slop, Oxlint vendorizado, por flag); saída passa pelo Firewall |
| `review.max_diff_bytes` | int | teto do diff entregue ao Checker; default 60 000 chars, por arquivo em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>` (E13) |
| `limits.max_pack_bytes` | int | corte do pack em bytes; default 120 000 **[hipótese]**, calibrar por p90 (E13) |
| `budgets.max_usd` / `max_model_calls` / `max_rework_rounds` | num | reserva por story no scheduler |
| `max_wall_clock_seconds` | int | orçamento de parede da missão (modo noturno) |
| `max_parked_units` | int | para o lote quando o acúmulo de unidades paradas deixa de ser útil |
| `notify` | argv | comando chamado com um JSON a cada mudança de estado relevante; roda com a confiança do operador e o mesmo `env` filtrado; **não** é efeito do lote e `permitted_effects` não o governa (RUNTIME.md, `notify_argv`) |

`deny_paths_always` embutido (não configurável para baixo): `.env*`, `**/secrets/**`, `.git/hooks/**`,
`**/*.pem`, `**/*credentials*`. Entradas fora do worktree (`~/.ssh/**`, `~/.aws/**`, `**/.env*` fora da
árvore) **não** entram aqui: vivem no `env` filtrado, no canário de isolamento e no `ade doctor`, nunca no
`contain` (que só vê o diff) — `architecture.md` §11 E23, que ajusta A4.

`.ade/` nunca entra em commit (`.git/info/exclude`). Mudança de nível — por story ou por lote — é um
`step` próprio no journal com o `permitted_effects` resultante.

**`.ade/config.json` é superfície de confiança, não dado inerte.** Ele declara argv que o **engine**
executa (`gates.always`, `gates.on_flag`, `notify`) e os padrões da varredura de segredo
(`secrets.patterns`). Vive na raiz do repo, **fora** do worktree da story, e o `contain` — por E23 — só
vê o diff do worktree: uma escrita ali não aparece em diff nenhum, e no Windows a escrita fora do
worktree não é prevenível para `claude` e `agy` (`security/README.md` §11.3). Duas consequências
operacionais na v1:

- **Argv congelado.** `gates` e `notify` são resolvidos (binário real pelo BinaryResolver) e congelados
  no `batch_open`; o lote em curso nunca relê o arquivo. Reedição só vale para o próximo lote.
- **Hash antes e depois.** `<repo>/.ade/**` (config e schemas) entra no conjunto de alvos que o canário
  de isolamento e o `ade doctor` verificam por hash antes e depois de cada chamada, junto com os
  caminhos de E23; divergência dentro do lote é `stop_batch`, como segredo.

O que **não** muda: `config_digest` continua entrando no `runtime_stamp` sem bloquear — só `core_version`
gera `stale_workflow_version` (E7). Tornar `config_digest` bloqueante seria mudança de arquitetura.

---

## 4. Flags de modo desatendido, por família e por papel

Medidas no binário local, não na documentação (`addendum-autonomia...` §1, §4.1; digest #37, #9, #27).
`ade doctor` reprova alto se uma flag do nível ativo sumiu do binário instalado: a ADE nunca finge que
`controlled` continua seguro depois de uma atualização de CLI.

### Por papel

| Papel | Escreve? | Família default | Comando |
| :--- | :-: | :--- | :--- |
| **Maker** | sim, no worktree | `claude` | `claude -p --safe-mode --session-id <uuid> --max-budget-usd <n> --json-schema <inline> --permission-mode bypassPermissions --permission-prompts none --disallowedTools "Bash(git push*),Bash(gh pr*)" --add-dir <worktree>` (string normativa única, `specs/adapters-capability-registry.md` §2), `env` filtrado + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| **Maker** (alt.) | sim, no worktree | `codex` | `codex exec --json --ignore-user-config --output-schema <arquivo> --sandbox workspace-write --approve-for-me -C <worktree>` |
| **Checker de rodada** | **não** | `codex` | `codex exec --json --ignore-user-config --output-schema review-result.schema.json --sandbox read-only -C <worktree>`; nunca `--approve-for-me`, nunca `codex review` |
| **Checker de portão** | **não** | `claude` | `claude -p --json-schema <inline> --permission-mode plan --add-dir <worktree>` |
| **Juiz visual** | **não lê o repo fonte** | outra família do Maker | rubrica no prompt + caminho de cada screenshot; na família Claude a imagem só entra por caminho de arquivo no texto do prompt (não existe `--image`, digest de `capabilities-claude-code.md` §6), logo `--safe-mode --tools "Read" --add-dir <artifacts>` — o `--add-dir` é o diretório das capturas, nunca o worktree; no braço Codex, `-i <captura>` por captura (flag nativa). Anti-ancoragem é restrição de **conteúdo do pack** (julga antes de ver diff e achados do detector), não ausência de ferramentas |
| **Classificador** | sem ferramentas | `claude` | `claude -p --output-format json --json-schema <inline> --model haiku --safe-mode --tools "" --max-turns 1 --max-budget-usd 0.05` (argv dono: `specs/adapters-capability-registry.md` §2; `--safe-mode`, nunca `--restricted`, que é outro modo e não foi medido como piso de bootstrap); só roda quando a regra determinística não fecha `trivial` — confiança < 0,6 ou classe ≥ `feature` (E18) |
| **Pesquisa** | somente-leitura | `agy` → `claude` | `agy --json-schema ... --dangerously-skip-permissions` (o `--approval-mode yolo` é do Gemini CLI, não do `agy`), worktree descartável, até o canário de isolamento passar em toda chamada (digest #38) |

`--sandbox read-only` no Checker de rodada transforma I28 ("Checker que edita a árvore") de detecção em
impossibilidade (judgment-J3 §5, recomendação §11). `no_checker_family_available` → `parked`, nunca
aprovado sem revisão. Maker ≠ Checker por `model_id`, não por binário (digest #3); o Checker de rodada
também recusa `models[].vendor` igual ao do Maker (E10). Chamada curta no Codex (Checker, classificador)
usa a receita completa `--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0`
com `AGENTS.md` ≤2 KB escrito pelo engine no worktree (E16).

### Por nível

| Nível | claude (Maker) | codex (Maker) | agy (pesquisa) |
| :--- | :--- | :--- | :--- |
| `safe` | `bypassPermissions` + `--permission-prompts none` + `--disallowedTools "Bash(git push*),Bash(gh pr*)"` (argumento único, vírgula — string normativa única) | `--sandbox workspace-write --approve-for-me`, `network_access=false` | `--dangerously-skip-permissions`, worktree descartável |
| `controlled` | idem, **mesma** string normativa (o nível não afrouxa a deny-list do worker: push/PR continuam efeito do engine) | idem, `network_access=true` (instalar dependência) | idem |
| `restricted` | **não despacha worker desatendido** | idem | idem |

Nunca `--permission-mode auto`: `auto-mode` só liga com esse valor literal do flag, é classificador
semântico exclusivo da família Claude e duplica o propósito do `contain`
(`addendum-autonomia...` §2.4). O bloco `environment` do `auto-mode` é o mesmo conteúdo que o
`.ade/config.json` já captura; gerá-lo como segunda camada opcional fica em backlog, nunca como portão.
Nunca `--bare` (quebra autenticação por assinatura, digest #9). Chamada curta no Codex sempre com
`--ignore-user-config`: piso de ~19,4k tokens de entrada (digest #27).

---

## 5. O que acontece com uma ação que exigiria aprovação

A resposta muda por família, e nenhuma é "a CLI pergunta e o engine responde".

| Família | Mecanismo | Observável | Risco |
| :--- | :--- | :--- | :--- |
| `claude` com `bypassPermissions` | **não há prompt a negar**; só `--disallowedTools` filtra, no nível de disponibilidade da ferramenta | `permission_denials` no stream-json; o texto final do turno **não** é evidência | Ferramenta bloqueada + relato de sucesso: medido. Um `claude -p` reporta sucesso após tentativa negada e retentativa — ou sem tentativa nenhuma (digest #37; `addendum-autonomia...` §2.3, §6.4) |
| `codex` com `--sandbox workspace-write` | fronteira de SO real no Windows (restricted token); escrita fora do diretório declarado falha com acesso negado | erro de acesso no stream; sem pergunta pendurada | Fail-closed real; mas `codex sandbox` como jaula universal não é zero-config (`[permissions.<nome>]` com chave não documentada; §3.2 do addendum) — não adotado na v1 |
| `agy` com `--dangerously-skip-permissions` | nada filtra | — | Escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, **sem aviso** (digest #38) |

Consequência de projeto: **bloqueio silencioso seguido de relato enganoso é o modo de falha default, não
o excepcional.** Por isso:

- O engine nunca trata `result`/`last_assistant_message` como prova. Só contam o diff da árvore, os
  eventos estruturados e o `EvalRecord`.
- `eval_run{phase: red}` contra `tree_before` é obrigatório (salvo `strictness.mode = additive`): a prova
  vermelha antes da mudança é o que distingue "o Maker trabalhou" de "o Maker escreveu um parágrafo".
  Só `red_reason: assertion` conta como vermelho válido; `missing_target`, `compile_error` e
  `environment` rebaixam para `additive` com aviso (classe ≥ `feature`: `awaiting_operator`), e `additive`
  exige no mesmo cenário um eval `negative` ou spot-check `mutate` (E12). Eval que nasce verde volta ao
  Intent Compiler (`architecture.md` §7, Eval-first).
- **Canário de isolamento por família a cada chamada**: um passo do Maker que escreve fora do worktree
  tem de falhar; se não falhar, a família é rebaixada e a story vai a `awaiting_operator`
  (judgment-J3 §3, §11.2).

---

## 6. Escalação

Destino único: fila de `awaiting_operator`, com motivo, evidência (ponteiro de artifact) e opções
`retry` / `skip` / `takeover` / `discard`. `ade decide <unit> --option retry|skip|discard|pick --value <id>`
(E32): `retry` devolve a unidade a `retryable` (o trabalho parado está no checkpoint em `refs/ade/`);
`skip` marca `failed`; `discard` manda a árvore para `refs/ade/discarded/`; `pick` escolhe entre opções
apresentadas (por exemplo, a variante visual do FQE) pelo `--value` (RUNTIME.md, `decide`).

| Gatilho | Tipo | Origem |
| :--- | :--- | :--- |
| `budget_exhausted` (usd, calls, rework, wall clock) | determinístico | reserva do scheduler |
| `loop_detected` (mesma assinatura normalizada N vezes) | determinístico | histórico de `attempt`; nunca zera com troca de modelo |
| `diff_oscillation` (árvore A→B→A) | determinístico | GitPort |
| `stagnation` (mesmo `findings_digest` do Checker em rodadas consecutivas, E22; ou assinatura de falha idêntica — hash de stderr/stack normalizado — em duas tentativas seguidas, A6) | determinístico | `review-result`; Gate/Eval runner |
| `scope_violation` 2ª vez na mesma story | determinístico | `contain` |
| `secret_detected`, `sensitive_path` | determinístico | `contain` → `stop_batch` (não é fila: para o lote) |
| `no_checker_family_available` | determinístico | Capability Registry |
| `network_unavailable` na retomada de `push`/`pull_request` | determinístico | reconciliação; **nunca retry** |
| `ambiguous` na reconciliação (remoto movido, PR em merge queue, `HEAD` avançado) | determinístico | Reconciler |
| `skill_first_use` no projeto (skill fora do conjunto elegível congelado na aprovação única, E33) | determinístico | Skill Fabric |
| `worker_heartbeat_lost` (sem heartbeat por N s: o engine mata o grupo de processos e põe o log em quarentena, A3) | determinístico | dead-man switch do Runner |
| `stale_workflow_version` | determinístico | `runtime_stamp` divergente |
| empate na pesquisa | determinístico | subsistema de pesquisa |
| `ask_operator` disparado por efeito | determinístico | `permitted_effects` × contrato |
| `target_role: 'human'` num `action_item` do Checker | **semântico** | `review-result` |

`target_role: 'human'` é o **único** gatilho semântico da ADE. Todo o resto é contável. Isso é
deliberado: o defeito latente do runtime de referência era exatamente `intent_gap` para humano que nunca
escalava, porque o schema e o código discordavam do nome do campo (digest #32).

Um lote `blocked` (só por decisões pendentes) reabre no próximo `ade run`. Um lote `stopped`
(segurança, orçamento, autorização, integridade de estado) **nunca** reabre: exige nova autorização.

---

## 7. Modo noturno — jornada 6

"Continue desenvolvendo sozinho enquanto durmo" não é classe de complexidade: é missão com `autonomy`,
orçamento de parede e retomada sem nova entrevista (`architecture.md` §5).

**Pré-requisitos (checados antes de soltar; falha em qualquer um = recusa, não degradação):**

| # | Pré-requisito |
| :-- | :--- |
| 1 | Nenhuma story `restricted` no backlog aprovado |
| 2 | `ade doctor` verde nas famílias dos papéis usados (probe real, não declaração; `probe_ok: null` recusa despacho, nunca degrada — E10) |
| 3 | `plan.mission_budget` gravado no `batch_open` com `max_wall_clock_seconds`, `max_parked_units` e `max_usd`; orçamento em USD com `cost_source` no resumo (E3) |
| 4 | Backlog já aprovado numa aprovação única prévia; `operator_can_raise` não se aplica desatendido |
| 5 | `git` limpo na base; nenhum lease vivo; `runtime_stamp` igual ao da missão |
| 6 | Gates ativos (`gates.always` não vazio) e baseline de eval verde na base (A5) |
| 7 | Caminho de rollback em `refs/ade/` disponível e isolamento por worktree verificado pelo canário da família (A5) |

`ade run --unattended` **recusa** quando qualquer um destes falta (`autonomy_requires_operator` /
precondição ausente, exit 3): a jornada 6 não degrada, não roda "sem gates" nem "sem baseline".

**Paradas do lote noturno (todas viram item de fila, nunca decisão do modelo):**

- **Skill fora do conjunto elegível** → `awaiting_operator: skill_first_use`. A aprovação única congela o
  conjunto elegível da missão (união do top-8 por story, E33): dentro dele o lote segue; skill fora dele
  exige aprovação humana mesmo em lote (`architecture.md` §7, Skill Fabric).
- **Rede indisponível** na retomada de `push`/`pull_request` → `awaiting_operator`, nunca retry (I11/I14
  exigem `ls-remote`/`gh` para reconciliar; sem rede não há como distinguir `released` de `ambiguous`).
- **Orçamento de parede esgotado** → o lote para no fim da story corrente (nunca no meio de um efeito
  externo), grava checkpoint e vai a `awaiting_operator: wall_clock_exhausted`.
- **`max_parked_units` atingido** → para o lote inteiro: acúmulo de unidades paradas deixou de produzir.
- **Backlog aprovado esgotado** → `awaiting_operator`, não geração autônoma de escopo novo.

**Relatório da manhã.** `ade report [missão]` é derivado do journal, não escrito por modelo. Seções
herdadas do runtime de referência: Completed · Changed · Commits/PRs · Verification · Automatically
Resolved · FYI · REVIEW · DECISION REQUIRED · BLOCKED · Cost/Usage (com `cost_source`; braço Codex sempre
`estimated`, digest #28) · Models · Recovery Events · What Happens Next. Story de UI acrescenta notas
visuais lado a lado para escolha preguiçosa.

**Descarte.** `ade discard <missão>` descarta o lote inteiro em um comando. Nada é apagado: tudo vai para
`refs/ade/discarded/<missão>/<n>`, incluindo árvores restauradas por `contain`. Limpar as refs é tarefa
do operador, nunca da ADE.

---

## 8. Runbooks

**Retomar após crash ou reboot.** `ade run` de novo, na mesma missão. O Reconciler lê o journal, compara
cada `step_intent` sem `step_result` contra o mundo (recibo durável em `.ade/missions/<id>/jobs/<step>.json`
com fingerprint pid+start time; `git ls-remote`; `gh pr list`) e classifica `ok` / `released` / `ambiguous`.
Na v1 o worker é não-detached: morre com o engine, a chamada vira `ambiguous`, a árvore suja vira
checkpoint e o próximo Maker continua. Perde-se uma chamada paga; ganha-se contenção de árvore de
processos de graça (`architecture.md` §6).

**Lease preso.** `ade status` mostra o dono (pid, start time). Exit 5 em conflito. Lease morto-vivo após
reboot é adotado automaticamente **só** quando o processo dono não existe com o mesmo start time — PID
reciclado não engana. Se o dono existe e é seu, encerre o engine; nunca apague `lease/` à mão com engine
vivo.

**`stale_workflow_version`.** `runtime_stamp` (`<core_version>:<config_digest>:<capabilities_digest>`, E7)
divergiu de uma intenção aberta. Só `core_version` — constante do núcleo durável (C1–C5, C7) — bloqueia;
`config_digest` e `capabilities_digest` (que cobre upgrade silencioso de CLI, `agy` 1.2.3 → 1.2.4) entram
no carimbo e no relatório. A missão fica bloqueada até `ade run --accept-stale-version`, gravado como
evento `decision`. Aceite depois de ler o diff de config; em dogfood, a regra existe exatamente para
impedir trocar o engine embaixo de uma missão em andamento (`architecture.md` §6).

**Worktree órfão.** `.ade/wt/<story>/` sem story viva. `ade doctor` reporta; a remoção é `git worktree
remove` pelo engine, e o conteúdo vai antes para `refs/ade/discarded/`. Em repo JS, `node_modules` por
worktree é custo real e conhecido — não compartilhe entre worktrees (quebra o isolamento que é a única
fronteira universal).

**Journal corrompido.** Linha inválida ou cadeia de hash quebrada é **recusa, exit 2, nunca ignorada**
(RUNTIME.md). A missão não abre. Recuperação: `ade show <ref>` para inspecionar, copiar o journal para
perícia, e abrir missão nova sobre a mesma base — a árvore está em `refs/ade/`, não no journal.

**Inventário do mundo é obrigatório antes de recomeçar.** Um journal ilegível pode conter intenções
abertas de efeito externo (`local_commit`, `push`, `pull_request`, `pull_request_merge`) que a
reconciliação nunca resolverá, porque a reconciliação lê o journal. Abrir missão nova sem inventário
reintroduz exatamente as duplicações que I35–I38 impedem. Passos, nesta ordem:

1. **Leitura forense somente-leitura**: `ade show <ref>` percorre o journal **até a primeira linha
   inválida** e lista os `step_intent` sem `step_result` com `effect_class` externo e o `intent_context`
   de cada um. Nada é reescrito; o arquivo corrompido é preservado para perícia.
2. **Confronto com o mundo**: `git ls-remote` para branches e commits empurrados, `gh pr list --head
   ade/<missão>/<story>` para PR aberto ou em merge queue, `git log` na base para merge já integrado.
3. **Confirmação do operador** do relatório resultante (o que existe no remoto e o que será
   considerado já entregue). Sem essa confirmação a missão nova não abre.
4. A missão nova nasce com um evento `note` referenciando o inventário e com `permitted_effects`
   reduzido a efeitos locais até a confirmação — o engine não empurra nem abre PR sobre uma base cujo
   estado remoto não foi inventariado.

**Custo estourado.** `budget_exhausted` para a story corrente (nunca no meio de efeito externo) e põe em
`awaiting_operator`. `ade decide <unit> --option retry` só depois de elevar `budgets.max_usd` no
`.ade/config.json` — o que muda o `config_digest` do `runtime_stamp` (registrado, mas não bloqueante: só
`core_version` gera `stale_workflow_version`, E7). Alternativa mais barata: `--option skip`.

**Dependência instalada pelo agente (`controlled`).** Permitida dentro do worktree, com `network_access=true`
no Codex. `contain` exige que o lockfile esteja no diff e dentro de `scope_paths`. Bump **major** de
dependência existente é `ask_operator: dependency_major_bump` — a instalação já aconteceu no worktree; o
que pausa é o commit.

**Migration (`controlled`).** Roda no worktree, contra banco local. DDL destrutivo (`DROP`, `TRUNCATE`,
`ALTER ... DROP COLUMN`) é `ask_operator: migration_destructive`, detectado por padrão sobre o arquivo de
migration no diff, não por julgamento de modelo. Migration contra banco não-local é efeito de produção:
`restricted`.

**Produção e segredos (`restricted`).** Não roda desatendido, ponto. O engine recusa despachar
(`autonomy_requires_operator`). Segredo encontrado em qualquer nível é `stop_batch` antes de commit, lote
`stopped`, nova autorização obrigatória. O operador que quiser agir usa `ade takeover <story>`, ciente de
que o takeover apaga todas as camadas nativas (permission-mode, execpolicy, sandbox, `--disallowedTools`)
— a única invariante que sobrevive é "só o resultado na árvore conta", porque é a única implementada fora
de qualquer CLI (`addendum-autonomia...` §6.5). `ade release <story>` grava checkpoint e devolve o ciclo.

---

## 9. Divergências resolvidas

Arbitradas em `architecture.md` §11 (2026-09-17). O texto deste documento já reflete cada decisão.

**9.1 — Forma do argumento `--disallowedTools` → aceita (`architecture.md` §11 E24).** Vale a forma
medida: **um** argumento com regras separadas por vírgula (`--disallowedTools "Bash(git push*),Bash(gh pr*)"`),
não dois argumentos com espaço dentro do glob. A forma errada é no-op silencioso. A string normativa é
única e mora em `specs/adapters-capability-registry.md` §2 — este documento e `security/README.md` a
referenciam, não a redigitam em variantes. Probe obrigatório do
`ade doctor`: um `-p` que tenta `git push --dry-run` **com essa string exata** tem de produzir
`permission_denials` não vazio.
Refletido em §1 e §4.

**9.2 — `ask_operator` com vocabulário fechado → aceita (E5).** Enum fechado no `task-contract.schema.json`
(`push`, `pull_request`, `pull_request_merge`, `dependency_add`, `dependency_major_bump`,
`migration_destructive`, `deploy`, `secrets_read`, `destructive_local`, `skill_first_use`, `*`) mais
`note` livre à parte. Nada em linguagem natural num campo avaliado sem modelo. Refletido em §2.

**9.3 — `deny_paths_always` com caminhos fora do worktree → aceita (E23, ajusta A4).** `~/.ssh/**`,
`~/.aws/**` e `**/.env*` fora da árvore saem do `contain` (que só vê o diff) e vivem no `env` filtrado,
no canário de isolamento e no `ade doctor`. Refletido em §3.

**9.4 — `restricted` com `scope_paths: ["**"]` → aceita (E5).** `restricted` herda
`${story.scope_paths}` como os demais níveis e mantém `stop_batch`: mais estrito nos dois eixos.

**9.5 — `restricted` com `permission_prompts: "host"` → aceita (E5).** `restricted` não tem bloco de
famílias: tem `dispatch: never` (`autonomy_requires_operator`). Refletido em §2 e §4.

**9.6 — `max_diff_bytes` herdado sem revisão → aceita (E13).** Teto explícito em `.ade/config.json`:
`review.max_diff_bytes` default 60 000 chars (não os 200 000 herdados), entregue por arquivo em ordem de
relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>` em vez de truncagem cega. O corte do
pack passa a ser em bytes (`limits.max_pack_bytes`, default 120 000 **[hipótese]**). Refletido em §3.

---

## 10. Perguntas abertas

1. Forma exata e comportamento de `--permission-prompts none` em 2.1.271 quando combinada com
   `bypassPermissions` — medido como "não há prompt a negar", mas não há doc de produto (§9.1).
2. Chave de `[permissions.<nome>]` que libera escrita no próprio `cwd` do `codex sandbox`: não está no
   `--help`; exige leitura do código-fonte do Codex. Bloqueia `codex sandbox` como jaula universal
   (backlog v2).
3. `agy`/Policy Engine falha aberto ou fechado com `--policy` inválido ou ausente? Sem confirmação
   (`addendum-autonomia...` §6.8). Enquanto isso, `agy` só somente-leitura e com canário por chamada.
4. Defaults numéricos de `max_wall_clock_seconds` e `max_parked_units` para a jornada 6: **[hipótese]**
   8 h e 3 (E3), a calibrar no dogfood.
5. Custo real do classificador barato: `claude -p --model haiku` faturou como `claude-sonnet-5`
   (US$ 0,37 para ecoar 200 bytes, digest #26). Até medir, o classificador tem orçamento próprio e
   fallback determinístico por tamanho de diff estimado.
6. `notify` roda com a confiança do operador e fora de `permitted_effects` (herdado de `notify_argv`).
   Se o comando de notificação fizer efeito externo, a ADE não o vê. Aceito conscientemente; revisar se
   o painel da v0.4 passar a configurá-lo.

## 11. Emendas de `architecture.md` §12 (2026-09-17)

§12 prevalece sobre este documento. Itens com efeito aqui: E44 (`deploy` e `dependency_install` são valores só de `ask_operator`, não de `effect_class`); E46 (literal canônico `"Bash(git push *),Bash(gh pr *),Bash(gh release *)"`, sede em adapters §2); E47 (exit codes = master-spec §4); E64 (`local_merge` ff-only entra em `safe`); E42 (`takeover_open` recusa despacho); E43/E68 (só `core_version` bloqueia; `config_digest`/`capabilities_digest` só relatam); E62 (sem cancelamento de story `running`); E56 (v1 assume repositório do próprio operador).
