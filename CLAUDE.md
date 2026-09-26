# Wise Wolf SAAS — CLAUDE.md

Guia técnico para o Claude Code neste projeto.

---

## Stack do Projeto

> ⚠️ **NÃO usamos a nuvem da Supabase.** Tudo roda na VPS própria
> (`187.127.46.251`, host SSH `wisewolf-vps`). O que roda lá é a **stack Supabase
> self-hosted** — não é PostgreSQL puro. Confundir as duas coisas leva a desligar
> container achando que é sobra, ou a tentar deploy pelo caminho errado.

- **Frontend:** **Vite** + React + TypeScript + Tailwind CSS (`vite build`).
  Não é Next.js — não existe `next.config.*` nem App Router. `App.tsx` na raiz.
- **Backend (VPS):** `supabase-db` (**Postgres 17.6**) · `supabase-rest`
  (PostgREST) · `supabase-auth` (GoTrue) · `supabase-kong` (gateway) ·
  `supabase-edge-functions` (**Deno**) · `supabase-storage` · `supabase-studio`
- **IA:** OpenAI Realtime (`wolfie-realtime-session`), OpenRouter
  (`wolfie-brain`, `pedagogical-content`, `lesson-planner`), OpenAI TTS
  (`wolfie-tts` → `gpt-4o-mini-tts`)
- **Pagamentos:** Asaas
- **Deploy:** VPS própria — frontend servido por **nginx** em
  `system.wisewolflanguage.com.br`; API em `api.wisewolflanguage.com.br`

**Guarda-corpo no código:** `lib/supabase.ts` **lança erro** se
`VITE_SUPABASE_URL` terminar em `.supabase.co` — um build apontado para a nuvem
falha antes de autenticar. O `vercel.json` na raiz é resíduo: a produção não
passa pela Vercel (nenhum header `x-vercel-*`; o domínio resolve para a VPS).

---

## 🧭 Toda funcionalidade nova sobe com TOUR DE NOVIDADE ✅

> **Regra da direção (16/09/2026): release que muda o que o usuário vê leva junto um
> tutorial guiado.** Quem abre a plataforma depois da atualização é levado pela mão
> até a novidade, uma vez, e pode rever em **Novidades** no menu do avatar.

**Como funciona (motor único, `components/tour/GuidedTour.tsx`):**
- **Catálogo:** `lib/featureTours.ts` — lista `FEATURE_TOURS`, uma entrada por release,
  id `AAAA-MM-DD-slug`, papéis que recebem, passos apontando para `data-tour="..."`.
- **"Já vi":** tabela `feature_tour_views (user_id, tour_id)` — por usuário, vale em
  qualquer aparelho (migration `20260916200000`). RLS: cada um grava só o seu.
- **Quando abre:** `App.tsx`, no mesmo efeito do tour de boas-vindas. Primeiro acesso
  (`profiles.onboarded = false`) → boas-vindas, e ao concluir **marca todas as
  novidades como vistas** (quem acabou de conhecer o produto viu tudo como novo).
  Senão → primeira novidade do papel ainda não vista. **Erro na leitura não abre
  tour nenhum** — incomodar por engano é pior do que deixar para "Novidades".
- **Alvo invisível é pulado** (celular com `hidden lg:flex`, papel sem o recurso).
  O motor escolhe o primeiro `[data-tour]` **visível** — menu lateral e barra do topo
  levam ambos `sidebar-nav`, e só um está na tela.

**Checklist ao entregar funcionalidade visível:**
1. `data-tour="<alvo>"` no elemento que o passo aponta.
2. Entrada nova **ao fim** de `FEATURE_TOURS` (data da release no id).
3. `lib/featureTours.test.ts` varre `components/` e `App.tsx`: **alvo que não existe
   no código reprova o teste** — o tour nasce amarrado à tela. Também recusa id
   repetido, fora de ordem, passo sem `view`.
4. Texto de cada passo se sustenta sozinho (o anterior pode ter sido pulado).

⚠️ Não use `profiles.onboarded` para novidade: é booleano do primeiro acesso, não uma
lista que cresce a cada release. E não guarde "já vi" só no localStorage — reapareceria
no celular, no notebook e depois de limpar cache.

---

## Navegação: menu no topo + trilho de atalhos é o padrão ✅

Copiado do `components/shell/` do MotoFix em 16/09/2026. Diretor e professor abrem
com **categorias no header + trilho de 64px à esquerda** (arrastar do dropdown,
reordenar, "×", "+", teto 10); o botão ⇄ no header volta para a lateral clássica, e a
escolha fica no localStorage por usuário (`wisewolf.navLayout.<uid>`,
`wisewolf.shortcuts.<uid>`). Aluno, vendedor e coordenador ficam na lateral (menu
curto, sem seções). Celular não muda: gaveta + barra inferior.

- **Fonte única dos menus por papel: `lib/navModel.ts`** (`buildMenuItems`). O
  `ModernSidebar`, o `TopNav` e o `ShortcutRail` leem a mesma lista — item novo do
  diretor continua entrando por `lib/adminNav.ts` + `allowedAdminTabs`.
- **Perfil · Tour guiado · Novidades · Sair moram no menu do avatar** (`UserMenu`),
  porque no layout de topo a sidebar (e o rodapé dela) some no desktop.
- ⚠️ Preferência de layout **não é dado de negócio** — não vai para `profiles` (coluna
  nova ali exige `profileColumns.ts` + auditoria).

---

## Wise Wolf Hub — a Biblioteca é o produto de entrada para o professor autônomo ✅

> **Decisão da direção (17/09/2026):** o Hub vende **estrutura de materiais por nicho × nível**
> para o professor autônomo usar com os alunos dele (Professor Essencial R$59 = só biblioteca);
> Educador IA/Wolfie são expansão e o **tenant (Professor Negócio) é o upsell**. Todo o acervo
> é de autoria da Wise Wolf, liberado para licenciamento por assinatura.

**Estado medido antes:** catálogo "aberto" desde 26/08 com **1 item** (e a prévia dele era outro
PDF); 2 contas de QA, 0 trials, 0 checkouts, 0 leads na história. Estava no ar sem estoque.

**O trilho de publicação (não invente outro):** `pedagogical_materials` → consentimento do diretor
(`hub_catalog_opt_in`, `hub_rights_basis`, `hub_rights_declaration`, `hub_preview_source_path`) →
verificação por **outro** ator (`hub_commercial_approved`, `hub_rights_verified_by`, SUPER_ADMIN)
→ edge `sync-hub-material` copia FULL e PREVIEW para o bucket privado `hub-library` → trigger
`hub_sync_pedagogical_material_catalog` espelha em `hub_content_items` (ativo/publicado). Guardas:
`hub_material_object_has_provenance` (o arquivo tem de estar em `materials` sob
`<tenant>/<uid>/<uuid>.pdf` com `storage.objects.owner_id` de perfil do tenant),
`hub_validate_material_publication_sources`, e `private.hub_catalog_is_ready()` (fail-closed).

- ✅ **35 materiais da escola publicados em 17/09/2026** pelo trilho acima, com prévia GERADA
  (2–3 páginas iniciais, marca d'água "AMOSTRA · WISE WOLF HUB" + rodapé; script em sessão, não
  no repo). Curadoria feita por SQL com `auth.uid()` nulo (caminho previsto para service jobs),
  `requested_by` = diretor, `verified_by` = SUPER_ADMIN, declaração cita a autorização da direção.
- ⚠️ **Upload com service role não carrega `owner_id`** — a provenance falha. Depois de subir a
  prévia, `update storage.objects set owner_id = <uid do diretor>` para os objetos novos.
- ⚠️ **`sync-hub-material` processa 10 por chamada** e o worker morre em 150 s: chame com
  `materialIds` em lotes de ≤5 (35 itens = 7 chamadas, todas < 10 s).
- ⚠️ **Nicho NÃO carrega nível.** `B2_GERAL`, `BUSINESS_ENGLISH_B2`, `TOEFL_TRIAL_LESSON_B1B2` e
  `B1_TOEFL` foram remapeados para `GENERAL`/`BUSINESS`/`TOEFL_IELTS` (e apagados de
  `tenant_niches`); o Hub só tem rótulo para os nichos base (`NICHE_META` do
  `MaterialsLibrary`) — chave custom apareceria crua no catálogo.
- **Livros no Hub** (`hub_collections`) não nascem sozinhos: espelhar `pedagogical_collections`
  por título e gravar `collection_id`/`part_number` nos itens, senão o modo "Pastas" não agrupa.
  Hoje: BOOK A1 (5), BOOK A2 (3), BOOK B2 (5), Business English B2 (8), KIDS A1 (5 — o "PART 5"
  da escola é o mesmo arquivo do PART 4, ficou fora), TOEFL B1 (6) + avulsos.
- **Fora do catálogo de propósito:** "Teste" (é o onboarding interno de professores),
  "COMO MONTAR AULA?" (metodologia interna) e o KIDS PART 5 duplicado.
- **Órfãos recuperados (17/09, a pedido da direção):** dos 18 itens inativos sem fonte (material
  apagado da escola depois do espelho de julho), **6 eram únicos** e foram ativados direto em
  `hub_content_items` — FULL continua em `hub-library/pedagogical/<id antigo>/material.pdf`,
  prévia gerada em `pedagogical/<item id>/preview.pdf` (`metadata.source =
  curated_recovery_20260917`): English for Travelers A1 (2), Cyber Wolf IT A1, Wise Wolf Part 3
  A2 TI Edition, BOOK B1 WISE WOLF Part 1 (livro B1 criado no Hub), TOEFL Trial Lesson B1/B2.
  Os outros 12: 10 eram **cópias byte a byte ou de conteúdo** de itens já publicados (TOEFL
  módulos, Business Units 1,2 e 17-20), "Onboarding do Professor" é MATERIAL INTERNO. ⚠️ Esses 6
  **não existem na biblioteca da escola** — editar título/nicho é SQL no Hub, não a tela.
- **Item órfão "English for IT Students"** (fonte apagada) foi mantido: prévia própria em
  `pedagogical/b727e699…/preview.pdf`, nicho TECH. Total no ar: **42 itens, 7 livros**.
- **Lacunas de estoque** (o que a promessa "por nicho e nível" ainda não cobre): Kids acima de
  A1, Business abaixo de B2, Viagem/Tech só A1–A2, Medicina vazio, C1/C2, Geral B1 com uma
  parte só. O que cobre isso é o **gerador de material** abaixo.

**Gerador de material (Educador IA, desde 18/09/2026):** aba Educador IA do portal tem dois
modos — *Gerar material* (default) e *Planner de aula*. O gerador não precisa de perfil de
aluno: tipo (`worksheet | quiz | vocab_cards | grammar_drill | reading | conversation`) ×
nicho × nível × tema → `pedagogical-content` com `hubMode: true, action: "material"`
(`components/hub/HubMaterialGenerator.tsx`).
- **Servidor:** `pedagogical-content/hub-material.ts` (puro, testado) tem o prompt, o
  **schema estrito por tipo** (structured output, `strict: true` — todo objeto com
  `additionalProperties: false` e `required` completo, sem `minItems`) e a normalização, que
  passa cada questão de múltipla escolha pela **auditoria de gabarito do `wolfie-activity`**
  e descarta a reprovada (`dropped_items`). Reprovou o material inteiro → retry no modelo de
  mais precisão; ainda assim → 502 e **a reserva é liberada, não cobra**.
- **Cota:** a mesma `educator_ai.generate` do planner (Descoberta 2, **Essencial 3/mês**
  — migration `20260918030000`, decisão da direção de 18/09; Pro 40/mês, Studio 120/mês).
  Plano com limite 0 vê a tela de bloqueio. Reserva → geração → `hub_educator_materials` →
  commit; idempotente por `requestKey`.
  ⚠️ **Cota de plano do Hub muda por MIGRATION, nunca por UPDATE na mão**: o seed de
  `marketing_hub_foundation` roda a cada release com `on conflict do update` e devolveria
  o valor antigo no deploy seguinte.
- **Tabela `hub_educator_materials`** (migration `20260918020000`): escrita só service_role,
  leitura/apagar pelo criador ou OWNER/ADMIN da conta (mesmo desenho de `hub_educator_plans`).
  Teste `supabase/tests/gerador_de_material_do_hub.sql`.
- Medido em 18/09 dentro da VPS com `openai/gpt-4o-mini`: worksheet, quiz e conversação em
  6–8 s, ~1.000 tokens cada, 0 questões descartadas; o schema estrito foi aceito pelo provedor.
- Impressão: `window.print()` com CSS que esconde tudo fora de `#hub-material-print`; o
  toggle "versão do professor" decide se o gabarito sai no papel. Copiar texto sempre leva o
  gabarito (quem copia é quem ensina).
- **Motor v2 (18/09, pedido da direção):** todo material é personalizado ao **objetivo do
  aluno** (`goal`, texto livre: "logística numa multinacional", "estudante de gastronomia",
  "intercâmbio no Canadá") e à **faixa etária** (`audience` kids/teens/adults), e carrega
  três blocos comuns: `grammar_focus` (UM ponto escolhido do **leque gramatical do nível**,
  `CEFR_GRAMMAR_MAP` em `hub-material.ts` — o modelo não pode usar estrutura acima do
  nível), `opportunity_pt` (a "porta que abre": o que o aluno passa a conseguir fazer no
  objetivo dele) e `ai_homework` (2 tarefas com o prompt pronto em inglês para o aluno colar
  no ChatGPT/Wolfie e a dica de como continuar — ensina o aluno a se virar com IA).
  Leitura ganha `strategies` (skimming com tempo, scanning com resposta, chunking com
  tradução, shadowing com foco); conversação ganha `shadowing`. Foco gramatical ausente
  reprova o material (retry → 502, não cobra). Medido com o provedor real: logística B1 →
  present perfect para status de embarque; gastronomia A1 → there is/are na cozinha; teen
  intercâmbio A2 → present continuous com a host family. `goal`/`audience` são colunas
  (migration `20260918040000`); o resto vive no jsonb `material`.
- **Jornada de 90 dias (`kind = journey`, migration `20260918050000`):** plano de 12 semanas
  por objetivo — cada semana com tema, ponto gramatical em progressão dentro do nível, tipo de
  material, resultado, 3 passos da aula de 30 min e lição; checkpoints (4/8/12) e **ações de
  retenção** para o professor (semanas 1/3/6/10, só na versão do professor). Semana faltando
  ou tipo inventado reprova (`MATERIAL_JOURNEY_INCOMPLETE`). Sem blocos comuns (a jornada é
  o plano; o material da semana é que os carrega). Na tela, "Gerar <tipo> desta semana"
  pré-preenche tipo + tema mantendo objetivo/nível/faixa — é a estrutura que o professor
  mostra na primeira aula e o que atravessa o 3º mês. Medido: teen A1 → to be, possessivos,
  there is/are, present simple…; gastronomia B1 → present perfect, first conditional, modais…

**Assentos de aluno no Hub (18/09, migration `20260918060000`):** o aluno do professor entra
no ambiente do professor como membro `MEMBER/LEARNER` — sem tenant. `team.seats` do plano é o
número de alunos (Descoberta 1 · Essencial 2 · Pro 8 · Studio 25 · Institucional 100).
- **Convite por link:** `hub_invite_learner(conta, perfil)` grava `invite_token` (64 hex, 14 dias)
  em `hub_educator_learners`; o professor manda `https://hub.wisewolflanguage.com.br/?convite=<token>`
  pelo WhatsApp (`HubLearnersPanel`, modo "Meus alunos" da aba Educador IA). O `HubApp` lê
  `?convite=` (guardado em `sessionStorage` para sobreviver ao login), mostra a prévia
  (`hub_learner_invite_preview`, anon) e `hub_accept_learner_invite` cria membership + perfil de
  membro e liga `member_user_id`. Convite renovado do mesmo aluno não conta assento novo.
- **O gabarito nunca sai do servidor:** o aluno não tem select em `hub_educator_materials` nem
  em `hub_learner_assignments`; recebe tudo por `hub_learner_desk`, que passa cada material por
  `private.hub_strip_answer_keys` (tira `correct`, `explanation_pt`, `answer`, `model_answer`,
  `tip_pt`, `watch_out_pt`, `teacher_notes_pt`, `retention_moves_pt`, resposta do scanning e
  tradução dos chunks). `hub_complete_assignment` marca feito + recado; o professor vê em
  `hub_list_learner_seats` (RPC-only: a tabela de perfis de aluno não tem grant a authenticated,
  e policy que consulte essa tabela por dentro dá "permission denied" — use predicado definer).
- **Navegação do aluno convidado** (`subjectRole = LEARNER` numa conta que não é `LEARNER`):
  só "Meus estudos" (`HubStudentDesk`) e Wolfie quando `wolfie.turn` do plano > 0. Sem
  biblioteca (licença é do professor), sem planos, sem Educador IA. Conta pessoal de aluno
  (audience `LEARNER`, Wolfie individual) não muda.
- ⚠️ **O insert da membership dispara `hub_memberships_seed_member_profile`**, que cria o
  perfil de membro ANTES do aceite — o insert do perfil em `hub_accept_learner_invite` cai
  sempre no `on conflict`, e o update tem de carregar TUDO (objetivo, `onboarding_completed`,
  `personalized_at`). O primeiro aluno convidado em produção viu o formulário genérico do
  Wolfie em vez da mesa por isso (migration `20260918070000` conserta e repara via one-shot).
- ⚠️ **Rota anônima nova = entrada em `security_definer_authorization_hardening.sql`.** A
  suíte recusa qualquer SECURITY DEFINER com EXECUTE para anon fora da allowlist exata (nas
  duas listas: a exata e a de rotas obrigatórias). `hub_learner_invite_preview(text)` derrubou
  um release por isso.
- Teste: `supabase/tests/assentos_de_aluno_no_hub.sql` (convite, teto, aceite com perfil
  completo, prévia, mesa sem gabarito, estranho recusado, conclusão). Verificado ponta a ponta
  em produção em 18/09/2026 com a conta QA (`qa-gerador-…` → `qa-aluno-assento-…`, as duas
  com `test_fixture` no metadata do auth).

**Upsell para o tenant (Professor Negócio):** `/seja-professor` grava `saas_leads`
(lead_type `teacher`). Migration `20260918010000`:
- trigger `zzz_saas_lead_notify_management` avisa o grupo da Gestão da escola operadora
  (`hub_settings.metadata.salesNoticeTenantId`, dado e não código) pela `notification_queue`
  (MANAGEMENT_NOTICE, idempotente por `saas_lead:<id>`); falha no aviso nunca derruba o lead;
- `convert_teacher_lead_to_tenant` (service_role, idempotente) cria tenant `teacher` em trial +
  `saas_subscriptions`; a edge **`activate-teacher-tenant`** (SUPER_ADMIN) chama a RPC, cria a
  conta SCHOOL_ADMIN do dono e manda o e-mail "Ative seu acesso à Wise Wolf"
  (`sendAccountActivation`, o mesmo de professor/aluno). `TeacherLeadsPanel` usa isso.
- ⚠️ O painel antes inseria o tenant pelo navegador e mostrava `/teacher-onboarding?tenant=…`,
  que `TeacherOnboarding` recusa (só aceita `?offer=<uuid>`) — link morto. Não volte a gerar
  link ali; a ativação é o e-mail.
- E-mail que já pertence a professor/aluno/diretor de outro ambiente é **recusado**
  (`OWNER_EMAIL_IN_USE`); só conta NON_STUDENT (vinda do Hub) evolui para dona do tenant.

---

## Google Meet da escola: registro das aulas e presença ✅

> Runbook completo: `docs/runbooks/google-meet-pedagogical-documentation.md`. Leia antes de mexer em
> `supabase/functions/google-meet`, `lesson_sessions.documentation_consent` ou na Central de Qualidade.

**Conta e projeto (26/09/2026):** Google Workspace **Business Plus** assinado sobre o Gmail da conta
central (sem domínio → sem organização no Cloud → app OAuth **Externo, em produção, não verificado**,
uso próprio < 100 usuários). Projeto `wise-wolf-aulas`, APIs Meet REST + Drive, cliente OAuth Web com
retorno `https://api.wisewolflanguage.com.br/functions/v1/google-meet`.

- ⚠️ **O segredo do cliente OAuth entra pela direção**, com `bash deploy/vps/configurar-google-meet.sh`
  (lê o JSON de Downloads, grava em `.env.functions` pelo stdin do ssh, gera a chave de cifragem NA VPS,
  apaga o JSON). Nunca colar no chat nem commitar.
- **O que existe (12/09 + 26/09):** sala exclusiva por sessão criada pela conta central, professor
  como coanfitrião, transcrição e anotações do Gemini automáticas, importação após a aula, revisão do
  professor, resumo aprovado na memória do aluno.
- **Termo de registro** (migration `20260926120000`): aluno/responsável aceita uma vez por link
  (`/registro-das-aulas?token=`), professor aceita no app; o job de 15 min marca as sessões das
  próximas 24 h com os dois aceites. Menor de idade exige responsável. Rotas anônimas nas duas listas de
  `security_definer_authorization_hardening.sql`.
- **Presença** (migration `20260926140000`, flag `GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED`): vem do
  **relatório de presença nativo do Google** (planilha no Drive da conta central), nunca de
  `participants` da API do Meet — o Google diz que ela não é para acompanhamento de desempenho.
  Divergência com o lançamento (aluno ausente em aula dada, falta do aluno com aluno na sala, professor
  ausente, atraso 10+ min, aula fora da sala) **só abre caso** na Central de Qualidade
  (`MEET_ATTENDANCE`, `LATE_START`, `OUTSIDE_ROOM`). Decisão da direção: nada disso altera pagamento.
- ⚠️ **Formato do relatório não é documentado pelo Google.** `attendance.ts` aceita colunas pt/en e
  horários em vários formatos; conferir no primeiro relatório real e ajustar. Nome real (26/09):
  "Relatório de participação em fxj-hykv-jev (2026-09-26 14:41)".
- ✅ **Sem computador ligado** (teste real 26/09): sala criada pelo servidor, só o professor (Gmail
  pessoal, COHOST) entrou e a conta da escola nunca — transcrição, anotações do Gemini e relatório de
  presença saíram assim mesmo. Aulas simultâneas = salas independentes da mesma conta.
- ⚠️ **`accessType: RESTRICTED` é recusado** na conta sobre Gmail (403 `updateAccessType`). O provider
  repete com `TRUSTED` só nesse erro exato (`provider.test.ts`). Antes do conserto, nenhuma sala nascia.
- ⚠️ **`drive.meet.readonly` NÃO exporta** as anotações do Gemini nem o relatório de presença (403
  `appNotAuthorizedToFile`, medido 2×) — por isso o escopo é `drive.readonly`, e o código só abre o id
  que a Meet API aponta e planilhas da própria conta com o código da sala no nome. Mudou escopo →
  **reconectar a conta central** (a tela avisa com `scopes_outdated`).
- ⚠️ **`get_my_lesson_rooms` só devolve sessão com sala da escola OU aceite de documentação**
  (migration `20260926160000`). Antes ela devolvia toda `lesson_session` (a agenda vira sessão a cada
  15 min) com link nulo, e `lib/lessonRooms.ts` — que corretamente não abre sala pessoal em aula com
  aceite — deixava o **botão "entrar na aula" do app vazio em todas as aulas de 13/09 a 26/09** (medido:
  4 de 4 aulas de um professor em 25/09). Ninguém reclamou porque o lembrete do WhatsApp usa
  `profiles.meeting_link`. Conserto no servidor vale até para PWA antigo em cache.
- ⚠️ Testando reunião no Chrome da escola: o Meet **entra com a câmera ligada** (permissão já dada ao
  site). Desligar câmera e microfone logo ao abrir (`cmd+e`, `cmd+d`).

---

## Wolfie: gratuito x premium — a VOZ é a fronteira ✅

> **A separação não é de tela, é de servidor.** Antes existiam dois blocos na
> entrada ("Prática livre" e "Chamada ao vivo · premium"), mas nenhuma regra
> atrás deles: o modo clássico gerava voz paga da OpenAI para qualquer aluno,
> sem limite e sem aparecer no painel de custo.

| Tier | O que o aluno tem | Custo |
|------|-------------------|-------|
| **Gratuito** | Fala (speech-to-text), escreve e recebe correção — o Wolfie responde **por escrito**. Ilimitado. | Transcrição + modelo de texto |
| **Premium** | O Wolfie **fala**: conversa ao vivo (speech-to-speech) e resposta falada no modo clássico. | Realtime + TTS |

- **Fonte única:** RPC `wolfie_student_tier` → `private.wolfie_tier_snapshot`
  (migration `20260803235500_wolfie_free_premium_tiers`). Superfícies:
  `wolfie_tier_for_student(uuid)` (edge functions) e `my_wolfie_tier()` (aluno).
- **Quem é premium:** assinante do `wolfie-direct` com assinatura viva, ou aluno
  da escola com franquia `wolfie.live_minutes` **configurada e com saldo** (por
  plano ou crédito comprado).
- ⚠️ **Franquia não configurada NÃO é premium.** É ausência de decisão
  comercial. Tratar como premium daria voz paga à escola inteira de graça.
- ⚠️ **O acesso ao ao vivo continua fail-open** (`wolfie_live_balance` devolve
  `allowed=true` quando não há franquia). O tier só reporta isso em
  `live_enforced` — cortar de surpresa tiraria do ar um recurso em uso. Definir
  a franquia é decisão do diretor.
- **No cliente:** `WolfieTutor` bloqueia `speak()` quando o tier é gratuito e
  **não cai no Web Speech** ao receber 403 — o fallback do navegador falaria de
  graça e furaria a separação. Tier desconhecido (`null`) segue em frente: quem
  decide é o servidor.
- **Custo:** `wolfie-tts` e a transcrição do clássico gravam em
  `ai_usage_events`, e o `AiCostPanel` separa gratuito / premium / interno.
  Preços de `gpt-4o-mini-tts` e `gpt-4o-transcribe` cadastrados em
  `ai_model_pricing` (migration `20260804034000`, tabela oficial de 04/08/2026).
- ⚠️ **Os tokens do `wolfie_tts` são ESTIMADOS** — a API de fala não devolve
  `usage`. Texto ≈ 1 token/4 caracteres; **áudio ≈ 2,67 tokens/caractere**
  (40 tokens/s de fala × ~15 caracteres/s; os 40 tokens/s saem da própria
  tabela da OpenAI: US$ 0,003/min ÷ US$ 1,25/1M). Gravar a saída de áudio é o
  que importa: ela custa **20× o texto** (US$ 12,00 contra US$ 0,60 por 1M).
  Registrar só a entrada mostraria ~5% da conta real.
- ⚠️ `wolfie_activity_listening_tts` (áudio de exercício de listening) segue
  **no gratuito** de propósito: é material de atividade, não resposta do tutor.

---

## Wolfie AI Tutor — Arquitetura de Áudio ✅ FUNCIONANDO

> **Leia isto ANTES de qualquer alteração em `WolfieTutor.tsx` ou `wolfie-tts`.**  
> Levou semanas para descobrir e estabilizar. Não quebre o que funciona.

### Stack de Áudio

| Camada | Desktop | iOS Safari/Chrome |
|--------|---------|-------------------|
| TTS (geração) | `wolfie-tts` → OpenAI `gpt-4o-mini-tts` | idem |
| Playback principal | `AudioContext` + `BufferSource` | `HTMLAudioElement` pré-ativado |
| Fallback 1 | `HTMLAudioElement` (blob URL) | `AudioContext` (se preUnlocked falhar) |
| Fallback 2 | `Web Speech API` | `speakWebSpeech` |

---

### Edge Function: `wolfie-tts`

**Localização:** `supabase/functions/wolfie-tts/index.ts`  
**TTS em uso:** **OpenAI** `gpt-4o-mini-tts` — é o fallback oficial de voz para
tudo que não está numa sessão speech-to-speech da Realtime API.

