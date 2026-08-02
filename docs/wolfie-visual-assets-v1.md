# Wolfie Visual Assets V1 — inventário, proveniência e prompt-set

> Versão: 1
> Data: 1º de agosto de 2026
> Estado: lote local; sem deploy de produção
> Escopo: Wolfie V2, dez reuniões globais e dois pilotos de outros universos

## 1. Resumo da entrega

Este lote contém um personagem vertical transparente e doze ambientes originais:

- dez fundos para o universo `global-meetings`;
- um fundo para `daily-life/food-cooking`;
- um fundo para `speaking/speak-for-a-minute`;
- um poster vertical do personagem `wolfie-coach` no estado `listening`.

Todos foram produzidos para esta implementação com o **ImageGen integrado ao
Codex**. Nenhuma imagem foi copiada ou extraída da Praktika; a referência foi
usada apenas como direção conceitual de presença, escala do personagem e
feedback contextual. Não há hotlink, marca de terceiro, rosto de pessoa real nem
dado do aluno nos arquivos ou nos prompts.

Os 44 cenários restantes do catálogo têm perfil visual determinístico, mas ainda
não têm bitmap próprio neste lote. Eles usam gradiente e fallback tipado.

## 2. Inventário de entrega

### 2.1 Arquivos finais

Os fundos usam dois recortes WebP por experiência:

- desktop: `1600 × 900`, proporção 16:9;
- mobile: `900 × 1200`, proporção 3:4;
- caminho: `public/assets/wolfie/scenes/{universe}/{experienceId}/{desktop|mobile}.webp`.

| Experiência | Universo | Fonte ImageGen aceita | Arquivos finais |
|---|---|---|---|
| `meetings-business` | `global-meetings` | `exec-cd8f189b-5133-4633-8f70-954db88b6caa.png` | `desktop.webp`, `mobile.webp` |
| `meetings-medicine` | `global-meetings` | `exec-6c6bdbe1-c2f9-48d7-835a-5d7c274dcf8d.png` | `desktop.webp`, `mobile.webp` |
| `meetings-human-reproduction` | `global-meetings` | `exec-7c8b2af2-c643-4aa2-8b60-6a47d4e19122.png` | `desktop.webp`, `mobile.webp` |
| `meetings-laboratories` | `global-meetings` | `exec-566dac13-ed89-492b-bd7c-5f5c63dd5539.png` | `desktop.webp`, `mobile.webp` |
| `meetings-beauty` | `global-meetings` | `exec-7d135767-3620-40d0-8312-860756313244.png` | `desktop.webp`, `mobile.webp` |
| `meetings-retail` | `global-meetings` | `exec-2d15e9ec-b9ac-43b6-be34-2ac7168e8621.png` | `desktop.webp`, `mobile.webp` |
| `meetings-technology` | `global-meetings` | `exec-db7280d6-eac4-4ef7-8403-4b2511639fd0.png` | `desktop.webp`, `mobile.webp` |
| `meetings-logistics` | `global-meetings` | `exec-9173058f-b11b-4cc8-9137-1d56f7e29374.png` | `desktop.webp`, `mobile.webp` |
| `meetings-tourism` | `global-meetings` | `exec-cf5951b4-3bc5-41d3-a870-78d9ce6bdbeb.png` | `desktop.webp`, `mobile.webp` |
| `meetings-aviation` | `global-meetings` | `exec-bc66a18a-67a0-4ae8-a9c9-1d1c1dd58171.png` | `desktop.webp`, `mobile.webp` |
| `food-cooking` | `daily-life` | `exec-766ce0f6-fed3-4901-86fc-50ad07f0dc2f.png` | `desktop.webp`, `mobile.webp` |
| `speak-for-a-minute` | `speaking` | `exec-6d90ae90-a747-4b69-b6e0-bb15172f3522.png` | `desktop.webp`, `mobile.webp` |

O personagem final é:

| Personagem/estado | Fonte ImageGen | Arquivo final | Dimensão final |
|---|---|---|---|
| `wolfie-coach/listening` | `exec-c074bdaf-0c17-44fc-a7f0-0af93bae6ee2.png` | `public/assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.webp` | `1024 × 1536` |

### 2.2 Fontes e transformação

- As fontes aprovadas dos ambientes foram geradas em `1672 × 941` PNG.
- O personagem foi gerado em `1024 × 1536` PNG sobre chroma uniforme; o chroma
  foi removido localmente para produzir alfa transparente e borda limpa.
