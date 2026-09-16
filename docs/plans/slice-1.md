# Slice 1 — MVP executável (~3 semanas)

Data: 2026-09-17. Plano do primeiro vertical slice. Arquitetura canônica: `docs/architecture.md`
(§3 componentes, §4 contratos, §6 durabilidade, §7 subsistemas). Evidência: `docs/research/README.md`
(digest #N) e os documentos citados por nome. Nada aqui redefine decisão de arquitetura; objeções
ficam em §9.

**Objetivo único.** `ade run --plan plan.json` executa **uma** story trivial escrita à mão num
repositório real: `lease` → `prepare` em `.ade/wt/<story>` → `eval_run:red` contra `tree_before` →
**uma** chamada `claude -p` com `--session-id` pré-cunhado e `--json-schema` para o `unit-result` →
`contain` + canário de isolamento → `gates` → `eval_run:green` → `local_commit`. Tudo no journal com
write-ahead, retomável após `SIGKILL` em qualquer ponto.

---

## 1. `PROJECT_CHARTER.md` (uma página, na raiz)

Arquivo a criar no commit 1, ~20 linhas, conforme `landscape-dev-workflows.md` §(c) c6.2 (o gate de
escopo do Beads é a única defesa documentada contra agente que amplia superfície).

> **TL-ADE — Charter.** A ADE é um *scheduler durável + compilador de contexto + compilador de
> intenção* local (`architecture.md` §1). Ela **é**: dona do worktree e do processo; dona do journal;
> quem roda `git`/`gh`; quem prova "pronto" por eval executado.
>
> A ADE **não é**: um CI (não roda pipeline de terceiros, não substitui GitHub Actions); um issue
> tracker (não tem backlog próprio, nem board, nem estado de projeto fora da missão); uma IDE (não
> tem editor, não tem LSP); um provedor de modelo (nunca chama API HTTP de modelo; só CLI com
> assinatura); um framework de agentes (não expõe SDK de agente a terceiros).
>
> **Escopo do slice 1.** Uma story `trivial` de um `plan.json` escrito à mão, família `claude`,
> `local_commit` local, zero rede além da própria CLI. **Fora do slice 1, sem exceção:** Intent
> Compiler, entrevista, classificação, Checker, rework, Skill Fabric, FQE, pesquisa, painel, PTY,
> push/PR/merge/CI, N>1, `agy`, SQLite, Playwright, Fastify, WebSocket.
>
> **Regra de ampliação.** Qualquer item da lista "fora" que apareça num diff do slice 1 é motivo de
> rejeição do PR, não de discussão. O caminho é uma linha em `docs/roadmap.md`.
>
> **Regra de cerimônia proporcional** (`landscape-dev-workflows.md` §(c) c2): se o diff cabe numa
> frase, pula plano e brainstorming.

---

## 2. Estrutura do repositório e volume de código

Um pacote (`packages/core`), npm workspaces, TypeScript estrito ESM, Node ≥ 22 (`architecture.md` §
stack). Estimativa de linhas **de produção** (`[hipotese]`, calibrada pelo volume do runtime de
referência: `tl_runtime.py` 2.470 linhas + `tl_job.py` 2.562 cobrem push/PR/merge/CI que o slice 1
não tem — `runtime-port-map.md` cabeçalho).

| Caminho | Conteúdo | LOC | Invariantes |
| :--- | :--- | ---: | :--- |
| `packages/core/src/journal/` | `canonical.ts` (wrapper `canonicalize` + `digest16`), `journal.ts` (append/read/fold, `prev`, fd aberto + `fsyncSync`) | 180 | I02, I03, I05 |
| `packages/core/src/step/` | `step.ts` (write-ahead, `input_digest`, `intent_context`, fila serializada), `reconcile.ts` (tabela por `effect_class`) | 260 | I01, I05–I09, I17, I48 |
| `packages/core/src/lease/` | `lease.ts` (`mkdir` + heartbeat 2 s + TTL 6 s + fingerprint pid/start-time; exit 5) | 70 | I04 |
| `packages/core/src/git/` | `gitport.ts` (instância por worktree, `worktree_tree` com índice racy, `dirty_paths -z`, checkpoint/restore em `refs/ade/`, `GIT_CONFIG_COUNT` por chamada) | 240 | I10, I18–I22, I29, I30, I50, I60 |
| `packages/core/src/runner/` | `spawn.ts` (env explícito, recibo durável, `taskkill /T /F`), `receipt.ts`, `resolve-binary.ts` | 230 | I07, I49, I64–I66 |
| `packages/core/src/contain/` | `contain.ts` (precedência segurança > sensíveis > escopo, `maxBuffer` explícito), `secrets.ts`, `canary.ts` | 160 | I23–I26 |
| `packages/core/src/gates/` | `gates.ts` (cache `gate:<id>:<tree>`, restauração de sobras) | 90 | I31, I32 |
| `packages/core/src/evals/` | `eval-runner.ts` (`phase: red\|green`, `strictness`, evidência) | 110 | novo (C9) |
| `packages/core/src/pack/` | `pack.ts` (5 seções do slice, teto por seção com ponteiro, redação pós-montagem, manifesto), `firewall.ts` (`run(argv) → {rawPath, extract}`) | 140 | I59, C10, C11 |
| `packages/core/src/adapters/claude/` | argv, `--session-id`, `--json-schema`, parser tolerante, `parse_usage` | 130 | I45 |
| `packages/core/src/adapters/fake/` | CLI falsa (§5) | 120 | fixture |
| `packages/core/src/cli/` | `node:util parseArgs`; `ade run --plan`, `ade doctor`, `ade show` | 180 | — |
| `packages/core/src/engine.ts` | ciclo da story, orçamento, `runtime_stamp` | 120 | I27, I44–I48 |
| `schemas/` | 8 arquivos `.schema.json` (§4 da arquitetura); no slice 1 são exercidos `journal-event`, `ade-config`, `plan`, `task-contract`, `eval`, `unit-result`, `capability-set`; `review-result` só validado | — | — |
| `fixtures/` | transcripts gravados, cenários da CLI falsa, vetores JCS (§5) | — | — |
| `packages/core/tests/` | Vitest, um arquivo por módulo + `parity/` com os nomes portados | ~2.500 | §4 |

**Total de produção ≈ 1.900 LOC.** Razão teste:produção alvo ≈ 1,3:1, publicada no corpo do PR
(`landscape-dev-workflows.md` §(c) c3.9; Cloudflare está em 1,9:1).

---

## 3. Stories do slice, como Task Contracts da própria ADE

Formato conforme `architecture.md` §4 (`TaskContract`). `roles` nomeia **família:papel**; o
`model_id` concreto vem do `capability-set` medido por `ade doctor`, nunca fixado à mão
(`architecture.md` §7, roteamento). `checker_round` é `codex` desde S1 (§6). Comando de eval usa
`node node_modules/vitest/vitest.mjs` e **nunca `npx`**: `spawn('npx.cmd')` sem `shell:true` falha
com `EINVAL` no Node 24/Windows (digest #30); o caminho do bin é confirmado por `ade doctor`.
Abreviação: `V(<arquivo>, <nome>)` = `["node","node_modules/vitest/vitest.mjs","run","--reporter=dot","packages/core/tests/<arquivo>","-t","<nome>"]`,
`expect_exit: 0`, `timeout_s: 120`, `max_output_bytes: 65536`, `author: 'operator'`,
`strictness: must_fail_before`, `evidence: ["packages/core/tests/<arquivo>"]`.
Budget padrão: `max_model_calls: 6`, `max_rework_rounds: 2`, `max_usd: 3`; onde difere, está no
cabeçalho da story. Guardrail padrão:
`do_not_touch: [".ade/**","schemas/**","fixtures/transcripts/**",".github/**"]`, `autonomy: 'safe'`,
`sensitive_paths: ["**/*.pem","**/.env*"]`; `scope_paths` abaixo é o que muda por story.
`roles` de todas: `maker: claude`, `checker_round: codex`.

### S1 — esqueleto, portões e charter
`ADE-S1` · `bounded` · `depends_on: []` · 0,5 dia · budget 4/1/US$ 2
**task**: workspace npm, `tsconfig` estrito ESM, Vitest, oxlint com `dmmulroy/anti-slop` pinado por SHA,
CI Windows + Linux, `AGENTS.md` ≤ 8 KB, `CLAUDE.md` de uma linha (`@AGENTS.md`), `PROJECT_CHARTER.md`.
Por quê: nenhuma autonomia sobe sem portão novo (`landscape-dev-workflows.md` §(c) c7).
**scope_paths**: `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.oxlintrc.json`, `.github/**`, `AGENTS.md`, `CLAUDE.md`, `PROJECT_CHARTER.md`; **do_not_touch** acrescenta `packages/core/src/**`.
**requirements**: R1 WHEN o CI roda nos dois SOs THE SYSTEM SHALL executar `tsc --noEmit`, `oxlint` e `vitest run`, falhando se qualquer um sair ≠ 0. R2 WHEN `AGENTS.md` excede 8.192 bytes THE SYSTEM SHALL falhar o portão (digest #39).
**scenarios**: C1 given `AGENTS.md` de 9 KB, when o portão roda, then exit ≠ 0 → E1.
**evals**: E1 `V(meta.test.ts, agents_md_stays_under_8kb)`; E2 `["node","node_modules/oxlint/bin/oxlint"]` (`kind: lint`, `additive`).

### S2 — canonicalização JCS e digest
`ADE-S2` · `bounded` · `depends_on: [ADE-S1]` · 0,5 dia
**task**: `canonical.ts` sobre a dependência `canonicalize` (Apache-2.0, 0 deps, digest #30) e
`digest16(obj)` = 16 hex do SHA-256 do texto canônico. Nunca reimplementar JCS à mão.
**scope_paths**: `packages/core/src/journal/canonical.ts`, `packages/core/tests/canonical*.ts`, `fixtures/jcs/**`.
**requirements**: R1 WHEN um objeto do conjunto de referência é canonicalizado THE SYSTEM SHALL produzir bytes idênticos ao `json.dumps(sort_keys=True, ensure_ascii=False, separators=(',',':'))` do runtime de referência. R2 WHEN o valor é float de valor inteiro (`1.0`) THE SYSTEM SHALL serializar como `1`. R3 WHEN há surrogate solitário THE SYSTEM SHALL recusar.
**scenarios**: C1 given `fixtures/jcs/reference.jsonl`, when canonicaliza cada linha, then byte-igual → E1. C2 given `{"a":1.0}`, when canonicaliza, then `{"a":1}` → E2. C3 given surrogate solitário, when canonicaliza, then erro → E3.
**evals**: E1 `V(canonical.test.ts, canonicalize_output_byte_identical_to_python_reference_fixture)`; E2 `V(canonical.test.ts, canonicalize_integer_valued_float_matches_js_number_tostring)`; E3 `V(canonical.test.ts, canonicalize_rejects_lone_surrogate)`.

### S3 — journal com cadeia de hash e fsync
`ADE-S3` · `bounded` · `depends_on: [ADE-S2]` · 1 dia · budget 8/2/US$ 5
**task**: append-only com `prev` (I02), `fd` aberto + `writeSync` + `fsyncSync` por linha (I03;
`appendFileSync` **não** garante flush), leitura com verificação da cadeia, escritor único por fila
serializada, `format_version` e `runtime_stamp` no envelope.
**scope_paths**: `packages/core/src/journal/**`, `schemas/journal-event.schema.json`, `packages/core/tests/**/journal*.ts`.
**requirements**: R1 WHEN uma linha do journal é alterada THE SYSTEM SHALL recusar a leitura com exit 2. R2 WHEN `append` retorna THE SYSTEM SHALL ter chamado `fsync` naquele descritor. R3 WHEN o `runtime_stamp` de uma intenção aberta difere do atual THE SYSTEM SHALL parar com `stale_workflow_version` até `--accept-stale-version` (I48).
**scenarios**: C1 given journal de 5 eventos, when o byte 3 da linha 3 muda, then leitura recusa → E1, E2. C2 given intenção aberta com stamp antigo, when `ade run`, then `stale_workflow_version` → E3.
**evals**: E1 `V(parity/journal.test.ts, journal_hash_chain_detects_tampering)`; E2 `V(parity/journal.test.ts, invalid_journal_line_is_refused)`; E3 `V(parity/journal.test.ts, stale_runtime_version_stops_until_accepted)`.

### S4 — lease com fingerprint
`ADE-S4` · `bounded` · `depends_on: [ADE-S3]` · 0,5 dia
**task**: `mkdir` + heartbeat 2 s + TTL 6 s + fingerprint (pid, start time); exit 5
`coordinator_conflict`. `proper-lockfile` está abandonado desde 2021 e não entra (digest #30).
**scope_paths**: `packages/core/src/lease/**`, `packages/core/tests/**/lease*.ts`.
**requirements**: R1 WHEN um segundo `ade run` tenta adquirir o lease vivo THE SYSTEM SHALL sair com 5. R2 WHEN o dono morreu sem liberar THE SYSTEM SHALL adotar o lease só após o TTL **e** só se não existir processo com aquele pid **e** start time.
**scenarios**: C1 given lease vivo, when segundo processo tenta, then exit 5 → E1. C2 given dono morto e pid reciclado por processo alheio, when TTL expira, then adoção → E2.
**evals**: E1 `V(parity/lease.test.ts, lease_is_exclusive)`; E2 `V(lease.test.ts, lease_is_released_after_holder_crash_without_graceful_unlock)`.

### S5 — GitPort por worktree
`ADE-S5` · `feature` · `depends_on: [ADE-S2]` · 1 dia · budget 10/2/US$ 6
**task**: instância por worktree (nunca singleton, digest #33), `worktree_tree` com `GIT_INDEX_FILE`
próprio e índice racy (`utimes(idx,1,1)`), `dirty_paths -z` com os dois lados de rename,
`checkpoint`/`restore` em `refs/ade/`, hooks desligados por `GIT_CONFIG_COUNT/KEY/VALUE` no `env` de
cada `execFile` (nunca mutando `process.env` — melhoria sobre I50), `maxBuffer` explícito sempre.
**scope_paths**: `packages/core/src/git/**`, `packages/core/tests/**/git*.ts`.
**requirements**: R1 WHEN um arquivo é reescrito com o mesmo tamanho no mesmo segundo THE SYSTEM SHALL ver a mudança em `worktree_tree` (I21). R2 WHEN um arquivo é renomeado de fora para dentro do escopo THE SYSTEM SHALL reportar os dois lados em `dirty_paths` (I22). R3 WHEN uma árvore é restaurada THE SYSTEM SHALL gravar `refs/ade/discarded/...` antes (I19) e rodar `clean -fd` antes de `read-tree` (I20).
**scenarios**: C1 → E1. C2 → E2. C3 given arquivo ignorado só pela regra descartada, when restaura, then o arquivo permanece no disco → E3, E4.
**evals**: E1 `V(parity/git.test.ts, worktree_tree_sees_a_same_size_rewrite_within_one_second)`; E2 `V(parity/git.test.ts, rename_out_of_scope_into_scope_is_contained)`; E3 `V(parity/git.test.ts, discarded_tree_is_kept_under_a_ref)`; E4 `V(parity/git.test.ts, restore_keeps_a_file_ignored_only_by_the_discarded_rules)`; E5 `V(parity/git.test.ts, linked_worktree_is_supported)`; E6 `V(parity/git.test.ts, repository_hooks_do_not_run_inside_runtime_git_commands)`.

### S6 — BinaryResolver e `ade doctor` mínimo
`ADE-S6` · `bounded` · `depends_on: [ADE-S1]` · 0,5 dia
**task**: resolver o `.exe` real atrás dos 3 shims npm do `claude` (sh, `.cmd`, `.ps1`), fallback
`cmd.exe /c` para shim desconhecido, `spawn(..., {shell:false})` sempre; `ade doctor` grava
`capability-set` com `probe_ok/probed_at` e valida `len(argv) < 30.000` (digest #31).
**scope_paths**: `packages/core/src/runner/resolve-binary.ts`, `packages/core/src/cli/doctor.ts`, `schemas/capability-set.schema.json`.
**requirements**: R1 WHEN o binário `claude` resolve para um shim THE SYSTEM SHALL spawnar o `.exe` real sem `ENOENT`/`EINVAL`. R2 WHEN o shim tem formato desconhecido THE SYSTEM SHALL cair no wrapper `cmd.exe /c` e ainda funcionar.
**scenarios**: C1 given `claude` resolvendo para `claude.cmd`, when spawn, then processo real inicia → E1. C2 given shim com formato não reconhecido, when spawn, then fallback funciona → E2.
**evals**: E1 `V(doctor.test.ts, doctor_resolves_npm_shim_to_real_exe_on_windows)`; E2 `V(doctor.test.ts, doctor_falls_back_to_cmd_wrapper_on_unknown_shim_format)`.

### S7 — Runner com recibo durável
`ADE-S7` · `feature` · `depends_on: [ADE-S3, ADE-S6]` · 1 dia · budget 10/2/US$ 6
**task**: spawn com `env` explícito filtrado (allowlist + `DO_NOT_TRACK=1`, nunca herdar
`process.env`), `cwd` no worktree, filho **não-detached** (Job Object do libuv, `architecture.md` §6),
recibo em `.ade/missions/<id>/jobs/<step>.json` por tmp + `fsync` + `rename` nos estados
`starting → running → exited|timeout|crashed|start_failed`, com fingerprint (unit, authorization, cwd,
argv, timeout, result_file, pid, start_time); kill por `taskkill /T /F /PID`, nunca `pty.kill`
(digest #29).
**scope_paths**: `packages/core/src/runner/**`, `packages/core/tests/**/runner*.ts`, `packages/core/tests/receipt.test.ts`.
**requirements**: R1 WHEN o worker está em voo THE SYSTEM SHALL manter em disco um recibo `running` legível por um processo frio sem IPC. R2 WHEN o `spawn` falha antes de existir pid THE SYSTEM SHALL gravar `start_failed` e classificar a chamada como `released`, nunca cobrada (I07). R3 WHEN o worker é spawnado THE SYSTEM SHALL passar apenas as variáveis da allowlist.
**scenarios**: C1 given worker de 3 s, when outro processo Node lê o recibo aos 0,2 s e aos 1,7 s, then `running` nas duas leituras → E1, E2. C2 given binário inexistente, when spawn, then `released` e orçamento intacto → E3. C3 given crash entre `writeSync` e `fsyncSync`, when relê, then o recibo anterior está íntegro → E5.
**evals**: E1 `V(receipt.test.ts, receipt_running_state_is_readable_mid_flight_by_a_cold_process)`; E2 `V(receipt.test.ts, receipt_written_before_spawn_is_readable_by_another_process_as_starting)`; E3 `V(parity/runner.test.ts, missing_harness_executable_is_environment_and_not_charged)`; E4 `V(parity/runner.test.ts, worker_env_is_scrubbed)`; E5 `V(receipt.test.ts, receipt_write_survives_fault_injection_before_fsync)`.

### S8 — CLI falsa e gravador de transcript
`ADE-S8` · `bounded` · `depends_on: [ADE-S7]` · 0,5 dia
**task**: o trio obrigatório de §5 — contador durável em disco, `no_result`, captura de pack + env.
Fixture é **gravação real**, nunca texto escrito à mão (`landscape-dev-workflows.md` §(c) c6.1).
**scope_paths**: `packages/core/src/adapters/fake/**`, `fixtures/**`, `scripts/record-transcript.mjs`.
**requirements**: R1 WHEN a CLI falsa é invocada n vezes THE SYSTEM SHALL consumir a n-ésima ação do cenário mesmo após reinício do engine. R2 WHEN a ação é `no_result` THE SYSTEM SHALL não gravar o result file e sair 0.
**scenarios**: C1 given cenário de 3 ações e crash entre a 1ª e a 2ª, when retoma, then a 2ª ação é consumida → E1. C2 given duas chamadas, when cada uma roda, then existem `maker-1/2.pack.md` e `.env.json` → E2.
**evals**: E1 `V(fake-cli.test.ts, fake_cli_counter_survives_engine_restart)`; E2 `V(fake-cli.test.ts, fake_cli_captures_pack_and_env_per_call)`.

### S9 — Step com write-ahead e Reconciler
`ADE-S9` · `feature` · `depends_on: [ADE-S3, ADE-S5, ADE-S7]` · 1 dia · budget 12/3/US$ 8
**task**: `step()` com `step_intent` antes do efeito e `step_result` depois, `input_digest` (JCS) e
`intent_context` **fora** do digest (I17), idempotência por step id, `model_call` reusada por step id
mesmo com pack recompilado (I06), fila que proíbe dois `step()` concorrentes na mesma unidade, guarda
de `HEAD`/branch em torno de toda `model_call` (I27). Reconciliação por `effect_class` para as classes
do slice: `none`, `model_call`, `local_write`, `local_commit`, `eval_run`.
**scope_paths**: `packages/core/src/step/**`, `packages/core/tests/**/step*.ts`, `packages/core/tests/parity/crash*.ts`.
**requirements**: R1 WHEN o engine morre antes do efeito de uma `model_call` THE SYSTEM SHALL liberar a chamada sem cobrar. R2 WHEN morre depois do efeito THE SYSTEM SHALL consumir a chamada, gravar checkpoint da árvore suja e continuar dele. R3 WHEN morre depois do commit THE SYSTEM SHALL adotar o commit só se `HEAD^{tree}` e o pai conferirem (I10), nunca commitar de novo. R4 WHEN o recibo aponta pid vivo com fingerprint diferente THE SYSTEM SHALL tratar como `ambiguous`, nunca adotar.
**scenarios**: C1–C3 = os três pontos de crash acima → E1–E3. C4 given pack recompilado diferente, when retoma, then não redespacha → E4. C5 given pid reciclado, when reconcilia, then recusa → E5.
**evals**: E1 `V(parity/crash.test.ts, crash_before_maker_effect_releases_the_call)`; E2 `V(parity/crash.test.ts, crash_after_maker_effect_consumes_call_and_continues_from_checkpoint)`; E3 `V(parity/crash.test.ts, crash_after_commit_is_reconciled_without_a_second_commit)`; E4 `V(parity/step.test.ts, resume_after_commit_with_changed_pack_does_not_redispatch)`; E5 `V(reconcile.test.ts, reconcile_rejects_pid_reuse_via_fingerprint_mismatch)`; E6 `V(parity/step.test.ts, worker_that_moves_head_stops_the_batch)`.

### S10 — Contain, segredos e canário de isolamento
`ADE-S10` · `feature` · `depends_on: [ADE-S5]` · 1 dia · budget 10/2/US$ 6
**task**: precedência **segurança > `sensitive_paths` > `scope_paths`/`do_not_touch`**; varredura de
segredo no diff integral e nos bytes de cada arquivo (binário incluso), com `maxBuffer` explícito e
truncagem tratada como `unexpected_tree_state` (`runtime-port-map.md` §1.2); "Maker não mudou nada" é
falha semântica (I26); violação de escopo restaura a árvore e a segunda estaciona (I25); **canário de
isolamento por família**: arquivo plantado fora do worktree que a chamada é instruída a escrever — se
aparecer escrito, a família é reprovada (digest #38: `agy` escreveu em
`~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir`).
**scope_paths**: `packages/core/src/contain/**`, `packages/core/tests/**/contain*.ts`.
**requirements**: R1 WHEN há segredo no diff THE SYSTEM SHALL parar o lote antes de qualquer commit, mesmo com violação de escopo simultânea. R2 WHEN o diff excede 1 MiB THE SYSTEM SHALL varrer o diff inteiro. R3 WHEN a chamada escreve fora do worktree THE SYSTEM SHALL reprovar a família e parar.
**scenarios**: C1 given diff > 1 MiB com segredo no último hunk **e** arquivo fora do escopo, when `contain`, then lote parado por segurança, com escopo registrado mas não como motivo → E1, E2. C2 given arquivo plantado fora do worktree escrito pela chamada, when canário roda, then família reprovada → E5.
**evals**: E1 `V(parity/contain.test.ts, secret_in_diff_stops_batch)`; E2 `V(parity/contain.test.ts, secret_with_scope_violation_still_stops)`; E3 `V(parity/contain.test.ts, secret_inside_a_binary_file_is_caught)`; E4 `V(parity/contain.test.ts, sensitive_path_stops_batch)`; E5 `V(contain.test.ts, isolation_canary_detects_write_outside_worktree)`; E6 `V(parity/contain.test.ts, scope_expansion_restores_tree_then_parks_on_repeat)`.

### S11 — Eval runner vermelho/verde
`ADE-S11` · `bounded` · `depends_on: [ADE-S9]` · 0,5 dia
**task**: `eval_run{phase: red|green}` como classe de efeito com `EvalRecord` no journal; vermelho
contra `tree_before` obrigatório salvo `strictness.mode = 'additive'` (aviso registrado); eval que
nasce verde **não** volta ao Maker — volta ao Intent Compiler (no slice 1, que não o tem: recusa com
`eval_born_green`).
**scope_paths**: `packages/core/src/evals/**`, `schemas/eval.schema.json`, `packages/core/tests/evals*.ts`.
**requirements**: R1 WHEN um eval `must_fail_before` passa contra `tree_before` THE SYSTEM SHALL recusar a story com `eval_born_green`. R2 WHEN `mode: 'additive'` THE SYSTEM SHALL registrar aviso e prosseguir.
**scenarios**: C1 given eval que já passa antes da mudança, when `eval_run:red`, then recusa → E1. C2 given story aditiva com `additive`, when `eval_run:red`, then aviso no journal e segue → E2.
**evals**: E1 `V(evals.test.ts, eval_born_green_is_rejected)`; E2 `V(evals.test.ts, additive_strictness_records_warning_and_proceeds)`.

### S12 — Pack compiler mínimo e Tool Output Firewall
`ADE-S12` · `bounded` · `depends_on: [ADE-S3]` · 0,5 dia
**task**: cinco seções em ordem fixa (`contract` → `policy` → `story` → `evals` → `task`), teto por
seção com ponteiro honesto, teto global, redação de segredos **depois** da montagem (I59), manifesto
`{sections:[{section,ref,bytes,digest}],bytes,digest,redactions}` como artifact; sempre `{pack_path}`,
nunca `{pack_text}` (digest #31). Firewall: `run(argv) → {rawPath, extract}`, bruto em `artifacts/`,
extrato ao modelo, `ade show <ref>` para drill-down.
**scope_paths**: `packages/core/src/pack/**`, `packages/core/src/cli/show.ts`.
**requirements**: R1 WHEN o pack é montado THE SYSTEM SHALL não conter histórico de conversa, log bruto, o journal nem o plano. R2 WHEN uma seção é truncada THE SYSTEM SHALL anexar o total de chars e o ponteiro de drill-down. R3 WHEN a saída de gate contém segredo THE SYSTEM SHALL redigi-lo no pack.
**scenarios**: C1 given pack montado, when inspeciona, then seções na ordem e sem `journal` → E1. C2 given seção acima do teto, when monta, then ponteiro anexado → E2. C3 given gate que imprime segredo, when monta, then `[REDACTED:...]` → E3.
**evals**: E1 `V(pack.test.ts, pack_sections_are_ordered_and_contain_no_journal)`; E2 `V(parity/pack.test.ts, excerpt_is_bounded)`; E3 `V(parity/pack.test.ts, gate_output_secret_is_redacted_from_packs)`.

### S13 — Adapter `claude`
`ADE-S13` · `feature` · `depends_on: [ADE-S7, ADE-S8, ADE-S12]` · 1 dia · budget 10/2/US$ 6
**task**: casca fina sobre flags verificadas (`capabilities-claude-code.md` §1): `-p`,
`--output-format json`, `--json-schema <inline>` → `structured_output` com o `unit-result`,
`--session-id <uuid>` pré-cunhado **antes** do spawn e gravado em `session_ref` na intenção,
`--max-budget-usd`, `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (nunca `--bare`, digest #9),
`--permission-mode bypassPermissions --permission-prompts none --disallowedTools "Bash(git *)" "Bash(gh *)"`
(a cerca real é o `env` filtrado e o engine ser o único a rodar git, digest #37); parser tolerante a
campos desconhecidos; `parse_usage` lê `total_cost_usd`/`modelUsage.*.costBasis` e **nunca inventa**
(I45). O relato do agente não conta: a prova é o eval (digest #37).
**scope_paths**: `packages/core/src/adapters/claude/**`, `fixtures/transcripts/claude/**`, `packages/core/tests/adapter-claude*.ts`.
**requirements**: R1 WHEN a chamada é despachada THE SYSTEM SHALL ter gravado `session_ref` no `step_intent` antes do spawn. R2 WHEN o transcript não traz custo THE SYSTEM SHALL registrar `cost_source: 'unknown'`, nunca estimativa. R3 WHEN o JSON traz campos desconhecidos THE SYSTEM SHALL ignorá-los sem erro.
**scenarios**: C1 given transcript com `structured_output`, when parse, then `unit-result` válido por ajv → E1. C2 given transcript sem `total_cost_usd`, when parse, then `unknown` → E2. C3 given chamada despachada, when lê o journal, then `session_ref` já está na intenção → E3.
**evals**: E1 `V(adapter-claude.test.ts, claude_adapter_parses_recorded_transcript_into_unit_result)`; E2 `V(parity/usage.test.ts, usage_parsers_never_invent)`; E3 `V(adapter-claude.test.ts, session_id_is_preminted_and_journaled_before_spawn)`.

### S14 — `ade run --plan` ponta a ponta e matriz de crash
`ADE-S14` · `feature` · `depends_on: [ADE-S4, ADE-S9, ADE-S10, ADE-S11, ADE-S13]` · 1 dia · budget 14/3/US$ 10
**task**: CLI com `node:util parseArgs`; carregar e validar `plan.json` + `task-contract` com ajv;
ciclo `prepare → eval:red → implement → contain+canário → gates → eval:green → local_commit`; orçamento
com reserva (I44) e teto em dólar só sobre custo observado (I45); `permitted_effects` governa todo
efeito (I55); `spec_revision` = digest do objeto da story (I54); injeção de falha por `ADE_FAULT=<ponto>`
→ `process.abort()`, nunca `process.exit` (buffers pendentes mentem, `runtime-port-map.md` §1.2);
`.ade/` em `.git/info/exclude`.
**scope_paths**: `packages/core/src/cli/**`, `packages/core/src/engine.ts`, `packages/core/tests/e2e*.ts`, `packages/core/tests/parity/{authz,budget}*.ts`.
**requirements**: R1 WHEN `ade run --plan` roda a story trivial num repositório real THE SYSTEM SHALL terminar em `local_commit` com eval vermelho e verde no journal. R2 WHEN o processo é morto em qualquer um dos 6 pontos THE SYSTEM SHALL retomar sem repetir efeito nem cobrar chamada já paga. R3 WHEN `permitted_effects.local_write` é `false` THE SYSTEM SHALL recusar antes de qualquer despacho.
**scenarios**: C1 given repositório real + `plan.json` de uma story, when `ade run --plan`, then commit local e journal completo → E1. C2 given `ADE_FAULT` em cada um dos 6 pontos, when retoma, then nenhum efeito repetido → E2. C3 given `local_write: false`, when `ade run`, then recusa antes do despacho → E3.
**evals**: E1 `V(e2e.test.ts, run_plan_executes_one_trivial_story_to_local_commit)`; E2 `V(e2e.test.ts, crash_matrix_resumes_without_repeating_effects)`; E3 `V(parity/authz.test.ts, local_write_false_is_refused_before_any_dispatch)`; E4 `V(parity/budget.test.ts, zero_cost_cap_is_enforced_on_observed_cost)`; E5 `V(parity/budget.test.ts, zero_model_call_budget_is_refused)`.

**Ordem e caminho crítico.** S1 → S2 → S3 → {S4, S5, S6} → S7 → S8 → S9 → {S10, S11, S12} → S13 → S14.
Soma: 10,5 dias de story. O resto das 3 semanas é o lote de paridade (§6) rodando em paralelo,
integração e a matriz de crash.

---

## 4. Testes nomeados obrigatórios

**Novos do slice (12).** Todos são portão de merge; nenhum pode ser marcado `skip`.

| Teste | Módulo | Prova |
| :--- | :--- | :--- |
| `canonicalize_output_byte_identical_to_python_reference_fixture` | journal | I02 cross-linguagem; sem isto a cadeia quebra em silêncio |
| `journal_hash_chain_detects_tampering` | journal | I02 (portado, mesmo nome) |
| `receipt_running_state_is_readable_mid_flight_by_a_cold_process` | runner | I65 sem IPC (`addendum-durable-receipt...` §3.1) |
| `reconcile_rejects_pid_reuse_via_fingerprint_mismatch` | step | I09; reuso de PID foi **observado**, não é hipótese (§3.2 do addendum) |
| `doctor_resolves_npm_shim_to_real_exe_on_windows` | runner | I66; quebra no dia 1 sem isto |
| `worker_env_is_scrubbed` | runner | I49 (portado) |
| `secret_in_diff_stops_batch` | contain | I23/I24 — cenário endurecido: segredo **e** violação de escopo simultâneos, diff > 1 MiB com o segredo no último hunk (pega `maxBuffer` default de 1 MiB) |
| `eval_born_green_is_rejected` | evals | C9; substitui atestação por LLM |
| `isolation_canary_detects_write_outside_worktree` | contain | digest #38 |
| `crash_before_maker_effect_releases_the_call` | step | I07/I09 (portado) |
| `crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` | step | I09/I18 (portado) |
| `crash_after_commit_is_reconciled_without_a_second_commit` | step | I10 (portado) |

**`fast_lane_trivial_starts_within_30s_zero_questions`: é v0.3, não slice 1.** A faixa rápida vive no
Intent Compiler (`architecture.md` §5.4, ADR 0008) e o slice 1 não tem entrada em linguagem natural —
o teste ou seria vazio ou exigiria um Intent Compiler de mentira. No slice 1 fica o substituto sem
portão: o engine grava `telemetry.first_source_edit_ms` a partir de `ade run --plan`, para que o
número de v0.3 tenha baseline. Ver §9 (D2).

**Portados de `test_tl_runtime.py` que cabem no slice (44 de 93).** Mesmo nome, prefixo `test_`
removido (convenção Vitest), em `packages/core/tests/parity/`:

`journal_hash_chain_detects_tampering`, `invalid_journal_line_is_refused`,
`stale_runtime_version_stops_until_accepted`, `lease_is_exclusive`,
`worktree_tree_sees_a_same_size_rewrite_within_one_second`, `linked_worktree_is_supported`,
`discarded_tree_is_kept_under_a_ref`, `restore_keeps_a_file_ignored_only_by_the_discarded_rules`,
`repository_hooks_do_not_run_inside_runtime_git_commands`, `rename_out_of_scope_into_scope_is_contained`,
`secret_in_diff_stops_batch`, `secret_with_scope_violation_still_stops`, `sensitive_path_stops_batch`,
`secret_beyond_the_pack_diff_cap_is_still_caught`, `secret_inside_a_binary_file_is_caught`,
`secret_in_a_file_git_would_quote_is_caught`, `scope_expansion_restores_tree_then_parks_on_repeat`,
`path_within_and_secret_scan`, `worker_that_moves_head_stops_the_batch`,
`pre_existing_dirt_on_the_unit_branch_is_refused`,
`stale_unit_branch_with_foreign_commits_waits_for_operator`, `gate_artifacts_never_reach_the_commit`,
`gate_leftovers_after_crash_are_not_committed`, `changed_gate_command_is_not_served_from_cache`,
`gate_placeholders_and_script_name_matching`, `gate_output_secret_is_redacted_from_packs`,
`excerpt_is_bounded`, `resume_after_commit_with_changed_pack_does_not_redispatch`,
`resume_after_commit_does_not_reserve_new_calls`, `crash_before_maker_effect_releases_the_call`,
`crash_after_maker_effect_consumes_call_and_continues_from_checkpoint`,
`crash_after_commit_is_reconciled_without_a_second_commit`,
`crash_after_journaled_commit_resumes_with_that_commit`,
`branch_amended_after_journaled_commit_is_not_delivered`,
`approved_work_without_local_commit_is_handed_to_the_operator`, `harness_crash_retries_once_then_parks`,
`missing_harness_executable_is_environment_and_not_charged`,
`transient_failure_retries_with_backoff_then_succeeds`, `maker_blocked_on_authorization_stops_batch`,
`zero_model_call_budget_is_refused`, `zero_cost_cap_is_enforced_on_observed_cost`,
`usage_parsers_never_invent`, `local_write_false_is_refused_before_any_dispatch`,
`non_boolean_optional_effects_are_refused`.

**Mapa de nomes onde a semântica mudou** (a tabela completa é entregável da v0.2, `architecture.md` §8;
estes três já nascem no slice 1):

| Nome original | Nome no slice 1 | Motivo |
| :--- | :--- | :--- |
| `test_dirty_tree_before_unit_stops` | `dirty_worktree_before_story_stops` | a guarda passa a ser por worktree, não global (digest #33) |
| `test_missing_immutable_digest_is_refused` | `missing_plan_approval_digest_is_refused` | `batch.schema.json` morreu; o digest é o da aprovação do plano |
| `test_spec_drift_and_scope_drift_are_refused` | `story_drift_and_scope_drift_are_refused` | `spec_revision` = digest do objeto da story, não de um `.md` (`runtime-port-map.md` §2) |

**Fora do slice** (v0.2, ~49 casos): tudo de `push`/`pull_request`/`merge`/CI, rework, Checker,
detector de loop, estagnação, `decide`, `report`.

---

## 5. Fixture da CLI falsa

Porte direto de `scripts/fixtures/runtime/fake_harness.py` (`runtime-port-map.md` §7), com o trio que
torna os testes de crash possíveis sem mock: **contador durável**, **`no_result`** e **captura de pack
+ env**.

```
fixtures/
  jcs/reference.jsonl                 # objetos + bytes canônicos gerados pelo Python de referência
  transcripts/claude/<nome>/
    argv.json  stdin.txt  stdout.json  stderr.txt  exit.txt  meta.json
  scenarios/<cenario>/
    maker.json                        # lista de ações
    .cursor.json                      # contador em disco (o que sobrevive ao restart)
    maker-<n>.pack.md                 # pack recebido na n-ésima chamada
    maker-<n>.env.json                # env visto na n-ésima chamada
    maker-<n>.argv.json
```

**Transcript.** `scripts/record-transcript.mjs` (~50 linhas) executa uma sessão **real** de
`claude -p "<prompt>" --output-format json --json-schema '<unit-result inline>' --session-id <uuid>
--safe-mode` com `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, grava stdout byte a byte e anota em `meta.json`
a versão do CLI, o modelo e a data. Fixture é gravação, nunca texto escrito à mão
(`landscape-dev-workflows.md` §(c) c6.1: a classe de bug que queimou cinco tentativas no Orca).
Transcripts mínimos do slice: `ok_with_structured_output`, `ok_without_cost`
(`cost_source: 'unknown'`), `unknown_fields` (campos novos ignorados), `truncated_json`,
`ansi_noise`, `permission_denied_then_reports_success` (digest #37).

**Ação do cenário** (`maker.json`, uma por chamada):
`{ write?: [{path, content}], delete?: [path], run?: argv, stdout_from?: "transcripts/claude/<nome>",
stderr?: string, exit?: number, result?: <unit-result> | "no_result", sleep_ms?: number }`.

- `run` executa `argv` arbitrário — é como se prova I27 (worker que move `HEAD`).
- `result: "no_result"` não grava o result file: é como se prova `ambiguous`.
- O contador é lido e incrementado **em disco** por tmp + `fsync` + `rename` antes de agir, para que o
  reinício do engine veja a mesma sequência que um harness real veria.
- A captura de `pack` e `env` é o que prova I49 e a ordem das seções do pack sem inspecionar o engine.

---

## 6. Método de execução

**Estágio 0 — lote de paridade.** Os ~44 casos portados são volumosos, repetitivos e com pronto
binário: o perfil exato de loop autônomo (`landscape-dev-workflows.md` §(c) c5). Rodar em
`tl-orchestrator v0.17.0` (`validate`, depois `run`) num worktree descartável, push só para branch
próprio. **Timebox de adaptação: meio dia**; se estourar, cai para `claude -p` em loop dirigido por um
runner de ~30 linhas com cursor JSONL (não um `for` cru — ver D5). Começa depois de S3+S5.

**Stories de infra (S1–S14).** Claude Code com Superpowers: `writing-plans` → `executing-plans`,
`using-git-worktrees`, `test-driven-development` (eval antes do código), `subagent-driven-development`
com implementer fresco por tarefa. `brainstorming` só em S9 e S10; nas demais a cerimônia proporcional
manda pular. Dois pontos de humano por story e só dois: aprovação do plano e do merge.

**Checker desde o dia 1.** `codex exec --json --sandbox read-only --ignore-user-config
--output-schema schemas/review-result.schema.json`, com diff + contrato da story por stdin
(`codex exec -`, evita o limite de linha de comando). Nunca `codex review`: ignora `--output-schema`
em silêncio (digest #6). `--ignore-user-config` é obrigatório pelo piso de 19,4k tokens do Codex
headless (digest #27). `review-result` validado por ajv na ingestão, já na forma rica (digest #32).

**Malha de portões** (ordem de custo crescente, `landscape-dev-workflows.md` §(c) c3):

| # | Portão | Onde | Bloqueia |
| :-- | :--- | :--- | :--- |
| 1 | `tsc --noEmit` estrito | local + CI | sim |
| 2 | `oxlint` + `dmmulroy/anti-slop` pinado por SHA | local + CI | sim |
| 3 | `vitest run` (unit + paridade) | local + CI (Win + Linux) | sim |
| 4 | cobertura de linhas ≥ 85 % em `src/{journal,step,lease,git,runner,contain}` | CI | sim |
| 5 | razão teste:produção no corpo do PR | CI (tabela, sem threshold) | não |
| 6 | root directory guard (~20 linhas) | CI | sim |
| 7 | ratchets (`max-lines`, `ts-nocheck`, `any`) — só melhora, suprimir regra é proibido por escrito no `AGENTS.md` | CI | sim |
| 8 | todo import novo existe no registry + lockfile commitado | CI | sim |

**CI.** GitHub Actions, matriz `windows-latest` + `ubuntu-latest`, Node 22 e 24. Vitest em paralelo
por worker com tmpdir próprio (a suíte Python leva 18 min em série — `runtime-port-map.md` §0).
**CI não tem credencial de CLI**: só a CLI falsa e os transcripts gravados rodam lá; as sondas reais de
`ade doctor` (`--json-schema`, `--session-id`, canário de isolamento) rodam só na máquina do
desenvolvedor e gravam `~/.ade/capabilities.json`, que o CI lê como fixture. O CI Windows também
verifica `core.longpaths=true` e o comprimento de `.ade/wt/<story>` com `node_modules` profundo
(buraco apontado em `judgment-J1` §5.7).

**`AGENTS.md` ≤ 8 KB** (digest #39: Codex omite skills acima de 2 % da janela e trunca `AGENTS.md` a
32 KiB em silêncio; a meta é ≤ 2,5k tokens). `CLAUDE.md` tem uma linha: `@AGENTS.md`. Conhecimento
condicional vai para `docs/reference/<cicatriz>.md`, escrito no momento em que um agente erra, nunca
para o `AGENTS.md`. Poda semanal pelo critério "remover esta linha faria o agente errar?".

**Convenção de commit** desde o commit 1: `Co-Authored-By:` para saída de agente, mensagem explícita
quando o humano corrige à mão — torna a razão IA/humano mensurável por `git log`.

---

## 7. Definição de pronto e critério de saída para a v0.2

**Pronto do slice 1** — todos obrigatórios:

1. `ade run --plan plan.json` fecha uma story trivial num repositório real (não fixture) com
   `local_commit`, eval vermelho e verde gravados, manifesto do pack como artifact.
2. Matriz de crash × fase verde: `ADE_FAULT` em 6 pontos (antes do spawn, depois do efeito do Maker,
   antes do `contain`, depois do `contain`, antes do commit, depois do commit) × {engine, worker} —
   nenhum efeito repetido, nenhuma chamada paga redespachada, journal explicando cada decisão.
3. Os 12 testes novos e os 44 portados verdes em Windows **e** Linux, em paralelo por worker.
4. Journal adulterado em uma linha → exit 2. Lease concorrente → exit 5.
5. `ade doctor` resolve o `.exe` real do `claude`, prova `--json-schema` e `--session-id` com chamada
   real, e grava `capability-set` com `probe_ok`/`probed_at`.
6. Canário de isolamento da família `claude` passa; `ade run` recusa família sem canário.
7. Segredo plantado no diff para o lote antes de qualquer commit, com violação de escopo simultânea e
   diff > 1 MiB.
8. **Dogfood**: a story trivial usada na demonstração é uma story **da própria ADE** — acrescentar um
   campo aditivo ao `journal-event` com o eval correspondente (o cenário que força a regra de
   `runtime_stamp` a valer, `judgment-J1` §5.5/5.6).
9. Portões 1–4 e 6–8 verdes no CI nos dois SOs. `AGENTS.md` ≤ 8 KB.

**Critério de saída para a v0.2** (o que a v0.2 herda como dívida declarada, `architecture.md` §
roadmap): paridade **93/93** nos dois SOs com a tabela completa de mapeamento de nomes; push/PR/merge e
reconciliação remota; Checker Codex produzindo `review-result` validado; rework; detector de loop;
orçamentos completos. O slice 1 entrega o esqueleto sobre o qual esses 49 casos restantes são porte
mecânico, não projeto novo.

---

## 8. Riscos e o que fazer se estourar 3 semanas

| # | Risco | Sintoma | Mitigação | Reversão |
| :-- | :--- | :--- | :--- | :--- |
| R1 | Canonicalizador errado quebra a cadeia em silêncio | nenhum — é invisível | vetores JCS e o teste de paridade byte a byte **antes** de qualquer outro código (S2 é a segunda story) | trocar a dependência `canonicalize` é um arquivo |
| R2 | `maxBuffer` default de 1 MiB trunca a varredura de segredo | teste de diff grande passa por acaso | `maxBuffer` explícito em todo `execFile` de git + truncagem = `unexpected_tree_state` (`runtime-port-map.md` §1.2) | stream em vez de buffer |
| R3 | Formato de saída do `claude` muda no meio do slice | parser quebra com CLI atualizada | transcripts gravados com versão anotada + parser tolerante a campo desconhecido + `ade doctor` falha alto | congelar a versão do `claude` pela duração do slice |
| R4 | O estágio 0 custa mais que o trabalho que economiza | meio dia de adaptação sem um teste verde | timebox explícito; fallback `claude -p` com cursor JSONL | rodar os 44 à mão pelo ciclo normal (+2 dias) |
| R5 | `.ade/wt/<story>` estoura MAX_PATH com `node_modules` | `EPERM`/`ENOENT` só no Windows | `core.longpaths=true` no doctor + caminho curto; teste no CI Windows | worktree em `%TEMP%` com junction |
| R6 | Worker morre com o engine e perde uma chamada paga | custo em crash de engine | decisão de arquitetura (§6, decisão 5 de Erick) | ver §9 D1 |

**Se estourar 3 semanas, a ordem de corte é fixa** (nada aqui muda o pronto de durabilidade):

1. Corta S12 para o mínimo: pack com 3 seções, sem firewall (`ade show` vira `cat`). −0,5 dia.
2. Corta os transcripts `truncated_json` e `ansi_noise` (ficam para a v0.2, com a classe de bug
   registrada em `docs/reference/`). −0,5 dia.
3. Corta 12 dos 44 casos portados — os de gate (`gate_placeholders...`, `changed_gate_command...`) e os
   de orçamento, que não têm efeito externo a reconciliar. −1 dia. A lista cortada vira issue,
   não silêncio.
4. **Nunca cortar**: cadeia de hash, `fsync` por linha, recibo durável, fingerprint anti-PID,
   `contain` de segurança, canário de isolamento, matriz de crash, paridade Windows+Linux. Cortar
   qualquer um destes transforma o slice 1 numa demo e a v0.2 num reinício.

Se, mesmo com os cortes 1–3, a matriz de crash não fechar até o fim da semana 3: **estender o slice,
não reduzir o pronto**. O slice 1 é o plano de teste do resto do projeto
(`proposal-B-durable.md` §10); aprová-lo com a durabilidade parcial paga juros em toda fase seguinte.

---

## 9. Divergências propostas

**D1 — a reconciliação `running` de `model_call` fica inalcançável com worker não-detached.**
`architecture.md` §6 fixa worker não-detached (morre com o engine, Job Object do libuv), mas I09
(`runtime-port-map.md` §1.1) e `addendum-durable-receipt-process-containment-windows.md` §3.3
descrevem "`starting/running` → anexa e espera", que pressupõe `detached:true` + `unref()` (§3.1,
prototipado assim). Com a decisão atual, todo recibo `running` na retomada é, por construção, órfão ou
PID reciclado: o ramo "anexa" nunca executa. **Objeção**: a tabela publicada tem três ramos e o código
terá dois — a mesma classe de divergência schema-vs-runtime que derrubou o `review-result` (digest #32).
**Proposta**: declarar em ADR 0012 que na v1 `model_call` reconcilia com dois ramos
(`not_started → released`; qualquer outro → `ambiguous` + checkpoint) e que `receipt_path` + fingerprint
existem para quando o detached voltar. Sem isso, o slice 1 implementa um ramo morto.

**D2 — `fast_lane_trivial_starts_within_30s_zero_questions` não é testável no slice 1.**
`judgment-J1` §6 enxerta a faixa rápida como requisito com eval próprio e `architecture.md` §5.4 fixa
≤30 s, 0 perguntas, ≤2 chamadas — mas a faixa rápida é a entrada em linguagem natural do Intent
Compiler, que é v0.3 (ADR 0008). **Objeção**: no slice 1 só existe `ade run --plan`, onde "0 perguntas"
é trivialmente verdadeiro e "30 s" mede `prepare`; um teste verde que não prova o requisito é pior que
nenhum. **Proposta**: mover o teste para critério de saída da v0.3 e manter no slice 1 apenas
`telemetry.first_source_edit_ms` sem portão, como baseline.

**D3 — o slice 1 precisa do seu próprio número de paridade, não do 93/93.** ADR 0003 fixa 93/93 e o
roadmap o coloca na v0.2; ~49 dos 93 nomes de `test_tl_runtime.py` exercem push/PR/merge/CI/review/
rework, inexistentes no slice 1. **Objeção**: sem subconjunto nomeado, "quantos testes o slice 1 deve
ter" vira negociação semanal e a matriz de crash acaba sendo o único portão real. **Proposta**: fixar
em ADR 0003 os 44 casos de §4 como critério do slice 1, mantendo 93/93 na v0.2.

**D4 — cobertura mínima global contradiz a evidência adotada.**
`landscape-dev-workflows.md` §(c) c3.9 recomenda **razão teste:produção no corpo do PR em vez de
threshold global**. Com ~1.900 LOC de produção e ~2.500 de teste, threshold global é satisfeito por
acidente e incentiva teste de fachada nos módulos baratos. **Proposta**: threshold só nos seis módulos
de durabilidade (85 %, portão 4 de §6); no resto, a tabela de razão no PR, sem portão.

**D5 — o fallback do estágio 0 precisa de cursor durável.** `landscape-dev-workflows.md` §(c) c5 define
o fallback como "`claude -p` em loop sobre a lista de testes". **Objeção**: sem cursor em disco, um
crash no meio de um lote de 44 casos perde a posição, e o projeto estaria construindo um scheduler
durável enquanto roda um loop sem durabilidade. **Proposta**: o fallback grava cursor JSONL no mesmo
formato de linha do `journal-event` (~30 linhas), que vira a primeira fixture real do próprio journal.
