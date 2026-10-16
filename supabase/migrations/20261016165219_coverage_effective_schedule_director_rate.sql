-- A cobertura usa a ocorrência efetiva; a direção congela a oferta por slot de 30 min.
alter table public.class_coverages add column if not exists offered_rate numeric(10,2);
alter table public.class_coverages add column if not exists offered_rate_set_by uuid references public.profiles(id);
alter table public.class_coverages add column if not exists offered_rate_set_at timestamptz;

-- As policies legadas permitem ao aluno ler sua cobertura. As novas colunas de
-- remuneração não podem herdar o SELECT amplo da tabela; as projeções de agenda
-- existentes mantêm todas as colunas que já podiam consultar.
do $$declare columns_list text;begin
 select string_agg(quote_ident(attname),',' order by attnum) into columns_list
 from pg_attribute where attrelid='public.class_coverages'::regclass and attnum>0 and not attisdropped
 and attname not in ('offered_rate','offered_rate_set_by','offered_rate_set_at');
 revoke select on public.class_coverages from anon,authenticated;
 execute 'grant select ('||columns_list||') on public.class_coverages to anon,authenticated';
end $$;

create or replace function private.guard_coverage_offered_rate()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if new.offered_rate is distinct from old.offered_rate or new.offered_rate_set_by is distinct from old.offered_rate_set_by
   or new.offered_rate_set_at is distinct from old.offered_rate_set_at then
   raise exception using errcode='42501',message='coverage_offered_rate_immutable';
  end if;
  return new;
 end if;
 if new.offered_rate is null then
  if new.offered_rate_set_by is not null or new.offered_rate_set_at is not null then
   raise exception using errcode='23514',message='coverage_rate_invalid';
  end if;
  return new;
 end if;
 if new.offered_rate::text in ('NaN','Infinity','-Infinity') or new.offered_rate<=0 or new.offered_rate>10000 then
  raise exception using errcode='23514',message='coverage_rate_invalid';
 end if;
 if (coalesce(auth.role(),'')<>'service_role' and auth.uid() is distinct from new.offered_rate_set_by)
  or not exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id
   where p.id=new.offered_rate_set_by and p.tenant_id=new.tenant_id and p.lifecycle_status='active'
    and m.tenant_id=new.tenant_id and m.role='SCHOOL_ADMIN' and m.status='ACTIVE') then
  raise exception using errcode='42501',message='coverage_rate_director_only';
 end if;
 new.offered_rate_set_at:=clock_timestamp();
 return new;
end $$;
alter function private.guard_coverage_offered_rate() owner to postgres;
revoke all on function private.guard_coverage_offered_rate() from public,anon,authenticated,service_role;
drop trigger if exists aa_guard_coverage_offered_rate on public.class_coverages;
create trigger aa_guard_coverage_offered_rate before insert or update on public.class_coverages
 for each row execute function private.guard_coverage_offered_rate();

create or replace function public.coverage_booking_occurrences(
 p_tenant text,p_teacher_ids uuid[],p_from date,p_to date,p_include_covered boolean default false)
returns table("bookingId" uuid,"teacherId" uuid,"studentId" uuid,"studentName" text,"classDate" date,"classTime" text,dow integer)
language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30 or coalesce(cardinality(p_teacher_ids),0) not between 1 and 50 then
  raise exception using errcode='22023',message='coverage_period_invalid';end if;
 return query
 select b.id,b.teacher_id,b.student_id,coalesce(s.full_name,'Aluno')::text,d.day::date,slot.v->>'time_slot',extract(dow from d.day)::integer
 from public.bookings b join public.profiles s on s.id=b.student_id and s.tenant_id=b.tenant_id
 join public.tenant_memberships m on m.user_id=s.id and m.tenant_id=b.tenant_id and m.role='STUDENT' and m.status='ACTIVE'
 cross join generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d(day)
 cross join lateral (select public.booking_schedule_on_date(b.id,d.day::date) v) slot
 where b.tenant_id=p_tenant and b.teacher_id=any(p_teacher_ids) and upper(b.status)='SCHEDULED'
 and s.lifecycle_status='active' and lower(coalesce(s.status,'')) not in ('inativo','inactive','arquivado','cancelado','trancado','suspenso','suspended','pausado')
 and coalesce(s.status_financial,'') not in ('ARCHIVED','SUSPENDED')
 and coalesce((slot.v->>'valid')::boolean,false)
 and (p_include_covered or not exists(select 1 from public.class_coverages c where c.tenant_id=b.tenant_id and c.booking_id=b.id
  and c.class_date=d.day::date and (lower(c.status)='confirmed' or (lower(c.status)='pending' and c.invite_expires_at>now()))))
 and (p_include_covered or not exists(select 1 from public.class_logs l where l.tenant_id=b.tenant_id and l.booking_id=b.id::text and l.class_date=d.day::date))
 order by d.day,slot.v->>'time_slot',s.full_name,b.id;