- Os ambientes foram redimensionados/cortados localmente para os dois recortes e
  exportados em WebP. Texto pedagógico, HUD e legenda não foram rasterizados.
- Os identificadores `exec-*` acima são o vínculo de proveniência com as saídas
  originais da geração. Eles não são URLs de runtime e não são enviados ao aluno.
- Os arquivos em `public/assets/wolfie/` são os únicos consumidos pela aplicação.

### 2.3 Orçamento

| Tipo | Limite V1 | Regra |
|---|---:|---|
| Fundo desktop WebP | 320 KB | cada arquivo, `1600 × 900` |
| Fundo mobile WebP | 180 KB | cada arquivo, `900 × 1200` |
| Personagem inicial WebP | 400 KB | poster vertical com transparência |

Antes de integrar ou substituir um arquivo, a validação deve confirmar dimensão,
tamanho, decodificação e existência de todos os caminhos declarados no catálogo.
AVIF, `srcset` e poses adicionais pertencem a um lote posterior; a V1 entregue
usa WebP com fallback de gradiente.

Validação final do lote: **24 fundos e um personagem decodificados**, todos nas
dimensões declaradas e dentro do orçamento. O maior desktop é
`meetings-tourism/desktop.webp`, com 172.554 bytes; o maior mobile é
`meetings-tourism/mobile.webp`, com 97.496 bytes; o personagem tem 98.684 bytes.

## 3. Proveniência e controle de qualidade

### 3.1 Método de produção

Modo utilizado: **geração e edição de imagem pelo ImageGen integrado ao Codex**.
O fluxo foi:

1. definir direção original Wise Wolf e restrições de segurança;
2. gerar o Wolfie V2 e três pilotos;
3. testar composição real com UI em desktop e mobile;
4. expandir os nove ambientes de reunião restantes;
5. inspecionar visualmente cada saída;
6. rejeitar ou editar saídas com logo, texto, marca ou composição inadequada;
7. produzir recortes WebP locais e validar orçamento.

### 3.2 Rejeição registrada: logística

A primeira saída de logística,
`exec-e26897cb-c6ac-496e-8876-d70559bc4e3f.png`, foi **rejeitada** porque continha
um emblema de cabeça de lobo em um pilar. Embora não fosse uma marca externa
identificada, o elemento violava a regra de cenário sem logos ou emblemas e
competia com a identidade do personagem.

A saída foi corrigida por edição de imagem, removendo o emblema e reconstruindo
o pilar de forma coerente. Somente
`exec-9173058f-b11b-4cc8-9137-1d56f7e29374.png` foi aprovada e usada. A saída
rejeitada não deve ser copiada para `public/`, manifestada nem reutilizada.

### 3.3 Checklist aplicado

- cenário original e coerente com o setor;
- sem pessoa ou rosto real;
- sem logo, marca, watermark ou identidade de companhia aérea;
- sem palavras, letras ou números legíveis;
- sem dashboards, prontuários, voos, rotas ou dados reais;
- sem estereótipo cultural ou clínico;
- área de respiro suficiente para personagem, HUD, legenda e controles;
- leitura preservada nos recortes desktop e mobile;
- personagem separado do fundo;
- fallback funcional se o arquivo não carregar.

## 4. Prompt-set estruturado

As instruções abaixo registram o conjunto consolidado de produção. Cada variação
foi combinada com o prompt-base e com o bloco negativo. Os IDs de proveniência da
tabela são a referência autoritativa de cada saída aceita.

### 4.1 Prompt-base dos ambientes

```text
Crie um ambiente original para o Wolf Tutor, plataforma premium de prática de
inglês da Wise Wolf. Use 3D cinematográfico realista estilizado, materiais e
iluminação convincentes, acabamento premium e acolhedor, sem parecer uma foto de
pessoa real e sem imitar personagem, interface, composição ou marca da Praktika.

Entregue somente o cenário, sem personagem e sem interface. Composição widescreen
16:9, câmera ampla em altura humana, profundidade clara em primeiro, segundo e
terceiro planos. Reserve a região indicada para receber o personagem e mantenha
zonas de baixo contraste para HUD, legenda e controles responsivos. O recorte
central também deve continuar útil em mobile 3:4.

Cenário: {ambiente}.
Objetivo pedagógico: {objetivo}.
Região reservada para personagem: {lado_personagem}.
Iluminação e paleta: {iluminacao_paleta}.
Atmosfera: {atmosfera}.
Props permitidos: {props_abstratos}.
```

### 4.2 Bloco negativo comum

