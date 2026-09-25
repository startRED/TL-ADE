# TL-ADE — Estúdio criativo e trabalho além de software

Plano pedido por Erick em 25/09/2026, consolidado de uma conversa de análise. Nada aqui está implementado. Cada parte
abaixo foi escrita para virar **um pedido na tela Missão**: título, o que fazer, critérios de pronto e o que não mexer.
Desenvolver na ordem; cada parte termina com as três provas verdes e um commit.

## 1. Onde queremos chegar

O usuário pede qualquer coisa na mesma caixa de pedido — de "como faço essa luz no Photoshop?" até "edita meu vídeo e
deixa pronto pra postar" ou "cria um canal do YouTube" — e o TL-ADE escolhe sozinho o caminho, as skills, os modelos e as
ferramentas certas para cada parte do trabalho. Serve a quem desenvolve software e a designer, editor de vídeo, youtuber,
social media, copywriter, ilustrador, quem faz 3D, curso online ou vende artesanato.

Três ideias sustentam tudo:

1. **Uma caixa de ferramentas criativas só**, usada por duas telas: o **Estúdio** (você junto, botão ou conversa) e a
   **Missão** (sozinha, parte por parte). Mesmo journal, mesmos arquivos; um abre o resultado do outro.
2. **O modelo decide, o motor executa.** A IA devolve um plano em JSON validado (lista de cortes, prompt de imagem,
   texto); o motor roda ffmpeg, transcrição e render como passos gravados. Crash no meio retoma sem refazer render, e
   todo arquivo final tem sha256 no journal (mesmo princípio do ADR 0012).
3. **Cada parte declara o que entrega e como se prova.** O kit (skills, modelo, ferramentas, verificação) sai de casar
   isso com o que os recursos declaram e com o histórico. Ninguém mantém lista de tipos de trabalho.

## 2. Estado atual que o plano corrige (leitura do código em 25/09/2026)

- O entendimento do pedido marca `needs_ui` para a missão inteira e o compilador o entrega só à primeira parte
  (`src/intent/compiler.ts:449`); a parte que tem tela pode ficar sem avaliação visual.
- O plano não tem campo de tipo de trabalho (`PLAN_SCHEMA`, `src/intent/llm-intent.ts:85`); o modelo de quem escreve é
  o mesmo para toda parte (`src/models/route.ts:31`); a qualidade é medida por modelo, não por área
  (`src/models/chains.ts:43`).
- "Pronto" só existe para código (teste) e tela (juiz); parte sem arquivo de teste pula a prova
  (`src/engine/proof.ts:60`).
- O catálogo tem 81 skills, todas de software e sem `domains` preenchido.
- O chat não recebe imagem nem busca na web (`src/panel/chat/agent.ts:31`).
- Suporte a macOS é parcial: seletor de pasta e abrir arquivo existem, mas encerramento de processos e resolução de
  binários são pensados para Windows (`src/runner/spawn.ts`, `src/runner/resolve-binary.ts`); a CI roda só Ubuntu.

## 3. Experiência do usuário (alinhada ao painel atual)

O painel hoje tem as abas Missão, Projetos, Modelos, Skills, Opções e Aparência; a Missão tem a caixa de pedido com
entrevista, briefing, plano e execução, e o chat ao lado. O plano mantém isso e acrescenta pouco:

- **Uma porta só.** A caixa de pedido da Missão continua a entrada principal. O usuário nunca escolhe "modo": o
  entendimento decide entre responder na hora (cai no chat ao lado), consultar especialistas (conselho) ou abrir missão.
- **Aba Estúdio** entre Missão e Projetos: galeria dos arquivos de mídia do projeto ativo, ações rápidas por arquivo
  (transcrever, cortar silêncios, legendar, gerar variações, redimensionar por rede) e o chat enxergando o arquivo
  selecionado. Pedido grande feito no Estúdio vira missão; resultado de missão tem "Abrir no Estúdio".
- **Aba Skills vira "Skills e ferramentas"**: mostra cada ferramenta como instalada ou não, com o comando de instalação
  do sistema do usuário para copiar. O TL-ADE nunca instala nada sozinho.
- **Nunca trava.** Ferramenta ausente aparece desligada com o motivo; a missão escolhe alternativa ou entrega sem aquele
  item e registra — ela nunca para esperando o usuário.
- **Ação nunca estraga o original.** Toda ação gera arquivo novo em `entregas/`; o original fica intacto.
- **Linguagem leiga**, como o painel já faz: sem sigla, sem caminho de arquivo na frente do usuário.
- **Publicar é do usuário.** O TL-ADE prepara a pasta "pronto pra postar"; postar em nome dele só depois de decisão
  própria, com aprovação a cada envio.

