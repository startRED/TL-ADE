# Melhorias do motor inspiradas no workflow do JavaScript Mastery

Fonte: repositório `jsmastery-pro/skills` (licença MIT, commit `43b69e4`), lido por inteiro em 17/09/2026 por quatro
leitores, mais uma auditoria do `proto/server.mjs`. As ideias abaixo são relato dos leitores com citação de arquivo;
nenhuma foi conferida linha a linha no repositório deles. O que é deles é só fonte de ideia: tudo aqui é mudança no TL-ADE.

O workflow deles é manual (nove skills disparadas por uma pessoa). Não tem motor, teto, cota, retomada após queda,
escada de modelos nem journal. O que ele faz melhor: conhecimento em arquivos do repositório, critérios de aceite
numerados como fio único, e regras de prompt muito específicas.

## Pacotes, em ordem de retorno

### P1. Fio dos critérios de aceite (plano, validadores, revisor)
- Cada critério ganha id estável (`CA-1`). Cada passo da `recipe` declara `satisfies: [CA-n]`. Cada `example` cita o critério que comprova.
- Validador mecânico: critério sem passo e passo sem critério reprovam o plano.
- Toda parte com 2 ou mais critérios tem um de caminho feliz e um de borda ou falha.
- Critério descreve resultado observável de fora, nunca passo de implementação.
- Achado do revisor cita um critério ou uma decisão; tem três campos (problema, por que importa, correção sugerida em palavras, nunca código) e campo opcional de pontos fortes.
- Severidade com definição literal: high = defeito, segurança, perda de dado ou contrato quebrado; medium = problema real que incomoda em breve; low = detalhe. Regra contra inflação e contra esconder defeito como detalhe; separar "está errado" de "eu preferiria"; não repetir o mesmo achado por arquivo.
- Rubrica ordenada do revisor: corretude, segurança, tratamento de erro, desempenho, contrato, manutenção, aderência às decisões, adequação das provas (inclui prova que só verifica mock).

### P2. Origem dos valores e decisão devida (planejador, crítico, quem escreve, correção)
- Planejador: para cada parte, nomear a origem de todo valor que ela produz, calcula ou exibe (parâmetro, campo, decisão anterior).
- Crítico do plano: tarefa principal é achar valor exigido por critério cuja origem o plano não nomeia, e decisão que quem implementa teria de inventar. Todo achado vem com correção recomendada. Dois baldes: decisão que falta (bloqueia) e clareza (sugestão).
- Crítico: tabela de erros conhecidos do nosso domínio (spawn sem `maxBuffer`, erro fora de `AdeError`, mudança de schema sem parte própria, item novo na raiz, fila por unidade ignorada).
- Crítico: sinalizar parte que depende de comportamento que nenhuma decisão ou ADR registra.
- Validadores novos: texto de enfeite em campo obrigatório ("TBD", "a definir", "..."); parte cujo único critério é "decidimos usar X".
- Quem escreve: antes de implementar, listar os valores; valor sem fonte é decisão devida. Nunca "use seu julgamento": ou para e sinaliza, ou registra a suposição explícita e segue. Na dúvida, é devida.
- Motor: guardar as suposições na parte, mostrar no Quadro, entregar ao revisor.
- Parte de correção pode responder "o contrato está errado": o motor manda a parte ao planejador em modo edição, em vez de gastar rodadas de código.
- Planejador: questionar a premissa do pedido contra os erros conhecidos e registrar a ressalva, sem bloquear.

### P3. Conhecimento durável (arquivo de decisões, sincronização, batedor)
- Decisões de cada épico gravadas em arquivo do projeto, numerado, com status; nunca reescrito: revisão cria outro que substitui e aponta para o antigo.
- Decisão com rastro: escolha, motivo em uma linha, alternativa descartada, o que se perde. Crítico rejeita decisão sem perda declarada.
- `follow_up` no plano: pendência que não virou parte fica registrada e vira linha do quadro.
- Épico com `done_when` de uma linha, resultado observável.
- Passo de sincronização ao fechar épico: padrão é não fazer nada ("nada a sincronizar" é resultado bom); idempotente (reler antes de escrever); edição cirúrgica; só marca decisão como desatualizada citando o ponto do código que a contradiz.
- Planejador dos épicos seguintes recebe o arquivo de decisões; o batedor deixa de responder "o que os épicos anteriores deixaram".
- Batedor com contrato de tamanho: arquivos a tocar, padrões `símbolo@linha`, pegadinhas; sem trecho de código nem narração; 1 a 2 mil tokens; teto numérico de leituras.

### P4. Verificação real contra os critérios (etapa nova)
- Para CLI e backend, o motor roda o comando real por critério e captura comando exato, código de saída e trecho da saída, sem modelo. Um modelo só julga depois.
- Quatro vereditos por critério: atendido, especificado mas ausente, especificado mas não aplicado, bloqueado.
- Sem evidência citada, não é atendido. Se o programa não rodou nesta rodada, nada passa. Ferramenta indisponível é bloqueio. Listar o que não foi checado. Aprovação fabricada é o único resultado proibido.
- Reprovação na verificação segura a parte mesmo com a suíte verde.
- Parte de refatoração: rodar antes (worktree no commit anterior, nunca `stash`) e depois, e comparar saídas.
- Matar todo processo iniciado ao terminar.

