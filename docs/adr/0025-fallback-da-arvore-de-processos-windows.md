# ADR 0025 — Fallback de encerramento da árvore de processos no Windows sob EPERM

**Status:** Aceito (confirmado por Erick em 2026-09-20)

## Contexto

No Windows 11 nativo, o mecanismo primário de encerramento forçado da árvore de processos de um worker é a execução síncrona de `taskkill /T /F /PID <pid>` (ADR 0022). Em determinadas execuções observadas no ambiente, a invocação do `taskkill` falhou com `code === 'EPERM'`, gerando bloqueio na contenção dos processos.

Anteriormente, o tratamento de erro engolia qualquer exceção de `taskkill` silenciosamente e retornava `undefined`, o que impedia distinguir se o processo já havia saído, se houve falha de permissão não contida ou se ocorreu outro erro inesperado do sistema operacional.

O operador Erick autorizou expressamente a correção limitada dessa contenção para desbloquear a durabilidade e o portão de cobertura da v0.2, mantendo os 93 casos sem skips.

## Decisão

Com base na autorização geral concedida por Erick em 2026-09-20:

1. **Preservação de `taskkill` como primário:** Manter `taskkill /T /F /PID <pid>` como a primeira tentativa para encerrar a árvore de processos no Windows, retornando `{ terminated_by: 'taskkill' }` em caso de sucesso.
2. **Fallback pontual para Job Object sob EPERM:** Caso a execução de `taskkill` lance erro com `code === 'EPERM'`, caso haja referência do processo filho não-destacado com método de encerramento (`child.kill`), invocar `child.kill('SIGKILL')` e retornar explicitamente `{ terminated_by: 'job_fallback' }`. O encerramento do processo raiz aciona o Job Object do Windows gerenciado pelo libuv com `KILL_ON_JOB_CLOSE` (ADR 0022 W7), garantindo o encerramento de toda a árvore de descendentes. Quando não houver filho encerrável, a falha `EPERM` é propagada sem mascaramento.
3. **Reconhecimento determinístico de processo já encerrado:** Se o erro apresentar `status === 128` ou mensagem textual indicando que o processo não existe / não foi encontrado, retornar `{ terminated_by: 'already_exited' }`.
4. **Falha fechada para erros inesperados:** Quaisquer outros erros na execução de `taskkill` são relançados imediatamente sem mascaramento.
5. **Semântica POSIX explícita:** Para plataformas não-Windows (`platform !== 'win32'`), se `child` estiver presente, invocar `child.kill('SIGKILL')` e retornar `{ terminated_by: 'sigkill' }`; se ausente, retornar `{ terminated_by: 'already_exited' }`.
6. **Escopo estrito:** Não alterar estados, recibos, cobrança, contenção de arquivos ou políticas de aprovação.

## Evidência

- Provas de paridade em `tests/parity/windows-durability.test.ts` comprovando:
  - Resposta `{ terminated_by: 'taskkill' }` sem chamar `child.kill` no sucesso;
  - Resposta `{ terminated_by: 'job_fallback' }` com envio de `SIGKILL` quando `execFileSync` falha com `code: 'EPERM'` e há processo filho encerrável;
  - Falha fechada relançando `EPERM` quando `child` não está disponível ou não expõe `kill`;
  - Resposta `{ terminated_by: 'already_exited' }` para código 128 ou texto de processo inexistente;
  - Relançamento de exceções inesperadas (`EACCES`);
  - Limpeza real de processos em timeout garantindo que pai e neto deixam de existir em até 1,5 segundo.

## Trade-offs

- Preserva a contenção estrita no Windows sem mascarar falhas inesperadas do ambiente;
- Garante observabilidade explícita para o Runner e testes sobre qual estratégia encerrou a árvore de processos;
- Mantém dependência do Job Object do libuv quando `taskkill` for bloqueado por políticas de permissão.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Substituir integralmente o `taskkill` por `SIGKILL` no Windows | Descartado: `taskkill` continua sendo a contenção primária mais abrangente no Windows |
| Continuar engolindo todo erro e retornar `undefined` | Descartado: mascara erros graves de infraestrutura e impede verificação determinística de contenção |
| Paralisar a sessão automática aguardando nova confirmação | Descartado: a autorização geral para expansão e correção de contenção já foi concedida por Erick |

## Como reverter

Restaurar a implementação anterior em `src/runner/spawn.js`, removendo o fallback para `SIGKILL` sob `EPERM` e o retorno tipado `{ terminated_by: ... }`.

## Consequências para outros documentos

- `docs/adr/README.md`: adiciona a entrada 0025 no índice de ADRs e mapeia sob a seção "Durabilidade e recuperação".
