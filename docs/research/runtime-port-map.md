# Mapa de porte do runtime durável — tl-orchestrator v0.17.0 → TL-ADE (TypeScript)

Data: 2026-09-16 · Pesquisa para a rodada de rearquitetação da TL-ADE.
Fonte primária: `E:\Documentos\ProjetosIA\tl-orchestrator-release` — `scripts/tl_runtime.py` (2470 linhas,
`RUNTIME_VERSION = "0.17.0"`, linha 40), `scripts/tl_job.py` (2562), `scripts/tl_supervisor.py` (558),
`scripts/tl_ci_slice.py` (181), `scripts/tests/test_tl_runtime.py` (1324, 93 casos), `docs/RUNTIME.md` (309),
`schemas/*.json`. Todas as linhas citadas foram lidas nesta pesquisa (tag `[verificado: código]`).

Convenção: `[verificado: <fonte>]` = lido em fonte primária · `[inferido]` = dedução a partir de
fonte primária · `[hipótese]` = não verificado.

---

## 0. Baseline da suíte no Windows (executada nesta pesquisa)

- **Surpresa nº 1 — não há 10 falhas: a suíte passa inteira no Windows.** Resultado literal:

  ```
  ...............................................................s.............................
  ----------------------------------------------------------------------
  Ran 93 tests in 1092.872s

  OK (skipped=1)
  ```

  93 casos, **0 falhas, 0 erros, 1 skip**, 1092,9 s (~18 min), Windows 11 Pro 26200, Python 3.13.
  [verificado: execução local 2026-09-16]
- **O único skip** é `test_push_that_errors_after_landing_is_not_repeated`
  (`test_tl_runtime.py` 687, skip em 700-701): *"a .cmd shim cannot forward multi-line commit messages;
  this scenario runs on the POSIX CI"*. É limitação do **fixture** (um shim `.cmd` que embrulha o `git`
  para simular push que erra depois de aterrissar), não do runtime. **No porte TS o skip desaparece**:
  o shim vira `node shim.js`, que recebe argumentos multi-linha sem passar por `cmd.exe`.
  [verificado: código do teste]
- **De onde vem o "10"**: o CHANGELOG atribui a baseline de falhas no Windows a
  **`test_context_ledger` e `test_resume_generate` — "3 falhas e 7 erros"** (= 10), **não** a
  `test_tl_runtime.py`. Ver `CHANGELOG.md` 231-232 (v0.15.0) e 282-284 (v0.13.0): *"No Windows, a baseline
  mantém 3 falhas e 7 erros em `test_context_ledger` e `test_resume_generate`; suporte desses helpers não
  está validado nessa plataforma"*. O PROMPT.md da ADE (linha 30) e a spec v2 §15 herdaram o número do
  helper errado. [verificado: CHANGELOG.md + PROMPT.md]
- **Consequência para a spec v2 §15.** O critério "os 10 casos com falha pré-existente no Windows devem
  passar nos dois sistemas" deve ser substituído por: **"93/93 de `test_tl_runtime.py` em Windows e
  Linux, incluindo o caso hoje skipado"**. Os helpers realmente quebrados no Windows
  (`context_ledger.py`, `resume_generate.py`) são exatamente os que a ADE **não** porta (§2 e §4). [inferido]
- **Custo da suíte é um requisito de porte.** ~11,7 s por caso em média, dominados por
  `RuntimeTest` (cada caso cria repositório Git + remoto bare + subprocessos `tl_job`). Em série, 18 min;
  a suíte Vitest equivalente precisa de paralelismo por caso (worker com tmpdir próprio) para o ciclo de
  paridade ser usável. [verificado: execução local]
- `python -m pytest ...` **não roda** nesta máquina: `No module named pytest` no Python 3.13 da Store
  (`PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0`). O runner válido é
  `python scripts/tests/test_tl_runtime.py` (`unittest.main()`). [verificado: execução local]

---

## 1. Invariantes de durabilidade (lista exaustiva)

### 1.1 Tabela invariante | código | teste | porte TS | risco

