-- Envio do termo de registro em lote (migration 20260926210000, sobre
-- 20260926200000): quem entra, para quem vai (idade não atestada pela escola
-- e menor -> responsável; telefone do responsável só o ATESTADO, a régua de
-- 20260926200000: gravado pelo próprio aluno ou de outra escola não vale, igual
-- ao do aluno vale e só pede conferência), idempotência por aluno + versão,
-- espaçamento no agendamento E na hora de mandar (janela, ritmo, validade),
-- link com os telefones do código (a família consegue responder), um link
-- vivo por aluno, reenvio só depois de 3 dias (na hora se o contato mudou),
-- portal da escola no link, revalidação na hora de mandar e registro de
-- abertura sem apagar a página pública da outra migration.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.lot_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'termo em lote: %', p_message;
  end if;
end;
$$;

-- Decisão pelo link já verificada por código (a tabela não aceita decisão
-- pelo link sem código desde 20260926200000).
create or replace function pg_temp.lot_verified_decision(
  p_tenant text, p_actor uuid, p_student uuid, p_decision text, p_relation text, p_version text
)
returns void language plpgsql as $$
declare
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values (p_tenant, p_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), p_actor,
    now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, p_tenant, p_student, p_relation, '5511900009999',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values (p_tenant, p_student, 'STUDENT', p_decision, 'Fixture Assinante', p_relation, 'STUDENT', p_version,
    'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-9999', v_challenge);
end;
$$;

-- O banco de teste pode vir só com a estrutura: garante os textos do termo.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v1', repeat('Termo de teste do aluno. ', 20), now() - interval '2 days'),
  ('TEACHER', 'v1', repeat('Termo de teste do professor. ', 20), now() - interval '2 days'),
  ('STUDENT', 'v2', repeat('Termo de teste do aluno v2. ', 20), now() - interval '1 day'),
  ('TEACHER', 'v2', repeat('Termo de teste do professor v2. ', 20), now() - interval '1 day')
on conflict (audience, version) do nothing;

do $privileges$
declare
  v_public text := pg_catalog.pg_get_functiondef('public.get_lesson_recording_consent_public(text)'::regprocedure);
begin
  perform pg_temp.lot_assert(
    not has_function_privilege('anon', 'public.preview_lesson_recording_consent_batch()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.enqueue_lesson_recording_consent_batch(integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.resend_lesson_recording_consent_request(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.list_lesson_recording_consent_requests()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_lesson_recording_consent_request_snapshot(uuid)', 'EXECUTE'),
    'anon alcança o envio em lote'
  );
  perform pg_temp.lot_assert(
    not has_function_privilege('authenticated', 'public.get_lesson_recording_consent_request_snapshot(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_lesson_recording_consent_request_snapshot(uuid)', 'EXECUTE'),
    'revalidação do envio exposta ao navegador ou fora do alcance do processador'
  );
  perform pg_temp.lot_assert(
    not has_table_privilege('authenticated', 'private.lesson_recording_consent_requests', 'SELECT')
    and not has_table_privilege('anon', 'private.lesson_recording_consent_requests', 'SELECT'),
    'tabela de envios acessível pelo navegador'
  );
  perform pg_temp.lot_assert(
    not has_function_privilege('authenticated', 'private.lesson_recording_enqueue_request(text,uuid,text,text,text,text,integer,uuid,text,text,text,text,text,timestamp with time zone,uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.lesson_recording_request_snapshot_at(uuid,timestamp with time zone)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_recording_request_snapshot_at(uuid,timestamp with time zone)', 'EXECUTE'),
    'enfileiramento ou revalidação crus expostos'
  );
  -- A página pública grava a abertura E continua sendo a de 20260926200000
  -- (campos do código em lesson_recording_public_link_fields e o link
  -- bloqueado): recriar a partir do texto antigo apagaria o fluxo do código.
  perform pg_temp.lot_assert(
    has_function_privilege('anon', 'public.get_lesson_recording_consent_public(text)', 'EXECUTE')
    and v_public like '%lesson_recording_note_link_opened%'
    and v_public like '%|| private.lesson_recording_public_link_fields(v_link.id)%'
    and v_public like '%''blocked'', true%'
    and (select provolatile = 'v' from pg_proc
      where oid = 'public.get_lesson_recording_consent_public(text)'::regprocedure),
    'a página pública não registra a abertura, perdeu a rota anônima ou perdeu o que 20260926200000 pôs nela'
  );
end
$privileges$;

-- Janela de envio e espaçamento, com datas fixas (26/09/2026 é sábado).
do $slots$
declare
  v_slots timestamptz[];
  v_slot timestamptz;
  v_local timestamp;
