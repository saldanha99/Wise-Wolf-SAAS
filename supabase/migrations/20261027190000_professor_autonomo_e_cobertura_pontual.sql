-- Reexecutável. Decisões da direção em 27/10/2026, depois da auditoria do termo
-- individual (nenhum dos professores ativos tinha CNPJ cadastrado, então ninguém
-- conseguia assinar termo nem o contrato geral v3):
--  1. Professor sem CNPJ assina o contrato geral v2 (pessoa física), o mesmo texto
--     já aceito pelos demais professores. O v3 continua sendo o contrato entre
--     empresas para quem tem CNPJ. Nenhum contrato assinado é reescrito.
--  2. O termo individual aceita prestador pessoa física (autônomo, CPF).
--  3. Cobertura pontual de aluno atual, por professor com contrato geral aceito,
--     dispensa o termo: vale o contrato geral e o link de aceite. Transferência,
--     aluno novo e troca de titular continuam exigindo termo.

-- 1. Contrato geral PF quando a escola oferece o v3.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('private.accept_teacher_contract_v2(text,integer)'::regprocedure);
 if strpos(s,'teacher_pf_contract')=0 then
  anchor:=E'    and p_terms_version is distinct from private.contract_terms_offered_version(\n      v_tenant, ''TEACHER''\n    )\n';
  if strpos(s,anchor)=0 then raise exception 'teacher_contract_v2_anchor_changed';end if;
  -- A v2 só vale fora da oferta quando o próprio professor escolheu o caminho PF
  -- pela fachada pública, nesta transação.
  s:=replace(s,anchor,anchor||E'    and not (p_terms_version = 2 and private.contract_terms_offered_version(v_tenant, ''TEACHER'') >= 3\n      and pg_catalog.current_setting(''app.teacher_pf_contract'', true) = ''on'')\n');
  execute s;
 end if;
end;$patch$;

