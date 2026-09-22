# ADR 0028 — Ativação da v0.5: Pesquisa externa controlada, telemetria auditável e intervenção do operador (pausa, retomada, takeover)

**Status:** Aceito (confirmado por Erick em 2026-09-21)

## Contexto

O roadmap normativo (`docs/roadmap.md` §5) e a autorização expressa concedida por Erick em 2026-09-19 ([ADR 0024](0024-autorizacao-roadmap-ate-v1.md)) estabelecem a continuidade da execução autônoma sequencial dos marcos até a v1:
`v0.2 -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1`.

A v0.4b entregou o painel local escuro e acessível, a projeção SQLite reconstruível e o servidor local protegido. A etapa seguinte, **v0.5**, cumpre os objetivos do nível D5 da escada de dogfood: tornar missões longas auditáveis e interrompíveis com preservação total de estado. Isso exige pesquisa externa controlada para resolução de incógnitas de fatos externos, telemetria granular por chamada de modelo com governança de custos e citação de skills, drenagem cooperativa (`RUNNING -> DRAINING -> STOPPED`), pausa e retomada com revalidação de contrato, e assunção manual pelo operador (takeover) com terminal interativo embutido no painel.

Em conformidade com as regras de governança da TL-ADE, decisões arquiteturais anteriormente aceitas (ADRs 0001 a 0027) permanecem imutáveis, e a ativação de cada novo marco deve ser formalizada por um novo ADR e pela atualização correspondente do charter e do estado público.

## Decisão

Formalizar a ativação exclusiva da **v0.5** sob a autorização contínua até a v1, fixando as seguintes diretrizes e limites normativos:

1. **Ativação exclusiva da v0.5 e fontes de verdade canônicas:**
   - A autorização geral concedida no ADR 0024 autoriza a sequência dos marcos, mas não constitui ativação simultânea ou implícita de marcos futuros; a v0.5 é ativada isoladamente neste épico.
   - `plan.json`, `journal.jsonl` e `artifacts/` permanecem como as únicas fontes de verdade autoritativas e canônicas do sistema. O banco SQLite derivado (`.ade/index.sqlite`) e a interface web atuam estritamente como projeção reconstruível sem estado autoritativo próprio.

2. **Pesquisa externa controlada como subsistema:**
   - A pesquisa é executada exclusivamente para incógnitas do tipo `external_fact` declaradas nos Task Contracts (`unknowns[].kind: 'external_fact'`); fatos de repositório (`repo_fact`) e decisões de produto (`product_choice`) não disparam pesquisa externa.
   - Tetos estritos por classe de complexidade:
     - `trivial`: nunca pesquisa (0 consultas);
     - `bounded`: no máximo 1 consulta direta, sem time paralelo;
     - `feature` ou superior (`subsystem`, `project`): até 3 consultas controladas.
   - Time de pesquisa com 2 a 4 participantes paralelos é permitido exclusivamente por opção explícita em nível de `subsystem` ou `project`; qualquer divergência ou empate entre pesquisadores é transformado em pergunta direta ao operador no painel, sem votação automática.
   - O adapter de pesquisa `agy` (v0.x) opera estritamente em modo somente-leitura com canário de isolamento (`--add-dir` e verificação de integridade). Qualquer tentativa de escrita fora do diretório autorizado detectada pelo canário desabilita imediatamente o `agy`. Fallback para outra família só é admitido se expressamente pré-autorizado e comportado pelo orçamento; caso contrário, a unidade de trabalho é estacionada (`parked`).
   - Todo achado de pesquisa (`research_finding`) é tratado categoricamente como dado não confiável: passa obrigatoriamente pela cerca de entrada (`firewall`) e é inserido em seção própria do Context Pack, jamais diretamente como instruções ou regras de agente.

3. **Telemetria auditável, governança de custos e poda do harness:**
   - Registro de telemetria completa por chamada de modelo (`model_call`), com campos: `models: { role: 'executor' | 'advisor', model_id }[]`, `duration_ms`, `ttft_ms`, `outcome`, `pack_bytes`, `pack_sections[]`, `approval_decisions`, `network_attempts`, `files_touched` e `skills_injected[]` (contendo `sha256` do conteúdo injetado e `source: 'catalog@<commit>' | 'local'`).
   - Custos não observados são registrados como `unknown` (com flag `cost_source: 'reported' | 'unknown'`), sendo categoricamente proibido inventar tabelas de conversão monetária local.
   - Não se registram `compaction_events`, dado que o ciclo de sessão nova por chamada, turno único e pack limitado elimina a compactação em tempo de execução.
   - Evento de consolidação final emitido no journal com `telemetry.scope: 'mission_summary'`.
   - O harness doctor opera em modo de coleta nas sete categorias normativas — Tool Coverage, Context Efficiency, Quality Gates, Memory Persistence, Eval Coverage, Security Guardrails e Cost Efficiency — sem poda automática por mera presença de arquivo. Sua primeira métrica é `cache_read / (tokens_in + cache_read)`, apurada separadamente por papel.
   - Poda por evidência: seção de pack, skill injetada ou regra com índice de citação inferior a 20% (`cited < 20%`) em 20 stories consecutivas é retirada do padrão e movida para opt-in explícito por configuração com registro no journal.
   - Promoção de modelos novos exige cadência de 5 execuções pareadas com e sem cada seção e portão afetado antes de virar default.

