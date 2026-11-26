-- Material e parte do livro em cada aula + resumo do Meet mais rápido (decisão da direção, 26/11/2026).
-- Caso: na troca dos alunos da Teacher Bruna para o Teacher Daniel ninguém sabia em que livro e
-- parte cada aluno tinha parado: o sistema guardava assunto e lição (pelo resumo do Meet), nunca o
-- material. Agora cada lançamento leva o material (da biblioteca ou escrito) e a parte/página; o
-- último aparece no lançamento seguinte, no dossiê e no aviso ao professor novo da troca. A IA do
-- resumo sugere a parte/página quando ela foi citada na aula (campo material_reference).
--
-- E o resumo: medido em 30 dias, o primeiro rascunho saía ~15 min depois do fim da aula (a rotina
-- do Google rodava a cada 15 min). Agora a rotina roda a cada 5 min, e get_class_log_meet_drafts
-- devolve a aula que terminou sem resumo como PENDING, para a tela oferecer "Buscar o resumo agora".

create table if not exists public.class_log_materials (
  class_log_id uuid primary key references public.class_logs(id) on delete cascade,
  tenant_id text not null,
  student_id uuid,
  teacher_id uuid,
  class_date date,
  material_id uuid references public.pedagogical_materials(id) on delete set null,
  -- Cópia do nome no lançamento: material apagado da biblioteca não apaga a história.
  material_title text check (material_title is null or length(material_title) <= 300),
  collection_title text check (collection_title is null or length(collection_title) <= 300),
  part_number integer,
  reference text check (reference is null or length(reference) <= 300),
  from_meet boolean not null default false,
  created_by uuid,
  updated_at timestamptz not null default now(),
  check (material_id is not null or nullif(btrim(coalesce(material_title, '')), '') is not null
         or nullif(btrim(coalesce(reference, '')), '') is not null)
);
create index if not exists class_log_materials_student_idx on public.class_log_materials (tenant_id, student_id, class_date desc);
alter table public.class_log_materials enable row level security;
revoke all on public.class_log_materials from public, anon, authenticated;

-- Grava (ou limpa) o material de aulas já lançadas. Professor só nas aulas dele; direção e
-- coordenação na escola. Item sem material, nome e parte = limpar.
create or replace function public.save_class_log_materials(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); actor public.profiles; it jsonb; cl public.class_logs;
  m public.pedagogical_materials; v_col text; v_title text; v_ref text; v_mat uuid; v_saved int := 0; v_cleared int := 0;
begin
  select * into actor from public.profiles where id = v_uid;
  if actor.id is null or actor.role not in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR')
     or coalesce(actor.lifecycle_status, 'active') <> 'active' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  for it in select value from jsonb_array_elements(p_items) loop
    select * into cl from public.class_logs where id = nullif(it->>'class_log_id', '')::uuid;
    if cl.id is null or cl.tenant_id is distinct from actor.tenant_id
       or (actor.role = 'TEACHER' and cl.teacher_id is distinct from actor.id) then
      raise exception 'class_log_not_found' using errcode = '42501';
    end if;
    v_mat := nullif(it->>'material_id', '')::uuid;
    v_title := nullif(btrim(left(coalesce(it->>'title', ''), 300)), '');
    v_ref := nullif(btrim(left(coalesce(it->>'reference', ''), 300)), '');
    v_col := null; m := null;
    if v_mat is not null then
      select * into m from public.pedagogical_materials where id = v_mat and tenant_id = actor.tenant_id;
      if m.id is null or (coalesce(m.approval_status, 'APPROVED') <> 'APPROVED' and m.uploaded_by is distinct from actor.id) then
        raise exception 'material_not_found' using errcode = '22023';
      end if;
      v_title := m.title;
      select c.title into v_col from public.pedagogical_collections c where c.id = m.collection_id;
    end if;
    if v_mat is null and v_title is null and v_ref is null then
      delete from public.class_log_materials where class_log_id = cl.id;
      v_cleared := v_cleared + 1;
      continue;
    end if;
    insert into public.class_log_materials(class_log_id, tenant_id, student_id, teacher_id, class_date, material_id,
      material_title, collection_title, part_number, reference, from_meet, created_by, updated_at)
    values (cl.id, cl.tenant_id, cl.student_id, cl.teacher_id, cl.class_date, v_mat, v_title, v_col, m.part_number,
      v_ref, coalesce((it->>'from_meet')::boolean, false), actor.id, now())
    on conflict (class_log_id) do update set material_id = excluded.material_id, material_title = excluded.material_title,
      collection_title = excluded.collection_title, part_number = excluded.part_number, reference = excluded.reference,
      from_meet = excluded.from_meet, created_by = excluded.created_by, updated_at = now();
    v_saved := v_saved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'saved', v_saved, 'cleared', v_cleared);
end;$$;
alter function public.save_class_log_materials(jsonb) owner to postgres;
revoke all on function public.save_class_log_materials(jsonb) from public, anon, service_role;
grant execute on function public.save_class_log_materials(jsonb) to authenticated;

-- Texto de uma linha: "Book A1 · Part 2 · Unit 3, página 34".
create or replace function private.class_log_material_text(r public.class_log_materials)
returns text language sql immutable set search_path = '' as $$
  select nullif(concat_ws(' · ',
    nullif(r.collection_title, ''),
    case when r.collection_title is not null and r.part_number is not null then 'Part ' || r.part_number
         else nullif(r.material_title, '') end,
    nullif(r.reference, '')), '');
$$;
alter function private.class_log_material_text(public.class_log_materials) owner to postgres;
revoke all on function private.class_log_material_text(public.class_log_materials) from public, anon, authenticated, service_role;