```text
Não incluir texto, letras, números legíveis, logo, emblema, marca, watermark,
dashboard real, dado pessoal, dado de paciente, rota real, informação de voo,
rosto de pessoa real, personagem existente, moldura de celular ou componente de
interface. Não inserir o Wolfie no fundo. Não usar imagem, paleta, roupa, cenário
ou composição proprietária da Praktika. Evitar mãos, multidões em primeiro plano,
poluição visual e objetos que bloqueiem a região reservada ao personagem.
```

### 4.3 Variações das dez reuniões globais

| `experienceId` | Variação combinada com o prompt-base |
|---|---|
| `meetings-business` | Boardroom internacional contemporâneo, mesa de decisão e painéis apenas abstratos; azul-marinho, ciano e luz urbana quente; clima executivo confiante; região do personagem à direita. |
| `meetings-medicine` | Sala internacional de discussão clínica, limpa e humana, sem paciente nem prontuário; azul clínico, branco suave e madeira clara; atmosfera precisa, calma e colaborativa; região do personagem à esquerda. |
| `meetings-human-reproduction` | Mesa-redonda científica multidisciplinar, técnica e acolhedora, com formas celulares totalmente abstratas e sem anatomia explícita; teal profundo e luz quente; região do personagem à direita. |
| `meetings-laboratories` | Sala de qualidade próxima a laboratório, vidro, equipamentos e indicadores abstratos ao fundo; ciano técnico sobre azul profundo; sensação de rigor e rastreabilidade; região do personagem à esquerda. |
| `meetings-beauty` | Showroom profissional de lançamento e distribuição, materiais rose/champagne e embalagens genéricas sem rótulo; luz editorial elegante, não publicitária; região do personagem à direita. |
| `meetings-retail` | Sala de merchandising e performance de categoria com produtos genéricos e planogramas abstratos; azul-marinho com acentos laranja; foco em margem, estoque e canais; região do personagem à esquerda. |
| `meetings-technology` | War room de produto, dados e incidentes, telas abstratas sem glifos legíveis; azul e violeta luminosos; atmosfera de decisão técnica sob pressão; região do personagem à direita. |
| `meetings-logistics` | Control tower de operações com rotas e nós inteiramente abstratos, sem mapa ou localização real; ciano e âmbar sobre azul profundo; região do personagem à esquerda; nenhum emblema em paredes ou pilares. |
| `meetings-tourism` | Sala de operações de hospitalidade e parceiros, madeira quente, luz de fim de tarde e costa abstrata sem marco reconhecível; clima relacional e premium; região do personagem à direita. |
| `meetings-aviation` | Sala de briefing operacional de aeroporto no blue hour, aeronave genérica distante sem pintura identificável e monitores em branco; atmosfera segura e precisa; região do personagem à esquerda. |

### 4.4 Variações dos dois pilotos

| `experienceId` | Variação combinada com o prompt-base |
|---|---|
| `food-cooking` | Cozinha contemporânea acolhedora, bancada limpa e ingredientes genéricos sem embalagem; luz natural quente, verde-sálvia e madeira; composição de roleplay em câmera média; região do personagem à direita. |
| `speak-for-a-minute` | Microestúdio de fala com spotlight, palco pequeno e área visual limpa para cronômetro HTML; roxo profundo, coral e luz de recorte suave; energia encorajadora, sem plateia; região do personagem à esquerda. |

### 4.5 Prompt do personagem Wolfie V2

```text
Crie um personagem 3D original para o universo visual da Wise Wolf: um lobo
antropomórfico adulto, amigável e competente, com pelagem cinza e creme, olhos
âmbar expressivos e óculos retangulares pretos. Ele é um tutor de inglês premium,
acolhedor e seguro, sem aspecto infantil e sem semelhança com personagem existente.

Figurino fixo: polo preta com mangas e detalhes vermelhos, calça preta simples,
sem logo, texto ou crachá. Pose listening: corpo inteiro, postura aberta, uma mão
no bolso e a outra em gesto calmo de convite; expressão atenta e natural; mãos e
patas anatomicamente coerentes. Iluminação de estúdio neutra compatível com os
ambientes, enquadramento vertical 2:3, corpo completo sem cortar orelhas, mãos,
cauda ou pés. Fundo chroma uniforme para recorte limpo posterior e espaço ao
redor da silhueta. Não incluir cenário, interface, marca ou watermark.
```

O asset V1 é um poster em camadas, não um rig. Estados de listening, speaking e
thinking são comunicados pela UI e pelo áudio; novas poses devem preservar
exatamente rosto, pelagem, óculos, proporções e figurino desta referência.

