# Wolfie Tutor como produto independente

## Objetivo e status

Este documento define o blueprint de produto, experiência e implantação para
oferecer o Wolfie Tutor em uma superfície própria, reaproveitando com segurança a
infraestrutura atual da Wise Wolf. Ele é uma especificação de implementação
incremental, não uma autorização para copiar textos, imagens, personagens ou
código de terceiros.

Estado: proposta para implementação por fases.

## Decisão de domínio

### Recomendação

Usar **`wolfie.wisewolflanguage.com.br`** na primeira versão.

O subdomínio é preferível a um domínio novo porque:

- mantém a confiança e a associação com a marca Wise Wolf;
- reduz custo e complexidade de DNS, certificado, suporte e observabilidade;
- permite publicar uma experiência própria sem duplicar o produto e o backend;
- facilita uma migração progressiva a partir do sistema atual;
- preserva a opção de adotar um domínio exclusivo no futuro, caso Wolfie passe a
  ter marca, aquisição e operação comprovadamente independentes.

Um eventual domínio curto de marca pode ser reservado e redirecionar para o
subdomínio. Ele não deve ser o endereço canônico antes de existirem decisão de
marca, busca de conflito, estratégia de SEO e operação próprias.

### Fronteiras de origem

| Origem | Responsabilidade |
| --- | --- |
| `www.wisewolflanguage.com.br` | Site institucional e conteúdo principal da escola. |
| `wolfie.wisewolflanguage.com.br` | Aquisição, diagnóstico, autenticação e uso do Wolfie. |
| `api.wisewolflanguage.com.br` | APIs próprias, autenticação e funções do produto. |
| `system.wisewolflanguage.com.br` | Operação interna e experiência atual durante a transição. |

O navegador nunca deve receber chaves privadas. CORS, cookies e URLs de retorno
devem declarar explicitamente as origens autorizadas; não se deve confiar em um
subdomínio apenas por compartilhar o domínio raiz.

## Referência competitiva e fronteira ética

A análise da Praktika serve somente para identificar padrões abstratos de
produto: uma mensagem central clara, um CTA dominante, demonstração visual,
personalização, prova do funcionamento e separação entre marketing e onboarding.

### Pode inspirar

- hierarquia da jornada e redução de escolhas concorrentes;
- uso de demonstrações do produto no contexto de uso;
- apresentação progressiva de benefícios, cenários e feedback;
- aquecimento do lead antes da criação da conta;
- separação operacional entre landing page e área autenticada.

### Deve ser original

- textos, nomes de funcionalidades e narrativa comercial;
- Wolfie, avatares, cenários, ilustrações, animações e direção de arte;
- perguntas, ordem, regras e tela de resultado do diagnóstico;
- componentes, layout final, código, dados e arquitetura;
- depoimentos, métricas, preços e comparações.

Não usar ativos baixados do concorrente, não reproduzir a aparência de seus
tutores e não publicar alegações sem fonte interna verificável. Se ainda não
houver métricas, depoimentos autorizados ou preços aprovados, o respectivo bloco
deve ser omitido — nunca preenchido com números ou conteúdo provisório que pareça
real.

## Princípios do produto

1. **Valor antes do cadastro:** o visitante entende e experimenta a proposta
   antes de fornecer dados pessoais.
2. **Fala como núcleo:** a primeira missão deve levar rapidamente a uma interação
   oral, com alternativa por texto.
3. **Personalização explicável:** toda recomendação mostra quais respostas a
   influenciaram.
4. **Uma próxima ação:** cada tela tem um objetivo e um CTA principal.
5. **Privacidade por padrão:** coletar o mínimo necessário e separar consentimento
   de produto de consentimento de marketing.
6. **Continuidade:** o diagnóstico deve abrir uma primeira missão já preparada,
   não terminar em um relatório sem ação.
7. **Design próprio:** identidade Wise Wolf, cenas e personagens originais, sem
   simular associação com a Praktika.

## Mapa de rotas

### Rotas públicas

| Rota | Finalidade | Indexação |
| --- | --- | --- |
| `/` | Landing principal do Wolfie | Sim |
| `/como-funciona` | Explicação curta do método e da IA | Sim |
| `/cenarios` | Catálogo público resumido de experiências | Sim |
| `/cenarios/:slug` | Página original de um cenário | Sim, se houver conteúdo único |
| `/diagnostico` | Funil curto de aquecimento | Não |
| `/diagnostico/resultado` | Resultado preliminar vinculado à sessão | Não |
| `/entrar` | Login e recuperação de acesso | Não |
| `/privacidade` | Aviso de privacidade e direitos LGPD | Sim |
| `/termos` | Termos de uso | Sim |
| `/cookies` | Preferências de cookies e tecnologias | Sim |
| `/acessibilidade` | Recursos e canal de acessibilidade | Sim |