begin
  perform pg_temp.lot_assert(
    private.lesson_recording_send_slot('2026-09-26 20:05:00-03') = '2026-09-28 09:00:00-03',
    'sábado depois das 20h não pulou o domingo'
  );
  perform pg_temp.lot_assert(
    private.lesson_recording_send_slot('2026-09-26 19:58:00-03') = '2026-09-26 19:58:00-03',
    'sábado antes das 20h ficou fora da janela'
  );
  perform pg_temp.lot_assert(
    private.lesson_recording_send_slot('2026-09-27 10:00:00-03') = '2026-09-28 09:00:00-03',
    'mandaria no domingo'
  );
  perform pg_temp.lot_assert(
    private.lesson_recording_send_slot('2026-09-28 07:30:00-03') = '2026-09-28 09:00:00-03',
    'mandaria antes das 9h'
  );
  perform pg_temp.lot_assert(
    private.lesson_recording_send_slot('2026-09-28 14:10:00-03') = '2026-09-28 14:10:00-03',
    'mexeu em horário dentro da janela'
  );
  v_slots := private.lesson_recording_send_slots('2026-09-28 19:50:00-03', 6);
  perform pg_temp.lot_assert(
    v_slots = array['2026-09-28 19:50:00-03', '2026-09-28 19:53:00-03', '2026-09-28 19:56:00-03',
      '2026-09-28 19:59:00-03', '2026-09-29 09:00:00-03', '2026-09-29 09:03:00-03']::timestamptz[],
    'lote não virou para a manhã seguinte na hora certa'
  );

  v_slots := private.lesson_recording_send_slots('2026-09-26 18:40:00-03', 45);
  perform pg_temp.lot_assert(cardinality(v_slots) = 45, 'faltou horário para o lote');
  for v_position in 1..45 loop
    v_slot := v_slots[v_position];
    v_local := v_slot at time zone 'America/Sao_Paulo';
    perform pg_temp.lot_assert(
      extract(isodow from v_local) <> 7 and v_local::time >= time '09:00' and v_local::time < time '20:00',
      'horário fora de segunda a sábado, 9h às 20h: ' || v_local::text
    );
    if v_position > 1 then
      perform pg_temp.lot_assert(v_slot - v_slots[v_position - 1] >= interval '3 minutes',
        'duas mensagens com menos de 3 minutos entre elas');
    end if;
    perform pg_temp.lot_assert(
      (select count(*) from unnest(v_slots) as other(at)
        where other.at >= v_slot and other.at < v_slot + interval '15 minutes') <= 5,
      'mais de 5 mensagens em 15 minutos'
    );
  end loop;
end
$slots$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_coordinator uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_adult2 uuid := gen_random_uuid();
  v_kid uuid := gen_random_uuid();
  v_unknown_guardian uuid := gen_random_uuid();
  v_unknown_nocontact uuid := gen_random_uuid();
  v_minor_nocontact uuid := gen_random_uuid();
  v_refused uuid := gen_random_uuid();
  v_revoked uuid := gen_random_uuid();
  v_accepted_current uuid := gen_random_uuid();
  v_accepted_old uuid := gen_random_uuid();
  v_inactive uuid := gen_random_uuid();
  v_test_account uuid := gen_random_uuid();
  v_reconfirm uuid := gen_random_uuid();
  v_selfguardian uuid := gen_random_uuid();
  v_ownphone_guardian uuid := gen_random_uuid();
  v_foreign_guardian uuid := gen_random_uuid();
  v_manual uuid := gen_random_uuid();
  v_bulk uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_late uuid := gen_random_uuid();
  v_all uuid[];
  v_students uuid[];
  v_adults uuid[];
  v_version text;
  v_result jsonb;
  v_preview jsonb;
  v_blocked boolean;
  v_last timestamptz;
  v_message text;
  v_token text;
  v_old_token text;
  v_manual_token text;
  v_notification uuid;
  v_issue jsonb;
  v_row record;
  v_previous timestamptz;
