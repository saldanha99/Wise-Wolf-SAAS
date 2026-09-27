-- Versão do texto do contrato gravada no aceite (27/09/2026).
--
-- Decisão da direção: as aulas da escola são registradas (transcrição e
-- anotações automáticas do Google Meet, resumo pedagógico com IA revisado pelo
-- professor, relatório de presença) por decisão da escola, e os NOVOS contratos
-- de aluno e de professor trazem a cláusula que diz isso — quem assina já
-- concorda.
--
-- O texto dos contratos é montado na tela (components/ContractDocument.tsx e
-- components/TeacherContractDocument.tsx). Sem versão, colocar a cláusula
-- mudaria também o contrato de quem JÁ assinou. Daqui em diante cada aceite
-- grava a versão que a pessoa leu, e a tela mostra essa versão
-- (lib/contractTerms.ts):
--   * contrato ainda não assinado → versão atual;
--   * assinado com versão gravada → a gravada;
--   * assinado sem versão gravada (todos os de antes desta migration) → versão
--     1, o texto de antes. Nenhum contrato antigo ganha cláusula.
--
-- Portas que gravam a versão:
--   * aluno: record_enrollment_contract_terms(oferta, versão), chamada pela
--     página de matrícula logo depois de begin_enrollment_offer e ANTES da
--     cobrança (a cadeia de begin_enrollment_offer não foi tocada);
--   * professor por convite: a edge register-teacher grava aqui e em
--     tenant_contract_records.commercial_snapshot.contractTermsVersion (junto
--     do PDF assinado, que já é a cópia fiel);
--   * professor que regulariza o aceite: accept_teacher_contract(assinatura,
--     versão). Ela nunca funcionou em produção: com search_path = public o
--     digest (pgcrypto mora em "extensions") não resolvia, e todo aceite morria
--     com "function digest(text, unknown) does not exist". Aqui ela é refeita
--     com search_path vazio e extensions.digest.
--
-- ⚠️ Esta migration NÃO muda a regra de autorização do registro das aulas. Ela
-- só guarda a base (private.contract_lesson_recording_accepted_at) para quando
-- a direção decidir usá-la — isso é outra frente.
--
-- Re-executável: create ... if not exists, on conflict, create or replace,
-- drop ... if exists. Sem begin/commit.

-- ---------------------------------------------------------------------------
-- 1. Versões conhecidas de cada contrato
-- ---------------------------------------------------------------------------
create table if not exists public.contract_terms_versions (
  contract_kind text not null
    check (contract_kind in ('STUDENT', 'TEACHER')),
  version integer not null check (version >= 1),
  includes_lesson_recording boolean not null,
  description text not null
    check (char_length(btrim(description)) between 3 and 300),
  primary key (contract_kind, version)
);

-- Dono postgres: as funções SECURITY DEFINER abaixo (donas postgres) leem e
-- gravam aqui; a migration roda como supabase_admin.
alter table public.contract_terms_versions owner to postgres;
alter table public.contract_terms_versions enable row level security;
revoke all on table public.contract_terms_versions
  from public, anon, authenticated;
grant select on table public.contract_terms_versions to service_role;

comment on table public.contract_terms_versions is
  'Versões do texto dos contratos (lib/contractTerms.ts). Versão nova de texto = linha nova aqui, número novo na tela e na edge register-teacher.';

-- Dado de referência, igual em todo release: a descrição pode ser corrigida,
-- mas a versão de um texto já assinado nunca muda de sentido.
insert into public.contract_terms_versions (
  contract_kind, version, includes_lesson_recording, description
)
values
  ('STUDENT', 1, false,
   'Contrato de prestação de serviços educacionais anterior a 27/09/2026 (Cláusulas 1 a 8, sem o registro das aulas).'),
  ('STUDENT', 2, true,
   'Inclui a Cláusula 8 — Do Registro das Aulas; o Foro passa a ser a Cláusula 9.'),
  ('TEACHER', 1, false,
   'Contrato de professor autônomo anterior a 27/09/2026 (Cláusulas 1ª a 10ª, sem o registro das aulas).'),
  ('TEACHER', 2, true,
   'Inclui a Cláusula 11ª – Registro das Aulas.')
