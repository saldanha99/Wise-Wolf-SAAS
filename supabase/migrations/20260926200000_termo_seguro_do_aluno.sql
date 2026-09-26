-- Termo de registro das aulas, lado do aluno/responsável: quem responde pelo
-- link precisa provar que é quem diz ser, e a idade vem da escola.
--
-- Medido em 26/09/2026: 47 de 47 alunos ativos sem birth_date e sem is_kids.
-- Na regra de 20260926120000 isso fazia TODOS parecerem adultos: qualquer
-- pessoa com o link (encaminhado, vazado, aberto no celular do filho) podia
-- aceitar "como aluno", digitando um nome. Decisões da direção:
--
-- 1. Responsável é obrigatório quando a idade NÃO é conhecida (fail-closed).
--    Só a data de nascimento cadastrada pela ESCOLA (SCHOOL_ADMIN/COORDINATOR,
--    pela RPC set_student_birth_date, com trilha) prova maioridade. Data vinda
--    de outro caminho (formulário de matrícula, o próprio aluno) não vale: a
--    prova é a linha de private.student_birth_date_records que bate com o
--    cadastro; mudou o cadastro por fora, a prova some.
-- 2. O professor não classifica mais o aluno como infantil (is_kids): nem pela
--    RPC update_student_pedagogical_profile, nem direto pela API.
-- 3. Antes de gravar a decisão (aceite OU recusa), a página pede um código de
--    6 dígitos mandado por WhatsApp ao telefone cadastrado (do aluno, ou do
--    responsável quando exigido). O código nasce aqui, é devolvido UMA vez à
--    edge `lesson-recording-code` (service_role), que o envia pelo helper que
--    respeita o teto do WhatsApp; no banco fica só o hash (com o id do desafio
--    como sal). Vale 10 minutos, 5 tentativas, 3 envios por hora por link.
--    O telefone é congelado no link por um trigger (vale para QUALQUER criador
--    de link, inclusive o envio em lote), e só entra telefone ATESTADO: o
--    contato de responsável verificado pela escola, ou o telefone/vínculo do
--    responsável cuja última gravação na trilha (profile_audit_log) foi da
--    direção, da coordenação ou do servidor (matrícula). O próprio aluno não
--    altera mais nascimento, turma infantil, telefone nem vínculo do
--    responsável pela API — senão um menor apontava o "telefone do
--    responsável" para o próprio número e assinava no lugar da família.
-- 4. A decisão registra que houve código e para qual telefone (mascarado).
--    Aceite pelo link sem código (versão anterior) não vale para marcar aula,
--    e aceite "como aluno" deixa de valer se a escola descobrir que é menor —
--    e a página pública diz isso, em vez de mostrar "Autorizado".
-- 5. Tetos acumulados por link: 3 envios por hora, 6 por dia e 10 no total;
--    15 tentativas erradas somando todos os códigos. Batido o total, o link é
--    bloqueado (a escola gera outro) e o painel mostra o motivo.

-- ---------------------------------------------------------------------------
-- 1. Data de nascimento cadastrada pela escola
-- ---------------------------------------------------------------------------

