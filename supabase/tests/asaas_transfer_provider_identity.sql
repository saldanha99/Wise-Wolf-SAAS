-- A transferencia conciliada jamais pode trocar o id imutavel do provedor.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

insert into public.tenants (id, name)
values ('asaas-transfer-identity-test', 'Asaas Transfer Identity Test');

set local app.enrollment_claim = '1';

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000a551',
  'authenticated',
  'authenticated',
  'asaas-transfer-identity@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Asaas Transfer Identity"}',
  now(),
  now()
);

update public.profiles
   set tenant_id = 'asaas-transfer-identity-test',
       role = 'TEACHER',
       lifecycle_status = 'active',
       full_name = 'Asaas Transfer Identity',
       nf_exempt = false
 where id = '00000000-0000-4000-8000-00000000a551';

insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year,
  total_lessons, total_amount, status,
  asaas_transfer_id, transfer_status
) values (
  '00000000-0000-4000-8000-00000000a552',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  '2026-08',
  1,
  10.00,
  'UNDER_REVIEW',
  'tr_persisted',
  'PENDING'
);

insert into public.asaas_teacher_transfer_attempts (
  id, closing_id, tenant_id, requested_by, external_reference,
  status, expected_amount, destination_pix_key,
  destination_pix_key_type, destination_fingerprint,
  transfer_description, provider_transfer_id, provider_status,
  claim_token, lease_expires_at, submit_attempt_count, submitted_at
) values (
  '00000000-0000-4000-8000-00000000a553',
  '00000000-0000-4000-8000-00000000a552',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  'wisewolf-teacher-closing:00000000-0000-4000-8000-00000000a552',
  'SUBMITTED',
  10.00,
  'identity-test@example.invalid',
  'EMAIL',
  repeat('a', 64),
  'Pagamento Professor - teste de identidade',
  'tr_persisted',
  'PENDING',
  '00000000-0000-4000-8000-00000000a554',
  now() + interval '5 minutes',
  1,
  now()
);

create temporary table identity_results (
  label text primary key,
  payload jsonb not null
);

insert into identity_results (label, payload)
select 'mismatch', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a553',
  p_claim_token => '00000000-0000-4000-8000-00000000a554',
  p_status => 'COMPLETED',
  p_provider_transfer_id => 'tr_divergent',
  p_provider_status => 'DONE'
);

select pg_temp.assert_true(
  (
    select payload->>'reason' = 'provider_transfer_id_mismatch'
       and payload->>'ok' = 'false'
      from identity_results
     where label = 'mismatch'
  ),
  'RPC aceitou um id Asaas divergente do id ja persistido'
);

select pg_temp.assert_true(
  (
    select provider_transfer_id = 'tr_persisted'
       and status = 'SUBMITTED'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a553'
  )
  and (
    select asaas_transfer_id = 'tr_persisted'
       and status = 'UNDER_REVIEW'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a552'
  ),
  'tentativa divergente alterou a transferencia ou o fechamento local'
);

insert into identity_results (label, payload)
select 'known-id-without-repeat', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a553',
  p_claim_token => '00000000-0000-4000-8000-00000000a554',
  p_status => 'UNKNOWN',
  p_error => 'read_temporarily_unavailable'
);

select pg_temp.assert_true(
  (
    select provider_transfer_id = 'tr_persisted'
       and status = 'UNKNOWN'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a553'
  ),
  'atualizacao sem novo id apagou a identidade Asaas persistida'
);

insert into identity_results (label, payload)
select 'terminal-without-destination-proof', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a553',
  p_claim_token => '00000000-0000-4000-8000-00000000a554',
  p_status => 'COMPLETED',
  p_provider_transfer_id => 'tr_persisted',
  p_provider_status => 'DONE'
);

select pg_temp.assert_true(
  (
    select payload->>'ok' = 'false'
       and payload->>'reason' = 'provider_destination_fingerprint_required'
      from identity_results
     where label = 'terminal-without-destination-proof'
  )
  and (
    select status = 'UNKNOWN'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a553'
  )
  and (
    select status = 'UNDER_REVIEW'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a552'
  ),
  'estado terminal sem prova do destinatario fechou o repasse'
);

insert into identity_results (label, payload)
select 'terminal-with-divergent-destination', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a553',
  p_claim_token => '00000000-0000-4000-8000-00000000a554',
  p_status => 'COMPLETED',
  p_provider_transfer_id => 'tr_persisted',
  p_provider_status => 'DONE',
  p_destination_fingerprint => repeat('d', 64)
);

select pg_temp.assert_true(
  (
    select payload->>'ok' = 'false'
       and payload->>'reason' = 'destination_snapshot_mismatch'
      from identity_results
     where label = 'terminal-with-divergent-destination'
  )
  and (
    select status = 'UNKNOWN'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a553'
  )
  and (
    select status = 'UNDER_REVIEW'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a552'
  ),
  'fingerprint divergente do destinatario fechou o repasse'
);

insert into identity_results (label, payload)
select 'exact-id', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a553',
  p_claim_token => '00000000-0000-4000-8000-00000000a554',
  p_status => 'COMPLETED',
  p_provider_transfer_id => 'tr_persisted',
  p_provider_status => 'DONE',
  p_destination_fingerprint => repeat('a', 64)
);

