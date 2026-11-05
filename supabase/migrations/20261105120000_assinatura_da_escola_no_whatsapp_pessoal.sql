-- Link de assinatura da escola no WhatsApp pessoal (decisão da direção, 05/11/2026).
--
-- O link saía do número central da escola para o próprio número central: o perfil
-- do diretor tem o telefone da instância que envia. A fila marcava "enviado", mas
-- até 05/11 foram 10 links da escola e nenhum aberto. Como a agenda do aluno só
-- nasce com a assinatura, aluno pago ficava sem aula e sem sinal para ninguém.
--
-- Agora o link da escola vai para um celular que a própria direção cadastra no
-- portal. O número central é recusado, e o telefone do perfil só serve quando não
-- é o central. Sem número válido o link não sai (nunca para si mesmo), e o termo
-- aparece na Central de Pendências de qualquer forma.
--
-- Remendos por âncora: student_term_issue_link, whatsapp_outbound_kind e
-- director_pending_counts. Não recrie essas funções a partir de texto antigo.

create table if not exists private.term_signature_contacts(
 tenant_id text not null references public.tenants(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 phone text not null,
 set_by uuid not null,
 set_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,user_id));
alter table private.term_signature_contacts owner to postgres;
alter table private.term_signature_contacts enable row level security;
revoke all on private.term_signature_contacts from public,anon,authenticated,service_role;

-- O número é o da instância central? Compara os 8 últimos dígitos, a régua do
-- projeto para o 9º dígito (whatsapp_outbound_kind).
create or replace function private.term_signature_phone_is_central(p_tenant text,p_phone text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.profiles p
   where p.tenant_id=p_tenant and upper(coalesce(p.role,'')) in('SCHOOL_ADMIN','SUPER_ADMIN')
     and nullif(btrim(coalesce(p.whatsapp_instance,'')),'') is not null
     and length(regexp_replace(coalesce(p.phone,''),'\D','','g'))>=8
     and right(regexp_replace(coalesce(p.phone,''),'\D','','g'),8)=right(regexp_replace(coalesce(p_phone,''),'\D','','g'),8));
$$;

-- Para onde vai o link de quem assina pela escola: o número cadastrado ou, em
-- escola sem esse problema, o telefone do perfil. Nulo = não enviar.
create or replace function private.student_term_school_signer_phone(p_tenant text,p_user uuid)
returns text language sql stable security definer set search_path='' as $$
 select coalesce(
  (select c.phone from private.term_signature_contacts c where c.tenant_id=p_tenant and c.user_id=p_user),
  (select z.d from(select private.whatsapp_digits(nullif(p.phone,'')) d from public.profiles p where p.id=p_user) z
    where z.d is not null and not private.term_signature_phone_is_central(p_tenant,z.d)));
$$;

-- Quem assina: diretor ativo com destino válido, preferindo quem cadastrou o
-- número e, depois, quem já assinou termos.
create or replace function private.student_term_school_signer(p_tenant text)
returns uuid language sql stable security definer set search_path='' as $$
 select m.user_id from public.tenant_memberships m join public.profiles p on p.id=m.user_id
 where m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='SCHOOL_ADMIN'
  and lower(coalesce(p.lifecycle_status,'active'))='active'
  and private.student_term_school_signer_phone(p_tenant,m.user_id) is not null
 order by exists(select 1 from private.term_signature_contacts c where c.tenant_id=p_tenant and c.user_id=m.user_id) desc,
  (select count(*) from private.teacher_student_terms t where t.school_signed_by=m.user_id) desc,m.created_at
 limit 1;
$$;

-- O link da escola passa a usar o destino acima.
do $patch$
declare s text;anchor text:='select private.whatsapp_digits(nullif(p.phone,'''')),p.full_name into v_phone,v_name from public.profiles p where p.id=v_signer;';
begin
 s:=pg_get_functiondef('private.student_term_issue_link(uuid,text,boolean)'::regprocedure);
 if strpos(s,'student_term_school_signer_phone')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'term_issue_link_phone_anchor_changed';end if;
 s:=replace(s,anchor,'select case when p_signer=''SCHOOL'' then private.student_term_school_signer_phone(r.tenant_id,v_signer) else private.whatsapp_digits(nullif(p.phone,'''')) end,p.full_name into v_phone,v_name from public.profiles p where p.id=v_signer;');
 execute s;
end;$patch$;