on conflict (contract_kind, version) do update
  set includes_lesson_recording = excluded.includes_lesson_recording,
      description = excluded.description;

-- ---------------------------------------------------------------------------
-- 2. Aceites com a versão lida
-- ---------------------------------------------------------------------------
create table if not exists public.contract_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  contract_kind text not null,
  terms_version integer not null,
  source text not null check (
    source in ('ENROLLMENT_OFFER', 'TEACHER_INVITE', 'TEACHER_CONTRACT_ACCEPT')
  ),
  source_id uuid,
  accepted_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint contract_terms_acceptances_version_fk
    foreign key (contract_kind, terms_version)
    references public.contract_terms_versions (contract_kind, version),
  constraint contract_terms_acceptances_source_shape check (
    (source = 'ENROLLMENT_OFFER' and contract_kind = 'STUDENT' and source_id is not null)
    or (source = 'TEACHER_INVITE' and contract_kind = 'TEACHER' and source_id is not null)
    or (source = 'TEACHER_CONTRACT_ACCEPT' and contract_kind = 'TEACHER' and source_id is null)
  ),
  -- Um registro por aceite: a matrícula de uma oferta, o convite, a
  -- regularização do professor. Repetir a chamada não cria outro.
  constraint contract_terms_acceptances_one_per_source
    unique nulls not distinct (user_id, contract_kind, source, source_id)
);

create index if not exists contract_terms_acceptances_user_kind_idx
  on public.contract_terms_acceptances (user_id, contract_kind, accepted_at desc);

alter table public.contract_terms_acceptances owner to postgres;
alter table public.contract_terms_acceptances enable row level security;
revoke all on table public.contract_terms_acceptances
  from public, anon, authenticated;
-- A edge register-teacher grava pelo service_role; o resto passa pelas
-- funções abaixo. UPDATE é recusado pelo gatilho (é prova do aceite).
grant select, insert, delete on table public.contract_terms_acceptances
  to service_role;

comment on table public.contract_terms_acceptances is
  'Versão do texto do contrato que cada pessoa aceitou (lib/contractTerms.ts). Sem linha = contrato de antes da versão gravada no aceite (versão 1). Imutável.';

create or replace function private.contract_terms_acceptance_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'contract_terms_acceptance_is_immutable'
    using errcode = '42501',
          hint = 'O aceite é prova do texto assinado; um aceite novo é uma linha nova.';
end;
$function$;

alter function private.contract_terms_acceptance_is_immutable() owner to postgres;
revoke all on function private.contract_terms_acceptance_is_immutable()
  from public, anon, authenticated;

drop trigger if exists trg_contract_terms_acceptance_immutable
  on public.contract_terms_acceptances;
create trigger trg_contract_terms_acceptance_immutable
  before update on public.contract_terms_acceptances
  for each row execute function private.contract_terms_acceptance_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. Leitura: versão do contrato de uma pessoa
-- ---------------------------------------------------------------------------
-- O aceite mais recente da pessoa naquela escola. Nulo = nada gravado (texto
-- de antes). Interna: quem chama já decidiu que pode ver.
create or replace function private.contract_terms_version_for(
  p_user uuid,
  p_contract_kind text,
  p_tenant text
)
returns integer
language sql
stable
set search_path = ''
as $function$
  select acceptance.terms_version
    from public.contract_terms_acceptances as acceptance
   where acceptance.user_id = p_user
     and acceptance.contract_kind = p_contract_kind
     and acceptance.tenant_id = p_tenant
   order by acceptance.accepted_at desc, acceptance.recorded_at desc
   limit 1;
$function$;

alter function private.contract_terms_version_for(uuid, text, text) owner to postgres;
revoke all on function private.contract_terms_version_for(uuid, text, text)
  from public, anon, authenticated;

