# ADR 0044 — Isolamento pelo projeto, sem `--safe-mode` (emenda os ADRs 0009, 0011 e 0019)

**Status:** Aceito (pedido de Erick, 2026-09-26: desligar o `--safe-mode` e usar todo o potencial do Claude Code,
incluindo as skills `run` e `verify`)

## Contexto

Os ADRs [0009](0009-skill-fabric-catalogo-curado-selecao-12-controles.md) (E15, E56) e
[0011](0011-context-pack-firewall-telemetria.md) isolam a chamada despachada com `--safe-mode` e a auto memory
desligada, e o [0019](0019-rejeicoes.md) repete que esse é o isolamento correto. O `--safe-mode` desliga toda
customização, inclusive a do projeto: skills em `<repo>/.claude/skills` (como a receita `run-tl-ade`), o
CLAUDE.md/AGENTS.md do repositório, os hooks do projeto e hooks passados pelo motor em `--settings` (medido em
2026-09-26 com a CLI 2.1.283: um Stop hook em `--settings` não dispara sob `--safe-mode`). Com isso, o maker não
enxergava a receita que o projeto grava para rodar e conferir o app.

Medido na mesma data, com sondas `stream-json` (evento `system/init` e pergunta direta ao modelo):

- `--setting-sources project --strict-mcp-config` deixa fora os plugins, hooks, MCP (inclusive os conectores do
  claude.ai) e instruções do usuário, e carrega a skill do projeto, as skills nativas (`run`, `verify`,
  `code-review`, `simplify`) e o AGENTS.md do repositório.
- A busca de CLAUDE.md sobe pelas pastas **acima** do cwd, passando da raiz do repositório. A cópia de trilho fica
  em `~/.ade/lanes/<id>` (ADR 0031), e dali o Claude Code carregava o `~/.claude/CLAUDE.md` do operador como se
  fosse do projeto.
- A auto memory é uma por repositório, compartilhada pelas worktrees: sem desligá-la, o maker lia a memória
  privada do operador.
- `--exclude-dynamic-system-prompt-sections` tira cwd, ambiente e git status do prompt de sistema; entre duas
  cópias diferentes a leitura do cache subiu de 26.224 para 29.974 tokens e a criação caiu de 8.188 para 4.298.
- `--bare` continua fora: exige chave de API e não lê a assinatura.

## Decisão

1. **Toda chamada ao `claude` passa por `src/adapters/claude/isolation.ts`**: maker, revisor, prova, crítico do
   plano, chat do painel, juiz visual, sonda de cota e `ade doctor`. Nenhum arquivo de `src/` usa `--safe-mode`
   (prova `tests/claude_isolation.test.ts`).
2. **Flags:** `--setting-sources project` (ou vazio para chamadas que não trabalham no projeto: juiz visual e sonda
   de cota), `--strict-mcp-config` (só o MCP que o motor passar em `--mcp-config`),
   `--exclude-dynamic-system-prompt-sections` e `--settings <arquivo>`.
3. **O arquivo de `--settings`** traz `autoMemoryEnabled: false` e `claudeMdExcludes` com os arquivos de instrução
   de todas as pastas acima do cwd (CLAUDE.md, CLAUDE.local.md, AGENTS.md, `.claude/CLAUDE.md`,
   `.claude/AGENTS.md`, `.claude/rules/**`), com a letra da unidade nas duas caixas. As instruções da própria cópia
   continuam valendo. O arquivo vai para o tmp do sistema, um por cwd, e não entra no argv, pelo teto de
   32.767 caracteres do Windows.
4. **Ambiente:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` em toda chamada, como o 0011 já pedia.
5. **O que passa a valer na chamada:** skills do repositório e as nativas, CLAUDE.md/AGENTS.md da cópia, hooks e
   regras de permissão do `.claude/settings.json` do projeto. `skills_injected[]` continua medindo só o que o pack
   injeta; a listagem nativa agora tem as skills do projeto e as embutidas da CLI, nunca as do operador.

## Evidência

- `tests/claude_isolation.test.ts`: pastas ancestrais excluídas e a do cwd não; raiz sem exclusão; letra da unidade
  nas duas caixas; arquivo estável por cwd; flags; maker e revisor sem `--safe-mode`; nenhum `--safe-mode` em `src/`.
- Chamada real com o argv do maker numa cópia sob `~/.ade/lanes`: resposta pelo schema e nenhuma instrução nem
  memória do operador no contexto (2026-09-26).

## Trade-offs

- Hooks do `.claude/settings.json` do projeto passam a rodar nas chamadas despachadas. É desejado (a regra do
  repositório vale para quem trabalha nele), mas um hook lento do projeto pesa em cada chamada.
- A listagem de skills nativas volta a ocupar contexto (cerca de 20 descrições curtas).

## Alternativas rejeitadas

- **Manter o `--safe-mode`**: o maker não vê a receita do projeto (`run-*`, `verify`) nem os hooks do motor.
- **`--setting-sources ""` no maker**: tira também as skills e instruções do projeto.
- **Limpar a configuração global do operador**: o motor não pode depender de como o usuário configura a própria
  CLI; o isolamento tem de valer em qualquer máquina.

## Como reverter

Trocar o corpo de `isolationArgs` por `['--safe-mode']` volta ao comportamento dos ADRs 0009 e 0011; a prova de
`src/` sem `--safe-mode` precisa sair junto.

## Consequências para outros documentos

Os ADRs 0009, 0011 e 0019 não foram editados; onde falam em `--safe-mode`, vale este ADR.