-- O celular de quem assina é da equipe, não contato frio: sem isso cairia no teto
-- de prospecção e um link de assinatura poderia esperar horas.
do $patch$
declare s text;anchor text:=E'  then return ''reply''; end if;\n';
begin
 s:=pg_get_functiondef('private.whatsapp_outbound_kind(text)'::regprocedure);
 if strpos(s,'term_signature_contacts')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'whatsapp_outbound_kind_anchor_changed';end if;
 s:=replace(s,anchor,anchor||E'  if exists (\n       select 1 from private.term_signature_contacts c\n        where right(pg_catalog.regexp_replace(c.phone, ''\\D'', '''', ''g''), 8) = v_tail)\n  then return ''staff''; end if;\n');
 execute s;
end;$patch$;

-- Termos que só dependem de a escola abrir e assinar. Sem os dados do prestador a
-- escola ainda não pode assinar, então não entram.
create or replace function private.student_term_school_pending_count(p_tenant text)
returns integer language sql stable security definer set search_path='' as $$
 select count(*)::integer from private.teacher_student_terms t
  where t.tenant_id=p_tenant and t.status='PROPOSED' and t.retired_at is null
    and t.school_signed_at is null and t.provider_identity is not null;
$$;

do $patch$
declare s text;anchor text:='-- Rascunho de resumo de aula parado há 3+ dias (20260927110000).';
begin
 s:=pg_get_functiondef('public.director_pending_counts()'::regprocedure);
 if strpos(s,'termos_para_assinar')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'director_pending_counts_anchor_changed';end if;
 s:=replace(s,anchor,E'-- Termo por aluno esperando a escola (20261105120000): a agenda só nasce com ele.\n    || pg_catalog.jsonb_build_object(''termos_para_assinar'', private.student_term_school_pending_count(v_tenant_id))\n    '||anchor);
 execute s;
end;$patch$;

-- Cartão "WhatsApp para assinar pela escola".
create or replace function public.my_term_signature_contact()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();tenant text:=private.active_tenant_id(uid);v_phone text;
begin
 if uid is null or coalesce(private.active_tenant_role(uid),'')<>'SCHOOL_ADMIN' then
  return jsonb_build_object('ok',false,'error','not_authorized');
 end if;
 select c.phone into v_phone from private.term_signature_contacts c where c.tenant_id=tenant and c.user_id=uid;
 return jsonb_build_object('ok',true,'phone',v_phone,
  'needs_number',private.student_term_school_signer_phone(tenant,uid) is null,
  'pending',private.student_term_school_pending_count(tenant));
end;$$;

-- Só a própria direção cadastra o próprio número. Número novo reemite os links em
-- aberto: o antigo é revogado e o novo sai para o celular certo. Salvar o mesmo
-- número não manda nada de novo. A auditoria guarda só o final do telefone.
create or replace function public.set_my_term_signature_contact(p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();tenant text:=private.active_tenant_id(uid);v_phone text;v_old text;v_term uuid;n int:=0;
begin
 if uid is null or coalesce(private.active_tenant_role(uid),'')<>'SCHOOL_ADMIN' then
  return jsonb_build_object('ok',false,'error','not_authorized');
 end if;
 v_phone:=private.whatsapp_digits(nullif(btrim(coalesce(p_phone,'')),''));
 if v_phone is null then return jsonb_build_object('ok',false,'error','numero_invalido');end if;
 if private.term_signature_phone_is_central(tenant,v_phone) then
  return jsonb_build_object('ok',false,'error','numero_da_escola');
 end if;
 select c.phone into v_old from private.term_signature_contacts c where c.tenant_id=tenant and c.user_id=uid for update;
 if v_old=v_phone then return jsonb_build_object('ok',true,'phone',v_phone,'links_sent',0);end if;
 insert into private.term_signature_contacts(tenant_id,user_id,phone,set_by)
 values(tenant,uid,v_phone,uid)
 on conflict(tenant_id,user_id) do update set phone=excluded.phone,set_by=excluded.set_by,set_at=clock_timestamp();
 insert into public.audit_logs(tenant_id,user_id,action,resource_type,resource_id,old_values,new_values)
 values(tenant,uid,'TERM_SIGNATURE_CONTACT_SET','term_signature_contact',uid::text,
  case when v_old is null then null else jsonb_build_object('phone_end',right(v_old,4)) end,
  jsonb_build_object('phone_end',right(v_phone,4)));
 if private.student_term_school_signer(tenant)=uid then
  for v_term in select t.id from private.teacher_student_terms t
   where t.tenant_id=tenant and t.status='PROPOSED' and t.retired_at is null
     and t.school_signed_at is null and t.provider_identity is not null
   order by t.created_at loop
   begin
    if private.student_term_issue_link(v_term,'SCHOOL') then n:=n+1;end if;
   exception when others then raise warning '[termo individual] link da escola nao reemitido para %: %',v_term,sqlerrm;end;
  end loop;
 end if;
 return jsonb_build_object('ok',true,'phone',v_phone,'links_sent',n);
end;$$;

-- Horário de matrícula segurado à espera do termo. A agenda só lia aulas já
-- criadas e mostrava esse horário como LIVRE, embora nenhuma outra matrícula possa
-- pegá-lo. jsonb de propósito, como list_future_start_holds.
create or replace function public.list_term_reserved_slots(p_tenant_id text,p_teacher_ids uuid[] default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'slot_id',s.id,'teacher_id',s.teacher_id,'student_label',t.student_name,
   'day_of_week',s.day_of_week::integer,'class_time',to_char(s.class_time,'HH24:MI'),
   'starts_on',to_char(t.starts_on,'YYYY-MM-DD'),
   'waiting_school',t.school_signed_at is null,'waiting_teacher',t.teacher_signed_at is null,'waiting_family',t.family_confirmed_at is null)
  order by s.day_of_week,s.class_time),'[]'::jsonb)
 from private.enrollment_offer_schedule_slots s
 join public.offers o on o.id=s.offer_id and o.revoked_at is null
 join private.teacher_student_terms t on t.source_kind='ENROLLMENT' and t.source_id=s.offer_id
  and t.teacher_id=s.teacher_id and t.student_id=s.reserved_by and t.status='PROPOSED' and t.retired_at is null
 where s.tenant_id=p_tenant_id and s.status='RESERVED' and s.reservation_expires_at>now()
   and (p_teacher_ids is null or s.teacher_id=any(p_teacher_ids))
   and (private.future_start_hold_actor_can_manage(p_tenant_id) or s.teacher_id=auth.uid());
$$;

do $$declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and p.proname in('term_signature_phone_is_central','student_term_school_signer_phone','student_term_school_signer','student_term_school_pending_count'))
   or (n.nspname='public' and p.proname in('my_term_signature_contact','set_my_term_signature_contact','list_term_reserved_slots')) loop
  execute format('alter function %s owner to postgres',r.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end$$;
grant execute on function public.my_term_signature_contact() to authenticated;
grant execute on function public.set_my_term_signature_contact(text) to authenticated;
grant execute on function public.list_term_reserved_slots(text,uuid[]) to authenticated;