4. **Drenagem cooperativa, pausa e retomada:**
   - O processo de execução suporta interrupção cooperativa: a transição de estado ocorre como `RUNNING -> DRAINING -> STOPPED`. Em estado `DRAINING`, o motor não despacha novas tarefas, conclui com segurança ou realiza checkpoint da etapa corrente e atinge `STOPPED`. Interrupção abrupta do processo de motor é rejeitada.
   - A retomada de uma missão pausada ou interrompida sempre revalida a cadeia de aprovação, o lease de processo, a versão do plano/contratos e o orçamento remanescente antes de continuar do último ponto durável registrado no journal.
   - As ações disparadas pelo operador no painel são solicitações duráveis autenticadas, mas qualquer passo é gravado no journal pelo coordenador ativo antes do efeito colateral, mantendo o invariante de escritor único.

5. **Intervenção do operador (takeover) e terminal embutido (PTY):**
   - O controle manual pelo operador (takeover) só pode ser iniciado quando a story/missão estiver em estado `STOPPED`, reutilizando a sessão e o worktree da story. Durante o takeover, o motor suspende despachos de modelo e assegura contenção para evitar escritas concorrentes entre humano e agentes.
   - O encerramento da árvore de processos do terminal no Windows utiliza obrigatoriamente `taskkill /T /F /PID` com `maxBuffer` explícito e sem invocação de shell, conforme a autorização de correção limitada; nenhuma rotina de decisão depende de `pty.kill()`, mitigando riscos de terminação de PIDs alheios.
   - O fechamento da janela do navegador ou a desconexão do WebSocket não encerra o takeover nem retoma a missão automaticamente; a devolução do controle ao motor requer a ação humana deliberada de encerramento via interface, gerando checkpoint e o evento durável `human_release`.

6. **Exclusões estritas:**
   - Estão expressamente fora de escopo e proibidos em `src/` durante a v0.5:
     - Transporte ACP (Agent Client Protocol);
     - Execução concorrente de múltiplas stories simultâneas (N>1 / N > 1);
     - Rotinas e rotinas em background ou agendamentos desatendidos da v1;
     - Exportação OTel (OpenTelemetry);
     - Operações remotas no GitHub real (push, pull request, merge);
     - Quaisquer outras capacidades reservadas para a v1 e versões futuras.

7. **Proibição de alteração em `proto/`:**
   - O diretório `proto/**` permanece estritamente como referência estática histórica e jamais deve ser editado ou reutilizado como código de produção.

## Evidência

- Autorização expressa de Erick em 2026-09-19 no [ADR 0024](0024-autorizacao-roadmap-ate-v1.md): *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
- `docs/roadmap.md` §5 (v0.5) define Must (adapter `agy` somente-leitura com canário, pesquisa como subsistema por `external_fact`, telemetria por chamada, doctor em coleta, drenagem `RUNNING -> DRAINING -> STOPPED`, poda de harness) e Should (takeover com PTY embutido no painel).
- Análise de riscos e pesquisas de base: Digest #29 (instabilidade de node-pty e mitigação por taskkill) e Digest #38 (canário de escrita fora do diretório autorizado para agy).

## Trade-offs

- **Positivo:** Operador obtém controle completo sobre o ciclo de vida da missão, com capacidade de pausar, auditar o consumo real de recursos por modelo/skill e intervir diretamente via terminal sem corromper o estado do repositório.
- **Positivo:** A pesquisa externa fica contida dentro de tetos previsíveis de custo e restrita a dados não confiáveis, prevenindo injeções de contexto maliciosas.
- **Risco controlado:** A introdução de terminal embutido no Windows traz riscos de processos órfãos; esses riscos são mitigados pela contenção de leases, encerramento forçado da árvore (`taskkill /T /F /PID`) e ausência de dependência em chamadas instáveis de `pty.kill()`.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Ativação implícita de todos os marcos até a v1 | Descartado: a governança exige ativação isolada e sequencial por marco através de ADR e charter específicos. |
| Votação automática em time de pesquisa | Descartado: divergência entre modelos sobre fatos externos deve ser decidida pelo operador humano, não por maioria estatística arbitrária. |
| Aceitar achados após violação do canário de `agy` | Descartado: isolamento e contenção de segurança prevalecem sobre a conveniência de manter a execução. |
| Interrupção abrupta no lugar de drenagem cooperativa | Descartado: matar processos no meio do ciclo causaria perda de recibos, violação de integridade do journal e potenciais escritas duplicadas. |
| Estimativa local de custo do Codex com tabela monetária | Descartado: a arquitetura admite apenas `reported` ou `unknown`; inventar conversões mascararia a auditoria financeira. |
| Preservação de `compaction_events` | Descartado: sessões de turno único e contexto delimitado tornam a compactação inexistente no desenho do sistema. |
| Retomada automática ao desconectar o navegador no takeover | Descartado: queda de conexão não prova intenção do operador; a entrega de controle deve ser um ato deliberado com `human_release`. |

## Como reverter

1. Revogar formalmente este ADR por determinação de Erick.
2. Desativar os endpoints e rotas de pausa, retomada, takeover e PTY no painel.
3. Desabilitar a invocação do subsistema de pesquisa em `src/intent/research.js` e o adapter `agy`.
4. Reverter o formato de telemetria para a estrutura reduzida anterior.

## Consequências para outros documentos

- `PROJECT_CHARTER.md`: atualizado para o recorte ativo da v0.5, autorizando pesquisa controlada, telemetria, drenagem cooperativa, pausa, retomada e takeover com terminal.
- `docs/roadmap.md`: registra a v0.5 como o marco ativo em execução na seção de estado e autorização.
- `docs/adr/README.md`: inclui o ADR 0028 no índice geral e mapeamento temático de governança.
- `README.md`: atualizado com o estado público da v0.5 e descrição das capacidades autorizadas.