## 5. Checksums

Os valores abaixo foram calculados sobre os arquivos WebP finais. Eles servem
para detectar substituições acidentais; os IDs `exec-*` continuam sendo a
proveniência das gerações, não o checksum do arquivo otimizado.

| Experiência | SHA-256 desktop | SHA-256 mobile |
|---|---|---|
| `food-cooking` | `e06d4adf21646612f53d4ce10878beebb980ef7c8cd2aa5d9793b24d27a66c77` | `cab5c78a760352362bd4d59b4fe621856d1ebbf18b1410cf8299052837a790fd` |
| `meetings-aviation` | `cc878f5bad08d507fa5adfb3a76be77984ed7ce57ae0ca35863930b37ad60de1` | `0f321cece25ff95f3cf85201030c44f0f04825b0e1b6298ed44ba4cfb008483f` |
| `meetings-beauty` | `d6a3e3f056eb68079a1985a2e8d2cc1402cf6861517e5b7288670d34bebe7edd` | `390d81d9c1eb27ced904425e0febeca2f5978bcec6c142ec78edbba27f897321` |
| `meetings-business` | `a5fc36b144181492045e3f257d868152c2083daf72abf02c4d107b4b862f47f9` | `20595301b1f4f1c0f2593c4a715f6e9becddbee46d702db1d309a7ebbcdbb00a` |
| `meetings-human-reproduction` | `4fec999021729d005d713a93f6989d79b8636bc36f1683a50a2a7ce5753ecdc4` | `23bcb9c2b67b2cdec2ec4a69da433cb44ca66a15640f46ae49053c7aa07d3dce` |
| `meetings-laboratories` | `cb1b23039a2448b63446f62d030017fe4cd9e1f4160eb8305063b9236601bf59` | `5dd04d3a2970620837e46438e9824125fdd1744131d1d6fb747146fefb5be1e8` |
| `meetings-logistics` | `b5f1816863cda234f36125079064f2277fe0c21b27958f56fbf0e29c205c0930` | `80ad22c6ab3f73c9a1b9f6e529109ab324e9a261f10e9b84c816642cd9e73788` |
| `meetings-medicine` | `9d63442a60df178592ea51fe51ee44cf1d8a135e0eb3ec2bae8645692e48be33` | `c54e39835bd68af3e90267d1984a4afff23b6b20c979a96573696c3de303068b` |
| `meetings-retail` | `4a0c5a2ff773c320c916879255858ae984084487f3cc83cd32dbe48789fd915b` | `1b8e2fb6011b875dbfef98a92a5d17fe5783e12315a434c1185cc4400cfb77ec` |
| `meetings-technology` | `cc9f82869f7f1dfe74acc56f61c3e08fda6ea22f03e0de90bd24e15f51e467e0` | `3033a4a4558e7e0fb84119d8c5f90f0911e70b7a1af509f8e557f5a232c1d1f1` |
| `meetings-tourism` | `8ff421493764768fecbc10d32651ebb3b8d1ea122fa9feac185c9466d7c1631c` | `8c6ac11942c959790ccebce37a115e7263f59791674b5516b701f29040564062` |
| `speak-for-a-minute` | `e463c26e251eacc70e7d53f899a04f9a5cea5aed82356afdaba41cad47e49b8a` | `ea57d3ee0fa554753d430d856ad17e0986142e438bc37a10155528325d215995` |

| Personagem | SHA-256 |
|---|---|
| `wolfie-coach/wolfie-v2-listening.webp` | `07cf0629cc2d6c406252eee866d42c44182eb869c3deddeb09928f0e1d519c0e` |

## 6. Estado do rollout, limites e próximo lote

- Este catálogo V1 foi publicado na release
  `20260802T004103Z-5d79a11ddaae`, a partir do commit `c1ad91a205e9`, com
  `VITE_WOLFIE_SCENARIO_UI_V2=true`.
- Os 25 assets deste lote e o mascote legado foram conferidos em produção: os
  26 WebPs retornaram `image/webp` e checksum idêntico ao arquivo local.
- Os 44 perfis sem bitmap continuam intencionalmente em fallback visual.
- Não há AVIF, rig em tempo real, lip-sync facial, elenco setorial completo nem
  thumbnails neste lote.
- Qualquer regeneração deve criar nova versão do manifest, manter a V1
  reproduzível e repetir inspeção visual, orçamento e QA responsivo.
- Imagem com texto, logo, emblema, dado real ou composição incompatível deve ser
  rejeitada mesmo que sua qualidade estética seja alta.