end $$;
alter function public.coverage_booking_occurrences(text,uuid[],date,date,boolean) owner to postgres;
revoke all on function public.coverage_booking_occurrences(text,uuid[],date,date,boolean) from public,anon,authenticated,service_role;
grant execute on function public.coverage_booking_occurrences(text,uuid[],date,date,boolean) to service_role;

-- Preserva as demais guardas e os remendos posteriores já publicados.
do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.enforce_active_class_coverage_slot()'::regprocedure);
 if position('coverage_effective_occurrence_v1' in definition)=0 then
  if position($old$     OR pg_catalog.left(coalesce(v_booking.time_slot, ''), 5) <>
          v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM NEW.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND NEW.class_date < v_booking.start_date
     )$old$ in definition)=0 or position($old$       AND pg_catalog.upper(coalesce(conflict.status, '')) <>
           'CANCELLED'
       AND pg_catalog.left(coalesce(conflict.time_slot, ''), 5) =
           v_time
       AND (
         conflict.date = NEW.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= NEW.class_date
           )
         )
       )$old$ in definition)=0 then
   raise exception 'coverage_schedule_anchor_missing: enforce_active_class_coverage_slot';end if;
  definition:=replace(definition,$old$     OR pg_catalog.left(coalesce(v_booking.time_slot, ''), 5) <>
          v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM NEW.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND NEW.class_date < v_booking.start_date
     )$old$,$new$     -- coverage_effective_occurrence_v1: mesma agenda da seleção e do lançamento.
     OR NOT coalesce((public.booking_schedule_on_date(v_booking.id,NEW.class_date)->>'valid')::boolean,false)
     OR left(public.booking_schedule_on_date(v_booking.id,NEW.class_date)->>'time_slot',5) IS DISTINCT FROM v_time$new$);
  definition:=replace(definition,$old$       AND pg_catalog.upper(coalesce(conflict.status, '')) <>
           'CANCELLED'
       AND pg_catalog.left(coalesce(conflict.time_slot, ''), 5) =
           v_time
       AND (
         conflict.date = NEW.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= NEW.class_date
           )
         )
       )$old$,$new$       AND coalesce((public.booking_schedule_on_date(conflict.id,NEW.class_date)->>'valid')::boolean,false)
       AND abs(extract(epoch from ((public.booking_schedule_on_date(conflict.id,NEW.class_date)->>'time_slot')::time-v_time::time)))<1800$new$);
  execute definition;
 end if;
end $patch$;

-- Preserva as demais guardas e os remendos posteriores já publicados.
do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.resolve_coverage_invite(text,boolean)'::regprocedure);
 if position('coverage_effective_occurrence_v1' in definition)=0 then
  if position($old$     OR left(coalesce(v_booking.time_slot, ''), 5) <> v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM v_coverage.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND v_coverage.class_date < v_booking.start_date
     )$old$ in definition)=0 or position($old$       AND upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       AND left(coalesce(conflict.time_slot, ''), 5) = v_time
       AND (
         conflict.date = v_coverage.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= v_coverage.class_date
           )
         )
       )$old$ in definition)=0 then
   raise exception 'coverage_schedule_anchor_missing: resolve_coverage_invite';end if;
  definition:=replace(definition,$old$     OR left(coalesce(v_booking.time_slot, ''), 5) <> v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM v_coverage.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND v_coverage.class_date < v_booking.start_date
     )$old$,$new$     -- coverage_effective_occurrence_v1: mesma agenda da seleção e do lançamento.
     OR NOT coalesce((public.booking_schedule_on_date(v_booking.id,v_coverage.class_date)->>'valid')::boolean,false)
     OR left(public.booking_schedule_on_date(v_booking.id,v_coverage.class_date)->>'time_slot',5) IS DISTINCT FROM v_time$new$);
  definition:=replace(definition,$old$       AND upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       AND left(coalesce(conflict.time_slot, ''), 5) = v_time
       AND (
         conflict.date = v_coverage.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= v_coverage.class_date
           )
         )
       )$old$,$new$       AND coalesce((public.booking_schedule_on_date(conflict.id,v_coverage.class_date)->>'valid')::boolean,false)
       AND abs(extract(epoch from ((public.booking_schedule_on_date(conflict.id,v_coverage.class_date)->>'time_slot')::time-v_time::time)))<1800$new$);
  execute definition;
 end if;
