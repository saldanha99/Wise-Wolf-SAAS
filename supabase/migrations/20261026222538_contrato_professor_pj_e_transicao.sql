-- V3 exclusiva para contratos NOVOS de professor. Não altera aceites ou cópias.
-- Reexecutável, sem commit. A assinatura individual por aluno é outra implementação.
insert into public.contract_terms_versions (contract_kind, version, includes_lesson_recording, description)
values ('TEACHER', 3, true, 'PJ identificada, autonomia, direitos preservados e transição contratual bilateral de 30 dias.')
on conflict (contract_kind, version) do nothing;

create or replace function private.teacher_provider_cnpj_valid(p_value text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_cnpj text := upper(regexp_replace(btrim(coalesce(p_value, '')), '[./\s-]', '', 'g'));
  v_base text;
  v_weight integer;
  v_sum integer;
  v_digit integer;
  i integer;
  n integer;
begin
  if v_cnpj !~ '^[A-Z0-9]{12}[0-9]{2}$' or v_cnpj ~ '^([0-9])\1{13}$' then return false; end if;
  for n in 12..13 loop
    v_base := left(v_cnpj, n); v_weight := n - 7; v_sum := 0;
    for i in 1..n loop
      v_sum := v_sum + (ascii(substr(v_base, i, 1)) - 48) * v_weight;
      v_weight := case when v_weight = 2 then 9 else v_weight - 1 end;
    end loop;
    v_digit := case when v_sum % 11 < 2 then 0 else 11 - v_sum % 11 end;
    if substr(v_cnpj, n + 1, 1)::integer <> v_digit then return false; end if;
  end loop;
  return true;
end;
$$;
alter function private.teacher_provider_cnpj_valid(text) owner to postgres;
revoke all on function private.teacher_provider_cnpj_valid(text) from public, anon, authenticated;

-- Guarda o corpo legado intacto e mantém a API de dois argumentos sem overload.
do $$
begin
  if to_regprocedure('private.accept_teacher_contract_v2(text,integer)') is null then
    alter function public.accept_teacher_contract(text,integer) set schema private;
    alter function private.accept_teacher_contract(text,integer) rename to accept_teacher_contract_v2;
  end if;
end;
$$;
revoke all on function private.accept_teacher_contract_v2(text,integer) from public, anon, authenticated;

create or replace function public.accept_teacher_contract(p_typed_signature text, p_terms_version integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tenant text; v_accepted boolean;
begin
  if (select auth.uid()) is null then return jsonb_build_object('ok',false,'error','nao_autenticado'); end if;
  select tenant_id,contract_accepted into v_tenant,v_accepted from public.profiles where id = (select auth.uid());
  if coalesce(v_accepted,false) then
    return private.accept_teacher_contract_v2(p_typed_signature,p_terms_version);
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

create or replace function public.accept_teacher_pj_contract(
  p_typed_signature text, p_terms_version integer, p_provider_identity jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
  v_school jsonb;
  v_identity jsonb;
  v_name text;
  v_cnpj text;
  v_address text;
  v_cpf text;
  v_sig text := btrim(coalesce(p_typed_signature,''));
  v_ip text;
  v_now timestamptz := now();
begin
  if v_uid is null then return jsonb_build_object('ok',false,'error','nao_autenticado'); end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if v_profile.role is distinct from 'TEACHER'
    or private.active_tenant_role(v_uid) is distinct from 'TEACHER'
    or private.active_tenant_id(v_uid) is distinct from v_profile.tenant_id
    or v_profile.status is distinct from 'Ativo' then
    return jsonb_build_object('ok',false,'error','contexto_invalido');
  end if;
  -- Repetição idêntica não reescreve a cópia, nem mesmo depois da mudança de oferta.
  if coalesce(v_profile.contract_accepted,false) then
    if exists (select 1 from public.tenant_contract_records where user_id = v_uid
      and tenant_id = v_profile.tenant_id and contract_kind = 'TEACHER'
      and commercial_snapshot ->> 'contractTermsVersion' = '3') then
      return jsonb_build_object('ok',true,'already',true);
    end if;
    return jsonb_build_object('ok',false,'error','contrato_ja_assinado');
  end if;
  if exists (select 1 from public.tenant_contract_records where user_id = v_uid
    and tenant_id = v_profile.tenant_id and contract_kind = 'TEACHER') then
    return jsonb_build_object('ok',false,'error','contrato_ja_assinado');
  end if;
  perform 1 from public.tenant_contract_terms where tenant_id = v_profile.tenant_id and contract_kind = 'TEACHER' for share;
  if p_terms_version is distinct from 3 or private.contract_terms_offered_version(v_profile.tenant_id,'TEACHER') is distinct from 3 then
    return jsonb_build_object('ok',false,'error','versao_invalida');
  end if;
  if length(v_sig) < 3 or lower(v_sig) is distinct from lower(btrim(v_profile.full_name)) then
    return jsonb_build_object('ok',false,'error','assinatura_invalida');
  end if;
  v_name := btrim(p_provider_identity ->> 'companyName');
  v_cnpj := upper(regexp_replace(btrim(p_provider_identity ->> 'cnpj'),'[./\s-]','','g'));
  v_address := btrim(p_provider_identity ->> 'companyAddress');
  v_cpf := regexp_replace(btrim(p_provider_identity ->> 'representativeCpf'),'[.\s-]','','g');
  if jsonb_typeof(p_provider_identity) is distinct from 'object'
    or jsonb_typeof(p_provider_identity -> 'companyName') is distinct from 'string'
    or jsonb_typeof(p_provider_identity -> 'cnpj') is distinct from 'string'
    or jsonb_typeof(p_provider_identity -> 'companyAddress') is distinct from 'string'
    or jsonb_typeof(p_provider_identity -> 'representativeCpf') is distinct from 'string'
    or coalesce(length(v_name),0) not between 2 and 160
    or coalesce(length(v_address),0) not between 5 and 300
    or not coalesce(private.teacher_provider_cnpj_valid(v_cnpj),false)
    or coalesce(v_cpf,'') !~ '^[0-9]{11}$' or not public.is_valid_cpf(v_cpf)
    or (p_provider_identity -> 'representativeHasAuthority') is distinct from 'true'::jsonb then
    return jsonb_build_object('ok',false,'error','empresa_invalida');
  end if;
  v_identity := jsonb_build_object('companyName',v_name,'cnpj',v_cnpj,'companyAddress',v_address,
    'representativeCpf',v_cpf,'representativeHasAuthority',true);
  perform 1 from public.tenants where id = v_profile.tenant_id for share;
  begin
    v_school := private.contract_school_info(v_profile.tenant_id);
  exception when sqlstate '22023' then
    return jsonb_build_object('ok',false,'error','escola_sem_identidade_juridica');
  end;
  if v_profile.hourly_rate is null or v_profile.hourly_rate <= 0 then
    return jsonb_build_object('ok',false,'error','valor_por_aula_ausente');
  end if;
  begin
    v_ip := split_part(coalesce(nullif(current_setting('request.headers',true),'')::json ->> 'x-forwarded-for',
      nullif(current_setting('request.headers',true),'')::json ->> 'x-real-ip',''),',',1);
  exception when others then v_ip := null;
  end;
  insert into public.tenant_contract_records (tenant_id,user_id,contract_kind,party_snapshot,legal_snapshot,
    commercial_snapshot,signed_document_path,accepted_at,accepted_ip)
  values (v_profile.tenant_id,v_uid,'TEACHER',jsonb_build_object('fullName',v_profile.full_name,
    'rg',coalesce(v_profile.rg,'---'),'cpf',v_cpf,'address',v_profile.address,
    'birthDate',coalesce(to_char(v_profile.birth_date,'DD/MM/YYYY'),'---'),'providerIdentity',v_identity),
    v_school,jsonb_build_object('hourlyRate',v_profile.hourly_rate,'subject',v_profile.module,
    'contractTermsVersion',3,'acceptedVia','TEACHER_CONTRACT_ACCEPT','displayRateUnit','PER_LESSON'),null,v_now,nullif(v_ip,''));
  insert into public.contract_terms_acceptances (tenant_id,user_id,contract_kind,terms_version,source,accepted_at)
  values (v_profile.tenant_id,v_uid,'TEACHER',3,'TEACHER_CONTRACT_ACCEPT',v_now);
  update public.profiles set contract_accepted=true,accepted_at=v_now,typed_signature=v_sig,
    signature_ip=nullif(v_ip,''),signature_hash=encode(extensions.digest(v_uid::text||'|'||v_sig||'|'||v_now::text,'sha256'),'hex'),
    cnpj=v_cnpj,cnpj_company_name=v_name where id=v_uid;
  return jsonb_build_object('ok',true,'accepted_at',v_now,'terms_version',3);
end;
$$;
alter function public.accept_teacher_pj_contract(text,integer,jsonb) owner to postgres;
revoke all on function public.accept_teacher_pj_contract(text,integer,jsonb) from public, anon;
grant execute on function public.accept_teacher_pj_contract(text,integer,jsonb) to authenticated;

-- Oferta futura somente da Wise Wolf, preservando outras escolas e decisão posterior.
do $$
begin
  if not exists (select 1 from public.schema_one_shots where key='contrato_professor_pj_v3_20261026')
    and exists (select 1 from public.tenant_contract_terms where tenant_id='school-wise-wolf' and contract_kind='TEACHER' and terms_version=2) then
    update public.tenant_contract_terms set terms_version=3,decided_at=now(),
      note='Revisão solicitada pela direção: identificação PJ, autonomia e saída bilateral com transição de 30 dias.'
      where tenant_id='school-wise-wolf' and contract_kind='TEACHER' and terms_version=2;
    insert into public.schema_one_shots(key,nota) values ('contrato_professor_pj_v3_20261026','V3 somente para novos contratos do professor, sem reescrever ou exigir novo aceite de contratos anteriores.');
  end if;
end;
$$;