| # | Invariante | Código (`scripts/tl_runtime.py` salvo indicação) | Teste que o prova (`scripts/tests/test_tl_runtime.py`) | Porte TS | Risco |
| :-- | :--- | :--- | :--- | :--- | :--- |
| I01 | **Write-ahead por step**: `step_intent` antes do efeito, `step_result` depois | `Runtime.step` 1285-1324 (intent 1298-1300, `fn` 1302, result 1310-1312) | `test_crash_before_maker_effect_releases_the_call` 1086; `..._after_maker_effect...` 1102; `..._after_commit...` 1119 | Função `step()` async; toda escrita passa por uma fila serializada (mutex assíncrono) para preservar ordem total | Médio: em Node o `await` entre intent e efeito abre janela de reentrância — proibir dois `step()` concorrentes na mesma unidade |
| I02 | **Cadeia de hash** (`prev` = 16 hex do SHA-256 da linha anterior); linha adulterada = recusa (exit 2) | `Journal.append` 301-311, `Journal.read` 313-338 (`prev` check 331-333), `Runtime.acquire` 1233-1235 | `test_journal_hash_chain_detects_tampering` 326; `test_invalid_journal_line_is_refused` 1168 | Canonicalizador **RFC 8785 (JCS)** em vez de reimplementar `json.dumps(sort_keys, ensure_ascii=False, separators)` | **Alto**: `JSON.stringify` não ordena chaves, serializa `1.0` como `1` e escapa surrogates isolados. Um canonicalizador errado quebra a cadeia silenciosamente |
| I03 | **fsync por linha** | `Journal.append` 307-310 (`flush` + `os.fsync`) | Indireto: todos os casos `TL_RUNTIME_FAULT` (`os._exit(70)` em `_fault_point` 1255-1262) | `fs.openSync(path,'a')` mantido aberto + `fs.writeSync` + `fs.fsyncSync(fd)` | Médio: `fs.appendFileSync` **não** garante flush; a opção `flush` só existe em `appendFile` (v21.1.0/v20.10.0) [verificado: nodejs.org/api/fs.html] |
| I04 | **Lease exclusivo** (um escritor por lote; exit 5 `coordinator_conflict`) | `Runtime.acquire` 1222-1226 → `tl_job.lock_exclusive` (`tl_job.py` 1240-1249: `fcntl.flock` / `msvcrt.locking`) | `test_lease_is_exclusive` 1031; `test_decide_needs_the_lease` 459 | Node **não tem flock no core** [verificado: nodejs.org/api/fs.html + npm]; usar `proper-lockfile` (mkdir + stat + heartbeat) ou `openSync(...,'wx')` com detecção de stale | **Alto**: lockfile advisory vaza em crash; `msvcrt.locking` é mandatório e liberado pelo SO, um `.lock` não é. Exige heartbeat + TTL |
| I05 | **Idempotência por step id + `input_digest`**: resultado `ok` com mesmo digest é reusado | `Runtime.step` 1288-1296 | `test_resume_after_commit_with_changed_pack_does_not_redispatch` 361; `test_crash_after_journaled_checker_result_never_redispatches` 881; `test_changed_gate_command_is_not_served_from_cache` 510 | Igual; `input_digest` = SHA-256 do intent canônico (JCS) | Médio: depende de I02 |
| I06 | **`model_call` é identificada pelo step id, não pelo pack**: resultado `ok` é reusado mesmo com pack recompilado diferente (a chamada já foi paga) | `Runtime.step` 1292-1296 | `test_resume_after_commit_with_changed_pack_does_not_redispatch` 361; `test_resume_after_commit_does_not_reserve_new_calls` 489 | Igual, literal | Baixo |
| I07 | **`released` vs `ambiguous`**: só `start_failed`/`invalid_input`/`conflict` provam que nada rodou e não são cobradas | `NO_DISPATCH_STATES` 59; `implement` 1595; `review` 1717 | `test_missing_harness_executable_is_environment_and_not_charged` 1055; `test_crash_before_maker_effect_releases_the_call` 1086 | Mapear estados equivalentes do spawn Node (`ENOENT`, `EINVAL`, `EACCES`) para `released`; qualquer outro é `ambiguous` | Médio: o conjunto de erros do `child_process` é diferente do de `subprocess`; errar aqui cobra ou perde chamadas |
| I08 | **Reconciliação por classe de efeito** antes de qualquer escalonamento | `Runtime.reconcile` 2051-2093; `_reconcile_one` 2109-2200 | 14 casos de fault injection (ver I09-I16) | Porte literal da tabela (RUNTIME.md "Step: a primitive do journal") | **Alto**: é o coração da durabilidade; qualquer simplificação reintroduz efeito duplicado |
| I09 | Reconciliação **`model_call`**: `not_started` → `released`; `starting/running` → **anexa** ao supervisor e espera; terminal sem resultado → `ambiguous` + checkpoint | `_reconcile_one` 2112-2127; `Harness.inspect` 946-953 | `test_crash_before_maker_effect_releases_the_call` 1086; `test_crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` 1102 | Com PTY do painel, "anexar" exige recibo em disco por chamada (o que `tl_job` faz) — **não** basta o handle do processo, que morre com o processo Node | **Alto**: hoje `tl_job.py` é quem dá o recibo durável; a ADE tem de reimplementar isso ou manter um shim |
| I10 | Reconciliação **`local_commit`**: adota só se `HEAD^{tree}` == árvore da intenção e pai confere; `HEAD` além do pai → `ambiguous` (nunca adota commit alheio) | `_reconcile_one` 2128-2139 | `test_crash_after_commit_is_reconciled_without_a_second_commit` 1119; `test_crash_after_journaled_commit_resumes_with_that_commit` 854; `test_branch_amended_after_journaled_commit_is_not_delivered` 839 | `execFile('git', [...])`; parsing igual | Baixo |
| I11 | Reconciliação **`push`**: `git ls-remote` contra `remote_before` gravado no `intent_context`; só "remoto exatamente como antes" libera o retry | `_reconcile_one` 2140-2152; intent context 1888-1889 | `test_crash_after_push_is_reconciled_against_the_remote` 1132; `test_diverged_remote_after_crash_awaits_operator` 1146; `test_remote_reset_after_a_pushed_crash_is_not_pushed_over` 662 | Igual | Baixo |
| I12 | Reconciliação **`pull_request`**: `gh pr list --head` adota só com `baseRefName` **e** `headRefOid` exatos; `MERGED` completa a unidade; `CLOSED` → `ambiguous` | `_reconcile_one` 2153-2170; `_find_pr` 2084-2092 | `test_crash_after_pr_creation_is_reconciled` 1247; `test_foreign_pr_on_the_branch_is_not_adopted` 594; `test_merged_pr_at_another_head_is_not_adopted` 473; `test_pr_merged_by_operator_during_interrupted_create_completes_the_unit` 898 | Igual; `gh` resolve para `gh.exe` (execFile direto funciona) | Baixo |
| I13 | Reconciliação **`pull_request_merge`**: PR ainda `OPEN` **não** prova que a chamada não aconteceu (merge queue) → `ambiguous` + `awaiting_operator` | `_reconcile_one` 2171-2183 | `test_merge_queue_success_reply_is_not_a_merge` 728; `test_crash_between_merge_call_and_verification_waits_for_operator` 753; `test_pr_merged_into_another_base_after_crash_is_not_adopted` 647 | Igual | Baixo |
| I14 | Reconciliação **`local_merge`**: `merge-base --is-ancestor`, `MERGE_HEAD` (merge em curso nunca é abortado), `base_before` do `intent_context` | `_reconcile_one` 2186-2198; contexto 2003-2004 | `test_base_moved_during_interrupted_local_merge_waits_for_operator` 796; `test_base_reset_after_a_completed_local_merge_is_not_merged_again` 810; `test_merge_in_progress_after_crash_waits_for_operator` 532 | Igual | Baixo |
| I15 | Reconciliação **`ci_rerun`**: sempre `ambiguous`, contado e nunca repetido | `_reconcile_one` 2184-2185 | `test_ci_infrastructure_failure_reruns_once_then_parks` 1222 | Igual (3 linhas) | Baixo |
| I16 | Reconciliação **`gate`/`ci_query`/`prepare`**: `released`, rodam de novo | `_reconcile_one` 2200 | `test_gate_leftovers_after_crash_are_not_committed` 606 | Igual | Baixo |
| I17 | **`intent_context`** (observações pré-efeito) é gravado com a intenção mas **fora** do `input_digest` | `Runtime.step` 1285-1300 (o `context` não entra em `input_digest`, 1288 + 1299) | `test_crash_after_push...` 1132; `test_base_moved_during...` 796 | Igual — é o que permite reconciliar sem invalidar cache | Baixo |
| I18 | **Checkpoint em ref**: árvore suja após ambiguidade vira `refs/tl/checkpoints/<lote>/<unidade>/<n>` | `_checkpoint_dirty` 2098-2107; `Git.checkpoint` 475-479 (`commit-tree` + `update-ref`) | `test_crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` 1102 | Igual (git puro) | Baixo |
| I19 | **Nada é descartado sem cópia**: toda restauração grava `refs/tl/discarded/<lote>/<n>` antes | `Runtime.restore` 1458-1464; `Git.restore_tree` 481-495 | `test_discarded_tree_is_kept_under_a_ref` 340 | Igual | Baixo |
| I20 | **`clean -fd` antes de `read-tree`**, sob as regras de ignore vigentes (arquivo ignorado só pela regra descartada fica no disco) | `Git.restore_tree` 490-494 | `test_restore_keeps_a_file_ignored_only_by_the_discarded_rules` 916 | Igual — ordem dos dois comandos é o invariante | Médio: inverter a ordem apaga arquivo do operador |
| I21 | **Árvore do worktree como identidade** (`git add -A` em índice temporário + `write-tree`), com truque do índice "racy" (`utime(1,1)`) para detectar reescrita de mesmo tamanho no mesmo segundo | `Git.worktree_tree` 450-473 | `test_worktree_tree_sees_a_same_size_rewrite_within_one_second` 767 | `GIT_INDEX_FILE` por chamada + `fs.copyFileSync` + `fs.utimesSync(idx, 1, 1)` | Médio: fácil de perder no porte; sem isso o gate cache e o `contain` ficam cegos |
| I22 | **`dirty_paths` com `-z` e os dois lados de rename** (`secrets/x -> pkg/x` é toque em `secrets/`) | `Git.dirty_paths` 427-448 | `test_rename_out_of_scope_into_scope_is_contained` 443; `test_secret_in_a_file_git_would_quote_is_caught` 623 | Split por `\0`, mesmo parser; **não** usar `--porcelain=v2` nem saída citada | Médio: bug clássico de porte (nomes com espaço/UTF-8) |
| 23 | **`contain`: precedência segurança > escopo**; segredo e caminho sensível param o lote antes de qualquer commit | `Policy.check_containment` 702-717; `Runtime.contain` 1610-1648 (stop 1640-1641) | `test_secret_in_diff_stops_batch` 959; `test_sensitive_path_stops_batch` 968; `test_secret_with_scope_violation_still_stops` 452 | Igual; regexes de `SECRET_PATTERNS` 84-91 portadas literalmente | Médio: diferenças de regex Python↔JS em `\b` e classes Unicode |
| I24 | **Varredura de segredo no diff integral e nos bytes de cada arquivo** (binário incluso), sem o teto `max_diff_bytes` | `Runtime.contain` 1615-1629 (diff com limite `1<<31`, leitura `latin-1`) | `test_secret_beyond_the_pack_diff_cap_is_still_caught` 401; `test_secret_inside_a_binary_file_is_caught` 560 | `readFileSync(p).toString('latin1')` | Baixo |
| I25 | **Violação de escopo restaura a árvore** para a árvore do início da rodada; segunda ocorrência estaciona | `Runtime.contain` 1642-1648; `failure` 1791-1793 | `test_scope_expansion_restores_tree_then_parks_on_repeat` 945 | Igual | Baixo |
| I26 | **"Maker não mudou nada" é falha semântica**, não sucesso | `Runtime.contain` 1633-1638 | coberto por `test_scope_expansion...` e pelos casos de rework | Igual | Baixo |
| I27 | **Guarda de `HEAD`/branch em torno de toda `model_call`**: worker que move `HEAD` → `state_integrity` → para o lote | `Runtime.step` 1297 + 1305-1307 | `test_worker_that_moves_head_stops_the_batch` 319 | Igual | Baixo |
| I28 | **Checker que edita a árvore** → árvore restaurada + `state_integrity` | `Runtime.review` 1711-1714 | coberto pelo caminho `unexpected_tree_state` | Igual | Baixo |
| I29 | **Árvore suja antes do `prepare` para o lote** (inclusive na branch da unidade) | `Runtime.prepare` 1488-1490 | `test_dirty_tree_before_unit_stops` 1023; `test_pre_existing_dirt_on_the_unit_branch_is_refused` 500 | Igual — mas com worktree por story (§5) a sujeira do operador deixa de bloquear | Baixo |
| I30 | **`stale_branch`**: branch `tl/<lote>/<unidade>` preexistente fora da base → `awaiting_operator` | `Runtime.prepare` 1493-1499 | `test_stale_unit_branch_with_foreign_commits_waits_for_operator` 780 | Igual | Baixo |
| I31 | **Gates rodam sobre a árvore do Maker**; artefato de gate é restaurado e nunca entra na entrega | `Runtime.gates` 1650-1677 (restauração 1658-1661 e 1670-1673) | `test_gate_artifacts_never_reach_the_commit` 303; `test_gate_leftovers_after_crash_are_not_committed` 606 | Igual | Baixo |
| I32 | **Cache de gate por árvore**, invalidado por mudança de `argv` (o `argv` entra no intent) | `Runtime.gates` 1666-1667 (step id `gate:<id>:<tree>`) | `test_changed_gate_command_is_not_served_from_cache` 510; `test_gate_placeholders_and_script_name_matching` 373 | Igual | Baixo |
| I33 | **Commit só da árvore exatamente revisada**; edição do operador durante parada nunca é commitada | `Runtime.deliver` 1826-1831 | `test_operator_edit_after_review_is_never_committed` 578 | Igual | Baixo |
| I34 | **"Nada a commitar" nunca adota `HEAD`** (`commit_ambiguous`) | `Runtime.deliver` 1836-1838 | `test_branch_amended_after_journaled_commit_is_not_delivered` 839 | Igual | Baixo |
| I35 | **Push fixado por refspec `<commit>:refs/heads/<branch>`**; branch apontando para outro commit → nada é enviado | `Runtime.deliver` 1865-1878 | `test_branch_repointed_during_interrupted_push_is_not_pushed` 826; `test_push_that_errors_after_landing_is_not_repeated` 687 | Igual | Baixo |
| I36 | **Erro do `git push` não prova falha**: consulta o remoto antes de decidir | `Runtime.deliver` 1872-1878 | `test_push_that_errors_after_landing_is_not_repeated` 687 — **é o único caso skipado no Windows** (§0) | Igual; no porte TS o shim vira `node shim.js` e o caso passa a rodar nos dois sistemas | Médio: hoje este invariante **não tem cobertura executada no Windows** |
| I37 | **PR: adoção só com base e head exatos**, nunca duplica | `Runtime.deliver` 1897-1913 | `test_foreign_pr_on_the_branch_is_not_adopted` 594 | Igual | Baixo |
| I38 | **Merge remoto com `--match-head-commit` + revalidação terminal `MERGED`**; sucesso de enfileiramento não é merge | `Runtime.deliver` 1946-1980 | `test_pr_merge_is_pinned_to_the_reviewed_commit` 422; `test_retargeted_pr_is_not_merged` 630; `test_pr_retargeted_between_check_and_merge_is_reported` 717; `test_merge_queue_success_reply_is_not_a_merge` 728 | Igual | Médio: depende do formato JSON do `gh`; fixar `--json state,mergedAt,headRefOid,baseRefName` |
| I39 | **Merge local só se a branch ainda aponta para o commit revisado**; conflito → `merge --abort` + `awaiting_operator` | `Runtime.deliver` 1990-2002 | `test_local_merge_refuses_a_branch_that_moved_after_review` 409 | Igual | Baixo |
| I40 | **Merge remoto exige CI `success`** quando CI está ativa | `Runtime.deliver` 1945-1947 | `test_ci_code_failure_is_sliced_reworked_and_merged` 1199 | Igual | Baixo |
| I41 | **Detector de loop por assinatura normalizada** (`loop_threshold`), **oscilação A→B→A** e **estagnação** (mesmos achados do Checker) — nunca zera com troca de modelo | `Runtime.failure` 1765-1787; `normalize_signature` 213-214 → `tl_ci_slice.normalize` 62-69 | `test_loop_detector_parks_on_repeated_gate_signature` 253; `test_diff_oscillation_parks` 265; `test_same_findings_twice_is_stagnation` 229 | Portar as 5 regex de normalização literalmente (`_TIMESTAMP`, `_TIME`, `_HEX`, `_PATH`, `_NUM`) | Médio: assinatura diferente = detector inútil sem falhar nenhum teste óbvio |
| I42 | **Classes de falha fechadas** (11) e **movimentos determinísticos** (`retry`/`rework`/`park`/`stop`); `STOP_CLASSES` param o lote | 50-54; `classify_dispatch` 969-1010; `Runtime.failure` 1774-1800 | `test_harness_crash_retries_once_then_parks` 1044; `test_transient_failure_retries_with_backoff_then_succeeds` 1068; `test_maker_blocked_on_authorization_stops_batch` 1077; `test_rework_exhaustion_parks_unit_and_blocks_dependent` 216 | Igual; regexes `_TRANSIENT` 93 e `_ENVIRONMENT` 94 literais | Médio: `_ENVIRONMENT` casa mensagens em português/Windows (`"não pode encontrar o arquivo"`, `WinError [23]`) — manter |
| I43 | **`unknown` leva a `park`, nunca a tentativa cega** | `Runtime.failure` 1799-1800 | `test_ci_rerun_without_permission_parks_without_touching_ci` 1237 | Igual | Baixo |
| I44 | **Orçamento com reserva** (Maker + Checker) antes de começar a unidade; resultado já gravado não é cobrado de novo | `check_budget` 1334-1350; `_calls_needed` 1329-1332; `execute_unit` 1437-1438 | `test_budget_reserve_stops_before_an_unverifiable_unit` 1013; `test_resume_after_commit_does_not_reserve_new_calls` 489 | Igual | Baixo |
| I45 | **Teto em dólar só sobre custo observado**; uso não observado é `unknown` e nunca vira estimativa | `check_budget` 1346-1350; `parse_usage` 832-879; `_usage_totals` 2212-2226 | `test_zero_cost_cap_is_enforced_on_observed_cost` 522; `test_usage_parsers_never_invent` 1312 | Igual; parsers `claude_json`/`codex_jsonl` viram os adapters da ADE | Médio: formato de saída das CLIs muda; fixtures obrigatórias |
| I46 | **Relógio de parede do lote** (`max_wall_clock_seconds`) medido a partir do primeiro evento do journal | `check_budget` 1341-1345 | indireto | Igual | Baixo |
| I47 | **`max_parked_units` para o lote** | `execute_unit` 1452-1454 | `test_rework_exhaustion_parks_unit_and_blocks_dependent` 216 | Igual | Baixo |
| I48 | **`runtime_stamp` = `<versão>:<digest da config>`**; intenção aberta de outra versão para o lote até `--accept-stale-version` | `Runtime.__init__` 1206; `reconcile` 2056-2060; `_version_accepted` 2095-2096 | `test_stale_runtime_version_stops_until_accepted` 1179 | Igual | Baixo |
| I49 | **Ambiente filtrado do worker** (allowlist base + `env_allowlist`, `DO_NOT_TRACK=1`) | `ENV_BASE_ALLOWLIST` 78-82; `Policy.worker_env` 695-700 | `test_worker_env_is_scrubbed` 186 | Igual; passar `env` explícito no `spawn`, **nunca** herdar `process.env` | Médio: em Node é fácil vazar `process.env` inteiro por omissão |
| I50 | **Hooks do repositório desligados** dentro dos comandos git do runtime (`core.hooksPath` para diretório vazio via `GIT_CONFIG_COUNT/KEY/VALUE`) | `Runtime.__init__` 1190-1197 | `test_repository_hooks_do_not_run_inside_runtime_git_commands` 867 | **Melhorar no porte**: passar as três variáveis no `env` de cada `execFile` do git em vez de mutar `process.env` global (hoje o Python muta o ambiente do processo) | Baixo |
| I51 | **Independência de família Maker ≠ Checker**, recusa `required_checker_independence_unavailable` | `load_runtime_config` 1544-1546 | `test_same_family_review_is_refused` 1003 | Igual | Baixo |
| I52 | **Adapter sem `tools_allowlist` nem `network_sandbox` exige `accept_unisolated_worker`** | `load_runtime_config` 1547-1551 | `test_unisolated_adapter_needs_explicit_acceptance` 311 | Igual | Baixo |
| I53 | **`immutable_digest` do `frozen_scope`** obrigatório; divergência = `unexpected_revision_drift` | `load_batch` 613-619; `frozen_scope_digest` 630-632 | `test_missing_immutable_digest_is_refused` 393 | Igual (com canonicalizador de I02) | Baixo |
| I54 | **`spec_revision` = SHA-256 do arquivo de spec** (64/16/12 hex); drift recusa antes de rodar | `load_unit` 668-672 | `test_spec_drift_and_scope_drift_are_refused` 990 | Igual | Baixo |
| I55 | **`permitted_effects` governa todo efeito externo**; `local_write: false` recusa o lote | `load_batch` 592-604; `Policy.effect_allowed` 692-693 | `test_local_write_false_is_refused_before_any_dispatch` 387; `test_unauthorized_push_is_never_attempted` 982; `test_non_boolean_optional_effects_are_refused` 437 | Igual | Baixo |
| I56 | **Trabalho aprovado sem `local_commit` vai para `awaiting_operator`, nunca `completed`** | `Runtime.deliver` 1819-1823 | `test_approved_work_without_local_commit_is_handed_to_the_operator` 929 | Igual | Baixo |
| I57 | **Scheduler determinístico**: primeira unidade em ordem topológica (desempate por id), com dependências `completed` | `topological` 1126-1146; `next_ready` 1148-1171 | `test_batch_runs_two_dependent_units_and_closes` 150; `test_continue_independent_after_block_runs_unrelated_unit` 241 | Igual; **muda** para N>1 (§5) | Médio |
| I58 | **Ciclo de dependências recusado** (exit 2) | `topological` 1131-1133 | indireto (`load_batch` 606-609 recusa dep fora do lote) | Igual | Baixo |
| I59 | **Redação de segredos em todo pack** (`[REDACTED:...]`), inclusive saída de gate e fatia de CI; `redactions` no manifesto | `redact_secrets` 217-224; `ContextCompiler.build` 826-828 | `test_gate_output_secret_is_redacted_from_packs` 567 | Igual | Baixo |
| I60 | **Worktree linkado suportado** (`.git` como arquivo) via `rev-parse --git-path` | `Git.git_path` 403-409 | `test_linked_worktree_is_supported` 349 | Igual — **pré-requisito do N>1** | Baixo |
| I61 | **Lote `stopped` nunca reabre**; `blocked` só por decisão reabre no próximo `run` | `main` (decide) 2452-2456; `Runtime.stop` 1384-1393 | `test_intent_gap_for_human_awaits_operator_and_decide_resumes` 273 | Igual | Baixo |
| I62 | **Gates canônicos no CLOSE** sobre a árvore de `HEAD`, com restauração de sobras | `Runtime.close` 1395-1416 (gates canônicos 1403-1412) | indireto (`test_batch_runs_two_dependent_units_and_closes` 150) | Igual | Baixo |
| I63 | **CI: fatia determinística, rerun só de infraestrutura sem teste falho e só com `ci_rerun`**; vermelho nunca é chamado de flaky | `ci_loop` 2007-2049; `tl_ci_slice.slice_log` | `test_ci_code_failure_is_sliced_reworked_and_merged` 1199; `test_ci_infrastructure_failure_reruns_once_then_parks` 1222; `test_ci_rerun_without_permission_parks_without_touching_ci` 1237 | Igual | Baixo |
| I64 | **Contenção da árvore de processos do worker** (POSIX: `setsid` + `killpg`; Windows: Job Object com kill-on-close) | `tl_job.py` 968-1000 (POSIX), 1083-1180 (Job Object) | suíte do `tl_job` (fora de `test_tl_runtime.py`) | **Não existe equivalente em Node core**: `child.kill()` não mata netos. Precisa de Job Object (Windows) / `setsid`+`killpg` (POSIX) por binding próprio ou dependência dedicada. **Não assumir que o `node-pty` resolve**: busca de código em `microsoft/node-pty` por `AssignProcessToJobObject`/`CREATE_SUSPENDED` não retornou ocorrências (2026-09-16) — tratar como não verificado e medir antes de confiar [hipótese] | **Alto**: sem isso, timeout deixa `claude`/`codex` rodando e escrevendo na árvore depois do "fim" da chamada |
| I65 | **Recibo durável da chamada** (estado `starting/running/exited/timeout/crashed/start_failed` em disco, consultável por outro processo) | `tl_job.py` `TERMINAL_STATES` 95; `Harness.dispatch` 913-944 / `inspect` 946-953 | `test_crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` 1102 | Reimplementar em TS (arquivo de estado por chamada, escrito antes do spawn e no fim) | **Alto**: é o que torna I09 possível |
| I66 | **Executável resolvido por caminho absoluto** (shims do Windows: `claude.cmd`, `gh.exe`) | `resolve_executable` 97-101 (`shutil.which`) | indireto | **Muda**: `.cmd`/`.bat` **não são executáveis via `execFile`/`spawn` sem shell no Windows** [verificado: nodejs.org/api/child_process.html]. Usar `spawn('cmd.exe', ['/c', <caminho>, ...args])`; `spawn(..., {shell:true})` está sob DEP0190 | **Alto**: `claude` resolve para `claude.cmd` nesta máquina — quebra direto no dia 1 |

