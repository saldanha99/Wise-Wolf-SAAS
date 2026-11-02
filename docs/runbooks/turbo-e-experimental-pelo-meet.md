# Turbo em reais e experimental conferida pelo Meet

Migration `20261101020000_turbo_visivel_e_experimental_pelo_meet.sql`, teste
`supabase/tests/turbo_visivel_e_experimental_pelo_meet.sql`. Decisão da direção
em 31/10/2026.

## 1. Turbo em reais

**Conta:** para cada aula paga do mês (`v_payable_class_logs`), extra =
`rate_efetivo − tarifa sem Turbo`, só quando a aula foi paga pela régua das
faixas (sem `rate_override`, sem valor de cobertura oferecido, sem tarifa de
treinador) num dia com `teacher_turbo_on`. Tarifa sem Turbo =
`private.teacher_rate_without_turbo` (a mesma régua de `teacher_student_rate`
antes do teste do Turbo).

- `private.turbo_lessons(tenant, mês)` → aula a aula;
  `private.turbo_month_summary` → por professor e por aluno.
- `public.teacher_turbo_earnings(professor, mês)` → card do professor
  (`TeacherTurboCard`). O próprio professor lê só o dele; direção/coordenação
  leem qualquer professor da escola.
- `private.payroll_month_rows_with_turbo` embrulha `payroll_month_rows` e
  acrescenta `turbo` por professor e `total_turbo`. `gestao_payroll_summary`
  (grupo do Financeiro) e `payroll_month_preview` (Repasse a Profs) passaram a
  chamar o embrulho. `payroll_month_rows` não foi tocada.
- ⚠️ O Balancete por Professor classifica como "turbo" qualquer aula acima da
  faixa 1. Em out/2026 isso dava R$ 5,00 a mais (duas aulas da Bruna pagas com o
  valor de cobertura oferecido pela direção). A conta nova é a certa; o
  Balancete ficou como estava.

Conferência em 01/11/2026 (rollback): set/2026 = R$ 117,50 nas duas contas.

## 2. Experimental conferida pelo Meet

**Liga por escola:** `private.trial_meet_settings` (sem linha = desligado). A
Wise Wolf nasce ligada, com 10 minutos mínimos. Desligar:
`update private.trial_meet_settings set enabled = false where tenant_id = '…'`.
Também exige na edge `GOOGLE_MEET_PEDAGOGY_ENABLED` e
`GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED` e a conta central conectada com o
escopo `drive` (leitura da planilha de presença).

**Fluxo (cron do `google-meet`, a cada 15 min, depois da fila das aulas):**

1. **Sala:** experimental `CLAIMED` nos próximos 30 dias (antes de
   `20261102140000` eram 24 h: a sala só nascia na véspera), professor com conta
   Google confirmada e sem link registrado no appointment →
   `createSpace({ attendanceReport: true, artifacts: false })` (transcrição e
   anotações do Gemini **desligadas**: o lead não aceitou termo), professor como
   coanfitrião, e só então `appointments.meeting_link = meeting_uri`. Falha
   tenta de novo (15 min × tentativas, até 5). Sem coanfitrião, nenhum link sai.
2. **Link:** o briefing do professor (`trial_teacher_briefings`) usa o link do
   appointment antes do link pessoal; o `funnel-sweeper` (bloco H) manda o link
   ao lead uma vez, assim que a sala fica pronta (antes: só 6 h antes) (`automation_sent` kind `TRIAL_MEET_LINK`),
   dizendo que só entrada e saída são registradas. O atendimento ("qual o
   link?") já lia `appointments.meeting_link`.
3. **Conferência:** 40 min depois do início, até 6 h. Conferência aberta
   espera. Lê a planilha de presença (código da sala no nome) e decide em
   `google-meet/trial-rooms.ts`:

| Resultado | Quando | Efeito |
|---|---|---|
| `ATTENDED` | professor e lead ≥ 10 min | lança `class_logs` AULA EXPERIMENTAL e `appointments.status = completed` (paga) |
| `NO_SHOW` | professor ≥ 10 min, lead < 1 min | `appointments.status = no_show` |
| `CONFLICT` | `NO_SHOW` mas o professor já lançou como dada | nada muda; fica no painel |
| `TEACHER_ABSENT` | professor < 1 min | fica no painel |
| `UNCERTAIN` | presença curta ou planilha ilegível | fica no painel |
| `NO_CONFERENCE` / `NO_REPORT` | depois de 6 h sem sala usada / sem planilha | fica no painel |

O painel "Liquidar" (`TrialTrainingSettlement`) mostra o motivo de cada aula que
sobrou. A aula comprovada sai da lista sozinha.

**Privacidade:** `private.trial_meet_rooms.evidence` guarda só números
(segundos, horário de entrada, contagem). Nada de planilha, nome ou e-mail do
lead. A mensagem ao lead avisa que só entrada e saída são registradas.
Recomendado passar pelo jurídico (presença de lead sem contrato).

**Diagnóstico:**

```sql
select appointment_id, state, outcome, evidence, error_code, attempts
  from private.trial_meet_rooms order by created_at desc limit 20;
```

e `docker logs supabase-edge-functions --since 1h | grep trial` na VPS.
Treinamento não entra (o appointment é da trainer); continua manual.

## 3. Links das aulas num lugar só (02/11/2026)

Migration `20261102140000_links_das_aulas_e_experimental_no_aceite.sql`, teste
`supabase/tests/links_das_aulas_e_experimental_no_aceite.sql`.

`public.my_lesson_links(p_from, p_to)` (logado; até 14 dias) devolve as aulas
do período com o link que vale, pela mesma regra de `lib/lessonRooms.ts`:
sala da escola pronta → `escola`; sala prevista e ainda não pronta (com aceite,
mais de 15 min antes) → `preparando`, sem link; senão o link pessoal do aluno →
`pessoal`; nada → `sem_link`. Experimental entra para o professor e a direção.
Aluno vê só as dele; professor, as dele; direção e coordenação, todas, mais o
e-mail da conta central.

Usam essa resposta: a aba **Links** (aluno e professor), o **aviso de 10
minutos** (`LessonStartingSoon`, aberto para aluno e professor logados, de 10
min antes a 10 min depois do início; fechar vale para aquela aula no
aparelho) e o **Ao vivo** da direção (menu Dia a dia → Ao vivo).

**Ao vivo / "entrar fantasma":** a sala da escola é da conta central; o link
abre com `?authuser=<conta central>` e entra direto, sem pedir para
participar. O Google Meet não tem participante invisível — o nome aparece na
lista. Link pessoal exige ser admitido.

⚠️ Professor que pediu para não registrar as aulas (Mateus, 28/09) não ganha
sala da escola: as aulas dele seguem no link pessoal do aluno ou ficam
`sem_link` quando o aluno não tem link cadastrado.