create or replace function public.accept_teacher_contract(p_typed_signature text, p_terms_version integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tenant text; v_accepted boolean; v_result jsonb;
begin
  if (select auth.uid()) is null then return jsonb_build_object('ok',false,'error','nao_autenticado'); end if;
  select tenant_id,contract_accepted into v_tenant,v_accepted from public.profiles where id = (select auth.uid());
  if coalesce(v_accepted,false) then
    return private.accept_teacher_contract_v2(p_typed_signature,p_terms_version);
  end if;
  -- Professor sem CNPJ: contrato de pessoa física (v2) mesmo com o v3 oferecido.
  if p_terms_version = 2 and private.contract_terms_offered_version(v_tenant,'TEACHER') >= 3 then
    perform set_config('app.teacher_pf_contract','on',true);
    v_result := private.accept_teacher_contract_v2(p_typed_signature,2);
    perform set_config('app.teacher_pf_contract','',true);
    return v_result;
  end if;
  if coalesce(p_terms_version, 1) >= 3 or private.contract_terms_offered_version(v_tenant,'TEACHER') >= 3 then
    return jsonb_build_object('ok',false,'error','versao_invalida');
  end if;
  return private.accept_teacher_contract_v2(p_typed_signature,p_terms_version);
end;
$$;
alter function public.accept_teacher_contract(text,integer) owner to postgres;
revoke all on function public.accept_teacher_contract(text,integer) from public, anon;
grant execute on function public.accept_teacher_contract(text,integer) to authenticated;

-- 2. Identidade de prestador pessoa física no termo individual.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.teacher_student_terms(text,uuid,jsonb)'::regprocedure);
 if strpos(s,'''INDIVIDUAL''')=0 then
  anchor:=E'  if jsonb_typeof(v_identity) is distinct from ''object'' or length(btrim(coalesce(v_identity->>''companyName'','''')))';
  if strpos(s,anchor)=0 then raise exception 'term_identity_anchor_changed';end if;
  s:=replace(s,anchor,E'  if v_identity->>''kind''=''INDIVIDUAL'' then\n   if not coalesce(public.is_valid_cpf(v_cpf),false) or length(btrim(coalesce(v_identity->>''companyAddress'',''''))) not between 5 and 300 or v_identity->''representativeHasAuthority'' is distinct from ''true''::jsonb then raise exception ''CPF ou endereço inválidos, ou declaração ausente.'';end if;\n   v_identity:=jsonb_build_object(''kind'',''INDIVIDUAL'',''companyName'',btrim(actor.full_name)||'' (pessoa física, autônomo)'',''cnpj'',''não se aplica (pessoa física)'',''companyAddress'',btrim(v_identity->>''companyAddress''),''representativeCpf'',v_cpf,''representativeHasAuthority'',true);\n  else\n'||anchor);
  anchor:=E'\n  insert into private.teacher_service_identities';
  if strpos(s,anchor)=0 then raise exception 'term_identity_insert_anchor_changed';end if;
  s:=replace(s,anchor,E'\n  end if;'||anchor);
  execute s;
 end if;
 s:=pg_get_functiondef('private.student_term_render(private.teacher_student_terms)'::regprocedure);
 if strpos(s,'Prestador pessoa física')=0 then
  anchor:=E'E''\\n\\nALUNO BENEFICIÁRIO: ''';
  if strpos(s,anchor)=0 then raise exception 'term_render_anchor_changed';end if;
  s:=replace(s,anchor,E'case when p.provider_identity->>''kind''=''INDIVIDUAL'' then E''\\nPrestador pessoa física: contrata em nome próprio; as referências deste termo a empresa, representante e poderes de representação aplicam-se ao próprio prestador.'' else '''' end||'||anchor);
  execute s;
 end if;
end;$patch$;

-- 3. Cobertura pontual de aluno atual.
create or replace function private.student_term_coverage_exempt(p_tenant text,p_student uuid,p_titular uuid,p_cover uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select p_titular is not null and p_cover is not null
  and private.student_term_covers_reschedule(p_tenant,p_student,p_titular)
  and exists(select 1 from public.profiles c where c.id=p_cover and c.tenant_id=p_tenant and c.role='TEACHER' and c.contract_accepted)
  and public.teacher_opportunity_recipient_eligible(p_tenant,p_cover);
$$;

do $patch$
declare s text;anchor text;
begin
 -- Guarda: a cobertura confirmada de aluno atual não procura termo.
 s:=pg_get_functiondef('private.guard_student_individual_term()'::regprocedure);
 if strpos(s,'student_term_coverage_exempt')=0 then
  anchor:=E'  if tg_op=''UPDATE'' and lower(old.status)=''confirmed'' and row(new.tenant_id,new.student_id,new.cover_teacher_id,new.class_date,new.class_time,new.booking_id) is not distinct from row(old.tenant_id,old.student_id,old.cover_teacher_id,old.class_date,old.class_time,old.booking_id) then return new;end if;\n';
  if strpos(s,anchor)=0 then raise exception 'guard_coverage_anchor_changed';end if;
  execute replace(s,anchor,anchor||E'  if sid is not null and teacher is not null and private.student_term_coverage_exempt(t,sid,b.teacher_id,teacher) then return new;end if;\n');
 end if;
 -- Proposta: não nasce termo (nem aviso) para cobertura dispensada.
 s:=pg_get_functiondef('private.student_term_source_proposal()'::regprocedure);
 if strpos(s,'student_term_coverage_exempt')=0 then
  anchor:=E'  if new.cover_teacher_id is null or new.student_id is null or lower(new.status) not in(''pending'',''scheduled'') then return new;end if;\n';
  if strpos(s,anchor)=0 then raise exception 'proposal_coverage_anchor_changed';end if;
  execute replace(s,anchor,anchor||E'  if private.student_term_coverage_exempt(new.tenant_id,new.student_id,(select bk.teacher_id from public.bookings bk where bk.id=new.booking_id and bk.tenant_id=new.tenant_id),new.cover_teacher_id) then return new;end if;\n');
 end if;
 s:=pg_get_functiondef('private.student_term_coverage_opportunity()'::regprocedure);
 if strpos(s,'student_term_coverage_exempt')=0 then
  anchor:=E' select * into b from public.bookings where id=op.booking_id and tenant_id=op.tenant_id;\n';
  if strpos(s,anchor)=0 then raise exception 'opportunity_coverage_anchor_changed';end if;
  execute replace(s,anchor,anchor||E' if private.student_term_coverage_exempt(op.tenant_id,op.student_id,b.teacher_id,new.teacher_id) then return new;end if;\n');
 end if;
end;$patch$;

do $$declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname in('student_term_coverage_exempt','guard_student_individual_term','student_term_source_proposal','student_term_coverage_opportunity','student_term_render','accept_teacher_contract_v2') loop
  execute format('alter function %s owner to postgres',r.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end$$;
alter function public.teacher_student_terms(text,uuid,jsonb) owner to postgres;
revoke all on function public.teacher_student_terms(text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.teacher_student_terms(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