### 1.2 Notas de porte que não cabem na tabela

- **`{pack_text}` não cabe no Windows.** O adapter `codex` de referência passa o pack inteiro como
  argumento (`"{pack_text}"`, RUNTIME.md §Configuração) e `max_pack_bytes` tem default **60 000**
  (`DEFAULT_LIMITS` 71). O limite de `lpCommandLine` do `CreateProcessW` é **32 767 caracteres**
  [verificado: learn.microsoft.com/CreateProcessW]. A ADE deve usar **sempre `{pack_path}`** (arquivo) e,
  se mantiver `{pack_text}`, validar `len(pack) + len(argv) < 30 000` no `ade doctor`. [verificado: código + docs MS]
- **Atomicidade de projeções.** `write_json_atomic` (144-146) → `tl_job.write_atomic` (`tl_job.py` 516-529):
  tmp + `fsync` + `os.replace`. Em Node: `fs.writeFileSync(tmp)` + `fsyncSync` + `fs.renameSync`
  (libuv usa `MoveFileEx` com `REPLACE_EXISTING` no Windows). [inferido]
- **`os._exit(70)` como injeção de falha** (`_fault_point` 1255-1262) é o que torna os 14 testes de crash
  possíveis sem mock. Em Node: `process.exit(70)` **não** basta (buffers pendentes); usar
  `process.kill(process.pid,'SIGKILL')` ou `process.abort()`, e garantir que toda escrita do journal já
  tenha passado por `fsyncSync`. [inferido]
