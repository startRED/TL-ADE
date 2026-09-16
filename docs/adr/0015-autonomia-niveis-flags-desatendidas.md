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
| `restricted` | produção, segredos, destrutivo | **nunca**; `ask_operator: ['*']` |

Flags de modo desatendido por família, medidas, aplicadas como **filtro barato**, não como fronteira:
Claude `--permission-mode bypassPermissions --permission-prompts none --disallowedTools "Bash(git *)"
"Bash(gh *)"` (nunca `--permission-mode auto`); Codex `codex exec --sandbox workspace-write
--approve-for-me` + `.rules` de `execpolicy`; `agy` `--approval-mode yolo`.

A **fronteira real é tripla e é do engine**: (1) `env` do worker explicitamente filtrado (I49); (2) o
engine é o único que roda `git`/`gh` (C22); (3) `contain` pós-fato sobre a árvore, com precedência
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
- `judgment-J3` §5 e buraco 7: `--disallowedTools "Bash(git push*)"` é glob de string —
  `git -C <dir> push`, um alias ou um script de repo passam. A rede real é o `env` filtrado, e isso
  precisa estar escrito.
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
`sensitive_paths`), `schemas/capability-set.schema.json` (`unattended_flags`, `sandbox`, `probe_ok` do
canário por família), `docs/operations/autonomy-and-permissions.md`, `docs/security/README.md`,
`docs/specs/` (`contain` com `maxBuffer` explícito em todo `execFile`), ADR 0006 (Checker que não
escreve torna I28 impossível), ADR 0012, ADR 0013, ADR 0022.
