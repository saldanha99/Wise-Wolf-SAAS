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

## Gestão de Vendedores (SALESPERSON) ✅

- **Criação:** por link de convite (`VendorInviteGenerator`, payload base64 com `commissionRate` em **centavos**) — vendedor se autocadastra. Surfaced no hub.
- **Hub do diretor** (`VendorManagement`, aba "Vendedores"): KPIs (a pagar, receita trazida), lista com editar comissão inline + ativar/desativar + convite. `VendorProfileView` = ficha 360 (comissões, funil, histórico) com **workflow** Confirmar→Pagar.
- **RPCs (só admin):** `list_vendors_overview()`, `get_vendor_overview(uuid)`, `set_vendor_commission_status(uuid, text)`.
- **Auto-confirm:** trigger `confirm_vendor_commission_on_payment` em `student_payments` → comissão PENDING vira CONFIRMED quando o aluno indicado paga (RECEIVED).
- **Atribuição:** link de matrícula com `?vendor_id=` cria `vendor_commissions` (vendor_id, student_id, amount_brl em **reais**, status PENDING/CONFIRMED/PAID).
- `profiles.commission_rate` em **centavos** (dividir por 100 p/ exibir). Auditoria de comissão via `log_profile_changes` (role SALESPERSON).
- **Estado atual:** 0 vendedores / 0 comissões — camada estava inerte; agora operável.

---

## Convenções do Projeto

- TypeScript estrito (sem `any`)
- Comentários em português
- Deploy automático via Vercel (push para `main`)
- Edge functions: deploy manual via `supabase functions deploy` ou MCP Supabase
- **Dados sensíveis da Wise Wolf** (CNPJ, email, telefone, endereço) **NUNCA no código** — apenas em variáveis de ambiente ou formulários preenchidos pelo usuário