- **`maxBuffer` mata a varredura de segredo.** `Runtime.contain` 1615-1617 pede o diff com limite
  `1 << 31` de propósito (o teto `max_diff_bytes` vale só para o pack do Checker — I24). Em Node, o default
  de `maxBuffer` do `execFile`/`exec` é **1 MiB** e, *"If exceeded, the child process is terminated and any
  output is truncated"* [verificado: nodejs.org/api/child_process.html]. Com o default, um diff grande
  passaria pela varredura **truncado** — falha silenciosa num invariante de segurança. Todo `execFile` de
  git do porte precisa de `maxBuffer` explícito (ou stream), e o `contain` precisa tratar truncagem como
  `unexpected_tree_state`, exatamente como o Python faz em 1616-1617.
- **Timezone/formato de data.** `now_iso` 114-115 usa `time.gmtime` e `%Y-%m-%dT%H:%M:%SZ` (segundos, UTC);
  `check_budget` faz o parse de volta com `calendar.timegm` (1342-1344). Em TS use
  `new Date().toISOString().replace(/\.\d{3}Z$/,'Z')` para manter o formato exato — milissegundos
  quebram o parser. [verificado: código]

---

## 2. O que é específico do método documental tl-orchestrator

| Item | Onde | Veredito na ADE |
| :--- | :--- | :--- |
| `_tl-orc/` como raiz de estado (`STATE_DIR_NAME = "_tl-orc/runtime"`, linha 42) | 42-43, 1187 | **Generalizar** para `<repo>/.ade/lotes/<id>/` (spec v2 §6). Manter a regra de acrescentar ao `.git/info/exclude` (`ensure_exclude` 504-511) |
| `tasks_dir` + resolução `T042` → `_tl-orc/project/tasks/T042*.md` | `load_unit` 652-660; config 574 | **Morre.** Na ADE o plano gera a story; o "spec file" é um objeto do `plan.json`, não um `.md` a descobrir por glob |
| Parser de frontmatter YAML (subset) | `parse_frontmatter` 170-197; `_scalar` 199-211 | **Morre.** Story vem tipada do `plan.schema.json` |
| `scope_paths` / `do_not_touch` / `flags` / `type` / `acceptance` / `verification` como frontmatter | `load_unit` 662-681 | **Generalizar**: viram campos da story no plano. `flags` vira a lista de gates extras (`visual`, `migration`); `acceptance`/`verification` viram o **eval obrigatório** (spec §7) |
| `Unit.kind` | 646, 676 | **Morre** — declarado e nunca usado (`grep "\.kind"` = 0 usos no runtime) |
| `integration_group` / `integration_groups` / `major_boundaries` | 641, 674; `batch.schema.json` | **Morre** — armazenado e nunca usado pelo runtime. Reaparece como *design input* da concorrência (§5) |
| `advisor_policy`, `max_advisor_calls`, `consumed_advisor_calls`, `advisor-result.schema.json`, `prompts/advisor.md` | `batch.schema.json` 128-163 | **Morre.** Spec v2 §12: "Sem advisor nativo; a segunda opinião é o Checker de outra família" |
| `stop_conditions` com exatamente 18 strings | `batch.schema.json` (`minItems: 18, maxItems: 18`) | **Morre** — ritual documental. O runtime tem as suas constantes (50-59) e nunca lê o array |
| Projeção das seções mutáveis do lote (`budget`/`execution` reescritas no arquivo do lote) | `project_batch` 2249-2274 | **Morre.** Existe só para uma sessão de Orquestrador ler consumo no `.md`. A ADE tem painel + índice SQLite |
| `report.md` "relatório da manhã" com 13 seções em inglês | `render_report` 2276-2352 | **Generalizar/adiar.** As seções são a taxonomia certa de eventos; o veículo passa a ser o painel. Manter `ade report` como projeção secundária (backlog) |
| `notify_argv` | 577, 2361-2372 | **Morre** — substituído por WebSocket do painel + notificação de SO (spec §6) |
| `price_table` | 579 | **Morre** — declarado, nunca usado |
| `permitted_effects.tag` / `.release` | validados em `load_batch` 593, **nunca consultados** | **Morre.** Nenhum `effect_allowed("tag"|"release")` existe no runtime (grep: 0 ocorrências) |
| `_resolve_pending_verification` — casa a string portuguesa `verificacao_pendente` do prompt do Checker com um gate verde | 1741-1760 | **Morre como implementação, sobrevive como regra.** Na ADE a seção `runtime_verification` do pack (já existente, 812-814) mais um campo estruturado no `review-result` substituem o casamento por string |
| `prompts/` do método (`orchestrator.md`, `orchestrator-playbook.md`, `planner.md`, `classifier.md`, `searcher.md`, `advisor.md`) | `prompts_dir` 576; `ContextCompiler._prompt` 731-741 | **Morre.** Só `maker.md` e `checker-report-only.md` têm equivalente (contratos de papel da ADE), reescritos |
| `tl_supervisor.py`: board markdown (`update_task_status_atomic`, `BOARD_ENTRY_PATTERN`), `_valid_story_id` | 33, 114-121, 503-557 | **Morre** — estado em tabela markdown é o método documental puro |
| `tl_supervisor.py`: pool de worktrees, `claim_scope`, fila de merge | 133-205, 238-279, 330-454 | **Sobrevive como projeto**, não como código: é o esqueleto do N>1 (§5). Hoje **nada disso é usado pelo runtime** (`grep tl_supervisor scripts/tl_runtime.py` = 0) |
| `context_ledger.py`, `context_lib.py`, `resume_generate.py`, `audit_lineage.py`, `tl_graft.py`, `tl_tools.py`, `workflow_quality.py`, `validate_*.py` | `scripts/` | **Morrem** na v1. São instrumentação do método; a ADE mede bytes de pack + uso do adapter (RUNTIME.md §Context Pack) e usa Graft como ferramenta, não como este porte |