```
POST https://api.openai.com/v1/audio/speech
  model: gpt-4o-mini-tts        ← WOLFIE_TTS_MODEL sobrescreve
  voice: cedar                  ← WOLFIE_TTS_VOICE_PT / _EN, contra allowlist
  instructions: <por idioma>    ← pt | en | mixed
  response_format: mp3
  speed: 0.25–4                 ← normalizado no servidor
```

**Regras críticas:**
- ✅ **A `OPENAI_API_KEY` nunca sai do servidor** — vive só em
  `/opt/wisewolf/supabase-docker/.env`. Sem ela a função devolve 503, não tenta
  nada alternativo.
- ✅ **Só aluno autenticado chama** (`allowedRoles: ["STUDENT"]`, sem
  service-role) e assinante do tenant `wolfie-direct` passa por
  `requireWolfieProductAccess` antes de gerar áudio.
- ✅ **Voz vem de allowlist** (`cedar`, `marin`, `alloy`, `nova`…); valor de env inválido
  cai em `cedar` em vez de quebrar.
- ✅ **`instructions` por idioma** manda preservar nome próprio, cidade e número
  exatamente — é o que impede o TTS de "corrigir" o que o aluno disse.
- ✅ **Teto de 32 KB por request**; acima disso, 413.

**Histórico — o que já foi TTS aqui e por que saiu:**
- 🕘 **Google Translate TTS** (grátis, sem auth) foi o motor até a migração para
  a voz oficial da OpenAI, que trouxe voz única entre modo ao vivo e clássico.
  Exigia User-Agent de browser real, chunks de 180 chars e locale extraído do
  nome da voz. Nada disso vale mais.

**O que NÃO funciona no Deno/Supabase Edge Functions:**
- ❌ **Microsoft Edge TTS (WebSocket)** — WebSocket conecta, mas mensagens binárias nunca chegam. Tentamos 7 versões com `binaryType`, subprotocolos, ConnectionId — nada funcionou.
- ❌ **Streamelements TTS** — era free, agora retorna 401 (exige auth)
- ❌ Qualquer WebSocket para TTS — o runtime Deno do Supabase tem problemas com binary frames externos

---

### iOS Safari/Chrome — Regras de Ouro

**Problema:** iOS bloqueia `audio.play()` e `speechSynthesis.speak()` em callbacks assíncronos. O fetch do wolfie-tts leva 2-5s → o callback está fora do contexto de gesto → iOS bloqueia silenciosamente.

#### Detecção de iOS
```typescript
// Módulo-level (fora do componente)
const IS_IOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);
```

#### `unlockAudio()` — DEVE ser chamado no `onTouchStart`
```typescript
// Três camadas de unlock, todas necessárias:

// 1. AudioContext: cria + resume + toca 1 sample silencioso
const ctx = new AudioContext();
ctx.resume().then(() => {
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start(0);
});

// 2. Web Speech API unlock (para o fallback)
const u = new SpeechSynthesisUtterance('');
window.speechSynthesis.speak(u);
window.speechSynthesis.cancel();

// 3. HTMLAudioElement pré-ativado — CRÍTICO: src vazio NÃO funciona no iOS!
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const audio = new Audio(SILENT_WAV); // src válido obrigatório
audio.volume = 0;
audio.play().then(() => audio.pause()); // ativa o elemento
preUnlockedAudioRef.current = audio;    // guarda para uso no callback async
```

#### `startIOSKeepAlive()` — inicia no `onTouchStart`, para ao receber áudio
```typescript
// iOS suspende AudioContext após ~1-2s de inatividade.
// O fetch leva 2-5s → contexto suspende antes de decodeAudioData.
// Solução: toca 1 sample silencioso a cada 500ms.
setInterval(() => {
  if (ctx.state !== 'running') return;
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start(0);
}, 500);
```

#### Playback no iOS — ordem de tentativa em `speak()`
```
1. preUnlockedAudioRef + blob URL  ← mais confiável (elemento já ativado no toque)
2. preUnlockedAudioRef + data URI  ← fallback sem blob URL
3. AudioContext.decodeAudioData    ← funciona se keepalive manteve ctx running
4. speakWebSpeech()                ← último recurso (qualidade baixa + limitado em async)
```

#### Regras de onde chamar o unlock
```typescript
onTouchStart → startRecording() → unlockAudio() + startIOSKeepAlive()
onTouchEnd   → stopRecordingAndSend() → unlockAudio() (re-unlock mais próximo do speak)
onClick texto → sendMessage() → unlockAudio()
```

---

### Desktop (Chrome/Firefox/Edge)

**Sem restrições de gesture.** Fluxo simples:
1. `AudioContext.decodeAudioData(bytes)` → `BufferSource.start(0)` ← preferido (qualidade, sem lag)
2. `HTMLAudioElement` + blob URL ← fallback
3. `Web Speech API` ← último recurso

---

### Arquivos Relevantes

| Arquivo | Responsabilidade |
|---------|-----------------|
| `components/WolfieTutor.tsx` | Unlock, keepalive, playback iOS/Desktop, estado da conversa |
| `supabase/functions/wolfie-tts/index.ts` | Geração TTS → OpenAI `gpt-4o-mini-tts` → base64 MP3 |
| `supabase/functions/wolfie-brain/index.ts` | IA conversacional (OpenRouter) — NÃO mexer no TTS |
| `supabase/functions/wolfie-realtime-session/index.ts` | Voz ao vivo (OpenAI Realtime) — não usa o `wolfie-tts` |

### Variáveis de Ambiente (runtime das Edge Functions, na VPS)
- `wolfie-brain`: `OPENROUTER_API_KEY`
- `wolfie-tts` / `wolfie-realtime-session`: `OPENAI_API_KEY` (obrigatória),
  `WOLFIE_TTS_MODEL`, `WOLFIE_TTS_VOICE_PT`, `WOLFIE_TTS_VOICE_EN`,
  `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `OPENAI_SAFETY_SALT`
- ⚠️ Nenhuma delas pode ter prefixo `VITE_` nem entrar em arquivo versionado —
  elas vivem só em `/opt/wisewolf/supabase-docker/.env` (600, root)

---

## Verificação de Presença (anti-fraude) ✅ FUNCIONANDO

> **Leia antes de mexer em pagamento de professor, `class_logs` ou disparos de WhatsApp.**

**Problema:** professor podia faltar e lançar `STUDENT_ABSENCE` (remunerado) para receber. A trava cria uma **2ª fonte independente: o aluno confirma se a aula aconteceu.**

**Fluxo (atrelado à OCORRÊNCIA da aula, não ao lançamento):**
1. Cron `wisewolf-send-attendance-confirmations` (a cada 15 min) → `trigger_send_attendance_confirmations()` → `enqueue_attendance_confirmations()` cria confirmações para aulas que terminaram (~40 min após `start_at`, lendo a view `upcoming_classes`) → edge `send-attendance-confirmations` envia o link.
2. Link 1-clique vai pela **instância CENTRAL da escola** (WhatsApp do `SCHOOL_ADMIN` do tenant, resolvido dinamicamente) — NUNCA pela instância do professor checado.
3. Aluno abre `https://system.wisewolflanguage.com.br/confirmar-presenca?token=...` (rota pública do SPA, `components/ConfirmAttendance.tsx`) e responde. RPC `apply_student_response`.
4. **Reconciliação em qualquer ordem** (`reconcile_attendance_confirmation`): roda quando o aluno responde E/OU quando o professor lança (`trigger trg_class_log_reconcile`). Divergência → `CONFLICT` + `class_logs.payment_hold = true`.
5. Pagamento (`TeacherFinancials`, `FinancialClosingModal`, `TeacherDashboard`) exclui `payment_hold = true`.
6. Admin resolve em **"Verificar Presença"** (`components/AttendanceDisputes.tsx`) → RPC `resolve_attendance_conflict(id, pagar bool)`.

**Regras críticas / pegadinhas:**
- ⚠️ **Página para o usuário final vai no SPA** (rota pública em `App.tsx`), não em edge function. Mas o motivo registrado aqui — "o gateway força `content-type: text/plain` + CSP `sandbox`" — **não se confirma hoje** (medido em 09/08/2026): `GET https://api.wisewolflanguage.com.br/functions/v1/accept-coverage?token=…` devolve `content-type: text/html; charset=utf-8`, sem CSP, e o HTML renderiza — é assim que a confirmação de cobertura funciona. Ou a configuração do gateway mudou, ou o diagnóstico original era outro. A recomendação continua de pé por razões próprias (rota versionada com o app, sem duplicar layout e sessão); **o que não vale é repetir a causa sem medir de novo**.
- ✅ **Evolution API (`api.2b.app.br`) usa formato v2**: `{ number, text, delay, linkPreview }`. O formato v1 (`{ textMessage: { text } }`) é rejeitado com 400.
- ✅ **apikey global** `d037...` funciona para qualquer instância (não use tokens específicos de instância).
- Estados de `attendance_confirmations.status`: `PENDING` → `AWAITING_TEACHER` (aluno respondeu, prof não lançou) / `CONFIRMED` / `CONFLICT` → `RESOLVED_PAID` / `RESOLVED_UNPAID`.
- Confirmações só são criadas para `presence IN ('COMPLETED','STUDENT_ABSENCE')` com aluno e telefone válidos.
- Aluno que NÃO responde fica `PENDING` e é pago pela confiança (não pune professor honesto).

**Arquivos:** `components/ConfirmAttendance.tsx`, `components/AttendanceDisputes.tsx`, `supabase/functions/send-attendance-confirmations`, `supabase/functions/confirm-attendance` (legado, não renderiza). RPCs no Postgres: `apply_student_response`, `reconcile_attendance_confirmation`, `resolve_attendance_conflict`, `enqueue_attendance_confirmations`, `get_confirmation_public`.

---

## Disparo de Confirmação de Aula (lembrete 30min) ✅

- `prepare-daily-reminders` (cron 5min): enfileira lembrete para aulas começando em 25-35 min (≈30 min antes). Professor com `date_automation_enabled = false` é pulado (modo manual).
- `TeacherDashboard`: seção "Aulas de Hoje" com botão **Disparar** por aluno (envia pela instância do professor, template personalizado via `send-class-notification`) + badge AUTO/MANUAL.
- `AutomacaoSmart`: toggle Automático (30min) vs Manual + QR de conexão.

---

## Gestão de Alunos e Professores (diretor/professor) ✅

**Alunos:** `StudentsList` (lista com risco/frequência/filtros/RBAC), `StudentProfileView` (ficha 360 role-aware), `StudentInsightsBoard` (aba "Painel de Alunos": risco de evasão, carga por professor, **Resumo IA** via `school-ai-digest`/OpenRouter).
**Professores:** `TeacherManagement` (CRUD), `TeacherProfileView` (ficha 360), `TeacherInsightsBoard` (aba "Gestão Profs": scorecard, alertas, custo-hora real, folha estimada, compliance PIX/contrato).

**RPCs (SECURITY DEFINER, escopo por papel via auth.uid()):**
- `list_students_overview()` / `get_student_overview(uuid)` — risco ponderado (FORTE: atraso/faltas/saída; FRACO: inatividade>30d/freq baixa). Professor não recebe financeiro.
- `list_teachers_overview()` / `get_teacher_overview(uuid)` — alertas (FORTE: 2+ faltas do prof/conflitos/NF pendente; FRACO: avaliação<3.5/cadastro incompleto). Só admin.
- `rate_attendance(token, stars)` — avaliação 1-5 do aluno na confirmação de presença → alimenta `avg_rating` do professor.

**Tabelas/colunas:** `student_teacher_notes` (observações), `profile_audit_log` + trigger `log_profile_changes` (auditoria STUDENT: financeiro/contrato; TEACHER: hourly_rate/commission/status/pix), `attendance_confirmations.student_rating`, `student_payments.due_reminder_sent_at`.
**Crons:** `wisewolf-notify-payment-due` (aviso de vencimento 3 dias antes).
**Regra de risco:** sinais FRACOS sozinhos NÃO alertam (evita ruído de `class_logs` esparso). Ajuste thresholds nos RPCs `list_*_overview`.

---

## SaaS / Super Admin (topo da pirâmide) ✅

> O SUPER_ADMIN tem caminho de render **separado**: `App.tsx` retorna `<SuperAdminDashboard/>` direto (não usa `ModernSidebar`/contentMap). Abas internas em `SuperAdminDashboard` (`command`/global/tenants/crm/infra/billing/teachers).

**Command Center** (`SaasCommandCenter`, aba default): KPIs reais (MRR/ARR/ARPU, escolas ativas, sem plano, em risco, trials expirando, faturas vencidas) + lista de escolas com health/risco B2B. `TenantProfileView` = ficha 360 da escola (uso, plano, faturas) + **atribuir plano** (`assign_tenant_plan`).

**RPCs (SECURITY DEFINER, só SUPER_ADMIN via `is_super_admin()`):** `saas_metrics()`, `list_tenants_overview()`, `get_tenant_overview(text)`, `assign_tenant_plan(text, uuid)`. `tenants.id` é **text** (slug, ex. `school-wise-wolf`) = `profiles.tenant_id`. Exclui sempre `id='master'` (a própria plataforma). `plan_id`/`saas_plans.id` são **uuid**.

**Billing B2B:** `run_saas_billing()` (cron `wisewolf-saas-billing` diário) — gera `saas_invoices` mensais (idempotente por `period_month`, único `(tenant_id, period_month)` — índice NÃO-parcial p/ ON CONFLICT), marca `OVERDUE`, auto `past_due` → `blocked` (>10d), reativa quem quita. **No-op enquanto tenants não têm `plan_id`** (estado atual: nenhum tem plano → MRR=0; atribuir plano liga a receita).

**Risco B2B (ponderado):** FORTE: bloqueado/past_due, fatura vencida, trial expirado sem plano, sem plano. FRACO: sem atividade 30d, sem alunos, ≥80% do limite.

---

## Automações de WhatsApp por Cron ✅

> Todas resolvem a **instância central da escola** via `profiles.whatsapp_instance` do `SCHOOL_ADMIN`/`SUPER_ADMIN` do tenant, usam payload **Evolution v2** (`{number,text,delay,linkPreview}`) com a apikey global, e são **idempotentes** via tabela `automation_sent (kind, subject_id, ref_date)` — índice único `(kind, subject_id, ref_date)`.

**Base (migrations `automation_base` + `automation_read_rpcs`):**
- `automation_sent` — dedupe diário. Cada envio insere uma linha; antes de enviar checa se já existe (mesmo `kind`+`subject`+`ref_date`).
  - ⚠️ **`ref_date` NÃO é a data do envio** — é a data de referência do assunto
    (no rateio, o `created_at` do pagamento). Para saber **quando o último aviso
    saiu**, use `automation_sent.created_at`. Ler `max(ref_date)` produziu, em
    25/08/2026, um diagnóstico de "9 dias de silêncio e 8 pagamentos sem aviso"
    que **não existiu** — e quase virou 6 avisos duplicados de dinheiro no grupo.
  - ⚠️ **A marca é gravada ANTES do envio** e apagada se o envio falha. Logo,
    linha em `automation_sent` = mensagem entregue; ausência = não entregue.

- ⚠️ **`profiles.directors_group_id` tem DOIS donos — cuidado ao mexer.**
  `accept-opportunity` manda por ele o aviso de experimental aceita (na Wise Wolf
  aponta para o grupo *EXPERIMENTAL CONFIRMADAS*), e a trava de posse
  `resolveOwnedTenantWhatsAppDestination` o usa como **allowlist** de quem pode
  receber relatório financeiro. O grupo do dinheiro é o *Gestão*, configurado em
  `dre_report_settings.destino` e registrado em campo nenhum do perfil — por isso
  a trava (22/08/2026) derrubou o aviso de rateio e o DRE, e **só esses dois**:
  `TEACHER_AGENDA`, `MONTHLY_CLOSING` e `WEEKLY_DIGEST` nunca falharam, porque
  usam outro destino.
  Conserto: **`resolveTenantConfiguredWhatsAppDestination`** para destino que vem
  da configuração da própria escola (linha escopada por `tenant_id`, gravada só
  pelo admin dela). A trava estrita continua existindo e continua sendo a certa
  para destino vindo do corpo de uma requisição — não troque uma pela outra sem
  olhar de onde o valor veio.
  - ⚠️ **Recusa de destino tem de ser VISÍVEL.** Ela virava só um item em
    `failures[]` dentro de um corpo de resposta HTTP que ninguém lê. Hoje sai como
    `console.error("[whatsapp] destino recusado...")`. Diagnóstico:
    `ssh wisewolf-vps 'docker logs supabase-edge-functions --since 24h | grep "destino recusado"'`.
- `run_monthly_teacher_closing(p_month text DEFAULT NULL)` — default = mês anterior; gera `teacher_closings` (idempotente por `NOT EXISTS`) computando aulas pagas × `hourly_rate`. Retorna `{ok, month, created}`.
- RPCs de leitura (só `service_role`): `birthdays_today()`, `teacher_agendas_today()`, `trial_followups()`, `weekly_digest_rows()`, `monthly_closings_to_notify(text)`.

**Edge functions (deploy `--no-verify-jwt`, cron internas):**
| Edge | Cron (`cron.job`) | Quando (UTC / BRT) | O quê |
|------|-------------------|---------|-------|
| `daily-automations` | `wisewolf-daily-automations` | `0 11 * * *` (08:00 BRT) | 3 em 1: **aniversário** (aluno+professor, `kind=BIRTHDAY`), **agenda do dia** do professor (`TEACHER_AGENDA`), **follow-up de trial** feito há 2 dias sem matrícula (`TRIAL_FOLLOWUP`) |
| `weekly-director-digest` | `wisewolf-weekly-digest` | `0 11 * * 1` (seg 08:00 BRT) | Resumo da semana pro diretor (`WEEKLY_DIGEST`): alunos ativos, aulas 7d, recebido 7d, inadimplência |
| `monthly-teacher-closing` | `wisewolf-monthly-closing` | `30 6 1 * *` (dia 1, 03:30 BRT) | Gera fechamento do mês anterior (`run_monthly_teacher_closing`) + avisa cada professor com aulas>0 (`MONTHLY_CLOSING`, subject=`teacher:month`) com link p/ *Financeiro → Meu Relatório (PDF)* |

**Wrappers cron** (`trigger_daily_automations` / `trigger_weekly_director_digest` / `trigger_monthly_teacher_closing`): padrão idêntico ao `trigger_notify_payment_due` — lê `vault.decrypted_secrets` (`wisewolf_service_role_key`) + `net.http_post` com `Authorization: Bearer <service_key>`.

**Testar manualmente:** `SELECT trigger_daily_automations();` → checar `SELECT * FROM net._http_response WHERE id=<request_id>` e `SELECT * FROM automation_sent WHERE ref_date=current_date`. Re-disparar deve retornar `skipped` (idempotência). ⚠️ Disparar manualmente **envia WhatsApp real** aos destinatários do dia.

---

## Gestão de Afiliados (SALESPERSON) — modelo híbrido por cupom ✅

> **Decisão da direção (25/09/2026): o afiliado NÃO gera link.** A indicação é o
> **cupom** dele (ex.: `AFILIADA10`). Quem se matricula com cupom fica isento da taxa
> de matrícula; o afiliado ganha um valor fixo por matrícula, liberado quando a
> **1ª mensalidade é liquidada**. Migration `20260924194214_affiliate_coupon_commission_settlement`
> (ainda **não publicada** em 25/09), teste `supabase/tests/affiliate_coupon_commission_settlement.sql`.

- **Convite:** `VendorInviteGenerator` → `create_affiliate_invite(comissão, nome, cupom)` —
  passa pela porta de sempre (`create_invite_offer`, que confere papel e escola) e **reserva
  o cupom** até o convite ser usado ou vencer (`affiliate_code_in_use` se já é de alguém).
  `/vendor-onboarding` explica o programa inteiro (cupom, liquidação, saque) antes do
  formulário e exige o aceite das regras (`acceptedTerms`, conferido no `register-vendor`).
  Cupom tomado entre o convite e o cadastro não trava: a conta nasce com cupom gerado.
- **Atribuição — três portas, um benefício** (`private.grant_affiliate_benefit`: taxa 0 +
  comissão congelada em `offers.metadata.affiliate_commission_cents`):
  1. o aluno digita o cupom na página de matrícula (`apply_affiliate_coupon`, service role
     via `tenant-legal-assets`, 10 chutes/hora por oferta);
  2. a escola põe o cupom no **link manual** (`RegistrationLinkGenerator` →
     `create_enrollment_offer_with_affiliate(payload, cupom)`, que chama a porta pública e
     aplica o benefício no mesmo commit; cupom inválido desfaz o link inteiro). O campo
     aceita cupom **ou nome** (`find_affiliates`, sem acento): cupom exato resolve sozinho;
     nome pede um clique, e com dois nomes iguais a lista mostra o cupom de cada um;
  3. legado: experimental aberta por afiliado (`opportunities.created_by_vendor_id`).
  Só vale para **plano** — aula avulsa não tem matrícula e não gera comissão.
- ⚠️ **SALESPERSON não cria oferta de matrícula** — trava na tabela
  (`trg_block_salesperson_enrollment_offer`, BEFORE INSERT em `offers`, pelo `_my_role()` da
  sessão). A porta aceitava **qualquer mensalidade** vinda do afiliado. O menu dele é só
  Painel + Como funciona + Perfil.
- ⚠️ **Não encaixe camada nova na cadeia de `create_enrollment_offer`.** Três testes
  (`crm_trial_conversion_hardening`, `harden_trial_offer_authority_and_idempotency`,
  `enrollment_without_trial_feedback`) leem o **texto-fonte** de cada camada (a pública tem de
  travar o lead do CRM; a `_pre_crm_lead_lock_impl` tem de conter a idempotência…). A primeira
  versão do cupom virou camada por cima da porta pública e reprovou a auditoria. Porta
  própria ao lado, chamando a pública, não quebra nada.
- ⚠️ Guarda de papel é sempre `coalesce(role, '') not in (…)`: a reescrita de
  `set_vendor_commission_status` perdeu o `coalesce(v_role` e o `tenant_id = v_tenant`, e o
  `conciliacao_caixa_asaas.sql` (que audita o texto da função) reprovou.
- **Liberação:** comissão nasce `PENDING` quando o aluno começa a matrícula e vira `CONFIRMED`
  quando a oferta chega a `COMPLETED` — que é disparado pela liquidação (`PAYMENT_RECEIVED`/
  `RECEIVED_IN_CASH`) da cobrança que ativa a matrícula. Como o cupom zera a taxa, essa
  cobrança é a **1ª mensalidade**: Pix na hora, boleto na compensação, cartão quando o valor
  cai (até ~30 dias; com antecipação da Asaas cai antes — medido: cartão de 31/08 liquidou
  em 01/09). Estorno reabre a oferta → comissão volta a `PENDING` e o saque pendente é cancelado.
- **Etapas do painel são derivadas, nunca gravadas** (`private.affiliate_referral_view`):
  aguardando pagamento → em liquidação (cartão aprovado, com `student_payments.estimated_credit_at`)
  → disponível → em saque → paga. Afiliado vê o aluno como "Maria S.".
- **Painel do afiliado:** `get_my_affiliate_panel()` (tudo numa chamada) + `set_my_affiliate_pix`.
  ⚠️ "Meu Perfil" só mostra PIX para **professor** — sem a porta própria, o saque do afiliado
  ficava preso em `PIX_REQUIRED` para sempre.
- **Saque:** só comissões `CONFIRMED` sem reserva entram; `request_vendor_withdrawal` reserva as
  linhas exatas (`withdrawal_request_id`); a direção aprova e marca pago na ficha
  (`set_vendor_withdrawal_status`). "Liberar manualmente" na ficha é exceção (pede confirmação).
- `vendor_commissions.amount_brl`, `vendor_withdrawal_requests.amount_brl` e
  `profiles.commission_rate` são **centavos** (padrão 4900 = R$ 49). Caixa, DRE e o alerta de
  `list_vendors_overview` convertem na borda (o alerta mostrava "R$ 4.900,00" para R$ 49).
- ⚠️ **Dois erros de sintaxe que derrubariam o release** estavam na migration e foram
  corrigidos em 25/09: um `+` solto (resto de patch) e `pg_catalog.substring(x from 1 for 10)`
  — a forma `from … for` é sintaxe especial e **não existe com o prefixo `pg_catalog.`** (use
  `pg_catalog.substr(x, 1, 10)`). Mesma família do `nullif`.
- **Testar migration sem travar produção:** cópia só com a estrutura no mesmo servidor —
  `createdb ww_x` + `pg_dump --schema-only | psql -d ww_x` (só o `pg_cron` falha, fica no
  banco principal), rodar migration 2× + teste em `BEGIN … ROLLBACK` ali, `dropdb` no fim.
  Não pega `ACCESS EXCLUSIVE` em `profiles` em horário de aula.
- **Validação de 26/09/2026:** os 134 testes SQL do release rodados um a um numa cópia
  só-estrutura, sem e com as migrations novas — **zero regressões** (as ~35 falhas nas duas
  rodadas dependem de dado real que a cópia não tem).
- 0 afiliados e 0 comissões em 26/09. O bot do WhatsApp **não** reconhece cupom na conversa —
  o caminho é a escola (link manual) ou o aluno (página de matrícula).

---

## Navegação do Diretor — menu, badges e Central de Pendências ✅

> O acesso do diretor (`SCHOOL_ADMIN`) tinha 30 itens de menu **flat, sem grupos nem alertas**. Reorganizado para reduzir carga e dar visibilidade ao que precisa de ação.

- **Menu agrupado** (`ModernSidebar`): `MenuItem` ganhou `section` (cabeçalho de grupo) e `badgeKey` (contador). Seções: Visão geral · Pessoas · Aulas · Pedagógico · Financeiro · Crescimento · Configurações. Renderização mostra header quando a seção muda; colapsado vira divisória.
- **Badges de pendência**: `App.tsx` busca `director_pending_counts()` (RPC, migration `20260605140000`) em `pendingCounts` e passa ao sidebar; itens com `badgeKey` (`acolhimento`, `presenca`, `materiais`, `trials`) mostram o número. Atualiza ao trocar de aba (`activeTab`).
- **Central de Pendências** (`components/DirectorPendingCenter.tsx`): no topo do Dashboard (aba analytics), lista tudo que espera ação com link direto (`onNavigate` = `setActiveTab` do App). Estado "tudo em dia" quando zero.
- **Nomes corrigidos** (eram confusos): `automation`="WhatsApp (Conexão)" (AutomacaoSmart) vs `automations`="Disparos WhatsApp" (AutomationPanel); `payments`="Repasse a Profs" (**TeacherPayments — pagamento AO professor**); `approvals`="Acolhimento (Docs)"; `financial`="Lançamentos do Caixa".
- **`contracts` agora é item de menu próprio** (`ContractManagement`) — antes só existia escondido na aba do Dashboard. A aba duplicada de Contratos foi **removida** do `SchoolAdminDashboard`.
- ⚠️ **Cuidado — "duplicatas" que NÃO são**: o menu `payments` = `TeacherPayments` (**repasse AO professor**). Mensalidades de ALUNOS = `AdminPaymentsList`, exposto no menu como `student-payments` ("Mensalidades (Alunos)"). `training`/`registration`/`recruiting` do Dashboard são telas únicas que só existem ali. Não remova achando que são cópias.
- **Seção Financeiro do menu** (4 telas distintas): `student-payments` (mensalidades de alunos, AdminPaymentsList) · `payments` (repasse a profs, TeacherPayments) · `cashflow` (CashflowPanel) · `financial` (FinancialReport). A aba "Mensalidades" do Dashboard foi removida (vive no menu); o "Ver Todos" do preview de recebimentos navega via `onNavigate('student-payments')`.
- **Guard de segurança do admin** (`App.tsx renderContent`): `SCHOOL_ADMIN` tem allowlist de abas (igual student/vendor) — abas fora do escopo redirecionam ao Início. Ao adicionar um item novo ao menu do diretor, **inclua o id em `allowedAdminTabs`** senão ele cai no dashboard.

---

