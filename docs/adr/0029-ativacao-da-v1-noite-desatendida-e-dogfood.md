# ADR 0029 — Ativação da v1: Noite desatendida, dogfood e calibração por telemetria

**Status:** Aceito (confirmado por Erick em 2026-09-22)

## Contexto

O roadmap normativo (`docs/roadmap.md` §6) e a autorização expressa concedida por Erick em 2026-09-19 ([ADR 0024](0024-autorizacao-roadmap-ate-v1.md)) estabelecem a continuidade da execução autônoma sequencial dos marcos até a v1:
`v0.2 -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1`.

A v0.5 entregou com sucesso a pesquisa externa controlada via subsistema dedicado com adapter `agy` somente-leitura e canário, telemetria auditável por chamada de modelo com métricas de harness doctor, drenagem cooperativa (`RUNNING -> DRAINING -> STOPPED`), pausa, retomada com revalidação e intervenção do operador (takeover com terminal PTY embutido no painel), formalizada no [ADR 0028](0028-ativacao-da-v05-pesquisa-telemetria-intervencao.md).

O passo final do roadmap é a **v1 — Jornada 6 e hardening (D5 pleno)**. A v1 concretiza a capacidade da ADE de conduzir o próprio desenvolvimento de forma autônoma durante uma noite inteira ("continue enquanto durmo"), validada por suíte de dogfood executável sem rede, calibração determinística de limites e corte visual orientada por telemetria medida, e consolidação documental de operações, segurança e evals.

Em cumprimento às regras de governança e imutabilidade de decisões aceitas (ADRs 0001 a 0028), este ADR emenda a autorização do ADR 0024 para formalizar a ativação exclusiva do marco v1 antes de qualquer código novo em `src/`, fixando o escopo normativo, precondições duras e limites operacionais.

## Decisão

Formalizar a ativação do marco final **v1** sob a emenda à autorização contínua do ADR 0024, fixando as seguintes diretrizes e limites normativos:

1. **Ativação da v1 e emenda ao ADR 0024:**
   - A autorização de Erick concedida em 2026-09-19 para execução sequencial dos marcos é estendida à v1 como emenda formal registrada neste ADR 0029, preservando intacto o texto do ADR 0024.
   - A ordem obrigatória dos marcos é rigorosamente mantida: `v0.2 -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1`.
   - A ativação da v1 precede qualquer código novo, garantindo conformidade com a carta do projeto.

2. **Noite desatendida (`ade run --unattended`) com precondições duras:**
   - O modo desatendido `--unattended` é estritamente opt-in; nenhum fluxo padrão ou existente de `ade run` tem seu comportamento alterado, preservando as provas de durabilidade já verdes.
   - Precondições duras obrigatórias antes do despacho desatendido:
     - Portões (gates) de integridade e revisão ativos e validados;
     - Baseline de evals totalmente verde antes do início;
     - Ponto de restauração e rollback garantido em `refs/ade/`;
     - Isolamento estrito por worktree comprovado por canário.
   - Recusa por descumprimento de precondição dura encerra o processo com **exit 2**, conforme a tabela única de exit codes da master-spec §4.
   - Orçamento de parede (`max_wall_clock_seconds`, padrão de 8 horas / 28.800 s) e teto de unidades estacionadas (`max_parked_units`, padrão de 3 unidades) configurados em `plan.mission_budget`. O orçamento de parede encerra o lote de forma ordenada, jamais interrompendo uma story no meio de sua execução.
   - Durante a noite desatendida, o motor avança unicamente stories pré-aprovadas no plano congelado (`approved_plan`). Qualquer story bloqueada é estacionada em `awaiting_operator` com o motivo de parada gravado no journal; replanejamento ou alteração contratual sem aprovação do operador é categoricamente proibido.
   - Relatório matinal (`ade report`) disponibilizado ao final da execução com o motivo de cada unidade estacionada, contendo caminhos absolutos auditáveis abríveis com `ade show <ref> --open`.
   - Conclusão da noite com unidades estacionadas ou pendentes de operador sai obrigatoriamente com **exit 3**, nunca 0.

3. **Fallback de encerramento de processos no Windows:**
   - O encerramento da árvore de processos utiliza `taskkill /T /F /PID` com `maxBuffer` explícito e `shell: false`.
   - Caso `taskkill` seja recusado pelo sistema operacional (EPERM), o motor aciona o fallback limitado de encerramento e registra o evento `terminated_by` no journal, assegurando que o lote desatendido não fique travado por workers órfãos.
   - Nenhuma decisão do motor depende do resultado do fallback, preservando integralmente a vigência e a redação do [ADR 0025](0025-fallback-da-arvore-de-processos-windows.md).

4. **Suíte de dogfood (20–50 tarefas, runs: 3, pass^3):**
   - A suíte de dogfood da v1 roda como suíte Vitest do próprio repositório, executada localmente com CLI falsa e repositório bare temporário em diretório de rascunho/temporário.
   - Descartada a criação de um comando CLI `ade dogfood` próprio, mantendo a superfície de comandos enxuta e focada.
   - Critério de estabilidade: execução de 20 a 50 tarefas representativas cobrindo os 5 grupos obrigatórios (tradutor, jornadas, visual, estritez e durabilidade), exigindo `runs: 3` e `pass^3` (três execuções consecutivas com 100% de aprovação).
   - Proibição absoluta de chamadas de rede externas e operações contra o GitHub real nos testes de dogfood.