### Rotas autenticadas

| Rota | Finalidade |
| --- | --- |
| `/app` | Início personalizado e retomada da última missão |
| `/app/praticar` | Escolha rápida de objetivo e sessão |
| `/app/cenarios` | Catálogo completo liberado ao usuário |
| `/app/cenarios/:slug` | Preparação da experiência escolhida |
| `/app/sessao/:sessionId` | Conversa em tempo real ou modo clássico |
| `/app/resultado/:sessionId` | Feedback e próxima missão |
| `/app/progresso` | Histórico e evolução sem promessas indevidas |
| `/app/conta` | Perfil, consentimentos, exportação e exclusão |

O funil deve permanecer em uma rota estável, com a etapa representada no estado
da sessão e, quando útil para voltar/avançar, em parâmetro não sensível. Respostas
pessoais não devem ser colocadas na URL.

## Landing page

### Estrutura recomendada

1. **Cabeçalho compacto:** marca Wolfie, “Como funciona”, “Cenários”, “Entrar” e
   CTA “Descobrir meu treino”.
2. **Hero:** Wolfie em uma cena original, promessa específica de prática oral,
   breve explicação e CTA para o diagnóstico.
3. **Demonstração curta:** amostra interativa de uma conversa, correção e próxima
   resposta; nunca iniciar áudio sem ação do visitante.
4. **Cenários:** reunião global, entrevista, apresentação, viagem e conversação,
   usando o catálogo e os ambientes próprios já existentes.
5. **Como funciona:** diagnosticar, praticar, receber feedback e repetir.
6. **Personalização:** explicar como objetivo, nível, contexto e histórico mudam
   a sessão.
7. **Segurança para praticar:** controle de ritmo, legenda, repetição, texto e
   privacidade do áudio.
8. **Prova do produto:** capturas e demonstrações reais do Wolfie. Métricas e
   depoimentos entram apenas depois de validados e autorizados.
9. **Oferta:** apresentar condições somente quando produto, preço, limites e
   termos estiverem formalmente aprovados.
10. **FAQ e rodapé:** IA, microfone, dados, compatibilidade, acessibilidade,
    suporte e documentos legais.

O CTA primário deve sempre iniciar ou retomar o diagnóstico. CTAs secundários
podem abrir a demonstração ou o login, sem competir visualmente com a ação
principal.

### Direção visual própria

- manter a personalidade Wise Wolf, com Wolfie como guia e não como elemento
  decorativo isolado;
- usar ambientes 3D originais para cada família de cenário;
- mostrar microestados de escuta, pensamento, fala, correção e celebração;
- usar movimento ambiental sutil e sincronização de boca existente, respeitando
  `prefers-reduced-motion`;
- preservar contraste e legibilidade sobre as cenas;
- gerar e registrar a proveniência de novos ativos no manifesto visual;
- não reutilizar composição, paleta, molduras de telefone ou aparência dos
  personagens da referência.

## Diagnóstico curto de aquecimento

Meta de experiência: chegar ao resultado em poucos minutos, com uma pergunta
principal por tela, progresso visível, retorno à etapa anterior e salvamento
local resiliente.

| Etapa | Pergunta/ação | Resultado utilizado |
| --- | --- | --- |
| 1. Objetivo | Em qual resultado o usuário quer avançar primeiro? | Universo e missão inicial |
| 2. Contexto | Em que situação real ele precisa usar inglês? | Cenário e vocabulário |
| 3. Autopercepção | Como avalia compreensão, fala e confiança? | Dificuldade e suporte inicial |
| 4. Disponibilidade | Quanto tempo e em quais dias consegue praticar? | Ritmo sugerido |
| 5. Preferência | Correção imediata ou ao fim, ritmo e uso de legenda | Configuração da sessão |
| 6. Voz opcional | Teste de microfone e amostra curta, com consentimento específico | Sinais preliminares de fala |
| 7. Resultado | Plano inicial e primeira missão | Continuidade no produto |

Regras obrigatórias:

- o teste de voz é opcional e possui alternativa por texto;
- a permissão do microfone só é solicitada após explicação e ação explícita;
- a pessoa pode concluir sem aceitar marketing;
- a coleta de e-mail acontece após a entrega de valor, para salvar o plano ou
  iniciar a sessão;
