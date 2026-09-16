# ADR 0015 — Três níveis de autonomia, flags desatendidas por família, `contain` como única fronteira

**Status:** aceito 2026-09-17

## Contexto

O operador precisa rodar lotes noturnos sem autorizar cada ação, e ao mesmo tempo nunca descobrir de
manhã que um agente fez deploy ou tocou um segredo. As três famílias têm mecanismos de permissão
assimétricos, e nenhum deles é utilizável como jaula universal no Windows. É preciso decidir onde mora a
fronteira real.

## Decisão

**Três níveis, declarados por story no Task Contract** (`guardrails.autonomy`, `guardrails.ask_operator`):

| Nível | Libera | Desatendido |
| :--- | :--- | :--- |
| `safe` | ler, editar, testar, branch, commit local | sim |
| `controlled` | push, PR, dependências novas, migrations | sim, com aprovação única na missão |
| `restricted` | produção, segredos, destrutivo | **nunca**; `dispatch: never` com motivo `autonomy_requires_operator` |

`ask_operator` é **enum fechado** (`push`, `pull_request`, `pull_request_merge`, `dependency_add`,
`dependency_major_bump`, `migration_destructive`, `deploy`, `secrets_read`, `destructive_local`,
`skill_first_use`, `*`) mais um `note` livre. `restricted` não tem bloco de famílias: não despacha e
herda `scope_paths` da story (§11 E5).

`ade run --unattended` tem precondição dura e recusa sem (a) gates ativos, (b) baseline de eval verde,
(c) caminho de rollback em `refs/ade/`, (d) isolamento por worktree verificado pelo canário (§10 A5).

Flags de modo desatendido por família, medidas, aplicadas como **filtro barato**, não como fronteira:
Claude `--permission-mode bypassPermissions --permission-prompts none --disallowedTools
"Bash(git push*),Bash(gh pr*)"` — **um argumento único separado por vírgula**, forma medida (§11 E24),
nunca `--permission-mode auto`; Codex `codex exec --sandbox workspace-write --approve-for-me` +
`.rules` de `execpolicy`; `agy` `--dangerously-skip-permissions` (o `--approval-mode yolo` é do Gemini
CLI, que não faz parte da ADE).

A **fronteira real é tripla e é do engine**: (1) `env` do worker explicitamente filtrado (I49), que é
onde vive a deny-list de caminhos fora do worktree (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) junto com o
canário e o `ade doctor` — **não** no `contain`, que só vê o diff (§11 E23, ajustando §10 A4);
`ANTHROPIC_BASE_URL` e equivalentes nunca propagados nem aceitos (CVE-2026-21852, CVE-2025-59536);
(2) o engine é o único que roda `git`/`gh` (C22); (3) `contain` pós-fato sobre a árvore, com precedência
**segurança > `sensitive_paths` > `scope_paths`/`do_not_touch`** (I23), `maxBuffer` explícito, e canário
de isolamento por família (escrever fora do worktree tem de falhar).

## Evidência

- `addendum-autonomia-permissoes-por-repositorio.md` §1 e veredito de abertura: nenhum dos cinco
  mecanismos nativos é o `contain`; todos são camadas que o **worker** vê, e o `contain` é a única que o
  **engine** vê depois do fato.
- Digest #8 / mesmo addendum §1: o sandbox de SO do Claude Code não roda em Windows nativo (doc oficial),
  e falha **aberta** por padrão quando indisponível; o do Codex é fail-closed mas exige
  `[permissions.<nome>]` que não vem pronto; `agy` não tem isolamento de SO.
- Digest #37: `--permission-mode auto` só ativa com esse valor literal, e um hook `PreToolUse` com
  `allow` explícita executa o comando **mesmo com `--permission-prompts none`** (medido). Um `claude -p`
  pode **reportar sucesso depois de ferramenta bloqueada** — daí a prova por eval, nunca por relato
  (ADR 0007).
- Digest #7: `--full-auto` não existe no Codex 0.154.0; `codex exec` não tem `-a`.
- Digest #38: `agy` escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, sem
  aviso — o canário por família é obrigatório, não opcional.
- `judgment-J3` §5 e buraco 7: `--disallowedTools "Bash(git push*),Bash(gh pr*)"` é glob de string —
  `git -C <dir> push`, um alias ou um script de repo passam. A rede real é o `env` filtrado, e isso
  precisa estar escrito. A sonda do `ade doctor` exige `permission_denials` não vazio num
  `git push --dry-run` para dar a flag por aplicada (§11 E24).