## Anti-duplicação de Agenda e Lançamento de Aula ✅

> **Regra de ouro:** o pagamento do professor = `class_logs` pagáveis × `hourly_rate`. Logo, agenda/lançamento duplicado = pagamento inflado. Houve um caso real (aluno Anderson/prof Flávio): a matrícula manual criou **6 cópias** de cada horário porque o botão Salvar foi clicado várias vezes e **não havia trava de unicidade**.

**Travas no banco (migration `20260605130000_prevent_duplicate_bookings_and_logs`):**
- `uq_bookings_no_dup_active` — único parcial em `bookings (tenant_id, student_id, teacher_id, day_of_week, time_slot) WHERE status='SCHEDULED' AND student_id IS NOT NULL`. Impede 2 agendamentos ativos no mesmo dia/horário. ⚠️ É **parcial** → NÃO dá pra usar como `onConflict` do supabase-js (erro "no matching constraint"); filtre contra existentes no app.
- `uq_class_logs_booking_date` — único em `class_logs (booking_id, class_date) WHERE booking_id IS NOT NULL`. Impede lançar o mesmo booking 2× no mesmo dia.

**No frontend:**
- `TeacherScheduleExplorer.handleAssignmentSubmit`: dedup do array + **filtra contra bookings SCHEDULED já existentes** antes de inserir (re-submit vira no-op, sem disparar o rollback que apaga o perfil recém-criado). NÃO usa upsert (índice parcial).
- `LessonLauncher`: ao montar as aulas do dia, **só 1 aula por horário** (`slotSeen`) — defesa caso ainda exista booking redundante.

**Como auditar duplicatas (rápido):** duplicata inequívoca = mesmo `student_id` + `class_date` + `time_slot` (do booking) com 2+ `class_logs` pagáveis (impossível dar 2 aulas no mesmíssimo horário). Atenção a falsos positivos: aluno com 2 aulas no mesmo dia em **horários diferentes** (ex: 19:00 e 19:30) é legítimo. Após limpar duplicatas, **regenere `teacher_closings` PENDENTE** (`DELETE` os afetados + `run_monthly_teacher_closing(mês)`) — o closing é snapshot e pode estar desatualizado mesmo sem duplicata.

---

## Lançamento de Aula — RPC transacional `log_teacher_classes` ✅

> **O lançamento tem UMA porta agora.** Migration `20260804120000_teacher_class_logging_rpc`.
> Antes era `insert` direto em `class_logs` feito pelo navegador, **copiado em duas telas
> que divergiram na regra** — e a cópia errada custava dinheiro do professor.

**O bug que motivou (medido em produção, 04/08/2026):** 98 reposições no banco (9 por falta
do professor) e **ZERO** `class_logs` com subtype `REPOSIÇÃO_PROF` na história do sistema.
Ou seja: **nenhuma reposição de falta do professor jamais foi paga**, embora
`v_payable_class_logs` já soubesse pagá-la. Causa: `PendingLessons` (aba "Pendentes")
(i) não gerava reposição para `TEACHER_ABSENCE`, (ii) gravava a reposição **sem `fault_type`**,
(iii) usava sempre subtype `'REPOSIÇÃO'`, (iv) contava o limite de 5 sem filtrar `fault_type`.

**A regra (em `v_payable_class_logs`, NÃO alterada — só passou a ser alimentada certo):**
| Situação | Subtype gravado | Paga? |
|---|---|---|
| Falta do PROFESSOR | — | ❌ e gera reposição `fault_type='TEACHER'` (ilimitada) |
| Reposição de falta do PROFESSOR | `REPOSIÇÃO_PROF` | ✅ |
| Falta do ALUNO | motivo (Doença/…) | ✅ e gera reposição `fault_type='STUDENT'` (5/mês) |
| Reposição de falta do ALUNO | `REPOSIÇÃO` | ❌ (a aula de origem já foi paga) |

- ✅ **O subtype é DERIVADO NO SERVIDOR** a partir de `reschedules.fault_type`. O navegador
  não escolhe mais quanto uma aula vale — nem por acidente.
- ✅ **Atômico:** gravar a aula + consumir a reposição usada + criar a reposição da falta +
  mover o lead no CRM eram 4 chamadas soltas do navegador. Rede caindo no meio deixava
  metade feito, em silêncio.
- ✅ **Anti-duplicata no servidor** (o guard antigo, `lib/classLogGuard.ts`, era *fail-open*
  no navegador e foi removido). Cruzamento só barra REPOSIÇÃO contra aula já lançada do
  mesmo aluno/data — ⚠️ **dois bookings distintos no mesmo dia continuam passando** (aula de
  1h partida, 19:00 + 19:30, é legítima e paga os dois).
- ✅ **A reposição consumida é MARCADA (`used_at`), nunca apagada** — alinhado ao commit
  `0bd4053`. Apagar destruía `fault_type`, que é justamente a prova que decide se a
  reposição paga; foi assim que 12 de 13 `class_logs` ficaram apontando para nada.
- ✅ **Cobertura de professor respeitada no servidor:** quem **assumiu** a aula lança usando
  o booking do professor original (a RPC aceita via `class_coverages.cover_teacher_id`), e
  quem **cedeu** é barrado (`aula_cedida_para_outro_professor`) — senão a mesma hora pagaria
  dois professores. A tela já escondia; a trava do dinheiro agora está no banco.
- ✅ **Antifraude × `used_at` — VERIFICADO em produção (04/08/2026), não é bug.**
  `upcoming_classes`/`enqueue_attendance_confirmations` **devem mesmo ignorar `used_at`**:
  a confirmação de presença é atrelada à **ocorrência** da aula, não ao lançamento
  (professor lançou + aluno calado = `PENDING`, pago pela confiança). E2E completo testado
  em `BEGIN…ROLLBACK` com a RPC: lançar reposição → `enqueue` cria a confirmação (2ª rodada
  cria 0, dedupe pelo unique `(source_id, source_type, class_date)`) →
  `reconcile_attendance_confirmation` **já casa `source_type='reschedule'`** por
  `reschedule_id + class_date` → aluno confirma = `CONFIRMED`; aluno desmente = `CONFLICT`
  + `payment_hold=true` (aula sai da folha até o admin resolver). O DELETE antigo na
  verdade **furava o antifraude**: reposição lançada antes do cron de 40 min sumia da view
  e nunca gerava confirmação (12 lançamentos `REPOSIÇÃO` × só 9 confirmações `reschedule`
  na história). ❌ **NÃO adicione filtro de `used_at` em `upcoming_classes`** — quebraria
  essa cobertura de propósito.
- ✅ **Telas que listam reposição "aberta" filtram `.is('used_at', null)`**
  (`StudentSchedule`, aba Reposições no `App.tsx`) — a linha consumida sobrevive, e sem o
  filtro a aula já dada aparecia como pendente de agendamento. `LessonLauncher`,
  `PendingLessons`, `TeacherDashboard` e `pendingLessonsCount` já filtravam por
  "existe class_log?" e não precisam do filtro.
- ⚠️ **`PendingLessons` não bloqueia mais mês anterior.** As duas telas tinham regras opostas
  (45 dias x mês corrente). Hoje a janela é 120 dias na RPC, e aula atrasada vai para o
  próximo fechamento aberto via `closing_carryovers` — o mecanismo está vivo (9 registros).
- ⚠️ **`alter function ... owner to postgres`** é obrigatório: a migration é aplicada como
  `supabase_admin`, que é **SUPERUSER**, e `SECURITY DEFINER` roda com os poderes do dono.
- ⚠️ **`nullif` é forma especial do SQL** — `pg_catalog.nullif(...)` não existe e quebra em
  runtime dentro de `set search_path = ''`. Mesma armadilha da migration
  `repair_wolfie_sql_special_forms`. `btrim`/`date_trunc`/`jsonb_*` são funções de verdade
  e aceitam o prefixo.

**Estímulo (o caixa subindo na tela):** `components/ClassLogReward.tsx` + `lib/classLogRules.ts`.
Duas camadas de propósito: **XP** é arcade (client-side, não representa dinheiro, então não
pode mentir — premia lançar em dia e em lote) e **R$** vem da RPC, que soma `rate_efetivo` de
`v_payable_class_logs` das aulas recém-inseridas.
❌ **NUNCA estime valor de aula no cliente** (`aulas × tarifa`): o valor varia por posição de
antiguidade do aluno na carteira e pelo turbo. Foi exatamente essa estimativa local que gerou
**contestação em série** no `TeacherFinancials` (ver comentário em `TeacherFinancials.tsx:42`).
Aula que não paga mostra **R$ 0,00 com o motivo** — fingir festa numa aula que vale zero
custaria a credibilidade da tela inteira no fechamento.

**Como testar:** `supabase/migrations/…_teacher_class_logging_rpc.sql` roda em
`BEGIN … ROLLBACK` contra a VPS (`psql -U supabase_admin`); confira que
`select sum(rate_efetivo) from v_payable_class_logs` é idêntico antes e depois.
Testes de UI: `components/ClassLogReward.test.tsx` (11 casos).
✅ **Aplicada em produção** (confirmado em 04/08/2026: `log_teacher_classes` existe no
banco da VPS). A nota anterior dizia o oposto e apoiava a afirmação falsa de que o
`release.sh` não aplica migration — ele aplica; ver a seção de Deploy.

---

## RLS de agenda — policies permissivas são OR ✅

> **Leia antes de criar qualquer policy em `bookings`, `reschedules` ou `class_coverages`.**

**A armadilha (corrigida em 04/08/2026):** no Postgres, políticas permissivas se somam com
**OR** — basta UMA liberar para as outras não valerem nada. Conviviam em `reschedules`:

```
Reschedules: Access control  FOR ALL  USING (tenant AND (dono OU admin))   <- certa
reschedules_tenant_scope     FOR ALL  USING (tenant OU aluno OU professor) <- anulava a de cima
```

Resultado medido: **todo usuário logado da escola enxergava os 111 agendamentos e as 98
reposições**, aluno inclusive, e qualquer professor podia **apagar** a agenda de um colega
pela API do PostgREST. Nenhuma tela explorava isso (todas filtram por `teacher_id`), mas a
API é pública para quem está logado — bastava o id da linha. E agenda é dinheiro: o
pagamento é `class_logs` pagáveis × tarifa, e o log nasce do booking.

**Padrão que ficou** (migrations `20260804180000` e `20260804210000`): uma policy `select`
e uma `all` por tabela — professor no que é dele, aluno no que é dele, admin/coordenador no
tenant.

- ⚠️ **`with check` tem de repetir a condição do `using`.** O `using` só enxerga a linha
  **antes** do update; sem o `with check` dá para gravar a linha já apontando para OUTRO
  professor — que é exatamente como uma reposição migra de agenda.
- ⚠️ **`bookings_select` PRECISA do ramo de `class_coverages`.** A primeira versão só
  liberava o booking próprio e **quebrava a cobertura de aula**: o `LessonLauncher` lê de
  propósito o agendamento de outro professor para montar a aula assumida
  (`assumedBookings`). Sem isso, quem assume a aula não a vê, não lança e **não recebe**.
- **Como testar sem derrubar produção:** rode `BEGIN … ROLLBACK` medindo, **pessoa por
  pessoa real**, quantas linhas cada uma enxerga antes e depois, e compare com o que ela
  de fato possui. Foi assim que a quebra da cobertura apareceu antes de ir para o ar.

⚠️ **O mesmo padrão apareceu em `profiles`** (achado e corrigido em 09/08/2026, migration
`20260809150000_escopo_de_tenant_na_escrita_de_aluno`). `Teachers update unlocked_tests`
tinha `USING (role = 'STUDENT')` — **sem filtro de tenant nenhum**. Medido por pessoa real,
contando linhas graváveis: Prof. Lobo (`wise-wolf-school`) e Ricardo Silva
(`royal-british`) tinham escopo legítimo de **2** linhas e a policy dava **57** — os 55
alunos da Wise Wolf ficavam graváveis por professor e diretor de outra escola.

- **O estrago não acontecia**, porque a policy de LEITURA (`profiles_scoped_read_p0`) é
  escopada e os triggers de campo (`enforce_profile_authorization_fields`) barram o resto.
  Defesa apoiada na peça errada: mexer na leitura um dia abriria isto sozinho.
- ⚠️ **Apagar a policy teria sido o conserto errado.** Ela era a **única** que dava ao
  SUPER_ADMIN escrita em aluno fora do tenant `master` — as outras cinco exigem
  `tenant_id = _my_tenant_id()`. Remover sem repor tiraria do suporte da plataforma a
  capacidade de corrigir aluno de escola cliente, **sem erro visível, só um "não salvou"**.
  Antes de derrubar policy frouxa, meça o que ela é a única a conceder.
- **O nome mentia:** falava de `unlocked_tests`, mas policy não restringe COLUNA — liberava
  a linha inteira.
- Depois: Wise Wolf segue em 81 (ninguém que opera perdeu nada), os de fora caíram para 2,
  SUPER_ADMIN manteve 56.

⚠️ **Ainda aberto:** o mesmo padrão pode existir em outras tabelas. Ao auditar, procure
`polcmd = '*'` com `polpermissive = true`, e também `polcmd = 'w'` cujo `USING` **não**
menciona tenant.

---

## ⚠️ NÃO registre as migrations legadas em `MIGRATION_RELATIVES` ✅

> Medido em 23/09/2026. Escrito aqui porque "faltam 115 migrations na lista" parece
> pendência e **não é** — registrá-las é que seria o estrago.

O release **não reaplica a lista inteira**: ele guarda marker
`<versão>-<sha256>.sha256` em `/opt/wisewolf/releases/.migration-checksums` e só roda as
**pendentes** (duas vezes, em transação, com rollback, antes de valer). Migration já
aplicada com **outro checksum** é recusada na hora.

- **115 migrations do repo estão fora da lista** — legado de jan–jul/2026. Como não têm
  marker, registrá-las faria o release **executá-las**. E **39 delas têm `DELETE`,
  `DROP`, `TRUNCATE` ou `UPDATE` de dado sem a trava `schema_one_shots`**, incluindo
  `20260127080000_delete_admins.sql`, `20260131140000_delete_veronica.sql`,
  `20260127021500_fix_password_hash.sql` e `20260127030000_copy_valid_hash.sql`. O
  próximo deploy apagaria administradores e reescreveria hash de senha.
- **Registre só migration nova**, escrita para rodar de novo. Ao registrar uma antiga
  (raro), leia o arquivo inteiro antes.
- ⚠️ **Ordem de aplicação é o glob `migrations/*.sql` ordenado por NOME**, não a ordem da
  lista. Conserto de função sempre em arquivo com data posterior ao que a define.
- **Auditar em 30 s:** extrair `MIGRATION_RELATIVES` do `release.sh`, comparar com
  `ls supabase/migrations`, cruzar o sha256 local com os markers da VPS → três respostas:
  conflito de checksum (recusa), pendente (vai rodar), fora da lista (nunca roda).
- ⚠️ **Rodar os 128 testes SQL na mão? Use o CÓDIGO DE SAÍDA do psql**, não
  `grep '^ERROR:'` — vários provocam erro de propósito. O grep acusou 7 falhas onde
  havia 4.
- ⚠️ `npm run deploy:vps | tail` **esconde a falha**: o `exit code` passa a ser o do
  `tail`. Redirecione para arquivo e leia `$?`.

---

## ⚠️ Reposição parada NÃO abre o aluno — e por que eu quase "consertei" isso ✅

> Migration `20260923130000_revert_open_reschedule_access.sql`. Leia antes de mexer em
> `_teacher_can_access_student`.

`_teacher_can_access_student` só deixa o professor enxergar o aluno por reposição quando
ela tem **data utilizável dentro da janela de 7 dias** (`20260922040028`, intenção
declarada: *"historical coverage and reschedule records must not grant access forever"*).
Reposição parada em `'Pendente'` **não abre nada**, e isso está certo.

**O erro que eu cometi em 23/09/2026 e a direção pegou:** vi que 195 das 196 reposições
abertas não abriam mais o aluno e que a Beatrís enxergava **zero**, tratei como regressão
e afrouxei a regra. O que ela abria eram **fantasmas** — 26 pares, todos de aluno que hoje
é de OUTRO professor: Beatrís via Paulo Eduardo (titular Mateus) e Ana Clara (titular
Flávio) por reposições de 09/06, 106 dias paradas; Flávio via Anderson (titular Lais) por
8 reposições de junho/julho; Mateus via Bruno Luis, **inativo**, por reposição de março.
A Beatrís enxergar zero estava certo: **ela não tem aluno**.

- ⚠️ **Contagem de acesso não é sinal de defeito.** Medi a saída da regra (quantos alunos
  cada professor vê, antes e depois) e nunca conferi a **verdade do terreno**: aquele
  professor dá aula para aquele aluno HOJE? A tabela que decide isso é `bookings`
  SCHEDULED, `profiles.professor_id/2` e cobertura confirmada — não `reschedules`.
- **Antes de mexer em regra de acesso, liste caso a caso**: professor, aluno, titular
  atual do aluno, idade do registro que está concedendo o acesso. Se o titular é outro e
  o registro tem 100 dias, o acesso é que estava errado.
- **O caso legítimo continua coberto:** substituto que VAI dar a aula tem reposição **com
  data**, e cobertura confirmada tem ramo próprio. `substituto_enxerga_o_aluno_que_cobre.sql`
  afirma os três lados — reposição marcada abre, reposição em `'Pendente'` não abre,
  reposição de 30 dias atrás não abre.
- **O passivo por trás disso é real e é outro problema:** 196 reposições abertas
  atribuídas a professor, 4 com data. Isso é higiene de dado (ver *Reposição parada é
  passivo*), não regra de acesso.

## ⚠️ `NULL not in (...)` é NULL, não verdadeiro ✅

> Migration `20260923060000_null_trial_status_keeps_post_trial_question.sql`.

O retorno de `trial_closing_teacher_asks` filtrava `opportunity.trial_status not in (...)`
**sem `coalesce`**, enquanto o `insert` da MESMA função usava `coalesce(trial_status,'')`.
Com o campo nulo a oportunidade entrava na fila e **nunca aparecia no retorno**: a
professora não era perguntada e o fechamento da experimental não começava, sem erro nenhum.

Não atingia ninguém (90 dias: 34 DONE, 15 SCHEDULED, 3+2 no-show, **zero nulos**), então o
conserto é no-op sobre os dados de hoje. Provado com fixture: nulo vai de 0 para 1, e
`NO_SHOW_TEACHER`/`CANCELLED` continuam em 0. Guardado por
`pos_experimental_com_trial_status_nulo.sql`, que reprova contra a função antiga.

⚠️ **Ao filtrar por `not in` / `<>` / `>=` numa coluna que aceita nulo, decida o nulo
explicitamente.** Mas decidir não é sempre "deixar passar" — na reposição acima, o nulo
**tem** de barrar. Qual dos dois é o certo se decide olhando o dado, não a simetria.

---

## ⚠️ Policy que chama função `private` derruba a escrita de TODO bucket ✅

> **Leia antes de usar `private.*` dentro de qualquer policy para `authenticated`/`anon`.**
> Migration `20260923030000_storage_write_guards_use_my_role.sql`.

O diretor não conseguia subir o PDF do treinamento: *"permission denied for function
active_tenant_role"*, num INSERT que o diretor nem escreveu. As barreiras de `invoices`
(`invoices_authenticated_update_guard` / `_delete_guard`, **RESTRICTIVE**, e as
`invoices_closing_scoped_update` / `_delete`) chamavam `private.active_tenant_role(...)`
direto — e `authenticated` **não tem EXECUTE** nela, de propósito: ela aceita um uuid
qualquer e diria o papel de qualquer pessoa.

- ⚠️ **O `bucket_id <> 'invoices'` NÃO salva.** O Postgres cobra o EXECUTE na
  **inicialização da expressão**, antes de qualquer curto-circuito do `OR`. Barreira
  RESTRICTIVE vale para todo bucket ⇒ **todo upsert, update e delete de arquivo morria**,
  em qualquer bucket, para qualquer usuário logado. `SELECT` e `INSERT` simples passavam —
  por isso a biblioteca "funcionava" e só o upload com `upsert: true` (`TrainingAdmin`) e
  as remoções (`PedagogicalConfig`) quebravam.
- **Conserto:** usar **`public._my_role()`** — que é exatamente
  `private.active_tenant_role((select auth.uid()))` embrulhado num SECURITY DEFINER do
  `postgres` com EXECUTE para `authenticated`. Conferido perfil a perfil (95 pessoas,
  **0 divergências**); a função interna continua fechada.
- ❌ **Não conserte dando `grant execute` na função `private`** — ela recebe uuid
  arbitrário; liberar entregaria o papel de qualquer usuário a qualquer logado.
- **Trava contra reincidência** dentro da própria migration: policy de `storage.objects`
  para `anon`/`authenticated` que cite função `private` sem EXECUTE **derruba a migration**,
  e não a tela do diretor às 23h.
- **Como auditar** (vale para qualquer tabela, não só storage): cruze `pg_policy` com
  `pg_proc` do schema `private` e `has_function_privilege('authenticated', oid, 'EXECUTE')`.
- ⚠️ `storage.objects` tem trigger `protect_objects_delete`: **DELETE direto por SQL é
  recusado** ("Use the Storage API instead"). Teste de remoção tem de ir pela API HTTP —
  `/storage/v1/object/<bucket>/<path>` com JWT do usuário, rodado **dentro da VPS** para a
  chave não entrar no contexto.

---

## ⚠️ Campo que não é coluna DERRUBA O UPDATE INTEIRO ✅

> **Leia antes de mexer em qualquer tela que salva perfil.** É a classe de bug mais
> silenciosa deste projeto: já quebrou **cinco** caminhos de salvamento ao mesmo tempo, e
> ninguém ligou uma coisa à outra por meses.

O PostgREST **não ignora** campo desconhecido no `update`/`insert` — ele **derruba o comando
inteiro**. E a mensagem cita um campo que o usuário nem editou:

```
ERROR: column "correction_preference" of relation "profiles" does not exist
```

O diretor tentava trocar o **telefone do aluno** pelo Mapa de Aulas, o UPDATE inteiro morria,
e o erro falava de "preferência de correção". Encontrado em 09/08/2026:

| Campo fantasma | Telas | O que travava |
|---|---|---|
| `correction_preference` | `TeacherScheduleExplorer`, `TeacherAvailabilityEditor` | **telefone do aluno** |
| `updated_at` | `TeacherPixSettings`, `TeacherPayoutDetails`, `seeds/create-admins.ts` | **chave PIX do professor** — por onde ele recebe |

- ✅ **`profiles` NÃO tem `updated_at`.** A trilha de alteração é `profile_audit_log`
  (trigger `log_profile_changes`). Não invente a coluna: use a auditoria que existe.
- ✅ **Guarda contra reincidência:** `lib/profileColumns.ts` (as 140 colunas reais) +
  `lib/profileColumns.test.ts`, que varre o **código-fonte** atrás de escrita em `profiles`
  com campo que não é coluna. Roda offline, no CI, antes de chegar na tela.
- ⚠️ **Ao adicionar coluna em `profiles`, atualize `lib/profileColumns.ts`**, senão o teste
  acusa falso positivo na tela que já está certa.
- ⚠️ O teste tem uma **âncora** que falha se a própria varredura parar de enxergar as
  escritas — sem ela, um regex quebrado faria o teste "passar" sempre.
- ⚠️ Ao escrever varredura assim, `payload.campo\s*=` casa com `payload.campo ===`. Use
  `=(?!=)`, senão comparação vira "atribuição" e gera falso positivo.

**Como auditar rápido:** compare as chaves gravadas com
`select column_name from information_schema.columns where table_name='profiles'`. Cuidado:
o payload costuma ser declarado em variável (`const updates = {…}`) longe do
`.from('profiles').update(updates)`, então grep ingênuo no `.update({` não acha.

---

## Mensalidade do aluno — uma coluna só (`monthly_fee`) ✅

> **`profiles.monthly_tuition` é DEPRECADA.** É espelho, não fonte.

Conviviam duas colunas para o mesmo número: `monthly_fee` (21 funções do banco, 23 arquivos
do frontend) e `monthly_tuition` (2 funções, 3 telas) — e telas diferentes gravavam colunas
diferentes. Medido em 09/08/2026, três alunos divergentes:

| Aluno | `monthly_fee` | `monthly_tuition` | Cobrança real |
|---|---|---|---|
| Yasmin | 188,00 | 189,00 | **188,00** |
| Beatriz | **0,00** | 169,00 | nenhuma |
| EVI | **0,00** | 187,00 | nenhuma |

A cobrança sempre seguiu `monthly_fee`. O perigo estava do outro lado: **`sync-payments`
PREFERIA `monthly_tuition`** quando > 0 — estava a um sync de faturar R$ 169 e R$ 187 de
dois alunos cuja mensalidade é zero. Não disparou por sorte, não por desenho.

- **Fonte única:** `monthly_fee`. Migration `20260809140000_mensalidade_tem_uma_coluna_so`
  reconcilia e instala `trg_mirror_monthly_tuition`, que mantém o espelho para leitor legado.
- ⚠️ **O espelho age no INSERT e SÓ quando `monthly_fee` MUDA no UPDATE.** Se agisse em todo
  UPDATE, editar o telefone de um aluno divergente mexeria num campo financeiro e
  `enforce_profile_authorization_fields` barraria a edição — **o bug da seção anterior,
  reintroduzido pela porta dos fundos**. Verificado: telefone → 261/261 intacto;
  mensalidade → 333/333 espelhado.
- ⚠️ Em `BEFORE INSERT` o registro `OLD` não existe — daí o `TG_OP` na função.
- Derrubar a coluna é passo separado, depois que ninguém mais a ler.

---

## ⚠️ Gotchas de RPC `RETURNS TABLE` (aprendido na marra)

Funções `RETURNS TABLE(...)` validam tipos em **runtime** (não na criação). Erros que deixam o painel "vazio" silenciosamente (frontend engole o erro):
1. **`count(*)` é bigint** — colunas de contagem declaradas `int` quebram ("structure of query does not match"). **Solução:** `::int` no SELECT final (ou declarar `bigint`).
2. **Nomes ambíguos** — se um OUT param tem o mesmo nome de coluna usada sem qualificar (`teacher_id`, `tenant_id`, `status`), dá "column reference is ambiguous". **Solução:** `#variable_conflict use_column` no topo do corpo + aliasar CTEs.
3. **`commission_rate` é integer** (centavos); declarado `numeric` quebra → `::numeric`. `hourly_rate`/`monthly_fee` são numeric; `xp`/`streak_count` são integer.
- **Validar SEMPRE chamando a função** (`SELECT count(*) FROM minha_rpc()` com `set_config('request.jwt.claims', '{"sub":"<uid>"}', true)`), NÃO só o SELECT interno.
- Fichas `get_*_overview` retornam **jsonb** → imunes a esse problema.

---

## Troca de Plano do Aluno — o aluno assina, aí o valor muda ✅

> **Leia antes de mexer em `profiles.monthly_fee`, `class_frequency` ou preço de plano.**

**O problema que originou (04/08/2026):** mudar frequência e valor era `UPDATE` na mão
no banco. O contrato assinado continuava dizendo outro número — a escola cobrava um valor
que não estava em documento nenhum. Aconteceu com o Victor Hugo: a agenda virou 6 aulas
às 17:57 e a mensalidade seguiu a de 4.

**A regra:** o diretor **PROPÕE**, a assinatura do aluno **APLICA**. O `update` em
`profiles` vive dentro de `sign_student_plan_change` e **em lugar nenhum antes dele** —
enquanto o aluno não assina, a escola cobra o valor antigo. A carência (`fidelity_plan`)
não é tocada: a troca é de frequência e valor dentro do compromisso que já existe.

**Fluxo:** ficha do aluno → "Mudar plano" (`StudentPlanChangeModal`, só admin) → link
`/mudar-plano?token=…` (`PlanChangeSign`, rota pública do SPA) → aluno assina digitando o
nome → RPC aplica e enfileira a Asaas.