- progresso local anônimo tem expiração e pode ser apagado;
- menores de idade seguem regra etária e consentimento do responsável definida
  juridicamente antes do lançamento.

## Lógica de resultado

A primeira versão deve ser determinística e testável. IA pode redigir a mensagem
ou refinar recomendações somente dentro de um esquema validado; ela não decide
permissões, preço, elegibilidade ou tratamento de dados.

### Entradas

- objetivo principal;
- contexto de uso;
- autopercepção de compreensão, fala e confiança;
- tempo disponível;
- preferências de correção, ritmo e legenda;
- sinais da amostra de voz, apenas quando houver consentimento e qualidade
  mínima para análise.

### Processamento

1. Validar respostas contra enums e limites conhecidos.
2. Selecionar o universo pelo objetivo e desempatar pelo contexto.
3. Definir o nível inicial de apoio pela autopercepção.
4. Se existir amostra válida, usar os sinais somente para ajustar dificuldade e
   foco; não substituir silenciosamente o que a pessoa informou.
5. Aplicar preferências de acessibilidade e feedback.
6. Escolher uma missão inicial compatível no catálogo existente.
7. Gerar uma explicação curta e rastreável da recomendação.

### Saída mínima

- objetivo resumido;
- cenário e primeira missão recomendados;
- dificuldade inicial e recursos de apoio;
- até três focos de prática;
- ritmo semanal sugerido com base na disponibilidade;
- CTA para iniciar a sessão;
- aviso “resultado preliminar” quando faltar uma amostra ou houver baixa
  confiança nos sinais.

O diagnóstico não deve declarar certificação, nível CEFR definitivo, fluência ou
garantia de resultado sem instrumento validado. Toda regra precisa de testes de
fronteira e um `reasonCode` legível para suporte e auditoria.

## Arquitetura incremental no mesmo repositório

### Estratégia inicial

Manter um único repositório, as funções existentes e o mesmo pipeline de release.
O novo subdomínio recebe um shell de produto próprio, mas compartilha componentes
Wolfie, catálogo de experiências, serviços Realtime/TTS e cliente da API.

Organização pretendida, criada conforme cada fase exigir:

```text
src/
  features/
    wolfie-standalone/
      landing/
      diagnosis/
      result/
      app-shell/
      analytics/
      domain/
  components/wolfie/       # experiência e visuais compartilhados
  services/                 # serviços compartilhados existentes
```

Não duplicar `WolfiePracticeFlow`, catálogos, prompts ou clientes de API. Adaptar
por interfaces e composição. Como o roteamento atual vive no frontend existente,
a extração deve ser gradual, sem uma reescrita integral do `App.tsx`.

### Seleção da superfície

- o host `wolfie.wisewolflanguage.com.br` abre o shell standalone;
- os hosts atuais mantêm a experiência existente;
- um feature flag permite ativação por ambiente e rollback imediato;
- rotas protegidas usam o mesmo provedor de autenticação;
- Nginx pode servir inicialmente o mesmo artefato versionado para os hosts,
  evitando dois releases divergentes;
- se tamanho, SEO ou cadência passarem a exigir isolamento, criar uma segunda
  entrada Vite no mesmo repositório antes de considerar outro repositório.

### Contratos

- schemas versionados para sessão anônima, respostas e resultado;
- catálogo de eventos analíticos tipado;
- validação no cliente e novamente na função de borda;
- idempotency key em criação de lead, vínculo de usuário e sessão;
- feature flags com valor seguro quando ausentes;
- nenhuma regra comercial ou autorização implementada apenas no frontend.

## Autenticação, RLS e LGPD

### Autenticação

- permitir diagnóstico anônimo com identificador aleatório e expiração curta;
- exigir autenticação para salvar histórico, acessar progresso ou iniciar uma
  experiência que consuma cota;
- preferir o fluxo de autenticação já suportado pelo sistema, com retorno
  explicitamente autorizado para o subdomínio;
- vincular a sessão anônima ao usuário em operação transacional e idempotente;
- rotacionar a sessão após login e impedir enumeração de contas;
- nunca armazenar tokens de autenticação em analytics ou logs de produto.

### RLS e backend

- RLS habilitada em todas as novas tabelas expostas pela Data API;
- leitura e escrita vinculadas a `auth.uid()` e, quando aplicável, ao tenant
  autorizado;
- nenhuma policy pública para listar leads, respostas, transcrições ou sessões;
- operações privilegiadas somente em Edge Functions autenticadas;
- `service_role` permanece exclusivamente no servidor;
- validar ownership da sessão em toda mutação e leitura;
- aplicar rate limit, limites de payload e proteção contra repetição;
- testes SQL negativos devem provar isolamento entre usuários e tenants.

