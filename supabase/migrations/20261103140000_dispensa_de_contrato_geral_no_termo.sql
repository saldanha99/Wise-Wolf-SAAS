-- Reexecutável. O termo por aluno exige contrato geral aceito (student_term_source_valid)
-- e recusava a assinatura com "Proposta indisponível ou fonte alterada", um motivo que
-- não era o real. A direção pode dispensar um professor do contrato geral: a dispensa
-- vale só para o termo por aluno, fica registrada e NÃO marca contract_accepted, porque
-- esse aceite não existiu. Cobertura pontual e demais regras seguem exigindo o aceite.
create table if not exists private.teacher_general_contract_waivers (
 id uuid primary key default gen_random_uuid(),
 tenant_id text not null references public.tenants(id),
 teacher_id uuid not null references public.profiles(id),
 decided_by uuid not null references public.profiles(id),
 reason text not null check (length(btrim(reason)) >= 10),
 created_at timestamptz not null default now(),
 revoked_at timestamptz,
 revoked_by uuid references public.profiles(id),
 revoke_reason text
);
create unique index if not exists uq_teacher_general_contract_waiver_active
 on private.teacher_general_contract_waivers(tenant_id, teacher_id) where revoked_at is null;
alter table private.teacher_general_contract_waivers enable row level security;
alter table private.teacher_general_contract_waivers owner to postgres;
revoke all on private.teacher_general_contract_waivers from public, anon, authenticated, service_role;

create or replace function private.teacher_general_contract_waived(p_tenant text, p_teacher uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from private.teacher_general_contract_waivers
  where tenant_id = p_tenant and teacher_id = p_teacher and revoked_at is null);
$$;
alter function private.teacher_general_contract_waived(text, uuid) owner to postgres;
revoke all on function private.teacher_general_contract_waived(text, uuid) from public, anon, authenticated, service_role;

-- Fora de qualquer API: roda na VPS, como private.set_teacher_punctuality_enabled.
create or replace function private.set_teacher_general_contract_waiver(p_tenant text, p_teacher uuid, p_decided_by uuid, p_enabled boolean, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
 if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'dispensa_motivo_obrigatorio'; end if;
 if not exists(select 1 from public.profiles where id = p_teacher and tenant_id = p_tenant and role = 'TEACHER') then raise exception 'dispensa_professor_invalido'; end if;
 if not exists(select 1 from public.profiles where id = p_decided_by and tenant_id = p_tenant and role = 'SCHOOL_ADMIN') then raise exception 'dispensa_autor_invalido'; end if;
 select id into v_id from private.teacher_general_contract_waivers where tenant_id = p_tenant and teacher_id = p_teacher and revoked_at is null;
 if p_enabled then
  if v_id is null then
   insert into private.teacher_general_contract_waivers(tenant_id, teacher_id, decided_by, reason) values (p_tenant, p_teacher, p_decided_by, btrim(p_reason)) returning id into v_id;
  end if;
 elsif v_id is not null then
  update private.teacher_general_contract_waivers set revoked_at = now(), revoked_by = p_decided_by, revoke_reason = btrim(p_reason) where id = v_id;
 end if;
 return v_id;
end;$$;
alter function private.set_teacher_general_contract_waiver(text, uuid, uuid, boolean, text) owner to postgres;
revoke all on function private.set_teacher_general_contract_waiver(text, uuid, uuid, boolean, text) from public, anon, authenticated, service_role;

do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('private.student_term_source_valid(private.teacher_student_terms)'::regprocedure);
 if strpos(s,'teacher_general_contract_waived')=0 then
  anchor:='if not exists(select 1 from public.profiles where id=p.teacher_id and contract_accepted) or not private.tenant_is_operational';
  if strpos(s,anchor)=0 then raise exception 'source_valid_anchor_changed';end if;
  execute replace(s,anchor,'if not(exists(select 1 from public.profiles where id=p.teacher_id and contract_accepted) or private.teacher_general_contract_waived(p.tenant_id,p.teacher_id)) or not private.tenant_is_operational');
 end if;

 s:=pg_get_functiondef('public.teacher_student_terms(text,uuid,jsonb)'::regprocedure);
 if strpos(s,'general_contract_waived')=0 then
  anchor:='''general_contract_accepted'',actor.contract_accepted,';
  if strpos(s,anchor)=0 then raise exception 'terms_list_anchor_changed';end if;
  s:=replace(s,anchor,anchor||'''general_contract_waived'',private.teacher_general_contract_waived(tenant,uid),');
  -- Quem assina fica sabendo o motivo real em vez de "fonte alterada".
  anchor:='  if actor.lifecycle_status<>''active'' or r.status<>''PROPOSED'' or r.provider_identity is null or not private.student_term_source_valid(r) then raise exception ''Proposta indisponível';
  if strpos(s,anchor)=0 then raise exception 'terms_sign_anchor_changed';end if;
  s:=replace(s,anchor,'  if not exists(select 1 from public.profiles where id=r.teacher_id and contract_accepted) and not private.teacher_general_contract_waived(r.tenant_id,r.teacher_id) then raise exception ''O contrato geral do professor está pendente. Este termo só pode ser assinado depois do aceite do contrato geral ou da dispensa registrada pela direção.'';end if;'||E'\n'||anchor);
  execute s;
 end if;
end;$patch$;
