\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

insert into public.tenants (id, name, slug, saas_status, school_info)
values
  (
    'invite-school-a', 'Invite School A', 'invite-school-a', 'active',
    jsonb_build_object(
      'legalName', 'Invite School A Ltda',
      'cnpj', '04252011000110',
      'address', 'Rua Segura, 100',
      'email', 'legal-a@example.invalid',
      'phone', '11999999999',
      'city', 'Sao Paulo',
      'state', 'SP',
      'legalRepresentativeName', 'Representante A',
      'legalRepresentativeSignatureUrl', rtrim(
        coalesce(
          nullif(current_setting('app.settings.api_external_url', true), ''),
          'https://api.wisewolflanguage.com.br'
        ),
        '/'
      ) || '/storage/v1/object/public/tenant-branding/invite-school-a/signature/00000000-0000-4000-8000-000000000ba1.png'
    )
  ),
  (
    'invite-school-b', 'Invite School B', 'invite-school-b', 'active',
    jsonb_build_object(
      'legalName', 'Invite School B Ltda',
      'cnpj', '11222333000181',
      'address', 'Rua Isolada, 200',
      'email', 'legal-b@example.invalid',
      'phone', '21999999999',
      'city', 'Rio de Janeiro',
      'state', 'RJ',
      'legalRepresentativeName', 'Representante B',
      'legalRepresentativeSignatureUrl', rtrim(
        coalesce(
          nullif(current_setting('app.settings.api_external_url', true), ''),
          'https://api.wisewolflanguage.com.br'
        ),
        '/'
      ) || '/storage/v1/object/public/tenant-branding/invite-school-b/signature/00000000-0000-4000-8000-000000000bb1.png'
    )
  );

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000b81', 'authenticated', 'authenticated', 'invite-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invite Admin A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000b82', 'authenticated', 'authenticated', 'invite-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invite Admin B"}', now(), now()),
  ('00000000-0000-4000-8000-000000000b83', 'authenticated', 'authenticated', 'invite-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invite Teacher A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000b84', 'authenticated', 'authenticated', 'invite-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invite Teacher B"}', now(), now());

update public.profiles
set tenant_id = 'invite-school-a', role = 'SCHOOL_ADMIN'
where id = '00000000-0000-4000-8000-000000000b81';
update public.profiles
set tenant_id = 'invite-school-b', role = 'SCHOOL_ADMIN'
where id = '00000000-0000-4000-8000-000000000b82';
update public.profiles
set tenant_id = 'invite-school-a', role = 'TEACHER', hourly_rate = 50
where id = '00000000-0000-4000-8000-000000000b83';
update public.profiles
set tenant_id = 'invite-school-b', role = 'TEACHER', hourly_rate = 50
where id = '00000000-0000-4000-8000-000000000b84';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values
  ('00000000-0000-4000-8000-000000000b81', 'invite-school-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000b82', 'invite-school-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000b83', 'invite-school-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000b84', 'invite-school-b', 'TEACHER', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-000000000b81', 'invite-school-a'),
  ('00000000-0000-4000-8000-000000000b82', 'invite-school-b'),
  ('00000000-0000-4000-8000-000000000b83', 'invite-school-a')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id, updated_at = now();

select pg_temp.assert_true(
  private.valid_cnpj('04.252.011/0001-10')
    and not private.valid_cnpj('04.252.011/0001-11'),
  'validacao de digitos do CNPJ esta incorreta'
);

do $$
declare
  original_school_info jsonb;
begin
  select school_info
  into original_school_info
  from public.tenants
  where id = 'invite-school-b';

  update public.tenants
  set school_info = school_info - 'address'
  where id = 'invite-school-b';

  begin
    perform private.contract_school_info('invite-school-b');
    raise exception 'assertion failed: snapshot juridico incompleto foi aceito';
  exception when invalid_parameter_value then null;
  end;

  update public.tenants
  set school_info = original_school_info
  where id = 'invite-school-b';
end;
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b81","role":"authenticated"}';

do $$
begin
  perform public.create_invite_offer(
    'TEACHER_INVITE',
    jsonb_build_object(
      'tenantId', 'invite-school-b',
      'hourlyRate', 50,
      'subject', 'Ingles'
    )
  );
  raise exception 'assertion failed: tenantId adulterado foi aceito';
exception when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.create_invite_offer(
    'TEACHER_INVITE',
    jsonb_build_object(
      'tenantId', 'invite-school-a',
      'hourlyRate', 50,
      'subject', 'Ingles',
      'schoolInfo', jsonb_build_object('legalName', 'Identidade adulterada')
    )
  );
  raise exception 'assertion failed: identidade juridica do navegador foi aceita';
exception when invalid_parameter_value then null;
end;
$$;

do $$
begin
  perform public.create_invite_offer(
    'VENDOR_INVITE',
    jsonb_build_object(
      'tenantId', 'invite-school-a',
      'commissionRate', 12.5
    )
  );
  raise exception 'assertion failed: comissao fracionaria foi aceita';
exception when invalid_parameter_value then null;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    jsonb_build_object(
      'unitId', 'invite-school-b',
      'value', 500,
      'dueDay', 10,
      'planDuration', 1,
      'classesPerWeek', 2,
      'requiresEnrollment', true,
      'enrollmentFee', 0
    )
  );
  raise exception 'assertion failed: oferta de matricula cruzada foi aceita';
