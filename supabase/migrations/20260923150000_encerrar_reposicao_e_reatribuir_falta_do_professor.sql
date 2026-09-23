-- Encerrar reposição sem dar a aula, e reatribuir a de falta do professor.
--
-- Levantamento de 23/09/2026 (196 reposições abertas, 30 alunos) e decisão da
-- direção: encerrar o balde A (aluno saiu / inativo / sem agenda — não há a quem
-- dar a aula) e reatribuir o balde B (falta do PROFESSOR pendurada em professor
-- que não dá mais aula para aquele aluno).
--
-- POR QUE `used_at` E NÃO UMA COLUNA DE STATUS NOVA: os ~20 leitores de
-- reposição aberta (telas do aluno e do professor, `_teacher_can_access_student`,
-- `reschedule_backlog_summary`, `director_pending_counts`, edges de agenda) já
-- filtram `used_at is null` = "ainda em aberto". Conferido um a um: NENHUM deles
-- lê `used_at` preenchido como "aula dada" para pagamento — quem paga é
-- `class_logs`. Então encerrar é marcar `used_at`, e `closed_reason`/`closed_by`
-- é o que distingue "encerrada pela direção" de "consumida por uma aula". Uma
-- coluna de status nova obrigaria a mexer nos 20 leitores para o mesmo efeito.
--
-- ⚠️ O único lugar que interpretava `used_at` preenchido era o trigger de
-- eventos, que emitiria 'dada'. Ele passa a emitir 'encerrada' quando há motivo
-- de encerramento — senão a trilha diria que a aula aconteceu.

alter table public.reschedules
  add column if not exists closed_by uuid references public.profiles(id),
  add column if not exists closed_reason text;

comment on column public.reschedules.closed_reason is
  'Preenchido quando used_at foi marcado SEM aula dada (encerramento administrativo). Nulo = used_at veio de class_log.';

-- 'encerrada' entra na trilha.
alter table public.reschedule_events drop constraint if exists reschedule_events_action_check;
alter table public.reschedule_events add constraint reschedule_events_action_check
  check (action in ('criada','marcada','remarcada','desmarcada','professor_trocado',
                    'atestada','dada','encerrada'));