-- Base para a autorização futura (NÃO usada por regra nenhuma ainda): quando a
-- pessoa aceitou, pela última vez, um contrato cujo texto traz a cláusula do
-- registro das aulas. Nulo = nunca aceitou.
create or replace function private.contract_lesson_recording_accepted_at(
  p_user uuid,
  p_contract_kind text,
  p_tenant text
)
returns timestamptz
language sql
stable
set search_path = ''
as $function$
  select max(acceptance.accepted_at)
    from public.contract_terms_acceptances as acceptance
    join public.contract_terms_versions as version
      on version.contract_kind = acceptance.contract_kind
     and version.version = acceptance.terms_version
   where acceptance.user_id = p_user
     and acceptance.contract_kind = p_contract_kind
     and acceptance.tenant_id = p_tenant
     and version.includes_lesson_recording;
$function$;

alter function private.contract_lesson_recording_accepted_at(uuid, text, text) owner to postgres;
revoke all on function private.contract_lesson_recording_accepted_at(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.contract_lesson_recording_accepted_at(uuid, text, text)
  to service_role;

-- Tela: a própria pessoa, ou direção/coordenação da escola dela (SUPER_ADMIN
-- em qualquer escola). Para quem não pode ver, nulo — e a tela mostra o texto
-- de antes, nunca uma cláusula que não foi assinada.
create or replace function public.get_contract_terms_version(
  p_user_id uuid,
  p_contract_kind text
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_caller uuid := (select auth.uid());
  v_role text;
  v_target_tenant text;
begin
  if v_caller is null
     or p_user_id is null
     or coalesce(p_contract_kind, '') not in ('STUDENT', 'TEACHER') then
    return null;
  end if;

  select profile.tenant_id
    into v_target_tenant
    from public.profiles as profile
   where profile.id = p_user_id;
  if v_target_tenant is null then
    return null;
  end if;

  if v_caller is distinct from p_user_id then
    v_role := coalesce(public._my_role(), '');
    if not (
      v_role = 'SUPER_ADMIN'
      or (
        v_role in ('SCHOOL_ADMIN', 'COORDINATOR')
        and public._my_tenant_id() is not distinct from v_target_tenant
      )
    ) then
      return null;
    end if;
  end if;

  return private.contract_terms_version_for(
    p_user_id, p_contract_kind, v_target_tenant
  );
end;
$function$;

alter function public.get_contract_terms_version(uuid, text) owner to postgres;
revoke all on function public.get_contract_terms_version(uuid, text)
  from public, anon;
grant execute on function public.get_contract_terms_version(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Aluno: a página de matrícula grava a versão logo depois do aceite
-- ---------------------------------------------------------------------------
-- begin_enrollment_offer grava o aceite (perfil + processing_by da oferta);
-- esta porta, chamada em seguida e antes da cobrança, grava a versão do texto
-- que a página mostrou. Só quem está com a oferta em andamento grava, e só uma
-- vez por oferta (a primeira resposta vale). Matrícula que já terminou sem
-- versão gravada terminou com o texto de antes: não se grava depois.
create or replace function public.record_enrollment_contract_terms(
  p_offer_id uuid,
  p_terms_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_offer record;
  v_profile record;
  v_version integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'nao_autenticado');
  end if;
  if p_offer_id is null
     or p_terms_version is null
     or not exists (
       select 1
         from public.contract_terms_versions as version
        where version.contract_kind = 'STUDENT'
          and version.version = p_terms_version
     ) then
    return jsonb_build_object('ok', false, 'error', 'versao_invalida');
  end if;

  select offer.id, offer.tenant_id, offer.kind, offer.processing_by,
         offer.processing_state, offer.consumed_at
    into v_offer
    from public.offers as offer
   where offer.id = p_offer_id;
  if not found or v_offer.kind is distinct from 'ENROLLMENT' then
    return jsonb_build_object('ok', false, 'error', 'oferta_invalida');
  end if;
  if v_offer.processing_by is distinct from v_user then
    return jsonb_build_object('ok', false, 'error', 'oferta_de_outra_pessoa');
  end if;

  -- Repetição da mesma chamada: devolve o que já foi gravado.
  select acceptance.terms_version
    into v_version
    from public.contract_terms_acceptances as acceptance
   where acceptance.user_id = v_user
     and acceptance.contract_kind = 'STUDENT'
     and acceptance.source = 'ENROLLMENT_OFFER'
     and acceptance.source_id = v_offer.id;
  if found then
    return jsonb_build_object('ok', true, 'terms_version', v_version, 'already', true);
  end if;

  if v_offer.consumed_at is not null
     or coalesce(v_offer.processing_state, '') = 'COMPLETED' then
    return jsonb_build_object('ok', false, 'error', 'matricula_concluida');
  end if;

  select profile.role, profile.tenant_id, profile.contract_accepted
    into v_profile
    from public.profiles as profile
   where profile.id = v_user;
  if not found
     or v_profile.role is distinct from 'STUDENT'
     or v_profile.tenant_id is distinct from v_offer.tenant_id
     or coalesce(v_profile.contract_accepted, false) is false then
    return jsonb_build_object('ok', false, 'error', 'aceite_nao_encontrado');
  end if;

  insert into public.contract_terms_acceptances (
    tenant_id, user_id, contract_kind, terms_version, source, source_id,
    accepted_at
  )
  values (
    v_offer.tenant_id, v_user, 'STUDENT', p_terms_version, 'ENROLLMENT_OFFER',
    v_offer.id, now()
  )
  on conflict on constraint contract_terms_acceptances_one_per_source
  do nothing
  returning terms_version into v_version;

  if v_version is null then
    -- Corrida com outra aba: vale o que entrou primeiro.
    select acceptance.terms_version
      into v_version
      from public.contract_terms_acceptances as acceptance
     where acceptance.user_id = v_user
       and acceptance.contract_kind = 'STUDENT'
       and acceptance.source = 'ENROLLMENT_OFFER'
       and acceptance.source_id = v_offer.id;
    return jsonb_build_object('ok', true, 'terms_version', v_version, 'already', true);
  end if;

  return jsonb_build_object('ok', true, 'terms_version', v_version, 'already', false);
end;
$function$;

alter function public.record_enrollment_contract_terms(uuid, integer) owner to postgres;
revoke all on function public.record_enrollment_contract_terms(uuid, integer)
  from public, anon;
grant execute on function public.record_enrollment_contract_terms(uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Professor que regulariza o aceite pelo app
-- ---------------------------------------------------------------------------
-- Mesma regra da versão de 11/07 (20260711120000), com a versão lida.
-- A assinatura de 1 argumento sai: com as duas no ar, a chamada do app antigo
-- ({p_typed_signature}) casaria com as duas e o PostgREST recusaria por
-- ambiguidade. Sem p_terms_version (app antigo, que mostrava o texto de antes)
-- o aceite é gravado como versão 1.
drop function if exists public.accept_teacher_contract(text);

create or replace function public.accept_teacher_contract(
  p_typed_signature text,
  p_terms_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_tenant text;
  v_accepted boolean;
  v_ip text;
  v_sig text := btrim(coalesce(p_typed_signature, ''));
  v_version integer := coalesce(p_terms_version, 1);
  v_now timestamptz := now();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'nao_autenticado');
  end if;

  select profile.role, profile.tenant_id, profile.contract_accepted
    into v_role, v_tenant, v_accepted
    from public.profiles as profile
   where profile.id = v_uid;

  if v_role is distinct from 'TEACHER' then
    return jsonb_build_object('ok', false, 'error', 'apenas_professor');
  end if;

  if coalesce(v_accepted, false) = true then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if length(v_sig) < 3 then
    return jsonb_build_object('ok', false, 'error', 'assinatura_invalida');
  end if;

  if not exists (
    select 1
      from public.contract_terms_versions as version
     where version.contract_kind = 'TEACHER'
       and version.version = v_version
  ) then
    return jsonb_build_object('ok', false, 'error', 'versao_invalida');
  end if;

  -- IP real do cliente via headers propagados pelo PostgREST (x-forwarded-for
  -- cai no primeiro IP).
  begin
    v_ip := split_part(coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for',
      nullif(current_setting('request.headers', true), '')::json ->> 'x-real-ip',
      ''), ',', 1);
  exception when others then
    v_ip := null;
  end;

  update public.profiles
     set contract_accepted = true,
         accepted_at = v_now,
         typed_signature = v_sig,
         signature_ip = nullif(v_ip, ''),
         signature_hash = encode(
           extensions.digest(v_uid::text || '|' || v_sig || '|' || v_now::text, 'sha256'),
           'hex'
         )
   where id = v_uid;

  if v_tenant is not null then
    insert into public.contract_terms_acceptances (
      tenant_id, user_id, contract_kind, terms_version, source, source_id,
      accepted_at
    )
    values (
      v_tenant, v_uid, 'TEACHER', v_version, 'TEACHER_CONTRACT_ACCEPT', null,
      v_now
    )
    on conflict on constraint contract_terms_acceptances_one_per_source
    do nothing;
  end if;

  return jsonb_build_object('ok', true, 'accepted_at', v_now, 'terms_version', v_version);
end;
$function$;

alter function public.accept_teacher_contract(text, integer) owner to postgres;
revoke all on function public.accept_teacher_contract(text, integer)
  from public, anon;
grant execute on function public.accept_teacher_contract(text, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Auditoria de matrículas (tela Contratos da direção)
-- ---------------------------------------------------------------------------
-- Mesma definição de 20260903180000, com a versão do texto no fim da lista
-- (create or replace view só acrescenta coluna no fim).
create or replace view public.vw_student_contracts
with (security_invoker = false, security_barrier = true) as
select
    p.id as user_id,
    p.full_name as student_name,
    p.cpf as student_cpf,
    p.email as student_email,
    p.phone as student_phone,
    p.postal_code as student_postal_code,
    p.address as student_address,
    p.address_number as student_address_number,
    coalesce(
        nullif(p.monthly_fee, 0),
        (
          select sp.value
          from public.student_payments sp
          where sp.student_id = p.id
            and sp.status != 'CANCELLED'
          order by sp.due_date desc
          limit 1
        ),
        0
    ) as plan_value,
    p.due_day,
    p.class_frequency,
    p.contract_accepted,
    p.accepted_at,
    p.signature_ip,
    p.typed_signature,
    p.signature_hash,
    p.student_signature_url,
    p.signed_document_url,
    p.wise_wolf_signature_token,
    p.documentation_status,
    p.audit_status,
    p.rejection_reason,
    p.tenant_id,
    -- Subconsulta direta (e não a função private): numa view sem
    -- security_invoker a tabela é lida com o dono da view, mas função chamada
    -- nela roda com quem consulta — e authenticated não lê a tabela de aceites.
    -- Mesma ordem de private.contract_terms_version_for.
    (
      select acceptance.terms_version
      from public.contract_terms_acceptances acceptance
      where acceptance.user_id = p.id
        and acceptance.contract_kind = 'STUDENT'
        and acceptance.tenant_id = p.tenant_id
      order by acceptance.accepted_at desc, acceptance.recorded_at desc
      limit 1
    ) as contract_terms_version
from public.profiles p
where p.role = 'STUDENT'
  and (
    (select public._my_role()) = 'SUPER_ADMIN'
    or (
      p.tenant_id = (select public._my_tenant_id())
      and (select public._my_role()) in ('SCHOOL_ADMIN', 'ADMIN')
    )
  );

alter view public.vw_student_contracts owner to postgres;
revoke all on public.vw_student_contracts from anon, public;
grant select on public.vw_student_contracts to authenticated, service_role;