---

## 3. Schemas: literal, muda, morre

### 3.1 Veredito por schema

| Schema | Veredito | Detalhe |
| :--- | :--- | :--- |
| `step-journal.schema.json` | **Literal + extensão aditiva** | O envelope (`format_version`, `seq`, `at`, `kind`, `prev`) e os enums `effect_class`, `status` (`ok`/`failed`/`released`/`ambiguous`), `unit_state`, `attempt.class`, `batch_state` são o contrato de durabilidade. Aditivo: a lista de `kind` permanece como está; `effect_class` ganha `human_takeover`, `human_release`, `visual_eval`, `research`, `eval_run` (spec §6); `step_intent` ganha `worktree` (§5) |
| `runtime-config.schema.json` | **Muda** | Sobrevivem `adapters` (argv/placeholders/family/usage_parser/capabilities), `roles`, `gates` (always/by_flag/canonical), `limits` (11 dos 12 campos), `ci`, `base_branch`, `branch_prefix`, `sensitive_paths`, `env_allowlist`, `env_set`, `git_executable`, `gh_executable`, `allow_same_family_review`, `accept_unisolated_worker`. Morrem `tasks_dir`, `prompts_dir`, `price_table`, `notify_argv`. Entram `panel`, `visual`, `research`, `catalog`, `harness`, `evals` (spec §6) |
| `batch.schema.json` | **Morre como envelope; sobrevive em pedaços** | Sobrevivem: `authorization.permitted_effects` (literal, menos `tag`/`release`), `authorization.proposal_digest`/`authorized_at`/`authority_source` (viram o registro de aprovação do resumo, spec §7.6), `frozen_scope.immutable_digest`, `units[].work_ref`/`spec_revision`/`dependencies`, `budget.max_model_calls`/`max_rework_rounds_per_unit`, `continue_independent_after_block`. Morrem: `batch_concurrency`, `advisor_policy`, `integration_groups`, `major_boundaries`, `stop_conditions[18]`, `revision`, `budget.*advisor*`, `execution.*` inteiro (projeção) |
| `review-result.schema.json` | **Muda — e precisa ser decidido, não copiado (ver §3.3)** | **Surpresa/defeito latente:** o schema exige `action_items[].{id,severity,category,target_role,location,problem,evidence,required_action}` e `prompts/checker-report-only.md` manda o Checker seguir *"o schema JSON é a única fonte da estrutura"*; mas o runtime lê `i.get("target")` e `i.get("summary")` (`review` 1728-1738; `_resolve_pending_verification` 1747), campos que **não existem no schema**. `load_result` 1020-1024 repassa `action_items` sem validar. A ADE tem de escolher uma forma e validá-la com `ajv` |
| `context-policy.schema.json` | **Morre** | Manifesto de política de contexto por fase/classe do método documental. Na ADE as seções e tetos do pack são código + `limits` (§6) |
| `context-ledger.schema.json` | **Morre na v1** | 18 campos obrigatórios de telemetria de sessão (turnos, amplificação de recuperação, divergência de telemetria). Depende do `context_ledger.py`, que é justamente o helper com baseline quebrada no Windows (§0). Backlog |
| `classification-result-v3.schema.json` | **Morre** | Matriz fechada de 4 estados para seleção dinâmica de primário, `evaluations[]` por (harness, modelo, effort), `project_priority` com precedência de seletores, pressão de cota. A ADE classifica tamanho + domínios (spec §7.1) e roteia por `harness.capabilities` (§13). Sobrevive **uma** ideia: empate → `awaiting_operator`, nunca desempate oculto |
| `resume-manifest.schema.json`, `ambiguity-register.schema.json`, `knowledge-profile.schema.json`, `runtime-proof.schema.json`, `skill-evaluation-result.schema.json`, `advisor-result.schema.json`, `classification-result.schema.json` (v2) | **Morrem** | Artefatos do método documental; nenhum é lido por `tl_runtime.py` |

