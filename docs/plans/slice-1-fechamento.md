# Conferência de fechamento do Slice 1

## Estado

Estado: **fechamento pendente**

Esta conferência usa o conteúdo disponível no repositório e o histórico Git local. Ela não promove
presença de teste a execução, nem observação histórica a validação do commit atual. Também não houve
chamada paga, probe real ou tentativa de corrigir produção durante esta story.

Fontes consultadas: `README.md`, `PROJECT_CHARTER.md`, `docs/roadmap.md` §§1–2,
`docs/plans/slice-1.md` §§3–4 e §7, `docs/operations/dogfood-d1.md`, `tests/**/*.test.ts`, `git log` e
`git show`. Nesta matriz, `não comprovado` significa literalmente que o campo ou a execução exigida
não foi demonstrado por um artefato local rastreável.

Classes de informação:

- **testes encontrados**: o nome existe no código de teste; isso não informa resultado nem sistema;
- **provas executadas**: saída de uma execução identificada por commit, sistema e artefato;
- **registros operacionais**: relato histórico, mantido como parcial quando não contém todos os campos;
- probes reais ficam separados dos testes determinísticos e nunca são inferidos a partir deles.

## Matriz

| criterio | origem | evidencia | commit | sistema | resultado | estado | lacuna |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| S1-01 | slice-1.md §7.1 | docs/operations/dogfood-d1.md | e733575395575c9098ab3a2d195d485ac15ef16f | não comprovado | registro operacional relata story real, eval vermelho/verde, contain e commit local | parcial | manifesto do pack, SO e log executável não constam no registro |
| S1-02 | slice-1.md §7.2 | docs/operations/slice-1-windows.json | 4a3205913adbff1de4ee3729cb43aac90de4a592 | windows | 12/12 células de crash matrix aprovadas no Windows; Linux não comprovado | parcial | faltam 12 células dedicadas e resultados Linux comprovados via CI |
| S1-03 | slice-1.md §7.3 | docs/operations/slice-1-windows.json | 4a3205913adbff1de4ee3729cb43aac90de4a592 | windows | 93/93 testes determinísticos aprovados no Windows; Linux não comprovado | parcial | falta execução Linux comprovada via CI |
| S1-04 | slice-1.md §7.4 | tests/parity/journal.test.ts; tests/parity/lease.test.ts | não comprovado | não comprovado | testes encontrados | não comprovado | faltam execuções que demonstrem exit 2 e exit 5 nos dois SOs |
| S1-05 | slice-1.md §7.5 | docs/operations/dogfood-d1.md | 9a37c9832ce92b085f4eb9aabd6ffb64589ef01a | não comprovado | registro menciona probe Haiku e correção de comando no CI | parcial | faltam saída do doctor, capability-set, prova real de json-schema/session-id e SO |
| S1-06 | slice-1.md §7.6 | tests/contain.test.ts | não comprovado | não comprovado | teste encontrado | não comprovado | faltam canário real por família, recusa de despacho e resultados por SO |
| S1-07 | slice-1.md §7.7 | tests/parity/contain.test.ts | não comprovado | não comprovado | testes encontrados | não comprovado | falta execução do cenário combinado com diff maior que 1 MiB antes do commit |
| S1-08 | slice-1.md §7.8 | docs/operations/dogfood-d1.md | e733575395575c9098ab3a2d195d485ac15ef16f | não comprovado | registro operacional sustenta ADE-D1 e alteração aditiva no journal-event | parcial | falta artefato executável que ligue toda a execução ao SO e ao commit atual |
| S1-09 | slice-1.md §7.9 | docs/operations/dogfood-d1.md | e733575395575c9098ab3a2d195d485ac15ef16f | não comprovado | gates_done vazio; tsc, lint e vitest são relatados como externos ao motor | não comprovado | faltam gates 1–4 e 6–8 verdes no CI Windows/Linux e prova de AGENTS.md ≤ 8 KB |
| RM-COBERTURA | roadmap.md §1; slice-1.md §6 | docs/operations/slice-1-windows.json | 4a3205913adbff1de4ee3729cb43aac90de4a592 | windows | cobertura ≥85% nos 6 módulos duráveis no Windows; Linux não comprovado | parcial | falta cobertura ≥85% comprovada no Linux via CI |
| RM-MEDICAO | roadmap.md §§0–1 | docs/roadmap.md §1 | 9a37c9832ce92b085f4eb9aabd6ffb64589ef01a | não comprovado | registro histórico informa 35.124 linhas, 3 dias e 11.708 linhas portadas por dia | parcial | medição existe, mas falta evidência reproduzível e replanejamento explícito das estimativas |

Nenhuma linha está classificada como `comprovado`. Para receber esse estado, a linha precisa ter
commit hexadecimal completo de 40 caracteres, sistema operacional, resultado executado e referência
rastreável do artefato. A falta de qualquer campo impede a classificação.