### Privacidade e LGPD

- documentar finalidade, base legal, retenção e operadores de cada dado;
- coletar apenas campos necessários ao plano inicial;
- consentimento de microfone/voz separado e revogável;
- marketing é opt-in separado, desmarcado por padrão;
- não enviar respostas, transcrições ou áudio a pixels de publicidade;
- áudio deve ser efêmero por padrão; qualquer retenção exige finalidade,
  consentimento, prazo e exclusão definidos;
- fornecer acesso, correção, portabilidade quando aplicável e exclusão na conta;
- registrar versão do aviso e data dos consentimentos;
- aplicar política específica para crianças e adolescentes antes de liberar
  cenários direcionados a esse público;
- manter inventário de fornecedores de IA, voz, analytics e hospedagem, incluindo
  transferência internacional e cláusulas contratuais quando aplicáveis.

## Analytics e experimentação

Usar eventos próprios e uma lista explícita de propriedades permitidas. Eventos
não podem conter e-mail, telefone, nome, áudio, transcrição, tokens ou texto livre
das respostas.

### Eventos mínimos

- `wolfie_landing_viewed`
- `wolfie_primary_cta_clicked`
- `wolfie_diagnosis_started`
- `wolfie_diagnosis_step_viewed`
- `wolfie_diagnosis_step_completed`
- `wolfie_microphone_permission_resolved`
- `wolfie_voice_sample_skipped`
- `wolfie_voice_sample_completed`
- `wolfie_result_viewed`
- `wolfie_auth_started`
- `wolfie_auth_completed`
- `wolfie_first_session_started`
- `wolfie_first_session_completed`

Propriedades ficam limitadas a versão do funil, identificador de etapa, categoria
de objetivo, categoria de cenário, variante, dispositivo e resultado técnico.
UTMs são preservadas até a autenticação, sem anexar respostas pessoais. A ligação
entre identificador anônimo e usuário ocorre somente após autenticação e conforme
as preferências de privacidade.

Experimentos exigem hipótese, métrica primária, guardrails, duração e critério de
encerramento. Não usar dark patterns, urgência falsa ou resultado manipulado para
forçar cadastro. Tags não essenciais e pixels só carregam após consentimento
quando exigido.

## Acessibilidade

Meta: WCAG 2.2 nível AA nos fluxos principais.

- navegação completa por teclado e foco sempre visível;
- ordem semântica de títulos, landmarks, rótulos e mensagens de erro;
- contraste AA sobre imagens, inclusive durante animações;
- área de toque mínima de 44 por 44 CSS pixels;
- progresso do diagnóstico anunciado sem depender apenas de cor;
- alternativas de texto, legenda e transcrição para toda interação por voz;
- feedback do tutor apresentado visualmente e por região `aria-live` adequada;
- nenhum áudio automático;
- suporte a zoom de 200%, orientação e tamanhos de tela móveis;
- respeito a `prefers-reduced-motion`, sem bloquear a compreensão;
- timeout, reconexão e falha de microfone com instruções recuperáveis;
- idioma da página e mudanças de idioma declarados corretamente;
- teste manual com teclado e leitores de tela, além das verificações automáticas.

## PWA e desempenho

O subdomínio deve ter manifesto e escopo próprios, com nome, ícones e `start_url`
do Wolfie. Reutilizar a estratégia atual de assets versionados e atualização do
service worker, observando:

- navegação tenta rede e usa fallback offline somente quando necessário;
- API, autenticação, áudio e respostas privadas nunca usam cache persistente do
  service worker;
- o shell offline explica a indisponibilidade e não simula uma sessão ativa;
- bundles e cenários são carregados sob demanda;
- imagens possuem tamanhos responsivos, dimensões declaradas e formatos modernos;
- vídeo e 3D têm poster e alternativa estática;
- atualização disponível é comunicada sem prender o usuário a bundle antigo;
- cache é separado por origem e limpo ao alterar versões incompatíveis;
- instalação é oferecida após sinal de interesse, nunca no primeiro instante.

Metas de desempenho devem ser definidas e medidas com dados reais antes de virar
SLA. O aceite inicial exige ausência de regressão perceptível nos principais
dispositivos suportados e monitoramento dos Core Web Vitals.

## Deploy, verificação e rollback

### Publicação