-- Encerramento é campo de servidor, como o atestado: só pela RPC.
create or replace function private.reschedule_server_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public._my_role();
begin
  if (new.attested_by is distinct from old.attested_by
      or new.attested_at is distinct from old.attested_at
      or new.attestation_reason is distinct from old.attestation_reason)
     and coalesce(pg_catalog.current_setting('app.reschedule_attest', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'reschedule_attestation_is_server_only';
  end if;
  if (new.closed_by is distinct from old.closed_by
      or new.closed_reason is distinct from old.closed_reason)
     and coalesce(pg_catalog.current_setting('app.reschedule_close', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'reschedule_closure_is_server_only';
  end if;
  if new.fault_type is distinct from old.fault_type
     and coalesce(auth.role(), '') <> 'service_role'
     -- session_user é forma especial do SQL (como nullif): sem prefixo pg_catalog.
     and session_user not in ('postgres', 'supabase_admin')
     and coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'reschedule_fault_type_is_server_only';
  end if;
  return new;
end;
$$;
alter function private.reschedule_server_fields_guard() owner to postgres;
revoke all on function private.reschedule_server_fields_guard() from public, anon, authenticated, service_role;
drop trigger if exists trg_aa_reschedule_server_fields_guard on public.reschedules;
create trigger trg_aa_reschedule_server_fields_guard
  before update on public.reschedules
  for each row execute function private.reschedule_server_fields_guard();

create or replace function public.close_reschedule(p_reschedule_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_reschedule public.reschedules%rowtype;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  v_closer uuid;
begin
  select reschedule.* into v_reschedule from public.reschedules as reschedule
   where reschedule.id = p_reschedule_id for update of reschedule;
  if not found then
    raise exception using errcode = 'P0002', message = 'reschedule_not_found';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    v_closer := private.management_group_default_actor(v_reschedule.tenant_id);
  elsif v_actor_id is not null
        and coalesce(v_actor_role, '') in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
        and (v_actor_role = 'SUPER_ADMIN' or public._my_tenant_id() = v_reschedule.tenant_id) then
    v_closer := v_actor_id;
  else
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  -- Já consumida por uma aula: encerrar depois seria reescrever a história.
  if v_reschedule.used_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true,
      'closed_reason', v_reschedule.closed_reason);
  end if;
  perform pg_catalog.set_config('app.reschedule_close', 'on', true);
  perform pg_catalog.set_config('app.reschedule_source', 'direcao', true);
  perform pg_catalog.set_config('app.reschedule_reason', v_reason, true);
  update public.reschedules
     set used_at = pg_catalog.now(), closed_by = v_closer, closed_reason = v_reason
   where id = v_reschedule.id;
  perform pg_catalog.set_config('app.reschedule_close', '', true);
  return pg_catalog.jsonb_build_object('ok', true, 'id', v_reschedule.id, 'closed_by', v_closer);
end;
$function$;
alter function public.close_reschedule(uuid, text) owner to postgres;
revoke all on function public.close_reschedule(uuid, text) from public, anon;
grant execute on function public.close_reschedule(uuid, text) to authenticated;

-- O trigger de trilha passa a distinguir encerramento de aula dada.
-- (Corpo copiado de 20260918100000, com a única mudança marcada abaixo.)
create or replace function private.reschedule_events_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_source text;
  v_reason text;
  v_actor uuid := auth.uid();
  v_role text;
  v_old_start timestamptz;
  v_new_start timestamptz;
  v_urgent boolean := false;
  v_event_id uuid;
  v_student public.profiles%rowtype;
  v_teacher public.profiles%rowtype;
  v_other_teacher public.profiles%rowtype;
  v_group text;
  v_family_phone text;
  v_director uuid;
  v_when_old text;
  v_when_new text;
  v_first_student text;
  v_first_teacher text;
  v_group_msg text;
  v_family_msg text;
  v_actor_name text;
begin
  if tg_op = 'INSERT' then
    v_action := case when private.reschedule_slot_start(new.date, new.time) is not null then 'marcada' else 'criada' end;
  else
    if old.used_at is null and new.used_at is not null then
      -- Encerramento administrativo marca used_at SEM aula. Dizer 'dada' aqui
      -- poria na trilha uma aula que não aconteceu.
      v_action := case when new.closed_reason is not null then 'encerrada' else 'dada' end;
    elsif new.teacher_id is distinct from old.teacher_id then
      v_action := 'professor_trocado';
    elsif (new.attested_by is not null and old.attested_by is null) then
      v_action := 'atestada';
    elsif new.date is distinct from old.date or left(coalesce(new.time, ''), 5) is distinct from left(coalesce(old.time, ''), 5) then
      v_old_start := private.reschedule_slot_start(old.date, old.time);
      v_new_start := private.reschedule_slot_start(new.date, new.time);
      v_action := case
        when v_new_start is not null and v_old_start is null then 'marcada'
        when v_new_start is not null and v_old_start is not null then 'remarcada'
        when v_new_start is null and v_old_start is not null then 'desmarcada'
        else null end;
    end if;
  end if;
  if v_action is null then return new; end if;

  v_role := public._my_role();
  v_source := coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),
    case
      when coalesce(auth.role(), '') = 'service_role' then 'sistema'
      when coalesce(v_role, '') in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then 'direcao'
      when coalesce(v_role, '') = 'TEACHER' then 'app'
      else 'sistema' end);
  if v_source not in ('app', 'whatsapp_professor', 'whatsapp_aluno', 'direcao', 'sistema') then v_source := 'sistema'; end if;
  v_reason := nullif(left(btrim(coalesce(pg_catalog.current_setting('app.reschedule_reason', true), '')), 300), '');
  if v_action = 'atestada' then v_reason := coalesce(v_reason, new.attestation_reason); end if;

  -- Em cima da hora: mexer numa reposição que começa (ou começava) em menos de 3 h.
  if v_action in ('remarcada', 'desmarcada') then
    v_urgent := v_old_start is not null and v_old_start > pg_catalog.now() - interval '3 hours'
                and v_old_start < pg_catalog.now() + interval '3 hours';
  elsif v_action = 'marcada' then
    v_new_start := private.reschedule_slot_start(new.date, new.time);
    v_urgent := v_new_start is not null and v_new_start < pg_catalog.now() + interval '3 hours';
  end if;

  insert into public.reschedule_events (tenant_id, reschedule_id, student_id, teacher_id, action,
      from_date, from_time, to_date, to_time, actor_id, actor_role, source, reason, em_cima_da_hora)
  values (new.tenant_id, new.id, new.student_id, new.teacher_id, v_action,
      case when tg_op = 'UPDATE' then old.date end, case when tg_op = 'UPDATE' then old.time end,
      new.date, new.time,
      case when coalesce(auth.role(), '') = 'service_role' then null else v_actor end, v_role, v_source, v_reason, v_urgent)
  returning id into v_event_id;

  -- Avisos: grupo de coordenação + família. Só o que muda a agenda de alguém;
  -- "criada" e "dada" já têm o lançamento como registro. Reparo em massa por
  -- SQL pode silenciar com set_config('app.reschedule_silent','on',true).
  if v_action not in ('marcada', 'remarcada', 'desmarcada', 'professor_trocado', 'atestada')
     or coalesce(pg_catalog.current_setting('app.reschedule_silent', true), '') = 'on' then
    return new;
  end if;

  select * into v_student from public.profiles where id = new.student_id;
  select * into v_teacher from public.profiles where id = new.teacher_id;
  if v_action = 'professor_trocado' then
    select * into v_other_teacher from public.profiles where id = old.teacher_id;
  end if;
  v_director := private.management_group_default_actor(new.tenant_id);
  v_first_student := split_part(btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);
  v_first_teacher := split_part(btrim(coalesce(v_teacher.full_name, 'professor')), ' ', 1);
  select p.full_name into v_actor_name from public.profiles p where p.id = v_actor;
  v_when_old := case when tg_op = 'UPDATE' and private.reschedule_slot_start(old.date, old.time) is not null
    then format('%s %s às %s', private.weekday_label_pt(old.date::date), to_char(old.date::date, 'DD/MM'), left(old.time, 5)) end;
  v_when_new := case when private.reschedule_slot_start(new.date, new.time) is not null
    then format('%s %s às %s', private.weekday_label_pt(new.date::date), to_char(new.date::date, 'DD/MM'), left(new.time, 5)) end;

  v_group_msg := case v_action
    when 'marcada' then format('📅 *Reposição marcada* · %s · %s%s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_new, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end,
      case when new.fault_type = 'TEACHER' then ' · falta do professor' else '' end)
    when 'remarcada' then format('🔁 *Reposição remarcada* · %s · %s → %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_old, '—'), coalesce(v_when_new, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end)
    when 'desmarcada' then format('❌ *Reposição desmarcada* · %s · era %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_old, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end)
    when 'professor_trocado' then format('👥 *Reposição passou de professor* · %s · de %s para %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_other_teacher.full_name, '?'), coalesce(v_teacher.full_name, '?'),
      case when v_when_new is not null then ' · ' || v_when_new else '' end)
    when 'atestada' then format('✔️ *Reposição de falta do professor atestada* · %s · com %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_teacher.full_name, '?'), case when v_when_new is not null then ' · ' || v_when_new else '' end)
    end
    || E'\n' || format('👨‍🏫 %s · por %s (%s)%s', coalesce(v_teacher.full_name, 'professor'),
      coalesce(v_actor_name, case v_source when 'whatsapp_aluno' then 'aluno' when 'sistema' then 'sistema' else 'escola' end),
      case v_source when 'app' then 'plataforma' when 'whatsapp_professor' then 'WhatsApp do professor'
        when 'whatsapp_aluno' then 'WhatsApp do aluno' when 'direcao' then 'direção' else 'sistema' end,
      case when v_reason is not null then ' · motivo: ' || v_reason else '' end);

  v_group := private.tenant_notice_destination(new.tenant_id, 'coordenacao');
  if v_group is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
        scheduled_for, status, source_type, notification_kind, idempotency_key)
    values (new.tenant_id, coalesce(v_director, new.teacher_id), new.student_id, 'Coordenação', v_group, v_group_msg,
        pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('reschedule-event:%s:group', v_event_id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
  end if;

  -- Família: marcada, remarcada e desmarcada (atestado e troca de professor são internos).
  if v_action in ('marcada', 'remarcada', 'desmarcada') and public.is_student_notifiable(new.student_id) then
    v_family_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
    if v_family_phone is not null then
      v_family_msg := case v_action
        when 'marcada' then format('Oi, %s! 🐺 Sua reposição com o teacher %s ficou marcada para %s. Qualquer imprevisto, é só responder aqui.', v_first_student, v_first_teacher, v_when_new)
        when 'remarcada' then format('Oi, %s! 🐺 Sua reposição com o teacher %s mudou: era %s e passou para %s. Qualquer dúvida, é só responder aqui.', v_first_student, v_first_teacher, v_when_old, v_when_new)
        else format('Oi, %s! 🐺 A reposição com o teacher %s que estava marcada para %s foi desmarcada. A escola vai combinar uma nova data com você.', v_first_student, v_first_teacher, v_when_old)
        end;
      insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
          scheduled_for, status, source_type, notification_kind, idempotency_key)
      values (new.tenant_id, coalesce(v_director, new.teacher_id), new.student_id, v_student.full_name, v_family_phone, v_family_msg,
          pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('reschedule-event:%s:family', v_event_id))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
    end if;
  end if;
  return new;
end;
$$;
alter function private.reschedule_events_capture() owner to postgres;
revoke all on function private.reschedule_events_capture() from public, anon, authenticated, service_role;
drop trigger if exists trg_zz_reschedule_events_capture on public.reschedules;

create trigger trg_zz_reschedule_events_capture
  after insert or update on public.reschedules
  for each row execute function private.reschedule_events_capture();

-- Aplicação ÚNICA dos dois baldes -------------------------------------------
-- Trava one-shot porque a migration é re-executada (a pré-validação do release
-- roda o pacote pendente DUAS vezes). E `app.reschedule_silent` porque cada
-- linha tocada aqui dispararia aviso ao grupo de coordenação E à família —
-- seriam ~24 mensagens de WhatsApp sobre decisões administrativas retroativas.
DO $onshot$
DECLARE
  v_fechadas int := 0;
  v_reatribuidas int := 0;
  v_ator uuid;
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_one_shots
              WHERE key = 'reposicoes_balde_a_e_b_20260923') THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.reschedule_silent', 'on', true);
  PERFORM pg_catalog.set_config('app.reschedule_source', 'direcao', true);

  -- BALDE A: aluno saiu, está inativo ou sem agenda. Não há a quem dar a aula.
  PERFORM pg_catalog.set_config('app.reschedule_close', 'on', true);
  PERFORM pg_catalog.set_config('app.reschedule_reason',
    'Encerrada na limpeza de 23/09/2026: aluno inativo ou sem agenda ativa.', true);
  FOR r IN
    SELECT resc.id, resc.tenant_id
      FROM public.reschedules AS resc
      JOIN public.profiles AS stu ON stu.id = resc.student_id
     WHERE resc.used_at IS NULL
       AND (
         pg_catalog.lower(coalesce(stu.status, '')) <> 'ativo'
         OR NOT EXISTS (
           SELECT 1 FROM public.bookings AS bk
            WHERE bk.student_id = stu.id
              AND pg_catalog.upper(coalesce(bk.status, '')) = 'SCHEDULED')
       )
  LOOP
    UPDATE public.reschedules
       SET used_at = pg_catalog.now(),
           closed_by = private.management_group_default_actor(r.tenant_id),
           closed_reason = 'Encerrada na limpeza de 23/09/2026: aluno inativo ou sem agenda ativa.'
     WHERE id = r.id;
    v_fechadas := v_fechadas + 1;
  END LOOP;
  PERFORM pg_catalog.set_config('app.reschedule_close', '', true);

  -- BALDE B: falta do PROFESSOR pendurada em professor que não dá mais aula
  -- para o aluno. A aula continua devida; quem a dará é o professor de hoje.
  -- Reatribuir SOZINHO tornaria a aula impagável — a prova de origem
  -- (private.teacher_reschedule_financial_origin_is_proven) exige que o
  -- class_log da falta seja do MESMO professor. Por isso vai junto o atestado
  -- da direção, que é o caminho previsto para "reposição de falta de um
  -- professor dada por outro".
  FOR r IN
    SELECT resc.id, resc.tenant_id, stu.professor_id AS novo_professor
      FROM public.reschedules AS resc
      JOIN public.profiles AS stu ON stu.id = resc.student_id
     WHERE resc.used_at IS NULL
       AND resc.fault_type = 'TEACHER'
       AND resc.attested_by IS NULL
       AND stu.professor_id IS NOT NULL
       AND resc.teacher_id IS DISTINCT FROM stu.professor_id
       AND resc.teacher_id IS DISTINCT FROM stu.professor_id2
       AND pg_catalog.lower(coalesce(stu.status, '')) = 'ativo'
       AND EXISTS (
         SELECT 1 FROM public.bookings AS bk
          WHERE bk.student_id = stu.id
            AND pg_catalog.upper(coalesce(bk.status, '')) = 'SCHEDULED')
  LOOP
    v_ator := private.management_group_default_actor(r.tenant_id);
    PERFORM pg_catalog.set_config('app.reschedule_reason',
      'Reatribuída em 23/09/2026: o aluno trocou de professor e a aula continua devida.', true);
    UPDATE public.reschedules SET teacher_id = r.novo_professor WHERE id = r.id;

    PERFORM pg_catalog.set_config('app.reschedule_attest', 'on', true);
    UPDATE public.reschedules
       SET attested_by = v_ator,
           attested_at = pg_catalog.now(),
           attestation_reason =
             'Reatribuída em 23/09/2026: falta do professor anterior, aula dada pelo professor atual.'
     WHERE id = r.id;
    PERFORM pg_catalog.set_config('app.reschedule_attest', '', true);
    v_reatribuidas := v_reatribuidas + 1;
  END LOOP;

  PERFORM pg_catalog.set_config('app.reschedule_silent', '', true);

  INSERT INTO public.schema_one_shots (key, nota)
  VALUES ('reposicoes_balde_a_e_b_20260923',
    pg_catalog.format('encerradas: %s; reatribuidas+atestadas: %s', v_fechadas, v_reatribuidas));
  RAISE NOTICE 'balde A encerradas: %; balde B reatribuidas: %', v_fechadas, v_reatribuidas;
END
$onshot$;