end $patch$;

do $patch$ declare definition text; old_conflict text;begin
 definition:=pg_get_functiondef('private.coverage_candidates(text,uuid,date)'::regprocedure);
 if position('coverage_effective_candidates_v1' in definition)=0 then
  if position($old$left(coalesce(b.time_slot, ''), 5) as slot$old$ in definition)=0 then raise exception 'coverage_candidates_slot_anchor_missing';end if;
  definition:=replace(definition,$old$left(coalesce(b.time_slot, ''), 5) as slot$old$,
   $new$/* coverage_effective_candidates_v1 */ left(public.booking_schedule_on_date(b.id,p_class_date)->>'time_slot',5) as slot$new$);
  old_conflict:=$old$          and upper(coalesce(c.status, '')) <> 'CANCELLED'
          and left(coalesce(c.time_slot, ''), 5) = (select slot from booking)
          and (c.date = p_class_date
               or (c.date is null and public.fold_accents(c.day_of_week) = lower((select name from dow))
                   and (c.start_date is null or c.start_date <= p_class_date)))$old$;
  if position(old_conflict in definition)=0 then raise exception 'coverage_candidates_conflict_anchor_missing';end if;
  definition:=replace(definition,old_conflict,$new$          and coalesce((public.booking_schedule_on_date(c.id,p_class_date)->>'valid')::boolean,false)
          and abs(extract(epoch from ((public.booking_schedule_on_date(c.id,p_class_date)->>'time_slot')::time-(select slot from booking)::time)))<1800$new$);
  execute definition;
 end if;
end $patch$;

create or replace function public.coverage_candidates_for_booking(p_tenant text,p_booking uuid,p_date date,p_time text)
returns table(teacher_id uuid,teacher_name text,teacher_phone text)
language plpgsql stable security definer set search_path='' as $$
declare b public.bookings%rowtype; slot jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required';end if;
 select * into b from public.bookings where id=p_booking and tenant_id=p_tenant;
 if not found then raise exception using errcode='22023',message='coverage_booking_invalid';end if;
 slot:=public.booking_schedule_on_date(p_booking,p_date);
 if not coalesce((slot->>'valid')::boolean,false) or left(slot->>'time_slot',5) is distinct from left(p_time,5) then
  raise exception using errcode='22023',message='coverage_booking_invalid';end if;
 return query select c.teacher_id,c.full_name,c.phone from private.coverage_candidates(p_tenant,p_booking,p_date) c;
end $$;
alter function public.coverage_candidates_for_booking(text,uuid,date,text) owner to postgres;
revoke all on function public.coverage_candidates_for_booking(text,uuid,date,text) from public,anon,authenticated,service_role;
grant execute on function public.coverage_candidates_for_booking(text,uuid,date,text) to service_role;

create index if not exists class_coverages_offered_rate_lookup
 on public.class_coverages(tenant_id,(booking_id::text),class_date,cover_teacher_id,student_id) include(offered_rate)
 where lower(status)='confirmed' and offered_rate is not null;

-- Mantém todos os filtros financeiros existentes. A oferta só remunera aula lançada e pagável.
do $patch$ declare definition text; anchor text:='COALESCE(cl.rate_override,';begin
 definition:=pg_get_viewdef('public.v_payable_class_logs'::regclass,true);
 if position('offered_rate' in definition)=0 then
  if position(anchor in definition)=0 then raise exception 'coverage_payable_view_anchor_missing';end if;
  definition:=replace(definition,anchor,$new$COALESCE(cl.rate_override,
    (select c.offered_rate from public.class_coverages c where c.tenant_id=cl.tenant_id and c.cover_teacher_id=cl.teacher_id
      and c.student_id=cl.student_id and c.booking_id::text=cl.booking_id and c.class_date=cl.class_date
      and lower(c.status)='confirmed' and c.offered_rate is not null limit 1),$new$);
  execute 'create or replace view public.v_payable_class_logs as '||definition;
 end if;
end $patch$;