- **Tabela:** `student_plan_changes` (PENDING → SIGNED / CANCELLED). Índice único parcial
  `uq_plan_change_one_pending`: **uma proposta aberta por aluno** — duas em pé fariam o
  aluno assinar a que chegasse primeiro no WhatsApp, não a que a escola quis valer.
- **RPCs:** `create_student_plan_change(uuid,text,numeric,boolean)`,
  `get_plan_change_public(text)` (anon), `sign_student_plan_change(text,text)` (anon),
  `list_student_plan_changes(uuid)`. Migrations `20260804190000` e `20260804200000`.
- ⚠️ **`unaccent` NÃO existe neste banco.** Por isso `normalize_signature_name` faz
  `translate()` na mão — sem ela, "Guimarães" digitado sem o til é recusado e o aluno
  trava sem entender por quê.
- ⚠️ **A página de assinatura fica no SPA, não em edge function** — o gateway força
  `content-type: text/plain` + CSP sandbox e não renderiza HTML pro usuário final. Mesma
  pegadinha da confirmação de presença.

### Asaas: fila, nunca chamada direta
A assinatura acontece numa página **pública, com o aluno deslogado** — ela não tem (nem
pode ter) credencial da Asaas. E se tivesse, uma instabilidade da Asaas derrubaria a
assinatura do aluno por um motivo que não é dele.

Então assinar só **enfileira** (`billing_sync_status = 'PENDING'`), e a edge
`sync-plan-change-billing` (cron `wisewolf-plan-change-billing`, a cada 10 min) faz
`POST /v3/subscriptions/{id}`. Seis tentativas; depois `FAILED`, com o erro guardado em
`billing_sync_error` — **erro visível em vez de divergência silenciosa**.

- **`update_pending_payments`** decide se a fatura JÁ gerada do mês entra no valor novo.
  É escolha do diretor no modal (ligada por padrão): cobrar R$ 90 a mais numa fatura que o
  aluno já viu rende chamado no WhatsApp.
- ⚠️ **Sem chave da Asaas a edge devolve 503 e NÃO consome tentativa** — senão um erro de
  configuração queimaria as 6 tentativas de todos os aditivos na fila.
- **23 de 53 alunos ativos** têm assinatura recorrente; para os outros o status fica
  `NOT_NEEDED` e a escola cobra na mão.

### Catálogo de preços (`student_pricing_plans`)
É **cardápio, não conta**: mexer nele não altera mensalidade de ninguém. Mas ele é lido no
fluxo de matrícula (`TrialsToContracts`, `StudentAssignmentModal`, `enroll-student`) —
catálogo defasado = aluno novo matriculado com preço velho (o 12m-3x saía R$ 187 contra os
R$ 229 praticados até 04/08/2026).

⚠️ O índice único é **parcial** (`where classes_per_week > 0`, por causa dos planos do
`wolfie-direct` que têm 0 aula/semana) → o `ON CONFLICT` **precisa repetir o predicado**.
Mesma pedra de `uq_bookings_no_dup_active` e `run_recurring_expenses`.

---

## Programa de Indicações (referral) ✅

- **Config do diretor** (`ReferralAdmin`, aba "Indicações"): liga/desliga, recompensa aluno/professor (R$), mín. pagamentos, teto mensal, validade do crédito, bloqueio auto-indicação. Fonte ÚNICA em `tenant_referral_settings` (antes os valores eram chumbados/inconsistentes: 45 vs 49).
- **Recompensa real no pagamento:** trigger `grant_referral_reward_on_payment` em `student_payments` → `process_referral_reward()` premia quando o aluno indicado paga (respeita `min_payments`). Aluno indicador → `student_credits` (redimível); professor indicador → `referral_rewards` PENDING (admin marca PAID). Ledger único `referral_rewards` (unique por `referred_student_id` = idempotente).
- **Atribuição:** `PublicRegistration` já grava `referrer_student_id`/`referrer_teacher_id` do `?ref=`/`?ref_student=` no perfil — fonte confiável (não depende de e-mail).
- **RPCs:** `get_referral_settings()`, `save_referral_settings(jsonb)`, `list_referrals_overview()`, `set_referral_reward_status(uuid,text)` (admin); `get_my_referral_info()` (qualquer user: valor, convertidas, saldo de crédito).
- `AffiliatePanel`/`TeacherAffiliateCard` agora leem o valor real via `get_my_referral_info` + mostram saldo de crédito.
- **Estado:** programa começa DESLIGADO (sem linha em `tenant_referral_settings`); só paga quando o diretor configura+ativa. `monthly_cap=0` = ilimitado.

---

## Higiene de dados / Caixa / Agenda / Wolfie Lab ✅

- **Aluno ativo vs órfão:** `list_students_overview` retorna `has_activity` (tem booking OU pagamento). Painéis contam ATIVOS; órfãos (sem aula/pagamento = testes) ficam num filtro "Sem matrícula" + RPC `archive_student`. **A agenda (`bookings`) é a fonte de verdade de quem é aluno real** (perfis incluem ~20 contas de teste).
- **Caixa:** trigger `ledger_on_payment_received` lança ENTRADA no `financial_transactions` quando pagamento vira RECEIVED **e REMOVE quando deixa de ser** (estorno, chargeback, cobrança excluída) — ver a seção *Conciliação do caixa* abaixo, que corrigiu o regime de data e o conjunto de status. RPC `get_cashflow(month)` = entradas − saídas (repasses PAGOS + comissões + indicações pagas) das fontes autoritativas (sem dupla contagem) + inadimplência aging. Componente `CashflowPanel` (aba "Fluxo de Caixa").
- **Explorador de Agenda** (`TeacherScheduleExplorer`): % ocupação, aulas/alunos distintos, busca que destaca o aluno na grade, alerta de conflito (mesmo horário com 2 alunos). Conflitos detectados no load (`conflictKeys`).
- **Wolfie Lab:** RPC `wolfie_insights()` (escopo por ALUNO do tenant — `wolfie_sessions.tenant_id` é uuid ≠ slug, então escopa via student_id) → totais, pontos fracos recorrentes (`wolfie_corrections.error_type`), top alunos por uso, quantos nunca usaram. Painel no topo do `WolfieLab`.

---

## Aprovação de Material Pedagógico ✅

- `pedagogical_materials.approval_status` (APPROVED default p/ existentes; PENDING/REJECTED) + reviewed_by/at + rejection_reason.
- **Professor** envia material em `PedagogicalConfig` (upload bucket `materials`) → nasce **PENDING** (scope PRIVATE). Vê badge "Em aprovação" e alerta.
- **Banco assinalável** (`TeacherPedagogicalModal`, `MaterialsLibrary`) só mostra **APPROVED** — pendentes/reprovados de outros não vazam.
- **Diretor** aprova/reprova em `MaterialApprovals` (aba "Aprovar Materiais"). Aprovar → `approval_status=APPROVED` + `scope=TENANT` (entra no banco). RPCs: `review_material(id,approve,reason)`, `list_material_approvals()`.

---

## Biblioteca Pedagógica — Pastas, Nichos e Livros ✅

> Estrutura de organização: **Nicho › Nível › Livro › Partes**. Resolveu o caso de livros grandes demais pro storage, que são **fracionados em partes** (A1 Part 1..N) e precisam ficar agrupados.

**Nicho = catálogo dinâmico por escola (`tenant_niches`), fonte ÚNICA.**
- ❌ NUNCA mais chumbe nichos em `<select>` no frontend nem em CHECK constraint. A constraint rígida `check_pedagogical_niche` (5 valores fixos) foi **removida** — era a causa do erro "Erro ao salvar edição" ao usar nicho novo. O catálogo controla o que é válido.
- Os 5 base (GENERAL/MEDICINE/TECH/TRAVEL/BUSINESS) foram **seedados como dados** em `tenant_niches`, não são mais código. `niche='GENERAL'` é o fallback.
- RPCs (SECURITY DEFINER): `list_niches()`, `upsert_niche(label)` (gera key UPPER sem acento), `rename_niche(key,label)` (mantém a key → não quebra materiais), `delete_niche(key)` (reatribui materiais/livros pra GENERAL; GENERAL é protegido).

**Livro = `pedagogical_collections`** (id, tenant_id, title, niche, level_tag, cover_url). Cada livro mora numa pasta nicho+nível.
- `pedagogical_materials.collection_id` (FK ON DELETE SET NULL) + `part_number` = a "parte" dentro do livro. `collection_id` NULL = material **avulso** (continua funcionando).
- RPCs: `upsert_collection(id,title,niche,level,cover)`, `delete_collection(id)` (partes viram avulsas, não sào apagadas), `set_material_collection(material_id,collection_id,part_number)`.
- Escrita de livro/nicho só via RPC (RLS só permite leitura por tenant — policies `tc_read`/`tn_read`).

**Frontend:** `MaterialsLibrary.tsx` tem 3 modos: **Pastas** (árvore, default quando recebe prop `collections`), Nível, Nicho. Recebe `nicheLabels` (de `list_niches`) p/ rótulos. `PedagogicalConfig.tsx`: form de upload cria/seleciona livro + nº da parte (auto-incrementa ao subir partes em sequência), edição de material/livro, criação de nicho/livro inline. Visão do aluno (`StudentPedagogicalView`) não passa `collections` → cai no modo plano (retrocompatível).

**Migrations:** `20260604152000_pedagogical_niche_catalog` (documenta tenant_niches + RPCs que existiam só no banco — havia drift), `20260604152637_pedagogical_library_structure`, `20260604152738_pedagogical_library_rpcs`.

---

## Aula Experimental & Treinamento — Pagamento ao Professor ✅

> **Como o professor é remunerado por experimental e treinamento.** A regra de ouro: **o pagamento SÓ existe quando há um `class_logs` COMPLETED.** Tanto o "a receber" em tempo real (`TeacherFinancials.isLessonPaid`) quanto o fechamento mensal (`run_monthly_teacher_closing`) contam AULA EXPERIMENTAL e TREINAMENTO normalmente — eles só excluem `TEACHER_ABSENCE`, `REPOSIÇÃO` e `Teste Oral`. Ou seja: contabilizar = gerar o class_log.

**Fluxo (experimental e treinamento são o mesmo mecanismo, via `opportunities.kind`):**
1. Disparo: experimental pelo SmartFinder/`TrialsToContracts`; treinamento pelo `TrainingAdmin` ("Broadcast ao vivo"). Ambos chamam a edge `broadcast-opportunity` que cria `opportunities` (com `kind` TRIAL|TRAINING) e manda o link mágico `/claim-opportunity` no grupo de professores.
2. Aceite: professor abre `/claim-opportunity` (`components/ClaimOpportunity.tsx`) → cria um `appointments` com `type = 'experimental' | 'training'` + seta `opportunities.winner_teacher_id` e `trial_appointment_id`.
3. Lançamento manual: `LessonLauncher` lê esses appointments (via `opportunities.winner_teacher_id` + `trial_appointment_id`) e o professor lança → class_log COMPLETED, `subtype = 'AULA EXPERIMENTAL' | 'TREINAMENTO'`, `appointment_id` preenchido.
4. **Liquidação pelo diretor (rede de segurança):** `components/TrialTrainingSettlement.tsx` (aba **"Experimentais/Treinos"**) lista os appointments realizados ainda sem class_log e o diretor marca **"Compareceu → Pagar"** (gera o class_log COMPLETED) ou "Não" (marca `appointments.status='no_show'`, não paga). RPCs: `list_pending_trial_sessions()`, `settle_trial_session(appointment_id, attended)`.

**Pegadinhas / aprendido na marra:**
- ⚠️ **O `LessonLauncher` só mostra os últimos ~8 dias E o mês corrente.** Experimental/treino realizado fora dessa janela some e o professor não consegue lançar → por isso o painel do diretor (passo 4) é a rede de segurança. (Histórico: das 26 experimentais aceitas, só 2 foram pagas; 24 ficaram órfãs.)
- ⚠️ **`class_logs.appointment_id` é `text`; `appointments.id` é `uuid`** → sempre castar (`a.id::text`) ao cruzar.
- ⚠️ **Vínculo do professor no appointment:** use `COALESCE(appointments.teacher_id, opportunities.winner_teacher_id)` — appointments antigos podem ter `teacher_id` nulo.
- `settle_trial_session` é **idempotente** (se já há class_log para o appointment, retorna `ja_lancado`). Corte fixo `2026-06-01` no `list_pending_trial_sessions` ignora pendências históricas (decisão de negócio).
- **Migration:** `20260605120000_trial_training_settlement_rpcs`.

---

## Experimental com dono se REMARCA — não se redispara ✅

> **Leia antes de mexer em `dispatchTrial` (`whatsapp-inbound`) ou no leilão de experimental.**

**O caso (13/08/2026, lead Rafael Varela):** ele marcou a experimental para
quinta às 12:00 e a Teacher Lais **aceitou** (opportunity `CLAIMED` + appointment
`experimental` na agenda dela). Depois ele falou **direto com a professora** que
não dava meio-dia e sim 16:00 — e os dois já tinham resolvido. Quando ele contou
a mesma coisa no WhatsApp central, a atendente criou uma **segunda** oportunidade
às 16:00 e mandou o link de aceite para todos os professores livres.

**Causa:** `dispatchTrial` só deduplicava contra oportunidade **ainda OPEN** e com
data+hora **idênticas**. Assim que um professor aceitava, qualquer horário novo
virava leilão novo — e o `funnel-sweeper` ainda re-disparava a sobra 20 min
depois, para a escola inteira.

**A regra agora** (`supabase/functions/whatsapp-inbound/trial-reschedule.ts`,
decisão pura e testada; a I/O fica no `index.ts`):

| Situação | O que o agente faz |
|---|---|
| Não há experimental com dono | leilão normal (`dispatchTrial`), como sempre |
| Já tem dono e o horário pedido é o MESMO | não faz nada — só confirma ao aluno |
| Já tem dono e o dono está livre no horário novo | **move o appointment**, avisa professora + diretor |
| Já tem dono e o dono tem conflito real | **não move e não leiloa** — avisa professora + diretor |

- ⚠️ **Disponibilidade DECLARADA (`teacher_availability`) NÃO entra na remarcação.**
  Professora e aluno combinam por fora; exigir a grade cadastrada recusaria
  justamente o caso que existe para ser atendido. O que barra é conflito de
  verdade (30 min de início a início, a mesma regra da tela de aceite), contra
  appointment do dia, aula fixa do mesmo dia da semana e booking com data própria.
- ⚠️ **Conflito escala para gente, não para leilão.** Redisparar ali daria a mesma
  aula a dois professores — e é exatamente o defeito que estamos consertando.
- ⚠️ **Só appointment `scheduled` segura o agendamento**, e com janela de 7 dias
  para trás: aula cancelada/dada/furada encerrou o ciclo, e aula velha esquecida
  em `scheduled` não pode sequestrar um pedido novo. O update carrega
  `.eq("status","scheduled")` — cancelamento no meio do caminho não vira
  remarcação sobre agendamento morto.
- **Leilão órfão morre junto** (`supersedeOpenTrials`): antes de abrir um novo, e
  também ao remarcar, as oportunidades `OPEN` do mesmo telefone viram `EXPIRED`.
  Dois leilões vivos = dois professores aceitando horários diferentes para a
  mesma pessoa. ⚠️ **Não mexe em `conversion_status`** — `LOST` ali é lead perdido
  no funil, e quem só remarcou não perdeu nada.