### 3.2 Conjunto mínimo proposto para a ADE v1 (7 schemas)

1. `journal-event.schema.json` — porte de `step-journal.schema.json` + classes novas. **Contrato de durabilidade.**
2. `ade-config.schema.json` — porte de `runtime-config.schema.json` + `panel`/`visual`/`research`/`catalog`/`harness`/`evals`.
3. `plan.schema.json` — **novo**: epics → stories (`id`, `title`, `spec`, `scope_paths`, `do_not_touch`,
   `dependencies`, `gates[]`, `evals[]` (obrigatório, ≥1), `skills[]`, `family`), mais
   `approval` (`digest`, `approved_at`, `permitted_effects`) e `budget`. Substitui `batch.schema.json`.
4. `unit-result.schema.json` — porte da lista fechada do Maker (`tl_job.RESULT_FIELDS` 45: `outcome`,
   `decision`, `blockers`, `next_action`, `observable_usage`, `proof_refs`; `OUTCOMES` 46).
5. `review-result.schema.json` — forma **única** decidida (recomendação: a forma rica do schema atual,
   porque `severity`/`location`/`evidence` são o que o painel mostra, com `target_role` mantido e
   `summary` derivado de `problem`), validada com `ajv` na entrada.
6. `visual-eval.schema.json` — **novo** (spec §10.4).
7. `research-finding.schema.json` — **novo** (spec §8).

Tudo o mais é projeção (status, índice SQLite, relatório) e não precisa de schema publicado.

### 3.3 O defeito latente do `review-result` (a ADE não pode herdá-lo)

Consequências se um Checker real seguir o schema (`target_role`, `problem`, `required_action`) em vez da
forma que o runtime lê (`target`, `summary`):

1. `human = [i for i in items if i.get("target") == "human" ...]` (1728) nunca casa → **`intent_gap`
   dirigido a humano nunca escalona**; a unidade entra em rework em vez de `awaiting_operator`.
2. `findings_digest = sha256(sorted(i.get("summary","")))` (1732) vira o digest de strings vazias →
   **idêntico em toda rodada** → `stagnation` dispara na segunda rodada mesmo com achados diferentes
   (`failure` 1770-1771).
3. `_resolve_pending_verification` (1747) nunca resolve nada.

Os testes não pegam isso porque o fixture emite a forma não-schema
(`test_tl_runtime.py` 384-385: `{"id": "R1", "target": "human", "category": "intent_gap", "summary": ...}`).
Na ADE: **um** schema, validado com `ajv` na leitura do result file, e o engine lendo exatamente os
campos que o schema declara. Recomendação: manter a forma rica (`severity`, `location`, `evidence`,
`target_role`, `problem`, `required_action`) porque é o que o painel mostra, e derivar `summary`
de `problem` no código. [verificado: código + prompt]

---

## 4. Candidatos YAGNI (cortes para a v1, com o risco de durabilidade avaliado)