exception when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    jsonb_build_object(
      'unitId', 'invite-school-a',
      'value', 500,
      'dueDay', 10,
      'planDuration', 1,
      'classesPerWeek', 2,
      'enrollmentFee', 0,
      'professorId', '00000000-0000-4000-8000-000000000b84'
    )
  );
  raise exception 'assertion failed: professor de outro tenant foi aceito';
exception when insufficient_privilege then null;
end;
$$;

select public.create_enrollment_offer(
  jsonb_build_object(
    'unitId', 'invite-school-a',
    'value', 500,
    'dueDay', 10,
    'planDuration', 1,
    'classesPerWeek', 2,
    'enrollmentFee', 0
  )
) as enrollment_offer_id \gset

select public.create_invite_offer(
  'TEACHER_INVITE',
  jsonb_build_object(
    'tenantId', 'invite-school-a',
    'hourlyRate', 50,
    'subject', '  Ingles  '
  )
) as teacher_offer_id \gset

select public.create_invite_offer(
  'TEACHER_INVITE',
  jsonb_build_object(
    'tenantId', 'invite-school-a',
    'hourlyRate', 50,
    'subject', 'Ingles'
  )
) as suspended_teacher_offer_id \gset

select public.create_invite_offer(
  'TEACHER_INVITE',
  jsonb_build_object(
    'tenantId', 'invite-school-a',
    'hourlyRate', 50,
    'subject', 'Ingles'
  )
) as expired_teacher_offer_id \gset

select public.create_invite_offer(
  'TEACHER_INVITE',
  jsonb_build_object(
    'tenantId', 'invite-school-a',
    'hourlyRate', 50,
    'subject', 'Ingles'
  )
) as stale_teacher_offer_id \gset

select public.create_invite_offer(
  'VENDOR_INVITE',
  jsonb_build_object(
    'tenantId', 'invite-school-a',
    'commissionRate', 250
  )
) as suspended_vendor_offer_id \gset

reset role;

select pg_temp.assert_true(
  (
    select tenant_id = 'invite-school-a'
      and payload ->> 'tenantId' = 'invite-school-a'
      and payload ->> 'subject' = 'Ingles'
      and payload -> 'schoolInfo' ->> 'legalName' = 'Invite School A Ltda'
      and invite_security_version = 1
    from public.offers
    where id = :'teacher_offer_id'::uuid
  ),
  'oferta nao foi vinculada ao tenant ativo'
);

select pg_temp.assert_true(
  (
    select tenant_id = 'invite-school-a'
      and payload ->> 'unitId' = 'invite-school-a'
      and payload -> '_schoolInfo' ->> 'legalName' = 'Invite School A Ltda'
      and invite_security_version = 1
    from public.offers
    where id = :'enrollment_offer_id'::uuid
  ),
  'wrapper de matricula nao preservou o tenant ativo'
);

select public.claim_invite_offer_server(
  :'teacher_offer_id'::uuid,
  'TEACHER_INVITE',
  '00000000-0000-4000-8000-000000000b91'
);

select public.claim_invite_offer_server(
  :'expired_teacher_offer_id'::uuid,
  'TEACHER_INVITE',
  '00000000-0000-4000-8000-000000000b95'
);

select public.claim_invite_offer_server(
  :'stale_teacher_offer_id'::uuid,
  'TEACHER_INVITE',
  '00000000-0000-4000-8000-000000000b96'
);

select public.claim_invite_offer_server(
  :'suspended_teacher_offer_id'::uuid,
  'TEACHER_INVITE',
  '00000000-0000-4000-8000-000000000b93'
);

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where invite_claim_token = '00000000-0000-4000-8000-000000000b93'
  limit 1;

  if offer_id is null then
    raise exception 'assertion failed: convite reivindicado nao foi localizado';
  end if;

  perform public.claim_invite_offer_server(
    offer_id,
    'TEACHER_INVITE',
    '00000000-0000-4000-8000-000000000b92'
  );
  raise exception 'assertion failed: convite foi reivindicado duas vezes';