## 4. Universal: Windows e macOS para qualquer pessoa

O TL-ADE vai ao público no GitHub. Regras que valem para toda parte deste plano:

1. **Windows e macOS são de primeira classe**; Linux é melhor esforço (a CI já roda nele). Toda parte nova tem prova que
   roda nos três na CI.
2. **Nada empacotado.** O TL-ADE chama binários que o usuário instalou (ffmpeg, whisper.cpp, auto-editor…) como
   processos separados, sem `shell` e com `maxBuffer` explícito. Licença GPL/LGPL de ferramenta não contamina o projeto;
   a licença aparece na aba de ferramentas.
3. **Binário único multiplataforma antes de ambiente Python.** Transcrição por whisper.cpp (CPU, CUDA no Windows, Metal
   no Mac) em vez de WhisperX (Python e CUDA). Ferramenta que só existe em Python fica opcional.
4. **Instalação guiada por sistema:** o `ade doctor` diz o comando exato (`winget` no Windows, `brew` no macOS) e a
   versão mínima.
5. **Aceleração escolhida pelo PC, com opção de trocar.** O doctor detecta o hardware e a opção "Aceleração" (em Opções)
   começa em **automática**; o usuário pode fixar outra. A missão mostra o tempo estimado antes de começar.

   A aceleração vale só para o que roda **no PC**: transcrição e processamento de vídeo.

   | PC | Transcrição (whisper.cpp) | Vídeo (ffmpeg) |
   | :--- | :--- | :--- |
   | NVIDIA (ex.: RTX 5060, geração Blackwell: exige CUDA 12.8+) | CUDA, modelo grande | NVENC |
   | Mac Apple Silicon (M1 em diante) | Metal / Core ML, modelo grande | VideoToolbox |
   | AMD ou Intel com GPU | Vulkan | AMF / QSV |
   | Mac Intel ou PC sem GPU | CPU, modelo pequeno ou médio | CPU |

   **Imagem e design são gerados sempre pela assinatura**, em qualquer PC: Codex `$imagegen` (plano ChatGPT) e
   Nano Banana pelo agy (plano Google), chamados pelas CLIs oficiais como o resto da TL-ADE. Geração local (ComfyUI,
   sd.cpp) fica como extra opcional para quem quiser, nunca como caminho padrão.
6. **Funciona com qualquer combinação de planos** (Claude, ChatGPT, Google). Função que depende de um plano — imagem pelo
   Codex, imagem pelo Nano Banana do Google — aparece desligada com o motivo quando o plano não existe; a aba Modelos já
   sabe quais planos o usuário tem.
