# Wise Wolf SAAS — CLAUDE.md

Guia técnico para o Claude Code neste projeto.

---

## Stack do Projeto

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Supabase (Postgres + Edge Functions em Deno)
- **IA:** Gemini (wolfie-brain), Google Translate TTS (wolfie-tts)
- **Pagamentos:** Asaas
- **Deploy:** Vercel (frontend) + Supabase (edge functions)

---

## Wolfie AI Tutor — Arquitetura de Áudio ✅ FUNCIONANDO

> **Leia isto ANTES de qualquer alteração em `WolfieTutor.tsx` ou `wolfie-tts`.**  
> Levou semanas para descobrir e estabilizar. Não quebre o que funciona.

### Stack de Áudio

| Camada | Desktop | iOS Safari/Chrome |
|--------|---------|-------------------|
| TTS (geração) | `wolfie-tts` → Google Translate TTS | idem |
| Playback principal | `AudioContext` + `BufferSource` | `HTMLAudioElement` pré-ativado |
| Fallback 1 | `HTMLAudioElement` (blob URL) | `AudioContext` (se preUnlocked falhar) |
| Fallback 2 | `Web Speech API` | `speakWebSpeech` |

---

### Edge Function: `wolfie-tts`

**Localização:** `supabase/functions/wolfie-tts/index.ts`  
**TTS em uso:** Google Translate TTS (v9, funcional)

```
GET https://translate.google.com/translate_tts
  ?ie=UTF-8
  &q=TEXTO_ENCODED
  &tl=en-US          ← locale extraído do nome da voz
  &client=gtx
  &ttsspeed=1
```

**Regras críticas:**
- ✅ **User-Agent de browser real obrigatório** — Google bloqueia UAs de servidor/bot
- ✅ **Chunks de 180 chars** — limite do endpoint; textos longos são divididos em sentenças
- ✅ **Chunks buscados em paralelo** com `Promise.all` e concatenados
- ✅ **Locale** extraído do nome da voz: `en-US-JennyNeural` → `en-US`, `pt-BR-ThalitaNeural` → `pt-BR`

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
| `supabase/functions/wolfie-tts/index.ts` | Geração TTS → Google Translate → base64 MP3 |
| `supabase/functions/wolfie-brain/index.ts` | IA conversacional (Gemini) — NÃO mexer no TTS |

### Variáveis de Ambiente (Supabase)
- `wolfie-brain`: precisa de `GEMINI_API_KEY` (configurada no painel Supabase)
- `wolfie-tts`: **sem variáveis** — Google Translate TTS é gratuito e sem auth

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
- ❌ **Edge functions do Supabase NÃO renderizam HTML** — o gateway força `content-type: text/plain` + CSP `sandbox`. Páginas para o usuário final ficam no SPA (rota pública em `App.tsx`), não em edge function.
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

## Gestão de Vendedores (SALESPERSON) ✅

- **Criação:** por link de convite (`VendorInviteGenerator`, payload base64 com `commissionRate` em **centavos**) — vendedor se autocadastra. Surfaced no hub.
- **Hub do diretor** (`VendorManagement`, aba "Vendedores"): KPIs (a pagar, receita trazida), lista com editar comissão inline + ativar/desativar + convite. `VendorProfileView` = ficha 360 (comissões, funil, histórico) com **workflow** Confirmar→Pagar.
- **RPCs (só admin):** `list_vendors_overview()`, `get_vendor_overview(uuid)`, `set_vendor_commission_status(uuid, text)`.
- **Auto-confirm:** trigger `confirm_vendor_commission_on_payment` em `student_payments` → comissão PENDING vira CONFIRMED quando o aluno indicado paga (RECEIVED).
- **Atribuição:** link de matrícula com `?vendor_id=` cria `vendor_commissions` (vendor_id, student_id, amount_brl em **reais**, status PENDING/CONFIRMED/PAID).
- `profiles.commission_rate` em **centavos** (dividir por 100 p/ exibir). Auditoria de comissão via `log_profile_changes` (role SALESPERSON).
- **Estado atual:** 0 vendedores / 0 comissões — camada estava inerte; agora operável.

---

## Navegação do Diretor — menu, badges e Central de Pendências ✅

> O acesso do diretor (`SCHOOL_ADMIN`) tinha 30 itens de menu **flat, sem grupos nem alertas**. Reorganizado para reduzir carga e dar visibilidade ao que precisa de ação.