1. Criar DNS e certificado TLS para `wolfie.wisewolflanguage.com.br`.
2. Adicionar o host ao proxy sem retirar os hosts atuais.
3. Publicar atrás do feature flag, inicialmente desligado em produção.
4. Executar typecheck, testes, build e verificação dos assets Wolfie.
5. Publicar como release imutável pelo pipeline VPS existente.
6. Validar página, manifesto, service worker, assets e preflight da API.
7. Fazer smoke test anônimo, login, sessão, resultado e logout em desktop e mobile.
8. Ativar gradualmente e observar erros, latência e abandono por etapa.

### Banco de dados

- mudanças seguem expansão e contração, com migrações compatíveis com a versão
  anterior durante o rollout;
- backup e validação antecedem qualquer migração material;
- policies RLS e testes negativos são obrigatórios antes da exposição;
- dados existentes não são reescritos em massa no primeiro lançamento.

### Rollback

- desligar o feature flag ou remover o host do novo shell é o primeiro rollback;
- restaurar o symlink para a release frontend anterior quando necessário;
- manter a release anterior e seus assets disponíveis até o fim da janela de
  observação;
- não desfazer migração de produção destrutivamente; preferir correção adiante ou
  desativação das novas leituras/escritas;
- registrar release, horário, motivo, impacto e resultado do rollback.

O rollback é considerado válido somente após novo smoke test, confirmação da
release ativa e ausência de sessões de diagnóstico quebradas.

## Fases e critérios de aceite

### Fase 0 — Fundação

Entregas: DNS/TLS preparado, host routing, shell standalone, feature flag,
contratos do diagnóstico e plano de dados.

Aceite:

- host pode ser ligado e desligado sem afetar `system` ou `app`;
- nenhuma chave privada aparece no bundle;
- rotas desconhecidas têm comportamento controlado;
- arquitetura e inventário LGPD foram revisados.

### Fase 1 — Landing original

Entregas: landing responsiva, direção visual Wolfie, cenários próprios, SEO
básico, páginas legais e CTA para diagnóstico.

Aceite:

- nenhum texto ou ativo proprietário de concorrente foi reutilizado;
- não há métrica, preço ou depoimento sem evidência e autorização;
- CTA funciona com UTMs preservadas;
- teclado, contraste, movimento reduzido e mobile passam no QA;
- página não abre áudio nem pede microfone automaticamente.

### Fase 2 — Diagnóstico e resultado

Entregas: sete etapas, persistência anônima temporária, microfone opcional,
resultado determinístico e retomada.

Aceite:

- todos os caminhos, voltar/avançar, pular voz e expiração têm testes;
- resultado possui `reasonCode` e nunca declara nível definitivo;
- dados sensíveis não aparecem em URL, analytics ou logs;
- negação do microfone não impede concluir;
- CTA abre a missão correta do catálogo.

### Fase 3 — Autenticação e primeira sessão

Entregas: login/cadastro, vínculo idempotente, shell autenticado e primeira
conversa Wolfie.

Aceite:

- sessão anônima é vinculada uma única vez;
- usuário não acessa dados de outro usuário ou tenant;
- cotas e permissões são aplicadas no servidor;
- falhas de rede, áudio, Realtime e fallback clássico são recuperáveis;
- logout remove estado privado do dispositivo e não apaga dados sem confirmação.

### Fase 4 — Segurança, LGPD, PWA e observabilidade

Entregas: RLS completa, preferências de consentimento, direitos do titular,
manifesto próprio, estratégia offline, dashboards e alertas.

Aceite:

- testes RLS positivos e negativos passam;
- exportação/exclusão e revogação de consentimento foram ensaiadas;
- service worker não guarda API, áudio ou conteúdo autenticado;
- eventos obedecem à allowlist e não contêm PII;
- atualização e rollback foram ensaiados em ambiente controlado.

### Fase 5 — Lançamento gradual

Entregas: rollout controlado, suporte preparado, análise de funil e correções.

Aceite:

- smoke tests de produção passam em desktop e mobile;
- release ativa, logs e alertas estão identificáveis;
- abandono por etapa e erros técnicos podem ser medidos sem expor respostas;
- existe responsável e procedimento para incidentes de produto, IA e privacidade;
- apenas evidências reais alimentam futuras alegações comerciais.

## Critério global de pronto

O Wolfie standalone está pronto para lançamento amplo quando a jornada
`landing → diagnóstico → resultado → autenticação → primeira sessão → feedback`
funciona de ponta a ponta, é acessível, respeita consentimentos, isola dados por
usuário e tenant, suporta atualização e rollback e não depende de conteúdo ou
identidade visual da Praktika.
