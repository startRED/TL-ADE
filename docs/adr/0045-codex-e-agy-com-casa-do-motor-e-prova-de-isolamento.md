# ADR 0045 — Codex e agy com casa própria do motor e prova de isolamento em cada máquina (complementa o ADR 0044)

**Status:** Aceito (pedido de Erick, 2026-09-26: sem vazamento para qualquer usuário futuro, não só nesta máquina)

## Contexto

O [ADR 0044](0044-isolamento-pelo-projeto-sem-safe-mode-emenda-0009-0011.md) isola o Claude. Medido na mesma data, com
o argv e o ambiente exatos do motor e perguntas diretas ao modelo sobre o próprio contexto:

- **Codex**: mesmo com `--ignore-user-config --ignore-rules`, o revisor recebia o `~/.codex/AGENTS.md` do operador
  (preferências pessoais de estilo). Não há chave que desligue as instruções globais; `project_doc_max_bytes=0` só corta
  o AGENTS.md do projeto. A memória do Codex (`memories_*.sqlite`) também ficava na pasta do usuário.
- **agy**: carregava o `~/.gemini/GEMINI.md` como `<RULE[user_global]>`. O prefixo "as instruções globais não valem"
  não tira o texto do contexto. O agy não tem flag de isolamento.
- **Claude**: o 0044 só testava a máquina de quem escreveu o motor. Outro usuário pode ter plugins, MCP, skills,
  agentes e comandos que ninguém previu.

## Decisão

1. **Codex roda com `CODEX_HOME=~/.ade/codex-home`** (`src/adapters/codex/home.ts`), uma pasta que só tem o `auth.json`
   ligado por hardlink ao do usuário. O Codex renova o token gravando no próprio arquivo (truncate e write, sem
   rename; lido no código do `codex-rs`), então os dois lados veem a renovação. Se o usuário fizer login de novo, o
   link é refeito na chamada seguinte. Vale para maker, revisor, crítico do plano, juiz visual e chat. A sonda de cota
   continua na pasta do usuário, porque a leitura da cota vem da sessão gravada lá.
2. **Sem `auth.json` (login no keyring) ou sem hardlink possível**, a chamada usa a pasta do usuário e o `ade doctor`
   avisa que as instruções globais entram. O motor não para por isso: continua autônomo.
3. **agy roda com `USERPROFILE`/`HOME=~/.ade/agy-home`** (`src/adapters/agy/home.ts`). O login fica no cofre do
   sistema, não na pasta, e continua valendo (medido).
4. **A sonda real do `ade doctor` prova o isolamento do Claude em cada máquina**: lê o `system/init` em stream-json e
   reprova (`probe_ok: false`, e o motor recusa missão) quando aparece plugin que não é embutido, qualquer MCP, skill
   sincronizada da conta, ou skill, agente ou comando da pasta de configuração do usuário.
5. **Juiz visual, chat e sonda de cota usam o mesmo ambiente fechado do motor** (`buildWorkerEnv`); passam só
   `CLAUDE_CONFIG_DIR` (onde fica o login) e as travas `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` e
   `ENABLE_CLAUDEAI_MCP_SERVERS=false`. O chat do Codex ganha `--ignore-user-config --ignore-rules`, como o maker.

## Evidência

- `tests/codex_home.test.ts`: pasta só com o login; renovação gravada no próprio arquivo vista dos dois lados; religação
  depois de novo login; idempotência entre trilhos; sem `auth.json` não há pasta; aviso do doctor.
- `tests/agy_home.test.ts`: casa do agy é pasta do motor, nunca a do usuário.
- `tests/claude_isolation.test.ts` e `tests/doctor-cli.test.ts`: detector de vazamento e reprovação da sonda.
- Sondas reais em 2026-09-26: Codex e agy sem nenhum termo do AGENTS.md/GEMINI.md do operador; Claude com canários
  plantados em skill, agente, regra, comando e servidor MCP do usuário, sem nenhum vazamento em três pastas diferentes
  (projeto, cópia sob `~/.ade/lanes`, outra unidade).

## Trade-offs

- Ferramentas que o maker do agy roda (git, npm, testes) veem a casa do motor: sem `.gitconfig` global do usuário. O
  motor já dá ao git a configuração que importa, e testes que escrevem em `os.homedir()` deixam de sujar a casa real.
- O e-mail da conta logada continua no contexto do Claude: é o próprio Claude Code que o injeta em toda sessão com
  login por assinatura, sem configuração que desligue.
- Instruções e memória do usuário não aparecem no `system/init`; a prova delas são as flags, os testes deste ADR e
  do 0044 e as sondas manuais descritas acima.

## Alternativas rejeitadas

- **Copiar o `auth.json` para a pasta do motor**: a renovação do token numa cópia invalida o refresh token da outra e
  desloga o usuário.
- **Só o prefixo "ignore as instruções globais"**: o texto continua no contexto, gasta tokens e ainda influencia.
- **Recusar missão quando o Codex não pode ser isolado**: fere a regra de missão sempre autônoma; o doctor avisa.

## Como reverter

Retirar `codexEnvExtras()` e `agyEnvExtras()` das chamadas volta às pastas do usuário; retirar `isolationLeaks` do
doctor volta à sonda que só confere o `session_id`.

## Consequências para outros documentos

Nenhum ADR aceito foi editado; o 0044 continua valendo e este o complementa.
