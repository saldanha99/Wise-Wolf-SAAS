-- ─────────────────────────────────────────────────────────────────────────────
-- LANÇAMENTO DE AULA — RPC TRANSACIONAL (fonte ÚNICA da regra)
--
-- POR QUE EXISTE
-- Até aqui o lançamento era um `insert` direto feito pelo NAVEGADOR, copiado em
-- duas telas (`LessonLauncher` e `PendingLessons`) que divergiram na regra:
--   • `PendingLessons` não gerava reposição para TEACHER_ABSENCE — o professor
--     que faltava e regularizava por ali perdia o único caminho de receber
--     aquela aula de volta;
--   • `PendingLessons` gravava a reposição SEM `fault_type`, e sempre com
--     subtype 'REPOSIÇÃO' — nunca 'REPOSIÇÃO_PROF';
--   • o limite de 5 reposições/mês era contado sem filtrar `fault_type`.
-- Efeito medido em produção (04/08/2026): 98 reposições no banco (9 por falta do
-- professor) e ZERO aulas jamais gravadas como 'REPOSIÇÃO_PROF'. Ou seja: nenhuma
-- reposição de falta do professor foi paga na história do sistema, embora
-- `v_payable_class_logs` já saiba pagá-la corretamente.
--
-- A REGRA (confirmada em `v_payable_class_logs`, que NÃO é alterada aqui)
--   • falta do PROFESSOR  → não paga; gera reposição `fault_type='TEACHER'`
--   • reposição de falta do PROFESSOR → subtype 'REPOSIÇÃO_PROF' → PAGA
--   • falta do ALUNO      → paga (o professor compareceu); gera reposição
--     `fault_type='STUDENT'`, limitada a 5/mês
--   • reposição de falta do ALUNO → subtype 'REPOSIÇÃO' → NÃO paga (a aula de
--     origem já foi remunerada; pagar de novo seria duplicar)
-- O subtype passa a ser DERIVADO NO SERVIDOR a partir de `reschedules.fault_type`.
-- O navegador não escolhe mais quanto uma aula vale — nem por acidente.
--
-- ATOMICIDADE
-- Gravar a aula, consumir a reposição usada, criar a reposição da falta e mover o
-- lead do CRM eram 4 chamadas separadas do navegador. Caindo a rede no meio,
-- metade acontecia e ninguém ficava sabendo. Agora é uma transação só.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.log_teacher_classes(p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_teacher_id uuid := auth.uid();
  v_profile record;
  v_entry jsonb;
  v_count int;

  -- por entrada
  v_ref text;
  v_booking_id text;
  v_reschedule_id text;
  v_appointment_id text;
  v_student_id uuid;
  v_class_date date;
  v_presence text;
  v_kind text;
  v_subtype text;
  v_fault_origin text;
  v_appt_type text;
  v_new_id uuid;
  v_skip_reason text;
  v_student_absence_count int;

  v_results jsonb := '[]'::jsonb;
  v_inserted_ids uuid[] := array[]::uuid[];
  v_inserted int := 0;
  v_skipped int := 0;
  v_reschedules_created int := 0;

  v_delta_amount numeric := 0;
  v_delta_lessons int := 0;
  v_projection jsonb;
begin
  ---------------------------------------------------------------------------
  -- 1. Autenticação e escopo. `teacher_id` é SEMPRE auth.uid(): não existe
  --    parâmetro para lançar aula em nome de outra pessoa.
  ---------------------------------------------------------------------------
  if v_teacher_id is null or auth.role() <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select p.id, p.tenant_id, p.role
    into v_profile
    from public.profiles p
   where p.id = v_teacher_id;

  if not found
     or v_profile.tenant_id is null
     or v_profile.role not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;

  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_entries';
  end if;

  v_count := pg_catalog.jsonb_array_length(p_entries);
  if v_count < 1 or v_count > 100 then
    raise exception using errcode = '22023', message = 'invalid_entries_length';
  end if;

  ---------------------------------------------------------------------------
  -- 2. Uma entrada por vez. Nada aqui aborta o lote: entrada inválida ou já
  --    lançada vira `skipped` com motivo, e o resto do lote grava normalmente.
  --    (Antes, um 23505 no meio derrubava o insert inteiro e o professor
  --    relançava tudo na mão.)
  ---------------------------------------------------------------------------
  for v_entry in select value from pg_catalog.jsonb_array_elements(p_entries)
  loop
    v_ref := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'ref', '')), '');
    v_booking_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'booking_id', '')), '');
    v_reschedule_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'reschedule_id', '')), '');
    v_appointment_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'appointment_id', '')), '');
    v_presence := pg_catalog.btrim(coalesce(v_entry ->> 'presence', 'COMPLETED'));
    v_skip_reason := null;
    v_new_id := null;
    v_student_id := null;
    v_class_date := null;

    -- student_id / class_date com validação de formato (entrada do navegador)
    begin
      v_student_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'student_id', '')), '')::uuid;
    exception when others then
      v_student_id := null;
    end;

    begin
      v_class_date := (v_entry ->> 'class_date')::date;
    exception when others then
      v_class_date := null;
    end;

    if v_class_date is null then
      v_skip_reason := 'data_invalida';
    elsif v_class_date > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
      -- aula no futuro nunca aconteceu: bloquear é mais barato que estornar
      v_skip_reason := 'aula_no_futuro';
    elsif v_class_date < ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 120) then
      v_skip_reason := 'fora_da_janela';
    elsif v_presence not in ('COMPLETED', 'STUDENT_ABSENCE', 'TEACHER_ABSENCE', 'Falta Justificada') then
      v_skip_reason := 'presenca_invalida';
    elsif v_booking_id is null and v_reschedule_id is null and v_appointment_id is null then
      v_skip_reason := 'sem_origem';
    end if;

    -----------------------------------------------------------------------
    -- 2a. A ORIGEM é deduzida do banco, não do que o cliente diz que é.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      if v_reschedule_id is not null then
        v_kind := 'REPOSICAO';

        select r.fault_type, r.student_id
          into v_fault_origin, v_student_id
          from public.reschedules r
         where r.id::text = v_reschedule_id
           and r.teacher_id = v_teacher_id;

        if not found then
          v_skip_reason := 'reposicao_inexistente';
        else
          -- AQUI mora a correção: quem decide se a reposição paga é a ORIGEM
          -- registrada no banco. Falta do professor → 'REPOSIÇÃO_PROF' (paga).
          -- Falta do aluno (ou origem desconhecida) → 'REPOSIÇÃO' (não paga).
          v_subtype := case
            when v_fault_origin = 'TEACHER' then 'REPOSIÇÃO_PROF'
            else 'REPOSIÇÃO'
          end;
        end if;

      elsif v_appointment_id is not null then
        select lower(coalesce(a.type, 'experimental'))
          into v_appt_type
          from public.appointments a
         where a.id::text = v_appointment_id;

        if v_appt_type = 'training' then
          v_kind := 'TRAINING';
          v_subtype := 'TREINAMENTO';
        else
          v_kind := 'TRIAL';
          v_subtype := 'AULA EXPERIMENTAL';
        end if;
        v_student_id := null; -- experimental/treino é lead, não aluno matriculado

      else
        v_kind := 'REGULAR';

        -- COBERTURA: quem lança é quem DEU a aula, não necessariamente o dono do
        -- agendamento. Aula assumida (`class_coverages.cover_teacher_id`) usa o
        -- booking do professor original — validar só por `b.teacher_id` recusaria
        -- o lançamento de quem realmente trabalhou.
        select b.student_id
          into v_student_id
          from public.bookings b
         where b.id::text = v_booking_id
           and (
             b.teacher_id = v_teacher_id
             or exists (
               select 1
                 from public.class_coverages c
                where c.booking_id = b.id
                  and c.class_date = v_class_date
                  and c.status = 'confirmed'
                  and c.cover_teacher_id = v_teacher_id
             )
           );

        if not found then
          v_skip_reason := 'agendamento_inexistente';

        -- E o inverso: quem CEDEU a aula não pode lançá-la. A tela já esconde,
        -- mas a trava do dinheiro tem de estar no servidor — lançar aula cedida
        -- pagaria dois professores pela mesma hora.
        elsif exists (
          select 1
            from public.class_coverages c
           where c.booking_id::text = v_booking_id
             and c.class_date = v_class_date
             and c.status = 'confirmed'
             and c.original_teacher_id = v_teacher_id
             and c.cover_teacher_id is distinct from v_teacher_id
        ) then
          v_skip_reason := 'aula_cedida_para_outro_professor';

        else
          -- Motivo da falta (Doença/Trabalho/Viagem/Outros) só quando houve falta.
          v_subtype := case
            when v_presence = 'COMPLETED' then null
            else nullif(pg_catalog.btrim(coalesce(v_entry ->> 'absence_reason', '')), '')
          end;
        end if;
      end if;
    end if;

    -----------------------------------------------------------------------
    -- 2b. Anti-duplicata NO SERVIDOR. O guard antigo vivia no navegador e era
    --     fail-open: numa queda de rede ele liberava tudo.
    --     Regras/índices já cobrem a MESMA origem (booking+data, reposição,
    --     appointment). O que falta cobrir é a origem CRUZADA: a aula lançada
    --     como regular e RELANÇADA como reposição — foi esse padrão que
    --     duplicou a folha de junho/2026.
    --     ⚠️ Aluno com dois horários no mesmo dia (19:00 + 19:30) é aula de 1h
    --     partida, NÃO duplicata: por isso o cruzamento só barra REPOSIÇÃO, e
    --     nunca dois bookings distintos.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      if v_kind = 'REGULAR' and exists (
        select 1 from public.class_logs cl
         where cl.booking_id = v_booking_id and cl.class_date = v_class_date
      ) then
        v_skip_reason := 'ja_lancada';

      elsif v_kind = 'REPOSICAO' and exists (
        select 1 from public.class_logs cl where cl.reschedule_id = v_reschedule_id
      ) then
        v_skip_reason := 'ja_lancada';

      elsif v_kind = 'REPOSICAO' and v_student_id is not null and exists (
        select 1 from public.class_logs cl
         where cl.teacher_id = v_teacher_id
           and cl.student_id = v_student_id
           and cl.class_date = v_class_date
      ) then
        v_skip_reason := 'aluno_ja_tem_aula_nesta_data';

      elsif v_kind in ('TRIAL', 'TRAINING') and exists (
        select 1 from public.class_logs cl where cl.appointment_id = v_appointment_id
      ) then
        v_skip_reason := 'ja_lancada';
      end if;
    end if;

    -----------------------------------------------------------------------
    -- 2c. Grava.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      insert into public.class_logs (
        tenant_id, teacher_id, student_id,
        booking_id, reschedule_id, appointment_id,
        presence, subtype,
        content_covered, content, observations,
        assessment_level, psychological_profile, teacher_verdict,
        class_date, created_at
      ) values (
        v_profile.tenant_id, v_teacher_id, v_student_id,
        case when v_kind = 'REGULAR' then v_booking_id else null end,
        case when v_kind = 'REPOSICAO' then v_reschedule_id else null end,
        case when v_kind in ('TRIAL', 'TRAINING') then v_appointment_id else null end,
        v_presence, v_subtype,
        nullif(pg_catalog.btrim(coalesce(v_entry ->> 'content_covered', '')), ''),
        nullif(pg_catalog.btrim(coalesce(v_entry ->> 'content_covered', '')), ''),
        nullif(pg_catalog.btrim(coalesce(v_entry ->> 'observations', '')), ''),
        case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'assessment_level', '')), '') end,
        case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'psychological_profile', '')), '') end,
        case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'teacher_verdict', '')), '') end,
        v_class_date, pg_catalog.now()
      )
      returning id into v_new_id;

      v_inserted := v_inserted + 1;
      v_inserted_ids := pg_catalog.array_append(v_inserted_ids, v_new_id);

      ---------------------------------------------------------------------
      -- 2d. Consome a reposição — MARCA `used_at`, não apaga.
      --     Apagar destruía a prova de quem faltou (`reschedules.fault_type`),
      --     e é ela que decide se a reposição paga. Com a linha apagada, 12 dos
      --     13 class_logs ficaram apontando para nada e a regra nunca disparou
      --     (diagnóstico do commit 0bd4053). A lista de pendentes já filtra por
      --     "existe class_log apontando para esta reposição?", então a linha
      --     consumida não reaparece para lançar.
      ---------------------------------------------------------------------
      if v_kind = 'REPOSICAO' then
        update public.reschedules r
           set used_at = pg_catalog.now()
         where r.id::text = v_reschedule_id
           and r.teacher_id = v_teacher_id
           and r.used_at is null;
      end if;

      ---------------------------------------------------------------------
      -- 2e. Falta gera reposição — e a ORIGEM fica gravada, que é o que
      --     permite pagar a reposição do professor lá na frente.
      --     Falta do professor: ilimitada (é o único caminho dele receber).
      --     Falta do aluno: 5 por mês.
      ---------------------------------------------------------------------
      if v_presence in ('TEACHER_ABSENCE', 'STUDENT_ABSENCE', 'Falta Justificada')
         and v_student_id is not null
         and coalesce(v_subtype, '') not in ('REPOSIÇÃO', 'REPOSIÇÃO_PROF')
      then
        if v_presence = 'TEACHER_ABSENCE' then
          insert into public.reschedules (
            tenant_id, teacher_id, student_id, original_booking_id,
            date, time, fault_type, created_at
          ) values (
            v_profile.tenant_id, v_teacher_id, v_student_id,
            case when v_kind = 'REGULAR' then v_booking_id::uuid else null end,
            'Pendente', 'Pendente', 'TEACHER', pg_catalog.now()
          );
          v_reschedules_created := v_reschedules_created + 1;
        else
          select count(*)::int
            into v_student_absence_count
            from public.reschedules r
           where r.student_id = v_student_id
             and r.fault_type = 'STUDENT'
             and r.created_at >= pg_catalog.date_trunc('month', pg_catalog.now());

          if v_student_absence_count < 5 then
            insert into public.reschedules (
              tenant_id, teacher_id, student_id, original_booking_id,
              date, time, fault_type, created_at
            ) values (
              v_profile.tenant_id, v_teacher_id, v_student_id,
              case when v_kind = 'REGULAR' then v_booking_id::uuid else null end,
              'Pendente', 'Pendente', 'STUDENT', pg_catalog.now()
            );
            v_reschedules_created := v_reschedules_created + 1;
          end if;
        end if;
      end if;

      ---------------------------------------------------------------------
      -- 2f. Experimental lançada move o lead no CRM.
      ---------------------------------------------------------------------
      if v_kind = 'TRIAL' then
        update public.crm_leads l
           set status = 'TRIAL_DONE'
         where l.tenant_id = v_profile.tenant_id
           and l.phone is not null
           and l.phone in (
             select a.student_phone from public.appointments a
              where a.id::text = v_appointment_id and a.student_phone is not null
           );
      end if;

    else
      v_skipped := v_skipped + 1;
    end if;

    v_results := v_results || pg_catalog.jsonb_build_object(
      'ref', v_ref,
      'id', v_new_id,
      'status', case when v_skip_reason is null then 'lancada' else 'ignorada' end,
      'reason', v_skip_reason,
      'kind', v_kind,
      'subtype', v_subtype
    );
  end loop;

  ---------------------------------------------------------------------------
  -- 3. Quanto isso virou de caixa — pela MESMA fonte que paga o professor
  --    (`v_payable_class_logs`). Nada de `aulas × tarifa` estimado: o valor por
  --    aula muda conforme a posição de antiguidade do aluno na carteira e o
  --    estado do turbo. Estimar aqui reproduziria exatamente a divergência que
  --    já gerou contestação em série no painel Financeiro.
  ---------------------------------------------------------------------------
  if pg_catalog.array_length(v_inserted_ids, 1) > 0 then
    select coalesce(sum(v.rate_efetivo), 0), count(*)::int
      into v_delta_amount, v_delta_lessons
      from public.v_payable_class_logs v
     where v.id = any(v_inserted_ids);

    -- Cada aula lançada recebe seu valor real (0 quando não entra na folha) e o
    -- motivo — é o que deixa a tela dizer a verdade em vez de fingir festa.
    select pg_catalog.jsonb_agg(
             r || pg_catalog.jsonb_build_object(
               'amount', coalesce(pay.rate_efetivo, 0),
               'paid', pay.id is not null,
               'unpaid_reason', case
                 when pay.id is not null then null
                 when r ->> 'id' is null then null
                 when cl.presence in ('TEACHER_ABSENCE', 'Falta do Professor') then 'falta_professor'
                 when cl.subtype = 'REPOSIÇÃO' then 'reposicao_falta_aluno'
                 when cl.subtype = 'Teste Oral' then 'teste_oral'
                 when coalesce(cl.payment_hold, false) then 'em_conferencia'
                 when cl.student_id is not null
                      and not public.is_billable_student(cl.student_id) then 'aluno_nao_faturavel'
                 else 'fora_da_folha'
               end
             )
           )
      into v_results
      from pg_catalog.jsonb_array_elements(v_results) r
      left join public.class_logs cl on cl.id::text = (r ->> 'id')
      left join public.v_payable_class_logs pay on pay.id::text = (r ->> 'id');
  end if;

  v_projection := public.teacher_pay_projection(v_teacher_id);

  return pg_catalog.jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_skipped,
    'reschedules_created', v_reschedules_created,
    'delta_amount', v_delta_amount,
    'delta_lessons', v_delta_lessons,
    'month_amount', coalesce((v_projection ->> 'amount_logged')::numeric, 0),
    'month_lessons', coalesce((v_projection ->> 'lessons_logged')::int, 0),
    'turbo_active', coalesce((v_projection -> 'turbo' ->> 'active')::boolean, false),
    'entries', coalesce(v_results, '[]'::jsonb)
  );
end;
$$;

comment on function public.log_teacher_classes(jsonb) is
  'Lançamento de aula transacional. Deriva subtype da origem real (REPOSIÇÃO_PROF quando a reposição vem de falta do professor), barra duplicata no servidor, gera a reposição com fault_type e devolve o valor autoritativo que entrou no caixa do professor.';

-- A migration é aplicada como `supabase_admin`, que é SUPERUSER. Uma função
-- SECURITY DEFINER roda com os poderes do DONO — deixá-la com esse dono daria
-- superusuário a qualquer aluno autenticado que chamasse a RPC. Passa para
-- `postgres`, que é o dono das demais funções do projeto (teacher_pay_projection etc).
alter function public.log_teacher_classes(jsonb) owner to postgres;

revoke all on function public.log_teacher_classes(jsonb) from public, anon;
grant execute on function public.log_teacher_classes(jsonb) to authenticated, service_role;
