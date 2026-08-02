# Wolf Tutor — plano de redesign interativo e prompt mestre

> Status: lotes V1 e V2 publicados; lote V3 validado e pronto para rollout
> Data da análise: 1º de agosto de 2026
> Escopo: experiência do aluno em `WolfiePracticeFlow`, atividades e conversa com o Wolf Tutor
> Referência conceitual: [Praktika](https://praktika.ai/) e sua [página oficial na App Store](https://apps.apple.com/us/app/praktika-ai-language-tutor/id1624701477)

## Status da execução — 1º de agosto de 2026

Esta seção registra o estado verificável da primeira entrega. Ela prevalece sobre
verbos no futuro usados nas fases do plano abaixo, que permanecem como roteiro de
evolução.

### Implementado e publicado

- O catálogo visual possui **56 perfis explícitos e versionados**, um para cada
  `experienceId` canônico. A seleção é determinística e segue
  `experienceId → setor confiável → universo → modo → neutro`; ela não interpreta
  o nome da atividade, a transcrição nem texto livre do aluno.
- A camada V2 foi extraída para componentes próprios: palco de cenário,
  personagem, HUD da sessão, HUD de reuniões globais, barra de legenda e painel
  de coaching. Esses componentes são integrados ao controlador ativo sem
  substituir seus contratos pedagógicos, de áudio ou de persistência.
- O Wolfie V2 usa um recorte vertical transparente e aparece integrado ao palco,
  sem o cartão quadrado do avatar legado.
- Os dez perfis de reuniões globais possuem fundos bitmap próprios, em recortes
  desktop e mobile: negócios, medicina, reprodução humana, laboratórios, beleza,
  varejo, tecnologia, logística, turismo e aviação.
- Dois pilotos fora de reuniões também possuem fundo bitmap: `food-cooking` e
  `speak-for-a-minute`. Com `meetings-business`, eles formaram o lote inicial que
  validou a composição antes da expansão para as demais reuniões.
- O lote V2 acrescenta seis cenários fingerprintados em produção:
  `job-interviews`, `career-networking`, `promotion`, `talks`, `trade-shows` e
  `medical-congresses`. O manifesto de assets trava URL, dimensão, bytes,
  orçamento e SHA-256 de cada arquivo.
- O lote V3 acrescenta dez cenários validados para vida cotidiana e fala:
  `home-organization`, `skincare-beauty`, `health-symptoms`, `shopping`,
  `services`, `digital-life`, `record-a-story`, `tell-a-story`,
  `describe-what-you-see` e `give-your-opinion`. Com eles, 28 dos 56 perfis já
  possuem bitmap exclusivo.
- O painel de coaching contém Tab e Shift+Tab dentro do diálogo, ignora controles
  indisponíveis e preserva foco inicial, Escape e restauração de foco.
- A interface V2 é protegida por `VITE_WOLFIE_SCENARIO_UI_V2`. O valor padrão de
  segurança é `false`; quando a flag está desligada, a experiência clássica
  continua disponível.
- Há fallbacks por perfil, setor, universo, modo e cena neutra. Durante o
  carregamento — ou se um bitmap falhar — o gradiente do perfil mantém a prática
  legível e funcional.

### Coberto por perfil, ainda sem bitmap exclusivo

As outras **28 experiências** já possuem identidade pré-definida no catálogo —
layout, ambiente, elenco, câmera, lado do personagem, paleta, HUD e descrição
acessível —, mas ainda usam o fallback visual gerado em código. Portanto,
“cobertura das 56 experiências” significa cobertura de resolução e design; não
significa que 56 fundos finais já foram produzidos.

Também permanecem para lotes futuros:

- imagens exclusivas das 28 experiências restantes;
- poses adicionais e elenco de interlocutores 3D;
- AVIF e `srcset` além dos WebP atuais;
- thumbnails de descoberta e resumo;
- auditoria completa de acessibilidade, performance e métricas p75 em produção;
- rig facial/corporal — o primeiro lote usa poster em camadas, não um rig 3D em
  tempo real.

### Rollout

O lote V1 foi implantado na release `20260802T004103Z-5d79a11ddaae` e o lote V2
na release `20260802T022645Z-745c73755821`, ambos com a feature flag ativada,
backup reversível e evidências registradas na seção 15. O lote V3 passou pelos
gates locais e aguarda o rollout. Os inventários e a proveniência estão em
`docs/wolfie-visual-assets-v1.md`, `docs/wolfie-visual-assets-v2.md` e
`docs/wolfie-visual-assets-v3.md`.

## 1. Resultado esperado

Transformar o Wolf Tutor em uma experiência imersiva, cinematográfica e orientada por cenário, na qual cada uma das 56 experiências do catálogo tenha uma assinatura visual previsível e adequada ao objetivo pedagógico.

O novo design deve:

- retirar o personagem do cartão quadrado central;
- integrar personagem, ambiente, legenda, feedback e controles em um palco responsivo;
- dar identidade própria a cada universo e cenário;
- destacar especialmente os dez contextos de reuniões globais;
- permitir avatares 3D realistas estilizados, consistentes e pertencentes à Wise Wolf;
- preservar integralmente a lógica já validada de áudio, Realtime, memória, correção, retry, handoff, cota e avaliação;
- funcionar com qualidade em celular, tablet e desktop;
- manter acessibilidade WCAG 2.2 AA e desempenho compatível com conversa em tempo real.

O princípio central é: **o cenário muda; o contrato pedagógico não**.

## 2. Diagnóstico do produto atual

### 2.1 Fluxo ativo

O caminho principal do aluno é:

```text
App.tsx
  → src/pages/student/StudentAITutor.tsx
  → src/components/wolfie/WolfiePracticeFlow.tsx
  → components/WolfieTutor.tsx
```

O fluxo também pode abrir `WolfieTutor` por atividades de `components/ActivityPlayer.tsx`. Portanto, a nova apresentação precisa aceitar tanto uma experiência completa quanto um contexto parcial com fallback seguro.

`components/WolfTutorChat.tsx` é legado e não deve ser tratado como a experiência ativa. O Studio do Hub, em `components/hub/HubWolfieStudio.tsx`, é uma superfície distinta e deve ser unificado somente em uma etapa própria, depois da estabilização do produto principal.

### 2.2 Causa do “avatar quadrado”

- Existe um único asset: `public/assets/wolfie/wolfie-tutor-mascot.webp`.
- A imagem tem fundo incorporado, proporção quadrada e não possui transparência.
- `components/WolfieAvatar.tsx` força `aspect-square`, recorte, fundo e cantos arredondados.
- `components/WolfieTutor.tsx` centraliza o componente em aproximadamente 260, 320 ou 500 pixels.
- Olhos, orelhas, focinho e boca são animados por recortes com coordenadas fixas do bitmap atual; trocar livremente a imagem desalinha o rosto.
- O fundo da conversa é sempre um gradiente abstrato, sem vínculo com `experienceId`, universo, setor ou interlocutor.

Conclusão: os cenários existem pedagogicamente, mas ainda não existem como sistema visual.

### 2.3 Base disponível

O catálogo canônico `src/components/wolfie/experienceCatalog.ts` já oferece:

- 9 universos;
- 56 experiências;
- 16 modos tipados, dos quais 14 estão em uso no catálogo;
- audiência, habilidade, modalidade, objetivo real e setor;
- `experienceId`, `experienceUniverse`, `experienceMode` e `experienceAudiences` chegando à conversa.

Essas chaves são suficientes para selecionar uma cena sem interpretar texto livre do aluno.

## 3. Como usar a Praktika como referência

Na referência oficial analisada, os elementos mais valiosos são:

- personagem em escala humana, ocupando parte importante da composição;
- sensação de presença e conversa, em vez de um retrato isolado;
- tutores com personalidade visual própria;
- correções e sugestões sobrepostas ao contexto, sem interromper a prática;
- onboarding com uma decisão por vez e progresso evidente;
- feedback em tempo real com hierarquia curta;
- cenários e papéis relacionados a situações concretas;
- linguagem visual amigável, confiante e pouco punitiva.

O Wolf Tutor deve aproveitar **esses princípios**, não copiar:

- personagens;
- marca, ícone ou paleta proprietária;
- composição exata das telas;
- textos, ilustrações ou assets;
- nomes, backstories ou roupas dos tutores;
- mockups ou screenshots.

A Wise Wolf precisa de uma direção própria: mais profissional nos contextos corporativos, mais acolhedora no aprendizado geral e mais lúdica apenas quando a audiência exigir.

## 4. Princípios de experiência

1. **Presença antes de decoração.** O personagem deve parecer estar dentro do ambiente, não colado sobre ele.
2. **Uma tarefa principal por momento.** O aluno precisa saber se deve ouvir, falar, revisar, repetir ou decidir.
3. **Cena determinística.** O mesmo `experienceId` sempre resolve o mesmo perfil visual versionado.
4. **Feedback sem quebrar o papel.** Correções entram em uma camada de coaching e devolvem o aluno ao checkpoint correto.
5. **Texto fora da imagem.** Legendas, dados, perguntas e feedback permanecem em HTML acessível.
6. **Profundidade progressiva.** A interface começa limpa e revela tradução, repertório, histórico e explicações sob demanda.
7. **Mobile não é desktop espremido.** No celular, painéis laterais viram bottom sheets e o palco ganha composição vertical própria.
8. **Áudio tem prioridade.** Nenhum download, efeito ou renderização visual pode degradar a conversa.
9. **Movimento comunica estado.** A animação reforça listening, speaking e retry, mas nunca é a única pista.
10. **Originalidade e segurança.** Sem caricaturas culturais, rostos reais, marcas de terceiros ou dados do aluno em prompts de imagem.

## 5. Arquitetura visual recomendada

### 5.1 Separar controlador e apresentação

`components/WolfieTutor.tsx` concentra cerca de 4.600 linhas de lógica crítica e UI. Não reescrever o controlador inteiro.

Extrair progressivamente a camada visual:

```text
src/components/wolfie/visuals/
  types.ts
  sceneCatalog.ts
  resolveScene.ts
  visualStateResolver.ts
  WolfieScenarioStage.tsx
  WolfieCharacter.tsx
  WolfieSessionHUD.tsx
  WolfieMeetingHUD.tsx
  WolfieCaptionBar.tsx
  WolfieCoachSheet.tsx
  WolfieSceneFeedback.tsx
  sceneCatalog.test.ts
  resolveScene.test.ts

public/assets/wolfie/
  scenes/{universe-id}/{experience-id}/desktop.avif
  scenes/{universe-id}/{experience-id}/desktop.{sha256-12}.webp
  scenes/{universe-id}/{experience-id}/mobile.avif
  scenes/{universe-id}/{experience-id}/mobile.{sha256-12}.webp
  characters/{character-id}/{pose-or-state}.{sha256-12}.webp
  thumbnails/{experience-id}.webp
```

### 5.2 Registro visual tipado

```ts
interface WolfieVisualScenarioProfile {
  version: 1;
  experienceId: string;
  universeId: LearningUniverseId;
  layout:
    | "conversation"
    | "roleplay"
    | "meeting"
    | "presentation"
    | "interview"
    | "exam"
    | "lab"
    | "mission"
    | "writing";
  environmentId: string;
  castIds: readonly string[];
  camera: "close" | "medium" | "wide";
  characterSide: "left" | "right" | "center";
  palette: {
    accent: string;
    glow: string;
    scrim: string;
  };
  assets: {
    desktopAvif: string;
    desktopWebp: string;
    mobileAvif: string;
    mobileWebp: string;
    posterWebp: string;
  };
  hudVariant:
    | "conversation"
    | "meeting"
    | "exam"
    | "mission"
    | "studio";
  accessibleEnvironmentLabel: string;
}
```

Prioridade de resolução:

```text
experienceId exato
  → setor confiável
  → universeId
  → experienceMode
  → cenário neutro seguro
```

Não selecionar cenas com base principal em `scenario`, transcrição, nome do aluno ou texto livre. Esses dados podem conter conteúdo arbitrário e não pertencem ao catálogo visual.

### 5.3 Layout do palco

Desktop:

```text
┌──────────────────────────────────────────────────────────┐
│ status, etapa, tempo e controles essenciais              │
├────────────────────────────────┬─────────────────────────┤
│                                │ contexto / checkpoint   │
│ palco 3D + personagem          │ pergunta / decisão      │
│                                │ apoio sob demanda       │
├────────────────────────────────┴─────────────────────────┤
│ legenda/transcrição + ação principal                     │
└──────────────────────────────────────────────────────────┘
```

Mobile:

```text
┌──────────────────────────┐
│ status curto + sair      │
├──────────────────────────┤
│ palco vertical           │
│ personagem em 3/4        │
├──────────────────────────┤
│ legenda                  │
│ ação principal           │
│ bottom sheet contextual  │
└──────────────────────────┘
```

Slots obrigatórios evitam a atual colisão entre overlays absolutos:

- `top HUD`;
- `stage`;
- `context rail` ou `bottom sheet`;
- `caption bar`;
- `primary action dock`;
- `modal layer` para confirmação de transcrição e erros bloqueantes.

## 6. Redesign por tela

| Tela/estado atual | Direção proposta |
|---|---|
| Descoberta (`subject`) | Hero com Wolfie em corpo/meio-corpo, universo em destaque, cards com thumbnail de cena e recomendações personalizadas. |
| Seleção de nível | Uma decisão por vez, amostra do tipo de suporte esperado em cada faixa e progresso visível. |
| Seleção de setor | Cards com cenas setoriais próprias; não apenas ícone e texto. |
| Seleção de formato (`mode`) | Prévia do palco e explicação clara de texto, voz clássica e conversa ao vivo, incluindo consumo de minutos. |
| Configuração da conversa | Editor de briefing progressivo; resumo visual persistente do papel, objetivo, interlocutor e dificuldade. |
| Carregamento | Poster da cena escolhida, skeleton reservado e mensagens pedagógicas; nenhum salto de layout. |
| Quiz/listening/reading/grammar | Ambiente contextual no topo, conteúdo em superfície legível e feedback integrado sem cobrir alternativas. |
| Writing | Estação de escrita, documento como foco e coach lateral; sem cenário competindo com o texto. |
| Reunião — construção | Seis blocos visuais com progresso e contexto setorial persistente. |
| Reunião — memorização | O roteiro desaparece progressivamente; palco e checkpoint continuam estáveis. |
| Reunião — readaptação | Mudança controlada de pressão, interlocutor ou restrição sem perder o mesmo universo visual. |
| Conversa ao vivo | Palco imersivo, personagem integrado, legenda estável e HUD específico do modo. |
| Revisão de transcrição | Bottom sheet/modal acessível que pausa a cena e deixa claro o impacto da confirmação. |
| Resumo | Evidências, evolução, uma prioridade e próximo treino; reaproveitar thumbnail da cena concluída. |
| Repertório | Biblioteca visual de experiências, correções e frases salvas, com filtros e retomada. |
| Erro de geração/conexão | Manter poster e contexto; explicar o que foi preservado e oferecer recuperação sem reiniciar indevidamente. |

## 7. Matriz visual das 56 experiências

Cada item abaixo deve possuir um registro explícito em `sceneCatalog.ts`. A cena pode compartilhar kit de arte, mas precisa ter composição, props e objetivo distinguíveis.

### 7.1 `about-you` — fale sobre sua vida

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `introduce-yourself` | Estúdio de apresentação acolhedor, luz de manhã e fundo neutro premium | Wolfie coach em plano médio, espaço livre para o pitch do aluno |
| `my-routine` | Apartamento dividido por sinais sutis de manhã e fim do dia | Coach lateral e objetos de rotina sem texto legível |
| `my-home` | Sala contemporânea com pontos de interesse visuais | Wolfie integrado ao ambiente; objetos servem de contexto de vocabulário |
| `my-family` | Lounge com porta-retratos abstratos e álbum fechado | Composição íntima, sem representar familiares reais |
| `my-childhood` | Sótão/estúdio de memórias com brinquedos genéricos e luz nostálgica | Coach em posição de escuta, sem usar foto de criança real |
| `my-plans` | Mesa de planejamento diante de uma janela para o horizonte | Mapa e notas sem texto, câmera ampla e tom otimista |

### 7.2 `daily-life` — inglês do dia a dia

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `home-organization` | Apartamento funcional com itens para organizar | Wolfie coach e checklist em HTML |
| `food-cooking` | Cozinha contemporânea com bancada e ingredientes | Contraparte culinária em plano americano |
| `skincare-beauty` | Estúdio de beleza/showroom com bancada limpa | Consultor de produto 3D, sem marcas reais |
| `health-symptoms` | Consultório acolhedor e não hospitalar | Profissional de atendimento; linguagem visual sem prometer diagnóstico |
| `shopping` | Loja moderna com balcão e araras genéricas | Atendente em roleplay e área clara para preço/opções em HTML |
| `services` | Balcão flexível de hotel/atendimento | Contraparte de serviço em composição frente a frente |
| `digital-life` | Home office com dispositivos e painéis abstratos | Coach lateral; nenhum conteúdo privado ou tela legível |

### 7.3 `speaking` — pratique falando

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `record-a-story` | Estúdio vertical de creator com luz suave | Wolfie ao lado de um enquadramento de celular abstrato |
| `tell-a-story` | Pequeno palco cinematográfico com camadas de profundidade | Coach em modo ouvinte e progressão narrativa no HUD |
| `describe-what-you-see` | Galeria de observação com moldura de conteúdo dinâmica | Personagem lateral; imagem observada continua em HTML/asset separado |
| `give-your-opinion` | Lounge de podcast/debate sem marcas | Contraparte curiosa, câmera alternando entre fala e escuta |
| `speak-for-a-minute` | Microestúdio com spotlight e relógio discreto | Wolfie coach fora do centro; cronômetro é a informação principal |

### 7.4 `kids-teens` — crianças e adolescentes

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `game-worlds` | Mundo de aventura 3D original com mapa de missão | Wolfie explorador estilizado; tom seguro e lúdico |
| `roblox-inspired-missions` | Mundo modular de blocos totalmente original | Sem logos, personagens ou interface de Roblox |
| `create-your-avatar` | Oficina de criação de personagem | Manequim/cartoon editável, sem padrões corporais punitivos |
| `school-life` | Espaço comum de escola contemporânea | Guia adulto amigável e personagens de fundo não identificáveis |
| `series-characters` | Estúdio de roteiro e cinema fictício | Silhuetas originais; nenhum personagem protegido |
| `mystery-adventures` | Sala de investigação leve com pistas não assustadoras | Wolfie detetive, mapa de missão e progressão clara |

### 7.5 `career` — carreira

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `job-interviews` | Sala de entrevista contemporânea | Entrevistador em plano médio e candidato em primeira pessoa |
| `first-job` | Estação de onboarding em escritório | Colega/gestor acolhedor e checklist em HTML |
| `multinationals` | Escritório híbrido com videowall abstrato | Elenco multicultural sem estereótipo nacional |
| `promotion` | Sala de conversa de desenvolvimento e liderança | Gestor como contraparte, clima firme e respeitoso |
| `career-networking` | Lounge de evento profissional | Pequenos grupos ao fundo e interlocutor em primeiro plano |
| `career-change` | Estúdio de estratégia com caminhos visuais | Coach de carreira e opções apresentadas como UI acessível |

### 7.6 `global-meetings` — reuniões globais

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `meetings-business` | Boardroom internacional com painel de KPI abstrato | Executivo como contraparte; decisão e pergunta persistentes |
| `meetings-medicine` | Sala internacional de discussão clínica | Peer clínico; sem nome ou dado de paciente |
| `meetings-human-reproduction` | Roundtable científico multidisciplinar | Especialista clínico/laboratorial, visual técnico e acolhedor |
| `meetings-laboratories` | Sala de qualidade próxima a laboratório | Líder de qualidade; equipamentos ao fundo sem informação sensível |
| `meetings-beauty` | Showroom de lançamento e distribuição | Buyer ou líder regional; amostras sem marcas reais |
| `meetings-retail` | Sala de merchandising e performance de categoria | Comprador/parceiro; planogramas abstratos |
| `meetings-technology` | Product war room com sprint/incident board abstrato | Product lead ou stakeholder técnico |
| `meetings-logistics` | Control tower com rotas e operações abstratas | Operador/parceiro; mapa sem localização real |
| `meetings-tourism` | Sala de operações de hospitalidade e parceiros | Gestor de destino/hotel; tom relacional |
| `meetings-aviation` | Briefing operacional de aeroporto | Líder de operações; painéis sem voos reais |

### 7.7 `events` — eventos e convenções

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `events-networking` | Área de networking de conferência | Interlocutor em primeiro plano e grupos desfocados |
| `medical-congresses` | Corredor/sala de congresso médico | Peer científico; nenhum dado clínico |
| `talks` | Palco de palestra com plateia abstrata | Aluno como speaker; Wolfie em modo coach |
| `panels` | Palco com cadeiras e mesa de painel | Moderador e participantes em composição ampla |
| `trade-shows` | Estande de feira profissional genérico | Visitante/comprador em roleplay, sem logos |
| `poster-presentation` | Área acadêmica de pôster | Avaliador como contraparte; pôster é UI separada e acessível |

### 7.8 `international-exams` — provas internacionais

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `exam-cambridge` | Sala oral clássica e sóbria, sem marca oficial | Dupla de avaliadores abstrata e foco em interação |
| `exam-toefl` | Cabine moderna de prova por computador | Interface limpa, microfone e cronômetro em HTML |
| `exam-ielts` | Sala de speaking individual | Examinador em frente ao aluno, sem coaching durante a resposta |
| `exam-toeic` | Centro de avaliação corporativa | Contexto profissional e instruções objetivas |
| `exam-duolingo` | Mesa de prova remota com webcam | Sem mascote, logo, cores ou interface proprietária do exame |

### 7.9 `skill-labs` — laboratórios de habilidade

| `experienceId` | Cena pré-definida | Personagem/composição |
|---|---|---|
| `listening-lab` | Cabine acústica com fontes sonoras espaciais | Wolfie técnico lateral; ondas são decorativas |
| `pronunciation-lab` | Estúdio de voz com microfone e luz reativa | Rosto/gesto visível, mas avaliação continua textual e auditiva |
| `writing-lab` | Estação editorial minimalista | Documento central e coach secundário |
| `vocabulary-lab` | Mesa de objetos/contextos com módulos visuais | Hotspots opcionais com equivalentes acessíveis |
| `presentation-lab` | Palco de ensaio com tela abstrata | Coach na lateral e enquadramento de speaker |

## 8. Reuniões globais: prioridade de produto

### 8.1 Evitar explosão combinatória

Os dez setores visuais não precisam gerar centenas de fundos. Os tipos de reunião podem variar câmera, elenco, pressão, props e HUD sobre um kit de ambiente.

Arquétipos de dinâmica:

1. atualização e revisão;
2. projeto e governança;
3. diagnóstico e operação;
4. relação externa;
5. pessoas e liderança;
6. capacitação.

O setor define ambiente e repertório visual. O arquétipo define número de participantes, posição da câmera, ritmo e informação prioritária.

### 8.2 HUD persistente

Durante a simulação, exibir em texto:

- interlocutor ativo (`counterpart`);
- pergunta pendente (`pendingQuestion`);
- decisão em jogo (`pendingDecision`);
- competência em foco;
- nível de pressão;
- etapa pedagógica;
- estado `active`, `paused/coaching`, `awaiting_retry` ou `completed`.

O backend já preserva parte desse checkpoint. A camada visual deve transportar esses campos para `TurnGuidance` sem mudar sua semântica.

### 8.3 Estágios

O palco permanece reconhecível durante:

```text
discovery → briefing → guided_build → practice → feedback → retry
→ simulation → readaptation → improvisation → assessment → report → completed
```

A etapa muda ferramentas e HUD; não troca arbitrariamente o contexto nem reinicia a sessão.

### 8.4 Intenções do aluno

| Intenção | Comportamento visual |
|---|---|
| `perform` | Reunião ativa, interlocutor e checkpoint visíveis |
| `ask_doubt` | Cena pausada, coach sheet curto e retorno ao mesmo ponto |
| `clarify_intent` | Pergunta neutra para distinguir idioma de conteúdo |
| `request_review` | Uma correção anterior, evidência e microprática |
| `request_model` | Bandeja Good / Better / Executive e ação “faça sua versão” |
| `request_feedback` | Evidência, uma prioridade principal e retry quando necessário |

## 9. Sistema de personagens e avatares 3D

### 9.1 Direção de arte

Adotar **3D cinematográfico realista estilizado**: acabamento premium, expressão humana e materiais convincentes, mas sem perseguir fotorrealismo ou imitar uma pessoa real. Essa escolha reduz uncanny valley e melhora consistência entre gerações.

Criar uma bíblia comum com:

- Wolfie V2: proporção, rosto, pelagem, olhos, cores, roupas e escala;
- elenco de contrapartes por papel, não por estereótipo nacional;
- proporção de corpo, lente, iluminação e render constantes;
- paleta Wise Wolf e variantes por universo;
- poses `idle`, `listening`, `thinking`, `speaking`, `encouraging`, `retry` e `error`;
- recortes de desktop e mobile;
- regras de sombra e integração com o fundo.

Cast inicial recomendado:

- `wolfie-coach` — guia transversal;
- `executive-counterpart` — negócios, varejo e liderança;
- `clinical-peer` — medicina e ciências;
- `technical-stakeholder` — tecnologia, laboratório e logística;
- `service-counterpart` — turismo, serviços e compras;
- `interviewer` — carreira;
- `examiner` — provas;
- `youth-guide` — experiências infantis/teen em estilo mais lúdico.

Os nomes e backstories podem ser definidos depois. Aparência não deve determinar sotaque, competência ou nacionalidade.

### 9.2 Bitmap não é rig

Uma imagem gerada por IA não se transforma em um avatar articulado apenas com CSS.

Implementação em fases:

1. **Fase bitmap em camadas:** fundo separado, personagem transparente, posters e poses consistentes; movimento por `transform`, `opacity`, luz e partículas.
2. **Fase sprite/face padronizada:** character sheet com âncoras faciais documentadas e sprites compatíveis.
3. **Fase opcional de rig real:** Rive, Live2D, Spine ou GLB, somente após prova de desempenho e bateria.

O código atual de recortes faciais deve continuar apenas para o asset antigo durante a migração. Novos personagens usam um contrato próprio; não reutilizar coordenadas do lobo em rostos diferentes.

### 9.3 Estados de voz

| Estado | Movimento e sinal adicional |
|---|---|
| `IDLE` | Respiração discreta, postura aberta e texto “pronto” |
| `LISTENING` | Inclinação de escuta, luz do microfone e forma de onda |
| `THINKING` | Olhar/gesto curto, indicador textual e sem falsa abertura de boca |
| `SYNTHESIZING` | Luz de preparação e status explícito |
| `SPEAKING` | Movimento guiado por `outputLevel`, legenda e sinal de áudio |
| `INTERRUPTED` | Reação curta, confirmação textual e retorno claro |
| `ERROR` | Posição estável, mensagem recuperável e ação disponível |

`prefers-reduced-motion` troca animação contínua por poster estático sem remover estado, legenda ou controles.

## 10. Pipeline de geração de imagens

### 10.1 Ordem correta

1. Aprovar a bíblia visual.
2. Gerar character sheet do Wolfie V2.
3. Gerar três protótipos: reunião de negócios, cozinha e estúdio de fala.
4. Validar desktop e mobile com UI real sobreposta.
5. Gerar os dez cenários de reuniões globais.
6. Gerar os demais universos em lotes pequenos e coerentes.
7. Inspecionar cada imagem e rejeitar texto, mãos deformadas, logos, estereótipos ou composição sem área de UI.
8. Converter os aprovados para AVIF/WebP, registrar dimensões e checksum.

### 10.2 Prompt-base de cenário

```text
Crie um cenário original para o Wolf Tutor, uma plataforma premium de prática
de inglês da Wise Wolf. Estilo 3D cinematográfico realista estilizado, acolhedor,
profissional, com materiais e iluminação convincentes, sem parecer uma fotografia
de pessoa real e sem imitar personagens ou interfaces da Praktika.

Cenário: {environment_description}.
Objetivo pedagógico: {real_world_goal}.
Composição: widescreen 16:9, câmera {camera}, profundidade em três planos,
área negativa limpa no lado {ui_side} para legenda, pergunta e controles.
Iluminação: {lighting}. Paleta: {palette}. Atmosfera: {mood}.

Não incluir palavras, letras, números legíveis, logos, marcas, dashboards reais,
dados pessoais, rostos de pessoas reais ou watermark. Não inserir moldura de
celular nem componentes de interface. O cenário deve funcionar como background,
com personagens e textos adicionados em camadas separadas.
```

### 10.3 Prompt-base de personagem

```text
Crie um personagem 3D original pertencente ao universo visual da Wise Wolf.
Estilo cinematográfico realista estilizado, expressão acolhedora, proporções
consistentes com animação premium, sem fotorrealismo e sem semelhança com pessoa
real ou personagem existente.

Papel: {role}. Personalidade visual: {personality}. Figurino: {wardrobe}.
Pose: {pose}. Expressão: {expression}. Enquadramento: {framing}.
Iluminação compatível com {scene_lighting}.

Renderizar o personagem isolado, corpo ou meio-corpo completo, fundo transparente,
bordas limpas, sombra em camada separável, mãos corretas e espaço ao redor para
recorte responsivo. Não incluir texto, logo, crachá legível, objeto de marca,
watermark ou referência à Praktika. Manter exatamente a mesma identidade facial,
proporções, materiais e figurino-base da folha de referência aprovada.
```

### 10.4 Orçamento de assets

- fundo mobile: alvo de até 180 KB;
- fundo desktop: alvo de até 320 KB;
- personagem inicial: alvo de até 400 KB;
- `width` e `height` explícitos para CLS zero;
- AVIF com fallback WebP;
- carregamento prioritário apenas da cena ativa;
- prefetch somente do provável próximo passo;
- nunca usar Base64 no TypeScript/CSS;
- nunca fazer hotlink de asset externo;
- não colocar as 56 cenas no precache inicial do PWA.

## 11. Plano de implementação

### Fase 0 — baseline e contrato

- Capturar baseline visual das telas ativas em 360×640, 390×844, 768×1024 e 1440×900.
- Registrar estados críticos de Realtime, clássico, texto, retry e confirmação.
- Criar feature flag `VITE_WOLFIE_SCENARIO_UI_V2` com fallback imediato para a UI atual.
- Congelar contratos e testes funcionais antes da mudança.

### Fase 1 — bíblia de arte e protótipos

- Aprovar identidade do Wolfie V2 e elenco inicial.
- Produzir reunião de negócios, cozinha e estúdio de fala.
- Testar composição com legendas longas, teclado aberto e painel de feedback.
- Validar diferença visual sem comprometer legibilidade.

### Fase 2 — motor visual

- Criar tipos, catálogo, resolver, fallback e testes de exaustividade.
- Implementar palco, personagem, HUD, legenda e slots de painéis.
- Integrar primeiro sem alterar a máquina de estados atual.
- Garantir fallback quando um asset falhar.

### Fase 3 — conversa ao vivo

- Retirar o avatar do quadrado.
- Preservar estados, `inputLevel`, `outputLevel` e acessibilidade.
- Migrar overlays absolutos para grid + rails/bottom sheets.
- Exibir checkpoint da reunião e garantir continuidade após dúvidas.

### Fase 4 — reuniões globais

- Implementar dez ambientes setoriais.
- Aplicar os seis arquétipos de dinâmica.
- Cobrir construção, memorização, readaptação, retry, assessment e relatório.
- Testar os 12 estágios e as seis intenções de aluno.

### Fase 5 — catálogo completo

- Cobrir os outros 46 `experienceId`.
- Integrar thumbnails na descoberta, resumo e repertório.
- Garantir que todas as experiências resolvam perfil e assets válidos.

### Fase 6 — qualidade e rollout

- Auditoria WCAG 2.2 AA, zoom, teclado, leitores de tela e reduced motion.
- Testes visuais em mobile, tablet e desktop.
- Orçamento de rede, memória, LCP, INP e CLS.
- Lançar progressivamente pela feature flag.
- Comparar conclusão, abandono, retries, duração, falhas de áudio e percepção de qualidade.

## 12. Critérios de aceite

### Cobertura visual

- As 56 experiências resolvem um perfil visual versionado.
- As dez reuniões globais são distinguíveis sem depender do título.
- Cada perfil possui recortes desktop e mobile.
- Contexto parcial recebe fallback coerente.
- Falha de imagem mantém a prática funcional.
- Nenhuma tela depende de URL externa.

### Preservação funcional

- Nenhum contrato de Edge Function, banco ou RLS é alterado pelo redesign.
- Realtime, voz clássica, texto, microfone iOS, TTS, interrupção e handoff continuam funcionando.
- Confirmação de transcrição continua bloqueando corretamente o próximo turno.
- Correção, contestação, tradução, histórico, retry, memória factual e cota permanecem intactos.
- Elementos decorativos usam `pointer-events-none`.

### Design e responsividade

- O personagem principal não fica dentro de um cartão quadrado destacado.
- Palco, HUD, legenda, feedback e input não colidem nos quatro viewports de referência.
- Usar `100dvh`, safe areas e controles primários de no mínimo 44×44 px.
- Texto pedagógico nunca é incorporado a imagens.
- O tema do tenant influencia acentos sem destruir a direção da cena.
- Zoom de 200–400% converte painéis em fluxo empilhado ou sheets utilizáveis.

### Acessibilidade

- Contraste WCAG 2.2 AA: 4,5:1 para texto e 3:1 para controles/estados.
- Navegação completa por teclado e foco visível.
- Estado nunca comunicado somente por cor, som ou movimento.
- `aria-pressed` nos toggles; `aria-live` apenas para mensagens finais relevantes.
- Conteúdo em inglês usa `lang="en"`; explicação usa `lang="pt-BR"`.
- Personagens decorativos ficam fora da árvore acessível; o estado possui rótulo equivalente.

### Performance

- Cena ativa é o único asset visual grande carregado com prioridade.
- Demais assets são lazy; sem precache integral.
- Animações usam preferencialmente `transform` e `opacity`.
- Animações pausam quando a aba fica oculta.
- `Save-Data` e aparelhos fracos recebem poster + gradiente.
- Metas p75: LCP < 2,5 s, INP < 200 ms e CLS < 0,1.

### Testes e QA

- Teste de cobertura garante que nenhum ID de `experienceCatalog.ts` ficou órfão.
- Vitest cobre resolução, fallback, falha de asset e estados de palco/personagem.
- Testes existentes de reunião, resumo, áudio, handoff e política continuam verdes.
- Executar `npm run typecheck`, suíte focal, suíte completa apropriada e `npm run build`.
- Fazer QA visual em uma única sessão controlada do navegador, sem abrir várias guias.
- Verificar console, rede, 404 de asset, teclado mobile, reduced motion e perda de conexão.

## 13. Prompt mestre de execução

Copie o bloco abaixo para iniciar a implementação em uma tarefa própria.

```text
Você é responsável por refatorar a camada visual e interativa do Wolf Tutor no
repositório Wise Wolf. Trabalhe até entregar uma implementação verificável, mas
não faça deploy de produção sem autorização explícita.

OBJETIVO

Transformar o Wolf Tutor em uma experiência imersiva orientada por cenário,
com personagem integrado ao ambiente, UI responsiva e uma identidade visual
pré-definida para todas as 56 experiências do catálogo. A direção pode se
inspirar nos princípios de presença, tutores 3D, clareza e feedback contextual
da Praktika, mas deve ser original da Wise Wolf. Não copie assets, personagens,
marca, paleta, layout, textos, nomes ou composição da Praktika.

LEIA ANTES DE ALTERAR

1. AGENTS.md e instruções do repositório.
2. docs/wolfie-interactive-redesign-plan-and-master-prompt.md por completo.
3. src/components/wolfie/experienceCatalog.ts.
4. src/components/wolfie/WolfiePracticeFlow.tsx.
5. components/WolfieTutor.tsx.
6. components/WolfieAvatar.tsx.
7. src/components/wolfie/WolfieMeetingActivity.tsx.
8. docs/wolfie-global-meeting-coach-v1.md.
9. supabase/functions/_shared/wolfie-global-meeting-policy.ts.
10. Testes atuais de catálogo, reunião, áudio, memória e handoff.

CONTRATO INEGOCIÁVEL

Refatore a apresentação e a interação sem mudar a semântica pedagógica, os
contratos de Supabase/Edge Functions, persistência, RLS, áudio, TTS, Realtime,
fallback clássico, handoff, confirmação de transcrição, memória factual,
contestação de correção, retry, rubrica, relatório ou cota.

components/WolfieTutor.tsx é um controlador crítico de aproximadamente 4.600
linhas. Não faça uma reescrita integral. Extraia a apresentação em passos
pequenos, preserve handlers e estados e mantenha fallback para a interface atual.
Não trabalhe em components/WolfTutorChat.tsx como se ele fosse o produto ativo.

PLANO OBRIGATÓRIO

1. Faça inventário do estado atual e capture baseline sem alterar dados reais.
2. Crie feature flag VITE_WOLFIE_SCENARIO_UI_V2.
3. Crie um catálogo visual tipado e um resolver determinístico.
4. Escreva primeiro o teste de cobertura dos 56 IDs.
5. Implemente palco, personagem, HUD, legenda e painéis responsivos.
6. Faça um piloto com meetings-business, food-cooking e speak-for-a-minute.
7. Valide mobile e desktop antes de gerar o restante dos assets.
8. Implemente os dez cenários de reuniões globais.
9. Cubra os outros 46 cenários.
10. Execute acessibilidade, performance, QA visual e testes funcionais.

ARQUITETURA ESPERADA

Crie uma camada semelhante a:

src/components/wolfie/visuals/
  types.ts
  sceneCatalog.ts
  resolveScene.ts
  visualStateResolver.ts
  WolfieScenarioStage.tsx
  WolfieCharacter.tsx
  WolfieSessionHUD.tsx
  WolfieMeetingHUD.tsx
  WolfieCaptionBar.tsx
  WolfieCoachSheet.tsx
  WolfieSceneFeedback.tsx
  sceneCatalog.test.ts
  resolveScene.test.ts

Resolva a cena nesta ordem:

experienceId → setor confiável → universeId → experienceMode → fallback neutro.

Não derive cena de nome, transcrição ou texto livre. Não crie cadeias extensas
de condicionais dentro de WolfieTutor.tsx. O catálogo pedagógico continua sendo
a fonte canônica de experiências; o catálogo visual apenas o complementa.

TELAS NO ESCOPO

- descoberta e recomendações;
- seleção de nível, setor e formato;
- configuração e carregamento;
- quiz/listening/reading/grammar;
- writing;
- reunião: construção, memorização e readaptação;
- conversa em texto, voz clássica e Realtime;
- confirmação de transcrição;
- feedback, tradução, vocabulário, quiz e histórico sobrepostos;
- resumo, repertório, retomada e erros recuperáveis.

SISTEMA VISUAL

Cada uma das 56 experiências listadas no documento de plano deve possuir um
WolfieVisualScenarioProfile explícito. Universo define direção de arte; modo
define composição; experienceId define ambiente e props; estágio pedagógico
define HUD; estado de voz define expressão e feedback.

O personagem deve aparecer em busto, plano americano ou corpo inteiro integrado
ao cenário, nunca preso a um quadrado central. Desktop usa palco + context rail.
Mobile usa palco vertical + legenda + bottom sheet. Use slots previsíveis e não
espalhe overlays absolutos concorrendo pelos mesmos cantos.

AVATARES E IMAGENS

Use a ferramenta de geração de imagens para produzir assets 3D cinematográficos
realistas estilizados, seguindo a bíblia visual do documento. Gere fundo e
personagem em camadas separadas. Mantenha folha de referência comum para rosto,
proporção, pelagem, materiais, figurino e iluminação.

Não envie dados livres do aluno ao gerador. Não gere durante a conversa. Não use
rostos reais, logos, marcas, texto incorporado, dashboards legíveis, dados de
paciente/empresa, personagens protegidos ou elementos da Praktika. Inspecione
visualmente cada saída antes de integrá-la.

O recorte facial atual é específico do único lobo e não pode animar personagens
arbitrários. Preserve-o como fallback legado. Para novos personagens, comece com
posters/poses em camadas e estados por luz, gesto e áudio. Só adote um rig Rive,
Live2D, Spine ou GLB após medir desempenho e bateria.

REUNIÕES GLOBAIS

Priorize meetings-business, meetings-medicine,
meetings-human-reproduction, meetings-laboratories, meetings-beauty,
meetings-retail, meetings-technology, meetings-logistics, meetings-tourism e
meetings-aviation.

Exiba persistentemente counterpart, pendingQuestion, pendingDecision,
competência, pressão, etapa e status. Transporte esses campos já preservados para
a camada visual sem alterar sua semântica. Dúvida, revisão, pedido de modelo e
feedback pausam o papel, abrem coaching curto e retomam exatamente o checkpoint.

Cubra discovery, briefing, guided_build, practice, feedback, retry, simulation,
readaptation, improvisation, assessment, report e completed. Preserve o fluxo
estruturado dos seis blocos e não o substitua por uma simulação genérica.

ACESSIBILIDADE

- WCAG 2.2 AA.
- Controles de no mínimo 44×44 px.
- Foco visível e operação completa por teclado.
- Estado não depende só de cor, áudio ou animação.
- Legendas e transcrição permanecem disponíveis.
- aria-live não lê tokens parciais repetidamente.
- aria-pressed em toggles.
- lang="en" em fala/modelo e lang="pt-BR" em explicação.
- prefers-reduced-motion apresenta poster estático equivalente.
- Zoom de 200–400% empilha ou converte painéis em sheets.
- Cenário e decoração não bloqueiam eventos e usam pointer-events-none.

PERFORMANCE E PWA

- AVIF com fallback WebP e srcset.
- Fundo mobile alvo ≤ 180 KB; desktop ≤ 320 KB; personagem inicial ≤ 400 KB.
- Defina dimensões para CLS zero.
- Carregue prioritariamente somente a cena ativa.
- Faça lazy load das demais e prefetch apenas do próximo passo provável.
- Não use Base64, hotlink ou precache integral das 56 cenas.
- Pause animações fora de visibilidade.
- Respeite Save-Data e aparelho fraco com poster + gradiente.
- Preserve prioridade de CPU e rede para o áudio.
- Metas p75: LCP < 2,5 s, INP < 200 ms e CLS < 0,1.

TESTES E DEFINIÇÃO DE PRONTO

- As 56 experiências resolvem perfis válidos e assets existentes.
- Os dez setores de reunião são visualmente distinguíveis.
- Contexto parcial e erro de asset possuem fallback funcional.
- Nenhum comportamento de áudio/realtime/persistência sofre regressão.
- Não há colisão entre HUD, personagem, legenda, feedback e input em
  360×640, 390×844, 768×1024 e 1440×900.
- Teste teclado, reduced motion, zoom, safe areas e teclado virtual aberto.
- Mantenha verdes typecheck, testes focais, testes existentes e build.
- Faça QA em uma única sessão de navegador, sem abrir várias guias; verifique
  console, rede, 404, performance e estados críticos.

ENTREGÁVEIS

1. Catálogo visual tipado e exaustivo.
2. Bíblia de arte e prompts/versionamento dos assets.
3. Assets otimizados e manifestados, com autoria original.
4. Componentes visuais extraídos e integrados pela feature flag.
5. HUD específico de reuniões e checkpoint persistente.
6. Testes unitários, de cobertura e evidências de QA visual.
7. Resumo de arquivos alterados, resultados de testes, riscos restantes e plano
   de rollout. Não faça deploy sem autorização explícita.
```

## 14. Decisão recomendada

Começar pela sessão ao vivo e por três protótipos, não por 56 imagens de uma vez. A qualidade percebida depende de coerência entre personagem, cena e UI; gerar o catálogo inteiro antes de validar o palco produziria assets caros e inconsistentes.

Depois do piloto, a ordem de maior impacto é:

1. dez reuniões globais;
2. carreira e eventos;
3. speaking e vida diária;
4. provas e skill labs;
5. sobre você e kids/teens;
6. unificação opcional do Studio do Hub.

Essa sequência ataca primeiro o problema comercial mais valioso — treinamento profissional em reuniões globais — e estabelece um motor reutilizável para todo o restante.

## 15. Registro do rollout em produção

O primeiro lote visual foi ativado em produção em 2 de agosto de 2026, às
00:41 UTC (1º de agosto, às 21:41 BRT), com a feature flag
`VITE_WOLFIE_SCENARIO_UI_V2=true`.

| Campo | Valor |
|---|---|
| Commit de origem | `c1ad91a205e9` |
| Release do lote V1 | `20260802T004103Z-5d79a11ddaae` |
| Backup reversível | `/opt/wisewolf/backups/release-20260802T004103Z-5d79a11ddaae` |
| Escopo visual | Dez reuniões globais, `food-cooking`, `speak-for-a-minute` e Wolfie V2 em camada separada |
| Perfis sem bitmap próprio | 44 perfis, preservados no fallback visual determinístico |

Evidências aprovadas no rollout:

- typecheck, 54 testes do frontend, testes Deno do Wolf Tutor e build de produção;
- quatro suítes SQL transacionais executadas no servidor com `ROLLBACK`;
- frontend e Hub respondendo `200`, preflights das APIs do Wolfie respondendo
  `200` e proteções de autenticação preservadas pelo smoke test da release;
- 26 de 26 WebPs servidos como `image/webp`, com SHA-256 remoto idêntico ao
  arquivo aprovado localmente — 25 assets do lote V1 e o mascote legado;
- cena de tecnologia carregada como recurso real da interface em `1600×900`,
  sem erro no navegador headless;
- sessão de navegador encerrada após o teste, sem sessão automatizada residual.

### Segundo lote — carreira, eventos e cache imutável

O segundo lote foi ativado em 2 de agosto de 2026, às 02:26 UTC (1º de agosto,
às 23:26 BRT), preservando `VITE_WOLFIE_SCENARIO_UI_V2=true`.

| Campo | Valor |
|---|---|
| Commit de origem | `f1ee474d99eb` |
| Release ativa | `20260802T022645Z-745c73755821` |
| Backup reversível | `/opt/wisewolf/backups/release-20260802T022645Z-745c73755821` |
| Escopo visual novo | `job-interviews`, `career-networking`, `promotion`, `talks`, `trade-shows` e `medical-congresses` |
| Cobertura atual | 18 cenários com bitmap próprio; 38 perfis no fallback determinístico |

Evidências aprovadas no segundo rollout:

- 60 testes de frontend, 166 testes Deno, typecheck, checks das funções e build
  de produção;
- suítes SQL transacionais concluídas com `ROLLBACK`;
- 62/62 URLs conferidas em produção com MIME, bytes e SHA-256 — 37 assets
  primários e 25 aliases de transição para sessões já abertas;
- frontend e Hub respondendo `200`, marcador remoto apontando exatamente para a
  nova release e todos os smokes de API aprovados pelo release;
- os 12 WebPs novos, o personagem fingerprintado e um alias legado carregados
  como imagens reais, com dimensões esperadas e sem erro no navegador headless;
- sessão de navegador encerrada, sem sessão automatizada residual.

O rollback atual deve usar o backup do lote V2 registrado acima. Cada lote
seguinte deve repetir os mesmos gates de teste, checksums, acessibilidade,
responsividade e smoke test em sessão única.
