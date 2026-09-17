# Revisão Humana Obrigatória: Módulo Contain (Slice 1)

Documento de conformidade com a **Exceção E30** e o **ADR 0015** do TL-ADE.

## Contexto e Fundamento

De acordo com o **ADR 0015** (Autonomia, Níveis e Flags Desatendidas) e a **Exceção Escrita E30** descrita no plano do Slice 1 (`docs/plans/slice-1.md`), as superfícies de segurança do TL-ADE possuem **revisão humana obrigatória de diff** pelo Erick antes do merge ou uso em produção. No Slice 1, essa fronteira é exatamente o subsistema de contenção pós-fato (`contain`), composto por varredura de segredos, validação de caminhos sensíveis, quarentena de árvores e o canário de isolamento.

O `contain` atua como a fronteira de segurança do motor após a execução de tarefas pelos workers (Claude, Codex ou Antigravity/AGY), garantindo que escritas fora do worktree, vazamento de segredos em diffs e expansão indevida de escopo sejam barrados e postos em quarentena determinística.

## Checklist de Arquivos para Revisão Humana do Erick

- [ ] **`src/contain/secrets.js`**
  - Implementação da varredura de segredos (`scanText`, `scanBytes`, `scanFile`) em diffs integrais e buffers.
  - Padrões de segredos monitorados (`SECRET_PATTERNS`: chaves AWS, OpenAI, GitHub, chaves privadas PEM, `.env`).
  - Função de fronteira `pathWithin(rootDir, candidate)` para contenção de caminhos relativos e proteção contra path traversal no Windows e POSIX.

- [ ] **`src/contain/contain.js`**
  - Ordem de precedência fixa de segurança: `secret` > `sensitive_path` > `scope` > `no_changes` (invariante I23).
  - Isolamento pós-fato e quarentena de árvores Git violadas sob `refs/ade/quarantine/<unitId>/<n>`.
  - Tratamento de restauração em primeira violação de escopo e estacionamento (`park`) na reincidência (invariante I25).
  - Tratamento de truncagem de buffer do Git (`diffMaxBuffer`) como erro de integridade de estado (`unexpected_tree_state`).

- [ ] **`src/contain/canary.js`**
  - Plantio de canário de isolamento (`plantCanary`) fora do worktree real com verificação estrita anti-traversal e recusa de diretórios internos.
  - Detecção de escrita indevida fora do worktree (`checkCanary`).
  - Reprovação estrita com erro de integridade de estado (`assertCanaryIntact` lançando `StateIntegrityError: isolation_canary_written`).

- [ ] **`tests/parity/contain.test.ts`**
  - Suíte de paridade cobrindo os cenários e evals formais do motor (segredos no diff, segredo com violação de escopo simultânea, segredo em arquivo binário, sensitive paths, expansão de escopo com restauração e estacionamento).

- [ ] **`tests/contain.test.ts`**
  - Provas unitárias e de integração da fronteira de contenção.
  - Prova de truncagem de `maxBuffer` lançando `unexpected_tree_state`.
  - Provas do canário de isolamento com a CLI simulada (`isolation_canary_plants_outside_worktree_and_file_does_not_exist`, `isolation_canary_rejects_inside_worktree_or_invalid_unit_id`, `isolation_canary_detects_write_outside_worktree`, `isolation_canary_remains_intact_when_cli_does_not_escape`).
