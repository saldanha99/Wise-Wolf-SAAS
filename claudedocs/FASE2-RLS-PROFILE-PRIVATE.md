# Fase 2 RLS — esconder pay/PII de `profiles` dentro do tenant

> Status: PLANEJADO. O vazamento **cross-tenant** (crítico) já está fechado.
> Isto trata a exposição **dentro da mesma escola**: hoje qualquer usuário
> autenticado do tenant consegue, via anon key, ler `hourly_rate`, `pix_key`,
> `commission_rate` (e `cpf`/`rg`) de outros. Não é só refactor — toca o
> fluxo de login e a folha, então exige cuidado e teste.

## Design escolhido (seguro): REVOKE de coluna + RPCs definer
- NÃO mover colunas (mover quebraria as funções SQL de folha — `run_monthly_teacher_closing`,
  `get_teacher_activity_report`, `list_teachers_overview`, `get_cashflow` — que leem
  `profiles.hourly_rate` direto → risco de pagar errado).
- Em vez disso: `REVOKE SELECT ON profiles FROM authenticated, anon` (nível-tabela) +
  `GRANT SELECT (<todas menos o trio>) ON profiles TO authenticated, anon` (nível-coluna).
- Funções `SECURITY DEFINER` rodam como dono → continuam lendo o trio normalmente
  (folha intacta). Cliente que pede coluna proibida → erro 42501 (barulhento, fácil de pegar).

## Fato empírico confirmado (testado em tabela descartável)
- Com grant só de coluna, o PostgREST **NÃO** omite a coluna no `select('*')`: ele
  **falha** com `42501 permission denied for table`. Logo, TODO `select('*')` em
  profiles precisa virar lista explícita de colunas ANTES do REVOKE.

## Sequência segura (cada fase verificada via agent-browser)
1. Frontend: trocar `select('*')` por colunas explícitas (sem o trio) + criar RPCs
   definer p/ os reads legítimos do trio (self e admin). Deploy.
2. Verificar no browser (login + telas financeiras) — colunas ainda existem, nada quebra.
3. Migration: revoke nível-tabela + grant nível-coluna (fecha o vazamento).
4. Verificar de novo: aluno NÃO lê trio (42501); admin/prof leem via RPC; folha OK.

## Superfície exata — 18 sites client-side (grep em 13/06)
### `select('*')` em profiles (precisam virar lista explícita) — ALTO CUIDADO
- components/Login.tsx:36, :76  ← FLUXO DE LOGIN (mais crítico; testar primeiro)
- App.tsx:165 (teachers), :172 (students)
- components/StudentsList.tsx:46
- components/LessonPlannerAI.tsx:63 (student)
- components/SuperAdminDashboard.tsx:60 (count head — provavelmente ok, é count)
- components/ContractView.tsx:35
- components/TeacherScheduleExplorer.tsx:86
- components/TeacherProfile.tsx:51
- components/PedagogicalConfig.tsx:132

### Reads explícitos do trio (precisam de RPC definer self/admin)
- components/TeacherFinancials.tsx:76  → `select('hourly_rate').eq('id', user.id)` (SELF)
- components/TeacherPixSettings.tsx:33 → `select('pix_key, pix_key_type')` (SELF)
- components/FinancialClosingModal.tsx:55 → `select('hourly_rate')` (admin)
- components/SchoolAdminDashboard.tsx:131 → `select('id, hourly_rate')` (admin)
- components/FinancialReport.tsx:68 → `select('id, full_name, avatar_url, hourly_rate')` (admin)
- components/VendorDashboard.tsx:39 → `select('commission_rate')` (self vendor)
- components/PublicRegistration.tsx:438 → `select('commission_rate')` (lê do vendor indicado)

### RPCs definer a criar
- `get_my_pay()` → retorna hourly_rate/pix_key/commission_rate do próprio auth.uid().
- `get_tenant_teacher_pay()` (admin) → lista {id, hourly_rate} do tenant (p/ os painéis admin).
- (commission do vendor indicado no PublicRegistration: já existe lógica; pode ir por RPC.)

## cpf / rg (PII) — FASE 2B, ainda mais arriscado
- cpf é ESCRITO no fluxo de matrícula (PublicRegistration → asaasService → ASAAS) e lido
  em 11 arquivos. Mexer aqui sem teste e2e de matrícula (cria cobrança real) é perigoso.
  Tratar separado, depois do trio financeiro estar estável.

## Verificação (logins de teste já validados em 13/06)
- Diretor: abrir Repasse a Profs / Fechamento / Fluxo de Caixa / Mensalidades.
  BASELINE atual (Repasse a Profs): Faturamento R$ 9.862,00 / R$ 1.899,00; tabela por
  professor (R$ 229, 299, 271, 279, 149, 169, 188, 377…); "Fechamentos pendentes 12".
  Após o refactor, esses valores DEVEM permanecer idênticos.
- Professor: abrir Financeiro / PIX (deve ver o próprio hourly_rate/pix via RPC).
- Teste do leak: como STUDENT, `from('profiles').select('hourly_rate')` deve dar 42501.