| Corte | Justificativa | Risco de perder durabilidade |
| :--- | :--- | :--- |
| `project_batch` (2249-2274) — reescrita das seções mutáveis do arquivo do lote | Existe para um leitor humano do método documental. O journal é o estado de registro (docstring 11-15) | **Nenhum.** É projeção pura; `_project` 2354-2358 já a envolve em `suppress(Refusal, OSError)` |
| `render_report` (2276-2352) na v1 | 77 linhas de markdown que o painel substitui com mais informação | **Nenhum.** Reconstruível do journal a qualquer momento |
| `notify_argv` (2361-2372) | Painel + notificação de SO cobrem | Nenhum |
| `price_table`, `permitted_effects.tag`, `permitted_effects.release`, `Unit.kind`, `integration_group` | Declarados e nunca consultados no runtime | Nenhum (código morto hoje) |
| `advisor_policy` inteiro | Nunca despachado pelo runtime (RUNTIME.md §Limites conhecidos: "Planner e Advisor não são despachados pelo runtime") | Nenhum |
| `_resolve_pending_verification` (1741-1760) | Casamento por substring em português entre prompt e gate | **Baixo, mas real**: sem substituto, um Checker que pede verificação já executada gera `intent_gap` → `awaiting_operator` falso. Substituir pela seção `runtime_verification` do pack (já existe, 812-814) **antes** de cortar |
| `parse_frontmatter` + `tasks_dir` + `load_unit` por glob | Spec vem do plano, tipada | **Baixo**: perde-se a detecção de drift de spec editada à mão (I54). Mitigar mantendo `spec_revision` = digest do objeto da story serializado |
| `gates.canonical` no CLOSE | Tentação de cortar por simplicidade | **NÃO CORTAR.** 18 linhas (1395-1416) que pegam quebra de integração entre stories que passaram isoladas |
| `--accept-stale-version` (I48) | Tentação de cortar | **NÃO CORTAR.** 6 linhas; evita que uma versão nova reconcilie uma intenção que não entende |
| `continue_independent_after_block` | Tentação de fixar em `false` | **NÃO CORTAR.** É a diferença entre "uma story ruim para a noite" e "para só o ramo dela" |
| `flaky_reruns` / `ci_rerun` | CI opcional na v1 | Nenhum se `ci.enabled: false` for o default (já é, 563) |
| `tl_ci_slice.py` (181 linhas) | Tentação de cortar junto com a CI | **NÃO CORTAR.** `normalize`/`signature` (62-73) são a assinatura normalizada do **detector de loop** (I41), usada mesmo com CI desligada (`normalize_signature` 213-214). O fatiador em si não tem nada do método documental: porta 1:1 |
| `env_set` | 1 linha | Manter (custo zero) |
| `tl_job.py` inteiro | 2562 linhas de contenção de processo | **NÃO CORTAR o conceito** (I64/I65). Cortar o *código Python* e reimplementar o mínimo em TS: recibo em disco + Job Object/`setsid`. Sem isso, `model_call` não é reconciliável e um timeout deixa o agente escrevendo na árvore |
| `context_ledger.py` / `context-ledger.schema.json` / `resume_generate.py` / `audit_lineage.py` | Instrumentação do método; baseline quebrada no Windows | Nenhum |
| `ContextCompiler._related_tests` (743-754) | `rglob("*")` por scope path **a cada despacho**, heurística `"test" in name` | Nenhum de durabilidade; é custo. Substituir por consulta ao Graft (spec §12) ou índice em cache |

---

## 5. Concorrência: o que trava N>1 hoje e o que muda

### 5.1 O que impede worktrees paralelas hoje

Nota: **`tl_supervisor.py` não é usado pelo runtime.** `grep tl_supervisor scripts/tl_runtime.py` = 0 ocorrências;
o único importador é `scripts/tl_run_story.py`. O supervisor tem as primitivas de concorrência
(`acquire_worktree_slot` 133-176, `release_worktree_slot` 178-205, `claim_scope`/`_paths_overlap` 219-262,
`enqueue_merge`/`advance_merge_queue` 330-454, `sweep_orphan_worktrees` 464-501 com heartbeat), mas o
runtime durável nunca as chama. [verificado: código]

Travas reais, em ordem de dificuldade:

1. **Recusa explícita**: `load_batch` 611-612 — `batch_concurrency != 1` é `Refusal` exit 2. (trivial)
2. **Laço sequencial**: `Runtime.run` 1353-1382 chama `execute_unit(uid)` de forma bloqueante, uma unidade
   por iteração; `next_ready` 1148-1171 devolve **uma** unidade. (fácil)
3. **Uma única árvore de trabalho**: `self.repo` é um caminho só. `prepare` faz `git checkout -b` nela
   (1500-1503), `contain` lê `git status` dela (1612), `worktree_tree` 450-473 usa o índice dela,
   `_leave_branch` 1473-1478 volta para a base, `restore` 1458-1464 mexe nela. **Duas unidades na mesma
   árvore são impossíveis.** (é o trabalho real)
4. **Guarda de árvore suja global**: `prepare` 1488-1490 para o lote se a árvore estiver suja — com N
   unidades numa árvore só, isso dispara o tempo todo.
5. **Encadeamento de dependência por branch**: `base_ref` 1480-1485 usa a branch da última dependência não
   mesclada e `prepare` 1504-1510 faz `git merge` dela na branch da unidade. Isso pressupõe ordem.
6. **`local_merge` na base compartilhada**: 1990-2005 faz `checkout base` + `merge` na mesma árvore.
7. **Lease único por lote**: `acquire` 1222-1226. (não é problema — ver 5.2)

### 5.2 O que muda no journal e no scheduler para N>1

- **Journal: nada muda no formato, tudo muda na disciplina de escrita.** Continua **um escritor**:
  em Node, N unidades são N tarefas assíncronas no mesmo processo, e todo `append` passa por uma fila
  serializada. A cadeia de hash (I02) continua sendo a ordem total de eventos; `seq` continua monotônico.
  Não há necessidade de journal por unidade nem de SQLite como estado de registro. [inferido]
- **Aditivos no evento**: `step_intent` ganha `worktree` (caminho) e `unit_state` ganha `worktree`, para
  que a reconciliação saiba **onde** olhar a árvore. Sem isso, `tree_before`/`tree_after` ficam ambíguos.
- **`Git` deixa de ser singleton**: uma instância por worktree (`git -C <wt>`), com `GIT_INDEX_FILE`
  próprio em `worktree_tree`. `Git.git_path` 403-409 já resolve worktree linkado (I60, teste linha 349),
  então a base existe.
- **Scheduler devolve um conjunto**: `next_ready` passa a retornar até `N` unidades topologicamente
  prontas com **`scope_paths` disjuntos** (a regra de `_paths_overlap` do supervisor, 219-221) e reserva
  de orçamento para todas (`check_budget` já conta intenções abertas: `model_calls_consumed` 1326-1327).
- **Integração serializada**: `commit`/`push`/`pull_request` são por branch e já são seguros em paralelo
  (cada step é fixado ao commit revisado — I35, I37, I38). **`local_merge` e o merge de PR na base
  precisam de fila** (uma integração por vez), porque ambos movem a ponta compartilhada. O
  `advance_merge_queue` do supervisor (372-454) é o desenho pronto; na ADE vira um mutex sobre a base +
  regravação do `base_before` no `intent_context` (I17) a cada tentativa.
- **Reconciliação não muda por classe**, porque toda evidência já é local à unidade (branch, commit, PR).
  As duas exceções ficam cobertas: `local_merge` pela fila acima; `prepare` porque a árvore da unidade
  passa a ser exclusiva (a guarda de árvore suja vira per-worktree e **deixa de ser um bloqueio global**
  — ganho colateral: o operador pode editar o repositório sem parar o lote).
- **Dependência não mesclada**: com worktrees, `base_ref` 1480-1485 continua válido (a branch da
  dependência existe); o `git merge` de `prepare` 1504-1510 roda dentro do worktree da unidade. Novo modo
  de falha: duas irmãs com `scope_paths` disjuntos podem ainda conflitar em arquivo compartilhado
  (lockfile, `package.json`) — a fila de integração precisa rodar os gates da unidade **depois** da
  integração, não só antes. [inferido]
- **Limpeza de órfãos**: crash com N worktrees deixa N diretórios. Precisa de
  `sweep_orphan_worktrees`-equivalente com heartbeat (supervisor 456-501) + `git worktree prune`.
- **Gate cache continua correto e fica melhor**: a chave é `gate:<id>:<tree>` (I32), global por árvore;
  duas unidades que chegam à mesma árvore reusam o resultado. Pressupõe gate hermético — já pressupunha.