### Metadados preservados do D1

Os valores abaixo são transcritos somente de `docs/operations/dogfood-d1.md`; não são generalizados
para os outros critérios:

- evidencias: [docs/operations/dogfood-d1.md]
- commit_base: `9a37c9832ce92b085f4eb9aabd6ffb64589ef01a`
- commit_story: `e733575395575c9098ab3a2d195d485ac15ef16f`
- gates_done: []
- first_source_edit_ms: indisponível
- maker_wall_ms: 20871
- maker_wall_ms não substitui first_source_edit_ms; são métricas diferentes.

`git show` confirma localmente que o primeiro commit altera `src/evals/eval-runner.js` e
`src/gates/command.js`, e que o segundo altera `schemas/journal-event.schema.json`. Isso confirma o
conteúdo dos commits, não reexecuta o dogfood nem comprova Linux.

## Inventário de evals

A união nominal abaixo vem de todos os `V(...)` de §3, da tabela de 12 destaques e da lista portada de
§4. Windows e Linux são colunas separadas. `não comprovado` não quer dizer que o teste falha: quer dizer
que não foi localizado relatório executado, associado a commit, para aquele sistema. O probe real é
identificado na classificação e não entra no alvo determinístico de paridade.

| nome | origem | Windows | Linux | classificação |
| :--- | :--- | :--- | :--- | :--- |
| `additive_strictness_records_warning_and_proceeds` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `agents_md_stays_under_8kb` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `approved_work_without_local_commit_is_handed_to_the_operator` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `branch_amended_after_journaled_commit_is_not_delivered` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `canonicalize_integer_valued_float_matches_js_number_tostring` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `canonicalize_output_byte_identical_to_python_reference_fixture` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `canonicalize_rejects_lone_surrogate` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `changed_gate_command_is_not_served_from_cache` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `claude_adapter_parses_recorded_transcript_into_unit_result` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `contract_with_eval_outside_scope_paths_is_refused` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `crash_after_commit_is_reconciled_without_a_second_commit` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `crash_after_journaled_commit_resumes_with_that_commit` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `crash_before_maker_effect_releases_the_call` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `crash_matrix_resumes_without_repeating_effects` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `dirty_worktree_before_story_stops` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `discarded_tree_is_kept_under_a_ref` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `doctor_falls_back_to_cmd_wrapper_on_unknown_shim_format` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `doctor_resolves_npm_shim_to_real_exe_on_windows` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `eval_born_green_is_rejected` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `excerpt_is_bounded` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `fake_cli_captures_pack_and_env_per_call` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `fake_cli_counter_survives_engine_restart` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `gate_artifacts_never_reach_the_commit` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `gate_leftovers_after_crash_are_not_committed` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `gate_output_secret_is_redacted_from_packs` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `gate_placeholders_and_script_name_matching` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `harness_crash_retries_once_then_parks` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `invalid_journal_line_is_refused` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `isolation_canary_detects_write_outside_worktree` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `journal_hash_chain_detects_tampering` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `lease_is_exclusive` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `lease_is_released_after_holder_crash_without_graceful_unlock` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `linked_worktree_is_supported` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `local_write_false_is_refused_before_any_dispatch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `maker_blocked_on_authorization_stops_batch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `missing_harness_executable_is_environment_and_not_charged` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `non_boolean_optional_effects_are_refused` | §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada; divergência de contagem |
| `pack_sections_are_ordered_and_contain_no_journal` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `path_within_and_secret_scan` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `pre_existing_dirt_on_the_unit_branch_is_refused` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `published_schemas_accept_valid_and_refuse_invalid_fixtures` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `receipt_running_state_is_readable_mid_flight_by_a_cold_process` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `receipt_write_survives_fault_injection_before_fsync` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `receipt_written_before_spawn_is_readable_by_another_process_as_starting` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `reconcile_rejects_pid_reuse_via_fingerprint_mismatch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `rename_out_of_scope_into_scope_is_contained` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `repository_hooks_do_not_run_inside_runtime_git_commands` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `restore_keeps_a_file_ignored_only_by_the_discarded_rules` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `resume_after_commit_does_not_reserve_new_calls` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `resume_after_commit_with_changed_pack_does_not_redispatch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `run_plan_closes_a_real_ade_story_with_claude` | §3 | não comprovado | não comprovado | probe real encontrado; execução atual não comprovada |
| `run_plan_executes_one_trivial_story_to_local_commit` | §3 | não comprovado | não comprovado | teste de paridade encontrado; execução não comprovada |
| `scope_expansion_restores_tree_then_parks_on_repeat` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `secret_beyond_the_pack_diff_cap_is_still_caught` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `secret_in_a_file_git_would_quote_is_caught` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `secret_in_diff_stops_batch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `secret_inside_a_binary_file_is_caught` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `secret_with_scope_violation_still_stops` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `sensitive_path_stops_batch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `session_id_is_preminted_and_journaled_before_spawn` | §3 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `stale_runtime_version_stops_until_accepted` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `stale_unit_branch_with_foreign_commits_waits_for_operator` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `transient_failure_retries_with_backoff_then_succeeds` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `usage_parsers_never_invent` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `worker_env_is_scrubbed` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `worker_that_moves_head_stops_the_batch` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `worktree_tree_sees_a_same_size_rewrite_within_one_second` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `zero_cost_cap_is_enforced_on_observed_cost` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |
| `zero_model_call_budget_is_refused` | §3 e §4 | não comprovado | não comprovado | teste encontrado; execução não comprovada |

