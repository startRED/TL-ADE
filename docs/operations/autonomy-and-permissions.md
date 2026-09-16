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
  `--disallowedTools` é glob de string best-effort (`git -C <dir> push`, um alias, um script de repo
  passam; judgment-J3 §5): a cerca real é o `env` filtrado mais o engine ser o único a rodar git/gh.

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
sai do worktree vira pergunta**. `ask_operator: ['*']` é obrigatório no contrato e o engine recusa
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
| `autonomy.permitted_effects` | mapa efeito→bool | vocabulário de `effect_class` do journal; o engine recusa um lote cujo passo peça efeito não permitido (porte de I55) |
| `sensitive_paths` | glob[] | precedência 2; `stop_batch` |
| `secrets.patterns` | regex[] | acrescenta aos embutidos; varredura sobre o diff integral com `maxBuffer` explícito |
| `secrets.max_diff_bytes` | int | teto da varredura; estourar é `stop_batch`, nunca truncar em silêncio |
| `gates.always` / `gates.on_flag` | argv[] | portões sobre a árvore do Maker; saída passa pelo Firewall |
| `budgets.max_usd` / `max_model_calls` / `max_rework_rounds` | num | reserva por story no scheduler |
| `max_wall_clock_seconds` | int | orçamento de parede da missão (modo noturno) |
| `max_parked_units` | int | para o lote quando o acúmulo de unidades paradas deixa de ser útil |
| `notify` | argv | comando chamado com um JSON a cada mudança de estado relevante; roda com a confiança do operador e o mesmo `env` filtrado; **não** é efeito do lote e `permitted_effects` não o governa (RUNTIME.md, `notify_argv`) |

`deny_paths_always` embutido (não configurável para baixo): `.env*`, `**/secrets/**`, `.git/hooks/**`,
`**/*.pem`, `**/*credentials*`. Entradas fora do worktree (`~/.ssh/**`, `~/.aws/**`) **não** entram aqui
— ver Divergências §8.3.

`.ade/` nunca entra em commit (`.git/info/exclude`). Mudança de nível — por story ou por lote — é um
`step` próprio no journal com o `permitted_effects` resultante.

---

## 4. Flags de modo desatendido, por família e por papel