### P5. Prompt de prova
- Estender o arquivo de prova do módulo; nunca criar paralelo; nunca reescrever prova antiga em silêncio.
- Nome de prova é frase; um conceito por prova; preparar, agir, conferir.
- Testar a interface pública e a saída observável, nunca estado interno.
- Mock só na fronteira (processo, relógio, arquivos, rede); nunca no que é nosso.
- Determinística; relógio congelado quando o tempo importa; todo `await` presente.
- Nunca afrouxar asserção nem mudar o código-fonte só para passar; vermelho que sobra é defeito a registrar.
- Ordem de cobertura: caminho feliz, bordas, erros, transições de estado.
- Casos adversos automáticos por sinal de risco no arquivo (`execFile`, `spawnSync`, hash, canonicalização): entrada maliciosa, buffer estourado, hash adulterado.
- Nas rodadas de correção, reexecutar só o arquivo que falhou; suíte inteira no fim.

### P6. Prompt de correção (protocolo de depuração)
- Explicar por que está errado antes de mudar qualquer linha.
- Reprodução determinística primeiro; sem reprodução, instrumentar e dizer isso.
- Uma hipótese falseável por vez, sobre a causa e não o sintoma; experimento mínimo; hipótese refutada é descartada e a mudança desfeita.
- Correção mínima na causa provada; sem refatoração de carona.
- Depois: prova de regressão que falha sem a correção; procurar o mesmo padrão em outros lugares.

### P7. Prompt de implementação e commit
- Seguir o padrão que o código já usa; padrão novo é decisão, não detalhe.
- Falhar fechado na fronteira; erros pelo padrão existente; invariantes valem sob concorrência; retries limitados e idempotentes; falhar alto se falta segredo ou configuração.
- Código substituído não convive com o novo: o motor faz `grep` dos símbolos removidos e roda typecheck e lint depois.
- Regras de produto web (paginação, limite de taxa, autorização por objeto, migração em etapas) só para projetos desse tipo.
- Commit de uma linha, sem corpo; o porquê fica no contrato. Procurar padrão de segredo no diff antes de commitar. Toda afirmação de resumo se apoia no diff.

### P8. Custo e contexto
- Skills injetadas com orçamento de bytes por combinação real de chamada, com folga de 10%; estourou, corta.
- Carregamento por gatilho: skill só entra quando a parte casa com o gatilho, em vez de sempre inteira.
- Auditoria dos nossos prompts pela regra "toda linha muda o que o agente faz"; regra dita uma vez.
- Journal em unidades de custo ponderadas (saída 5, escrita de cache 1,25, entrada 1, leitura de cache 0,1): cortar saída e entrada nova primeiro.
- Frase final de quem escreve curta: manchete, o que mudou, avisos só se houver.

### P9. Profundidade e ordem de entrega
- Nível por missão (Protótipo, Alfa, Beta, GA) com exceção por épico; o último estágio do nível fecha o "pronto".
- Abordagem de entrega declarada (fio fino de ponta a ponta, menor produto usável, fachada primeiro, uma jornada por vez) e `depends_on` coerente com ela.
- Fundações antes de funcionalidades; projeto herdado: o que existe entra como existente ou parcial, nunca como pronto.
- Marcar épico que exige decisão de arquitetura antes do plano.

### P10. Interface
- Lista negativa no portão visual: formulário solto no centro, área morta, elemento sem estilo, estado ausente, controle órfão.
- Contraste (4,5:1 e 3:1) e alvo de toque (44 por 44) por script, sem modelo.
- Estados por elemento interativo; token faltante vira token novo, nunca valor solto; paleta derivada e verificada, nunca de memória.
- Quem implementa se audita contra a lista antes do portão; dado falso marcado de forma inconfundível.

### P11. Git e retomada
- Guardar trabalho não commitado com `stash` e avisar, em vez de descartar.
- Conferir se o branch está atrás do remoto antes de começar.
- Commit pela lista de arquivos da parte, não `git add -A`.
- Só marcar como feito o que foi verificado nesta rodada; interrupção deixa aberto.

## Não se aplica a motor automático
Consentimento interativo antes de buscar ferramenta; regras de tom para leitor humano; escolha do modelo do revisor por
pergunta (o par de fornecedores já é fixo); monorepo; modelos de PR, changelog e postmortem (baixo retorno agora);
`AGENTS.md` aninhado por pasta.

## Ordem sugerida
1. P5, P6 e P7: só texto de prompt, efeito imediato nas rodadas.
2. P1 e P2: mudam o schema do plano e os validadores; entrar entre dois épicos.
3. P3: arquivo de decisões e sincronização.
4. P4: etapa nova, a maior.
5. P8, P9, P11, P10.