create table if not exists private.student_birth_date_records (
  seq bigint generated always as identity primary key,
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  birth_date date check (birth_date is null or birth_date >= date '1900-01-01'),
  previous_birth_date date,
  recorded_by uuid not null references public.profiles(id),
  recorded_role text not null check (recorded_role in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')),
  reason text check (reason is null or length(reason) <= 500),
  recorded_at timestamptz not null default now()
);
create index if not exists student_birth_date_records_student_idx
  on private.student_birth_date_records(student_id, seq desc);

alter table private.student_birth_date_records owner to postgres;
alter table private.student_birth_date_records enable row level security;
revoke all on private.student_birth_date_records from public, anon, authenticated, service_role;

-- Data de nascimento que a escola atestou E que ainda é a do cadastro.
create or replace function private.lesson_recording_school_birth_date(p_student uuid)
returns date
language sql stable security definer set search_path = '' as $$
  select latest.birth_date
  from (
    select record.birth_date, record.tenant_id
    from private.student_birth_date_records as record
    where record.student_id = p_student
    order by record.seq desc
    limit 1
  ) as latest
  join public.profiles as student on student.id = p_student
  where latest.tenant_id = student.tenant_id
    and latest.birth_date = student.birth_date;
$$;

-- Por que o responsável responde: KIDS (turma infantil), MINOR (menor pela
-- data da escola), AGE_UNKNOWN (sem data atestada). Nulo = adulto comprovado.
create or replace function private.lesson_recording_guardian_reason(p_student uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_is_kids boolean;
  v_birth date;
begin
  select coalesce(student.is_kids, false) into v_is_kids
  from public.profiles as student
  where student.id = p_student;
  if not found then
    return 'AGE_UNKNOWN';
  end if;
  if v_is_kids then
    return 'KIDS';
  end if;
  v_birth := private.lesson_recording_school_birth_date(p_student);
  if v_birth is null then
    return 'AGE_UNKNOWN';
  end if;
  if v_birth > ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - interval '18 years')::date then
    return 'MINOR';
  end if;
  return null;
end;
$$;

-- Fail-closed: sem prova de maioridade, quem responde é o responsável.
create or replace function private.lesson_recording_requires_guardian(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_guardian_reason(p_student) is not null;
$$;

create or replace function public.set_student_birth_date(
  p_student_id uuid,
  p_birth_date date,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_actor public.profiles;
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_reason text := left(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), 500);
  v_latest date;
  v_has_record boolean;
begin
  select * into v_student from public.profiles where id = p_student_id for update;
  if not found or v_student.role <> 'STUDENT' then
    raise exception 'aluno_invalido' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_actor from public.profiles where id = (select auth.uid());
  if coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if p_birth_date is not null
     and (p_birth_date > v_today or p_birth_date < date '1900-01-01') then
    raise exception 'data_de_nascimento_invalida' using errcode = '22023';
  end if;

  select true, record.birth_date into v_has_record, v_latest
  from private.student_birth_date_records as record
  where record.student_id = p_student_id and record.tenant_id = v_student.tenant_id
  order by record.seq desc limit 1;

  -- Mesma data já atestada e ainda no cadastro: nada a registrar de novo.
  if coalesce(v_has_record, false)
     and v_latest is not distinct from p_birth_date
     and v_student.birth_date is not distinct from p_birth_date then
    return jsonb_build_object(
      'ok', true, 'unchanged', true, 'birth_date', p_birth_date,
      'guardian_reason', private.lesson_recording_guardian_reason(p_student_id)
    );
  end if;

  -- A troca do valor entra em profile_audit_log pelo trigger log_profile_changes.
  update public.profiles
     set birth_date = p_birth_date
   where id = p_student_id and birth_date is distinct from p_birth_date;

  -- A escola confirmou a data que já estava no cadastro (ex.: veio do
  -- formulário de matrícula): o trigger não vê mudança, a trilha registra.
  if v_student.birth_date is not distinct from p_birth_date then
    insert into public.profile_audit_log (tenant_id, profile_id, changed_by, field, old_value, new_value)
    values (v_student.tenant_id, p_student_id, v_actor.id, 'birth_date_confirmed',
      p_birth_date::text, p_birth_date::text);
  end if;

  insert into private.student_birth_date_records (
    tenant_id, student_id, birth_date, previous_birth_date, recorded_by, recorded_role, reason
  ) values (
    v_student.tenant_id, p_student_id, p_birth_date, v_student.birth_date, v_actor.id, v_actor.role,
    nullif(v_reason, '')
  );

  return jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'birth_date', p_birth_date,
    'guardian_reason', private.lesson_recording_guardian_reason(p_student_id)
  );
end;
$$;

create or replace function public.get_student_birth_date_record(p_student_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_record record;
begin
  select * into v_student from public.profiles where id = p_student_id;
  if not found or v_student.role <> 'STUDENT' then
    raise exception 'aluno_invalido' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  select record.birth_date, record.recorded_at, record.recorded_role, record.reason,
         nullif(btrim(coalesce(recorder.full_name, '')), '') as recorded_by_name
    into v_record
  from private.student_birth_date_records as record
  left join public.profiles as recorder on recorder.id = record.recorded_by
  where record.student_id = p_student_id and record.tenant_id = v_student.tenant_id
  order by record.seq desc limit 1;

  return jsonb_build_object(
    'ok', true,
    'profile_birth_date', v_student.birth_date,
    'school_birth_date', private.lesson_recording_school_birth_date(p_student_id),
    'recorded_at', v_record.recorded_at,
    'recorded_by_name', v_record.recorded_by_name,
    'recorded_role', v_record.recorded_role,
    'reason', v_record.reason,
    'is_kids', coalesce(v_student.is_kids, false),
    'guardian_reason', private.lesson_recording_guardian_reason(p_student_id),
    -- Telefone do responsável que recebe o código (só o atestado pela escola).
    'guardian_code_phone_masked', private.lesson_recording_mask_phone(private.lesson_recording_guardian_phone(p_student_id)),
    'guardian_phone_unconfirmed', private.lesson_recording_guardian_phone_unconfirmed(p_student_id)
  );
end;
$$;

-- Trilha de aluno ganha nascimento, turma infantil, telefone e vínculo do
-- responsável (quem recebe o código quando o responsável responde): é por
-- ela que se sabe se o telefone do responsável foi gravado pela escola.
-- changed_at passa a ser o relógio da mudança (clock_timestamp), não o início
-- da transação: duas mudanças na mesma transação ficam em ordem na trilha.
-- Resto igual ao vivo.
create or replace function public.log_profile_changes()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_by uuid := auth.uid(); PROC RECORD; vals text[][];
BEGIN
  IF NEW.role = 'STUDENT' THEN
    FOR PROC IN SELECT * FROM (VALUES
      ('full_name', OLD.full_name, NEW.full_name),
      ('module', OLD.module, NEW.module),
      ('monthly_fee', OLD.monthly_fee::text, NEW.monthly_fee::text),
      ('due_day', OLD.due_day::text, NEW.due_day::text),
      ('status_financial', OLD.status_financial, NEW.status_financial),
      ('professor_id', OLD.professor_id::text, NEW.professor_id::text),
      ('cpf', OLD.cpf, NEW.cpf), ('phone', OLD.phone, NEW.phone),
      ('birth_date', OLD.birth_date::text, NEW.birth_date::text),
      ('is_kids', OLD.is_kids::text, NEW.is_kids::text),
      ('guardian_phone', OLD.guardian_phone, NEW.guardian_phone),
      ('guardian_id', OLD.guardian_id::text, NEW.guardian_id::text)
    ) AS t(field, oldv, newv) LOOP
      IF PROC.oldv IS DISTINCT FROM PROC.newv THEN
        INSERT INTO profile_audit_log (tenant_id, profile_id, changed_by, field, old_value, new_value, changed_at)
        VALUES (NEW.tenant_id, NEW.id, v_by, PROC.field, PROC.oldv, PROC.newv, clock_timestamp()); END IF;
    END LOOP;
  ELSIF NEW.role = 'TEACHER' THEN
    FOR PROC IN SELECT * FROM (VALUES
      ('full_name', OLD.full_name, NEW.full_name),
      ('hourly_rate', OLD.hourly_rate::text, NEW.hourly_rate::text),
      ('commission_rate', OLD.commission_rate::text, NEW.commission_rate::text),
      ('status', OLD.status, NEW.status), ('pix_key', OLD.pix_key, NEW.pix_key)
    ) AS t(field, oldv, newv) LOOP
      IF PROC.oldv IS DISTINCT FROM PROC.newv THEN
        INSERT INTO profile_audit_log (tenant_id, profile_id, changed_by, field, old_value, new_value, changed_at)
        VALUES (NEW.tenant_id, NEW.id, v_by, PROC.field, PROC.oldv, PROC.newv, clock_timestamp()); END IF;
    END LOOP;
  ELSIF NEW.role = 'SALESPERSON' THEN
    FOR PROC IN SELECT * FROM (VALUES
      ('full_name', OLD.full_name, NEW.full_name),
      ('commission_rate', OLD.commission_rate::text, NEW.commission_rate::text),
      ('status', OLD.status, NEW.status), ('pix_key', OLD.pix_key, NEW.pix_key)
    ) AS t(field, oldv, newv) LOOP
      IF PROC.oldv IS DISTINCT FROM PROC.newv THEN
        INSERT INTO profile_audit_log (tenant_id, profile_id, changed_by, field, old_value, new_value, changed_at)
        VALUES (NEW.tenant_id, NEW.id, v_by, PROC.field, PROC.oldv, PROC.newv, clock_timestamp()); END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Professor não classifica aluno como infantil
-- ---------------------------------------------------------------------------

-- Pela API (PostgREST): mesmo bloco que já protege nascimento e telefone do
-- responsável. E o próprio aluno deixa de mudar, no perfil dele, o que decide
-- quem responde o termo (nascimento, turma infantil, telefone e vínculo do
-- responsável): nenhuma tela do aluno grava esses campos (conferido em
-- 26/09/2026); matrícula e escola gravam por outros caminhos. Resto igual à
-- definição viva.
create or replace function public.enforce_profile_authorization_fields()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  actor_id uuid := (select auth.uid());
  actor_role text;
  privileged_runtime boolean := current_user in (
    'postgres', 'service_role', 'supabase_admin'
  );
begin
  if privileged_runtime then return new; end if;

  select profile.role into actor_role
  from public.profiles as profile
  where profile.id = actor_id;
  if actor_role = 'SUPER_ADMIN' then return new; end if;

  if new.id is distinct from old.id
     or new.role is distinct from old.role
     or new.tenant_id is distinct from old.tenant_id
     or new.whatsapp_instance is distinct from old.whatsapp_instance
     or new.whatsapp_instance_id is distinct from old.whatsapp_instance_id
     or new.whatsapp_instance_name is distinct from old.whatsapp_instance_name
     or new.whatsapp_token is distinct from old.whatsapp_token then
    raise exception 'authorization-managed profile fields cannot be changed by this role'
      using errcode = '42501';
  end if;

  if actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    if new.monthly_fee is distinct from old.monthly_fee
       or new.monthly_tuition is distinct from old.monthly_tuition
       or new.fidelity_plan is distinct from old.fidelity_plan
       or new.due_day is distinct from old.due_day
       or new.subscription_id is distinct from old.subscription_id
       or new.asaas_customer_id is distinct from old.asaas_customer_id
       or new.asaas_subscription_status is distinct from old.asaas_subscription_status
       or new.asaas_subscription_end_date is distinct from old.asaas_subscription_end_date
       or new.asaas_subscription_synced_at is distinct from old.asaas_subscription_synced_at
       or new.status_financial is distinct from old.status_financial
       or new.enrollment_fee is distinct from old.enrollment_fee
       or new.enrollment_fee_paid is distinct from old.enrollment_fee_paid
       or new.enrollment_payment_id is distinct from old.enrollment_payment_id
       or new.paid_through is distinct from old.paid_through
       or new.prepaid_months is distinct from old.prepaid_months
       or new.hourly_rate is distinct from old.hourly_rate
       or new.commission_rate is distinct from old.commission_rate then
      raise exception 'financial profile fields cannot be changed by this role'
        using errcode = '42501';
    end if;
  end if;

  if actor_role = 'TEACHER' and old.id <> actor_id then
    if new.email is distinct from old.email
       or new.phone is distinct from old.phone
       or new.cpf is distinct from old.cpf
       or new.rg is distinct from old.rg
       or new.birth_date is distinct from old.birth_date
       or new.is_kids is distinct from old.is_kids
       or new.cnpj is distinct from old.cnpj
       or new.cnpj_company_name is distinct from old.cnpj_company_name
       or new.address is distinct from old.address
       or new.address_number is distinct from old.address_number
       or new.postal_code is distinct from old.postal_code
       or new.bank_name is distinct from old.bank_name
       or new.agency is distinct from old.agency
       or new.account_number is distinct from old.account_number
       or new.pix_key is distinct from old.pix_key
       or new.pix_key_type is distinct from old.pix_key_type
       or new.guardian_name is distinct from old.guardian_name
       or new.guardian_cpf is distinct from old.guardian_cpf
       or new.guardian_email is distinct from old.guardian_email
       or new.guardian_phone is distinct from old.guardian_phone
       or new.guardian_id is distinct from old.guardian_id
       or new.private_notes is distinct from old.private_notes
       or new.signature_ip is distinct from old.signature_ip
       or new.signature_url is distinct from old.signature_url
       or new.contract_url is distinct from old.contract_url
       or new.student_signature_url is distinct from old.student_signature_url
       or new.signed_document_url is distinct from old.signed_document_url
       or new.wise_wolf_signature_token is distinct from old.wise_wolf_signature_token
       or new.typed_signature is distinct from old.typed_signature
       or new.signature_hash is distinct from old.signature_hash
       or new.user_ip is distinct from old.user_ip then
      raise exception 'private profile fields cannot be changed by a teacher'
        using errcode = '42501';
    end if;
  end if;

  if actor_role = 'STUDENT' and old.id = actor_id then
    if new.birth_date is distinct from old.birth_date
       or new.is_kids is distinct from old.is_kids
       or new.guardian_phone is distinct from old.guardian_phone
       or new.guardian_id is distinct from old.guardian_id then
      raise exception 'school-managed profile fields cannot be changed by the student'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

-- Pela RPC pedagógica (roda como postgres, o trigger acima não a vê): o
-- professor não muda is_kids. Mandar o mesmo valor que já está no cadastro
-- continua valendo (as telas antigas mandam o formulário inteiro).
create or replace function public.update_student_pedagogical_profile(p_student_id uuid, p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid(); v_role text := public._my_role();
  v_before public.profiles%rowtype; v_after public.profiles%rowtype;
  v_result jsonb; v_effective_data jsonb := p_data; v_fields text[] := '{}';
  v_notice uuid; v_previous_notice_guard text := current_setting('app.teacher_profile_notice_wrapped',true);
begin
  select * into v_before from public.profiles where id=p_student_id;
  if v_role='TEACHER' then
    if p_data ? 'is_kids'
       and coalesce(nullif(p_data->>'is_kids','')::boolean, false) is distinct from coalesce(v_before.is_kids, false) then
      raise exception using errcode = '42501', message = 'kids_classification_requires_direction';
    end if;
    v_effective_data := v_effective_data-'status'-'status_reason'-'is_kids';
  end if;
  perform set_config('app.teacher_profile_notice_wrapped','1',true);
  v_result := private.update_student_pedagogical_profile_before_teacher_notice(p_student_id,v_effective_data);
  perform set_config('app.teacher_profile_notice_wrapped',coalesce(v_previous_notice_guard,''),true);
  select * into v_after from public.profiles where id=p_student_id;
  if v_role='TEACHER' then
    if v_before.full_name is distinct from v_after.full_name then v_fields:=array_append(v_fields,'nome'); end if;
    if v_before.phone is distinct from v_after.phone then v_fields:=array_append(v_fields,'telefone'); end if;
    if v_before.attendance_phone is distinct from v_after.attendance_phone then v_fields:=array_append(v_fields,'contato de presença'); end if;
    if v_before.meeting_link is distinct from v_after.meeting_link then v_fields:=array_append(v_fields,'link da aula'); end if;
    if v_before.occupation is distinct from v_after.occupation then v_fields:=array_append(v_fields,'ocupação'); end if;
    if v_before.interests is distinct from v_after.interests then v_fields:=array_append(v_fields,'interesses'); end if;
    if v_before.private_notes is distinct from v_after.private_notes then v_fields:=array_append(v_fields,'notas pedagógicas'); end if;
    if v_before.fixed_schedule is distinct from v_after.fixed_schedule then v_fields:=array_append(v_fields,'descrição da agenda'); end if;
    if v_before.module is distinct from v_after.module then v_fields:=array_append(v_fields,'nível pedagógico'); end if;
    if coalesce(array_length(v_fields,1),0)>0 then
      v_notice:=private.enqueue_teacher_change_group_notice(v_after.tenant_id,v_actor,p_student_id,
        'Perfil pedagógico do aluno','Campos alterados: '||array_to_string(v_fields,', ')||'.');
    end if;
  end if;
  return v_result||jsonb_build_object('group_notification_id',v_notice);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Telefone do código: o atestado pela escola, congelado quando o link nasce
-- ---------------------------------------------------------------------------

-- Só dígitos; número brasileiro sem DDI ganha o 55. Fora do formato, nulo.
create or replace function private.lesson_recording_normalize_phone(p_phone text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when length(digits.value) in (10, 11) then '55' || digits.value
    when length(digits.value) between 12 and 15 then digits.value
    else null
  end
  from (
    select ltrim(pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '0') as value
  ) as digits;
$$;

-- "(11) •••••-1234": o bastante para a família reconhecer o número.
create or replace function private.lesson_recording_mask_phone(p_phone text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when digits.value is null or length(digits.value) < 10 then null
    when digits.value like '55%' and length(digits.value) in (12, 13)
      then '(' || substr(digits.value, 3, 2) || ') •••••-' || right(digits.value, 4)
    else '+' || left(digits.value, 2) || ' ••••-' || right(digits.value, 4)
  end
  from (
    select pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as value
  ) as digits;
$$;

-- Telefone do aluno: contato verificado pela escola, depois o do cadastro.
create or replace function private.lesson_recording_student_phone(p_student uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (
      select private.lesson_recording_normalize_phone(contact.phone)
      from public.student_quality_contacts as contact
      join public.profiles as student on student.id = contact.student_id
      where contact.student_id = p_student and contact.tenant_id = student.tenant_id
        and contact.active and contact.verified_at is not null
        and contact.relationship = 'STUDENT'
      order by contact.verified_at desc
      limit 1
    ),
    (select private.lesson_recording_normalize_phone(student.phone) from public.profiles as student where student.id = p_student),
    (select private.lesson_recording_normalize_phone(student.attendance_phone) from public.profiles as student where student.id = p_student)
  );
$$;

-- Quem pode atestar um dado do aluno que decide o termo: a escola (direção,
-- coordenação da própria escola, super admin) ou o servidor sem usuário na
-- sessão (matrícula por service_role, rotina de banco). Aluno, professor e
-- qualquer outro papel, não.
create or replace function private.lesson_recording_trusted_editor(p_actor uuid, p_tenant text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_actor is null or exists (
    select 1 from public.profiles as editor
    where editor.id = p_actor
      and (editor.role = 'SUPER_ADMIN'
        or (editor.role in ('SCHOOL_ADMIN', 'COORDINATOR') and editor.tenant_id = p_tenant))
  );
$$;

-- O valor ATUAL de um campo do aluno foi gravado por quem pode atestar? Lê a
-- trilha de profile_audit_log (escrita só pelo trigger log_profile_changes e
-- por RPCs da escola; a tabela não aceita INSERT de fora): as linhas mais
-- recentes do campo têm de trazer o valor de hoje e autor confiável. Empate
-- de horário conta contra (fail-closed). Sem trilha — valor gravado antes da
-- auditoria ou na criação do perfil — não está atestado: a escola confirma
-- pelo contato de responsável verificado (ficha do aluno).
create or replace function private.lesson_recording_profile_value_attested(
  p_student uuid,
  p_field text,
  p_current text
)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_current is not null and coalesce((
    select bool_and(
      latest.new_value is not distinct from p_current
      and latest.tenant_id is not distinct from student.tenant_id
      and private.lesson_recording_trusted_editor(latest.changed_by, student.tenant_id)
    )
    from public.profiles as student
    cross join lateral (
      select log.new_value, log.changed_by, log.tenant_id,
             rank() over (order by log.changed_at desc) as position
      from public.profile_audit_log as log
      where log.profile_id = p_student and log.field = p_field
    ) as latest
    where student.id = p_student and latest.position = 1
  ), false);
$$;

-- Telefone do responsável que recebe o código: só o ATESTADO pela escola.
-- 1) contato de responsável verificado pela escola (student_quality_contacts,
--    aprovado na ficha do aluno); 2) guardian_phone gravado pela escola ou pela
--    matrícula; 3) telefone do perfil do responsável financeiro, quando o
--    vínculo (guardian_id) foi gravado pela escola ou pela matrícula.
-- Número que o próprio aluno pôs no cadastro não entra, nem que seja por uma
-- rota antiga: a trilha diria que foi ele.
create or replace function private.lesson_recording_guardian_phone(p_student uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (
      select private.lesson_recording_normalize_phone(contact.phone)
      from public.student_quality_contacts as contact
      join public.profiles as student on student.id = contact.student_id
      where contact.student_id = p_student and contact.tenant_id = student.tenant_id
        and contact.active and contact.verified_at is not null
        and contact.relationship = 'GUARDIAN'
      order by contact.verified_at desc
      limit 1
    ),
    (
      select private.lesson_recording_normalize_phone(student.guardian_phone)
      from public.profiles as student
      where student.id = p_student
        and private.lesson_recording_profile_value_attested(p_student, 'guardian_phone', student.guardian_phone)
    ),
    (
      select private.lesson_recording_normalize_phone(guardian.phone)
      from public.profiles as student
      join public.profiles as guardian on guardian.id = student.guardian_id
      where student.id = p_student and guardian.id <> student.id
        and guardian.tenant_id = student.tenant_id
        and private.lesson_recording_profile_value_attested(p_student, 'guardian_id', student.guardian_id::text)
    )
  );
$$;

-- O cadastro tem telefone ou vínculo de responsável, mas nenhum atestado: a
-- escola precisa confirmar (o painel explica onde).
create or replace function private.lesson_recording_guardian_phone_unconfirmed(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (nullif(btrim(coalesce(student.guardian_phone, '')), '') is not null
        or student.guardian_id is not null)
      and private.lesson_recording_guardian_phone(p_student) is null
    from public.profiles as student
    where student.id = p_student
  ), false);
$$;

-- Mesmo número para aluno e responsável (comum quando a criança não tem
-- celular e o cadastro usa o da família). Não bloqueia — a escola atestou —,
-- mas o painel pede para conferir.
create or replace function private.lesson_recording_same_phone(p_left text, p_right text)
returns boolean
language sql immutable set search_path = '' as $$
  select length(pg_catalog.regexp_replace(coalesce(p_left, ''), '\D', '', 'g')) >= 8
    and right(pg_catalog.regexp_replace(coalesce(p_left, ''), '\D', '', 'g'), 8)
      = right(pg_catalog.regexp_replace(coalesce(p_right, ''), '\D', '', 'g'), 8);
$$;

alter table private.lesson_recording_consent_links
  add column if not exists student_phone text
    check (student_phone is null or student_phone ~ '^[0-9]{12,15}$'),
  add column if not exists guardian_phone text
    check (guardian_phone is null or guardian_phone ~ '^[0-9]{12,15}$'),
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text
    check (blocked_reason is null or blocked_reason in ('CODE_ATTEMPTS', 'CODE_SENDS'));

-- Congela no link, na criação, os telefones atestados de hoje — para QUALQUER
-- criador (a tela da escola, o envio em lote, uma rotina futura) e ignorando
-- o que o criador mandou. Depois de criado, o telefone do link não muda.
create or replace function private.lesson_recording_freeze_link_phones()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.student_phone := private.lesson_recording_student_phone(new.student_id);
    new.guardian_phone := private.lesson_recording_guardian_phone(new.student_id);
  elsif new.student_phone is distinct from old.student_phone
     or new.guardian_phone is distinct from old.guardian_phone then
    raise exception 'lesson_recording_link_phone_frozen' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists lesson_recording_consent_links_freeze_phones
  on private.lesson_recording_consent_links;
create trigger lesson_recording_consent_links_freeze_phones
  before insert or update of student_phone, guardian_phone
  on private.lesson_recording_consent_links
  for each row execute function private.lesson_recording_freeze_link_phones();

create table if not exists private.lesson_recording_consent_challenges (
  id uuid primary key,
  seq bigint generated always as identity,
  link_id uuid not null references private.lesson_recording_consent_links(id),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  relation text not null check (relation in ('SELF', 'GUARDIAN')),
  destination text not null check (destination ~ '^[0-9]{12,15}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  delivery_status text not null default 'ISSUED'
    check (delivery_status in ('ISSUED', 'SENT', 'AMBIGUOUS', 'NOT_SENT')),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) <= 320),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz
);
-- Ordem estrita dos códigos de um link (created_at empata dentro da mesma
-- transação). Quem já tinha a tabela sem a coluna ganha a coluna aqui.
alter table private.lesson_recording_consent_challenges
  add column if not exists seq bigint generated always as identity;
create index if not exists lesson_recording_consent_challenges_link_idx
  on private.lesson_recording_consent_challenges(link_id, created_at desc);
create index if not exists lesson_recording_consent_challenges_link_seq_idx
  on private.lesson_recording_consent_challenges(link_id, seq desc);

alter table private.lesson_recording_consent_challenges owner to postgres;
alter table private.lesson_recording_consent_challenges enable row level security;
revoke all on private.lesson_recording_consent_challenges from public, anon, authenticated, service_role;

alter table private.lesson_recording_consents
  add column if not exists verification text
    check (verification is null or verification = 'WHATSAPP_CODE'),
  add column if not exists verified_phone text
    check (verified_phone is null or length(verified_phone) <= 40),
  add column if not exists verification_challenge_id uuid
    references private.lesson_recording_consent_challenges(id);

-- Decisão pelo link sem código não entra mais. NOT VALID: não reavalia linha
-- antiga (a versão anterior gravava sem código), vale para toda linha nova.
do $verified_check$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'lesson_recording_consents_link_verified_check'
      and conrelid = 'private.lesson_recording_consents'::regclass
  ) then
    alter table private.lesson_recording_consents
      add constraint lesson_recording_consents_link_verified_check
      check (
        source <> 'LINK'
        or (verification = 'WHATSAPP_CODE' and verified_phone is not null
          and verification_challenge_id is not null)
      ) not valid;
  end if;