Medidas no binário local, não na documentação (`addendum-autonomia...` §1, §4.1; digest #37, #9, #27).
`ade doctor` reprova alto se uma flag do nível ativo sumiu do binário instalado: a ADE nunca finge que
`controlled` continua seguro depois de uma atualização de CLI.

### Por papel

| Papel | Escreve? | Família default | Comando |
| :--- | :-: | :--- | :--- |
| **Maker** | sim, no worktree | `claude` | `claude -p --safe-mode --session-id <uuid> --max-budget-usd <n> --json-schema <inline> --permission-mode bypassPermissions --permission-prompts none --disallowedTools "Bash(git push*),Bash(gh pr*),Bash(gh release*)" --add-dir <worktree>`, `env` filtrado + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| **Maker** (alt.) | sim, no worktree | `codex` | `codex exec --json --ignore-user-config --output-schema <arquivo> --sandbox workspace-write --approve-for-me -C <worktree>` |
| **Checker de rodada** | **não** | `codex` | `codex exec --json --ignore-user-config --output-schema review-result.schema.json --sandbox read-only -C <worktree>`; nunca `--approve-for-me`, nunca `codex review` |
| **Checker de portão** | **não** | `claude` | `claude -p --json-schema <inline> --permission-mode plan --add-dir <worktree>` |
| **Juiz visual** | **não lê o repo** | outra família do Maker | screenshots + rubrica no prompt; sem `--add-dir`, sem ferramentas; julga antes de ver diff e achados do detector |
| **Classificador** | sem ferramentas | `claude` | `claude -p --restricted --json-schema <inline>` (`--restricted` remove Bash/PowerShell/REPL/WebFetch e ignora settings de usuário/projeto) |
| **Pesquisa** | somente-leitura | `agy` → `claude` | `agy --json-schema ... --approval-mode yolo`, worktree descartável, até o canário de isolamento passar em toda chamada (digest #38) |

`--sandbox read-only` no Checker de rodada transforma I28 ("Checker que edita a árvore") de detecção em
impossibilidade (judgment-J3 §5, recomendação §11). `no_checker_family_available` → `parked`, nunca
aprovado sem revisão. Maker ≠ Checker por `model_id`, não por binário (digest #3).

### Por nível

| Nível | claude (Maker) | codex (Maker) | agy (pesquisa) |
| :--- | :--- | :--- | :--- |
| `safe` | `bypassPermissions` + `--permission-prompts none` + `--disallowedTools` cobrindo git/gh/WebFetch | `--sandbox workspace-write --approve-for-me`, `network_access=false` | `--approval-mode yolo`, worktree descartável |
| `controlled` | idem; `--disallowedTools` cobre `git push*`, `gh pr create*`, `gh pr merge*` | idem, `network_access=true` (instalar dependência) | idem |
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
| `agy` com `yolo` | nada filtra | — | Escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, **sem aviso** (digest #38) |

Consequência de projeto: **bloqueio silencioso seguido de relato enganoso é o modo de falha default, não
o excepcional.** Por isso:

- O engine nunca trata `result`/`last_assistant_message` como prova. Só contam o diff da árvore, os
  eventos estruturados e o `EvalRecord`.
- `eval_run{phase: red}` contra `tree_before` é obrigatório (salvo `strictness.mode = additive`): a prova
  vermelha antes da mudança é o que distingue "o Maker trabalhou" de "o Maker escreveu um parágrafo".
  Eval que nasce verde volta ao Intent Compiler (`architecture.md` §7, Eval-first).
- **Canário de isolamento por família a cada chamada**: um passo do Maker que escreve fora do worktree
  tem de falhar; se não falhar, a família é rebaixada e a story vai a `awaiting_operator`
  (judgment-J3 §3, §11.2).

---

## 6. Escalação

Destino único: fila de `awaiting_operator`, com motivo, evidência (ponteiro de artifact) e opções
`retry` / `skip` / `takeover` / `discard`. `ade decide <unit> --option retry|skip`: `retry` devolve a
unidade a `retryable` (o trabalho parado está no checkpoint em `refs/ade/`); `skip` marca `failed`
(RUNTIME.md, `decide`).

| Gatilho | Tipo | Origem |
| :--- | :--- | :--- |
| `budget_exhausted` (usd, calls, rework, wall clock) | determinístico | reserva do scheduler |
| `loop_detected` (mesma assinatura normalizada N vezes) | determinístico | histórico de `attempt`; nunca zera com troca de modelo |
| `diff_oscillation` (árvore A→B→A) | determinístico | GitPort |
| `stagnation` (mesmos achados do Checker em rodadas consecutivas) | determinístico | `review-result` |
| `scope_violation` 2ª vez na mesma story | determinístico | `contain` |
| `secret_detected`, `sensitive_path` | determinístico | `contain` → `stop_batch` (não é fila: para o lote) |
| `no_checker_family_available` | determinístico | Capability Registry |
| `network_unavailable` na retomada de `push`/`pull_request` | determinístico | reconciliação; **nunca retry** |
| `ambiguous` na reconciliação (remoto movido, PR em merge queue, `HEAD` avançado) | determinístico | Reconciler |
| `skill_first_use` no projeto | determinístico | Skill Fabric |
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
| 2 | `ade doctor` verde nas famílias dos papéis usados (probe real, não declaração) |
| 3 | `max_wall_clock_seconds` e `max_parked_units` definidos; orçamento em USD com `cost_source` no resumo |
| 4 | Backlog já aprovado numa aprovação única prévia; `operator_can_raise` não se aplica desatendido |
| 5 | `git` limpo na base; nenhum lease vivo; `runtime_stamp` igual ao da missão |

**Paradas do lote noturno (todas viram item de fila, nunca decisão do modelo):**

- **Skill nova no projeto** → `awaiting_operator: skill_first_use`. Primeira aparição exige aprovação
  humana mesmo em lote (`architecture.md` §7, Skill Fabric).
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

**`stale_workflow_version`.** `runtime_stamp` (`<versão do engine>:<digest da config>`) divergiu de uma
intenção aberta. A missão fica bloqueada até `ade run --accept-stale-version`. Aceite depois de ler o
diff de config; em dogfood, a regra existe exatamente para impedir trocar o engine embaixo de uma missão
em andamento (`architecture.md` §6).

**Worktree órfão.** `.ade/wt/<story>/` sem story viva. `ade doctor` reporta; a remoção é `git worktree
remove` pelo engine, e o conteúdo vai antes para `refs/ade/discarded/`. Em repo JS, `node_modules` por
worktree é custo real e conhecido — não compartilhe entre worktrees (quebra o isolamento que é a única
fronteira universal).

**Journal corrompido.** Linha inválida ou cadeia de hash quebrada é **recusa, exit 2, nunca ignorada**
(RUNTIME.md). A missão não abre. Recuperação: `ade show <ref>` para inspecionar, copiar o journal para
perícia, e abrir missão nova sobre a mesma base — a árvore está em `refs/ade/`, não no journal.

**Custo estourado.** `budget_exhausted` para a story corrente (nunca no meio de efeito externo) e põe em
`awaiting_operator`. `ade decide <unit> --option retry` só depois de elevar `budgets.max_usd` no
`.ade/config.json` — o que muda o `runtime_stamp` e exige `--accept-stale-version` se houver intenção
aberta. Alternativa mais barata: `--option skip`.

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

## 9. Divergências propostas

Objeções a `architecture.md`; a revisão adversarial decide. Nenhuma decisão foi alterada neste documento.

**9.1 — Forma do argumento `--disallowedTools`.** `architecture.md` §7 escreve
`--disallowedTools "Bash(git *)" "Bash(gh *)"` (dois argumentos, espaço dentro do glob). A medição do
addendum §1/§4.1 usa **um** argumento com regras separadas por vírgula
(`--disallowedTools "Bash(git push*),Bash(gh pr*)"`) e registra que "o espaço antes do `*` importa" no
prefix-match. Duas formas diferentes não podem estar ambas certas, e a forma errada faz **no-op
silencioso** — exatamente o modo de falha que este documento diz que a arquitetura deve evitar. Proposta:
fixar a forma de argumento único separado por vírgula e transformar isso em probe do `ade doctor`
(lançar um `-p` que tenta `git push --dry-run` e exigir `permission_denials` não vazio). Evidência:
`addendum-autonomia-permissoes-por-repositorio.md` §1, §4.1; digest #37.

**9.2 — `ask_operator` precisa de vocabulário fechado.** `architecture.md` §4 tipa `ask_operator?: string[]`
e o addendum §5 preenche com frases ("dependência com bump major", "migration com DROP/TRUNCATE",
"hard_deny (qualquer família)"). Frase em linguagem natural num campo que o engine tem de avaliar **sem
modelo** reintroduz o gatilho semântico que a §5.11 limita a um só (`target_role: 'human'`). Proposta:
enum fechado (o de §2 deste documento) no `task-contract.schema.json`, com `note` livre à parte.
Evidência: judgment-J3 §10.9 ("`ask_operator: '*'` não está em contrato nenhum"); digest #32 (o defeito
latente do runtime nasceu de schema e código discordando de um campo de escalação).

**9.3 — `deny_paths_always` com caminhos fora do worktree é regra morta.** O addendum §5 lista `~/.ssh/**`
e `~/.aws/**` em `deny_paths_always`. `contain` opera sobre `git status`/diff **do worktree**
(judgment-J3 §3): esses globs nunca casam e dão sensação falsa de cobertura. A proteção real desses
caminhos é o `env` filtrado (I49) mais o canário de isolamento por família. Proposta: removê-los do
`contain` e registrá-los como item do canário e do `ade doctor`. Evidência: judgment-J3 §3; digest #38.

**9.4 — `restricted` com `scope_paths: ["**"]` é mais largo que `safe`.** O addendum §5 define, para
`restricted`, `contain.scope_paths: ["**"]` — um nível chamado "restrito" cuja regra de escopo aceita
qualquer caminho, confiando apenas em `on_scope_violation: stop_batch`. Proposta: `restricted` herda
`${story.scope_paths}` como os outros e mantém `stop_batch` (mais estrito nos dois eixos, não só num).
Evidência: `addendum-autonomia...` §5, bloco `restricted`.

**9.5 — `restricted` com `permission_prompts: "host"` não tem host.** O addendum §5 configura, para
`restricted`, `claude: { permission_mode: "plan", permission_prompts: "host" }`. Numa sessão headless
`-p` despachada pelo engine não existe host interativo para responder o prompt: ou pendura, ou degrada
para o default. Como `restricted` nunca roda desatendido de qualquer forma (§2), a entrada é
contraditória. Proposta: `restricted` não tem bloco `families`; tem `dispatch: never`. Evidência:
`addendum-autonomia...` §4.2 (`restricted`: "a resposta correta é não desatender").

**9.6 — `max_diff_bytes` herdado sem revisão.** `architecture.md` não fixa o teto de diff entregue ao
Checker; o valor herdado do runtime é 200 000 chars (~50k tokens), pago por rodada, por Checker, por
story grande. Judgment-J3 §6 nomeia isso como o desperdício estrutural nº 2, presente nas três propostas
do painel. Proposta: teto explícito no `.ade/config.json` (`review.max_diff_bytes`), menor, com ponteiro
de drill-down pelo Firewall (`ade show <ref>`) em vez de truncagem cega. Evidência: judgment-J3 §6, §10.5.

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
   6 h e 3, a calibrar no dogfood.
5. Custo real do classificador barato: `claude -p --model haiku` faturou como `claude-sonnet-5`
   (US$ 0,37 para ecoar 200 bytes, digest #26). Até medir, o classificador tem orçamento próprio e
   fallback determinístico por tamanho de diff estimado.
6. `notify` roda com a confiança do operador e fora de `permitted_effects` (herdado de `notify_argv`).
   Se o comando de notificação fizer efeito externo, a ADE não o vê. Aceito conscientemente; revisar se
   o painel da v0.4 passar a configurá-lo.
