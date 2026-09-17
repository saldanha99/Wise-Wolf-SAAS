-- ─────────────────────────────────────────────────────────────────────────────
-- COBERTURA COM O PACOTE DO ALUNO (direção, 17/09/2026)
--
-- A coordenação negociava a cobertura com a Bruna na mão pelo WhatsApp:
-- "amanhã 10h o Theo… te passo o contato e o conteúdo". Agora, quando a
-- cobertura é ACEITA (pelo link ou respondendo "sim" ao número da escola), o
-- substituto recebe automaticamente o contato do aluno, nível/objetivo e o
-- conteúdo das últimas aulas; a família é avisada de quem dá a aula; e a
-- Gestão vê o resumo. Tudo pela fila `notification_queue` (instância central,
-- mesma porta do aviso manual), idempotente por cobertura.
-- ─────────────────────────────────────────────────────────────────────────────

-- `management_group_default_actor` nasceu com dono supabase_admin e ACL só
-- para ele; as funções abaixo têm dono postgres e precisam chamá-la.
grant execute on function private.management_group_default_actor(text) to postgres;

create or replace function private.whatsapp_digits(p_phone text)
returns text language sql immutable set search_path = '' as $$
  select case
    when d ~ '^[0-9]{10,11}$' then '55' || d
    when d ~ '^55[0-9]{10,11}$' then d
    else null end
  from (select pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x;
$$;

create or replace function private.weekday_label_pt(p_date date)
returns text language sql immutable set search_path = '' as $$
  select (array['dom','seg','ter','qua','qui','sex','sáb'])[extract(dow from p_date)::int + 1];
$$;

-- Enfileira (a) o pacote para o substituto, (b) o aviso à família e, quando
-- pedido, (c) o resumo no grupo da Gestão. Só para cobertura confirmada.
create or replace function public.coverage_briefing_enqueue(p_coverage_id uuid, p_notify_group boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.class_coverages%rowtype;
  v_student public.profiles%rowtype;
  v_cover public.profiles%rowtype;
  v_original public.profiles%rowtype;
  v_director uuid;
  v_time text;
  v_when text;
  v_duration int := 30;
  v_dow_name text;
  v_slot time;
  v_student_phone text;
  v_cover_phone text;
  v_lessons text := '';
  v_level text;
  v_line text;
  v_r record;
  v_briefing text;
  v_family text;
  v_group text;
  v_group_jid text;
  v_first_cover text;
  v_first_original text;
  v_first_student text;
  v_queued jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select * into c from public.class_coverages where id = p_coverage_id;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'cobertura_nao_encontrada'); end if;
  if lower(coalesce(c.status, '')) <> 'confirmed' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'cobertura_nao_confirmada', 'status', c.status);
  end if;
  select * into v_student from public.profiles where id = c.student_id;
  select * into v_cover from public.profiles where id = c.cover_teacher_id;
  select * into v_original from public.profiles where id = c.original_teacher_id;
  v_director := private.management_group_default_actor(c.tenant_id);
  if v_director is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_diretor_ativo');
  end if;

  v_time := left(coalesce(c.class_time, ''), 5);
  v_when := format('%s %s às %s', private.weekday_label_pt(c.class_date), to_char(c.class_date, 'DD/MM'), v_time);
  v_first_cover := split_part(btrim(coalesce(v_cover.full_name, 'Professor')), ' ', 1);
  v_first_original := split_part(btrim(coalesce(v_original.full_name, 'professor')), ' ', 1);
  v_first_student := split_part(btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);

  -- Duração: aulas de 1 h são dois bookings de 30 min seguidos do mesmo aluno.
  v_dow_name := (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.class_date)::int + 1];
  begin
    v_slot := v_time::time;
    for i in 1..3 loop
      exit when not exists (
        select 1 from public.bookings b
         where b.tenant_id = c.tenant_id and b.student_id = c.student_id
           and b.teacher_id = c.original_teacher_id
           and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
           and public.fold_accents(b.day_of_week) = public.fold_accents(v_dow_name)
           and left(b.time_slot, 5) = left((v_slot + (i * interval '30 minutes'))::text, 5));
      v_duration := v_duration + 30;
    end loop;
  exception when others then v_duration := 30; end;

  -- Nível: `profiles.level` é o da gamificação (XP), não serve. O que vale é
  -- a última avaliação que um professor registrou na aula.
  select l.assessment_level into v_level from public.class_logs l
   where l.student_id = c.student_id and nullif(btrim(l.assessment_level), '') is not null
   order by l.class_date desc nulls last, l.created_at desc limit 1;

  -- Últimas aulas registradas (o que foi feito e o que ficou para a próxima).
  -- Aula de 1 h vira dois lançamentos iguais (dois bookings): linha repetida
  -- é pulada.
  for v_r in
    select l.class_date, l.content, l.next_content, l.content_covered, l.homework_assigned, l.recommended_next_step
      from public.class_logs l
     where l.student_id = c.student_id
       and coalesce(l.content, l.content_covered, l.next_content, l.recommended_next_step) is not null
     order by l.class_date desc nulls last, l.created_at desc
     limit 3
  loop
    v_line := format('• %s: %s', to_char(v_r.class_date, 'DD/MM'),
      left(btrim(coalesce(nullif(v_r.content, ''), nullif(v_r.content_covered, ''), '—')), 160));
    if coalesce(nullif(v_r.next_content, ''), nullif(v_r.recommended_next_step, '')) is not null then
      v_line := v_line || format(' → próx.: %s', left(btrim(coalesce(nullif(v_r.next_content, ''), v_r.recommended_next_step)), 120));
    end if;
    if nullif(v_r.homework_assigned, '') is not null then
      v_line := v_line || format(' (lição: %s)', left(btrim(v_r.homework_assigned), 80));
    end if;
    if v_lessons not like '%' || v_line || '%' then
      v_lessons := v_lessons || v_line || E'\n';
    end if;
  end loop;

  v_student_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
  v_cover_phone := private.whatsapp_digits(coalesce(nullif(v_cover.attendance_phone, ''), nullif(v_cover.phone, '')));

  v_briefing := format(E'Olá %s! 🐺 Cobertura confirmada:\n\n👤 *%s* (aluno de %s)\n📅 %s · %s min\n', v_first_cover,
      btrim(coalesce(v_student.full_name, 'Aluno')), v_first_original, v_when, v_duration)
    || case when v_student_phone is not null
         then format(E'📱 Contato: wa.me/%s%s — combine direto e mande o link da aula.\n', v_student_phone,
                     case when nullif(v_student.guardian_name, '') is not null then format(' (responsável: %s)', v_student.guardian_name) else '' end)
         else E'📱 Contato: sem WhatsApp no cadastro — peça à coordenação.\n' end
    || case when coalesce(v_level, nullif(v_student.learning_objective, '')) is not null
         then format(E'🎯 Nível: %s · Objetivo: %s\n', coalesce(v_level, '—'), coalesce(nullif(v_student.learning_objective, ''), '—'))
         else '' end
    || case when v_student.is_kids then E'🧒 Aluno kids — material Kids na biblioteca.\n' else '' end
    || case when v_lessons <> '' then E'📚 Últimas aulas:\n' || v_lessons else E'📚 Sem registro de aula anterior — comece por diagnóstico e conversa.\n' end
    || E'\nA aula conta no seu pagamento: depois de dar, lance em *Lançar Aula*. Dúvida, responda por aqui.';

  v_family := format('Oi, %s! 🐺 A aula de %s será com a Teacher %s, no lugar de %s. %s vai te chamar pelo WhatsApp para combinar o link. Qualquer dúvida, é só responder aqui.',
      v_first_student, v_when, v_first_cover, v_first_original, v_first_cover);

  v_group := format('✅ *Cobertura aceita:* %s dá a aula de *%s* em %s (de %s). %s recebeu o contato do aluno e o conteúdo das últimas aulas; %s.',
      v_first_cover, btrim(coalesce(v_student.full_name, 'aluno')), v_when, v_first_original, v_first_cover,
      case when v_student_phone is not null then 'a família foi avisada' else 'a família NÃO foi avisada (sem WhatsApp no cadastro)' end);

  if v_cover_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_cover.full_name, v_cover_phone, v_briefing, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:briefing', c.id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;
    if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('briefing'::text); end if;
  end if;
  v_id := null;
  if v_student_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_student.full_name, v_student_phone, v_family, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:family', c.id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;
    if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('family'::text); end if;
  end if;
  v_id := null;
  if p_notify_group then
    select s.destino into v_group_jid from public.dre_report_settings s
     where s.tenant_id = c.tenant_id and s.is_active and s.destino ~ '^[0-9]{10,25}@g[.]us$';
    if v_group_jid is not null then
      insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
          source_type, class_date, notification_kind, idempotency_key)
      values (c.tenant_id, v_director, 'Gestão', v_group_jid, v_group, pg_catalog.now(), 'pending',
          'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:group', c.id))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
      returning id into v_id;
      if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('group'::text); end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'queued', v_queued, 'student_phone_known', v_student_phone is not null,
    'cover_phone_known', v_cover_phone is not null, 'briefing', v_briefing);