select pg_temp.assert_true(
  (
    select payload->>'ok' = 'true'
       and payload->>'provider_transfer_id' = 'tr_persisted'
      from identity_results
     where label = 'exact-id'
  )
  and (
    select provider_transfer_id = 'tr_persisted'
       and status = 'COMPLETED'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a553'
  )
  and (
    select asaas_transfer_id = 'tr_persisted'
       and transfer_status = 'DONE'
       and status = 'PAID_WAITING_NF'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a552'
  ),
  'conciliacao pelo id exato deixou de concluir a transferencia'
);

insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year,
  total_lessons, total_amount, status
) values (
  '00000000-0000-4000-8000-00000000a555',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  '2026-09',
  1,
  10.00,
  'PENDENTE'
);

insert into public.asaas_teacher_transfer_attempts (
  id, closing_id, tenant_id, requested_by, external_reference,
  status, expected_amount, destination_pix_key,
  destination_pix_key_type, destination_fingerprint,
  transfer_description, claim_token, lease_expires_at
) values (
  '00000000-0000-4000-8000-00000000a556',
  '00000000-0000-4000-8000-00000000a555',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  'wisewolf-teacher-closing:00000000-0000-4000-8000-00000000a555',
  'CLAIMED',
  10.00,
  'terminal-without-id@example.invalid',
  'EMAIL',
  repeat('b', 64),
  'Pagamento Professor - teste sem id do provedor',
  '00000000-0000-4000-8000-00000000a557',
  now() + interval '5 minutes'
);

insert into identity_results (label, payload)
select 'terminal-without-provider-id', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a556',
  p_claim_token => '00000000-0000-4000-8000-00000000a557',
  p_status => 'SUBMITTED',
  p_provider_status => 'PENDING'
);

select pg_temp.assert_true(
  (
    select payload->>'reason' = 'provider_transfer_id_required'
       and payload->>'ok' = 'false'
      from identity_results
     where label = 'terminal-without-provider-id'
  )
  and (
    select provider_transfer_id is null
       and status = 'CLAIMED'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a556'
  )
  and (
    select asaas_transfer_id is null
       and status = 'PENDENTE'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a555'
  ),
  'estado terminal sem id Asaas alterou a tentativa ou o fechamento'
);

insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year,
  total_lessons, total_amount, status,
  asaas_transfer_id, transfer_status
) values (
  '00000000-0000-4000-8000-00000000a558',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  '2026-10',
  1,
  10.00,
  'UNDER_REVIEW',
  'tr_closing_identity',
  'PENDING'
);

insert into public.asaas_teacher_transfer_attempts (
  id, closing_id, tenant_id, requested_by, external_reference,
  status, expected_amount, destination_pix_key,
  destination_pix_key_type, destination_fingerprint,
  transfer_description, provider_transfer_id, provider_status,
  claim_token, lease_expires_at, submit_attempt_count, submitted_at
) values (
  '00000000-0000-4000-8000-00000000a559',
  '00000000-0000-4000-8000-00000000a558',
  'asaas-transfer-identity-test',
  '00000000-0000-4000-8000-00000000a551',
  'wisewolf-teacher-closing:00000000-0000-4000-8000-00000000a558',
  'SUBMITTED',
  10.00,
  'cross-table-mismatch@example.invalid',
  'EMAIL',
  repeat('c', 64),
  'Pagamento Professor - teste de divergencia entre tabelas',
  'tr_attempt_identity',
  'PENDING',
  '00000000-0000-4000-8000-00000000a55a',
  now() + interval '5 minutes',
  1,
  now()
);

insert into identity_results (label, payload)
select 'cross-table-provider-id-mismatch', public.record_asaas_teacher_transfer_state(
  p_attempt_id => '00000000-0000-4000-8000-00000000a559',
  p_claim_token => '00000000-0000-4000-8000-00000000a55a',
  p_status => 'COMPLETED',
  p_provider_transfer_id => 'tr_attempt_identity',
  p_provider_status => 'DONE'
);

select pg_temp.assert_true(
  (
    select payload->>'reason' = 'closing_provider_transfer_id_mismatch'
       and payload->>'ok' = 'false'
      from identity_results
     where label = 'cross-table-provider-id-mismatch'
  )
  and (
    select provider_transfer_id = 'tr_attempt_identity'
       and status = 'SUBMITTED'
      from public.asaas_teacher_transfer_attempts
     where id = '00000000-0000-4000-8000-00000000a559'
  )
  and (
    select asaas_transfer_id = 'tr_closing_identity'
       and status = 'UNDER_REVIEW'
      from public.teacher_closings
     where id = '00000000-0000-4000-8000-00000000a558'
  )
  and exists (
    select 1
      from public.asaas_reconciliation_issues as issue
     where issue.source = 'TRANSFER'
       and issue.kind = 'TEACHER_TRANSFER_PROVIDER_ID_MISMATCH'
       and issue.severity = 'CRITICAL'
       and issue.provider_entity_id = 'tr_attempt_identity'
       and issue.local_entity_id = '00000000-0000-4000-8000-00000000a558'
       and issue.fingerprint =
         'teacher-transfer:00000000-0000-4000-8000-00000000a559:provider-id-mismatch'
       and issue.resolved_at is null
  ),
  'divergencia entre tentativa e fechamento nao foi bloqueada e observada'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.record_asaas_teacher_transfer_state(uuid,uuid,text,text,text,integer,text,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_asaas_teacher_transfer_state(uuid,uuid,text,text,text,integer,text,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.record_asaas_teacher_transfer_state(uuid,uuid,text,text,text,integer,text,jsonb,text)',
    'EXECUTE'
  ),
  'RPC de transferencia perdeu o ACL restrito ao service_role'
);

rollback;