---

## 6. Context Pack compiler: como funciona e o que a ADE mantém

`ContextCompiler` 722-830. Um pack por despacho, escrito em `state_dir/packs/<step_id>.md` e passado ao
adapter por `{pack_path}`/`{pack_text}` (`Harness.render` 893-911).

**Seções, em ordem fixa** (prefixo cacheável — 756-824):

| # | Seção | Quando | Teto |
| :-- | :--- | :--- | ---: |
| 1 | `contract` | sempre (prompt do papel + digest) | 12 000 |
| 2 | `policy` | sempre (unidade, fase, papel, `scope_paths`, `do_not_touch`, "nunca rode git/gh", `result_file`) | — |
| 3 | `spec` | sempre | 24 000 |
| 4 | `acceptance` | se houver | — |
| 5 | `verification_commands` | se houver | — |
| 6 | `related_tests` | se houver | até 30 caminhos |
| 7 | `open_findings` | só em rework | 8 000 |
| 8 | `gate_failures` | só em rework | 8 000 |
| 9 | `ci_failure` | só após CI vermelha | 6 000 |
| 10 | `checkpoint` | só após ambiguidade | — |
| 11 | `runtime_verification` | Checker, gates já executados | — |
| 12 | `changed_files` + `diff` | Checker | `max_diff_bytes` (200 000) |
| 13 | `task` | sempre (contrato de saída do `result_file`) | — |

**Regras estruturais** (todas a manter):

- **Truncagem com ponteiro**: `add()` 761-767 corta no teto e anexa `"[... truncated, N chars total;
  full content on demand at <ref>]"`. O pack nunca mente sobre o que foi cortado.
- **Teto global** `max_pack_bytes` (60 000): corte em bytes UTF-8 com `decode(..., "ignore")` 820-822.
- **Redação de segredos depois da montagem** (826-828), sobre o pack inteiro — inclusive saída de gate e
  fatia de CI. `redactions` entra no manifesto.
- **Manifesto como evidência**: `{role, unit, phase, sections:[{section, ref, bytes, digest}], bytes,
  digest, redactions}` (829); é gravado como artefato e referenciado em `_evidence` do step
  (`implement` 1599, `review` 1718). O `pack_digest` entra no `intent` (1602, 1720) — **mas não invalida
  um `model_call` já pago** (I06).
- **O que o pack nunca contém**: histórico de conversa, log bruto, o journal, o lote.
  Provado por `test_batch_runs_two_dependent_units_and_closes` 150 (assert de ordem das seções e
  `assertNotIn("journal", ...)`, linhas 179-183).

**O que a ADE mantém, muda e acrescenta:**

- **Mantém literalmente**: ordem fixa das seções, teto por seção com ponteiro, teto global, redação
  pós-montagem, manifesto como evidência do step, `runtime_verification` (evita o Checker reclamar de
  verificação que o engine já rodou), regra "o worker nunca roda git/gh".
- **Muda**: `contract` passa a ser o contrato de papel da ADE (não `prompts/maker.md` do método);
  `spec` vira a story do plano; `acceptance`/`verification_commands` viram a seção **`evals`** (spec §7),
  obrigatória; `related_tests` sai do `rglob` e vem do Graft.
- **Acrescenta** (spec §9, §10, §12): `skills` (até 3 corpos de `SKILL.md`, com teto próprio),
  `graft_context`, `design_guardrails` (stories visuais), `visual_findings` (rodada do loop visual).
  Cada uma precisa de teto próprio **antes** do teto global, senão o corte global come o `task`.
- **Corrige**: `{pack_text}` versus o limite de 32 767 caracteres do Windows (§1.2).

---

## 7. Ordem de porte sugerida (consequência das seções acima)

1. **Primitivas**: canonicalizador JCS, `Journal` (append/read/fold + cadeia), lease, `Git` por worktree
   (incluindo `worktree_tree` com índice racy), `step()` com write-ahead. Testes: I01-I05, I21, I60.
2. **Política e contenção**: `worker_env`, `SECRET_PATTERNS`, `check_containment`, `dirty_paths` com
   rename, `restore`/`checkpoint` em refs. Testes: I19-I26, I49.
3. **Harness**: spawn com recibo durável + Job Object/`setsid`, `resolve_executable` com o caminho
   `cmd.exe /c` para `.cmd`, `parse_usage`. Testes: I07, I09, I45, I64-I66.
4. **Scheduler + falhas**: topológico, `next_ready`, `failure` com detector de loop, orçamento.
   Testes: I41-I44, I57.
5. **Entrega e reconciliação**: commit/push/PR/merge + `_reconcile_one` completo. Testes: I08-I16, I33-I40.
6. **CI** (opcional na v1) e gates canônicos. Testes: I62-I63.

A suíte de paridade é `test_tl_runtime.py` caso a caso, com o mesmo nome em Vitest (spec §15), rodando em
paralelo por worker com tmpdir próprio.

**Contrato das CLIs falsas (porte direto de `scripts/fixtures/runtime/fake_harness.py`)**: um script lê
`<scenario>/<role>.json` (lista de ações), consome a próxima ação e mantém **o contador em disco** — é
isso que faz um reinício do runtime ver a mesma sequência que um harness real veria. Cada ação pode
escrever/apagar arquivos, rodar um `argv` arbitrário (usado para mover `HEAD` e provar I27), emitir
`stdout`/`stderr`, sair com código, ou **não** gravar o result file (`no_result`, que é como se prova
`ambiguous`). O fixture também grava o pack recebido (`<role>-<n>.pack.md`) e o ambiente visto
(`<role>-<n>.env.json`), o que é o que prova I49 e a ordem das seções do pack. A ADE precisa do mesmo
trio: contador durável, `no_result` e captura de pack + env. [verificado: código]

---

## 8. Fontes

Código e documentos primários (lidos integralmente ou nas faixas citadas), commit local de
`E:\Documentos\ProjetosIA\tl-orchestrator-release` em 2026-09-16, versão `0.17.0`:

- `scripts/tl_runtime.py`, `scripts/tl_job.py`, `scripts/tl_supervisor.py`, `scripts/tl_ci_slice.py`
- `scripts/tests/test_tl_runtime.py`, `scripts/fixtures/runtime/{fake_harness.py,fake_gh.py}`
- `docs/RUNTIME.md`, `CHANGELOG.md`, `prompts/maker.md`, `prompts/checker-report-only.md`
- `schemas/{batch,step-journal,runtime-config,review-result,context-ledger,context-policy,classification-result-v3}.schema.json`
- `E:\Documentos\ProjetosIA\TL-ADE\docs\specs\2026-09-16-ade-design.md` (spec v2),
  `E:\Documentos\ProjetosIA\TL-ADE\docs\catalog-sources.md`

Documentação oficial externa:

- Node.js — `child_process`, seção "Spawning `.bat` and `.cmd` files on Windows":
  https://nodejs.org/api/child_process.html
- Node.js — `fs` (`fsyncSync`, opção `flush` de `appendFile` desde v21.1.0/v20.10.0; ausência de flock):
  https://nodejs.org/api/fs.html
- Node.js — Deprecations, DEP0190 (`args` com `shell` em `execFile`/`spawn`):
  https://nodejs.org/api/deprecations.html
- Microsoft Learn — `CreateProcessW`, limite de 32 767 caracteres de `lpCommandLine`:
  https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
- RFC 8785 — JSON Canonicalization Scheme (JCS), ordenação lexicográfica de propriedades e serialização
  de números: https://www.rfc-editor.org/rfc/rfc8785