exception when no_data_found then null;
end;
$$;

insert into public.tenant_contract_records (
  tenant_id,
  user_id,
  contract_kind,
  party_snapshot,
  legal_snapshot,
  commercial_snapshot,
  signed_document_path,
  accepted_at,
  accepted_ip
)
values (
  'invite-school-a',
  '00000000-0000-4000-8000-000000000b83',
  'TEACHER',
  jsonb_build_object(
    'fullName', 'Invite Teacher A',
    'rg', '12345678',
    'cpf', '12345678909',
    'address', 'Rua do Professor, 1',
    'birthDate', '1990-01-01'
  ),
  private.contract_school_info('invite-school-a'),
  jsonb_build_object('hourlyRate', 50, 'subject', 'Ingles'),
  'invite-school-a/teacher/contract.pdf',
  now(),
  '127.0.0.1'
);

update public.offers
set expires_at = now() - interval '1 second'
where invite_claim_token = '00000000-0000-4000-8000-000000000b95';

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where invite_claim_token = '00000000-0000-4000-8000-000000000b95';

  if offer_id is null then
    raise exception 'assertion failed: convite expirado nao foi localizado';
  end if;

  perform public.finalize_invite_offer_server(
    offer_id,
    'TEACHER_INVITE',
    '00000000-0000-4000-8000-000000000b95',
    '00000000-0000-4000-8000-000000000b83'
  );
  raise exception 'assertion failed: convite expirado foi finalizado';
exception when no_data_found then null;
end;
$$;

update public.offers
set invite_claimed_at = now() - interval '16 minutes'
where invite_claim_token = '00000000-0000-4000-8000-000000000b96';

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where invite_claim_token = '00000000-0000-4000-8000-000000000b96';

  if offer_id is null then
    raise exception 'assertion failed: convite com lease vencido nao foi localizado';
  end if;

  perform public.finalize_invite_offer_server(
    offer_id,
    'TEACHER_INVITE',
    '00000000-0000-4000-8000-000000000b96',
    '00000000-0000-4000-8000-000000000b83'
  );
  raise exception 'assertion failed: lease vencido foi finalizado';
exception when no_data_found then null;
end;
$$;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.offers
    where id in (
      :'expired_teacher_offer_id'::uuid,
      :'stale_teacher_offer_id'::uuid
    )
      and consumed_at is not null
  ),
  'convite sem capacidade vigente foi consumido'
);

update public.tenant_contract_records
set commercial_snapshot = jsonb_build_object(
  'hourlyRate', 999,
  'subject', 'Ingles'
)
where tenant_id = 'invite-school-a'
  and user_id = '00000000-0000-4000-8000-000000000b83'
  and contract_kind = 'TEACHER';

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where invite_claim_token = '00000000-0000-4000-8000-000000000b91';

  if offer_id is null then
    raise exception 'assertion failed: convite contratual nao foi localizado';
  end if;

  perform public.finalize_invite_offer_server(
    offer_id,
    'TEACHER_INVITE',
    '00000000-0000-4000-8000-000000000b91',
    '00000000-0000-4000-8000-000000000b83'
  );
  raise exception 'assertion failed: contrato divergente do convite foi aceito';
exception when insufficient_privilege then null;
end;
$$;

update public.tenant_contract_records
set commercial_snapshot = jsonb_build_object(
  'hourlyRate', 50,
  'subject', 'Ingles'
)
where tenant_id = 'invite-school-a'
  and user_id = '00000000-0000-4000-8000-000000000b83'
  and contract_kind = 'TEACHER';

select public.finalize_invite_offer_server(
  :'teacher_offer_id'::uuid,
  'TEACHER_INVITE',
  '00000000-0000-4000-8000-000000000b91',
  '00000000-0000-4000-8000-000000000b83'
);

select pg_temp.assert_true(
  (select consumed_at is not null and consumed_by = '00000000-0000-4000-8000-000000000b83'
   from public.offers where id = :'teacher_offer_id'::uuid),
  'convite nao foi finalizado de forma atomica'
);

update public.tenants
set saas_status = 'blocked'
where id = 'invite-school-a';

update public.offers
set processing_by = '00000000-0000-4000-8000-000000000b83',
    processing_state = 'PROFILE_READY'
where id = :'enrollment_offer_id'::uuid;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b81","role":"authenticated"}';

