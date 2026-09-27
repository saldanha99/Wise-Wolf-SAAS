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
--   * contrato ainda não assinado → a versão que a ESCOLA oferece hoje
--     (tenant_contract_terms; sem linha = versão 1);
--   * assinado com versão gravada → a gravada;
--   * assinado sem versão gravada (todos os de antes desta migration) → versão
--     1, o texto de antes. Nenhum contrato antigo ganha cláusula.
--
-- A cláusula é da Wise Wolf, não da plataforma: ela afirma que a CONTRATADA
-- grava as aulas no Google Meet e contrata o OpenRouter. Escola sem essa
-- decisão (outra escola cliente, tenant de professor do Hub) continua
-- oferecendo a versão 1 — tenant_contract_terms diz qual versão cada escola
-- oferece, e só a Wise Wolf nasce com a 2 (one-shot abaixo).
--
-- Portas que gravam a versão (todas conferem a versão que a escola oferece):
--   * aluno: record_enrollment_contract_terms(oferta, versão), chamada pela
--     página de matrícula logo depois de begin_enrollment_offer e ANTES da
--     cobrança (a cadeia de begin_enrollment_offer não foi tocada). Grava
--     também se quem assinou foi o RESPONSÁVEL (link de dependente, lido da
--     oferta no servidor) e a data da assinatura desta matrícula — numa
--     rematrícula o perfil mantém a assinatura antiga, e o contrato novo não
--     pode aparecer com a data dela;
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
-- a direção decidir usá-la — isso é outra frente. A base já segue a regra do
-- termo para menor: aluno de quem a escola exige responsável
-- (private.lesson_recording_guardian_reason — KIDS, MINOR ou AGE_UNKNOWN) só
-- conta com contrato assinado pelo responsável.
--
-- Re-executável: create ... if not exists, on conflict, create or replace,
-- drop ... if exists; dado de escola só por one-shot. Sem begin/commit.

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
-- 2. Versão que cada escola oferece nos contratos novos
-- ---------------------------------------------------------------------------
-- Sem linha = versão 1 (texto sem a cláusula do registro das aulas). É decisão
-- de cada escola: a cláusula diz que a CONTRATADA grava as aulas no Google
-- Meet e contrata o provedor de IA, o que só é verdade onde a escola decidiu
-- isso. Mudar a versão de uma escola é SQL da plataforma (sem tela) e vale só
-- para contratos novos: o que já foi assinado lê a versão gravada no aceite.
create table if not exists public.tenant_contract_terms (
  tenant_id text not null references public.tenants (id) on delete cascade,
  contract_kind text not null,
  terms_version integer not null,
  decided_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 300),
  primary key (tenant_id, contract_kind),
  constraint tenant_contract_terms_version_fk
    foreign key (contract_kind, terms_version)
    references public.contract_terms_versions (contract_kind, version)
);

alter table public.tenant_contract_terms owner to postgres;
alter table public.tenant_contract_terms enable row level security;
revoke all on table public.tenant_contract_terms
  from public, anon, authenticated;
grant select on table public.tenant_contract_terms to service_role;

comment on table public.tenant_contract_terms is
  'Versão do contrato que cada escola oferece aos contratos NOVOS (lib/contractTerms.ts). Sem linha = versão 1, sem a cláusula do registro das aulas.';

-- A Wise Wolf decidiu o registro das aulas em 27/09/2026: contratos novos dela
-- (aluno e professor) saem com a versão 2. One-shot: sem a trava, todo release
-- desfaria uma mudança feita depois (ou recriaria uma linha apagada de
-- propósito). Só marca quando a escola existe — banco sem dados (clone de
-- estrutura) não queima a marca.
do $seed$
begin
  if not exists (
    select 1 from public.schema_one_shots
     where key = 'contrato_registro_das_aulas_wise_wolf_20260927'
  ) and exists (
    select 1 from public.tenants where id = 'school-wise-wolf'
  ) then
    insert into public.tenant_contract_terms (
      tenant_id, contract_kind, terms_version, note
    )
    values
      ('school-wise-wolf', 'STUDENT', 2,
       'Decisão da direção de 27/09/2026: aulas registradas por decisão da escola.'),
      ('school-wise-wolf', 'TEACHER', 2,
       'Decisão da direção de 27/09/2026: aulas registradas por decisão da escola.')
    on conflict (tenant_id, contract_kind) do nothing;

    insert into public.schema_one_shots (key, nota)
    values ('contrato_registro_das_aulas_wise_wolf_20260927',
            'school-wise-wolf oferece a versão 2 (com o registro das aulas) nos contratos novos de aluno e professor');
  end if;
end
$seed$;

-- Interna: a versão que a escola oferece hoje (1 quando não decidiu).
create or replace function private.contract_terms_offered_version(
  p_tenant text,
  p_contract_kind text
)
returns integer
language sql
stable
set search_path = ''
as $function$
  select coalesce(
    (select offer.terms_version
       from public.tenant_contract_terms as offer
      where offer.tenant_id = p_tenant
        and offer.contract_kind = p_contract_kind),
    1
  );