-- Último material de cada aluno (quem pode ler o dossiê do aluno).
create or replace function public.last_class_materials(p_student_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); actor public.profiles; v_out jsonb := '{}'; r record;
begin
  select * into actor from public.profiles where id = v_uid;
  if actor.id is null or actor.role not in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR') then return '{}'; end if;
  if coalesce(cardinality(p_student_ids), 0) > 200 then raise exception 'invalid_students' using errcode = '22023'; end if;
  for r in
    select distinct on (m.student_id) m.*, private.class_log_material_text(m) as label, t.full_name as teacher_name
      from public.class_log_materials m left join public.profiles t on t.id = m.teacher_id
     where m.tenant_id = actor.tenant_id and m.student_id = any(p_student_ids)
     order by m.student_id, m.class_date desc nulls last, m.updated_at desc
  loop
    if not private.can_read_student_pedagogy(actor.tenant_id, r.student_id) then continue; end if;
    v_out := v_out || jsonb_build_object(r.student_id::text, jsonb_build_object(
      'materialId', r.material_id, 'title', r.material_title, 'collection', r.collection_title, 'part', r.part_number,
      'reference', r.reference, 'label', r.label, 'classDate', r.class_date, 'teacherName', r.teacher_name));
  end loop;
  return v_out;
end;$$;
alter function public.last_class_materials(uuid[]) owner to postgres;
revoke all on function public.last_class_materials(uuid[]) from public, anon, service_role;
grant execute on function public.last_class_materials(uuid[]) to authenticated;

-- Resumo do Meet no lançamento: parte/página sugerida e aula terminada sem resumo (PENDING).
do $patch$
declare s text;
begin
  s := pg_get_functiondef('public.get_class_log_meet_drafts(jsonb)'::regprocedure);
  if strpos(s, 'material_reference') = 0 then
    if strpos(s, $a$'uncertainties',summary.content->'uncertainties'$a$) = 0 then raise exception 'meet_drafts_anchor_changed (uncertainties)'; end if;
    s := replace(s, $a$'uncertainties',summary.content->'uncertainties'$a$,
      $a$'uncertainties',summary.content->'uncertainties','material_reference',summary.content->'material_reference'$a$);
  end if;
  if strpos(s, $a$'status','PENDING'$a$) = 0 then
    if strpos(s, 'if summary.id is null then continue; end if;') = 0 then raise exception 'meet_drafts_anchor_changed (pending)'; end if;
    s := replace(s, 'if summary.id is null then continue; end if;',
      $a$if summary.id is null then
      result := result || jsonb_build_object(e->>'ref', jsonb_build_object('sessionId',session.id,'status','PENDING','endedAt',session.scheduled_end_at));
      continue;
    end if;$a$);
  end if;
  execute s;
end $patch$;

-- Professor novo da troca recebe junto em que material o aluno parou.
create or replace function private.teacher_transfer_applied_notify_teachers()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_student text;v_from text;v_from_phone text;v_to text;v_to_phone text;v_agenda text;v_material text;
begin
 if new.status is distinct from 'APPLIED' or old.status is not distinct from 'APPLIED' then return null;end if;
 if exists(select 1 from public.teacher_departure_offers o where o.transfer_id=new.id) then return null;end if;
 begin
  select full_name into v_student from public.profiles where id=new.student_id;
  select full_name,private.whatsapp_digits(nullif(phone,'')) into v_from,v_from_phone from public.profiles where id=new.from_teacher_id;
  select full_name,private.whatsapp_digits(nullif(phone,'')) into v_to,v_to_phone from public.profiles where id=new.to_teacher_id;
  v_agenda:=private.student_term_agenda_text(new.proposed_slots);
  select private.class_log_material_text(m)||' (aula de '||to_char(m.class_date,'DD/MM')||')' into v_material
    from public.class_log_materials m where m.tenant_id=new.tenant_id and m.student_id=new.student_id
    order by m.class_date desc nulls last, m.updated_at desc limit 1;
  if v_from_phone is not null and new.from_teacher_id is distinct from new.to_teacher_id then
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
   values(new.tenant_id,new.from_teacher_id,new.student_id,v_from,v_from_phone,
    format(E'Oi, %s! 🐺 O aluno *%s* foi transferido para o(a) teacher %s a partir de %s e saiu da sua agenda. Obrigado por tudo até aqui!',
     split_part(btrim(v_from),' ',1),v_student,v_to,to_char(new.cutover_date,'DD/MM')),
    private.student_term_send_at(now()),private.student_term_send_at(now()),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('teacher-transfer:%s:applied:from',new.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  end if;
  if v_to_phone is not null then
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
   values(new.tenant_id,new.to_teacher_id,new.student_id,v_to,v_to_phone,
    format(E'Oi, %s! 🐺 Tudo assinado: *%s* entrou na sua agenda.\n📅 %s, a partir de %s.%s',
     split_part(btrim(v_to),' ',1),v_student,v_agenda,to_char(new.cutover_date,'DD/MM'),
     case when v_material is not null then E'\n📘 Parou em: '||v_material else '' end),
    private.student_term_send_at(now()),private.student_term_send_at(now()),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('teacher-transfer:%s:applied:to',new.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  end if;
 exception when others then
  raise warning '[troca de professor] aviso aos professores falhou para %: %',new.id,sqlerrm;
 end;
 return null;
end;$$;
alter function private.teacher_transfer_applied_notify_teachers() owner to postgres;
revoke all on function private.teacher_transfer_applied_notify_teachers() from public, anon, authenticated, service_role;

-- Rotina do Google a cada 5 min (era 15).
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'wisewolf-meet-document-sync' and schedule <> '*/5 * * * *') then
    perform cron.alter_job((select jobid from cron.job where jobname = 'wisewolf-meet-document-sync'), schedule := '*/5 * * * *');
  end if;
end $cron$;