begin
  v_version := (private.lesson_recording_current_term('STUDENT')).version;
  perform pg_temp.lot_assert(v_version is not null and v_version <> 'v1', 'versão vigente do termo ausente');

  v_students := array[v_adult, v_adult2, v_kid, v_unknown_guardian, v_unknown_nocontact, v_minor_nocontact,
    v_refused, v_revoked, v_accepted_current, v_accepted_old, v_inactive, v_test_account,
    v_reconfirm, v_selfguardian, v_ownphone_guardian, v_foreign_guardian, v_manual] || v_bulk || v_late;
  v_all := array[v_admin, v_coordinator, v_teacher, v_outsider] || v_students;
  -- Maiores de idade atestados pela escola (os outros ficam sem data).
  v_adults := array[v_adult, v_adult2, v_refused, v_revoked, v_accepted_current, v_accepted_old,
    v_inactive, v_test_account, v_reconfirm, v_manual] || v_bulk || v_late;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- A escola do teste tem portal próprio verificado; a outra, nenhum.
  insert into public.tenants (id, name, custom_domain, custom_domain_verified) values
    ('rec-lot-fixture', 'Escola Fixture', 'termo-lote.fixture.invalid', true),
    ('rec-lot-other', 'Outra Escola Fixture', null, false);
  insert into public.tenants (id, name) values ('school-wise-wolf', 'Wise Wolf')
  on conflict (id) do nothing;
  perform pg_temp.lot_assert(
    private.lesson_recording_portal_url('rec-lot-fixture') = 'https://termo-lote.fixture.invalid'
    and private.lesson_recording_portal_url('rec-lot-other') is null
    and private.lesson_recording_portal_url('school-wise-wolf') = 'https://system.wisewolflanguage.com.br',
    'portal da escola resolvido errado'
  );

  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'rec-lot-' || id::text || '@example.invalid', '{"provider":"email"}', '{}'
  from unnest(v_all) as id;

  update public.profiles
     set tenant_id = case when id = v_outsider then 'rec-lot-other' else 'rec-lot-fixture' end,
         lifecycle_status = case when id = v_inactive then 'suspended' else 'active' end,
         status = 'Ativo',
         is_test_account = (id = v_test_account),
         role = case
           when id in (v_admin, v_outsider) then 'SCHOOL_ADMIN'
           when id = v_coordinator then 'COORDINATOR'
           when id = v_teacher then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_admin then 'Direcao Fixture'
           when id = v_coordinator then 'Coordenacao Fixture'
           when id = v_teacher then 'Professora Fixture'
           when id = v_outsider then 'Outra Direcao Fixture'
           when id = v_adult then 'Ana Adulta Fixture'
           when id = v_adult2 then 'Bruno Adulto Fixture'
           when id = v_kid then 'Caio Crianca Fixture'
           when id = v_unknown_guardian then 'Davi Semidade Fixture'
           when id = v_unknown_nocontact then 'Eva Semidade Fixture'
           when id = v_minor_nocontact then 'Fabio Menor Fixture'
           when id = v_refused then 'Gabi Recusou Fixture'
           when id = v_revoked then 'Hugo Revogou Fixture'
           when id = v_accepted_current then 'Iara Aceitou Fixture'
           when id = v_accepted_old then 'Joao Aceitouantes Fixture'
           when id = v_inactive then 'Kely Inativa Fixture'
           when id = v_test_account then 'Lia Teste Fixture'
           when id = v_reconfirm then 'Nina Reconfirma Fixture'
           when id = v_selfguardian then 'Otto Proprio Fixture'
           when id = v_ownphone_guardian then 'Paula Mesmonumero Fixture'
           when id = v_foreign_guardian then 'Quico Deforae Fixture'
           when id = v_manual then 'Rita Manual Fixture'
           when id = v_late then 'Zeca Novo Fixture'
           else 'Massa Lote Fixture ' || array_position(v_bulk, id)::text end,
         birth_date = null,
         is_kids = (id = v_kid),
         guardian_phone = case
           when id = v_kid then '(11) 98888-0003'
           when id = v_unknown_guardian then '5511988880004'
           when id = v_reconfirm then '5511988880020'
           when id = v_ownphone_guardian then '5511988880023'
           else null end,
         guardian_id = case when id = v_foreign_guardian then v_outsider end,
         attendance_phone = case when id = v_adult2 then '5511988880002' else null end,
         phone = case
           when id = v_adult then '11 98888-0001'
           when id = v_adult2 then '5511977770002'
           when id = v_kid then '5511988880013'
           when id = v_unknown_guardian then '5511988880014'
           when id = v_unknown_nocontact then '5511988880005'
           when id = v_minor_nocontact then '5511988880006'
           when id = v_selfguardian then '5511988880022'
           when id = v_ownphone_guardian then '11 98888-0023'
           when id = any(v_students) then '55119877' || lpad((array_position(v_students, id) + 10)::text, 5, '0')
           else '5511966660000' end
   where id = any(v_all);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any(v_all)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  -- v_late só entra na escola depois do primeiro lote.
  update public.tenant_memberships set status = 'SUSPENDED'
   where user_id = v_late and tenant_id = 'rec-lot-fixture';

  perform pg_temp.lot_assert(
    (select count(*) from public.profiles where id = any(v_students) and is_test_account is not true) = 23,
    'fixture de aluno ficou marcada como conta de teste'
  );

  -- A escola atesta a data de nascimento de quem é maior (e do menor).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_student_birth_date(id, date '1990-05-10', 'Documento conferido (fixture)')
  from unnest(v_adults) as id;
  perform public.set_student_birth_date(v_minor_nocontact,
    ((now() at time zone 'America/Sao_Paulo')::date - interval '10 years')::date, 'Menor (fixture)');

  -- Decisões já registradas, todas com código.
  perform pg_temp.lot_verified_decision('rec-lot-fixture', v_admin, v_refused, 'REFUSED', 'SELF', v_version);
  perform pg_temp.lot_verified_decision('rec-lot-fixture', v_admin, v_revoked, 'ACCEPTED', 'SELF', v_version);
  perform pg_temp.lot_verified_decision('rec-lot-fixture', v_admin, v_accepted_current, 'ACCEPTED', 'SELF', v_version);
  perform pg_temp.lot_verified_decision('rec-lot-fixture', v_admin, v_accepted_old, 'ACCEPTED', 'SELF', 'v1');
  perform pg_temp.lot_verified_decision('rec-lot-fixture', v_admin, v_reconfirm, 'ACCEPTED', 'SELF', v_version);
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, source, reason)
  values ('rec-lot-fixture', v_revoked, 'STUDENT', 'REVOKED', 'Escola', 'SCHOOL', 'SCHOOL', 'Pedido da família fixture.');
  -- A escola descobre que quem aceitou "como aluno" é menor: o aceite deixa
  -- de valer e o responsável precisa responder.
  perform public.set_student_birth_date(v_reconfirm,
    ((now() at time zone 'America/Sao_Paulo')::date - interval '15 years')::date, 'Correção: 15 anos (fixture)');
  perform pg_temp.lot_assert(
    private.lesson_recording_consent_state(v_reconfirm) = 'ACCEPTED'
    and not private.lesson_recording_student_consent_effective(v_reconfirm),
    'fixture: aceite do aluno que virou menor ainda vale'
  );

  -- A direção gerou e mandou o link de um aluno à mão agora há pouco.
  v_manual_token := public.create_lesson_recording_consent_link(v_manual) ->> 'token';

  -- O próprio aluno grava um "telefone do responsável" (a API deixa).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_selfguardian, 'role', 'authenticated')::text, true);
  update public.profiles set guardian_phone = '5511988880021' where id = v_selfguardian;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Para quem vai: o responsável ATESTADO (a mesma régua do código), ou sem contato.
  perform pg_temp.lot_assert(
    (select target.recipient = 'GUARDIAN' and target.destination is null
        and target.missing_reason = 'responsavel_nao_confirmado'
      from private.lesson_recording_request_target(v_selfguardian) as target),
    'mandaria o termo ao telefone de responsável gravado pelo próprio aluno'
  );
  -- Responsável com o MESMO número do aluno, gravado pela escola: vale (família
  -- que divide o celular) — o painel só pede conferência. É o número do código.
  perform pg_temp.lot_assert(
    (select target.recipient = 'GUARDIAN' and target.destination = '5511988880023'
        and target.missing_reason is null
        and target.destination = private.lesson_recording_guardian_phone(v_ownphone_guardian)
        and private.lesson_recording_same_phone(target.destination,
          (select phone from public.profiles where id = v_ownphone_guardian))
      from private.lesson_recording_request_target(v_ownphone_guardian) as target),
    'responsável atestado com o mesmo número do aluno ficou sem o termo (ou fora do número do código)'
  );
  perform pg_temp.lot_assert(
    (select target.destination is null and target.missing_reason = 'responsavel_nao_confirmado'
      from private.lesson_recording_request_target(v_foreign_guardian) as target),
    'responsável de outra escola recebeu o termo'
  );
  perform pg_temp.lot_assert(
    (select target.recipient = 'STUDENT' and target.destination = '5511977770002'
        and target.destination = private.lesson_recording_student_phone(v_adult2)
      from private.lesson_recording_request_target(v_adult2) as target),
    'o termo e o código do adulto não iriam para o mesmo número'
  );

  -- Só a direção dispara.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.preview_lesson_recording_consent_batch();
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'professor abriu a prévia do lote');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coordinator, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(12);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'coordenação disparou o lote');
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(
    (v_result ->> 'ok')::boolean and not (v_result ->> 'can_send')::boolean,
    'coordenação não vê a lista ou aparece como quem pode enviar'
  );

  -- Escola sem portal conhecido não manda link que não abre.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(jsonb_array_length(v_result -> 'students') = 0, 'outra escola viu os alunos');
  perform pg_temp.lot_assert(not (public.preview_lesson_recording_consent_batch() ->> 'portal_ok')::boolean,
    'prévia de escola sem portal não avisou');
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(0);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'portal_da_escola_indefinido'; end;
  perform pg_temp.lot_assert(v_blocked, 'escola sem portal enfileirou termo');
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'outra escola enviou o termo para aluno alheio');

  -- Prévia da direção.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_preview := public.preview_lesson_recording_consent_batch();
  perform pg_temp.lot_assert((v_preview ->> 'to_send')::integer = 13,
    'prévia contou errado quem recebe: ' || v_preview::text);
  perform pg_temp.lot_assert((v_preview ->> 'to_guardians')::integer = 4, 'prévia contou errado os responsáveis');
  perform pg_temp.lot_assert((v_preview ->> 'term_updated')::integer = 1, 'prévia não viu quem aceitou versão antiga');
  perform pg_temp.lot_assert((v_preview ->> 'reconfirm')::integer = 1, 'prévia não viu o aceite que deixou de valer');
  perform pg_temp.lot_assert((v_preview ->> 'no_contact')::integer = 4,
    'prévia não contou os sem contato: ' || v_preview::text);
  perform pg_temp.lot_assert((v_preview ->> 'manual_link_recent')::integer = 1,
    'prévia não separou quem recebeu link à mão agora');
  perform pg_temp.lot_assert((v_preview ->> 'portal_ok')::boolean, 'escola com portal apareceu sem portal');
  perform pg_temp.lot_assert((v_preview ->> 'first_at')::timestamptz > now(), 'lote começaria no passado');
  perform pg_temp.lot_assert(
    (v_preview ->> 'last_at')::timestamptz - (v_preview ->> 'first_at')::timestamptz >= interval '36 minutes',
    '13 mensagens caberiam em menos de 36 minutos'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from public.notification_queue where tenant_id = 'rec-lot-fixture'),
    'a prévia enfileirou mensagem'
  );

  -- Contagem diferente da mostrada: nada entra.
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(12);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'aceitou lote com contagem diferente da prévia');
  perform pg_temp.lot_assert(
    not exists (select 1 from private.lesson_recording_consent_requests where tenant_id = 'rec-lot-fixture'),
    'lote recusado deixou pedido para trás'
  );

  v_result := public.enqueue_lesson_recording_consent_batch(13);
  perform pg_temp.lot_assert((v_result ->> 'queued')::integer = 13, 'lote não enfileirou os 13');
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue
      where tenant_id = 'rec-lot-fixture' and notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
        and status = 'pending' and teacher_id is null and scheduled_for > now()) = 13,
    'fila não recebeu 13 mensagens agendadas da escola'
  );
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue
      where tenant_id = 'rec-lot-fixture'
        and idempotency_key = 'lesson-recording-consent:' || student_id::text || ':' || v_version || ':1') = 13,
    'chave de idempotência fora do padrão aluno + versão'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from public.notification_queue where student_id in
      (v_unknown_nocontact, v_minor_nocontact, v_refused, v_revoked, v_accepted_current, v_inactive,
       v_test_account, v_late, v_selfguardian, v_foreign_guardian, v_manual)),
    'mandou para quem já decidiu, está inativo, é teste, não tem contato confiável ou acabou de receber à mão'
  );

  -- O link de cada pedido guarda o telefone que recebe a mensagem: é para lá
  -- que a página manda o código (antes, o link do lote nascia sem telefone e
  -- ninguém conseguia responder).
  perform pg_temp.lot_assert(
    (select count(*)
      from private.lesson_recording_consent_requests as request
      join private.lesson_recording_consent_links as link on link.id = request.link_id
      join public.notification_queue as queue on queue.id = request.notification_id
      where request.tenant_id = 'rec-lot-fixture'
        and request.destination = queue.student_phone
        and request.destination = case request.recipient
          when 'GUARDIAN' then link.guardian_phone else link.student_phone end) = 13,
    'link do lote sem o telefone do destinatário'
  );
  perform pg_temp.lot_assert(
    (select revoked_at is null from private.lesson_recording_consent_links
      where token_hash = encode(extensions.digest(v_manual_token, 'sha256'), 'hex')),
    'o lote derrubou o link que a direção acabou de mandar à mão'
  );

  -- Menor e idade desconhecida: responsável, nunca o número do aluno.
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_kid) = '5511988880003',
    'termo do menor não foi para o responsável'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_unknown_guardian) = '5511988880004',
    'idade desconhecida não foi para o responsável'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_reconfirm) = '5511988880020',
    'aceite que deixou de valer não pediu ao responsável'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_ownphone_guardian) = '5511988880023',
    'responsável atestado com o mesmo número do aluno não recebeu'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_adult) = '5511988880001',
    'adulto não recebeu no próprio número'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_adult2) = '5511977770002',
    'adulto não recebeu no telefone do cadastro (o mesmo do código)'
  );
  v_message := (select message_body from public.notification_queue where student_id = v_kid);
  perform pg_temp.lot_assert(
    v_message like 'Olá! Aqui é da Escola Fixture. Como responsável por Caio,%'
      and v_message like '%sem vídeo%'
      and v_message ~ 'https://termo-lote\.fixture\.invalid/registro-das-aulas\?token=[a-f0-9]{64}'
      and v_message like '%código de 6 dígitos para este WhatsApp%'
      and v_message like '%Sem autorização, a aula acontece normalmente%'
      and length(v_message) < 700,
    'mensagem ao responsável fora do combinado: ' || v_message
  );
  perform pg_temp.lot_assert(
    (select message_body like 'Olá, Ana! Aqui é da Escola Fixture.%' from public.notification_queue where student_id = v_adult),
    'mensagem ao adulto não fala com ele'
  );
  perform pg_temp.lot_assert(
    (select message_body like '%O termo foi atualizado desde a sua última resposta.%'
      from public.notification_queue where student_id = v_accepted_old),
    'quem aceitou a versão antiga não soube que o termo mudou'
  );
  perform pg_temp.lot_assert(
    (select message_body like '%não foi dada pelo responsável e precisa ser confirmada por você.%'
      from public.notification_queue where student_id = v_reconfirm),
    'responsável não soube por que o termo voltou'
  );

  -- O token só existe na mensagem; no banco, o hash.
  v_token := substring(v_message from 'token=([a-f0-9]{64})');
  perform pg_temp.lot_assert(
    exists (select 1 from private.lesson_recording_consent_links
      where student_id = v_kid and token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'))
    and not exists (select 1 from private.lesson_recording_consent_links where token_hash = v_token),
    'link do lote sem hash ou sem vínculo com a mensagem'
  );
  perform pg_temp.lot_assert(
    (select count(*) from private.lesson_recording_consent_links
      where student_id = v_kid and revoked_at is null) = 1,
    'mais de um link vivo para o mesmo aluno'
  );

  -- Espaçamento real das mensagens enfileiradas.
  v_previous := null;
  for v_row in
    select scheduled_for from public.notification_queue
    where tenant_id = 'rec-lot-fixture' order by scheduled_for
  loop
    perform pg_temp.lot_assert(
      extract(isodow from v_row.scheduled_for at time zone 'America/Sao_Paulo') <> 7
      and (v_row.scheduled_for at time zone 'America/Sao_Paulo')::time >= time '09:00'
      and (v_row.scheduled_for at time zone 'America/Sao_Paulo')::time < time '20:00',
      'mensagem agendada fora da janela'
    );
    if v_previous is not null then
      perform pg_temp.lot_assert(v_row.scheduled_for - v_previous >= interval '3 minutes',
        'mensagens do lote a menos de 3 minutos');
    end if;
    perform pg_temp.lot_assert(
      (select count(*) from public.notification_queue as other
        where other.tenant_id = 'rec-lot-fixture'
          and other.scheduled_for >= v_row.scheduled_for
          and other.scheduled_for < v_row.scheduled_for + interval '15 minutes') <= 5,
      'mais de 5 mensagens do lote em 15 minutos'
    );
    v_previous := v_row.scheduled_for;
  end loop;

  -- Idempotência: clicar de novo não duplica.
  v_preview := public.preview_lesson_recording_consent_batch();
  perform pg_temp.lot_assert((v_preview ->> 'to_send')::integer = 0, 'segundo clique veria alunos já enviados');
  v_result := public.enqueue_lesson_recording_consent_batch(0);
  perform pg_temp.lot_assert((v_result ->> 'queued')::integer = 0, 'segundo lote enfileirou algo');
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(13);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'repetir a contagem antiga passou');
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue where tenant_id = 'rec-lot-fixture') = 13,
    'fila duplicou mensagens'
  );

  -- Aluno novo entra num lote que começa depois do último ainda na fila.
  update public.tenant_memberships set status = 'ACTIVE'
   where user_id = v_late and tenant_id = 'rec-lot-fixture';
  v_last := (select max(scheduled_for) from public.notification_queue where tenant_id = 'rec-lot-fixture');
  v_preview := public.preview_lesson_recording_consent_batch();
  perform pg_temp.lot_assert((v_preview ->> 'to_send')::integer = 1, 'aluno novo fora da prévia');
  v_result := public.enqueue_lesson_recording_consent_batch(1);
  perform pg_temp.lot_assert(
    (select scheduled_for from public.notification_queue where student_id = v_late) >= v_last + interval '3 minutes',
    'segundo lote encavalou no primeiro'
  );

  -- A família do Caio responde pelo link do lote: pede o código, que vai para
  -- o MESMO número da mensagem, e decide.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.lot_assert(
    (v_result ->> 'found')::boolean and v_result ->> 'guardian_reason' = 'KIDS'
      and v_result ->> 'guardian_phone_masked' = '(11) •••••-0003',
    'página do link do lote sem o telefone do código: ' || v_result::text
  );
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  perform pg_temp.lot_assert(
    (v_issue ->> 'ok')::boolean and v_issue ->> 'destination' = '5511988880003',
    'o código do link do lote não saiu para o número da mensagem: ' || v_issue::text
  );
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', 'msg-lote-1');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Responsavel Fixture', 'GUARDIAN', true, v_issue ->> 'code');
  perform pg_temp.lot_assert(v_result ->> 'decision' = 'ACCEPTED', 'responsável não conseguiu aceitar pelo link do lote');
  perform pg_temp.lot_assert(private.lesson_recording_student_consent_effective(v_kid),
    'aceite pelo link do lote não vale para marcar aula');

  -- Reenvio.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'envio_em_andamento'; end;
  perform pg_temp.lot_assert(v_blocked, 'reenviou com a primeira mensagem ainda na fila');

  update public.notification_queue
     set status = 'sent', delivery_status = 'accepted', accepted_at = now() - interval '1 day'
   where student_id = v_adult;
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'reenvio_so_depois_de_3_dias'; end;
  perform pg_temp.lot_assert(v_blocked, 'reenviou antes de 3 dias');

  v_old_token := substring((select message_body from public.notification_queue where student_id = v_adult)
    from 'token=([a-f0-9]{64})');
  update public.notification_queue set accepted_at = now() - interval '4 days' where student_id = v_adult;
  v_result := public.resend_lesson_recording_consent_request(v_adult);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'reenvio depois de 3 dias falhou');
  perform pg_temp.lot_assert(
    exists (select 1 from public.notification_queue
      where student_id = v_adult and status = 'pending'
        and idempotency_key = 'lesson-recording-consent:' || v_adult::text || ':' || v_version || ':2'),
    'reenvio sem a segunda tentativa na fila'
  );
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.lot_assert(
    not (public.get_lesson_recording_consent_public(v_old_token) ->> 'found')::boolean,
    'o link do envio anterior continuou valendo depois do reenvio'
  );
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'envio_em_andamento'; end;
  perform pg_temp.lot_assert(v_blocked, 'dois reenvios seguidos passaram');

  update public.notification_queue
     set status = 'skipped', delivery_status = 'skipped', last_error = 'contato_mudou'
   where student_id = v_adult2;
  v_result := public.resend_lesson_recording_consent_request(v_adult2);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'mensagem que não saiu não pôde ser reenviada na hora');

  -- Número corrigido depois do envio: o reenvio sai na hora (sem esperar 3
  -- dias) e o link que foi para o número errado deixa de valer.
  update public.notification_queue
     set status = 'sent', delivery_status = 'accepted', accepted_at = now() - interval '1 day'
   where student_id = v_bulk[6];
  v_old_token := substring((select message_body from public.notification_queue where student_id = v_bulk[6])
    from 'token=([a-f0-9]{64})');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles set phone = '5511955556666' where id = v_bulk[6];
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_bulk[6]::text
        and (item ->> 'resend_available_at')::timestamptz <= now()),
    'lista segurou o reenvio de quem teve o número corrigido'
  );
  v_result := public.resend_lesson_recording_consent_request(v_bulk[6]);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'número corrigido não pôde receber o termo na hora');
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_bulk[6] and status = 'pending')
      = '5511955556666',
    'reenvio não foi para o número corrigido'
  );
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.lot_assert(
    not (public.get_lesson_recording_consent_public(v_old_token) ->> 'found')::boolean,
    'link mandado ao número errado continuou valendo'
  );
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- Lista do painel.
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert((v_result ->> 'can_send')::boolean, 'direção não aparece como quem envia');
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_minor_nocontact::text and item ->> 'recipient' = 'GUARDIAN'
        and item ->> 'missing_reason' = 'menor_sem_telefone_do_responsavel' and item ->> 'contact_last4' is null)
    and exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_unknown_nocontact::text and item ->> 'missing_reason' = 'idade_nao_cadastrada')
    and exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_selfguardian::text and item ->> 'missing_reason' = 'responsavel_nao_confirmado'),
    'lista não mostra quem está sem contato e por quê'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_adult::text and (item -> 'request' ->> 'attempt')::integer = 2
        and item -> 'request' ->> 'state' = 'QUEUED' and item ->> 'resend_available_at' is null
        and item -> 'request' ->> 'next_attempt_at' is not null),
    'lista não mostra o reenvio na fila'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_refused::text and not (item ->> 'eligible')::boolean
        and item ->> 'resend_available_at' is null),
    'lista oferece reenvio a quem recusou'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_reconfirm::text and (item ->> 'reconfirm')::boolean
        and (item ->> 'eligible')::boolean),
    'lista não mostra o aceite que precisa ser confirmado'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_manual::text and item ->> 'manual_link_at' is not null
        and item -> 'request' = 'null'::jsonb and (item ->> 'resend_available_at')::timestamptz <= now()),
    'lista não mostra o link gerado à mão'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' in (v_inactive::text, v_test_account::text)),
    'lista mostrou aluno inativo ou conta de teste'
  );

  -- "Enviar" de um aluno é explícito: substitui o link gerado à mão.
  v_result := public.resend_lesson_recording_consent_request(v_manual);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'envio de um aluno com link à mão falhou');
  perform pg_temp.lot_assert(
    (select revoked_at is not null from private.lesson_recording_consent_links
      where token_hash = encode(extensions.digest(v_manual_token, 'sha256'), 'hex')),
    'dois links vivos para o mesmo aluno depois do envio'
  );

  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_refused);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'aluno_ja_decidiu'; end;
  perform pg_temp.lot_assert(v_blocked, 'pediu de novo a quem recusou');
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_revoked);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'aluno_ja_decidiu'; end;
  perform pg_temp.lot_assert(v_blocked, 'passou por cima da revogação');
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_minor_nocontact);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'sem_contato'; end;
  perform pg_temp.lot_assert(v_blocked, 'menor sem responsável recebeu no próprio número');
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_selfguardian);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'sem_contato'; end;
  perform pg_temp.lot_assert(v_blocked, 'termo foi ao responsável que o próprio aluno cadastrou');

  -- Revalidação na hora de mandar (processador, service role).
  v_notification := (select id from public.notification_queue where student_id = v_unknown_guardian);
  v_blocked := false;
  begin perform public.get_lesson_recording_consent_request_snapshot(v_notification);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'navegador leu a revalidação do envio');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Pela porta pública o resultado depende do relógio (janela e ritmo).
  v_result := public.get_lesson_recording_consent_request_snapshot(v_notification);
  perform pg_temp.lot_assert(
    (v_result ->> 'ok')::boolean or v_result ->> 'reason' in ('fora_da_janela_de_envio', 'ritmo_do_termo'),
    'porta do processador recusou envio válido: ' || v_result::text
  );
  v_result := private.lesson_recording_request_snapshot_at(v_notification,
    (select scheduled_for from public.notification_queue where id = v_notification));
  perform pg_temp.lot_assert(
    (v_result ->> 'ok')::boolean and v_result ->> 'destination' = '5511988880004'
      and v_result ->> 'message' = (select message_body from public.notification_queue where id = v_notification)
      and v_result ->> 'portal' = 'https://termo-lote.fixture.invalid',
    'revalidação recusou envio válido: ' || v_result::text
  );

  v_notification := (select id from public.notification_queue where student_id = v_kid);
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'reason' = 'aluno_ja_decidiu',
    'mandaria o pedido a quem já respondeu'
  );

  v_notification := (select id from public.notification_queue where student_id = v_bulk[1]);
  v_result := private.lesson_recording_request_snapshot_at(v_notification,
    (select scheduled_for from public.notification_queue where id = v_notification));
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'massa de teste não passou na revalidação: ' || v_result::text);
  update public.profiles set phone = '5511955550000' where id = v_bulk[1];
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'reason' = 'contato_mudou',
    'mandaria para o número antigo'
  );

  update public.notification_queue set message_body = replace(message_body, 'Olá', 'Oi')
   where student_id = v_bulk[3];
  v_notification := (select id from public.notification_queue where student_id = v_bulk[3]);
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'reason' = 'mensagem_alterada',
    'mandaria mensagem alterada na fila'
  );

  update public.profiles set lifecycle_status = 'suspended' where id = v_bulk[4];
  v_notification := (select id from public.notification_queue where student_id = v_bulk[4]);
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'reason' = 'aluno_nao_esta_ativo',
    'mandaria para aluno que saiu'
  );

  -- A escola gera o link à mão: o do lote deixa de valer e a mensagem não sai.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.create_lesson_recording_consent_link(v_bulk[2]);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_notification := (select id from public.notification_queue where student_id = v_bulk[2]);
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'reason'
      = 'link_substituido_ou_vencido',
    'mandaria link substituído'
  );

  -- A escola registra revogação: a mensagem na fila não sai.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.revoke_lesson_recording_consent(v_unknown_guardian, 'A família pediu pelo WhatsApp para não registrar.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_notification := (select id from public.notification_queue where student_id = v_unknown_guardian);
  perform pg_temp.lot_assert(
    private.lesson_recording_request_snapshot_at(v_notification,
      (select scheduled_for from public.notification_queue where id = v_notification)) ->> 'ok' = 'false',
    'mandaria pedido depois da revogação'
  );

  -- Abrir o link fica registrado.
  v_token := substring((select message_body from public.notification_queue where student_id = v_bulk[5])
    from 'token=([a-f0-9]{64})');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.lot_assert(
    (public.get_lesson_recording_consent_public(v_token) ->> 'found')::boolean,
    'link do lote não abriu'
  );
  perform pg_temp.lot_assert(
    (select first_opened_at is not null and last_opened_at is not null
      from private.lesson_recording_consent_links
      where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex')),
    'abertura do link não foi registrada'
  );
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_bulk[5]::text and item -> 'request' ->> 'opened_at' is not null),
    'lista não mostra que o link foi aberto'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_kid::text and item ->> 'decision' = 'ACCEPTED'
        and (item -> 'request' ->> 'answered_after')::boolean),
    'lista não mostra que o responsável respondeu depois do pedido'
  );

  perform set_config('fx.accepted_old', v_accepted_old::text, true);
  perform set_config('fx.late', v_late::text, true);