### Células normativas de crash

Estas células são obrigações, não resultados. Os identificadores dão nome auditável à combinação; até
existir um teste dedicado e um relatório por SO, o resultado permanece `não comprovado`.

| celula | ator | fase | teste | Windows | Linux |
| :--- | :--- | :--- | :--- | :--- | :--- |
| CR-ENGINE-01 | engine | antes do spawn | não comprovado | não comprovado | não comprovado |
| CR-ENGINE-02 | engine | depois do efeito do Maker | não comprovado | não comprovado | não comprovado |
| CR-ENGINE-03 | engine | antes do contain | não comprovado | não comprovado | não comprovado |
| CR-ENGINE-04 | engine | depois do contain | não comprovado | não comprovado | não comprovado |
| CR-ENGINE-05 | engine | antes do commit | não comprovado | não comprovado | não comprovado |
| CR-ENGINE-06 | engine | depois do commit | não comprovado | não comprovado | não comprovado |
| CR-WORKER-01 | worker | antes do spawn | não comprovado | não comprovado | não comprovado |
| CR-WORKER-02 | worker | depois do efeito do Maker | não comprovado | não comprovado | não comprovado |
| CR-WORKER-03 | worker | antes do contain | não comprovado | não comprovado | não comprovado |
| CR-WORKER-04 | worker | depois do contain | não comprovado | não comprovado | não comprovado |
| CR-WORKER-05 | worker | antes do commit | não comprovado | não comprovado | não comprovado |
| CR-WORKER-06 | worker | depois do commit | não comprovado | não comprovado | não comprovado |

## Divergências

1. A enumeração de §7 tem precedência: as 12 células `engine` e `worker` por seis fases prevalecem. Em
   forma curta, **12 prevalecem sobre 24, 28 e 14** das variantes antigas. Máquina, browser e fases de
   push, PR, merge, takeover e visual não são promovidos para o Slice 1.
2. A aritmética normativa de §4 é **44 + 6 = 50** nomes básicos: os 12 destaques repetem seis portados.
   Contudo, a lista que se apresenta como “44 de 93” contém 45 nomes distintos; a **lista nominal contém 45**,
   pois inclui também `non_boolean_optional_effects_are_refused`. A união literal com os destaques daria
   51, não 50. O nome permanece no inventário e a divergência permanece aberta; nenhum requisito foi
   removido silenciosamente.
3. Os **evals adicionais de §3** permanecem no inventário e no portão mesmo quando não pertencem aos
   50 nomes básicos. Por isso a união nominal completa desta conferência tem 70 nomes.
4. `docs/roadmap.md` §1 chama a tabela de destaques de “12 novos” e ainda acrescenta
   `dispatch_into_open_takeover_is_refused`; `slice-1.md` §4 diz que seis dos 12 são portados. Esta
   conferência segue a fonte normativa do plano e registra a redação divergente do roadmap.
5. A presença de `crash_matrix_resumes_without_repeating_effects` não prova, sozinha, as 12 células
   nomeadas exigidas por §7.2.

## Lacunas

- Não há relatório rastreável do conjunto completo no Windows nem no Linux para o commit atual.
- Não há artefato de cobertura ≥85% dos seis módulos de durabilidade.
- A medição de 11.708 linhas portadas por dia está publicada, mas sua coleta reproduzível e o
  replanejamento explícito das estimativas não estão comprovados.
- Não há 12 testes dedicados e nomeados para todas as células normativas de crash.
- Não há artefato atual de `ade doctor` real com capability-set e provas de json-schema/session-id.
- Não há artefato atual do canário por família nem da recusa de família sem canário.
- Não há execução documentada do cenário combinado de segredo, violação de escopo e diff > 1 MiB.
- O dogfood D1 tem `gates_done` vazio; logo não demonstra os portões obrigatórios dentro do motor.
- O dogfood não registra seu sistema operacional como campo de evidência e não pode provar Linux.
- `first_source_edit_ms` está indisponível; `maker_wall_ms` não pode ser usado como substituto.
- A divergência 44 versus 45 nomes portados precisa ser resolvida na fonte normativa sem retirar o
  nome excedente desta conferência.

Enquanto qualquer uma dessas obrigações estiver ausente, o estado derivado continua
**fechamento pendente**. Isso não declara conclusão da v0.2.