5. **Calibração de corte visual e tetos de contexto pela telemetria:**
   - Ajuste determinístico dos limites de contexto (`limits.max_pack_bytes` e `review.max_diff_bytes`) com base no percentil p90 medido na telemetria acumulada, substituindo valores provisórios.
   - Calibração do corte visual com base em dados observados: `escaped_visual_defects > 10 %` em 20 stories ajusta a nota de corte para 8,0; `awaiting_operator` em trabalho aprovado de primeira ajusta o corte para 7,0.
   - A calibração de limites e corte visual gera propostas registradas como evento durável no journal e só se torna efetiva após alteração explícita de configuração aprovada pelo operador em `ade-config`, pois portões e configurações pertencem ao plano de controle e não sofrem merge automático.

6. **Fechamento da documentação de operações, segurança e evals:**
   - Consolidação de guias operacionais em `docs/operations/` (autonomia, permissões e uso em outros projetos);
   - Consolidação das políticas e mecanismos de segurança em `docs/security/` (isolamento, contenção, quarentena de segredos e SkillGuard);
   - Consolidação da matriz de testes e rigor em `docs/evals/` (catálogo de evals e critérios de aprovação).

7. **Exclusões estritas (backlog pós-v1 proibido em `src/`):**
   - Continuam rigorosamente fora do escopo e proibidos em `src/` e `packages/`:
     - Protocolo ACP (Agent Client Protocol) e steering intra-turno;
     - Execução concorrente N>1 com fila de merge;
     - Rotinas autônomas agendadas em background;
     - Ablação automática de harness (Caliper);
     - Controle de pressão por provedor (`ProviderRateController`);
     - Mapa semântico de domínio sobre o IR (Understand-Anything);
     - Gateway local multi-provedor (OmniRoute);
     - Arquiteto/editor em dois passos;
     - 4º provider de modelo (OpenCode);
     - Exportador OpenTelemetry (OTel);
     - Memória persistente por usuário;
     - CI loop com `ci_query` e `ci_rerun` ativos contra CI remoto;
     - Empacotamento Tauri para o painel;
     - Plugin anti-slop do oxlint;
     - Operações de escrita/push/PR/merge remotas contra o GitHub real.
   - O diretório `proto/**` permanece intocado, servindo apenas como referência estática.

## Evidência

- Autorização original de Erick em 2026-09-19 ([ADR 0024](0024-autorizacao-roadmap-ate-v1.md)): *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
- `docs/roadmap.md` §6 define o escopo canônico da v1: jornada 6 desatendida (`ade run --unattended`), suíte de dogfood com runs: 3 e pass^3 como suíte Vitest, calibração por telemetria e fechamento documental.
- Tabela única de exit codes em `docs/specs/2026-09-17-master-spec.md` §4: exit 2 para precondição violada ou parada final; exit 3 para conclusão com paradas pendentes do operador.

## Trade-offs

- **Positivo:** Permite a conclusão autônoma do roadmap da TL-ADE com garantias formais de segurança, contenção de orçamento e ausência de efeitos colaterais descontrolados durante a noite.
- **Positivo:** A suíte de dogfood em Vitest com CLI falsa e repositório bare garante reprodutibilidade hermética sem dependência de rede ou credenciais de serviços externos.
- **Risco controlado:** Operações autônomas noturnas podem esgotar orçamentos ou acumular paradas; mitigado pelo orçamento rígido de tempo de parede, teto estrito de unidades estacionadas (`max_parked_units: 3`) e saída explicada com exit 3.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Editar o ADR 0024 para incluir a v1 | Descartado: viola a regra inegociável de imutabilidade de ADRs já aceitos estabelecida no AGENTS.md e na governança do projeto. |
| Implementar código da v1 antes da governança | Descartado: a carta do projeto rejeita categoricamente qualquer código em `src/` fora do recorte ativo. |
| Tornar `--unattended` obrigatório em todo `ade run` | Descartado: `--unattended` é opt-in; os fluxos interativos e provas duráveis existentes devem permanecer intocados. |
| Replanejamento automático durante a noite | Descartado: o operador é o portão exclusivo de aprovação de contratos; sem operador, a unidade bloqueada deve estacionar em `awaiting_operator`. |
| Motor reescrever automaticamente seus próprios limites | Descartado: `ade-config` é plano de controle; a telemetria produz proposta registrada no journal, que exige aprovação explícita. |
| Criar comando CLI `ade dogfood` separado | Descartado: a suíte de dogfood deve rodar como suíte Vitest padrão do repositório, evitando proliferação desnecessária de comandos na CLI. |
| Criar novo exit code para o modo desatendido | Descartado: a master-spec §4 já define a tabela única de códigos de saída (exit 2 para precondição recusada e exit 3 para paradas). |

## Como reverter

1. Revogar formalmente este ADR por determinação de Erick.
2. Desativar a flag `--unattended` na CLI do motor.
3. Restaurar o escopo ativo anterior (v0.5) na carta do projeto e no roadmap.

## Consequências para outros documentos

- `PROJECT_CHARTER.md`: atualizado para refletir o recorte ativo da v1, registrando a v0.5 como entregue e mantendo as exclusões de pós-v1.
- `docs/roadmap.md`: atualizado com a v0.5 entregue em §5 e a v1 como recorte ativo em §6 e na seção de estado.
- `docs/adr/README.md`: inclui o ADR 0029 no índice geral de ADRs com status aceito.
- `README.md`: reflete a ativação da v1 e o estado de entrega da v0.5.