$function$;

alter function private.contract_terms_offered_version(text, text) owner to postgres;
revoke all on function private.contract_terms_offered_version(text, text)
  from public, anon, authenticated;

-- Para as edges (tenant-legal-assets mostra o contrato da oferta pública;
-- register-teacher confere a versão assinada). Só service_role.
create or replace function public.contract_terms_offered_version(
  p_tenant text,
  p_contract_kind text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when coalesce(p_contract_kind, '') in ('STUDENT', 'TEACHER')
      then private.contract_terms_offered_version(p_tenant, p_contract_kind)
  end;
$function$;

alter function public.contract_terms_offered_version(text, text) owner to postgres;
revoke all on function public.contract_terms_offered_version(text, text)
  from public, anon, authenticated;
grant execute on function public.contract_terms_offered_version(text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Aceites com a versão lida
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
  -- Quem assinou foi o responsável do aluno (link de dependente). Derivado da
  -- oferta no servidor, nunca do navegador.
  signed_as_guardian boolean not null default false,
  -- Data da assinatura DESTE contrato (numa rematrícula, não a do perfil).
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
  constraint contract_terms_acceptances_guardian_is_student check (
    not signed_as_guardian or contract_kind = 'STUDENT'
  ),
  -- Um registro por aceite: a matrícula de uma oferta, o convite, a
  -- regularização do professor. Repetir a chamada não cria outro.
  constraint contract_terms_acceptances_one_per_source
    unique nulls not distinct (user_id, contract_kind, source, source_id)
);

-- Banco que viu o rascunho desta migration (só clones de teste): a coluna
-- entra sem mexer no resto.
alter table public.contract_terms_acceptances
  add column if not exists signed_as_guardian boolean not null default false;

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
  'Versão do texto do contrato que cada pessoa aceitou (lib/contractTerms.ts), quando e se o aluno foi representado pelo responsável. Sem linha = contrato de antes da versão gravada no aceite (versão 1). Imutável.';

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
-- 4. Base da autorização futura (NÃO usada por regra nenhuma ainda)
-- ---------------------------------------------------------------------------
-- Quando a pessoa aceitou, pela última vez, um contrato cujo texto traz a
-- cláusula do registro das aulas. Nulo = nunca aceitou. Para aluno de quem a
-- escola exige responsável (a mesma régua do termo:
-- private.lesson_recording_guardian_reason — turma KIDS, menor pela data
-- atestada ou idade não comprovada), só vale o contrato assinado pelo
-- responsável: aceite dado pelo próprio menor não autoriza nada (LGPD, art.
-- 14). A régua é avaliada agora, então o aluno que a escola atesta adulto
-- passa a contar com o próprio aceite.
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
     and version.includes_lesson_recording
     and (
       acceptance.contract_kind <> 'STUDENT'
       or acceptance.signed_as_guardian
       or private.lesson_recording_guardian_reason(p_user) is null
     );
$function$;

alter function private.contract_lesson_recording_accepted_at(uuid, text, text) owner to postgres;
revoke all on function private.contract_lesson_recording_accepted_at(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.contract_lesson_recording_accepted_at(uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Leitura para a tela: o que a pessoa assinou e o que a escola oferece
-- ---------------------------------------------------------------------------
-- Rascunho anterior desta frente (nunca publicado) devolvia só a versão.
drop function if exists public.get_contract_terms_version(uuid, text);
drop function if exists private.contract_terms_version_for(uuid, text, text);

-- A própria pessoa, ou direção/coordenação da escola dela (SUPER_ADMIN em
-- qualquer escola). Para quem não pode ver, nulo — e a tela mostra o texto de
-- antes, nunca uma cláusula que não foi assinada.
--   recorded_version / accepted_at: o aceite mais recente naquela escola
--     (nulos = nada gravado: o texto de antes);
--   offered_version: a versão que a escola oferece hoje (contrato ainda não
--     assinado mostra esta).
create or replace function public.get_contract_terms(
  p_user_id uuid,
  p_contract_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_caller uuid := (select auth.uid());
  v_role text;
  v_target_tenant text;
  v_version integer;
  v_accepted_at timestamptz;
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

  select acceptance.terms_version, acceptance.accepted_at
    into v_version, v_accepted_at
    from public.contract_terms_acceptances as acceptance
   where acceptance.user_id = p_user_id
     and acceptance.contract_kind = p_contract_kind
     and acceptance.tenant_id = v_target_tenant
   order by acceptance.accepted_at desc, acceptance.recorded_at desc
   limit 1;

  return jsonb_build_object(
    'recorded_version', v_version,
    'accepted_at', v_accepted_at,
    'offered_version', private.contract_terms_offered_version(
      v_target_tenant, p_contract_kind
    )
  );
end;
$function$;

alter function public.get_contract_terms(uuid, text) owner to postgres;
revoke all on function public.get_contract_terms(uuid, text)
  from public, anon;
grant execute on function public.get_contract_terms(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Aluno: a página de matrícula grava a versão logo depois do aceite
-- ---------------------------------------------------------------------------
-- begin_enrollment_offer grava o aceite (perfil + processing_by da oferta);
-- esta porta, chamada em seguida e antes da cobrança, grava a versão do texto
-- que a página mostrou. Só quem está com a oferta em andamento grava, só uma
-- vez por oferta (a primeira resposta vale) e só a versão que a escola da
-- oferta oferece (página desatualizada → recarregar; nada foi cobrado ainda).
-- Matrícula que já terminou sem versão gravada terminou com o texto de antes:
-- não se grava depois.
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
  v_guardian boolean;
  v_accepted_at timestamptz;
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
         offer.processing_state, offer.processing_started_at,
         offer.consumed_at, offer.payload
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

  -- A página mostra a versão que a escola oferece (tenant-legal-assets). Outra
  -- versão = página aberta antes de a escola mudar: recarregar e ler de novo.
  if p_terms_version is distinct from private.contract_terms_offered_version(
    v_offer.tenant_id, 'STUDENT'
  ) then
    return jsonb_build_object('ok', false, 'error', 'versao_desatualizada');
  end if;

  select profile.role, profile.tenant_id, profile.contract_accepted,
         profile.accepted_at
    into v_profile
    from public.profiles as profile
   where profile.id = v_user;
  if not found
     or v_profile.role is distinct from 'STUDENT'
     or v_profile.tenant_id is distinct from v_offer.tenant_id
     or coalesce(v_profile.contract_accepted, false) is false then
    return jsonb_build_object('ok', false, 'error', 'aceite_nao_encontrado');
  end if;

  -- Link de dependente: o CONTRATANTE é o responsável (a página exige a
  -- assinatura com o nome dele). Lido da oferta, nunca do navegador.
  v_guardian := jsonb_typeof(v_offer.payload -> 'isDependent') = 'boolean'
    and (v_offer.payload ->> 'isDependent')::boolean;

  -- Data da assinatura desta matrícula. begin_enrollment_offer só grava
  -- profiles.accepted_at na primeira assinatura do perfil (coalesce): assinado
  -- agora (depois do início desta oferta) → a mesma data do perfil, a que o
  -- hash da assinatura usa; rematrícula (perfil com assinatura de antes) →
  -- agora, para o contrato novo não aparecer com a data da assinatura antiga.
  v_accepted_at := case
    when v_profile.accepted_at is not null
     and v_offer.processing_started_at is not null
     and v_profile.accepted_at >= v_offer.processing_started_at
      then v_profile.accepted_at
    else now()
  end;

  insert into public.contract_terms_acceptances (
    tenant_id, user_id, contract_kind, terms_version, source, source_id,
    signed_as_guardian, accepted_at
  )
  values (
    v_offer.tenant_id, v_user, 'STUDENT', p_terms_version, 'ENROLLMENT_OFFER',
    v_offer.id, coalesce(v_guardian, false), v_accepted_at
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
-- 7. Professor que regulariza o aceite pelo app
-- ---------------------------------------------------------------------------
-- Mesma regra da versão de 11/07 (20260711120000), com a versão lida.
-- A assinatura de 1 argumento sai: com as duas no ar, a chamada do app antigo
-- ({p_typed_signature}) casaria com as duas e o PostgREST recusaria por
-- ambiguidade. Sem p_terms_version (app antigo, que mostrava o texto de antes)
-- o aceite é gravado como versão 1. Com a versão, ela tem de ser a que a escola
-- do professor oferece hoje (a tela lê por get_contract_terms).
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
  ) or (
    p_terms_version is not null
    and p_terms_version is distinct from private.contract_terms_offered_version(
      v_tenant, 'TEACHER'
    )
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
-- 8. Auditoria de matrículas (tela Contratos da direção)
-- ---------------------------------------------------------------------------
-- Mesma definição de 20260903180000, com a versão do texto e a data da
-- assinatura dessa versão no fim da lista (create or replace view só
-- acrescenta coluna no fim). A data importa na rematrícula: o perfil guarda a
-- assinatura antiga, e "Data Matrícula" ao lado de "v2" diria que a cláusula
-- foi assinada antes de existir.
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
    -- Junção direta (e não a função private): numa view sem security_invoker
    -- a tabela é lida com o dono da view, mas função chamada nela roda com
    -- quem consulta — e authenticated não lê a tabela de aceites. Mesma ordem
    -- de public.get_contract_terms.
    latest_acceptance.terms_version as contract_terms_version,
    latest_acceptance.accepted_at as contract_terms_accepted_at
from public.profiles p
left join lateral (
    select acceptance.terms_version, acceptance.accepted_at
    from public.contract_terms_acceptances acceptance
    where acceptance.user_id = p.id
      and acceptance.contract_kind = 'STUDENT'
      and acceptance.tenant_id = p.tenant_id
    order by acceptance.accepted_at desc, acceptance.recorded_at desc
    limit 1
) latest_acceptance on true
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
