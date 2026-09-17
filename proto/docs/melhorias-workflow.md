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

---

# Segunda rodada (17/09/2026): OpenSpec, claude-code-best-practice, GSD, BMAD, Headroom, RAGFlow

Lidos por nove leitores Sonnet, somente leitura. Como antes, é relato com citação de arquivo, sem conferência linha a
linha. Licenças: MIT (OpenSpec `bae58cf`, claude-code-best-practice `4b0c0c4`, gsd-core `fb3e228`, BMAD `0a00053`) e
Apache-2.0 (Headroom `b8b222f`, RAGFlow `15b6668`).

## Veredito por repositório

- **OpenSpec:** copiar o formato, não depender da CLI. A atomicidade dele é snapshot em memória mais arquivo de trava,
  mais fraca que o journal do TL-ADE; ele não executa nada (só planeja e mescla markdown). Vale copiar: `MODIFIED` como
  substituição total com recusa se um cenário existente some; ordem fixa RENAMED, REMOVED, MODIFIED, ADDED; marca (hash)
  do estado-base e recusa de escrita se mudou; envelope único de diagnóstico (severidade, código, mensagem, alvo,
  comando de correção); schemas com `additionalProperties: false` (campo desconhecido ignorado em silêncio é fonte
  clássica de defeito); saída `--json` com dependências explícitas mesmo no que já está feito.
- **claude-code-best-practice:** fonte de fatos sobre a CLI. Conferido na máquina: `--fallback-model`,
  `--no-session-persistence`, `--settings`, `--setting-sources`, `--permission-mode`, `-w/--worktree` existem. O motor
  já usa `--safe-mode`, que desliga CLAUDE.md, skills, plugins e hooks: os hooks pessoais do usuário não vazam para as
  sessões do motor, e hooks como portão dentro da sessão não combinam com esse modo; os portões ficam no motor. O
  relatório de limites confirma a janela de 5 horas, mas não traz o texto do erro de limite em modo headless.
- **GSD:** o mais próximo do nosso motor. Vale copiar: classificador de prova vermelha com motivos nomeados (verde
  inesperado, zero provas descobertas, saída diferente de zero sem falha de prova, falha de carga, falha de outra
  prova); prova não vazia (nome de prova diferente do nome do arquivo); escrita durável (write, fsync, close, rename
  com nova tentativa no Windows, fsync do diretório); trava por processo vivo (`process.kill(pid, 0)`), não por idade;
  commit por lista de arquivos; regras de desvio numeradas; verificação orientada a objetivo (existe, é substantivo,
  está ligado); ondas com detecção de arquivos em comum; teto de contexto por plano. Não copiar: 33 agentes, mercado de
  capacidades, instalador para 16 CLIs, modos interativos.
- **BMAD:** já rejeitado como método (ADR 0019). Peças que valem: toda alegação com fonte verificável, senão é
  suposição ou pergunta em aberto; achado que aponta para spec ruim volta ao plano em vez de remendar código; registro
  de triagem de achados que só recebe acréscimos; status lido de arquivo, nunca inferido de texto; retrospectiva de
  épico com visões que nenhuma parte sozinha enxerga; patch do que foi tentado guardado como evidência quando a parte
  é revertida. Não copiar: personas, party mode, PRD longo, customização em camadas.
- **Headroom:** só copiar técnicas. Arrasta Python, núcleo Rust com ONNX e atrito documentado no Windows; o maior ganho
  dele (não reescrever prefixo já em cache) o motor já tem. Técnicas para o firewall de contexto: manter começo, fim e
  linhas de erro com 3 linhas de contexto; deduplicar linhas repetidas; cortar diff por arquivo e por trecho, não no
  meio; guardar o original em arquivo e entregar ponteiro; leitura repetida do mesmo arquivo substitui a anterior.
- **RAGFlow:** não usar no motor (Docker, cerca de 5 contêineres, 16 GB de RAM; trata código como texto puro, sem
  AST). Como componente de produto só quando o projeto precisa de OCR, layout e tabelas em volume. Para a base de
  decisões e lições do próprio projeto, `rg` com índice pequeno basta até a casa de mil documentos.

## Aplicado na demo em 17/09/2026

| Commit | O que entrou |
| :--- | :--- |
| `ea5d4c4` | API só aceita o painel local; tempo esgotado mata a árvore de processos; crítica do plano só conta se respondeu; referência de provas atualizada a cada parte; pausa por cota do Claude; aviso de diff cortado e de prova vermelha que sumiu |
| `4c8c0f2` | Prompts: qualidade da prova; suposição declarada (`SUPOSIÇÃO:`), guardada pelo motor e julgada pelo revisor; depuração nas rodadas com prova vermelha; saída `CONTRATO ERRADO:` sem gastar rodadas; revisor com critérios numerados e regra contra inflação; quem escreve roda só o arquivo de prova da parte |
| `b885829` | `--no-session-persistence`; processos filhos sem atualização automática nem telemetria |
| `8429be3` | Plano: origem nomeada de cada valor; critérios observáveis com caminho feliz e borda; rastreio `[CA1]` conferido pelo motor; decisão com motivo; decisões dos épicos anteriores entregues aos seguintes; crítico caça valor sem origem e violação do AGENTS.md; planejador pode recusar pedido do crítico; pacote não nomeado não se instala; marcadores de dívida vão ao revisor |
| `186e6e1` | Arquivos alterados conferidos contra o contrato; suíte que estoura o tempo não vira prova vermelha; missão gravada por temporário mais rename; arquivo de segredo fora do commit |

## Falta (em ordem)

1. Verificação real por critério (P4): rodar o comando de verdade, quatro vereditos, sem evidência não passa.
2. Classificador de prova vermelha com motivos nomeados e prova não vazia (GSD).
3. Retomada que guarda trabalho não commitado (`stash`) em vez de descartar; commit por lista de arquivos.
4. Revisão automática pendente como estado durável (pausar no meio da revisão do plano retoma sem revisar).
5. Retrospectiva ao fechar épico e passo de sincronização com padrão "não fazer nada".
6. Firewall de contexto: só arquivos editados voltam ao prompt a partir da rodada 2; saída de provas e diff cortados pelas regras do Headroom.
7. Profundidade por missão (Protótipo, Alfa, Beta, GA) e revisor em escada (Luna antes de Terra).
8. Journal com id de épico e de parte; custo em unidades ponderadas.
9. Ondas de partes independentes em worktrees, com portão depois de juntar.