- **Menu agrupado** (`ModernSidebar`): `MenuItem` ganhou `section` (cabeçalho de grupo) e `badgeKey` (contador). Seções: Visão geral · Pessoas · Aulas · Pedagógico · Financeiro · Crescimento · Configurações. Renderização mostra header quando a seção muda; colapsado vira divisória.
- **Badges de pendência**: `App.tsx` busca `director_pending_counts()` (RPC, migration `20260605140000`) em `pendingCounts` e passa ao sidebar; itens com `badgeKey` (`acolhimento`, `presenca`, `materiais`, `trials`) mostram o número. Atualiza ao trocar de aba (`activeTab`).
- **Central de Pendências** (`components/DirectorPendingCenter.tsx`): no topo do Dashboard (aba analytics), lista tudo que espera ação com link direto (`onNavigate` = `setActiveTab` do App). Estado "tudo em dia" quando zero.
- **Nomes corrigidos** (eram confusos): `automation`="WhatsApp (Conexão)" (AutomacaoSmart) vs `automations`="Disparos WhatsApp" (AutomationPanel); `payments`="Repasse a Profs" (**TeacherPayments — pagamento AO professor**); `approvals`="Acolhimento (Docs)"; `financial`="Lançamentos do Caixa".
- **`contracts` agora é item de menu próprio** (`ContractManagement`) — antes só existia escondido na aba do Dashboard. A aba duplicada de Contratos foi **removida** do `SchoolAdminDashboard`.
- ⚠️ **Cuidado — "duplicatas" que NÃO são**: a aba `payments` do Dashboard = `AdminPaymentsList` (**mensalidades de ALUNOS**, rotulada "Mensalidades"), diferente do menu `payments` = `TeacherPayments` (repasse ao professor). `training`/`registration`/`recruiting` do Dashboard são telas únicas que só existem ali. Não remova achando que são cópias.

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

## ⚠️ Gotchas de RPC `RETURNS TABLE` (aprendido na marra)

Funções `RETURNS TABLE(...)` validam tipos em **runtime** (não na criação). Erros que deixam o painel "vazio" silenciosamente (frontend engole o erro):
1. **`count(*)` é bigint** — colunas de contagem declaradas `int` quebram ("structure of query does not match"). **Solução:** `::int` no SELECT final (ou declarar `bigint`).
2. **Nomes ambíguos** — se um OUT param tem o mesmo nome de coluna usada sem qualificar (`teacher_id`, `tenant_id`, `status`), dá "column reference is ambiguous". **Solução:** `#variable_conflict use_column` no topo do corpo + aliasar CTEs.
3. **`commission_rate` é integer** (centavos); declarado `numeric` quebra → `::numeric`. `hourly_rate`/`monthly_fee` são numeric; `xp`/`streak_count` são integer.
- **Validar SEMPRE chamando a função** (`SELECT count(*) FROM minha_rpc()` com `set_config('request.jwt.claims', '{"sub":"<uid>"}', true)`), NÃO só o SELECT interno.
- Fichas `get_*_overview` retornam **jsonb** → imunes a esse problema.

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
- **Caixa:** trigger `ledger_on_payment_received` lança ENTRADA no `financial_transactions` quando pagamento vira RECEIVED (idempotente — dispensa reconciliação manual). RPC `get_cashflow(month)` = entradas − saídas (repasses PAGOS + comissões + indicações pagas) das fontes autoritativas (sem dupla contagem) + inadimplência aging. Componente `CashflowPanel` (aba "Fluxo de Caixa").
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

## Planner de Aula com IA (LessonPlannerAI) ✅

> Antes era um **template estático** (não chamava IA). Agora usa IA real via edge `lesson-planner`.

- Edge `lesson-planner` (OpenRouter, Gemini free + fallback) monta plano PERSONALIZADO juntando: perfil (nível/CEFR, personalidade, KIDS, interesses, objetivos), **pontos fracos recorrentes** (`wolfie_corrections.error_type` das sessões do aluno), **histórico** (`class_logs` últimas 5 — continuidade), plano anterior (`lesson_plans`), e **materiais APROVADOS** do tenant (sugere só desses). Retorna `{objectives, content, materials, ai_memory_reflection, weak_points}` — o `content` traz seções com tempos (aquecimento/principal/prática/lição/evitar/continuidade).
- `LessonPlannerAI.handleGeneratePlan` chama `supabase.functions.invoke('lesson-planner', { student_id, custom_prompt })` (não mais template). Salva em `lesson_plans` (memória p/ continuidade).
- Guardrails: só sugere materiais da lista fornecida; usa dados reais (anti-genérico). Auth: TEACHER/admin.

---

## Convenções do Projeto

- TypeScript estrito (sem `any`)
- Comentários em português
- Deploy automático via Vercel (push para `main`)
- Edge functions: deploy manual via `supabase functions deploy` ou MCP Supabase
- **Dados sensíveis da Wise Wolf** (CNPJ, email, telefone, endereço) **NUNCA no código** — apenas em variáveis de ambiente ou formulários preenchidos pelo usuário
