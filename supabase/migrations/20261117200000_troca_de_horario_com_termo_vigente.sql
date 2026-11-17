-- Troca de horário com o mesmo professor não exige termo novo quando já existe
-- termo individual assinado (EXECUTED) entre os dois.
--
-- Caso (17/11/2026): a direção trocou a aula de quarta da Amanda Mendes com a
-- Teacher Laís de 17:00 para 18:00. As duas já tinham termo assinado (escola,
-- professora e família), mas o editor de agenda (teacher_apply_student_schedule_change
-- → student_term_stage_schedule) só dispensava aluno anterior à política. Abriu um
-- termo novo, escola e professora assinaram, e a troca ficou parada esperando a
-- família confirmar no portal, sem aviso nenhum a ela.
--
-- 20261116200000 já dispensava o termo no pedido de troca (schedule_change_requests).
-- Aqui a mesma regra vale para o editor de agenda e para o guarda da agenda,
-- somente na MUDANÇA de horário de uma aula fixa existente (UPDATE em bookings e
-- versões da agenda). Aula nova, professor novo, cobertura e transferência seguem
-- exigindo termo próprio.

create or replace function private.student_term_same_teacher_executed(p_tenant text, p_student uuid, p_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists(
    select 1 from private.teacher_student_terms t
     where t.tenant_id = p_tenant and t.student_id = p_student and t.teacher_id = p_teacher
       and t.status = 'EXECUTED' and t.retired_at is null
  );
$function$;

alter function private.student_term_same_teacher_executed(text,uuid,uuid) owner to postgres;
revoke all on function private.student_term_same_teacher_executed(text,uuid,uuid) from public, anon, authenticated;

-- Editor de agenda: não prepara termo quando o mesmo professor já tem termo assinado.
do $$
declare
  v_def text;
  v_anchor text := 'if private.student_term_legacy_relationship(tenant,p_student,b.teacher_id) then continue;end if;';
  v_patch text := 'if private.student_term_legacy_relationship(tenant,p_student,b.teacher_id) then continue;end if;'
    || E'\n  -- troca_de_horario_com_termo_vigente\n  if private.student_term_same_teacher_executed(tenant,p_student,b.teacher_id) then continue;end if;';
begin
  v_def := pg_get_functiondef('private.student_term_stage_schedule(uuid,jsonb,date,text)'::regprocedure);
  if position('troca_de_horario_com_termo_vigente' in v_def) > 0 then
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'ancora_de_student_term_stage_schedule_nao_encontrada';
  end if;
  execute replace(v_def, v_anchor, v_patch);
end;
$$;

-- Guarda da agenda: mudança de horário de aula fixa existente do mesmo professor
-- com termo assinado passa, só quando vem de pedido de troca APLICADO (o caminho
-- oficial); escrita direta continua barrada. A âncora aparece duas vezes: a 1ª no ramo de bookings
-- (só UPDATE da mesma aula fixa, mesmo aluno e professor), a 2ª no de versões.
do $$
declare
  v_def text;
  v_pos integer;
  v_anchor text := 'if sid is not null and teacher is not null and private.student_term_legacy_relationship(t,sid,teacher) then return new;end if;';
  v_bookings text := E'\n  -- troca_de_horario_com_termo_vigente: só mudança de aula fixa existente\n'
    || E'  if tg_op=''UPDATE'' and sid is not null and teacher is not null and old.teacher_id is not distinct from new.teacher_id and old.student_id is not distinct from new.student_id and old.date is null and new.date is null and exists(select 1 from public.schedule_change_requests q where q.booking_id=new.id and q.tenant_id=t and q.status=''APPLIED'' and public.canonical_weekday_name(q.new_day)=public.canonical_weekday_name(new.day_of_week) and left(q.new_time,5)=left(new.time_slot,5)) and private.student_term_same_teacher_executed(t,sid,teacher) then return new;end if;';
  v_versions text := E'\n  -- troca_de_horario_com_termo_vigente\n'
    || E'  if sid is not null and teacher is not null and b.date is null and new.request_id is not null and exists(select 1 from public.schedule_change_requests q where q.id=new.request_id and q.booking_id=new.booking_id and q.tenant_id=t and q.status=''APPLIED'') and private.student_term_same_teacher_executed(t,sid,teacher) then return new;end if;';
begin
  v_def := pg_get_functiondef('private.guard_student_individual_term()'::regprocedure);
  if position('troca_de_horario_com_termo_vigente' in v_def) > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 2 then
    raise exception 'ancora_de_guard_student_individual_term_nao_encontrada';
  end if;
  -- 2ª ocorrência primeiro, para a posição da 1ª não mudar.
  v_pos := position(v_anchor in v_def);
  v_pos := v_pos + length(v_anchor) + position(v_anchor in substr(v_def, v_pos + length(v_anchor))) - 1;
  v_def := overlay(v_def placing v_anchor || v_versions from v_pos for length(v_anchor));
  v_pos := position(v_anchor in v_def);
  v_def := overlay(v_def placing v_anchor || v_bookings from v_pos for length(v_anchor));
  execute v_def;
end;
$$;

-- One-shot: encerra a proposta de termo aberta por troca de horário quando o mesmo
-- professor já tinha termo assinado com o aluno (em 17/11, só a da Amanda Mendes).
do $$
begin
  if exists(select 1 from public.schema_one_shots where key = 'troca_de_horario_com_termo_vigente_20261117') then
    return;
  end if;
  update private.teacher_student_terms t
     set status = 'SUPERSEDED',
         closed_reason = 'Troca de horário com o mesmo professor e termo já assinado: termo novo dispensado',
         updated_at = now()
   where t.status = 'PROPOSED' and t.retired_at is null
     and t.source_kind in ('MANUAL', 'SCHEDULE_CHANGE') and t.mode = 'RECURRING'
     and exists(select 1 from private.teacher_student_terms e
                 where e.tenant_id = t.tenant_id and e.student_id = t.student_id and e.teacher_id = t.teacher_id
                   and e.status = 'EXECUTED' and e.retired_at is null and e.id <> t.id);
  insert into public.schema_one_shots(key, nota)
  values ('troca_de_horario_com_termo_vigente_20261117', 'Propostas de termo por troca de horário com termo vigente encerradas');
end;
$$;
