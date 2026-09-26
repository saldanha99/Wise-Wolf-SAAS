-- Envio do termo de registro em lote (migration 20260926210000): quem entra,
-- para quem vai (menor e idade desconhecida -> responsável), idempotência por
-- aluno + versão do termo, espaçamento das mensagens, reenvio só depois de 3
-- dias, revalidação na hora de mandar e registro de abertura do link.
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

-- O banco de teste pode vir só com a estrutura: garante os textos do termo.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v1', repeat('Termo de teste do aluno. ', 20), now() - interval '2 days'),
  ('TEACHER', 'v1', repeat('Termo de teste do professor. ', 20), now() - interval '2 days'),
  ('STUDENT', 'v2', repeat('Termo de teste do aluno v2. ', 20), now() - interval '1 day'),
  ('TEACHER', 'v2', repeat('Termo de teste do professor v2. ', 20), now() - interval '1 day')
on conflict (audience, version) do nothing;

do $privileges$
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
    not has_function_privilege('authenticated', 'private.lesson_recording_enqueue_request(text,uuid,text,text,text,integer,uuid,text,text,boolean,timestamp with time zone,uuid)', 'EXECUTE'),
    'enfileiramento cru exposto ao navegador'
  );
  perform pg_temp.lot_assert(
    has_function_privilege('anon', 'public.get_lesson_recording_consent_public(text)', 'EXECUTE')
    and pg_catalog.pg_get_functiondef('public.get_lesson_recording_consent_public(text)'::regprocedure)
      like '%lesson_recording_note_link_opened%'
    and (select provolatile = 'v' from pg_proc
      where oid = 'public.get_lesson_recording_consent_public(text)'::regprocedure),
    'a página pública não registra a abertura do link (ou perdeu a rota anônima)'
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
  v_bulk uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_late uuid := gen_random_uuid();
  v_all uuid[];
  v_students uuid[];
  v_version text;
  v_result jsonb;
  v_preview jsonb;
  v_blocked boolean;
  v_count integer;
  v_last timestamptz;
  v_message text;
  v_token text;
  v_notification uuid;
  v_row record;
  v_previous timestamptz;
begin
  v_version := (private.lesson_recording_current_term('STUDENT')).version;
  perform pg_temp.lot_assert(v_version is not null and v_version <> 'v1', 'versão vigente do termo ausente');

  v_students := array[v_adult, v_adult2, v_kid, v_unknown_guardian, v_unknown_nocontact, v_minor_nocontact,
    v_refused, v_revoked, v_accepted_current, v_accepted_old, v_inactive, v_test_account] || v_bulk || v_late;
  v_all := array[v_admin, v_coordinator, v_teacher, v_outsider] || v_students;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values
    ('rec-lot-fixture', 'Escola Fixture'),
    ('rec-lot-other', 'Outra Escola Fixture');
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
           when id = v_late then 'Zeca Novo Fixture'
           else 'Massa Lote Fixture ' || array_position(v_bulk, id)::text end,
         birth_date = case
           when id in (v_kid, v_unknown_guardian, v_unknown_nocontact) then null
           when id = v_minor_nocontact then (now() at time zone 'America/Sao_Paulo')::date - interval '10 years'
           when id = any(v_students) then date '1990-05-10'
           else birth_date end,
         is_kids = (id = v_kid),
         guardian_phone = case
           when id = v_kid then '(11) 98888-0003'
           when id = v_unknown_guardian then '5511988880004'
           else null end,
         guardian_id = null,
         attendance_phone = case when id = v_adult2 then '5511988880002' else null end,
         phone = case
           when id = v_adult then '11 98888-0001'
           when id = v_adult2 then '5511977770002'
           when id = v_kid then '5511988880013'
           when id = v_unknown_guardian then '5511988880014'
           when id = v_unknown_nocontact then '5511988880005'
           when id = v_minor_nocontact then '5511988880006'
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
    (select count(*) from public.profiles where id = any(v_students) and is_test_account is not true) = 18,
    'fixture de aluno ficou marcada como conta de teste'
  );

  -- Decisões já registradas.
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source)
  values
    ('rec-lot-fixture', v_refused, 'STUDENT', 'REFUSED', 'Gabi Recusou', 'SELF', 'STUDENT', v_version, 'LINK'),
    ('rec-lot-fixture', v_revoked, 'STUDENT', 'ACCEPTED', 'Hugo Revogou', 'SELF', 'STUDENT', v_version, 'LINK'),
    ('rec-lot-fixture', v_accepted_current, 'STUDENT', 'ACCEPTED', 'Iara Aceitou', 'SELF', 'STUDENT', v_version, 'LINK'),
    ('rec-lot-fixture', v_accepted_old, 'STUDENT', 'ACCEPTED', 'Joao Aceitou', 'SELF', 'STUDENT', 'v1', 'LINK');
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, source, reason)
  values ('rec-lot-fixture', v_revoked, 'STUDENT', 'REVOKED', 'Escola', 'SCHOOL', 'SCHOOL', 'Pedido da família fixture.');

  -- Só a direção dispara.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.preview_lesson_recording_consent_batch();
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'professor abriu a prévia do lote');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coordinator, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(11);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'coordenação disparou o lote');
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(
    (v_result ->> 'ok')::boolean and not (v_result ->> 'can_send')::boolean,
    'coordenação não vê a lista ou aparece como quem pode enviar'
  );

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert(jsonb_array_length(v_result -> 'students') = 0, 'outra escola viu os alunos');
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'outra escola enviou o termo para aluno alheio');

  -- Prévia da direção.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_preview := public.preview_lesson_recording_consent_batch();
  perform pg_temp.lot_assert((v_preview ->> 'to_send')::integer = 11,
    'prévia contou errado quem recebe: ' || (v_preview ->> 'to_send'));
  perform pg_temp.lot_assert((v_preview ->> 'to_guardians')::integer = 2, 'prévia contou errado os responsáveis');
  perform pg_temp.lot_assert((v_preview ->> 'term_updated')::integer = 1, 'prévia não viu quem aceitou versão antiga');
  perform pg_temp.lot_assert((v_preview ->> 'no_contact')::integer = 2, 'prévia não contou os sem contato');
  perform pg_temp.lot_assert((v_preview ->> 'first_at')::timestamptz > now(), 'lote começaria no passado');
  perform pg_temp.lot_assert(
    (v_preview ->> 'last_at')::timestamptz - (v_preview ->> 'first_at')::timestamptz >= interval '30 minutes',
    '11 mensagens caberiam em menos de 30 minutos'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from public.notification_queue where tenant_id = 'rec-lot-fixture'),
    'a prévia enfileirou mensagem'
  );

  -- Contagem diferente da mostrada: nada entra.
  v_blocked := false;
  begin perform public.enqueue_lesson_recording_consent_batch(10);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'aceitou lote com contagem diferente da prévia');
  perform pg_temp.lot_assert(
    not exists (select 1 from private.lesson_recording_consent_requests where tenant_id = 'rec-lot-fixture'),
    'lote recusado deixou pedido para trás'
  );

  v_result := public.enqueue_lesson_recording_consent_batch(11);
  perform pg_temp.lot_assert((v_result ->> 'queued')::integer = 11, 'lote não enfileirou os 11');
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue
      where tenant_id = 'rec-lot-fixture' and notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
        and status = 'pending' and teacher_id is null and scheduled_for > now()) = 11,
    'fila não recebeu 11 mensagens agendadas da escola'
  );
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue
      where tenant_id = 'rec-lot-fixture'
        and idempotency_key = 'lesson-recording-consent:' || student_id::text || ':' || v_version || ':1') = 11,
    'chave de idempotência fora do padrão aluno + versão'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from public.notification_queue where student_id in
      (v_unknown_nocontact, v_minor_nocontact, v_refused, v_revoked, v_accepted_current, v_inactive,
       v_test_account, v_late)),
    'mandou para quem já decidiu, está inativo, é teste ou não tem contato'
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
    (select student_phone from public.notification_queue where student_id = v_adult) = '5511988880001',
    'adulto não recebeu no próprio número'
  );
  perform pg_temp.lot_assert(
    (select student_phone from public.notification_queue where student_id = v_adult2) = '5511988880002',
    'adulto não recebeu no telefone de presença'
  );
  v_message := (select message_body from public.notification_queue where student_id = v_kid);
  perform pg_temp.lot_assert(
    v_message like 'Olá! Aqui é da Escola Fixture. Como responsável por Caio,%'
      and v_message like '%sem vídeo%'
      and v_message ~ 'https://system\.wisewolflanguage\.com\.br/registro-das-aulas\?token=[a-f0-9]{64}'
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

  -- O token só existe na mensagem; no banco, o hash.
  v_token := substring(v_message from 'token=([a-f0-9]{64})');
  perform pg_temp.lot_assert(
    exists (select 1 from private.lesson_recording_consent_links
      where student_id = v_kid and token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'))
    and not exists (select 1 from private.lesson_recording_consent_links where token_hash = v_token),
    'link do lote sem hash ou sem vínculo com a mensagem'
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
  begin perform public.enqueue_lesson_recording_consent_batch(11);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'repetir a contagem antiga passou');
  perform pg_temp.lot_assert(
    (select count(*) from public.notification_queue where tenant_id = 'rec-lot-fixture') = 11,
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

  -- Reenvio.
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

  update public.notification_queue set accepted_at = now() - interval '4 days' where student_id = v_adult;
  v_result := public.resend_lesson_recording_consent_request(v_adult);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'reenvio depois de 3 dias falhou');
  perform pg_temp.lot_assert(
    exists (select 1 from public.notification_queue
      where student_id = v_adult and status = 'pending'
        and idempotency_key = 'lesson-recording-consent:' || v_adult::text || ':' || v_version || ':2'),
    'reenvio sem a segunda tentativa na fila'
  );
  v_blocked := false;
  begin perform public.resend_lesson_recording_consent_request(v_adult);
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'envio_em_andamento'; end;
  perform pg_temp.lot_assert(v_blocked, 'dois reenvios seguidos passaram');

  update public.notification_queue
     set status = 'skipped', delivery_status = 'skipped', last_error = 'contato_mudou'
   where student_id = v_adult2;
  v_result := public.resend_lesson_recording_consent_request(v_adult2);
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'mensagem que não saiu não pôde ser reenviada na hora');

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

  -- Lista do painel.
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.lot_assert((v_result ->> 'can_send')::boolean, 'direção não aparece como quem envia');
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_minor_nocontact::text and item ->> 'recipient' = 'GUARDIAN'
        and item ->> 'missing_reason' = 'menor_sem_telefone_do_responsavel' and item ->> 'contact_last4' is null)
    and exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_unknown_nocontact::text and item ->> 'missing_reason' = 'idade_nao_cadastrada'),
    'lista não mostra quem está sem contato e por quê'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_adult::text and (item -> 'request' ->> 'attempt')::integer = 2
        and item -> 'request' ->> 'state' = 'QUEUED' and item ->> 'resend_available_at' is null),
    'lista não mostra o reenvio na fila'
  );
  perform pg_temp.lot_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_refused::text and not (item ->> 'eligible')::boolean
        and item ->> 'resend_available_at' is null),
    'lista oferece reenvio a quem recusou'
  );
  perform pg_temp.lot_assert(
    not exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' in (v_inactive::text, v_test_account::text)),
    'lista mostrou aluno inativo ou conta de teste'
  );

  -- Revalidação na hora de mandar (processador, service role).
  v_notification := (select id from public.notification_queue where student_id = v_kid);
  v_blocked := false;
  begin perform public.get_lesson_recording_consent_request_snapshot(v_notification);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.lot_assert(v_blocked, 'navegador leu a revalidação do envio');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_result := public.get_lesson_recording_consent_request_snapshot(v_notification);
  perform pg_temp.lot_assert(
    (v_result ->> 'ok')::boolean and v_result ->> 'destination' = '5511988880003'
      and v_result ->> 'message' = v_message,
    'revalidação recusou envio válido: ' || v_result::text
  );

  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source)
  values ('rec-lot-fixture', v_kid, 'STUDENT', 'ACCEPTED', 'Responsavel Fixture', 'GUARDIAN', 'STUDENT', v_version, 'LINK');
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(v_notification) ->> 'reason' = 'aluno_ja_decidiu',
    'mandaria o pedido a quem já respondeu'
  );

  v_result := public.get_lesson_recording_consent_request_snapshot(
    (select id from public.notification_queue where student_id = v_bulk[1]));
  perform pg_temp.lot_assert((v_result ->> 'ok')::boolean, 'massa de teste não passou na revalidação');
  update public.profiles set phone = '5511955550000' where id = v_bulk[1];
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(
      (select id from public.notification_queue where student_id = v_bulk[1])) ->> 'reason' = 'contato_mudou',
    'mandaria para o número antigo'
  );

  update public.notification_queue set message_body = replace(message_body, 'Olá', 'Oi')
   where student_id = v_bulk[3];
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(
      (select id from public.notification_queue where student_id = v_bulk[3])) ->> 'reason' = 'mensagem_alterada',
    'mandaria mensagem alterada na fila'
  );

  update public.profiles set lifecycle_status = 'suspended' where id = v_bulk[4];
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(
      (select id from public.notification_queue where student_id = v_bulk[4])) ->> 'reason' = 'aluno_nao_esta_ativo',
    'mandaria para aluno que saiu'
  );

  -- A escola gera o link à mão: o do lote deixa de valer e a mensagem não sai.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.create_lesson_recording_consent_link(v_bulk[2]);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(
      (select id from public.notification_queue where student_id = v_bulk[2])) ->> 'reason' = 'link_substituido_ou_vencido',
    'mandaria link substituído'
  );

  -- A escola registra revogação: a mensagem na fila não sai.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.revoke_lesson_recording_consent(v_unknown_guardian, 'A família pediu pelo WhatsApp para não registrar.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.lot_assert(
    public.get_lesson_recording_consent_request_snapshot(
      (select id from public.notification_queue where student_id = v_unknown_guardian)) ->> 'ok' = 'false',
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
end
$test$;

rollback;