do $$
begin
  perform public.create_invite_offer(
    'VENDOR_INVITE',
    jsonb_build_object(
      'tenantId', 'invite-school-a',
      'commissionRate', 250
    )
  );
  raise exception 'assertion failed: tenant bloqueado criou convite';
exception when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    jsonb_build_object(
      'unitId', 'invite-school-a',
      'value', 500,
      'dueDay', 10,
      'planDuration', 1,
      'classesPerWeek', 2,
      'enrollmentFee', 0
    )
  );
  raise exception 'assertion failed: tenant bloqueado criou matricula';
exception when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'enrollment_offer_id'::uuid,
    '{}'::jsonb
  ) ->> 'error' = 'TENANT_UNAVAILABLE',
  'tenant bloqueado iniciou oferta de matricula existente'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b83","role":"authenticated"}';
select pg_temp.assert_true(
  public.get_enrollment_progress(:'enrollment_offer_id'::uuid)
    ->> 'error' = 'TENANT_UNAVAILABLE',
  'tenant bloqueado expos progresso e PII da matricula'
);
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b81","role":"authenticated"}';

reset role;

set local role anon;
select pg_temp.assert_true(
  public.get_invite_offer_public(:'suspended_vendor_offer_id'::uuid)
    ->> 'error' = 'TENANT_UNAVAILABLE',
  'convite aberto de tenant bloqueado permaneceu publico'
);
select pg_temp.assert_true(
  public.get_offer_public(:'enrollment_offer_id'::uuid)
    ->> 'error' = 'TENANT_UNAVAILABLE',
  'oferta de matricula de tenant bloqueado permaneceu publica'
);
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'enrollment_offer_id'::uuid,
    '00000000-0000-4000-8000-000000000b83'
  ) ->> 'error' = 'TENANT_UNAVAILABLE',
  'tenant bloqueado concluiu oferta de matricula existente'
);
reset role;
set local request.jwt.claims = '{}';

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where kind = 'VENDOR_INVITE'
    and created_by = '00000000-0000-4000-8000-000000000b81'
    and consumed_at is null
  order by created_at desc
  limit 1;

  if offer_id is null then
    raise exception 'assertion failed: convite de vendedor nao foi localizado';
  end if;

  perform public.claim_invite_offer_server(
    offer_id,
    'VENDOR_INVITE',
    '00000000-0000-4000-8000-000000000b94'
  );
  raise exception 'assertion failed: tenant bloqueado reivindicou convite';
exception when no_data_found then null;
end;
$$;

do $$
declare
  offer_id uuid;
begin
  select id
  into offer_id
  from public.offers
  where invite_claim_token = '00000000-0000-4000-8000-000000000b93'
  limit 1;

  if offer_id is null then
    raise exception 'assertion failed: convite suspenso nao foi localizado';
  end if;

  perform public.finalize_invite_offer_server(
    offer_id,
    'TEACHER_INVITE',
    '00000000-0000-4000-8000-000000000b93',
    '00000000-0000-4000-8000-000000000b83'
  );
  raise exception 'assertion failed: tenant bloqueado finalizou convite';
exception when insufficient_privilege then null;
end;
$$;

update public.tenants
set saas_status = 'active'
where id = 'invite-school-a';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b83","role":"authenticated"}';

select pg_temp.assert_true(
  (public.get_contract_public('00000000-0000-4000-8000-000000000b83')
    -> 'schoolInfo' ->> 'legalName') = 'Invite School A Ltda',
  'titular nao recebeu o snapshot juridico do contrato'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b81","role":"authenticated"}';

select pg_temp.assert_true(
  (public.get_contract_public('00000000-0000-4000-8000-000000000b83')
    ->> 'full_name') = 'Invite Teacher A',
  'admin do tenant nao recebeu o contrato correto'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000b82","role":"authenticated"}';

select pg_temp.assert_true(
  public.get_contract_public('00000000-0000-4000-8000-000000000b83') is null,
  'admin B recebeu contrato do tenant A'
);

reset role;

select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.get_contract_public(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_invite_offer_server(uuid,text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_enrollment_offer(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.create_enrollment_offer_authoritative_impl(jsonb)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.begin_enrollment_offer_authoritative_impl(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.get_enrollment_progress_authoritative_impl(uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.complete_enrollment_offer_authoritative_impl(uuid,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_enrollment_progress(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_enrollment_offer(uuid,uuid)', 'EXECUTE')
    and has_function_privilege('anon', 'public.get_invite_offer_public(uuid)', 'EXECUTE'),
  'grants de convite/contrato estao incorretos'
);

rollback;