end
$test$;

-- Janela, ritmo e validade valem NA HORA DE MANDAR, com o relógio fixado no
-- horário marcado do pedido (sempre dentro da janela). Antes, só o
-- agendamento respeitava a janela: um adiamento pelo teto ou uma fila parada
-- mandava à noite, no domingo ou em rajada.
-- O relógio é fixado (p_now), para o teste não depender da hora em que roda.
do $pacing$
declare
  v_item uuid;
  v_at timestamptz;
  v_local_night timestamptz;
  v_monday timestamptz := '2026-09-28 10:00:00-03';
  v_result jsonb;
  v_others uuid[];
  v_start timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_item := (select id from public.notification_queue
    where student_id = current_setting('fx.accepted_old')::uuid);
  v_at := (select scheduled_for from public.notification_queue where id = v_item);
  -- Isola o ritmo: os outros pedidos da escola ficam fora da conta.
  update public.notification_queue
     set status = 'skipped', delivery_status = 'skipped', accepted_at = null, sent_at = null
   where tenant_id = 'rec-lot-fixture' and id <> v_item;

  v_result := private.lesson_recording_request_snapshot_at(v_item, v_at);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'pedido válido no horário marcado foi barrado: ' || v_result::text);

  -- Às 21h do mesmo dia: adia até o próximo horário da janela, sem cancelar.
  v_local_night := (date_trunc('day', v_at at time zone 'America/Sao_Paulo') + interval '21 hours')
    at time zone 'America/Sao_Paulo';
  v_result := private.lesson_recording_request_snapshot_at(v_item, v_local_night);
  perform pg_temp.lot_assert(
    v_result ->> 'reason' = 'fora_da_janela_de_envio' and (v_result ->> 'retryable')::boolean
      and (v_result ->> 'defer_seconds')::integer
        = ceil(extract(epoch from private.lesson_recording_send_slot(v_local_night) - v_local_night))::integer,
    'fora da janela o processador mandaria (ou cancelaria): ' || v_result::text
  );
  -- Domingo de manhã também não.
  v_result := private.lesson_recording_request_snapshot_at(v_item, '2026-09-27 10:00:00-03');
  perform pg_temp.lot_assert(
    v_result ->> 'reason' = 'fora_da_janela_de_envio'
      and (v_result ->> 'defer_seconds')::integer = 23 * 3600,
    'mandaria no domingo: ' || v_result::text
  );

  -- Dois dias depois do horário marcado: cancela (não vira rajada atrasada).
  v_result := private.lesson_recording_request_snapshot_at(v_item, v_at + interval '2 days 1 minute');
  perform pg_temp.lot_assert(v_result ->> 'reason' = 'pedido_vencido' and not coalesce((v_result ->> 'retryable')::boolean, false),
    'pedido parado dias na fila ainda sairia: ' || v_result::text);

  -- Ritmo (segunda às 10h): outro termo saiu há 1 minuto -> espera 2min30.
  perform pg_temp.lot_assert(
    (private.lesson_recording_request_snapshot_at(v_item, v_monday) ->> 'ok')::boolean,
    'pedido válido na segunda às 10h foi barrado'
  );
  v_others := array(select id from public.notification_queue
    where tenant_id = 'rec-lot-fixture' and id <> v_item order by scheduled_for limit 5);
  update public.notification_queue
     set status = 'sent', delivery_status = 'accepted', accepted_at = v_monday - interval '60 seconds'
   where id = v_others[1];
  v_result := private.lesson_recording_request_snapshot_at(v_item, v_monday);
  perform pg_temp.lot_assert(
    v_result ->> 'reason' = 'ritmo_do_termo' and (v_result ->> 'defer_seconds')::integer = 90,
    'duas mensagens do termo a 1 minuto uma da outra: ' || v_result::text
  );

  -- Cinco saíram nos últimos 15 minutos -> espera o mais antigo sair da janela.
  update public.notification_queue as queue
     set status = 'sent', delivery_status = 'accepted',
         accepted_at = v_monday - (array[interval '14 minutes', interval '11 minutes', interval '8 minutes',
           interval '5 minutes', interval '3 minutes'])[array_position(v_others, queue.id)]
   where queue.id = any(v_others);
  v_result := private.lesson_recording_request_snapshot_at(v_item, v_monday);
  perform pg_temp.lot_assert(
    v_result ->> 'reason' = 'ritmo_do_termo' and (v_result ->> 'defer_seconds')::integer = 60,
    'sexta mensagem do termo em 15 minutos: ' || v_result::text
  );
  perform pg_temp.lot_assert(
    (private.lesson_recording_request_snapshot_at(v_item, v_monday + interval '61 seconds') ->> 'ok')::boolean,
    'passada a janela de 15 minutos o pedido continuou barrado'
  );

  -- Lote novo logo depois do fim do anterior: começa 3 min depois do que JÁ
  -- SAIU, não só do que está na fila.
  update public.notification_queue
     set status = 'sent', delivery_status = 'accepted',
         scheduled_for = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute',
         accepted_at = now() - interval '30 seconds'
   where tenant_id = 'rec-lot-fixture';
  v_start := private.lesson_recording_batch_start('rec-lot-fixture');
  perform pg_temp.lot_assert(
    v_start >= now() - interval '30 seconds' + interval '3 minutes'
      and v_start = date_trunc('minute', v_start),
    'lote novo encavalou no que acabou de sair: ' || v_start::text
  );
end
$pacing$;


rollback;