end
$verified_check$;

-- ---------------------------------------------------------------------------
-- 4. Aceite que vale para marcar aula
-- ---------------------------------------------------------------------------

-- Aluno: última decisão é aceite com código e, se hoje o cadastro exige
-- responsável, quem aceitou foi o responsável.
create or replace function private.lesson_recording_student_consent_effective(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select last_decision.decision = 'ACCEPTED'
      and last_decision.verification = 'WHATSAPP_CODE'
      and (last_decision.signer_relation = 'GUARDIAN'
        or not private.lesson_recording_requires_guardian(p_student))
    from (
      select consent.decision, consent.verification, consent.signer_relation
      from private.lesson_recording_consents as consent
      where consent.subject_id = p_student
      order by consent.seq desc
      limit 1
    ) as last_decision
  ), false);
$$;

create or replace function private.lesson_recording_active(p_student uuid, p_teacher uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_student_consent_effective(p_student)
    and private.lesson_recording_consent_state(p_teacher) = 'ACCEPTED';
$$;

-- ---------------------------------------------------------------------------
-- 5. Link, página pública, código e decisão
-- ---------------------------------------------------------------------------

create or replace function public.create_lesson_recording_consent_link(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_token text;
  v_expires timestamptz := pg_catalog.now() + interval '30 days';
  v_student_phone text;
  v_guardian_phone text;
begin
  select * into v_student from public.profiles where id = p_student_id;
  if not found or v_student.role <> 'STUDENT' then
    raise exception 'aluno_invalido' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  -- Um link vivo por aluno: gerar outro invalida o anterior.
  update private.lesson_recording_consent_links
     set revoked_at = pg_catalog.now()
   where student_id = p_student_id and revoked_at is null;

  -- Os telefones do código são congelados pelo trigger do link (atestados).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.lesson_recording_consent_links (
    tenant_id, student_id, token_hash, created_by, expires_at
  ) values (
    v_student.tenant_id, p_student_id, encode(extensions.digest(v_token, 'sha256'), 'hex'),
    (select auth.uid()), v_expires
  )
  returning student_phone, guardian_phone into v_student_phone, v_guardian_phone;

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', v_expires,
    'guardian_reason', private.lesson_recording_guardian_reason(p_student_id),
    'student_phone_masked', private.lesson_recording_mask_phone(v_student_phone),
    'guardian_phone_masked', private.lesson_recording_mask_phone(v_guardian_phone),
    'guardian_phone_unconfirmed', private.lesson_recording_guardian_phone_unconfirmed(p_student_id)
  );
end;
$$;

-- O que a página pública precisa saber para pedir o código e para não
-- mostrar como resolvido um aceite que não vale. Fica numa função própria
-- para que QUALQUER versão de get_lesson_recording_consent_public (a do envio
-- em lote recria a página) só precise juntar `|| lesson_recording_public_link_fields(link)`.
create or replace function private.lesson_recording_public_link_fields(p_link_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_link private.lesson_recording_consent_links;
  v_reason text;
  v_decision text;
  v_verification text;
  v_effective boolean;
begin
  select * into v_link from private.lesson_recording_consent_links where id = p_link_id;
  if not found then
    return '{}'::jsonb;
  end if;
  v_reason := private.lesson_recording_guardian_reason(v_link.student_id);
  select consent.decision, consent.verification into v_decision, v_verification
  from private.lesson_recording_consents as consent
  where consent.subject_id = v_link.student_id
  order by consent.seq desc
  limit 1;
  v_effective := private.lesson_recording_student_consent_effective(v_link.student_id);

  return jsonb_build_object(
    'requires_guardian', v_reason is not null,
    'guardian_reason', v_reason,
    'student_phone_masked', private.lesson_recording_mask_phone(v_link.student_phone),
    'guardian_phone_masked', private.lesson_recording_mask_phone(v_link.guardian_phone),
    'current_effective', v_effective,
    -- Aceite gravado que não vale: sem o código (versão anterior do link) ou
    -- dado pelo aluno quando hoje o cadastro exige o responsável.
    'current_not_effective_reason', case
      when v_decision = 'ACCEPTED' and not v_effective then
        case when v_verification is distinct from 'WHATSAPP_CODE' then 'UNVERIFIED' else 'GUARDIAN_REQUIRED' end
    end
  );
end;
$$;

create or replace function public.get_lesson_recording_consent_public(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_student_name text;
  v_school_name text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if found and v_link.blocked_at is not null then
    return jsonb_build_object('found', false, 'expired', true, 'blocked', true);
  end if;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    return jsonb_build_object('found', false, 'expired', found);
  end if;

  v_term := private.lesson_recording_current_term('STUDENT');
  select split_part(btrim(student.full_name), ' ', 1) into v_student_name
  from public.profiles as student where student.id = v_link.student_id;
  select tenant.name into v_school_name from public.tenants as tenant where tenant.id = v_link.tenant_id;

  return jsonb_build_object(
    'found', true,
    'school_name', v_school_name,
    'student_first_name', v_student_name,
    'term_version', v_term.version,
    'term_body', v_term.body,
    'current_decision', private.lesson_recording_consent_state(v_link.student_id),
    'expires_at', v_link.expires_at
  ) || private.lesson_recording_public_link_fields(v_link.id);
end;
$$;

-- Tetos do código por link. Por hora e por dia protegem o número da escola
-- (restringido pelo WhatsApp em 17/09/2026 depois de mensagens em série) e a
-- família de receber código sem pedir; o total e as tentativas erradas
-- somadas fecham o link vazado de vez — a escola gera outro.
create or replace function private.lesson_recording_code_limits()
returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'sends_per_hour', 3,
    'requests_per_hour', 10,
    'sends_per_day', 6,
    'sends_per_link', 10,
    'wrong_attempts_per_code', 5,
    'wrong_attempts_per_link', 15
  );
$$;

-- Bloqueia o link (e os códigos vivos dele). Bloqueado também é revogado:
-- toda rota que confere revoked_at já trata o link como morto.
create or replace function private.lesson_recording_block_link(p_link_id uuid, p_reason text)
returns void
language sql volatile security definer set search_path = '' as $$
  update private.lesson_recording_consent_links
     set blocked_at = coalesce(blocked_at, pg_catalog.now()),
         blocked_reason = coalesce(blocked_reason, p_reason),
         revoked_at = coalesce(revoked_at, pg_catalog.now())
   where id = p_link_id;
  update private.lesson_recording_consent_challenges
     set invalidated_at = pg_catalog.now()
   where link_id = p_link_id and consumed_at is null and invalidated_at is null;
$$;

-- Só a edge `lesson-recording-code` (service_role) chama: devolve o código
-- UMA vez para ela mandar pelo WhatsApp; aqui fica só o hash.
create or replace function public.issue_lesson_recording_consent_code(p_token text, p_relation text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limits jsonb := private.lesson_recording_code_limits();
  v_link private.lesson_recording_consent_links;
  v_destination text;
  v_delivered_hour integer;
  v_issued_hour integer;
  v_delivered_day integer;
  v_delivered_total integer;
  v_oldest_delivered_hour timestamptz;
  v_oldest_issued_hour timestamptz;
  v_oldest_delivered_day timestamptz;
  v_id uuid := extensions.gen_random_uuid();
  v_code text;
  v_expires timestamptz := pg_catalog.now() + interval '10 minutes';
  v_student_name text;
  v_school_name text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' or coalesce(p_relation, '') not in ('SELF', 'GUARDIAN') then
    return jsonb_build_object('ok', false, 'error', 'resposta_invalida');
  end if;

  -- A trava do link serializa pedidos simultâneos: o limite não é furado.
  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if found and v_link.blocked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'link_bloqueado');
  end if;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error', 'link_expirado');
  end if;
  if p_relation = 'SELF' and private.lesson_recording_requires_guardian(v_link.student_id) then
    return jsonb_build_object('ok', false, 'error', 'responsavel_obrigatorio');
  end if;

  v_destination := case p_relation when 'SELF' then v_link.student_phone else v_link.guardian_phone end;
  if v_destination is null then
    return jsonb_build_object('ok', false, 'error', 'telefone_nao_cadastrado');
  end if;

  -- "Entregue" = pode ter chegado (SENT, AMBIGUOUS e ISSUED sem resultado);
  -- NOT_SENT não saiu e não conta.
  select count(*) filter (where challenge.delivery_status <> 'NOT_SENT'
           and challenge.created_at > pg_catalog.now() - interval '1 hour'),
         count(*) filter (where challenge.created_at > pg_catalog.now() - interval '1 hour'),
         count(*) filter (where challenge.delivery_status <> 'NOT_SENT'
           and challenge.created_at > pg_catalog.now() - interval '24 hours'),
         count(*) filter (where challenge.delivery_status <> 'NOT_SENT'),
         min(challenge.created_at) filter (where challenge.delivery_status <> 'NOT_SENT'
           and challenge.created_at > pg_catalog.now() - interval '1 hour'),
         min(challenge.created_at) filter (where challenge.created_at > pg_catalog.now() - interval '1 hour'),
         min(challenge.created_at) filter (where challenge.delivery_status <> 'NOT_SENT'
           and challenge.created_at > pg_catalog.now() - interval '24 hours')
    into v_delivered_hour, v_issued_hour, v_delivered_day, v_delivered_total,
         v_oldest_delivered_hour, v_oldest_issued_hour, v_oldest_delivered_day
  from private.lesson_recording_consent_challenges as challenge
  where challenge.link_id = v_link.id;

  if v_delivered_total >= (v_limits ->> 'sends_per_link')::integer then
    perform private.lesson_recording_block_link(v_link.id, 'CODE_SENDS');
    return jsonb_build_object('ok', false, 'error', 'link_bloqueado');
  end if;
  if v_delivered_day >= (v_limits ->> 'sends_per_day')::integer then
    return jsonb_build_object(
      'ok', false,
      'error', 'limite_diario',
      'retry_after_seconds', greatest(60, ceil(extract(epoch from (
        v_oldest_delivered_day + interval '24 hours' - pg_catalog.now()
      )))::integer)
    );
  end if;
  if v_delivered_hour >= (v_limits ->> 'sends_per_hour')::integer
     or v_issued_hour >= (v_limits ->> 'requests_per_hour')::integer then
    return jsonb_build_object(
      'ok', false,
      'error', 'limite_de_envios',
      'retry_after_seconds', greatest(60, ceil(extract(epoch from (
        (case when v_delivered_hour >= (v_limits ->> 'sends_per_hour')::integer
          then v_oldest_delivered_hour else v_oldest_issued_hour end)
          + interval '1 hour' - pg_catalog.now()
      )))::integer)
    );
  end if;

  -- O código anterior só cai quando este sair de fato (settle): um reenvio
  -- barrado pelo teto do WhatsApp não mata o código que a família já tem.
  v_code := lpad(((('x' || encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint) % 1000000)::text, 6, '0');
  insert into private.lesson_recording_consent_challenges (
    id, link_id, tenant_id, student_id, relation, destination, code_hash, expires_at
  ) values (
    v_id, v_link.id, v_link.tenant_id, v_link.student_id, p_relation, v_destination,
    encode(extensions.digest(v_id::text || ':' || v_code, 'sha256'), 'hex'), v_expires
  );

  select split_part(btrim(student.full_name), ' ', 1) into v_student_name
  from public.profiles as student where student.id = v_link.student_id;
  select tenant.name into v_school_name from public.tenants as tenant where tenant.id = v_link.tenant_id;

  return jsonb_build_object(
    'ok', true,
    'challenge_id', v_id,
    'code', v_code,
    'destination', v_destination,
    'destination_masked', private.lesson_recording_mask_phone(v_destination),
    'relation', p_relation,
    'tenant_id', v_link.tenant_id,
    'school_name', v_school_name,
    'student_first_name', v_student_name,
    'expires_at', v_expires
  );
end;
$$;

-- Resultado do envio. NOT_SENT (nada saiu) não conta no limite e invalida
-- este código; SENT/AMBIGUOUS (pode ter chegado) conta e derruba os códigos
-- ANTERIORES deste link. Só os anteriores: dois pedidos ao mesmo tempo (duas
-- abas, um retry depois de timeout) terminando fora de ordem não podem matar
-- o mais novo — antes, cada um derrubava o outro e a família ficava com dois
-- códigos inúteis. Enquanto ISSUED, o código não decide nada.
create or replace function public.settle_lesson_recording_consent_code(
  p_challenge_id uuid,
  p_status text,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link uuid;
  v_seq bigint;
  v_invalidated timestamptz;
begin
  if coalesce(p_status, '') not in ('SENT', 'AMBIGUOUS', 'NOT_SENT') then
    return jsonb_build_object('ok', false, 'error', 'resposta_invalida');
  end if;
  update private.lesson_recording_consent_challenges
     set delivery_status = p_status,
         provider_message_id = left(nullif(btrim(coalesce(p_provider_message_id, '')), ''), 320),
         invalidated_at = case when p_status = 'NOT_SENT'
           then coalesce(invalidated_at, pg_catalog.now()) else invalidated_at end
   where id = p_challenge_id and delivery_status = 'ISSUED'
  returning link_id, seq, invalidated_at into v_link, v_seq, v_invalidated;
  if v_link is null then
    return jsonb_build_object('ok', false);
  end if;
  -- Código já derrubado por um mais novo não derruba ninguém.
  if p_status <> 'NOT_SENT' and v_invalidated is null then
    update private.lesson_recording_consent_challenges
       set invalidated_at = pg_catalog.now()
     where link_id = v_link and seq < v_seq
       and consumed_at is null and invalidated_at is null;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- A versão sem código deixa de existir: senão a rota antiga continuaria
-- aceitando decisão só com nome digitado.
drop function if exists public.decide_lesson_recording_consent_public(text, text, text, boolean);

create or replace function public.decide_lesson_recording_consent_public(
  p_token text,
  p_signer_name text,
  p_relation text,
  p_accept boolean,
  p_code text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_limits jsonb := private.lesson_recording_code_limits();
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_challenge private.lesson_recording_consent_challenges;
  v_name text := btrim(regexp_replace(coalesce(p_signer_name, ''), '\s+', ' ', 'g'));
  v_code text := btrim(coalesce(p_code, ''));
  v_decision text;
  v_masked text;
  v_wrong_total integer;
begin
  if p_accept is null or coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  if coalesce(p_relation, '') not in ('SELF', 'GUARDIAN') then
    raise exception 'relacao_invalida' using errcode = '22023';
  end if;
  if length(v_name) < 5 or length(v_name) > 120 or v_name !~ '^\S+( \S+)+$' then
    raise exception 'nome_completo_obrigatorio' using errcode = '22023';
  end if;

  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if found and v_link.blocked_at is not null then
    raise exception 'link_bloqueado' using errcode = '22023';
  end if;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    raise exception 'link_expirado' using errcode = '22023';
  end if;
  if p_relation = 'SELF' and private.lesson_recording_requires_guardian(v_link.student_id) then
    raise exception 'responsavel_obrigatorio' using errcode = '22023';
  end if;

  -- Daqui em diante os erros do código voltam como resposta, não exceção:
  -- a tentativa errada precisa ficar gravada.
  if v_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;

  select * into v_challenge
  from private.lesson_recording_consent_challenges as challenge
  where challenge.link_id = v_link.id
    and challenge.relation = p_relation
    and challenge.consumed_at is null
    and challenge.invalidated_at is null
    and challenge.delivery_status in ('SENT', 'AMBIGUOUS')
  order by challenge.seq desc
  limit 1
  for update;
  if not found or v_challenge.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error', 'codigo_expirado');
  end if;
  if v_challenge.attempts >= (v_limits ->> 'wrong_attempts_per_code')::integer then
    return jsonb_build_object('ok', false, 'error', 'codigo_bloqueado', 'attempts_left', 0);
  end if;

  if encode(extensions.digest(v_challenge.id::text || ':' || v_code, 'sha256'), 'hex') <> v_challenge.code_hash then
    update private.lesson_recording_consent_challenges
       set attempts = attempts + 1,
           invalidated_at = case when attempts + 1 >= (v_limits ->> 'wrong_attempts_per_code')::integer
             then pg_catalog.now() else invalidated_at end
     where id = v_challenge.id;
    -- Tentativas erradas somando todos os códigos do link: passou do teto,
    -- quem está chutando não tem o WhatsApp da família; o link fecha.
    select coalesce(sum(challenge.attempts), 0) into v_wrong_total
    from private.lesson_recording_consent_challenges as challenge
    where challenge.link_id = v_link.id;
    if v_wrong_total >= (v_limits ->> 'wrong_attempts_per_link')::integer then
      perform private.lesson_recording_block_link(v_link.id, 'CODE_ATTEMPTS');
      return jsonb_build_object('ok', false, 'error', 'link_bloqueado', 'attempts_left', 0);
    end if;
    return jsonb_build_object(
      'ok', false,
      'error', case when v_challenge.attempts + 1 >= (v_limits ->> 'wrong_attempts_per_code')::integer
        then 'codigo_bloqueado' else 'codigo_incorreto' end,
      'attempts_left', greatest(0, (v_limits ->> 'wrong_attempts_per_code')::integer - (v_challenge.attempts + 1))
    );
  end if;

  update private.lesson_recording_consent_challenges
     set consumed_at = pg_catalog.now()
   where id = v_challenge.id;

  v_term := private.lesson_recording_current_term('STUDENT');
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  v_masked := private.lesson_recording_mask_phone(v_challenge.destination);
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, link_id, signer_ip, signer_user_agent,
    verification, verified_phone, verification_challenge_id
  ) values (
    v_link.tenant_id, v_link.student_id, 'STUDENT', v_decision, v_name, p_relation,
    'STUDENT', v_term.version, 'LINK', v_link.id,
    private.lesson_recording_request_header('x-forwarded-for', 64),
    private.lesson_recording_request_header('user-agent', 300),
    'WHATSAPP_CODE', v_masked, v_challenge.id
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'verified_phone', v_masked);
end;
$$;

-- Painel da escola: o telefone do link agora é o que recebe o código; o
-- motivo do responsável e se o aceite vale de fato aparecem ao lado.
create or replace function public.list_lesson_recording_consents()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_tenant is null or not private.can_manage_lesson_quality(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'ok', true,
    'google_connected', exists (
      select 1 from private.google_workspace_connections as connection
      where connection.tenant_id = v_tenant and connection.status = 'CONNECTED'
    ),
    'students', coalesce((
      select jsonb_agg(row_data order by row_data ->> 'name')
      from (
        select jsonb_build_object(
          'student_id', student.id,
          'name', btrim(student.full_name),
          'requires_guardian', reason.value is not null,
          'guardian_reason', reason.value,
          'school_birth_date', private.lesson_recording_school_birth_date(student.id),
          'guardian_name', nullif(btrim(coalesce(student.guardian_name, '')), ''),
          'contact_phone', case when reason.value is not null
            then guardian_phone.value
            else private.lesson_recording_student_phone(student.id) end,
          'decision', coalesce(last_decision.decision, 'NONE'),
          'effective', private.lesson_recording_student_consent_effective(student.id),
          'decided_at', last_decision.decided_at,
          'signer_name', last_decision.signer_name,
          'signer_relation', last_decision.signer_relation,
          'verification', last_decision.verification,
          'verified_phone', last_decision.verified_phone,
          'link_expires_at', live_link.expires_at,
          'link_code_phone_masked', private.lesson_recording_mask_phone(
            case when reason.value is not null then live_link.guardian_phone else live_link.student_phone end
          ),
          -- Tem telefone/vínculo de responsável no cadastro, mas nenhum
          -- atestado pela escola: o código não sai até a escola confirmar.
          'guardian_phone_unconfirmed', reason.value is not null
            and private.lesson_recording_guardian_phone_unconfirmed(student.id),
          -- Responsável com o mesmo número do aluno: vale (a escola atestou),
          -- mas o painel pede para conferir.
          'guardian_phone_same_as_student', reason.value is not null
            and (private.lesson_recording_same_phone(guardian_phone.value, student.phone)
              or private.lesson_recording_same_phone(guardian_phone.value, student.attendance_phone)),
          -- Último link bloqueado por excesso de códigos ou de tentativas.
          'link_blocked_reason', case when live_link.expires_at is null then last_link.blocked_reason end,
          'link_blocked_at', case when live_link.expires_at is null then last_link.blocked_at end
        ) as row_data
        from public.profiles as student
        cross join lateral (select private.lesson_recording_guardian_reason(student.id) as value) as reason
        cross join lateral (select private.lesson_recording_guardian_phone(student.id) as value) as guardian_phone
        left join lateral (
          select link.blocked_reason, link.blocked_at
          from private.lesson_recording_consent_links as link
          where link.student_id = student.id
          order by link.created_at desc limit 1
        ) as last_link on true
        left join lateral (
          select consent.decision, consent.decided_at, consent.signer_name, consent.signer_relation,
                 consent.verification, consent.verified_phone
          from private.lesson_recording_consents as consent
          where consent.subject_id = student.id
          order by consent.seq desc limit 1
        ) as last_decision on true
        left join lateral (
          select link.expires_at, link.student_phone, link.guardian_phone
          from private.lesson_recording_consent_links as link
          where link.student_id = student.id and link.revoked_at is null
            and link.expires_at > pg_catalog.now()
          order by link.created_at desc limit 1
        ) as live_link on true
        where student.tenant_id = v_tenant and student.role = 'STUDENT'
          and exists (
            select 1 from public.lesson_sessions as session
            where session.tenant_id = v_tenant and session.student_id = student.id
              and session.status <> 'SUPERSEDED'
              and session.class_date between v_today - 30 and v_today + 30
          )
      ) as rows
    ), '[]'::jsonb),
    'teachers', coalesce((
      select jsonb_agg(row_data order by row_data ->> 'name')
      from (
        select jsonb_build_object(
          'teacher_id', teacher.id,
          'name', btrim(teacher.full_name),
          'decision', coalesce(last_decision.decision, 'NONE'),
          'decided_at', last_decision.decided_at
        ) as row_data
        from public.profiles as teacher
        left join lateral (
          select consent.decision, consent.decided_at
          from private.lesson_recording_consents as consent
          where consent.subject_id = teacher.id
          order by consent.seq desc limit 1
        ) as last_decision on true
        where teacher.tenant_id = v_tenant and teacher.role = 'TEACHER'
          and exists (
            select 1 from public.lesson_sessions as session
            where session.tenant_id = v_tenant and session.teacher_id = teacher.id
              and session.status <> 'SUPERSEDED'
              and session.class_date between v_today - 30 and v_today + 30
          )
      ) as rows
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Donos e permissões
-- ---------------------------------------------------------------------------

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_school_birth_date(uuid)',
    'private.lesson_recording_guardian_reason(uuid)',
    'private.lesson_recording_requires_guardian(uuid)',
    'private.lesson_recording_normalize_phone(text)',
    'private.lesson_recording_mask_phone(text)',
    'private.lesson_recording_student_phone(uuid)',
    'private.lesson_recording_guardian_phone(uuid)',
    'private.lesson_recording_trusted_editor(uuid,text)',
    'private.lesson_recording_profile_value_attested(uuid,text,text)',
    'private.lesson_recording_guardian_phone_unconfirmed(uuid)',
    'private.lesson_recording_same_phone(text,text)',
    'private.lesson_recording_freeze_link_phones()',
    'private.lesson_recording_public_link_fields(uuid)',
    'private.lesson_recording_code_limits()',
    'private.lesson_recording_block_link(uuid,text)',
    'private.lesson_recording_student_consent_effective(uuid)',
    'private.lesson_recording_active(uuid,uuid)',
    'public.set_student_birth_date(uuid,date,text)',
    'public.get_student_birth_date_record(uuid)',
    'public.create_lesson_recording_consent_link(uuid)',
    'public.get_lesson_recording_consent_public(text)',
    'public.issue_lesson_recording_consent_code(text,text)',
    'public.settle_lesson_recording_consent_code(uuid,text,text)',
    'public.decide_lesson_recording_consent_public(text,text,text,boolean,text)',
    'public.list_lesson_recording_consents()',
    'public.update_student_pedagogical_profile(uuid,jsonb)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
end
$owners$;

-- Rotas do link público (token de 64 hex, 30 dias). A decisão exige o código.
grant execute on function public.get_lesson_recording_consent_public(text) to anon, authenticated;
grant execute on function public.decide_lesson_recording_consent_public(text,text,text,boolean,text) to anon, authenticated;
-- Código: só a edge function (service_role).
revoke all on function public.issue_lesson_recording_consent_code(text,text) from service_role;
revoke all on function public.settle_lesson_recording_consent_code(uuid,text,text) from service_role;
grant execute on function public.issue_lesson_recording_consent_code(text,text) to service_role;
grant execute on function public.settle_lesson_recording_consent_code(uuid,text,text) to service_role;
-- Escola (a checagem de papel e escola é interna).
grant execute on function public.create_lesson_recording_consent_link(uuid) to authenticated;
grant execute on function public.list_lesson_recording_consents() to authenticated;
grant execute on function public.set_student_birth_date(uuid,date,text) to authenticated;
grant execute on function public.get_student_birth_date_record(uuid) to authenticated;
-- Professor, coordenação e direção (a RPC decide o que cada um altera).
grant execute on function public.update_student_pedagogical_profile(uuid,jsonb) to authenticated;