7. **Caminhos portáveis:** `path.join`, nomes com espaço e acento testados, nada de `C:\` ou `/Users` fixo.
8. **Idioma:** o painel é em português; para o público geral falta decidir inglês (ver §7).

## 5. Ferramentas candidatas (pesquisa de 25/09/2026)

Nenhuma entra sem passar pela lista curada da parte P1.1 (repositório, commit ou versão, licença, motivo).

| Camada | Ferramenta | Uso | Autonomia |
| :--- | :--- | :--- | :--- |
| Local | ffmpeg | cortar, juntar, áudio, legenda, formatos, quadros para o juiz | sozinha |
| Local | whisper.cpp | transcrição com tempo, base da decupagem | sozinha |
| Local | auto-editor (domínio público) | corte automático de silêncios | sozinha |
| Local | OpenTimelineIO / FCPXML | timeline para Premiere, DaVinci e Final Cut | sozinha |
| Local | Remotion (grátis para pessoa física e empresa de até 3 pessoas) | vídeo como código, animações | sozinha |
| Assinatura | Codex `$imagegen` (gpt-image-2) | imagens, thumbnails, assets | sozinha |
| Assinatura | agy + Nano Banana (Gemini Image) | gerar e editar imagem | sozinha |
| Referência | open-generative-ai (MIT, app Electron; gera pela API paga Muapi.ai, local só SD 1.5/SDXL via sd.cpp e vídeo via Wan2GP) | ideias de interface de estúdio e o motor local sd.cpp; não como dependência, porque o caminho principal é API paga | — |
| Programa (MCP) | DaVinci Resolve, Premiere Pro, Photoshop/Adobe, Blender, Canva (oficial), Figma (oficial), ComfyUI | controlar o programa do usuário | só com você, no Estúdio |

MCP de programa roda código dentro do Photoshop, Resolve ou Blender e mexe fora da pasta do projeto, onde o `contain`
não enxerga. Por isso nunca roda em missão desatendida.

Referências: github.com/samuelgursky/davinci-resolve-mcp, github.com/hiteshK03/davinci-resolve-mcp,
github.com/leancoderkavy/premiere-pro-mcp, github.com/alisaitteke/photoshop-mcp, github.com/mikechambers/adb-mcp,
github.com/misbahsy/video-audio-mcp, github.com/KyaniteLabs/kinocut, github.com/wyattblue/auto-editor,
github.com/jwulff/whisper-mcp, github.com/anil-matcha/open-generative-ai, github.com/ahujasid/blender-mcp, github.com/artokun/comfyui-mcp,
canva.dev/docs/apps/mcp, developers.figma.com/docs/figma-mcp-server, remotion.dev/docs/export-opentimeline.

## 6. Partes, em ordem

Cada parte: **Pedido** (texto para colar na Missão), **Pronto quando** (critérios verificáveis), **Não mexer**.

### Fase 0 — Base

**P0.1 Tela vai para a parte que tem tela.**
Pedido: o plano marca, por parte, se ela tem tela; a avaliação visual e as ferramentas de design seguem essa marca, não a
posição da parte.
Pronto quando: plano com S1 de banco e S2 de tela dá `needs_ui` só a S2; missão com duas partes de tela avalia as duas.
Não mexer: rubrica e corte do juiz visual.

**P0.2 macOS de primeira classe.**
Pedido: encerrar árvore de processos, resolver binários e abrir arquivos no macOS; CI com Windows, macOS e Ubuntu.
Pronto quando: a suíte inteira passa nos três sistemas na CI; `ade doctor` roda no Mac sem erro.
Não mexer: comportamento no Windows (ADR 0022, 0025).

**P0.3 ADR de escopo.**
Pedido: ADR que amplia o norte da TL-ADE para trabalho criativo e fixa as regras deste plano (§3, §4, autonomia das
ferramentas, política de API paga).
Pronto quando: ADR aceito por Erick, charter e visão emendados por referência, linha 12 do backlog do roadmap atualizada.
Não mexer: ADRs aceitos (emendar com ADR novo).

### Fase 1 — Caixa de ferramentas

**P1.1 Lista curada de ferramentas.**
Pedido: `docs/catalog/ferramentas-curadas.json` no formato da lista de skills: id, o que faz, entrada e saída, binário ou
MCP, versão mínima ou commit, licença, instalação por sistema, autonomia (`sozinha` ou `com_voce`), motivo.
Pronto quando: prova falha se uma entrada vier sem licença, instalação ou autonomia.

**P1.2 Doctor de ferramentas.**
Pedido: `ade doctor` detecta ffmpeg, whisper.cpp e auto-editor, com versão, GPU e o comando de instalação do sistema.
Pronto quando: prova com binários falsos cobre presente, ausente e versão antiga nos três sistemas.

**P1.3 Ferramenta como passo do motor.**
Pedido: rodar ferramenta local vira passo gravado (write-ahead, recibo, reconciliação), com saída em `entregas/` fora do
git e sha256 no journal.
Pronto quando: transcrever um vídeo de fixture curto grava o passo; matar o motor no meio e retomar não refaz o que já
terminou.

### Fase 2 — Mentor e Estúdio

**P2.1 Chat recebe imagem.** O anexo vira arquivo e o modelo o lê. Pronto quando: print de thumbnail + "como faço essa
luz" responde com o nome da técnica e os passos.

**P2.2 Chat busca na web** (opção ligável). Pronto quando: resposta com referência cita a fonte.

**P2.3 Skills criativas no catálogo.** Pastas de marca, conteúdo, SEO e vídeo das coleções já curadas (licença MIT
conferida no commit) e skills próprias escritas com `skill-creator` onde faltar; `tags` preenchidas. Pronto quando: prova
de seleção escolhe skills diferentes para "thumbnail", "copy de anúncio" e "decupagem".

**P2.4 Aba Estúdio v0.** Galeria de mídia do projeto, ações rápidas pela caixa de ferramentas, chat com o arquivo
selecionado, resultado sempre em arquivo novo. Pronto quando: prova de interface transcreve e corta silêncio de um vídeo
de fixture pela tela, e o original fica intacto.

### Fase 3 — O pedido entende qualquer pedido

**P3.1 Caminho no entendimento.** O entendimento devolve `resposta`, `conselho` ou `missao`; resposta vai para o chat.
Pronto quando: 10 pedidos gravados (código, pergunta, nome, vídeo, campanha…) caem no caminho certo.

**P3.2 Conselho de especialistas.** A mesma pergunta vai em paralelo, só leitura, a cada área (marca, marketing, redes,
comercial); uma síntese de outra empresa ranqueia; checagens na web quando cabem (domínio, @, registro de marca).
Pronto quando: "nome para canal de culinária" devolve top 5 justificado com disponibilidade conferida.

**P3.3 Parte declara entrega, área e juízo.** `entrega` (código, texto, imagem, áudio, vídeo, dados, arquivo), `area`
(etiquetas livres normalizadas contra as `tags` do catálogo) e `juizo` (executa, render+juiz, juiz, variantes). Exige
story própria para os schemas. Pronto quando: parte só de texto roda sem exigir arquivo de teste.

**P3.4 Juiz genérico e portões de mídia.** Rubrica tirada dos critérios da parte, juiz de outra empresa, no máximo 2
rodadas; prova vermelha vira "o juiz reprova o antes". Portões medidos antes do juiz: duração, resolução, volume
(-14 LUFS), tamanho de arquivo, limite de caracteres. Pronto quando: parte de texto e parte de imagem gravam veredito no
journal.

**P3.5 Modelo decide, motor executa.** Planos de mídia em JSON validado (lista de cortes, prompt de imagem, legenda) que
o motor executa. Pronto quando: lista de cortes inválida (trecho fora do vídeo) é recusada antes de renderizar.

**P3.6 Kit do projeto.** Marca, público e tom de voz num arquivo do projeto, criado pela primeira missão e dado a toda
parte. Pronto quando: a segunda missão usa o tom da primeira sem perguntar.

**P3.7 Qualidade por área.** A fila de modelos pesa a aprovação medida por modelo e área, com a medida global quando a
amostra é pequena. Pronto quando: com journal sintético, a rota escolhe modelos diferentes para áreas diferentes.

### Fase 4 — Vídeo pronto para postar (meta de dogfood)

**P4.1 Decupar e cortar:** transcrição, IA marca trechos bons, erros e repetições, corte por auto-editor + ffmpeg.
**P4.2 Áudio e legenda:** redução de ruído, volume padrão, legenda sincronizada com a transcrição.
**P4.3 Textos:** título, descrição, tags e capítulos a partir da transcrição, com juiz.
**P4.4 Thumbnail:** 3 conceitos, imagens pela assinatura disponível, 1280×720 até 2 MB, juiz visual escolhe.
**P4.5 Shorts:** 3 trechos em 9:16 com legenda, abaixo de 60 s.
**P4.6 Timeline:** exportar OTIO/FCPXML para acabamento no Premiere, DaVinci ou Final Cut.
**P4.7 Pacote:** pasta `pronto-pra-postar/` com vídeo, thumbnail, textos, Shorts e checklist.
Pronto quando (fase inteira): um vídeo bruto real vira o pacote completo sem intervenção, em Windows e macOS, com todos os
passos no journal.

### Fase 5 — Geração, voz e programas

**P5.1 Imagem pela assinatura:** Codex `$imagegen` e agy Nano Banana como ferramentas da caixa, escolhidos pelos planos.
**P5.2 Voz local (TTS)** para narração, licença conferida antes. **P5.3 Criar do zero:** roteiro com juiz, narração,
imagens e Remotion.
**P5.4 MCPs de programa no Estúdio:** Resolve, Premiere, Photoshop, Blender, Canva e Figma pela lista curada, só com o
usuário presente e aprovando.
**P5.5 Métricas de volta:** ler o CSV de analytics (YouTube Studio, Meta) e dar o que funcionou à próxima missão.
**P5.6 Missões criativas grandes:** canal do YouTube (8 partes: nicho, nome pelo conselho, identidade, textos, pilares e
ideias, roteiros, thumbnails, calendário com checklist de criação da conta), campanha, curso.

## 7. Decisões pendentes de Erick

1. ADR de escopo (P0.3): aprovar a ampliação para trabalho criativo.
2. API paga opcional por ferramenta (música, vídeo gerado, voz em nuvem) ou só local e assinatura.
3. Programa de vídeo principal para o primeiro MCP e formato de timeline: Premiere ou DaVinci.
4. Arquivos grandes em `entregas/` fora do git: confirmar.
5. Publicar em nome do usuário: quando e com qual aprovação.
6. Idioma do painel para o público geral: só português ou português e inglês.
7. Divergência ADR 0040 (até 4 skills por parte) contra o código (até 12, `src/intent/llm-intent.ts:275`).