- `runtime-port-map.md` §1.2 (I24): o default de 1 MiB do `maxBuffer` do `execFile` **trunca a varredura
  de segredo em silêncio** — segredo no fim de um diff grande passa.
- `landscape-dev-workflows.md` b2: usuários do Claude Code aprovam 93 % dos prompts de permissão — o
  gate por clique não é gate.

## Trade-offs

`contain` pós-fato detecta, não impede: uma escrita fora do worktree já aconteceu quando é vista, e o
remédio é descarte + `awaiting_operator`, não prevenção. Em troca, a regra é **uma só para as três
famílias** e continua valendo durante o takeover, quando toda flag nativa deixa de existir (ADR 0013).
`restricted` nunca desatendido custa noites de lote em que a missão para — é o custo aceito.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| `claude auto-mode` como política da ADE | 76 KB de classificador em linguagem natural, sem doc de produto, só ativo com `--permission-mode auto`; a extensão (`environment`) está vazia nesta instalação (addendum §2) |
| `codex sandbox` como jaula universal | fail-closed até para escrita no próprio `cwd` sem chave não documentada (#37) |
| Sandbox de SO do Claude Code | não existe em Windows nativo e falha aberta (#8) |
| `autonomy` no plano, não na story | uma story de migration e uma de texto não têm o mesmo risco (J3 §5) |
| Confiar em `--disallowedTools` como cerca de git/gh | glob de string, contornável (J3 buraco 7) |

## Como reverter

**Gatilho:** uma família publicar sandbox de SO utilizável em Windows nativo e verificável por canário.
**Custo:** o nível vira flag do adapter e o `contain` permanece como segunda camada — nada some.
Rebaixar `restricted` a desatendido, ao contrário, exige mudança de contrato e aprovação explícita do
operador; não é reversão, é decisão nova.

## Consequências para outros documentos

`schemas/task-contract.schema.json` (`guardrails.autonomy`, `guardrails.ask_operator`,
`sensitive_paths`; `ask_operator` como enum fechado + `note`), `schemas/capability-set.schema.json`
(`unattended_flags`, `sandbox`, `probe_ok: boolean | null` e `probe_mode` do canário por família),
`docs/operations/autonomy-and-permissions.md` (precondições de `--unattended`), `docs/security/README.md`
(deny-list no `env` filtrado, no canário e no doctor),
`docs/specs/` (`contain` com `maxBuffer` explícito em todo `execFile`), ADR 0006 (Checker que não
escreve torna I28 impossível), ADR 0012, ADR 0013, ADR 0022.

## Emendas (2026-09-17)

Fonte: `architecture.md` §12 (revisão adversarial). Prevalecem sobre o texto acima onde houver conflito.

- **E44** `deploy` e `dependency_install` são valores exclusivos do enum de `ask_operator` (E5); não
  entram em `effect_class`. A menção em operations §1 é vocabulário de aprovação, não de
  `permitted_effects`.
- **E46** O literal canônico de `--disallowedTools` (E24) passa a
  `"Bash(git push *),Bash(gh pr *),Bash(gh release *)"`. `WebFetch` fica fora (leitura sem efeito
  externo; a pesquisa depende dela). Sede normativa: adapters §2.
- **E47** Tabela única de exit codes (master-spec §4, herdada do runtime): 0 ok/idle; 2 recusa ou parada
  final (inclui `stale_workflow_version` e trabalho vermelho final); 3 concluído com paradas
  (`awaiting_operator`, orçamento esgotado, `parked`); 4 entrada inválida; 5 lease. Não existem 1 nem 6.
- **E43/E68** Reafirmam E7: só `core_version` bloqueia despacho e `--unattended`. `config_digest`
  divergente não ganha `--accept-config-change` (mitigação: argv congelado no `batch_open` e hash de
  `.ade/**` verificado pelo doctor); `capabilities_digest` divergente não bloqueia `--unattended` — vai
  ao relatório e ao `mission_summary`.
- **E56** Confiança em repositório: a v1 assume repositórios do próprio operador. `catalog.sources`
  permanece em `.ade/config.json` do repositório (sem `~/.ade/config.json`, que não existe no layout).
  "Modo repositório de terceiros" (allowlist de remotos; `.ade/config.json` não confiado) é backlog da
  v0.5 com ADR próprio quando chegar.