end $$;

-- Aceite/recusa pelo link ou pelo texto, com o pacote atrás: mesma decisão de
-- sempre (`resolve_coverage_invite`), mais o enfileiramento.
create or replace function public.resolve_coverage_invite_and_brief(p_token text, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_coverage_id uuid;
  v_brief jsonb;
  v_group_jid text;
  v_tenant text;
  v_text text;
  v_director uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select id, tenant_id into v_coverage_id, v_tenant from public.class_coverages where token = lower(coalesce(p_token, ''));
  v_result := public.resolve_coverage_invite(p_token, p_accept);
  if coalesce((v_result ->> 'ok')::boolean, false) and p_accept and v_coverage_id is not null then
    v_brief := public.coverage_briefing_enqueue(v_coverage_id, true);
    v_result := v_result || pg_catalog.jsonb_build_object('coverage_id', v_coverage_id, 'briefing', v_brief);
  elsif coalesce((v_result ->> 'ok')::boolean, false) and not p_accept and v_coverage_id is not null then
    -- Recusa também é notícia para a Gestão: alguém precisa procurar outro.
    v_director := private.management_group_default_actor(v_tenant);
    select s.destino into v_group_jid from public.dre_report_settings s
     where s.tenant_id = v_tenant and s.is_active and s.destino ~ '^[0-9]{10,25}@g[.]us$';
    select format('❌ *Cobertura recusada:* %s não pode dar a aula de *%s* em %s %s às %s (de %s). Precisa de outro substituto.',
             split_part(btrim(coalesce(ct.full_name, 'Professor')), ' ', 1), coalesce(s.full_name, 'aluno'),
             private.weekday_label_pt(c.class_date), to_char(c.class_date, 'DD/MM'), left(coalesce(c.class_time, ''), 5),
             split_part(btrim(coalesce(ot.full_name, 'professor')), ' ', 1))
      into v_text
      from public.class_coverages c
      left join public.profiles ct on ct.id = c.cover_teacher_id
      left join public.profiles ot on ot.id = c.original_teacher_id
      left join public.profiles s on s.id = c.student_id
     where c.id = v_coverage_id;
    if v_group_jid is not null and v_director is not null and v_text is not null then
      insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
          source_type, notification_kind, idempotency_key)
      values (v_tenant, v_director, 'Gestão', v_group_jid, v_text, pg_catalog.now(), 'pending',
          'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('coverage:%s:declined', v_coverage_id))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
    end if;
    v_result := v_result || pg_catalog.jsonb_build_object('coverage_id', v_coverage_id);
  end if;
  return v_result;
end $$;

-- Convites pendentes do substituto, para ele poder responder "sim" pelo
-- número da escola em vez de abrir o link.
create or replace function public.teacher_pending_coverage_invites(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'coverage_id', c.id, 'token', c.token, 'class_date', c.class_date, 'class_time', left(coalesce(c.class_time, ''), 5),
           'when', private.weekday_label_pt(c.class_date) || ' ' || to_char(c.class_date, 'DD/MM') || ' às ' || left(coalesce(c.class_time, ''), 5),
           'student_name', coalesce(s.full_name, 'Aluno'), 'original_teacher_name', coalesce(ot.full_name, 'professor'))
           order by c.class_date, c.class_time), '[]'::jsonb)
    from public.class_coverages c
    left join public.profiles s on s.id = c.student_id
    left join public.profiles ot on ot.id = c.original_teacher_id
   where c.tenant_id = p_tenant and c.cover_teacher_id = p_teacher
     and lower(coalesce(c.status, '')) = 'pending'
     and c.token ~ '^[0-9a-f]{32}$'
     and (c.invite_expires_at is null or c.invite_expires_at > pg_catalog.now())
     and c.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
$$;

do $owners$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where (s.nspname = 'public' and p.proname in ('coverage_briefing_enqueue', 'resolve_coverage_invite_and_brief', 'teacher_pending_coverage_invites'))
              or (s.nspname = 'private' and p.proname in ('whatsapp_digits', 'weekday_label_pt'))
  loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $owners$;