- **O prompt da atendente muda quando existe aula aceita:** ela pode citar a
  professora pelo nome e dizer que a aula ESTÁ marcada (a regra dura de "nunca
  diga que está agendada" vale para quando ainda não há dono).
- **Fuso:** `appointments.start_time` é UTC e a escola pensa em BRT
  (12:00 BRT = 15:00Z). Use `brtStartIso` / `brtSlotFromIso` — a tela de aceite
  monta o ISO pelo relógio do navegador do professor, a edge function roda em UTC.
- **O registro não depende do envio** (`conversation-log.ts`, achado no teste
  ponta a ponta de 13/08/2026): a resposta ao lead só era gravada em
  `ai_wa_messages` **se o WhatsApp aceitasse** — uma remarcação acontecia no
  banco e não sobrava prova nenhuma da decisão. Hoje toda resposta é registrada
  com `entregue: true|false`.
  ⚠️ **E o histórico enviado ao modelo filtra o que não foi entregue** — senão a
  atendente leria "eu já expliquei isso" sobre uma mensagem que o aluno nunca
  recebeu. O filtro roda **em memória, não no PostgREST**: `meta->>entregue neq
  false` descartaria toda linha antiga (sem o campo), porque comparação com NULL
  não é verdadeira.
  ⚠️ Tentativa falha passa a contar no teto de 12 respostas/hora — cada uma
  custou uma chamada de modelo, que é o que o teto protege. E `last_outbound_at`
  (que alimenta o `sdr-followups`) só avança quando a mensagem chega.
  A convenção vale para **todos os agentes** (atendente, RH, assistente de
  gestão, atendimento de aluno) e para o retorno do `funnel-sweeper`.
- **Testes:** `trial-reschedule.test.ts` (11 casos, incluindo o caso do Rafael
  como regressão), registrado no `release.sh`.
  ⚠️ O arquivo tem `/// <reference lib="deno.ns" />` porque o `tsconfig.json` da
  raiz (lib DOM, do Vite) é lido pelo Deno e apaga `deno.ns` quando o teste roda
  sozinho.

---

## Transferir aula para outro professor — `search-slots` e a disponibilidade ✅

> **A disponibilidade do professor é SLOT DISCRETO de 30 min, não intervalo.**

`teacher_availability.end_time` é **NULL nas 322 linhas** do banco. Quem tratar a tabela como
intervalo (`start_time <= t AND end_time > t`) recebe lista vazia **sempre** — em SQL,
`NULL > '15:30'` não é falso, é NULL, e a linha nunca entra no resultado.

Foi o que aconteceu com `search-slots`, que alimenta o botão **"Substitutos"** do
`AbsenceCoverageManager`: devolvia `{"slots":[]}` em 100% das chamadas, então a coordenação
nunca conseguia escolher quem cobre e **transferir aula era inalcançável desde sempre**
(`teacher_absences` estava com **0 linhas** em produção). Medido: a query antiga devolvia 0
professores para Terça 15:30; o slot discreto devolve 3.

- ⚠️ **`search-slots` rodava com service role e SEM autenticação nenhuma** — devolvia nome e
  **telefone** de professor de qualquer escola para quem tivesse a chave anon. Hoje exige
  JWT e escopa pelo tenant de quem chamou.
- **Conflito é checado em três frentes:** aula fixa (booking recorrente), aula avulsa daquela
  data e reposição já marcada naquela data. Cobertura só é honesta se o substituto estiver
  mesmo livre.
- O resto do código já tratava a tabela como slot discreto (`dispatchTrial` usa
  `.eq("start_time", …)`); só o `search-slots` divergia.
- ⚠️ **`accept-coverage` devolve HTML e funciona** — testado, o gateway entrega
  `text/html`. É exceção à regra "edge function não renderiza HTML" (que vale para o que o
  Kong serve nas rotas do SPA). Não "conserte" movendo para o SPA sem medir.
- ⚠️ **Página HTML com `Referrer-Policy: no-referrer` NÃO pode checar `Origin` no POST.**
  Com essa política o navegador manda `Origin: null` no envio do formulário (medido no
  Chromium em 16/09/2026). A `teacher-training-invite` fazia a checagem e devolvia 403
  "Origem inválida" para **todo** aceite — nenhum convite de treinamento foi aceito entre
  09/09 e 16/09 (a Bruna foi a primeira a reclamar). Quem protege o aceite é o token de 64
  hex no corpo, como na `accept-coverage`/`claim-coverage`, que nunca checaram origem.

---

## Cobertura de aula que JÁ aconteceu — a direção atesta ✅

> **Leia antes de mexer em `gestao_create_coverage_invite`, `enforce_active_class_coverage_slot`
> ou em qualquer escritor de `teacher_absences`.** Migration `20260916210000`.

**O caso (16/09/2026):** o Flávio acordou doente, a Débora deu a aula do Theo (agenda
09:30, dada às 10:00). À tarde, no grupo da Gestão, a direção pediu a cobertura e ouviu
*"precisa ser para uma aula que ainda não começou"*. A aula ficou no financeiro de quem
não a deu.

**A regra:** aula **futura** segue pelo convite (o substituto aceita no link). Aula que
**já começou** (até 31 dias atrás) nasce `confirmed` com `class_coverages.confirmed_by` =
quem pediu, e `apply_coverage_acceptance` — **a mesma rotina do aceite** — move o
lançamento já feito para o substituto (`aula_movida`) ou deixa o lançamento futuro com
ele (`lancamento_redirecionado`), recalculando o fechamento dos dois. Medido em
`ROLLBACK` com os dados reais: o log saiu do Flávio (R$ 10,50, faixa dele) e entrou na
Débora (R$ 8,00, faixa dela) — **aula por aula, na tarifa de quem deu**.

- ⚠️ **Para aula já dada NÃO valem** grade declarada nem "substituto ocupado": a Débora
  tinha a própria aula às 09:30 e deu a do Theo às 10:00. Quem atesta é a direção; o
  horário real vai no motivo, e a cobertura fica amarrada ao **booking** (é o que
  identifica a aula para o pagamento). O assistente aceita hora diferente da agenda
  quando o aluno tem UMA aula com aquele professor no dia.
- ⚠️ **Mês fechado (`teacher_closings.status <> 'PENDENTE'`) recusa** com `mes_fechado`.
  Mover aula num mês pago criaria diferença que relatório nenhum mostraria.
- **O trigger reconhece a cobertura atestada por `confirmed_by`**: exige que a aula já
  tenha começado (`retroactive_coverage_window`) e dispensa grade/conflito. Os marcadores
  que `gestao_management_agent_hardening.sql` procura continuam lá.
- Os dois professores recebem **aviso** (não convite): o substituto "conta no seu
  pagamento" e o ausente "não entra no seu". Falha no aviso não desfaz o registro.

### ⚠️ `teacher_absences` tem CHECKs criados FORA do repositório — e ninguém obedecia

`reason IN ('SICK','VACATION','PERSONAL','OTHER')` e `status IN ('ACTIVE','RESOLVED',
'CANCELLED')`, vivos só no banco (`supabase/schema/producao-*.sql`). A RPC do grupo e os
dois escritores do painel (`coverage-admin`, `AbsenceCoverageManager`) gravavam texto
livre + `'active'` → **todo pedido de cobertura da direção morria no insert da ausência**.
Medido: 0 linhas em `teacher_absences`, 0 coberturas com `request_id` na história. Hoje:
`reason` derivado do texto (`SICK`/`OTHER`), texto em `notes`, `status = 'ACTIVE'`. Leitores
usam `lower(status)` ou `.in(['ACTIVE','active'])` — `.eq('status','active')` é código morto.

### ⚠️ Participante do grupo chega como `@lid` — `p_actor_id` é NULL nas ações

A Evolution entrega quem escreve no grupo como `99201044238394@lid`, sem telefone, então
`resolveManagementActor` não acha o perfil e a ação segue como `MANAGEMENT_GROUP_MEMBER`
com `userId = null`. A **autorização** vem da ação pendente confirmada
(`private.management_group_execution_authorized`, por `request_id`), não da identidade —
mas qualquer RPC que **exija** o uuid (`if p_actor_id is null`, ou que grave `confirmed_by`
/`created_by` com ele) quebra só para quem escreve pelo grupo. Foi assim que a cobertura do
Theo passou pela autorização e morreu no INSERT (`active_coverage_already_started`, porque
`confirmed_by` nulo é "cobertura futura" para o trigger), em 16/09/2026 à noite.
Regra (migration `20260917000000`): `v_attester := coalesce(p_actor_id,
private.management_group_default_actor(p_tenant))` (o diretor ativo da escola) para
atribuição; a auditoria (`gestao_action_audit`) guarda o jid real. ⚠️ O release **recusa
migration já aplicada com checksum diferente** — editar a de ontem derrubou o deploy; o
conserto vai em migration nova com `create or replace`. ⚠️ Testar RPC de grupo **com `p_actor_id := null`** e uma linha `executing` em
`gestao_acao_pendente` — testar só com o uuid do diretor, como fiz na véspera, passa e
não prova nada.

### ⚠️ O substituto precisa ENXERGAR o aluno — senão a cobertura "registrada" não chega ao lançamento (18/09/2026) ✅

A Bruna tinha três coberturas confirmadas de 16/09 e o `Lançar Aula` mostrava nada ("Não
aparece para eu lançar aula"). `coverages_for_teacher_in_tenant` devolvia as três, os
`bookings` do Flávio apareciam — mas `_teacher_can_access_student` só reconhecia
`professor_id`/`professor_id2` e `bookings` SCHEDULED; o join `student:student_id(...)` do
`LessonLauncher` voltava `null` e a aula era descartada em silêncio (`if (!student) return`).
Como o pagamento é `class_logs` × tarifa, a substituta não recebia. Migration
`20260918080000`: cobertura confirmada (`cover_teacher_id`) e reposição atribuída
(`reschedules.teacher_id`) abrem o aluno para o professor (só a projeção de diretório —
grants de coluna continuam). Medido por pessoa em produção: só Bruna, Débora e Mateus mudam.
Teste: `supabase/tests/substituto_enxerga_o_aluno_que_cobre.sql`.

- ⚠️ **Convite recusado/cancelado bloqueava a próxima cobertura da MESMA aula.** A UNIQUE
  `(booking_id, class_date)` de `class_coverages` (criada fora do repositório) valia para linha
  cancelada — o atestado retroativo do Theo (convite cancelado na véspera) morria em
  `duplicate key`. Migration `20260918090000`: índice parcial só para `confirmed`
  (+ legados); quem cuida das vivas é o trigger. Teste:
  `supabase/tests/cobertura_cancelada_nao_bloqueia_a_proxima.sql`.
- ⚠️ **Treinamento: o appointment é da TRAINER.** `teacher_training_invite` cria o
  `appointments` com `teacher_id = trainer` (Débora), e `protect_training_class_log` recusa
  lançamento nesse appointment por quem não é a trainer. O professor que RECEBE o treinamento
  lança num appointment PRÓPRIO (`type='training'`, `teacher_id` = ele, sem sessão vinculada)
  → `v_payable_class_logs` paga R$ 8 (não é `is_trainer`). Foi assim que o treinamento da
  Bruna (16/09 15:50) entrou.
- **Cobertura confirmada não aparece na Agenda nem no "Aulas de hoje" do substituto** —
  `TeacherAvailabilityEditor` lê só `bookings` + experimental, `TeacherDashboard` lê
  `list_teacher_lesson_booking_occurrences` (só bookings próprios) + reposições + trials.
  Ela só aparece em `Lançar Aula`, depois do horário do slot. Reposição atribuída
  (`reschedules.teacher_id`) aparece no "Aulas de hoje" e em Reposições. Lacuna conhecida.
- **Horário combinado ≠ slot:** a cobertura fica amarrada ao slot do booking (16:30) mesmo que
  a aula seja às 18:00 — o combinado vai no motivo/notes (mesma regra do Theo/Débora). O
  `class_log` nasce com o horário do slot.

### Reposição com trilha — só existe marcada no sistema (migration `20260918100000`) ✅

**O caso (18/09/2026):** o Flávio "passou a reposição que tinha marcado para hoje" e a direção
não sabia horário nem motivo — as 13 dele estão `Pendente`; a reposição foi combinada por
fora. Medido em 60 dias: **138 criadas, 16 com data (12%), 11 dadas, 122 abertas sem data**
(Mateus 127, Lais 34, Flávio 13, Débora 10). A tela só gravava data/hora, sem motivo, sem
histórico, sem aviso, sem `audit_logs`.

- **`reschedule_events`** (trigger `trg_zz_reschedule_events_capture` em `reschedules`):
  criada · marcada · remarcada · desmarcada · professor_trocado · atestada · dada, com ator,
  origem (`app` tela · `whatsapp_professor` · `whatsapp_aluno` acompanhamento · `direcao` ·
  `sistema`), motivo e `em_cima_da_hora` (< 3 h). Origem/motivo entram por
  `set_config('app.reschedule_source'|'app.reschedule_reason', …, true)` antes do UPDATE —
  a RPC e o `care_set_reschedule_slot` já fazem isso. **Venha de onde vier a mudança, a
  trilha existe.** `set_config('app.reschedule_silent','on',true)` cala os avisos num
  reparo em massa por SQL.
- **Avisos automáticos** (fila `notification_queue`, kind `MANAGEMENT_NOTICE`, idempotente
  `reschedule-event:<id>:group|family`): uma linha no **canal de coordenação** e uma para a
  família (marcada/remarcada/desmarcada; atestado e troca de professor são internos).
- **`schedule_reschedule(id, data, hora, motivo)`** — remarcar (já tinha data) sem motivo
  → `motivo_obrigatorio`. A assinatura de 3 argumentos foi derrubada (PostgREST recusaria
  por ambiguidade). **`unschedule_reschedule(id, motivo)`** volta a `Pendente`.
- ⚠️ **Reposição de falta do PROFESSOR dada por OUTRO professor nunca pagava:**
  `teacher_reschedule_financial_origin_is_proven` só conhecia o lançamento de falta do
  próprio titular. Agora a direção **atesta** (`attest_teacher_fault_reschedule(id, motivo)`,
  SCHOOL_ADMIN/COORDINATOR ou service_role) — como na cobertura de aula já dada. Colunas
  `attested_*` são do servidor (`trg_aa_reschedule_server_fields_guard`, chave
  `app.reschedule_attest`); `fault_type` só muda por admin/service_role/DBA. Professor não
  tem policy de UPDATE em `reschedules` — escreve só pelas RPCs.
- **`reschedule_backlog_summary(tenant)`**: por professor, sem data · vencidas · marcadas
  em 7 dias · mais antiga. Base do resumo semanal e do comando do grupo (ainda por ligar).
- Tela `TeacherReschedules`: motivo (obrigatório ao remarcar), ⚠️ "em breve", histórico
  (`reschedule_events`, RLS: professor vê as suas), Desmarcar. Regras espelhadas em
  `lib/rescheduleRules.ts` (com teste).
- **Etapa 2 (migration `20260918110000`):** o professor marca/remarca/desmarca pelo
  WhatsApp da escola — "a reposição do Theo passou para terça 15h", "marca a reposição da
  Ana amanhã 16:30", "desmarca a reposição do Vinícius" (`teacher-reschedule-move.ts`,
  puro, testado; roteado ANTES da troca de horário fixo porque "passou para 15h" casa nos
  dois — a palavra *reposição* decide). Proposta + "confirma?" (motivo junto: "sim, aluno
  pediu") → `teacher_reschedule_prompt_apply` age como o professor pela MESMA RPC da tela,
  com `app.reschedule_source = whatsapp_professor`. Comando **"reposições"** no grupo
  (Direção ou Coordenação) e **resumo toda segunda** no canal de coordenação
  (`daily-automations`, kind `RESCHEDULE_WEEKLY`); **reposição vencida** (data passou, sem
  lançamento) cobra o professor uma vez por reposição (`RESCHEDULE_OVERDUE`, marca em
  `automation_sent` antes da fila) e resume no grupo (`RESCHEDULE_OVERDUE_GROUP`).
  Composição em `_shared/reschedule-messages.ts` (ritual completo no `release.sh`).

### Canais de aviso — um grupo de WhatsApp por assunto (migration `20260918100000`) ✅

Decisão da direção (18/09/2026): o grupo da Gestão centralizava dinheiro, agenda, funil e
o assistente. Agora **4 canais**: `direcao` (rateio, DRE, folha, cobrança, planos, lead de
professor, perguntas de gestão), `coordenacao` (ausência, cobertura, reposição, troca de
horário, aluno faltando, briefing de experimental), `comercial` (lead, experimental
marcada/aceita/sem professor, pós-experimental, follow-up), `professores` (disparos —
`profiles.teachers_group_id`).

- **Fonte:** `tenant_notice_channels (tenant, channel, group_jid)`; resolver
  **`private.tenant_notice_destination(tenant, canal)`** → configurado, senão
  `teachers_group_id` (só `professores`), senão `management_group_destination` (Gestão).
  **Canal sem grupo cai na Gestão** — nada se perde enquanto os grupos são criados.
- Tela: *WhatsApp (Conexão)* → "Canais de aviso da gestão" (`GroupSelector` com
  `channel=`, RPCs `get_notice_channels` / `save_notice_channel`).
- Já roteados: eventos de reposição, `coverage_briefing_enqueue` (resumo da cobertura) e
  `teacher_apply_student_schedule_change` (troca de horário) → `coordenacao`.
- **Etapa 2 (migration `20260918110000`):** `comercial` cai em `profiles.directors_group_id`
  ("EXPERIMENTAL CONFIRMADAS") antes da Gestão. Edge functions leem o canal por
  `loadTenantNoticeDestination(sb, tenant, canal)` (`_shared/tenant-communication.ts` →
  RPC `notice_channel_destination`, service_role): `claim-coverage`, ausência e cobertura
  do dia no `whatsapp-inbound` → `coordenacao`; `payment-split-notify`, `dre-report`,
  `management-payroll-report`, `monthly-reserve-notify`, renovação → `direcao`. **O bot
  ouve os grupos por canal**: ingress e inbox aceitam o conjunto de `notice_channel_jids`
  (menos o dos professores); `private.management_group_jid_is_authorized` entra em
  `management_group_execution_authorized` e `whatsapp_inbox_remote_jid_is_allowed`.
  Escopo: Direção/Gestão = tudo; **Coordenação** = cobertura, cobertura do dia,
  transferência, troca de horário, treinamento, reposições (pedido de dinheiro ou pergunta
  de gestão ganha "isso é no grupo da Direção" — o retrato financeiro não sai lá);
  **Comercial** = só avisos (comando vira um ponteiro).
- **Canal `financeiro` (19/09/2026, migration `20260919100000`):** a direção criou DIREÇÃO,
  FINANCEIRO, COORDENAÇÃO e AULAS E COMERCIAL — dinheiro ganhou grupo próprio. `financeiro`
  recebe rateio (`payment-split-notify`), DRE, folha (`management-payroll-report`) e caixinha
  (`monthly-reserve-notify`); sem grupo configurado cai na **Direção**, depois na Gestão. No bot,
  o grupo Financeiro executa `conta_pagar`, `ajuste_repasse`, `folha_professores`,
  `mudanca_plano` e responde pergunta de gestão; agenda ganha "isso é na Coordenação".
  ⚠️ **As cercas do outbox de aviso de pagamento** (`begin_/authorize_management_payment_
  notification_submission`) comparavam o destino esperado com `dre_report_settings.destino` —
  com canal apontando para outro grupo, TODO rateio seria suprimido
  (`management_destination_changed_before_send`). Agora comparam com
  `tenant_notice_destination(tenant, 'financeiro')`. Ao rotear um aviso que passa por outbox,
  procure a cerca correspondente.
- **Folha do mês EM ABERTO é prévia, não zero.** `gestao_payroll_summary` lia só
  `teacher_closings` (nasce no dia 1º): em setembro a Bruna saía como "0 aulas · R$ 0,00" com
  oito "↪ cobriu …: +R$ 8,00" embaixo — lia-se "as coberturas não entraram na contabilidade
  dela", quando o Financeiro dela já dizia R$ 120. Hoje `private.payroll_month_rows` devolve,
  para quem não tem fechamento, `status = 'PREVIA'` com a MESMA conta do Financeiro do
  professor (`v_payable_class_logs` + `closing_adjustments`), cobertura confirmada sem aula
  lançada sinalizada (`received.pending`, item `logged=false` → "ainda não lançada", nunca
  "+R$ 0,00"). "Repasse a Profs" mostra a prévia por professor (`payroll_month_preview`,
  `data-tour="payroll-preview"`) em vez de ficar em branco até o dia 1º.
- **Wise Wolf em 19/09:** `dre_report_settings.destino` passou a ser o grupo DIREÇÃO (o
  antigo "Gestão" ficou sem função — nada mais cai nele); `directors_group_id` → AULAS E
  COMERCIAL (era "EXPERIMENTAL CONFIRMADAS"). ⚠️ `teachers_group_id` aponta para "LEADS WISE
  WOLF" (4 pessoas, nenhuma professora) — o broadcast de vaga é individual por padrão, então
  não dói, mas o "Grupo de Oportunidades" está errado até a direção escolher o grupo certo.

### Cobertura do DIA — "Flávio não dá aula hoje" (migration `20260916230000`) ✅

O modelo `class_coverages` é **um convite para um professor** e o trigger proíbe dois
convites vivos para a mesma aula. "Vários recebem, o primeiro leva" é outro objeto, como o
leilão da experimental: **`coverage_opportunities`** (uma por aula do dia) +
**`coverage_opportunity_invites`** (um link por professor candidato — é o que identifica
quem clicou). No aceite (`claim_coverage_opportunity`, edge `claim-coverage`, HTML como a
`accept-coverage`) nasce a `class_coverages` pending→confirmed **pelo mesmo trigger**, que
garante um vencedor só; `apply_coverage_acceptance` faz o financeiro; os outros convites
viram `LOST`. `confirmed_by` fica NULL de propósito (quem aceitou foi o substituto).

- **Candidatos** (`private.coverage_candidates`): grade declarada no horário, sem aula/
  reposição/experimental/ausência/cobertura no slot, com WhatsApp, mesma escola, e
  `can_access_teacher_projection`. Mesmas barreiras do convite individual.
- **Grupo:** ação `cobertura_dia` (professor, data, motivo) → lista as aulas do dia que
  ainda não começaram → `sim #código` → `gestao_open_coverage_day` → DM com link para cada
  candidato → resumo no grupo ("09:30 Theo — 3 professores avisados"). Aula sem candidato
  aparece como ⚠️ para a direção resolver na mão. Ao aceitar, a página avisa o grupo e o
  professor ausente.
- `p_source='teacher'`: o próprio professor pode abrir a própria ausência (porta da
  instância da escola — **ainda não ligada** no roteamento do inbound).
- Teste sintético: `supabase/tests/cobertura_do_dia_oportunidade_para_varios.sql`.

### Troca de plano pelo grupo (migration `20260916220000`) ✅

`mudanca_plano` (aluno, frequência, valor) ou de carona em `transferencia_professor`
(`nova_frequencia`/`novo_valor`): `gestao_create_plan_change` cria a proposta em nome de
quem pediu e o aluno recebe o link `/mudar-plano` no WhatsApp. A regra da tela não muda —
**a direção propõe, a assinatura do aluno aplica, a Asaas entra pela fila.** O `expected`
do aval é montado na RPC (com `p_tipo`), nunca pelo chamador.

### Professor avisa a instância que não dá aula (migration `20260916240000`) ✅

Professor conhecido escrevendo para o número da escola caía num `continue` **mudo** (não
era a atendente — era ninguém). Hoje `teacher-absence.ts` (puro, testado) reconhece
*"não vou conseguir dar aula hoje/amanhã/dia 18"*, o bot lista as aulas do dia e pergunta
**"confirma?"** (`teacher_absence_prompts`, 2 h de validade, uma por professor). No SIM:
`gestao_open_coverage_day` com `p_source='teacher'` (ele atesta a própria ausência), aviso
no grupo da Gestão com o mesmo resumo do comando do grupo, links para os professores livres.
Falso positivo custa uma pergunta; por isso a regex é generosa e a confirmação, obrigatória.

### Professor troca horário do aluno pelo WhatsApp da escola (migration `20260917190000`) ✅

"O aluno Felipe trocou pra 14:30 e a Isabella para as 14" (Teacher Mateus, 17/09/2026) —
a coordenação fazia na mão. Hoje `teacher-schedule-change.ts` (puro, testado) lê o pedido
(nome, horário novo; dia/horário de origem opcionais), `teacher_schedule_change_candidates`
resolve o nome na agenda fixa do professor (prefixo de qualquer nome, sem acento; dois
"Felipe" → pergunta qual), `proposeChanges` monta aula a aula o que muda (sem dia = todas
as aulas que ainda não estão no horário), e o bot mostra "Quinta 14:00 → 14:30 … Vale a
partir de amanhã. Confirma?" (`teacher_schedule_change_prompts`, 2 h, uma por professor).
No SIM, `teacher_schedule_change_prompt_apply` (só service_role) age como o professor
(`trial_closing_act_as`) e chama a **mesma RPC da tela** (`teacher_apply_student_schedule_change`:
vigência amanhã, choque checado, Gestão avisada) — o bot não inventou regra de agenda nova.

- ⚠️ **Uma aula por chamada, em duas rodadas.** A RPC da tela recusa o lote inteiro se UMA
  aula choca (Felipe: quarta 14:30 é da Ana Clara; quinta e sexta estavam livres). E um
  choque pode ser com aula que a PRÓPRIA proposta tira do lugar (Isabella vai para quinta
  14:00, de onde o Felipe sai para 14:30): a segunda rodada retenta o que chocou depois
  que o resto mudou. Medido em `ROLLBACK` com a proposta real: 3 aplicadas, 1 choque.
- **O choque é dito ANTES do "confirma?"** (`teacher_schedule_change_busy` +
  `annotateConflicts`: "⚠️ Quarta 14:30 já é de Ana — essa fica como está") e fica fora
  da proposta; o SIM aplica só o que pode mudar. O resultado repete aula a aula, com quem
  ocupa o horário quando ainda assim choca.
- Roteamento no inbound: professor → ausência → **troca de horário** → resposta de
  acompanhamento. `fold_accents` já existia no banco (usada pela RPC da tela) — não crie
  outra função de tirar acento.

### Cobertura aceita traz o pacote do aluno; o substituto responde "sim" por texto (migration `20260917200000`) ✅

A coordenação negociava com a Bruna na mão ("10:30 você consegue?" / "Consigo sim" / "vou te
mandar o contato e o conteúdo"). Hoje, ao ACEITAR uma cobertura — pelo link
(`accept-coverage` → `resolve_coverage_invite_and_brief`), pela disputa do dia
(`claim-coverage` → `coverage_briefing_enqueue`) ou **respondendo "consigo sim"/"não consigo"
ao número da escola** (`handleTeacherCoverageReply`, com `teacher_pending_coverage_invites`) —
`coverage_briefing_enqueue` põe na `notification_queue` (instância central, kind
`MANAGEMENT_NOTICE`, idempotente por `coverage:<id>:briefing|family|group`): o pacote para o
substituto (contato do aluno em `wa.me/`, responsável se kids, última avaliação de nível do
professor, objetivo, **últimas 3 aulas com "próx." e lição**), o aviso à família de quem dá
a aula e o resumo no grupo da Gestão (recusa também vai ao grupo).
- ⚠️ `profiles.level` é nível de **gamificação** (XP), não CEFR — o briefing usa
  `class_logs.assessment_level` mais recente. Aula de 1 h vira dois lançamentos iguais: linha
  repetida é pulada.
- ⚠️ "Combinado"/"ok"/"perfeito" **não** aceitam cobertura (`coverageInviteAnswer`): são acuso
  de recebimento; registrar cobertura e avisar a família por um "ok" seria pior que perguntar.
  Vários convites pendentes: o professor escolhe pelo horário ou responde "todas".
- ⚠️ `private.management_group_default_actor` nasceu com dono `supabase_admin` e ACL só para
  ele; função com dono `postgres` que a chama precisa do `grant execute … to postgres` (feito
  nesta migration). Reposição (`reschedules`) com outro professor **não** é cobertura de
  booking — continua manual.

### 🚦 Teto e aquecimento do WhatsApp — todo envio automático pede licença ao banco ✅

> Migration `20260918000000`. **Leia antes de criar qualquer disparo automático.**

**O caso (17/09/2026, 14:15):** o WhatsApp **restringiu o número da escola por 21 h**
depois de ~130 mensagens automáticas em 7 h (pico de 37/h), boa parte para contato frio.
Um número só concentra atendente, lembretes, acompanhamento, cobertura e Gestão — banimento
definitivo derruba tudo de uma vez.

- **Choke point:** `sendWhatsTextToResolvedDestinationDetailed` em `_shared/evolution-send.ts`
  (26 módulos passam por ele) chama `whatsapp_outbound_permit(instância, destino)` antes do
  POST. `allowed=false` → `{outcome:"rejected", throttled:true, retryAfterMs}`; `sendWhatsText`
  devolve `false` (quem "marca antes e apaga se falhar" tenta na rodada seguinte — é o
  espalhamento desejado). `wait_ms ≤ 12 s` → dorme e manda. Sem `SUPABASE_URL`/chave (testes)
  ou com o banco fora, **não trava** (fail-open com `console.error`).
- **O tipo é do destino, não do chamador** (`private.whatsapp_outbound_kind`): `group`;
  `reply` (a pessoa escreveu ao número nas últimas 72 h — sem espaçamento); `staff` (perfil da
  equipe — sem espaçamento); `transactional` (aluno/responsável com perfil — 20–40 s);
  `outreach` (o resto: lead frio, follow-up — 60–120 s, teto 10/h e 50/dia por padrão).
  Tetos por instância em `whatsapp_outbound_policy` (linha criada sozinha no 1º envio;
  `enabled=false` desliga a régua).
- **Aquecimento:** `warmup_started_at` → 40 % dos tetos no dia da volta, 70 % no seguinte,
  100 % depois. Depois de QUALQUER restrição: `update whatsapp_outbound_policy set
  warmup_started_at = <hora da volta>`.
- **Fila (`process-notification-queue`):** espia a régua (`p_reserve=false`) ANTES do fence
  e, se vetada, `defer_notification_delivery` devolve a vaga **sem gastar `attempts`** (o
  claim já tinha somado 1). Corrida rara depois do fence vira `pending` com backoff.
- `throttle: "skip"` só para envio manual de gente (inbox). Os 12 chamadores que fazem
  `fetch` direto em `message/sendText` (broadcast-opportunity, hr, register-teacher, inbox
  proxy…) **não** passam pela régua — baixo volume; ao criar disparo novo, use o helper.
- Livro em `whatsapp_outbound_ledger` (2 dias, cron `wisewolf-wa-ledger-prune`). Diagnóstico:
  `select kind, count(*) from whatsapp_outbound_ledger where slot_at > now()-interval '1 day'
  group by 1` e `docker logs … | grep "adiado pelo teto"`.
- `sdr-followups` caiu de 15 para **5 por rodada**; `care-sweeper` e `sdr-followups` ficaram
  pausados em 17/09 e voltam com a régua no ar.

### ⚠️ Link para GENTE usa `SUPABASE_PUBLIC_URL`, nunca `SUPABASE_URL` (17/09/2026) ✅

Dentro do container `SUPABASE_URL` é **`http://kong:8000`** (rede interna). `whatsapp-inbound`
(convite individual e disputa do dia) e `coverage-admin` montavam
`…/functions/v1/accept-coverage?token=` com ele — **todo convite de cobertura saía com link que
não abre no celular**. Medido: 0 coberturas com `dispatched_at` na história. Hoje:
`publicFunctionsBase()` / `PUBLIC_FUNCTIONS_URL` = `SUPABASE_PUBLIC_URL`
(`https://api.wisewolflanguage.com.br`), com `SUPABASE_URL` só como fallback. Cliente
supabase-js continua com `SUPABASE_URL` (interno, correto). Ao criar link que uma pessoa
abre, procure `SUPABASE_PUBLIC_URL` — e teste com `curl -I` no host público.

### A atendente respeita a janela de horário do lead — e o código veta horário inventado ✅

A Ana Carolina (17/09/2026) disse "sábados ou dias de semana depois das 18h". Nenhum professor
tem sábado na grade; a atendente ofereceu "2026-09-19 às 09:00" (inventado, data crua), o
leilão falhou e a alternativa foi 10:30 num dia útil. Em `_shared/sdr-scheduling.ts`:
`parseAvailabilityWindows` (dias × faixa: "depois das 18h", "antes das 12", "entre 19h e 21h",
"de manhã", "fim de semana", "dias de semana", nomes de dia; negação não vira janela; hora com
data por perto é escolha, não disponibilidade) → a lista dada ao modelo é filtrada pela janela
(`filterSlotsByWindows`), o prompt recebe `availabilityFacts` ("aos sábados → NENHUM professor
livre; seg–sex depois das 18:00 → 58 opções"), `rankTrialAlternatives` trata a janela como
filtro duro quando há opção dentro dela, e `replyOffersUnknownSlot` **veta** resposta que
oferece data+horário fora da lista livre (vira `unavailablePreferenceNote` + alternativas
reais). Datas saem como "sex 18/09 às 18:00" (`formatSlotBr`/`humanizeIsoDates`).
⚠️ O veto não roda com experimental já marcada (`activeTrial`): o modelo cita o horário dela,
que não está na lista livre.

### Folha do mês por professor no grupo (migrations `20260916250000`/`260000`) ✅

`gestao_payroll_summary(tenant, mês)` lê `teacher_closings` (a folha oficial) e as
coberturas confirmadas do mês (`class_log_id` → `rate_efetivo`); o compositor
`_shared/payroll-message.ts` mostra, por professor, aulas · valor · status e as coberturas
**linha a linha** ("↪ cobriu Theo de Flávio em 16/09: +R$ 8,00" / "↩ cedeu…"), com o
*previsto pela agenda* = folha − recebidas + cedidas. Duas portas, um texto: o comando
só-leitura `folha_professores` no grupo ("folha de agosto") e o cron
`wisewolf-monthly-payroll-gestao` (dia 1º, 07:00 UTC, edge `management-payroll-report`,
dedupe `automation_sent` kind `MONTHLY_PAYROLL`, marca antes do envio).
⚠️ O valor "que o ausente teria recebido" é conta hipotética (depende da faixa dele) — a
cedida mostra só a contagem, e o previsto usa a tarifa de quem cobriu.

---

## A grade do Explorador de Agenda TEM SEMANA ✅

> **Reposição e experimental são eventos de UM DIA. A grade é semanal.** Misturar os dois é
> o que fazia a reposição parecer "chumbada".

Antes as colunas eram só "Segunda…Sábado", sem semana, e a reposição era casada pelo **dia da
semana** da data dela. Uma reposição marcada para quinta 20/08 pintava a célula "Quinta" em
**toda semana** até a data passar — indistinguível de aula fixa. Pior: a célula desenha a
reposição **antes** do booking, então ela **escondia o aluno fixo** daquele horário.

- Hoje cada coluna tem **data concreta** (`weekStartOf`, `dateForDayIndex`,
  `dayLabelWithDate` em `lib/scheduleGrid.ts`) e o rótulo mostra "Segunda 11/08" — é o que
  deixa explícito, na tela, que a grade é de uma semana e não de um molde perpétuo.
- ⚠️ O paliativo anterior (mostrar só `date >= hoje`) **escondia o sintoma no passado e
  deixava o futuro intacto**. Não confunda com correção.
- ⚠️ **Domingo pertence à semana que ACABA nele**, senão quem abre a tela no domingo vê a
  semana seguinte e acha que perdeu as aulas da semana corrente.
- ⚠️ **`appointments` NÃO tem colunas `date`/`time`** — tem `start_time` (timestamptz). O
  código da experimental lia `t.date`/`t.time`, que são `undefined`: `new Date(undefined)`
  vira Invalid Date, `dIdx` vira NaN e o bloco nunca renderiza. **A experimental era código
  morto na grade** — por isso ela "parecia" temporária. Regra do projeto continua valendo:
  antes de espelhar um comportamento, confirme que ele existe.

---

## Reposição parada é passivo — e não aparecia em contador nenhum ✅

Medido em 09/08/2026: **109 reposições abertas, 102 SEM DATA** — a mais antiga de
04/03/2026, cinco meses parada; um único professor acumulava **71**.

Reposição sem data é dívida com o aluno: a aula foi paga (falta dele) ou é obrigação do
professor (falta dele), e ainda não aconteceu. Sem data ela **não aparece** em "Lançar Aula"
nem em "Pendentes" — só na aba Reposições, que ninguém abre sem motivo. Por isso o passivo
cresceu em silêncio: `director_pending_counts` media acolhimento, presença, materiais,
experimentais, fechamentos e reconciliação, e **ignorava reposição por completo**.

- **Duas contagens, porque pedem ações opostas:** `reposicoes` (falta agendar) e
  `reposicoes_vencidas` (a data passou e ninguém lançou).
- ⚠️ A aba `reschedules` só existia no menu do professor. Sem entrar em `ADMIN_NAV`, o link
  da Central de Pendências cairia na allowlist do `renderContent` e voltaria ao dashboard —
  a mesma pegadinha já documentada em `allowedAdminTabs`.

---

## Planner de Aula com IA (LessonPlannerAI) ✅

> Antes era um **template estático** (não chamava IA). Agora usa IA real via edge `lesson-planner`.

- Edge `lesson-planner` (OpenRouter, Gemini free + fallback) monta plano PERSONALIZADO juntando: perfil (nível/CEFR, personalidade, KIDS, interesses, objetivos), **pontos fracos recorrentes** (`wolfie_corrections.error_type` das sessões do aluno), **histórico** (`class_logs` últimas 5 — continuidade), plano anterior (`lesson_plans`), e **materiais APROVADOS** do tenant (sugere só desses). Retorna `{objectives, content, materials, ai_memory_reflection, weak_points}` — o `content` traz seções com tempos (aquecimento/principal/prática/lição/evitar/continuidade).
- `LessonPlannerAI.handleGeneratePlan` chama `supabase.functions.invoke('lesson-planner', { student_id, custom_prompt })` (não mais template). Salva em `lesson_plans` (memória p/ continuidade).
- Guardrails: só sugere materiais da lista fornecida; usa dados reais (anti-genérico). Auth: TEACHER/admin.

### Cartão do aluno — o professor escreve, a IA não inventa (migration `20260926220000`)

Objetivo real, temas que engajam, estilo de correção (`immediate|end|selective|examiner`, o
mesmo vocabulário de `wolf_intelligence.preferred_correction_mode`), o que evitar e
observações. Tabela própria **`public.student_learning_cards`** (PK `tenant_id, student_id`) —
**não é coluna de `profiles`** (e `correction_preference` continua não sendo).

- **Escrita só por `save_student_learning_card`** (SECURITY DEFINER): quem lê o dossiê
  (`private.can_read_student_pedagogy`) **e** tem papel TEACHER/COORDINATOR/SCHOOL_ADMIN.
  SUPER_ADMIN não escreve. `p_expected_version` recusa sobrescrever o que outra pessoa
  salvou (`cartao_alterado_por_outra_pessoa`). `service_role` só lê (o Planner).
- **Limites no servidor** (`private.student_learning_card_limits()`: objetivo 300, 8 temas,
  6 "evitar", 60 por item, notas 400) — texto longo é **recusado**, não cortado. A tela
  avisa ao lado do formulário: nada de saúde, religião, política, família ou dinheiro.
- **Menor de idade** (`is_kids` ou nascido há < 18 anos, régua do termo de registro): só
  objetivo e temas. O gatilho `trg_student_learning_cards_guard` recusa o resto para
  QUALQUER escritor; se o aluno "vira" menor depois, a leitura esconde os campos pessoais
  (`hidden_for_minor`) e o próximo salvamento os apaga.
- **Histórico** (`private.student_learning_card_events`): quem, quando, papel e QUAIS campos —
  **nunca o texto**. A confirmação de leitura do dossiê (`student_handover_reads`) guarda só
  `learning_card_version`, pelo mesmo motivo.
- **Tela:** aba "Continuidade pedagógica" da ficha (`StudentHandover` → `StudentLearningCard`,
  regras espelhadas em `lib/studentLearningCard.ts`). O cartão chega por
  `get_student_handover` → `learning_card`.
- **Planner:** `lesson-planner/teacher-card.ts` — campo preenchido no cartão **substitui** o
  inferido (objetivo, temas, evitar, estilo); vazio cai no Wolfie/`profiles`. Falha ao ler o
  cartão não derruba o plano. `student_profile.teacher_reviewed_fields` diz o que veio do
  professor.
- Teste: `supabase/tests/cartao_do_aluno_pelo_professor.sql` (acesso, menor, limites,
  versão, histórico sem texto) e `lesson-planner/teacher-card.test.ts`.

---

## Convenções do Projeto

- TypeScript estrito (sem `any`)
- Comentários em português
- **Dados sensíveis da Wise Wolf** (CNPJ, email, telefone, endereço) **NUNCA no código** — apenas em variáveis de ambiente ou formulários preenchidos pelo usuário

### Deploy — caminho real (VPS, não Vercel/Supabase cloud)

❌ **Não existe** deploy automático por push, nem `supabase functions deploy`,
nem MCP da Supabase. Nada disso chega na produção.

✅ **Release completo:** `deploy/vps/release.sh` — roda `npm run typecheck`,
`deno test` e `deno check`, builda o frontend, faz `rsync` para
`/opt/wisewolf/releases/<timestamp>-<commit>/`, **aplica as migrations**,
promove e roda smoke test.

⚠️ **O release NÃO roda `npm ci`** — builda o site com o `node_modules` da pasta de onde
roda. Em 26/09/2026 a pasta principal tinha 20 pacotes fora do lock (`@supabase/supabase-js`
2.112 contra 2.89, React 19.2.8 contra 19.2.3): publicar dali trocaria dependência em
produção sem ninguém decidir. **Rode `npm ci` antes do deploy.** Prova de que o site no ar é
de um commit: `npm ci` + build dele com as mesmas `VITE_*` → os 472 arquivos batem byte a byte
com `release-inputs.sha256`.

⚠️ **O release APLICA MIGRATION, sim** (corrigido em 04/08/2026 — este arquivo
afirmava o contrário e o erro custou um deploy quebrado). Ele percorre
`MIGRATION_RELATIVES` e roda a lista **inteira a cada deploy**, dentro da
transação dele. Duas consequências que não são opcionais:

- **Nada de `begin;`/`commit;` dentro da migration.** Um `commit;` fecha a
  transação do release no meio do caminho.
- **Toda migration tem de ser RE-EXECUTÁVEL**, porque ela roda de novo em todo
  release. `create policy` exige o `drop policy if exists` antes (foi
  exatamente `policy "reschedules_select" already exists` que derrubou o
  deploy); use `create or replace`, `if not exists`, `on conflict do update`.
  Teste aplicando a migration **duas vezes seguidas** num `BEGIN … ROLLBACK`
  contra a VPS antes de commitar.

⚠️ **Três listas explícitas no `release.sh`; arquivo fora delas não sai daqui.**
Já mordeu duas vezes no mesmo dia:

| Lista | O que registra | Sintoma quando esquece |
|---|---|---|
| `MIGRATION_RELATIVES` | migrations aplicadas/enviadas | banco fica sem o objeto, ou o pacote de restauração fica incompleto |
| `HARDENED_FUNCTIONS` (literal **1×**; o script remoto lê `hardened-functions.txt`) | pastas de edge function | "Deploy concluído" e o diretório **nem existe** na VPS |
| lista do `deno check` | type-check das functions | função nova sobe sem validação |

**Arquivo novo dentro de uma function que JÁ está na lista** vai junto sozinho
(o `rsync -a` copia a pasta inteira). **Function nova, não** — precisa entrar em
`HARDENED_FUNCTIONS`.

⚠️ **Arquivo novo em `_shared` precisa de CINCO registros, não de um.**
Descoberto em 13/08/2026 ao criar `_shared/lead-contact.ts`: o `_shared` **não**
segue o rsync de pasta das functions — cada arquivo tem um ritual próprio,
espalhado pelo script. Faltando o quinto, o deploy publica o pacote, o worker
sobe com `Module not found` e o smoke test derruba a release inteira (a produção
volta sozinha para a anterior — foi o que aconteceu).

| Ponto | Onde | O que faz |
|---|---|---|
| `SHARED_*_RELATIVE=` | junto das outras declarações | nomeia o arquivo |
| `[[ -s "$SHARED_*" ]] \|\| die` | bloco de guardas | recusa deploy sem o arquivo |
| `rsync -a -- "$SHARED_*"` | envio para `remote_release` | põe no pacote da release |
| `[[ -s "$release_dir/functions/_shared/<arq>" ]]` | asserções do pacote | confere que chegou |
| `cp -a -- "$release_dir/..." "$functions_dir/_shared/<arq>"` + flag `*_shared_swapped` e o bloco de rollback | promoção | **é o que coloca o arquivo no ar** |

Espelhe um arquivo existente (`wolfie-product-access.ts` é o mais recente) com
`grep -n "wolfie-product-access\|wolfie_product_access" deploy/vps/release.sh`
antes de criar qualquer coisa em `_shared`.

⚠️ **Function ANTIGA também pode estar fora das listas.** Não é problema só de
arquivo novo: em 09/08/2026, `search-slots` e `sync-payments` — as duas em
produção há meses — não estavam em lista nenhuma. Corrigi-las localmente não
teria efeito nenhum no ar. Antes de editar uma function, confira:
`grep -c "<nome>" deploy/vps/release.sh`.

⚠️ **`if (!auth.ok)` NÃO estreita o tipo** no TypeScript que o Deno usa aqui,
apesar de `RequestAuthResult` ser união discriminada. O `deno check` morre com
«Property 'response' does not exist on type 'RequestAuthResult'». Use sempre
**`if (auth.ok === false) return auth.response`**. Sete funções carregavam esse
erro e, por causa dele, estavam **fora do `deno check`** — subiam para produção
sem validação nenhuma (`sync-payments`, `whatsapp-hr-welcome`,
`generate-student-insights`, `send-rejection-email`, `register-user`,
`reconcile-ledger`, `whatsapp-notificacao-wise`). Corrigidas e inscritas em
09/08/2026. Quando o type-check de uma function reclamar, **conserte a function**
— tirá-la da lista é o que criou o buraco.

### Duas travas contra publicar às cegas (12/08/2026)

**1. A VPS pode estar À FRENTE do repositório.** O release copia as functions por
cima do que está no servidor. `send-attendance-confirmations` tinha, na VPS, 38
linhas que o repositório não tinha — a revalidação anti-fantasma do antifraude de
presença, aplicada por `scp` e nunca commitada. Publicar sem olhar teria apagado
a proteção em silêncio.

`deploy/vps/lib/function-drift-guard.sh` não compara repositório com VPS (isso
acusaria toda publicação legítima) — compara a **VPS com o que o último release
publicou**, num manifesto em `/opt/wisewolf/releases/.published-functions.md5`:

    VPS == manifesto  → ninguém mexeu por fora; pode sobrescrever
    VPS != manifesto  → alguém mexeu. PARA e diz quais

Hash por pasta inteira (`find | sort | md5sum`), então arquivo novo e apagado
contam. Escape: `DEPLOY_ALLOW_FUNCTION_DRIFT=1`, depois de trazer o hotfix para o
repositório — ou quando a intenção é mesmo descartá-lo.

⚠️ **Antes de inscrever uma function antiga em `HARDENED_FUNCTIONS`, compare com
a VPS.** Foi assim que o hotfix perdido apareceu.

**2. A árvore pode mudar DURANTE o release.** `assert_release_tree_is_publishable`
roda uma vez, no começo; o pacote é lido minutos depois (install, typecheck,
testes, build). Nessa janela alguém pode salvar arquivo no mesmo checkout.

Aconteceu: árvore aprovada às 23:05, um colega salvou 248 linhas de feature em
andamento às ~23:07, e o release de 23:09 **empacotou trabalho não commitado** —
commitado só dez minutos depois. A publicação não sabia o que estava levando.

`assert_release_tree_unchanged` reconfere imediatamente antes de empacotar, e
exige que o **HEAD seja o mesmo**: trocar de commit no meio invalida tudo que já
foi verificado.

⚠️ **Consequência prática:** com mais de uma pessoa (ou agente) no mesmo
checkout, o release falha em vez de publicar um Frankenstein. Se falhar assim,
não force — combine quem publica.

### O release abre ~90 conexões SSH — e o servidor corta na 11ª

A etapa de preparação dispara um `rsync` por function, por migration e por teste.
Sem multiplexação são ~90 handshakes, e o deploy morre com
`ssh: connect to host ... Operation timed out` **antes de publicar qualquer
coisa** (falhou 4× seguidas em 09/08/2026). Medido: 1 falha em 60 conexões
soltas, 0 em 60 multiplexadas.

A multiplexação vive **dentro do `release.sh`** (função de shell `ssh` +
`RSYNC_RSH`, que o openrsync do macOS honra), e **não** no `~/.ssh/config` de
quem publica — o release tem de funcionar em máquina recém-clonada.

⚠️ **Não acrescente um `trap … EXIT` novo.** Já existe um (`cleanup`, no topo) e
um segundo **substitui** o primeiro em vez de somar: o diretório de stage ficaria
para trás e as variáveis `VITE_*` vazariam para o shell de quem publicou. O
fechamento do socket entra **dentro** do `cleanup` existente.

⚠️ **"Deploy concluído" não é prova.** Confira no servidor o que era o objetivo
do deploy: `ls` da pasta da function, `grep` do trecho no bundle minificado
(nomes de função são minificados — grep por *string literal* ou nome de
propriedade), `psql` para o objeto de banco. E o release **restaura sozinho** o
frontend e as functions anteriores quando falha no meio: se algo quebrar, a
produção continua na release anterior, não pela metade.

🔒 **Trava de árvore** (`deploy/vps/lib/release-preflight.sh`, commit `d36c84f`):
antes de qualquer contato com a VPS, o release recusa **árvore suja** (inclusive
arquivo não rastreado), **branch ≠ `DEPLOY_GIT_BRANCH`** (declarada no
`.env.deploy.local`), **HEAD atrás de `origin/<branch>`** e **HEAD sem
`origin/main`** — e imprime checkout, branch e commit antes de publicar. Existe
porque já publicamos árvore antiga (o frontend voltou no tempo e travou o
lançamento de aulas por ~23h) e trabalho não commitado que estava no checkout
por acaso. Consequência: **deployar de worktree acabou** (o Git não deixa a mesma
branch em dois checkouts) — se o checkout principal estiver sujo, commite ou
descarte, porque era esse WIP que vazava. Emergência consciente:
`DEPLOY_ALLOW_DIRTY=1`.

✅ **Hotfix de uma edge function** (sem subir frontend — útil quando a árvore
tem mudanças de outras frentes que não podem ir junto):

```bash
scp supabase/functions/<fn>/*.ts \
  wisewolf-vps:/opt/wisewolf/supabase-docker/volumes/functions/<fn>/
ssh wisewolf-vps 'docker restart supabase-edge-functions'
```

Faça backup antes (`cp -a` do diretório em `/opt/wisewolf/backup-<fn>-<data>`).

**Segredos:** vivem só em `/opt/wisewolf/supabase-docker/.env` (600, root) — os das edge
functions (OpenRouter, Evolution, Resend, Asaas, Gamma…) em **`.env.functions`**, que o
`docker-compose.override.yml` injeta por `env_file` (mudou o arquivo → recriar o container
das functions, `docker compose up -d functions`) —
nunca no Git nem no chat. Testes que precisam de chave (OpenAI etc.) devem rodar
**dentro da VPS**, lendo do `.env`, para a chave não entrar no contexto.

**Diagnóstico:** `ssh wisewolf-vps 'docker logs --timestamps
supabase-edge-functions --since 30m'`.

### O edge-runtime matava metade dos pedidos (16/09/2026) ✅

`supabase/functions/main/index.ts` criava workers com 150 MB / 60 s e a política padrão
`per_worker` **reaproveita o isolate de cada function até o relógio de parede vencer** —
o pedido que estivesse em voo naquele segundo morria com `early termination has been
triggered`. Medido: **9.270 terminações em 19.129 pedidos/24 h**; o grupo da Gestão ficou
sem resposta às 19:53 porque o worker do `whatsapp-inbound` venceu 7 s depois de a
mensagem chegar. Hoje: `--policy per_request` no `docker-compose.yml` (um worker por
pedido, relógio próprio), 512 MB e 150 s. Duas horas depois: 0 terminações; CPU do
container caiu de 150% para <1% (era o custo de matar e recriar workers o dia inteiro).
⚠️ **O `release.sh` NÃO publica `main/index.ts` nem o `docker-compose.yml`** — os dois
foram copiados na mão (`scp` + `docker compose up -d functions`); backup em
`/opt/wisewolf/backups/edge-runtime-20260916T231602Z`. Se mexer neles, repita o ritual.
 Banco: `docker exec supabase-db psql -U
postgres`. Compare o horário do erro com
`docker inspect -f '{{.State.StartedAt}}' supabase-edge-functions` antes de
concluir que um erro é posterior ao deploy.


---

## Geração de Conteúdo Pedagógico com IA (`pedagogical-content`) ✅

> **Por que existe uma edge function separada do `wolfie-brain` só pra gerar JSON.** O `wolfie-brain` é o **tutor conversacional**: o system prompt dele força TODA resposta no schema da persona WOLFIE (`{chatResponse, correction, ...}`). Qualquer pedido de JSON estruturado (ex.: `{cards}`, `{questions}`, um array de atividades) era embrulhado nesse schema → o client recebia o objeto da persona, não o conteúdo pedido, e quebrava com `"AI did not return valid JSON"`. Não use o `wolfie-brain` para gerar material.

- **Edge `pedagogical-content`** (`supabase/functions/pedagogical-content/index.ts`): gerador de **JSON estrito, sem persona**. System prompt é literalmente "strict JSON content generator" (CEFR-aligned, alunos pt-BR) — exige saída crua começando com `{` ou `[`, sem markdown, sem fences, sem comentário, sem chaves extras. Explicações pedagógicas em pt-BR (`exp`, `explanation_pt`, `translation`, `rule_pt`, `instructions_pt`); conteúdo de inglês em inglês natural no nível pedido.
- **Lida com objeto OU array**: `extractJson()` decide pelo delimitador que aparece primeiro (`{` vs `[`), remove fences ```` ```json ````, e recorta só o bloco JSON. Cada modelo da cadeia ainda passa por `JSON.parse()` de validação antes de ser aceito — JSON inválido derruba pro próximo modelo.
- **Mesma cadeia de modelos do `wolfie-brain`** (OpenRouter, `PREFERRED_MODELS`): Claude Haiku 3.5 primeiro (JSON confiável), depois Haiku 3, Gemini 2.0 Flash free, GPT-4o-mini, Gemini Flash 1.5, Llama 3.3 70B free, DeepSeek, GPT-OSS — pagos e gratuitos pra nunca deixar o professor sem conteúdo. `401` (chave inválida) aborta na hora; outros erros caem pro próximo. `temperature: 0.6`, `max_tokens: 2000`, timeout 25s por modelo.
- **Retorno:** `{ result, raw, aiText }` — `result` é o JSON **já parseado** (server faz `JSON.parse(raw)`; fica `null` se falhar), `raw`/`aiText` é o texto limpo como fallback. Exige usuário autenticado (professor/admin chamam pelo painel).
- **Como o client consome** (`services/geminiService.ts`): usa `data.result` direto quando já vem parseado (objeto em `generateUnitActivityContent`, array em `generateActivities`); só cai no `data.raw`/`data.aiText` + regex (`/\{[\s\S]*\}/` ou `/\[[\s\S]*\]/`) + `JSON.parse` quando `result` veio `null`.
- **Quem usa:** `generateUnitActivityContent` → flashcards (`vocab_cards`), `quiz`, `grammar_drill`, `reading` e `speaking_wolfie` da trilha (LearningPathsBuilder), cada tipo com seu schema EXATO no prompt; `generateActivities` → 4 atividades complementares personalizadas (StudentActivities), com `getFallbackActivities()` local como rede de segurança se a IA falhar.
- ⚠️ **Pegadinha:** `getPedagogicalSuggestion` e `generateBillingReminder` continuam em outro caminho (wolfie-brain / Gemini direto) porque são **texto livre**, não JSON estruturado — só material estruturado vai pelo `pedagogical-content`.

---

## Status do Aluno (Ativo/Inativo) e Gating de Notificações ✅

> **Problema:** aluno inativo (sem professor / sem aulas) continuava recebendo WhatsApp automático (aniversário, lembrete de vencimento). O diretor quer **MANTER todos os dados** do aluno, só **parar de notificá-lo**, e poder **reativar depois**. Migration: `supabase/migrations/20260615120000_student_status_notifications.sql`.

- **Fonte de verdade:** `profiles.status` (default `'Ativo'`). O diretor alterna; `status_financial = 'ARCHIVED'` (do `archive_student`) também silencia.
- **`is_student_notifiable(uuid)`** — helper canônico (SQL STABLE SECURITY DEFINER): o aluno pode receber mensagem automática? `status NOT IN ('Inativo','INACTIVE','Inactive','Arquivado','Cancelado','Trancado')` **E** `status_financial <> 'ARCHIVED'`. Use este helper em qualquer automação nova em vez de repetir a lista.
- **`set_student_status(uuid, text)`** — RPC SECURITY DEFINER que o diretor chama pra alternar. Só `SCHOOL_ADMIN`/`SUPER_ADMIN`/`COORDINATOR`, e admin/coordenador **só dentro do próprio tenant** (`s_tenant <> v_tenant` → `sem_permissao`). Normaliza entrada (`ativo`/`active` → `'Ativo'`, `inativo`/`inactive` → `'Inativo'`). **INATIVAR MANTÉM TODOS OS DADOS** — é só um `UPDATE profiles SET status` — desliga as notificações e pode reativar a qualquer momento. `GRANT EXECUTE ... TO authenticated`.
- **Automações que respeitam o status:**
  - `birthdays_today()` — professores sempre entram; **alunos só quando notificáveis** (mesma cláusula do helper inline no `WHERE`).
  - `notify-payment-due` (`supabase/functions/notify-payment-due/index.ts`) — lê `status`/`status_financial` do aluno e, se inativo/arquivado, **pula sem marcar `due_reminder_sent_at`** (`continue` antes do `mark()`). Crítico: ao reativar, a cobrança volta a ser avisada (não ficou "queimada" como enviada).
- **UI do diretor** (`components/StudentsList.tsx`):
  - **Filtro** "Status: todos / Ativos / Inativos" (`statusFilter`, ao lado do filtro de Situação).
  - **`isInactive(s)`** = `status` na lista de inativos OU `status_financial === 'ARCHIVED'`.
  - **Badge cinza** `UserX · "INATIVO · SEM NOTIFICAÇÕES"` no card; o card inteiro fica **esmaecido** (`opacity-60 grayscale`, borda slate).
  - **Botão por aluno** (`handleToggleStatus`): `UserX` (inativar, âmbar) ↔ `UserCheck` (reativar, esmeralda), com `window.confirm` explicando que os dados são mantidos. Chama `set_student_status` e atualiza o estado local otimista.
- ⚠️ **Pegadinha:** o gating só silencia valores **explicitamente inativos** (`Inativo` / `INACTIVE` / `Inactive` / `Arquivado` / `Cancelado` / `Trancado`) ou `status_financial='ARCHIVED'`. **Nunca** silencia `'Ativo'` / `'ACTIVE'` / `null` — em produção só existem `'Ativo'` e `'ACTIVE'` (ambos ativos), então o default é "notifica". Ao adicionar uma automação nova, prefira `is_student_notifiable(uuid)` em vez de reescrever a lista (evita drift).

---

## Auditoria Determinística do Gabarito (`answer-key-audit`) ✅

> **Bug real (03/08/2026):** o quiz marcou **"am / like / am"** como resposta correta em
> *"Hi! My name ___ Ana. I ___ sports. ... I ___ from Curitiba."*, produzindo **"My name am Ana"** —
> e a própria explicação dizia `'My name is' usa 'is'`. Um aluno viu a plataforma validar um erro
> de gramática básica. **Prioridade máxima: credibilidade pedagógica.**

**Causa raiz:** `correctIndex` é **autoral do modelo**. A edge `wolfie-activity` pedia
`{prompt, options, correctIndex, explanationPt}` ao OpenRouter e gravava o gabarito em
`wolfie_activity_keys.answer_key` **sem nenhuma verificação**. Não era bug de embaralhamento nem
de mapeamento — era o modelo apontando o índice errado, com explicação certa ao lado.

**Regra de ouro: a IA PROPÕE, o código VETA.**

- **`supabase/functions/wolfie-activity/answer-key-audit.ts`** — auditoria determinística, sem modelo:
  - **Regra 1 — concordância de classe fechada.** Preenche as lacunas com CADA alternativa e checa
    pronome + cópula/auxiliar (`I am` / `he is` / `they are` / `she has` / `I do`…). Inclui a regra
    universal: **só o pronome `I` licencia `am`** — é o que reprova `My name am Ana`. Rejeita quando
    o gabarito viola E outra alternativa é limpa.
  - **Regra 2 — explicação × gabarito.** Extrai trechos entre aspas da `explanationPt` e compara o
    par (sujeito, verbo) com o que o gabarito produz. `'My name is'` + gabarito `name am` = incoerência.
    Guarda contra contraexemplo: só considera citação que já é gramatical (não dispara em "nunca diga 'he have'").
  - **Nunca "corrige" o índice.** Reprovou → a questão sai de circulação. Adivinhar gabarito seria o mesmo erro.
  - **Só rejeita com CERTEZA.** Fora do alcance das regras → `unknown` → segue o fluxo. Falso negativo é aceitável;
    falso positivo só desperdiça geração. Cada regra tem guarda: sujeito coordenado (`Ana and I are`),
    inversão (`Does he have`), subjuntivo (`If I were you`), `9 am` (horário), WH-word.

**Duas barreiras (as duas necessárias):**
1. **Geração** — `normalizeQuestions` audita cada questão; reprovada sai com `correctIndex = -1` e é
   descartada. Se sobrarem <6 questões, `normalizeGeneratedActivity` cai no **banco curado**
   (`buildContextualFallback`, em `personalization.ts`). ⚠️ Por isso o teste
   `"nenhuma questão do banco curado é reprovada"` é obrigatório: se a auditoria reprovasse o próprio
   fallback, `normalizeGeneratedActivity` recursionaria infinitamente.
2. **Conferência** — `handleCheckAnswer` re-audita o gabarito **lido do banco**. Sessões criadas ANTES
   dessa mudança têm gabarito não verificado; ali o servidor devolve `ANSWER_KEY_INVALID` (503) em vez
   de ensinar errado. Mensagem pt-BR em `src/services/wolfieActivityService.ts`.

**Bug latente corrigido junto:** `normalizeQuestions` usava `boundedStringArray()` (que **descarta**
itens vazios/não-string) e só depois lia `rawOptions[correctIndex]` — uma opção vazia vinda do modelo
**deslocava o gabarito em silêncio**. Agora a normalização preserva as posições e só filtra depois de
capturar a alternativa correta.

**O que a auditoria NÃO faz:** não prova que o gabarito está certo, só que não viola regra decidível.
Semântica, vocabulário e tempo verbal continuam por conta do modelo — por isso `q4`/`q5` de gramática
básica (`is/are/am`) são o alvo, que é onde dói na credibilidade.

**Observabilidade:** log `[wolfie-activity] gabarito reprovado na auditoria` (geração) e
`gabarito armazenado reprovado` (conferência). Grepar isso nos logs da edge mede a taxa real de erro do modelo.

**Testes:** `supabase/functions/wolfie-activity/answer-key-audit.test.ts` (12 casos, inclui o print da aluna
como regressão). Registrado em `deploy/vps/release.sh` e `release-wolfie.sh`.
⚠️ `fallbackQuiz()` em `index.ts` é **código morto** (nunca chamado) — o fallback real é
`buildContextualFallback` de `personalization.ts`. Não confie no primeiro ao mexer no banco curado.
---

## DRE Gerencial — resultado por competência ✅

> **Leia antes de mexer em `get_cashflow`, `financial_transactions` ou qualquer coisa que "lance despesa".**

**O problema que originou:** o caixa tinha **159 lançamentos, todos `ENTRADA`**. Zero saída. Nem repasse a professor, nem ferramentas, nem impostos. Sem o lado do custo não existe resultado — só faturamento.

**A armadilha que quase foi cometida:** "lançar o repasse a professores como SAÍDA no caixa". Isso **dobraria** a conta — `get_cashflow` já soma o repasse direto de `teacher_closings`. É o mesmo bug que `20260612210100_fix_cashflow_double_count.sql` matou do lado da receita.

**O problema real era REGIME, não lançamento faltando.** `get_cashflow` só reconhece o custo quando o fechamento vira `PAGO`. Julho/2026 tem R$ 2.150,00 de custo real e reporta R$ 0,00 lá; no histórico só R$ 3.519,50 de R$ 7.799,50 em fechamentos chegaram a PAGO — **55% do custo com professor nunca entrou em relatório nenhum.**

### Os dois regimes convivem, cada um no seu caminho
| Função | Pergunta que responde | Custo do professor |
|---|---|---|
| `get_cashflow(mes)` | quanto dinheiro entrou e saiu | quando o fechamento é **PAGO** |
| `dre_gerencial(mes, tenant)` | qual foi o **resultado** do mês | no mês em que a **aula aconteceu** |

`get_cashflow` foi **versionado em migration** (`20260802120000`) — vivia só no banco, mesmo drift do catálogo de nichos. Captura fiel, nada mudou de comportamento.

### Plano de contas (`dre_accounts`, global) + mapa por escola (`dre_category_map`)
- **`ledger_allowed = false`** é a trava contra dupla contagem: conta alimentada por competência (repasse 5.1.01, ajustes 5.1.02, comissões 6.1.01, indicações 6.1.02) **não aceita** lançamento do caixa. Saída que caia numa dessas é **ignorada no resultado** e vira alerta. `set_dre_category_account` e `upsert_recurring_expense` **recusam** essas contas na origem.
- **Precedência da classificação:** `financial_transactions.account_code` (lançamento sabe sua conta) → `dre_category_map` (categoria em texto livre, legado) → `6.9.99 Outras despesas`.
- ⚠️ Categoria sem mapa **nunca some** do resultado — cai em Outras despesas. Despesa esquecida infla o lucro.
- `financial_transactions.category` nasceu com duas eras para a mesma coisa (`student_tuition` 83× e `MENSALIDADE` 76×). O mapa reconcilia **sem reescrever dado histórico**.
- As linhas do DRE são agregadas **por conta**, não por natureza — senão classificar marketing, ferramentas e contabilidade continuaria mostrando um total único e o plano de contas não serviria para nada.

### Despesas recorrentes (`recurring_expenses`)
- É **molde, não saldo**. `run_recurring_expenses(mes)` materializa como SAÍDA no caixa — aí caixa e DRE veem a mesma despesa, cada um no seu regime, e o diretor corrige o mês em que o valor real veio diferente sem mexer no molde.
- Idempotência por **índice único** `(recurring_expense_id, recurring_month)`, não por `NOT EXISTS` — dois cliques simultâneos perderiam a corrida.
- ⚠️ O índice é **parcial** → o `ON CONFLICT` precisa repetir o predicado (`WHERE recurring_expense_id IS NOT NULL`), senão dá "no unique or exclusion constraint matching". Mesma pedra de `uq_bookings_no_dup_active`.
- `day_of_month` limitado a **28**: dia 29–31 não existe em todo mês.
- Cron `wisewolf-recurring-expenses` (dia 1, 06:10 UTC), antes do fechamento do professor.

### Categorizador por IA (`dre-categorize`)
- **Sugere, não grava.** O mapa decide como o resultado é lido; classificação errada gravada em silêncio é pior que sugestão recusada. O diretor aplica via `set_dre_category_account`.
- Toda sugestão é validada contra o plano antes de sair da edge — código inventado pela IA é descartado. Categoria não classificada continua pendente e o retorno diz quantas (`nao_classificadas`).
- Categoria e descrição são texto escrito por humanos no caixa = **entrada não confiável**: vão dentro de `<dados_do_caixa>` e o system prompt manda ignorar instruções que apareçam ali.

### Relatório no WhatsApp (`dre-report`)
- **Nasce desligado** (`dre_report_settings.is_active` default false, tabela vazia). Nada é enviado até o diretor configurar destino e cadência.
- **Um cron diário só** (`wisewolf-dre-report`, 11:20 UTC); quem decide "hoje envia?" é `dre_report_targets`, lendo a cadência da escola. Trocar semanal→mensal é UPDATE, não novo agendamento.
- Datas resolvidas em **America/Sao_Paulo** — o cron roda em UTC, mas "dia 1" e "segunda-feira" são do calendário do diretor.
- ⚠️ `authorizeAutomation` garante que é o cron OU um admin — **não diz qual admin**. O `tenant` do envio manual vem SEMPRE do perfil de quem chamou (exceto SUPER_ADMIN); confiar no corpo da requisição deixaria um diretor disparar no grupo de outra escola.
- Dedupe por `automation_sent` (`kind=DRE_REPORT`); envio manual usa `subject_id = <tenant>:manual` para não ser bloqueado pelo automático do mesmo dia.

**Arquivos:** `components/DreGerencialPanel.tsx` (menu Financeiro → "Resultado (DRE)"), `DreCategorizer.tsx`, `RecurringExpensesManager.tsx`, `DreReportSettings.tsx`; edges `dre-categorize`, `dre-report`. Migrations `20260802120000` a `20260802160000`.

⚠️ **Se um dia a escola quiser um ledger clássico com toda movimentação postada**, é `dre_gerencial` que define o que postar — mas aí `get_cashflow` tem de parar de ler `teacher_closings` **no mesmo commit**, senão dobra.

---

## Aula que reaparece para lançar, e o dinheiro que não bate entre telas ✅

> **Leia antes de mexer em `LessonLauncher`, `lib/pendingLessons.ts` ou em qualquer
> tela que mostre "quanto ganhei" / "quantos alunos tenho".**

**O relato (Flávio, 13/08/2026):** aulas do mês passado que ele já tinha lançado
voltaram para a tela de lançamento; o Financeiro dizia R$ 301,00 e o Dashboard
R$ 304,00; o perfil mostrava 11 alunos e ele tem 10.

### 1. A aula é (agendamento + data) — nunca só o agendamento
O `LessonLauncher` usava `b.id` como id do item. Dentro da janela de 45 dias o
MESMO agendamento semanal vira ~6 itens com o **mesmo id**: o React repete a
chave, o formulário sobrescreve os campos e o `find` do envio pega sempre o
primeiro. Medido: **78 itens na tela para 21 agendamentos** — ele preenchia 6
aulas e só 1 era lançada, as outras 5 voltavam. Hoje o ref é
`<booking>|<YYYY-MM-DD>` (`lessonRef`).

### 2. Agendamento trocado deixava a aula lançada voltar
O casamento era só por `booking_id`. Quando o aluno muda de horário, a escola
cria um agendamento novo e o antigo costuma ser **apagado** — o `class_logs`
continua apontando para o que não existe mais (na conta do Flávio: 8 logs de
julho, 40 de junho). A tela lia "nunca lançada" e reoferecia.

⚠️ **Relançar não é inofensivo:** a trava do servidor é `(booking_id, class_date)`
e **não barra agendamentos diferentes** — de propósito, porque aula de 1h partida
(16:30 + 17:00) são dois agendamentos legítimos que pagam os dois. Ou seja, a
tela deixava a mesma aula ser paga duas vezes.

A regra vive em **`lib/lessonMatching.ts`** (com teste) e consome os lançamentos
do dia em duas passadas — pela origem, depois pelo aluno. `some()` **não serve**:
sem consumir, um único log esconde as duas metades de uma aula de 1h e o
professor deixa de lançar (e de receber) a outra. Era esse o defeito espelhado em
`pendingLessons.ts`, corrigido junto.

⚠️ Só log de aula REGULAR entra na conta: reposição e experimental do mesmo aluno
no mesmo dia são **outra** aula.

### 3. Matrícula que ainda não começou não é aula a lançar
Aula anterior ao `start_date` do agendamento entrava na lista uma vez **por dia
da janela** — 72 linhas, 14 do mesmo aluno. Agora é **uma linha por
agendamento** no bloco "Ainda não começaram" (o professor precisa saber que o
aluno existe; não precisa ver 14 vezes).

Resultado no Flávio: **78 itens → 6**, e os 6 são aulas que ele de fato não
lançou (Victor Hugo, quarta 16:30, desde 08/07).

### 4. Uma conta só para aluno e para dinheiro
`aulas × hourly_rate` calculado no navegador ignora a faixa por antiguidade,
ignora override do diretor e conta aula que não paga (perfil não faturável,
experimental sem comparecimento, duplicata). Havia **três respostas** para a
mesma pergunta — Dashboard R$ 392,00 · ficha do diretor R$ 368,00 · Financeiro
R$ 375,50 — e o print do professor (R$ 304 x R$ 301) foi reproduzido exatamente.
`TeacherDashboard`, `get_teacher_overview` e `list_teachers_overview` passaram a
ler `v_payable_class_logs` / `teacher_pay_projection`.

⚠️ **Sem resposta do servidor a tela mostra "—"**, nunca um número estimado.

O "11 alunos" era o perfil **TREINAMENTO** (offboarded, não faturável) com
agendamento ativo. Quem conta é `teacher_carteira` — a mesma que destrava o
turbo. A ficha do diretor ganhou `linked_students` ao lado, para a diferença ser
visível em vez de parecer aluno sumido.

### 4b. ⚠️ `bookings.day_of_week` sem acento = agenda invisível
`sync-student-asaas` gravava `tuesday: "Terca"` e `saturday: "Sabado"` (sem
acento) ao criar a agenda na matrícula. As telas comparam com o nome que o
navegador gera (`Terça`), então **a aula nunca aparecia para lançar** — e o
professor não recebia por ela. Três agravantes:

- `dow_name_to_int` **normaliza acento**, então `teacher_pay_projection`
  CONTAVA no potencial do mês uma aula que a tela não deixava lançar;
- `uq_bookings_no_dup_active` compara texto: `'Terca' <> 'Terça'`, então o índice
  **não via a duplicata** e o horário virava dois agendamentos ativos (Gabriel e
  Milena, achados em 13/08/2026);
- quem tentava consertar pela tela criava o par com cedilha e deixava o antigo
  vivo — foi assim que os dois nasceram.

Corrigido no `dayMap`, e a comparação com o que já existe passou a **ignorar
acento e caixa** (`dayKey`) — senão o agendamento legado em "Terca" não casaria
com o "Terça" novo e a função criaria exatamente a duplicata que ela evita.

Os dois legados viraram `CANCELLED`, **não foram apagados**: um deles tinha aula
lançada apontando para ele, e `DELETE` deixaria o `class_logs` órfão — o defeito
do item 2, criado pelas próprias mãos.

**Como auditar:** `select distinct day_of_week from bookings` — qualquer valor
fora de `Segunda/Terça/Quarta/Quinta/Sexta/Sábado/Domingo` é agenda invisível.

### 5. Texto do turbo: nem valor chumbado, nem regra vencida
- A faixa de **R$ 9,50 (5º ao 9º) foi apagada com a direção em 02/08/2026**
  (`20260802110000_remove_faixa_9_50`) e três telas continuaram prometendo-a por
  11 dias. Agora o texto sai de `teacher_pay_projection.tiers` via
  **`lib/payTiers.ts`** — mexer na tabela muda a tela junto.
- O card dizia "você está há **{days_clean} dias** sem faltar": esse campo deixou
  de existir quando a apuração virou mensal, então a tela mostrava **undefined**.
  Pior — como `days_to_activate` também sumiu, o professor **bloqueado por falta**
  lia "Requisitos completos". Hoje o motivo vem de `blocked_by`.
- ⚠️ **A régua continua sendo MÊS FECHADO** (confirmado pela direção em
  13/08/2026), não "30 dias corridos": zero falta do professor no mês e no
  anterior, e o turbo vale para o mês inteiro ou para nenhuma aula dele. Falta do
  ALUNO não trava; conflito de lançamento trava.

---

## Rateio do pagamento — DUAS réguas, escolhidas por quem deu a aula ✅

> **Leia antes de mexer em `payment_split_breakdown`, no aviso do grupo ou nos percentuais.**

O aviso do pagamento do Felipe (R$ 271,00, 17 aulas com a direção) escancarou a régua única:
quase tudo saía como pró-labore e **R$ 27,10 ficavam na escola**. Decisão da direção em
13/08/2026 — a régua passa a depender de **quem dá a aula**:

| Origem da aula | Dízimo | Investimento | Pró-labore | Fica na escola |
|---|---|---|---|---|
| **Direção** (👑 em `payment_split_owner_teachers`) | 10% | 10% | **80%** | 0% |
| **Professor contratado** | 10% | **70%** | **20%** | 0% |

⚠️ **Ao conferir totais do mês, separe `na_base`.** Pagamento sem aluno vinculado entra na
régua "professor" (não há aula, logo `share = 0`) com o valor cheio e dízimo ZERO. Somar o
líquido dos dois grupos faz o dízimo parecer errado — aconteceu em 13/08/2026: R$ 3.632,95 de
"base" com R$ 120,00 de dízimo, porque R$ 2.433,00 daquilo estava fora da base. A base real
era R$ 1.199,95, e 10% dela é exatamente R$ 120,00.

- **A base é o LÍQUIDO** (pagamento − salário previsto do professor), como sempre foi. Na
  régua do professor os percentuais incidem sobre o que sobra **depois** do salário dele.
- **Aluno partido entre as duas** (existe: Verônica, com Debora e Mateus) tem o líquido
  rateado **por número de aulas**, e cada parte segue a sua régua — mesmo critério do
  balancete.
- ⚠️ **`dizimo_pct`/`investimento_pct` no retorno são EFETIVOS**, não os configurados: num
  pagamento partido, repetir o configurado anunciaria "Dízimo (10%)" ao lado de um valor que
  não é 10% da base mostrada.
- **O aviso tem TRÊS linhas, não quatro** (13/08/2026): dízimo · *investimento que fica na
  escola* · pró-labore. "Investimento" e "fica na escola" eram o mesmo dinheiro em duas
  linhas, e a segunda dava sempre R$ 0,00 na régua do professor — linha zerada em todo aviso
  vira ruído. O percentual dessa linha é calculado **sobre a base real**, não copiado da
  configuração: num pagamento partido entre as duas réguas, nenhum dos percentuais
  configurados descreve o total.
- ⚠️ **A sobra é RESÍDUO** (`líquido − dízimo − investimento − pró-labore`), não um percentual
  próprio: é o que impede centavo de arredondamento de sumir ou de ser inventado.
- ⚠️ **Resíduo negativo existe e é tratado.** As três fatias são arredondadas de forma
  independente e juntas estouram a base por um centavo — agosto/2026 exibia
  "escola: −R$ 0,01". O centavo sai do **pró-labore**, nunca da escola: inflar a parte da
  empresa com arredondamento seria criar dinheiro que não existe.
- **Configurável na tela** (Financeiro → Rateio): a régua do professor tem os três campos
  próprios. `save_payment_split_settings` ganhou 3 parâmetros — a assinatura de 4 argumentos
  foi **derrubada** de propósito, senão o PostgREST teria duas candidatas e recusaria a
  chamada por ambiguidade.
- ⚠️ **O ajuste de dado (`escola_pct = 0`) é ONE-SHOT**, guardado por `schema_one_shots`. A
  migration roda a cada release: sem essa trava, todo deploy desfaria o que o diretor mudasse
  na tela, e ninguém ligaria uma coisa à outra. **Use o mesmo padrão para qualquer UPDATE de
  dado em migration.**
- O relatório do mês (`payment_split_report`) **chama** `payment_split_breakdown` por
  pagamento em vez de repetir a conta — tela e mensagem não podem divergir.
- Testes: `payment-split-notify/message.test.ts` (6 casos, com os números reais das duas
  réguas).

---

## Competência e pagamento completo (vários meses) ✅

> **Leia antes de mexer em `payment_split_breakdown`, na caixinha, em
> `teacher_payroll_reconciliation` ou em qualquer coisa que diga "mês pendente".**
> Migration `20260914100000_competencia_e_pagamento_completo`, teste
> `supabase/tests/competencia_e_pagamento_completo.sql`.

- **Competência = mês do VENCIMENTO** (`private.payment_competencia_of`). A caixinha
  (`professores[].custo`) usa a agenda do mês da fatura; o caixa (`get_cashflow`,
  DRE, "recebido" do relatório) continua pelo mês em que o dinheiro entrou.
  Medido em 14/09/2026: fatura de vencimento 05/08 paga no cartão e creditada em
  08/09 avisou a agenda de setembro (18 aulas, R$ 144); pela competência são 17
  aulas, R$ 136 — exatamente a folha de agosto daquele aluno.
- **Taxa de matrícula não gera caixinha** (`private.payment_is_enrollment_fee`:
  `payment_type = 'ENROLLMENT'` ou descrição "(Taxa de) matrícula"). ⚠️ "Taxa de
  cancelamento" existe na base e NÃO é matrícula.
- **Pagamento completo** vive em `student_payment_allocations` (escrita só por RPC):
  `register_prepayment(pagamento, 1º mês, N, 'MENSAL'|'LEGADO')`,
  `register_external_prepayment` (recebido por fora: só parcelas, sem lançar caixa) e
  `cancel_prepayment` (marca `CANCELLED`, nunca apaga; registrar de novo reaproveita
  as linhas pelo unique `(payment_id, competencia)`).
  - **MENSAL**: 1/N por mês com centavos exatos; o aviso do recebimento rateia só a
    1ª parcela e diz `recebido_total`, `parcela` e `reservado`; a parcela k sai por
    `payment_split_installment` e entra no `payment_split_report` do mês dela.
  - ⚠️ **MENSAL é recusado depois que o aviso do valor cheio saiu** — ratear de novo
    dobraria o dízimo. Aí o registro é **LEGADO** (só cobre os meses).
  - Um mês não é coberto duas vezes: índice único parcial `(student_id, competencia)
    where status = 'ACTIVE'`.
- **Mês coberto não é pendência (D3)**: fechamento mensal (`SETTLED`; com boleto vivo
  no mesmo mês vira `REVIEW` — é cobrança em dobro), régua de cobrança e suspensão
  (`mes_coberto_por_pagamento_completo` em `student_payment_provider_block_reason`,
  DEPOIS das regras do Asaas), `gestao_financial_context`, Fluxo de Caixa
  (`get_cashflow_unchecked` — os dois se espelham de propósito), resumo semanal,
  `alunos_sem_assinatura` e `financial_reconciliation`.
- **Fechamento da caixinha (D2)**: `caixinha_fechamento(mes, tenant)` compara a
  caixinha **AVISADA** (snapshot congelado em `management_payment_notification_outbox`)
  com a folha, por professor contratado: completar/devolver e o motivo por aluno. O
  painel Caixinha × Folha lê a MESMA conta — ele recalculava com a agenda de hoje.
  Motivos novos: `SEM_AVISO` (sem snapshot; recalculado), `PREPAGO_SEM_RESERVA`
  (LEGADO não separou nada no mês) e `AVISO_DE_OUTRO_MES` (aviso da regra antiga, que
  usou a agenda do mês do caixa). Agosto/2026: folha R$ 2.732 × caixinha R$ 1.936
  (R$ 1.600 sem aviso — os avisos de agosto são quase todos anteriores ao outbox).
- ⚠️ **Teste SQL: um SELECT não enxerga o que as funções chamadas por ele gravaram.**
  `cancel_prepayment(...)` e `select count(*)` na mesma asserção falham com a função
  certa (o snapshot é o do início do statement). Grave num statement, confira no
  seguinte.
- ⚠️ `current_setting('request.jwt.claims', true)::json` quebra com claim vazia — `''`
  fica na sessão depois de um `SET LOCAL`. Use `nullif(btrim(...), '')`.
- ⚠️ A regra nova muda o `snapshot_hash` do fechamento mensal (custo por competência e
  chaves novas no caixa). Em 14/09/2026 nenhum fechamento tinha sido enviado; se um
  já tivesse saído, o próximo refresh marcaria `REVIEW`
  (`source_changed_after_monthly_close`).
- **Ainda não feito:** envio do fechamento da caixinha no grupo da Gestão no dia 1º
  (edge + cron), aviso no grupo de cada parcela k, tela para registrar/cancelar
  pagamento completo, cobertura em `list_students_overview`,
  `recompute_student_financial_status…` e `generate_monthly_student_payments`, e
  cancelar no Asaas a cobrança do mês coberto.

---

## Conciliação do caixa Asaas — uma resposta só para "quanto entrou" ✅

> **Leia antes de mexer em `ledger_on_payment_received`, `reconcile-ledger` ou em
> qualquer coisa que datar lançamento.** Conserto de 25/08/2026, cinco releases.

**O problema:** duas telas somavam receita de fontes diferentes e divergiam TODO
mês. Julho: Fluxo de Caixa e DRE diziam R$ 6.840,69; Dashboard e Relatório
Financeiro diziam R$ 9.075,59. A soma do ano quase fechava (−R$ 507,20) porque os
erros se cancelavam — o que engana, porque é o mês que se usa para decidir.

**Causa raiz:** `student_payments.paid_at` estava NULL em **186 de 186**
pagamentos pagos. O webhook grava `payment_date` e nunca `paid_at`, e o trigger
usava `occurred_at = coalesce(NEW.paid_at, now())` — ou seja, sempre `now()`.

### As três regras que não podem divergir

| Onde | Conjunto de status |
|---|---|
| trigger `ledger_on_payment_received` | `RECEIVED` + `RECEIVED_IN_CASH` |
| `get_cashflow` / `dre_gerencial` | `RECEIVED` + `RECEIVED_IN_CASH` |
| edge `reconcile-ledger` | `RECEIVED` + `RECEIVED_IN_CASH` |

⚠️ **`CONFIRMED` está fora de propósito.** Na Asaas é pagamento reconhecido e
ainda não liquidado, e o painel de caixa nunca o contou. Cartão confirmado vira
`RECEIVED` na liquidação e o lançamento nasce ali (medido: 2 dos 4 cartões da base
já fizeram essa transição). Se mexer no conjunto, **mexa nos três lugares** — foi
exatamente essa divergência que sobrou no primeiro conserto e precisou de outro
deploy.

### Regime de data
- `paid_at` virou responsabilidade do **banco** (`trg_student_payment_paid_at`),
  não do webhook: vale para qualquer escritor.
- ⚠️ **Meio-dia, não meia-noite.** O banco roda em UTC e a escola pensa em BRT;
  meia-noite UTC é 21:00 do dia anterior em Brasília, e um pagamento do dia 1º
  trocaria de mês em qualquer leitura com fuso local.
- A cadeia de competência é `coalesce(paid_at, payment_date, due_date)` nos três
  lugares. `now()` só como última rede.

### Estorno remove o lançamento
O gatilho não é lista de evento, é **"o dinheiro deixou de ser recebido"** — os 15
`CANCELLED` da base provam que existem caminhos além do webhook. O lançamento é
APAGADO (o índice `uq_financial_transactions_student_payment` garante uma linha por
pagamento, então se o dinheiro voltar o ramo de entrada recria com a data certa) e
o rastro fica em `reconciliation_issues` (`kind = PAYMENT_REVERSED`).

⚠️ `reconciliation_issues.tenant_id` é **NOT NULL** — pagamento sem escola vai para
o tenant `master`. Inserir `null` ali falha **em silêncio** (o supabase-js devolve
erro em vez de lançar).

### Pegadinhas medidas
- ⚠️ **`ledger_entry_created` mente.** O trigger cria o lançamento e não marca a
  flag; só o `reconcile-ledger` marca. Medido: 96 pagos com a flag em `false`, 69
  deles já com lançamento. Para saber o que falta conciliar use `NOT EXISTS` contra
  `financial_transactions`, nunca a flag.
- ⚠️ O `reconcile-ledger` inseria `amount_cents` **sem `amount`**, que é `NOT NULL`
  — todo insert morria. Era o único caminho de conserto dos 27 pagamentos sem
  lançamento (R$ 9.390,00) e estava morto. Hoje um trigger BEFORE deriva um do
  outro (`trg_sync_financial_amounts`); no Postgres o `NOT NULL` é checado DEPOIS
  dos triggers BEFORE, e é isso que salva quem insere só um dos lados.
- ⚠️ **Resíduo legítimo, não erro:** jan/fev carregam R$ 6.277,80 em lançamentos
  órfãos anteriores ao trigger, apontando para `pay_` que não existem mais.
  Decisão da direção em 25/08/2026: **ficam como estão.** De março em diante as
  duas fontes batem exato — divergência a partir de março é regressão de verdade.

---

## Balancete por Professor e gasto de anúncio ✅

**Balancete** (`balancete_professores`, menu Financeiro → "Balancete por Prof"): abre o custo com professor por natureza e mostra o lucro por cabeça. O custo NÃO é recalculado — sai de `v_payable_class_logs`, a mesma fonte da folha e do DRE; o que a função faz é **decompor**.

- **Decomposição**: `custo_base` = aulas × valor da faixa 1 (lido de `teacher_pay_tiers`, **nunca chumbado**), e tudo acima disso separado por motivo. A ordem da classificação espelha o `COALESCE` de `rate_efetivo` na view — **override primeiro**, depois o 16,00 de quem MINISTRA treinamento, e só então a faixa por carteira. Inverter faria um override de 10,50 ser lido como turbo.
- ⚠️ **Receita rateada.** `director_teacher_margin` junta a receita INTEIRA do aluno em cada linha professor×aluno — aluno com dois professores aparece com a mensalidade cheia nos dois e o lucro de ambos sai inflado (1 caso em julho/2026, 7 no histórico). O balancete rateia pelo número de aulas.
- ⚠️ **Receita não atribuível vai numa linha própria**, nunca some nem é diluída: pagamento sem `student_id` (R$ 2.365,00 em julho/2026, 8 pagamentos) e aluno que pagou sem ter aula no mês. Descartar faria o balancete não fechar com o DRE; diluir inventaria lucro.
- ⚠️ **A expressão de receita é IDÊNTICA à de `dre_gerencial`** (status `RECEIVED`/`RECEIVED_IN_CASH`, escopo por `student_payments.tenant_id`, data por `COALESCE(paid_at, payment_date, due_date)`). `director_teacher_margin` usa outra (aceita `CONFIRMED`/`PAID` e escopo pelo tenant do PERFIL) — por isso os dois não batem. Não "melhore" um lado só.

**Gasto de anúncio** (`post_ad_spend` → conta 6.1.03 Marketing): gasto de mês em curso **cresce**; reimportar não é duplicata. Por isso a chave `(tenant, origem, conta, período)` faz a segunda importação **atualizar** o lançamento, não criar outro. Controle em `ad_spend_imports`.

⚠️ **Limite de escopo honesto:** o MCP de anúncios roda na **sessão do agente**, não dentro do produto — a VPS não tem token do Meta nem chama MCP. `post_ad_spend` é a porta de entrada; quem lê a conta e chama é um agente. Automação de verdade exigiria token próprio + edge + cron.

---

## Assistente de Gestão no grupo de WhatsApp ✅

Grupo da direção vira um gerente a quem se pergunta. Entrada: `whatsapp-inbound`, que **sempre descartou mensagem de grupo** (`if (!remoteJid.endsWith("@s.whatsapp.net")) continue`) — agora há um desvio antes dessa linha, e só para o grupo autorizado.

**Três travas, nesta ordem, antes de qualquer coisa cara:**
1. **Gatilho** — a mensagem precisa começar com `Wolfie`, `gerente` ou `/`. Grupo é conversa entre pessoas; responder a tudo seria insuportável e caro.
2. **Grupo autorizado** — o JID tem de ser exatamente `dre_report_settings.destino` daquele tenant, com `is_active`. ⚠️ **Não existe lista paralela de grupos permitidos** — é o mesmo grupo que já recebe o relatório, configurado na tela. Duas listas sairiam de sincronia.
3. **Dedup** — `wa_inbound_seen` (PK `msg_id`), a mesma trava atômica do 1:1.

Mais teto de **20 respostas/hora por grupo** (`ai_wa_messages`): erro de configuração ou brincadeira não vira conta de IA.

⚠️ **Grupo não autorizado é ignorado em SILÊNCIO.** Responder "sem permissão" confirmaria que existe um assistente ali para quem tiver o link.

⚠️ **Sem laço de resposta:** o webhook já descarta `fromMe` de grupo, então a própria resposta do bot não se realimenta.

### `gestao_snapshot(mes, tenant)` — a base factual
O assistente **não consulta o banco livremente e não tem tool-calling**. Recebe um retrato pronto e responde em cima dele:
- Uma IA que monta a própria query **decide sozinha o que é "receita"** — exatamente o que este projeto passou a semana consertando. Aqui a definição continua sendo a das RPCs (`dre_gerencial`, `balancete_professores`), uma só.
- O tenant é resolvido **no servidor**; não existe caminho para a pergunta alcançar outra escola.
- Custo e latência previsíveis: uma chamada.

Preço conhecido: **o que não estiver no snapshot, o assistente não sabe** — e o prompt manda dizer que não sabe em vez de inventar. Payload ~6 KB (resultado do mês corrente e do fechado, professores, pendências, inadimplência, MEI).

⚠️ O snapshot usa o **mês FECHADO** para "como fomos": o corrente está pela metade e induz conclusão errada numa comparação direta.

⚠️ A pergunta vem de um grupo de WhatsApp = **entrada não confiável**: vai dentro de `<pergunta>` e o system prompt manda tratar como dado, recusar pedido de ignorar regras, de revelar o prompt ou de agir no sistema (o assistente não executa nada — só informa em que tela se faz).

⚠️ **Privacidade:** todo mundo no grupo passa a ver faturamento, margem e quanto cada professor recebe. Conferir participantes antes de ativar. A API devolve os participantes como `@lid`, então **não dá para identificá-los pelo servidor**.

---

## Os três agentes de WhatsApp (`whatsapp-inbound`) ✅

> **Uma function, três agentes, roteamento por identidade do telefone.** A ordem do
> roteamento importa e não é arbitrária: candidato → aluno contratado → lead.

| Agente | Quem atende | Onde mora |
|---|---|---|
| **Bia (SDR)** | quem não é candidato nem aluno = lead | `handleSDR` |
| **Michelle (RH)** | telefone casa com `job_applications` | `handleRita` + `triagem.ts` |
| **Atendimento ao aluno** | telefone casa com `profiles` de STUDENT com `contract_accepted` | rota `support` |

- ⚠️ **O aluno contratado NÃO fala com IA.** A resposta é um recado curto que confirma
  recebimento e encaminha a humano — e **não pode encostar** em matrícula, pagamento,
  contrato ou cobrança. A versão antiga dizia "não precisa preencher nada de matrícula
  novamente" e, para quem perguntava a chave PIX ou avisava que não pagou, isso lia como
  "está tudo certo, não precisa pagar". Aconteceu 12 vezes com 8 alunas (07/08/2026).
- ⚠️ **O aviso ao humano fica FORA do dedupe da resposta automática.** Silenciar a resposta
  é economia de ruído; silenciar o encaminhamento é perder o atendimento.

### Handoff humano tem validade e volta atrás

Medido em 09/08/2026: a Michelle recebeu **132 mensagens em 30 dias e respondeu 12**. As
outras 120 saíram como `skipped: human_handoff`. 26 das 67 candidaturas e 34 dos 103 leads
estavam com `ai_handoff = true`.

O handoff foi desenhado para "a IA sai de cena NESTA conversa" quando um humano responde
manualmente pela instância central. Só que era **booleano e sem volta**: uma única resposta
manual calava a IA naquele contato **para sempre**, sem expiração, botão ou aviso. A base foi
emudecendo em silêncio.

- `ai_handoff_at` (migration `20260809130000_handoff_da_ia_tem_validade`) carimba **quando** o
  humano assumiu, para o inbound perguntar "isto ainda é um atendimento humano vivo?" em vez
  de "alguém já respondeu aqui alguma vez na história?".
- ✅ **Desde 13/08/2026 a expiração vale nos DOIS caminhos.** Ela nasceu só no reativo (o
  contato escreveu de novo), e a prospecção ativa seguiu exigindo `ai_handoff = false` **sem
  prazo** — o mesmo defeito, um andar abaixo. Medido antes da mudança: **28 dos 47 leads
  `CONTACTED` estavam nesse limbo** e 73 leads nunca tinham recebido follow-up. Depois de 72h
  em silêncio, "um humano assumiu" só significa "ninguém está cuidando deste lead".
  A regra virou `handoffAtivo` em **`_shared/lead-contact.ts`**, usada pelo `whatsapp-inbound`
  e pelo `sdr-followups` — duas cópias divergiriam no primeiro ajuste.
- ⚠️ **O backfill usa a ÚLTIMA mensagem trocada, não `now()`.** Carimbar `now()` prorrogaria o
  silêncio por mais uma janela inteira — exatamente o problema que a migration existe para
  acabar.
- RPC `set_ai_handoff(p_kind, p_id, p_handoff)` devolve o contato à IA (ou tira) pela tela.
  Escrita fechada numa RPC estreita em vez de policy de update ampla nas duas tabelas.

### Experimental sem professor não pode virar silêncio ✅

Medido em 13/08/2026: de 125 experimentais da história, **69 expiraram sem nenhum professor
aceitar (55%)**. O lead tinha ouvido *"vou verificar o professor e já te confirmo"* — e depois
disso **18 ficaram em silêncio total** e **16 tiveram que cobrar** (a mensagem seguinte foi
deles). O `funnel-sweeper` avisava o diretor aos 60 min e marcava `LOST` em 48h, mas **nunca
falava com quem pediu a aula**.

A varredura **C2) LEAD ÓRFÃO** fecha o circuito: quem ficou sem professor recebe as
alternativas reais da grade (`pickAlternatives`, o mesmo cálculo que a atendente usa).

- ⚠️ **Roda separada do momento da expiração.** Expirar às 3h e mandar mensagem na hora seria
  pior que não mandar; a oportunidade é varrida no horário comercial seguinte, com
  idempotência por `automation_sent (TRIAL_NO_TEACHER)` — um único toque por experimental.
- ⚠️ **Janela de 3 dias.** Sem ela, a primeira execução dispararia para os 69 do histórico.
- ⚠️ **Não fala com quem já tem aula.** Pula quando a oportunidade tem `lost_reason` (foi
  substituída porque o próprio aluno remarcou) e quando existe outra experimental `CLAIMED`
  para o mesmo telefone. Dizer "não achei professor" a quem tem aula marcada derruba a aula.
- Trava comercial (virou aluno), telefone de candidato e teto diário de 15 valem aqui como em
  todo contato de venda — o número da escola já foi restringido uma vez.
- **A atendente agora DÁ PRAZO** ("te confirmo hoje mesmo; se ninguém puder, eu te aviso e
  ofereço outros horários"). A promessa só é honesta porque esta varredura existe — mudar uma
  sem a outra volta a criar lead esperando retorno que não vem.

### ⚠️ Instância inexistente derruba TODO envio do tenant — em silêncio

Investigando por que um follow-up falhava (13/08/2026), a causa não era o número: a Evolution
respondia **404 `The "prof-diretornovo-7w8c" instance does not exist`**. Essa instância estava
em **três perfis** — `master`, `royal-british` e `wise-wolf-school` —, então **todo envio
automático desses tenants falhava desde sempre**, incluindo os 10 leads da Royal British.

- Os três campos foram **limpos** (`whatsapp_instance = null`): sem instância, as automações
  **pulam** o tenant em vez de tentar e falhar. Reversível — basta reconectar pela tela
  "WhatsApp (Conexão)".
- ⚠️ **Nome de instância no perfil não é validado contra a Evolution.** Antes de investigar
  "por que a mensagem não chegou", confira:
  `curl -s https://api.2b.app.br/instance/fetchInstances -H "apikey: $KEY"` e compare com
  `select distinct whatsapp_instance from profiles where whatsapp_instance is not null`.
- Foi o log do motivo da recusa (abaixo) que revelou isto em 30 segundos. Sem ele, a
  investigação passou por duas hipóteses erradas (9º dígito e campo `lid`).

### Envio no chute falha em SILÊNCIO — resolva o JID antes ✅

DDD antigo costuma estar registrado no WhatsApp **sem o 9º dígito**. Mandar para o número
como está no cadastro não bate com o JID real e a mensagem **nunca chega — com a Evolution
respondendo 200/PENDING**, então o envio parece ter dado certo.

O `funnel-sweeper` já resolvia o JID; `sdr-followups` e `whatsapp-inbound` não — três cópias,
uma com comportamento diferente. Unificadas em 13/08/2026.

⚠️ **A suspeita que originou isto foi MEDIDA E NÃO SE CONFIRMOU.** O gatilho foi o follow-up
da lead Cléria (`553399975104`, 12 dígitos) falhar na primeira rodada da prospecção
reativada. Consultando `chat/whatsappNumbers`, os **9 leads de 12 dígitos resolvem para o
MESMO número** — existem assim mesmo no WhatsApp. Logo, o 9º dígito **não explica** aquela
falha, que segue sem causa conhecida. O valor da unificação é consistência e cobrir o caso
quando ele aparecer; **não conte isto como correção de entrega.** Antes de culpar o 9º
dígito, consulte o endpoint e confirme.

- Envio e resolução vivem em **`_shared/evolution-send.ts`**, usado pelos três.
- ⚠️ **Falha ao resolver NÃO cancela o envio** — cai no número original. A resolução melhora o
  acerto; exigir que ela funcione transformaria instabilidade da Evolution em mensagem não
  enviada.
- ⚠️ **Grupo (`@g.us`) e JID pronto pulam a consulta**: o endpoint responde para NÚMERO, e uma
  chamada extra por mensagem de grupo só adiciona latência a cada disparo.
- **Recusa da Evolution agora diz o motivo** (`console.warn "[evolution] envio recusado"` com
  status e corpo). Sem isso, envio recusado virava só um `false` e não dava para distinguir
  limite de sessão caída — exatamente o beco em que a falha da Cléria parou.
  Diagnóstico: `ssh wisewolf-vps 'docker logs supabase-edge-functions --since 1h | grep evolution'`.
- Testes com `fetch` dublado em `_shared/evolution-send.test.ts` (8 casos).

### ⚠️ Aluno matriculado recebendo oferta de experimental — a trava de sósia

Aconteceu em 13/08/2026: a aluna **Penha Vilani** (matriculada, contrato aceito) recebeu
*"ainda tem interesse na aula experimental?"*. O CRM tinha **"Penha Valani"** com telefone
`27 999247902` contra `27 99924792` no cadastro dela — **um dígito de diferença**. Para o
casamento por telefone eram dois estranhos; para quem recebeu, foi a escola perguntando se
ela quer conhecer a escola em que estuda.

- A supressão comercial casava lead↔aluno **só por telefone/e-mail**. Agora, quando esse
  caminho não acha ninguém, entra `provavelSosiaDeAluno`: **nome quase idêntico (distância
  ≤ 2) + MESMO DDD + mesma escola ⇒ não manda venda**.
- ⚠️ **Ela BLOQUEIA, não vincula** (`studentId` volta nulo). Vincular cadastro por semelhança
  de nome mexeria em cobrança a partir de um palpite; recusar uma mensagem de venda, no pior
  caso, custa um lead não prospectado — e isso um humano conserta em dez segundos.
- ⚠️ Nome com menos de 6 letras fica fora da regra, senão "Ana" bloquearia "Ane".
- **Auditoria para achar os próximos** (leads que são alunos com telefone divergente):
  `levenshtein` sobre nome normalizado + mesmo tenant, filtrando quem já casa por telefone.
  Rodada em 13/08/2026: só a Penha entre os registros reais.
- ⚠️ A trava não conserta o cadastro duplicado — ela só impede a mensagem. **Quem reconcilia
  os dois telefones é gente**, e enquanto não reconciliar o lead segue no CRM como pessoa
  separada.

### ⚠️ Quem é "aluno" para a trava comercial (auditoria de 13/08/2026)

A supressão de venda considerava aluno quem tem `contract_accepted = true` **ou** contrato
`ACTIVE/PAUSED` em `student_contracts`. Só que **`student_contracts` está VAZIA** (0 linhas) —
esse ramo é código morto —, e a auditoria achou **8 alunos ativos e pagantes com
`contract_accepted = false`** (matrícula antiga, feita na mão). Para o robô, oito clientes não
eram alunos. Nenhum estava no CRM naquele dia, então nada foi enviado: **foi sorte, não
desenho.**

- Agora vale também a ATIVIDADE: aula `SCHEDULED` na agenda ou pagamento `RECEIVED`
  (`facts.studentsWithActivity`, motivo `aluno_em_atividade`). Papelada atrasada não devolve
  ninguém para o funil de venda.
- A trava de sósia passou a considerar esses alunos também.
- ⚠️ **Não conserte isso marcando `contract_accepted = true` na mão** para os 8: a flag
  significa "aceitou o contrato no sistema", e forçá-la inventaria um aceite que não houve —
  o mesmo erro do 1969 abaixo, só que em documento.

### ⚠️ 31/12/1969 na tela de contratos — `new Date(null)` é o epoch

A coluna "Matrícula" imprimia **31/12/1969** para 13 alunos: são os migrados em fev/2026, com
contrato marcado como aceito e **`accepted_at` nulo** (nunca assinaram digitalmente — o nulo
ali é honesto). `new Date(null)` é o epoch, que em Brasília cai em 31/12/1969.

- Use **`formatSignatureDate`** (`lib/contractDates.ts`) para EXIBIR: devolve "—" para nulo,
  data inválida e epoch exato.
- ⚠️ **Não use `contractReferenceDate` numa tela.** Ela cai para "hoje" de propósito, porque o
  documento precisa de vigência válida; numa lista isso viraria "matriculado hoje" para quem
  nunca assinou — mentira pior que o buraco.
- O mesmo helper já tinha nascido de um caso irmão: contrato impresso com
  "Vigência: 10/01/1970 a 10/01/1971".

**Outros números da auditoria de contratos (55 alunos na tela):** 39 com contrato aceito, dos
quais **33 sem assinatura nenhuma** registrada; 16 sem contrato aceito, **8 deles com aula ou
pagamento**; 7 com `accepted_at` ANTERIOR ao `contract_sent_at` (ordem impossível, provável
reenvio que recarimbou o envio); 7 aceitos sem dia de vencimento; 3 sem CPF.

### ⚠️ Aluno em rajada NÃO é aluno sem resposta

Uma auditoria de 13/08/2026 apontou "34 de 47 mensagens de aluno sem resposta (72%)" e quase
virou mudança na janela de dedupe do atendimento. **A medição estava mal recortada.** Abrindo
o intervalo entre mensagens do mesmo aluno em 60 dias: **32 são rajada (<15 min)** — a pessoa
mandando 3-4 mensagens seguidas na mesma conversa —, 9 são a primeira da conversa, e só
**3 chegaram mais de 4h depois**. Responder cada mensagem de uma rajada com o mesmo recado
automático é pior que não responder.

A janela de 4h fica como está. Antes de mexer nela, refaça esse recorte: o número de
"mensagens sem resposta" sozinho não distingue silêncio de bom senso.

### `outbox_messages` está APOSENTADA — não religue o cron sem ler isto

Medido em 13/08/2026: **12 mensagens `PENDING` desde MAIO** — convites de experimental para o
grupo dos professores ("EXPERIMENTAL — 02/05/2026 às 19:00", com link de vaga que não existe
mais). Não há cron chamando `process-outbox`, e **nenhum código escreve mais nessa fila**: o
broadcast passou a enviar direto.

- ✅ O worker ganhou **validade (`MAX_AGE_MS`, 2h)**: mensagem vencida vai para a **DLQ com o
  motivo, sem ser enviada**. O risco nunca foi o passado parado — era alguém religar o cron e
  a escola inteira receber convite de três meses atrás.
- ⚠️ Se um dia a fila voltar a ser usada para algo que tolera atraso longo, **esse teto tem de
  ser revisto junto**. Não é constante inofensiva.
- As 12 antigas foram marcadas `DLQ` (motivo registrado), não apagadas nem enviadas.

### A etapa da triagem é decidida no SERVIDOR, não pelo modelo

Medido em 09/08/2026: **67 candidaturas, 3 triagens concluídas (4,5%)**. O roteiro de 10
etapas vivia inteiro num system prompt de ~2.500 tokens, e o modelo tinha de reconstruir a
cada mensagem em que ponto estava, lendo o JSON de respostas já coletadas.

**Modelo bom em conversa não é bom em contabilidade de estado.** Hoje `triagem.ts` faz a
parte determinística — qual é a próxima pergunta, o que já foi respondido, quando acabou — e
o modelo recebe **uma etapa por vez**, para fazer só o que faz bem: virar aquela pergunta
numa frase humana que reage ao que a pessoa acabou de dizer.

- `done` deixou de ser opinião do modelo e virou **contagem de campos**.
- `mergeRespostas` descarta chave inventada e **não sobrescreve resposta já dada**.
- Pular ou repetir etapa deixou de ser possível **por construção**.
- Log de progresso por etapa: sem ele não dá para saber onde as triagens morrem — e era esse
  o ponto cego.
- ⚠️ Os números de remuneração nos blocos são **comerciais**. Não invente nem arredonde ao
  editar `ETAPAS`.
- Testes: `supabase/functions/whatsapp-inbound/triagem.test.ts` (24 casos).

### Renovação assinada por aluno SUSPENSO — o caso da Bianca (17/09/2026) ✅

Ela assinou a renovação (5x R$ 377 → 3x R$ 261) estando suspensa, com a assinatura antiga
já apagada na Asaas. Quatro travas em cadeia, todas "fail-closed" e nenhuma pensada para
renovação com mudança de plano:

1. **`student-renewal-billing` (CREATE_NEW)** exigia a assinatura antiga viva, com o MESMO
   valor: 404/valor diferente → `REVIEW source_subscription_changed`. Hoje: antiga ausente
   (404) ou encerrada (EXPIRED/INACTIVE/deleted) libera; só antiga ATIVA barra
   (`source_subscription_still_active`). Valor e forma de pagamento vêm da oferta.
2. **`asaas-mutation-guard`** só conhecia `<studentId>` e `enrollment:<oferta>:<fim>`; a
   renovação cria `renewal:<oferta>:subscription` → `ASAAS_IDENTITY_MISMATCH` na reativação
   e em qualquer mutação futura. Hoje: kind `RENEWAL`, provado por
   `student_course_renewal_binding(p_offer)` (migration `20260917150000`).
3. **`apply_active_student_payment_event`** (RPC) rejeitava a mesma referência
   (`reference_mismatch` → TRIAGE). Cópia integral com o ramo novo em `20260917160000`.
4. **Deadlock**: a reativação oficial exige a cobrança no ledger local
   (`SUBSCRIPTION_PAYMENT_PROVIDER_ONLY`), e o ledger só aceita cobrança de aluno ATIVO
   (`student_lifecycle_or_binding_changed`). Resolvido na mão: `profiles` → ativo (sem
   operação em voo, o guard deixa), o trigger `apply_pending_renewal_schedule_on_reactivation`
   criou a agenda, e os 4 eventos da inbox foram reenfileirados (`status='RETRY'`).
   ✅ **Fechado no mesmo dia** (migration `20260917170000`): na reativação pelo painel, se a
   assinatura do perfil foi criada por renovação SIGNED+SYNCED
   (`student_course_renewal_binding_for_subscription`), a conferência do ledger TOLERA a
   cobrança que só existe no provedor; depois do `finalize`, os eventos em TRIAGE daquela
   assinatura voltam para o worker (`requeue_asaas_inbox_events_for_renewal_subscription`) e
   entram pelo caminho normal. Nada é inserido na mão em `student_payments`.
- `SUBSCRIPTION_CREATED` da renovação fica em TRIAGE (`student_subscription_operation_
  unresolved`): o vínculo já foi gravado pelo `finish … SYNCED`; é ruído, não perda.

### Inbox do WhatsApp: áudio e foto abrem na plataforma ✅

A inbox guarda só texto e tipo (`whatsapp_messages.message_type`); o arquivo fica no
provedor. Botão **Ouvir áudio / Ver foto / Abrir documento** na bolha
(`MediaAttachment`, `components/WhatsappInbox.tsx`) busca sob demanda pela ação
`inbox/media` do `whatsapp-evolution-proxy` (`chat/getBase64FromMediaMessage`, o mesmo
endpoint que o bot usa para transcrever), validando conversa + instância + escola e o
tipo da mensagem; teto de 12 MB de base64. ⚠️ Mensagem antiga pode não ter mais mídia
no provedor — a resposta é "não está mais disponível", não erro de sistema.

### Acompanhamento de aluno e professor — a manutenção de conversa ✅

> Migration `20260917180000`, edge `care-sweeper` (cron `wisewolf-care-sweeper`, 15 min),
> agente `care` no `whatsapp-inbound`. Decisão da direção em 17/09/2026.

**Medido antes:** 82 faltas de aluno em 30 dias (18%), 15 alunos com 2+ faltas, **55
reposições abertas, todas sem data**; a confirmação de presença tinha 796 aulas sem
resposta. O aluno faltava, ganhava o direito, e ninguém corria atrás.

- **Sinais, não calendário.** `care_due_absence_followups` (faltou ontem → "sentimos sua
  falta" + direito + horários livres do professor), `care_due_weekly_checkins` (sexta
  15–19h, só quem teve aula), `care_due_monthly_checkins` (a cada 30 dias, 2 por rodada
  para não sair em rajada), `care_due_teacher_touchpoints` (aluno que não respondeu →
  professor cobra comparecimento com texto pronto; 2+ faltas SEM cobertura → política de
  remarcação; check-in mensal). Cada toque é uma linha em `care_touchpoints`
  (idempotente por assunto+tipo+referência; marca antes do envio, apaga se falhar).
- **Aluno matriculado fala com a IA SÓ aqui** (`handleCareStudent`), e a IA **nunca** fala
  de cobrança/contrato/valor — `isMoneyOrContractTopic` manda para gente antes da IA.
  Sentimento negativo ou pedido que só a coordenação decide → `HANDOFF` + aviso ao
  diretor. Horário escolhido da lista (ou "quinta às 19h") marca a reposição na hora
  (`care_set_reschedule_slot`, só na grade livre do professor) e avisa a professora.
- **4 reposições por direito no mês** (era 5): patch por âncora no
  `private.log_teacher_classes_engine`; da 5ª em diante não nasce reposição automática —
  é combinação, sem obrigação. A regra está na tela do aluno (`StudentSchedule`, tour
  `2026-09-17-faltas-e-reposicoes`) e nos guias do professor.
- ⚠️ Falta do professor COM cobertura confirmada não conta para a política — quem avisou e
  teve a aula coberta fez o certo.
- Professor respondendo a um toque: sem IA — registra no toque e encaminha à coordenação.
- Desligar por escola: `tenants.ai_team_config.care = false` (ou `.care.enabled = false`).

### Central de Ajuda do professor + Planner IA vivo de novo ✅

- **Central de Ajuda** (`components/TeacherSupportCenter.tsx`, botão flutuante "Ajuda" em toda
  tela do professor): guias em `lib/teacherSupportGuides.ts` — o que fazer em cada situação,
  com a mensagem exata para o WhatsApp da escola ("Não vou conseguir dar aula hoje" → o bot
  de ausência) e botões que agem (wa.me com texto pronto; navegar para a tela). Contatos vêm
  de `teacher_support_contacts()` (migration `20260917140000`): o WhatsApp da escola é o
  telefone do perfil SCHOOL_ADMIN dono da instância central (conferido contra o `sender` dos
  webhooks), a coordenação vem de `tenants.school_info`. ⚠️ Os números dos guias (5
  reposições/mês, R$ 16 do treinamento, 40 min da confirmação) são regra do produto — mudou
  no banco, mude no guia. Teste garante que toda ação de navegação existe no menu do professor.
- **Planner IA estava morto no ar**: 25 s de timeout por chamada para um JSON estrito de até
  7.000 tokens — 504 em toda geração; **zero planos salvos na história** (medido em
  17/09/2026 como o Flávio, dentro da VPS). Agora orçamento único de 135 s por geração
  (`PLANNER_TOTAL_BUDGET_MS`; worker e Kong dão 150 s), primeira tentativa até 100 s, retry
  com o que sobrar. Medido depois: 20 s, plano completo.
- **"Planejar" em Aulas de Hoje** (`data-tour="lesson-plan-ai"`): manda o professor ao Planner
  já com o aluno e o objetivo (`lib/plannerIntent.ts`, sessionStorage consumido uma vez).
- ⚠️ **`tenants.domain` não é o portal.** A tela de configuração grava
  `<slug>.wisewolflanguage.com.br` (`update_tenant_settings`), e "wisewolf.wisewolflanguage.
  com.br" não existe no DNS — em 17/09 o link de renovação da Bianca saiu nesse host e ela
  respondeu "esse link não funciona". `resolveTenantCommunicationIdentity` agora só deixa
  domínio próprio VERIFICADO passar na frente de `system.wisewolflanguage.com.br` para a Wise
  Wolf; o dado foi corrigido na mão (`domain = system…`) e o link reenviado.

### Pós-experimental é conversa, 10 minutos depois da aula — e o professor recebe briefing ✅

> Migration `20260917120000`. **Leia antes de mexer em `trial_closing_*`, no
> `funnel-sweeper` (bloco F/G) ou na etapa de fechamento da atendente.**

- **Antes** o aluno só era chamado depois de a professora responder "sim" ao bot
  (etapa `ASK_STUDENT`) — e recebia de cara "me diz frequência e plano + tabela".
  Professora que demorava travava tudo (16/09: três experimentais "sem resposta").
- **Agora** (`trial_closing_student_openers`): 40 min depois do início (30 de aula + 10)
  **ou assim que a aula é lançada** como dada, o bot abre a conversa — *"Como foi a
  aula com a teacher X? Me conta o que achou"* — entre 8h e 22h, sem esperar a
  professora. Daí em diante quem conduz é a **atendente**, com a etapa
  `PÓS-EXPERIMENTAL — FECHAMENTO` (`trial_closing_student_context`): reage, pergunta a
  frequência, dá os valores da tabela, oferece os horários livres da professora.
  Frequência/plano/horários ditos pelo aluno continuam sendo lidos pelo caminho
  determinístico (`handleTrialClosingStudent` → `trial_closing_student_plan`, que agora
  aceita a etapa `ASK_TEACHER`).
- ⚠️ **O LINK continua exigindo o "sim" da professora** (antifraude: quem diz que deu
  a aula é quem recebe por ela). Escolha feita antes fica guardada (`waiting: feedback`)
  e `trial_closing_pending_offers` solta o link quando ela responde.
- ⚠️ `trial_closing_student_asks` ficou intacta de propósito: a migration antiga a
  recria a cada release com o retorno antigo, e mudar o retorno quebraria aquele
  `create or replace`. Função nova para retorno novo.
- **Briefing do professor** (`trial_teacher_briefings`, `TRIAL_TEACHER_BRIEFING` em
  `automation_sent`): até 2h30 antes da experimental (ou na primeira varredura depois
  de um aceite em cima da hora) o professor recebe aluno, telefone, objetivo, nível,
  contexto do CRM (sem carimbos `[IA …]` nem UTMs) e o que fazer antes. A Bruna tinha
  recebido "não esqueça da experimental de hoje" — mandado na mão, sem nome nem
  horário (17/09).

### Várias ações na mesma mensagem do grupo — fila dentro da ação pendente ✅

A direção manda "a Bruna cobriu três aulas do Flávio: …" numa mensagem só, e o modelo
de pendência é **um por grupo** (PK `group_jid`). Até 17/09 só a primeira era proposta;
as outras duas morriam em silêncio (foi assim com Victor Hugo 17:00 e Vinícius 17:30).
Hoje o modelo devolve `acoes: [...]`, a primeira vira a pendente e as demais viajam em
`acao.fila`; ao terminar (ou cancelar) uma, `proposeNextQueuedManagementAction` propõe
a próxima com código novo (`request_id` = mensagem original + `:qN`). A autorização
compara por contenção (`acao @> expected`), então a chave extra não invalida nada.
⚠️ Cancelar uma **não** cancela a lista — a próxima ainda é proposta.

### Preço para o lead: a IA propõe a frase, o código veta o número ✅

> **Leia antes de mexer em `commercial-response-policy.ts`, `lead-pricing.ts` ou no
> prompt da atendente.** Conserto de 17/09/2026.

**O caso (lead Diná, 07:12–07:21):** pediu "estimativa de valores" e ouviu um bloco
fixo ("As aulas são de 30 minutos, e isso é proposital… Os planos começam em
R$ 169"); perguntou **"4 vezes na semana qual valor?"** e ouviu, duas vezes, *"esse
horário já está aguardando o aceite de um professor"*. Escreveu que estava sendo
tratada "como idiota com essas mensagens repetidas" e a direção mandou a tabela na
mão. Três defeitos, nenhum do modelo:

1. **A política SUBSTITUÍA a resposta** por um texto fixo a cada palavra "valor" —
   sem a tabela e sem a frequência pedida. Hoje a resposta do modelo com valores do
   catálogo (`student_pricing_plans`, carregado em `loadLeadPriceCatalog`) **passa
   inteira**; valor de fora do catálogo é barrado (`blocked_foreign_price`); pergunta
   de preço sem número ganha o mínimo; **frequência dita ganha os valores dela + a
   tabela no formato da direção** (uma vez por conversa — `priceListAlreadySent`);
   "??" ou reclamação depois de preço sem resposta é cobrança e recebe a tabela.
2. **O modelo repetia `schedule_trial` do pedido anterior** em toda mensagem, e o
   ramo `alreadyPending` (e o `keep` da aula com dono) sobrescrevia qualquer
   resposta. Só mensagem que fala de horário (`mentionsSchedule`) ouve o aviso.
3. **A resposta de preço engolia a promessa de verificar o professor** quando os dois
   pedidos vinham na mesma mensagem ("As 10" + "estimativa de valores"). A promessa
   é anexada (`TRIAL_PROMISE`).

- ⚠️ **O mensal (fidelidade 1) existe no catálogo e NÃO entra na tabela** — a
  direção manda só 6 e 12 meses (`LIST_MIN_DURATION_MONTHS`). O modelo recebe o
  catálogo inteiro como fato e cita o mensal só se perguntarem por opção sem
  fidelidade.
- ⚠️ **Não volte a colocar texto fixo no lugar da resposta.** Robô que repete a
  mesma frase é o que a direção pediu para acabar. O que é fixo é o **número**; a
  frase é do modelo, e o histórico enviado a ele já traz o que foi dito.
- Testes: `lead-pricing.test.ts` e `commercial-response-policy.test.ts` (a conversa
  real como regressão). Os dois no `release.sh` (fmt + test).

### Áudio vale para lead e candidato, não só para a direção

O Whisper já estava pago e ligado, mas **só o grupo da direção usava**: lead e candidato que
mandavam nota de voz recebiam "só consigo ler texto". No WhatsApp brasileiro isso é metade
das respostas — e um candidato que grava áudio para a pergunta de apresentação **em inglês**
era o sinal mais útil da triagem inteira.

- ⚠️ **Só áudio entra.** Imagem, vídeo e documento continuam pedindo texto.
- ⚠️ O Whisper decide o decoder pela **extensão do arquivo**, não pelo mimetype do form —
  nota de voz do WhatsApp é ogg/opus e sem o nome certo ele recusa.
- ⚠️ A mídia do WhatsApp é criptografada: a Evolution devolve o arquivo decifrado em base64 a
  partir da chave da mensagem (`chat/getBase64FromMediaMessage`), e só então dá para
  transcrever.
