-- Núcleo do Meet, parte 2: identidade Google do professor, revogação que desliga
-- a sala, troca de conta central com confirmação, transcrição bruta só para quem
-- deu/coordena a aula e marcação manual só pela direção.
--
-- Decisões da direção (26/09/2026) que esta migration implementa:
--   * o professor CONFIRMA a conta Google por login Google (openid + email) antes
--     de ser coanfitrião — o e-mail do cadastro não prova nada. Sem identidade
--     verificada: não há sala (google_teacher_identity_required) e o aceite do
--     termo pelo professor é recusado (teacher_google_identity_required);
--   * revogação desliga a transcrição da sala JÁ criada: sessão com sala
--     (READY/COHOST_PENDING) que perde documentation_consent entra na fila como
--     DISABLE_ARTIFACTS (a edge faz spaces.patch com transcrição e anotações OFF);
--     se o aceite voltar antes da aula, ENABLE_ARTIFACTS religa. A sala com
--     documentação desligada não é mais entregue no app (get_my_lesson_rooms),
--     como já não é no lembrete do WhatsApp (official_lesson_link);
--   * troca de conta central: com salas criadas pela conta atual, o retorno do
--     OAuth recusa outra conta Google (google_organizer_change_requires_confirmation)
--     a menos que a direção tenha pedido a troca (allow_replace no nonce);
--   * transcrição bruta (fontes importadas, rascunhos e planilha de presença) só
--     para o professor da própria aula, a coordenação e a direção da escola. Outros
--     professores do aluno e o SUPER_ADMIN (suporte da plataforma) veem só o
--     resumo aprovado;
--   * marcação manual de documentação (set_lesson_documentation_consent) só pela
--     direção (SCHOOL_ADMIN), com motivo, e sem passar por cima de recusa ou
--     revogação do aluno/responsável ou do professor. Revogação que chega DEPOIS
--     de uma marcação manual também desmarca a sessão (apply_standing).
--
-- Parte das definições de 20260926170000 (google_meet_backend,
-- get_pending_google_meet_sync_sessions, get_my_lesson_rooms) e das definições
-- vivas de 20260926120000 (set_my_lesson_recording_consent,
-- apply_standing_lesson_recording_consent) e 20260912203213
-- (set_lesson_documentation_consent). Não toca nas funções do lado do
-- aluno/responsável (link, decisão pública, lesson_recording_active).
--
-- Re-executável: if not exists, drop/add constraint, create or replace, on
-- conflict. Dono das funções existentes preservado; a única SECURITY DEFINER
-- nova (get_my_google_identity) é do postgres, que é dono da tabela nova.

-- 1. Identidade Google do professor --------------------------------------------
create table if not exists private.teacher_google_identities (
  -- A identidade não sobrevive ao perfil (não bloqueia apagar conta de teste).
  teacher_id uuid primary key references public.profiles(id) on delete cascade,
  tenant_id text not null references public.tenants(id),
  google_sub text not null check (google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  google_email text not null
    check (google_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and google_email = lower(google_email)),
  -- Só guarda conta com e-mail verificado pelo Google (openid userinfo).
  email_verified boolean not null check (email_verified),
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Uma conta Google por professor da escola: dois professores com a mesma conta
-- deixariam a presença (reconhecida pelo e-mail) ambígua.
create unique index if not exists teacher_google_identities_sub_idx
  on private.teacher_google_identities(tenant_id, google_sub);
alter table private.teacher_google_identities owner to postgres;
alter table private.teacher_google_identities enable row level security;
revoke all on private.teacher_google_identities from public, anon, authenticated, service_role;
comment on table private.teacher_google_identities is
  'Conta Google confirmada pelo próprio professor (login Google, openid+email). É ela que entra como coanfitriã e que reconhece o professor no relatório de presença.';

-- 2. Fluxo do OAuth: conta central ou identidade do professor --------------------
alter table private.google_meet_oauth_states add column if not exists flow text not null default 'organizer';
alter table private.google_meet_oauth_states add column if not exists allow_replace boolean not null default false;
alter table private.google_meet_oauth_states drop constraint if exists google_meet_oauth_states_flow_check;
alter table private.google_meet_oauth_states add constraint google_meet_oauth_states_flow_check
  check (flow in ('organizer','teacher_identity'));
alter table private.google_meet_oauth_states drop constraint if exists google_meet_oauth_states_allow_replace_check;
alter table private.google_meet_oauth_states add constraint google_meet_oauth_states_allow_replace_check
  check (flow = 'organizer' or not allow_replace);
comment on column private.google_meet_oauth_states.allow_replace is
  'A direção pediu para TROCAR a conta central: o retorno aceita outra conta Google mesmo com salas criadas pela atual.';

-- 3. Documentação ligada/desligada na sala já criada ------------------------------
alter table private.google_meet_rooms add column if not exists artifacts_state text not null default 'ENABLED';
alter table private.google_meet_rooms add column if not exists artifacts_changed_at timestamptz;
alter table private.google_meet_rooms add column if not exists artifacts_error_code text;
alter table private.google_meet_rooms add column if not exists artifacts_attempts integer not null default 0;
alter table private.google_meet_rooms add column if not exists artifacts_next_attempt_at timestamptz;
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_artifacts_state_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_artifacts_state_check
  check (artifacts_state in ('ENABLED','DISABLED'));
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_artifacts_error_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_artifacts_error_check
  check (artifacts_error_code is null or artifacts_error_code ~ '^[a-z_]{1,80}$');
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_artifacts_attempts_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_artifacts_attempts_check
  check (artifacts_attempts >= 0);
comment on column private.google_meet_rooms.artifacts_state is
  'Transcrição e anotações automáticas no Google: ENABLED (como a sala nasce) ou DISABLED (aceite revogado; spaces.patch com OFF). A fila acerta a diferença com lesson_sessions.documentation_consent.';

-- Porta do servidor -------------------------------------------------------------
create or replace function public.google_meet_backend(
  p_action text, p_tenant_id text default null, p_actor_id uuid default null,
  p_session_id uuid default null, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.profiles%rowtype;
  s public.lesson_sessions%rowtype;
  c private.google_workspace_connections%rowtype;
  r private.google_meet_rooms%rowtype;
  n private.google_meet_oauth_states%rowtype;
  v private.lesson_summary_versions%rowtype;
  i private.google_meet_artifact_imports%rowtype;
  t private.teacher_google_identities%rowtype;
  v_id uuid; v_version integer; v_parent uuid; v_status text;
  v_sources uuid[]; v_content jsonb; v_admin boolean := false;
  v_state text; v_claim uuid; v_automatic boolean; v_complete boolean;
  v_interval interval; v_closing boolean; v_raw boolean := false;
  v_sub text; v_email text; v_holder uuid; v_holder_active boolean;
begin
  if p_action = 'nonce_consume' then
    update private.google_meet_oauth_states
       set consumed_at = now()
     where state_hash = p_payload->>'state_hash' and consumed_at is null and expires_at > now()
     returning * into n;
    if not found then raise exception 'oauth_state_invalid' using errcode = '22023'; end if;
    return to_jsonb(n);
  end if;

  select * into a from public.profiles where id = p_actor_id;
  if a.id is null or lower(coalesce(a.lifecycle_status,'')) <> 'active'
    or a.role not in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR','TEACHER')
    or (a.role <> 'SUPER_ADMIN' and a.tenant_id is distinct from p_tenant_id) then
    raise exception 'google_meet_forbidden' using errcode = '42501';
  end if;
  v_admin := a.role in ('SCHOOL_ADMIN','SUPER_ADMIN');
  if p_action in ('nonce_create','connection_save','disconnect') and not v_admin then
    raise exception 'google_meet_admin_required' using errcode = '42501';
  end if;
  -- A identidade Google é do PRÓPRIO professor: ninguém confirma por outro.
  if p_action in ('identity_nonce_create','identity_save') and a.role <> 'TEACHER' then
    raise exception 'google_meet_teacher_required' using errcode = '42501';
  end if;

  if p_action = 'nonce_create' then
    delete from private.google_meet_oauth_states where expires_at < now() - interval '1 day';
    insert into private.google_meet_oauth_states(state_hash,tenant_id,actor_id,verifier_ciphertext,expires_at,flow,allow_replace)
    values (p_payload->>'state_hash',p_tenant_id,p_actor_id,p_payload->>'verifier_ciphertext',now()+interval '10 minutes',
      'organizer',coalesce((p_payload->>'allow_replace')::boolean,false));
    return jsonb_build_object('ok',true);
  elsif p_action = 'identity_nonce_create' then
    delete from private.google_meet_oauth_states where expires_at < now() - interval '1 day';
    insert into private.google_meet_oauth_states(state_hash,tenant_id,actor_id,verifier_ciphertext,expires_at,flow,allow_replace)
    values (p_payload->>'state_hash',p_tenant_id,p_actor_id,p_payload->>'verifier_ciphertext',now()+interval '10 minutes',
      'teacher_identity',false);
    return jsonb_build_object('ok',true);
  elsif p_action = 'identity_save' then
    v_sub := btrim(coalesce(p_payload->>'google_sub',''));
    v_email := lower(btrim(coalesce(p_payload->>'google_email','')));
    if coalesce((p_payload->>'email_verified')::boolean,false) is not true then
      raise exception 'google_identity_unverified' using errcode = '22023'; end if;
    if v_sub !~ '^[0-9A-Za-z_-]{1,255}$' or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
      raise exception 'google_identity_invalid' using errcode = '22023'; end if;
    -- A mesma conta Google já confirmada por OUTRO professor da escola: se ele
    -- ainda está ativo, recusa (presença ficaria ambígua); se saiu, libera.
    select ident.teacher_id, lower(coalesce(holder.lifecycle_status,''))='active'
      into v_holder, v_holder_active
      from private.teacher_google_identities ident
      left join public.profiles holder on holder.id=ident.teacher_id
     where ident.tenant_id=p_tenant_id and ident.google_sub=v_sub and ident.teacher_id<>a.id;
    if v_holder is not null and v_holder_active then
      raise exception 'google_identity_in_use' using errcode = '23505'; end if;
    if v_holder is not null then
      delete from private.teacher_google_identities where teacher_id=v_holder;
    end if;
    insert into private.teacher_google_identities(teacher_id,tenant_id,google_sub,google_email,email_verified,verified_at,updated_at)
    values (a.id,p_tenant_id,v_sub,v_email,true,now(),now())
    on conflict (teacher_id) do update set tenant_id=excluded.tenant_id, google_sub=excluded.google_sub,
      google_email=excluded.google_email, email_verified=true, verified_at=now(), updated_at=now()
    returning * into t;
    insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
    values(p_tenant_id,a.id,null,'TEACHER_GOOGLE_IDENTITY_VERIFIED');
    return jsonb_build_object('email',t.google_email,'verified_at',t.verified_at);
  elsif p_action = 'connection_save' then
    -- Troca de conta central com salas já criadas pela atual: os documentos
    -- dessas salas ficam no Drive da conta antiga e deixam de ser lidos, e a
    -- revogação não consegue mais desligá-las. Só com o pedido explícito da
    -- direção (allow_replace gravado no nonce, não no retorno do Google).
    select * into c from private.google_workspace_connections where tenant_id=p_tenant_id for update;
    if c.tenant_id is not null and c.organizer_sub is distinct from p_payload->>'organizer_sub'
      and not coalesce((p_payload->>'allow_replace')::boolean,false)
      and exists (select 1 from private.google_meet_rooms room
        where room.tenant_id=p_tenant_id and room.organizer_sub=c.organizer_sub and room.space_name is not null) then
      raise exception 'google_organizer_change_requires_confirmation' using errcode = '55000';
    end if;
    insert into private.google_workspace_connections(tenant_id,organizer_sub,organizer_email,refresh_token_ciphertext,granted_scopes,status,connected_by)
    values (p_tenant_id,p_payload->>'organizer_sub',p_payload->>'organizer_email',p_payload->>'refresh_token_ciphertext',
      array(select jsonb_array_elements_text(p_payload->'granted_scopes')),'CONNECTED',p_actor_id)
    on conflict (tenant_id) do update set organizer_sub=excluded.organizer_sub,organizer_email=excluded.organizer_email,
      refresh_token_ciphertext=excluded.refresh_token_ciphertext,granted_scopes=excluded.granted_scopes,status='CONNECTED',
      connected_by=p_actor_id,connected_at=now(),updated_at=now(),last_error_code=null;
    if c.tenant_id is not null and c.organizer_sub is distinct from p_payload->>'organizer_sub' then
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(p_tenant_id,p_actor_id,null,'ORGANIZER_REPLACED');
    end if;
  elsif p_action = 'disconnect' then
    update private.google_workspace_connections set refresh_token_ciphertext=null,status='DISCONNECTED',updated_at=now()
    where tenant_id=p_tenant_id;
    update private.google_meet_oauth_states set consumed_at=coalesce(consumed_at,now()) where tenant_id=p_tenant_id;
  elsif p_action = 'connection_error' then
    update private.google_workspace_connections set status='REAUTH_REQUIRED',last_error_code=left(p_payload->>'error_code',80),updated_at=now()
    where tenant_id=p_tenant_id;
  elsif p_action in ('connection_get','status') then
    select * into c from private.google_workspace_connections where tenant_id=p_tenant_id;
    if p_action='connection_get' then return coalesce(to_jsonb(c),'{}'::jsonb); end if;
    return jsonb_build_object('connection',case when c.tenant_id is null then null else
      jsonb_build_object('organizer_email',c.organizer_email,'status',c.status,'connected_at',c.connected_at,'last_error_code',c.last_error_code) end,
      -- Salas com link criadas pela conta atual: trocar de conta as deixa sem leitura.
      'rooms_count',case when c.tenant_id is null then 0 else (select count(*) from private.google_meet_rooms room
        where room.tenant_id=p_tenant_id and room.organizer_sub=c.organizer_sub and room.space_name is not null) end);
  elsif p_action = 'sync_due' then
    if not v_admin then raise exception 'google_meet_admin_required' using errcode='42501'; end if;
    -- Mesma régua da fila automática: importação que já concluiu ou venceu não volta.
    return coalesce((select jsonb_agg(x) from (
      select room.lesson_session_id from private.google_meet_rooms room
      join public.lesson_sessions sess on sess.id=room.lesson_session_id and sess.tenant_id=room.tenant_id
      where room.tenant_id=p_tenant_id and room.state='READY' and sess.documentation_consent and sess.status<>'SUPERSEDED'
        and sess.scheduled_end_at < now() and sess.scheduled_end_at > now()-interval '7 days'
        and room.sync_status in ('WAITING','PENDING')
        and coalesce(room.next_sync_at, room.last_synced_at+interval '30 minutes', '-infinity'::timestamptz) <= now()
      order by room.last_synced_at nulls first limit 5
    ) x),'[]'::jsonb);
  else
    select * into s from public.lesson_sessions where id=p_session_id and tenant_id=p_tenant_id;
    if s.id is null then raise exception 'lesson_session_not_found' using errcode='22023'; end if;
    -- Professor alcança a sessão que ele dá (inclusive substituto) ou de aluno seu.
    if a.role='TEACHER' and s.teacher_id<>a.id and not exists (
      select 1 from public.profiles student where student.id=s.student_id and student.tenant_id=s.tenant_id
      and (student.professor_id=a.id or student.professor_id2=a.id or exists (
        select 1 from public.bookings b where b.student_id=student.id and b.tenant_id=s.tenant_id
        and b.teacher_id=a.id and b.status='SCHEDULED'
      ))
    ) then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;
    -- Transcrição bruta (fontes, rascunhos, planilha de presença): só o professor
    -- da própria aula, a coordenação e a direção DESTA escola. Outros professores
    -- do aluno e o suporte da plataforma (SUPER_ADMIN) ficam com o resumo aprovado.
    v_raw := (a.role in ('SCHOOL_ADMIN','COORDINATOR') and a.tenant_id=s.tenant_id)
      or (a.role='TEACHER' and s.teacher_id=a.id);

    if p_action='room_claim' then
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      if s.status='SUPERSEDED' then raise exception 'lesson_session_superseded' using errcode='22023'; end if;
      if a.role='TEACHER' and s.teacher_id<>a.id then raise exception 'session_teacher_required' using errcode='42501'; end if;
      v_automatic := coalesce((p_payload->>'automatic')::boolean,false);
      -- O coanfitrião é a conta Google que o professor da aula confirmou por
      -- login. O e-mail do cadastro (ou o que vier do chamador) não conta.
      select * into t from private.teacher_google_identities ident
       where ident.teacher_id=s.teacher_id and ident.tenant_id=s.tenant_id;
      if t.teacher_id is null and not exists (select 1 from private.google_meet_rooms room
        where room.lesson_session_id=s.id and room.space_name is not null) then
        raise exception 'google_teacher_identity_required' using errcode='42501'; end if;
      if t.teacher_id is not null then
        insert into private.google_meet_rooms(lesson_session_id,tenant_id,organizer_sub,cohost_email,state,created_by,claim_id,creation_attempts)
        values(s.id,s.tenant_id,p_payload->>'organizer_sub',t.google_email,'CREATING',a.id,pg_catalog.gen_random_uuid(),1)
        on conflict (lesson_session_id) do nothing returning * into r;
        if r.lesson_session_id is not null then
          insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_CREATION_CLAIMED');
          return jsonb_build_object('claimed',true,'room',to_jsonb(r)); end if;
        -- Nova tentativa, só de linha SEM link salvo (nada foi distribuído):
        --   FAILED — na rodada automática, só quando a espera venceu; clique manual
        --            tenta na hora;
        --   CREATING há mais de 15 min — o worker que reservou morreu (ele vive no
        --            máximo 150 s); a reserva nova invalida a antiga (claim_id);
        --   NEEDS_RECONCILIATION sem link — legado da regra antiga ("criação
        --            incerta"), que nunca salvava link.
        -- A rodada automática para em 5 tentativas; o clique manual não tem teto.
        update private.google_meet_rooms room
           set state='CREATING', claim_id=pg_catalog.gen_random_uuid(),
               creation_attempts=room.creation_attempts+1,
               organizer_sub=p_payload->>'organizer_sub', cohost_email=t.google_email,
               next_attempt_at=null, last_error_code=null, updated_at=now()
         where room.lesson_session_id=s.id and room.tenant_id=s.tenant_id and room.space_name is null
           and ((room.state='FAILED' and (not v_automatic or (room.next_attempt_at is not null and room.next_attempt_at<=now())))
             or (room.state in ('CREATING','NEEDS_RECONCILIATION') and room.updated_at<now()-interval '15 minutes'
               and (not v_automatic or room.creation_attempts<5)))
        returning * into r;
        if r.lesson_session_id is not null then
          insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_CREATION_RETRY_CLAIMED');
          return jsonb_build_object('claimed',true,'room',to_jsonb(r)); end if;
        -- Sala pronta com coanfitrião diferente da conta confirmada (o professor
        -- confirmou outra conta, ou a aula mudou de professor): volta para
        -- COHOST_PENDING com o e-mail novo, e a edge configura o membro.
        update private.google_meet_rooms room
           set cohost_email=t.google_email, state='COHOST_PENDING', updated_at=now()
         where room.lesson_session_id=s.id and room.tenant_id=s.tenant_id and room.space_name is not null
           and room.state in ('READY','COHOST_PENDING') and room.organizer_sub=p_payload->>'organizer_sub'
           and room.cohost_email<>t.google_email
        returning * into r;
        if r.lesson_session_id is not null then
          insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_COHOST_CHANGED');
          return jsonb_build_object('claimed',false,'room',to_jsonb(r)-'claim_id'); end if;
      end if;
      select * into r from private.google_meet_rooms where lesson_session_id=s.id;
      return jsonb_build_object('claimed',false,'room',to_jsonb(r)-'claim_id');
    elsif p_action='room_save' then
      v_state := p_payload->>'state';
      if v_state is null or v_state not in ('COHOST_PENDING','READY','FAILED') then
        raise exception 'google_room_state_invalid' using errcode='22023'; end if;
      select * into r from private.google_meet_rooms where lesson_session_id=s.id and tenant_id=s.tenant_id for update;
      if r.lesson_session_id is null then raise exception 'google_room_not_found' using errcode='22023'; end if;
      v_claim := nullif(p_payload->>'claim_id','')::uuid;
      -- O resultado da criação (link salvo ou FAILED) só vale para quem tem a
      -- reserva atual: um worker atrasado não sobrescreve a tentativa seguinte.
      if (p_payload ? 'space_name' or v_state='FAILED') and r.claim_id is distinct from v_claim then
        raise exception 'google_room_claim_lost' using errcode='55000'; end if;
      if v_state='FAILED' and r.space_name is not null then
        raise exception 'google_room_already_created' using errcode='55000'; end if;
      -- Único risco real de dois links: já existe um salvo e chega outro. Não
      -- escolhe sozinho — a direção decide qual vale.
      if p_payload ? 'space_name' and r.space_name is not null and r.space_name<>p_payload->>'space_name' then
        update private.google_meet_rooms set state='NEEDS_RECONCILIATION',last_error_code='google_room_space_conflict',updated_at=now()
         where lesson_session_id=s.id and tenant_id=s.tenant_id returning * into r;
        insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_NEEDS_RECONCILIATION');
        return to_jsonb(r)-'claim_id';
      end if;
      if v_state in ('COHOST_PENDING','READY') and coalesce(p_payload->>'space_name',r.space_name) is null then
        raise exception 'google_room_space_required' using errcode='22023'; end if;
      update private.google_meet_rooms set space_name=coalesce(p_payload->>'space_name',space_name),
        meeting_uri=coalesce(p_payload->>'meeting_uri',meeting_uri),state=v_state,
        last_error_code=p_payload->>'error_code',
        -- Espera crescente entre tentativas automáticas; na 5ª para.
        next_attempt_at=case when v_state<>'FAILED' or creation_attempts>=5 then null
          when creation_attempts<=1 then now()+interval '30 minutes'
          when creation_attempts=2 then now()+interval '2 hours'
          else now()+interval '6 hours' end,
        updated_at=now()
      where lesson_session_id=s.id and tenant_id=s.tenant_id returning * into r;
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_'||r.state);
      return to_jsonb(r)-'claim_id';
    elsif p_action='room_artifacts_save' then
      -- Resultado do spaces.patch da documentação (DISABLE/ENABLE). Grava o que
      -- está no GOOGLE, não o desejado: se o aceite mudou de novo no meio do
      -- caminho, a fila vê a diferença e manda a operação oposta.
      v_state := p_payload->>'result';
      if v_state is null or v_state not in ('ENABLED','DISABLED','FAILED') then
        raise exception 'google_room_state_invalid' using errcode='22023'; end if;
      update private.google_meet_rooms room set
        artifacts_state=case when v_state='FAILED' then room.artifacts_state else v_state end,
        artifacts_changed_at=case when v_state<>'FAILED' and v_state<>room.artifacts_state then now() else room.artifacts_changed_at end,
        artifacts_error_code=nullif(p_payload->>'error_code',''),
        artifacts_attempts=case when v_state='FAILED' then room.artifacts_attempts+1 else 0 end,
        -- Falha tenta de novo em 15 min, 30, 60, 120 (teto de 2 h): desligar a
        -- transcrição de quem revogou não desiste.
        artifacts_next_attempt_at=case when v_state='FAILED'
          then now()+least(interval '2 hours', interval '15 minutes'*power(2,least(room.artifacts_attempts,4))::integer)
          else null end,
        updated_at=now()
      where room.lesson_session_id=s.id and room.tenant_id=s.tenant_id and room.space_name is not null
      returning * into r;
      if r.lesson_session_id is null then raise exception 'google_room_not_found' using errcode='22023'; end if;
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(s.tenant_id,a.id,s.id,'ROOM_ARTIFACTS_'||v_state);
      return to_jsonb(r)-'claim_id';
    elsif p_action='sync_complete' then
      -- A fila tem fim. Concluída (tudo importado e presença avaliada) sai da
      -- fila; senão volta em 10 min nas primeiras 6 h depois da aula, de hora em
      -- hora até 48 h e a cada ~6 h até 7 dias — aí encerra (EXPIRED).
      v_complete := coalesce((p_payload->>'complete')::boolean,false);
      v_interval := case when now()<s.scheduled_end_at+interval '6 hours' then interval '10 minutes'
        when now()<s.scheduled_end_at+interval '48 hours' then interval '55 minutes'
        else interval '355 minutes' end;
      v_closing := not v_complete and now()+v_interval>s.scheduled_end_at+interval '7 days';
      update private.google_meet_rooms set last_synced_at=now(),last_error_code=p_payload->>'error_code',updated_at=now(),
        sync_status=case when v_complete then 'COMPLETE' when v_closing then 'EXPIRED' else 'PENDING' end,
        sync_completed_at=case when v_complete or v_closing then now() else null end,
        next_sync_at=case when v_complete or v_closing then null else now()+v_interval end
      where lesson_session_id=s.id and tenant_id=s.tenant_id;
    elsif p_action='artifact_save' then
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      insert into private.meeting_artifact_revisions(tenant_id,lesson_session_id,provider_name,kind,document_id,content_sha256,source_text,expires_at,source)
      values(s.tenant_id,s.id,p_payload->>'provider_name',p_payload->>'kind',p_payload->>'document_id',p_payload->>'content_sha256',
        p_payload->>'source_text',now()+make_interval(days=>greatest(7,least(365,(p_payload->>'retention_days')::integer))),
        coalesce(nullif(p_payload->>'source',''),'DRIVE_EXPORT'))
      on conflict (tenant_id,lesson_session_id,provider_name,content_sha256) do nothing returning id into v_id;
      if v_id is null then
        select id into v_id from private.meeting_artifact_revisions where tenant_id=s.tenant_id and lesson_session_id=s.id
          and provider_name=p_payload->>'provider_name' and content_sha256=p_payload->>'content_sha256';
        return jsonb_build_object('id',v_id,'inserted',false);
      end if;
      return jsonb_build_object('id',v_id,'inserted',true);
    elsif p_action='artifact_status' then
      -- Situação de UM documento, com o erro dele. Sem conteúdo aqui.
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      v_status := p_payload->>'status';
      v_id := nullif(p_payload->>'revision_id','')::uuid;
      if v_id is not null and not exists(select 1 from private.meeting_artifact_revisions ar
        where ar.id=v_id and ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id) then
        raise exception 'artifact_revision_scope_mismatch' using errcode='42501'; end if;
      insert into private.google_meet_artifact_imports(lesson_session_id,tenant_id,provider_name,kind,provider_state,status,source,
        last_error_code,failed_attempts,revision_id)
      values(s.id,s.tenant_id,p_payload->>'provider_name',p_payload->>'kind',nullif(p_payload->>'provider_state',''),v_status,
        nullif(p_payload->>'source',''),nullif(p_payload->>'error_code',''),case when v_status='FAILED' then 1 else 0 end,v_id)
      on conflict (lesson_session_id,provider_name) do update set
        kind=excluded.kind, provider_state=excluded.provider_state, status=excluded.status,
        source=coalesce(excluded.source,private.google_meet_artifact_imports.source),
        last_error_code=excluded.last_error_code,
        failed_attempts=private.google_meet_artifact_imports.failed_attempts+excluded.failed_attempts,
        revision_id=coalesce(excluded.revision_id,private.google_meet_artifact_imports.revision_id),
        updated_at=now()
      returning * into i;
      return to_jsonb(i);
    elsif p_action='summary_claim' then
      if not v_raw then raise exception 'google_meet_raw_access_required' using errcode='42501'; end if;
      insert into private.google_meet_generation_leases(lesson_session_id,tenant_id,acquired_at,actor_id)
      values(s.id,s.tenant_id,now(),a.id)
      on conflict (lesson_session_id) do update set acquired_at=now(),actor_id=a.id
      where private.google_meet_generation_leases.acquired_at < now()-interval '2 minutes'
      returning lesson_session_id into v_id;
      if v_id is null then raise exception 'google_summary_generation_rate_limited' using errcode='55000'; end if;
    elsif p_action='summary_save' then
      -- Revisar, aprovar ou gerar resumo exige ver a fonte. O rascunho das notas
      -- nativas é gravado pela importação (a conta que conectou pode ser o suporte).
      if not v_raw and not (p_payload->>'status'='PROPOSED' and p_payload->>'origin'='GOOGLE_SMART_NOTES') then
        raise exception 'google_meet_raw_access_required' using errcode='42501'; end if;
      perform pg_advisory_xact_lock(hashtextextended('google-meet-summary:'||s.id::text,0));
      v_status := p_payload->>'status';
      v_content := p_payload->'content';
      v_parent := nullif(p_payload->>'parent_version_id','')::uuid;
      v_sources := array(select jsonb_array_elements_text(coalesce(p_payload->'source_artifact_ids','[]'::jsonb)))::uuid[];
      if v_status not in ('PROPOSED','VERIFIED','REJECTED') or jsonb_typeof(v_content)<>'object'
        or octet_length(v_content::text)>150000 then raise exception 'invalid_summary' using errcode='22023'; end if;
      if exists(select 1 from unnest(v_sources) x where not exists(
        select 1 from private.meeting_artifact_revisions ar where ar.id=x and ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id and ar.expires_at>now()
      )) then raise exception 'summary_artifact_scope_mismatch' using errcode='42501'; end if;
      if v_parent is not null and not exists(select 1 from private.lesson_summary_versions sv
        where sv.id=v_parent and sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id) then
        raise exception 'summary_parent_scope_mismatch' using errcode='42501'; end if;
      if v_status in ('VERIFIED','REJECTED') and (v_parent is null or p_payload->>'origin'<>'HUMAN_REVIEW') then
        raise exception 'summary_review_required' using errcode='22023'; end if;
      if v_status='VERIFIED' and (length(btrim(coalesce(v_content->>'lesson_objective','')))=0
        or length(btrim(coalesce(v_content->>'recommended_next_step','')))=0) then
        raise exception 'summary_objective_and_next_step_required' using errcode='22023'; end if;
      select coalesce(max(version),0)+1 into v_version from private.lesson_summary_versions where lesson_session_id=s.id;
      insert into private.lesson_summary_versions(tenant_id,lesson_session_id,version,parent_version_id,status,origin,content,
        source_artifact_ids,model_id,prompt_version,review_reason,created_by)
      values(s.tenant_id,s.id,v_version,v_parent,v_status,p_payload->>'origin',v_content,v_sources,
        p_payload->>'model_id',p_payload->>'prompt_version',left(p_payload->>'review_reason',2000),a.id) returning * into v;
      if v_status='VERIFIED' then
        insert into public.student_learning_memories(tenant_id,student_id,source_type,source_ref,occurred_at,
          lesson_objective,content_practiced,recurring_errors,strengths_observed,homework_assigned,recommended_next_step,
          confidence_level,verification_status,metadata,created_by)
        values(s.tenant_id,s.student_id,'MEET_SESSION',s.id::text,s.scheduled_start_at,
          v_content->>'lesson_objective',array(select jsonb_array_elements_text(coalesce(v_content->'content_practiced','[]'::jsonb))),
          array(select jsonb_array_elements_text(coalesce(v_content->'recurring_errors','[]'::jsonb))),
          array(select jsonb_array_elements_text(coalesce(v_content->'strengths_observed','[]'::jsonb))),
          coalesce(v_content->>'homework_assigned',''),v_content->>'recommended_next_step','HIGH','VERIFIED',
          jsonb_build_object('summary_version_id',v.id,'pedagogical_documentation_only',true,'reviewed_by',a.id),a.id)
        on conflict (tenant_id,student_id,source_type,source_ref) do update set
          lesson_objective=excluded.lesson_objective,content_practiced=excluded.content_practiced,
          recurring_errors=excluded.recurring_errors,strengths_observed=excluded.strengths_observed,
          homework_assigned=excluded.homework_assigned,recommended_next_step=excluded.recommended_next_step,
          confidence_level=excluded.confidence_level,verification_status='VERIFIED',metadata=excluded.metadata,updated_at=now();
      end if;
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'SUMMARY_'||v_status);
      return to_jsonb(v);
    elsif p_action='session_state' then
      -- Uso interno da edge (fila, criação da sala, importação, documentação
      -- ligada/desligada): estado sem texto bruto e sem registro de leitura.
      return jsonb_build_object('session',to_jsonb(s),
        'room',(select to_jsonb(room)-'claim_id' from private.google_meet_rooms room where room.lesson_session_id=s.id),
        'imports',coalesce((select jsonb_agg(to_jsonb(imp) order by imp.kind desc, imp.first_seen_at)
          from private.google_meet_artifact_imports imp
          where imp.tenant_id=s.tenant_id and imp.lesson_session_id=s.id),'[]'::jsonb),
        'attendance_saved_reports',coalesce((select greatest(1,cardinality(rep.source_document_ids))
          from private.meeting_attendance_reports rep
          where rep.tenant_id=s.tenant_id and rep.lesson_session_id=s.id and rep.parse_error is null and rep.expires_at>now()
          order by rep.imported_at desc limit 1),0),
        'summaries',coalesce((select jsonb_agg(jsonb_build_object('id',sv.id,'version',sv.version,'status',sv.status,
            'origin',sv.origin,'source_artifact_ids',sv.source_artifact_ids,'created_at',sv.created_at) order by sv.version desc)
          from private.lesson_summary_versions sv where sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id),'[]'::jsonb),
        -- Conta Google confirmada pelo professor DA AULA: coanfitrião e quem o
        -- relatório de presença reconhece como professor.
        'teacher_google_email',(select ident.google_email from private.teacher_google_identities ident
          where ident.teacher_id=s.teacher_id and ident.tenant_id=s.tenant_id));
    elsif p_action='session_detail' then
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(s.tenant_id,a.id,s.id,case when v_raw then 'READ_PEDAGOGICAL_DOCUMENTATION' else 'READ_APPROVED_SUMMARIES' end);
      return jsonb_build_object('session',to_jsonb(s),
        'raw_access',v_raw,
        'room',(select to_jsonb(room)-'claim_id' from private.google_meet_rooms room where room.lesson_session_id=s.id),
        'artifacts',case when v_raw then coalesce((select jsonb_agg(ar order by ar.imported_at desc) from private.meeting_artifact_revisions ar
          where ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id and ar.expires_at>now()),'[]'::jsonb) else '[]'::jsonb end,
        -- Situação de cada documento (o que falhou, o que está vazio, o que o
        -- Google ainda está gerando). Só estado e código de erro.
        'imports',coalesce((select jsonb_agg(to_jsonb(imp) order by imp.kind desc, imp.first_seen_at)
          from private.google_meet_artifact_imports imp
          where imp.tenant_id=s.tenant_id and imp.lesson_session_id=s.id),'[]'::jsonb),
        -- Quantas planilhas de presença (uma por conferência) já estão guardadas
        -- e legíveis: com todas, a importação só reavalia contra o lançamento.
        'attendance_saved_reports',coalesce((select greatest(1,cardinality(rep.source_document_ids))
          from private.meeting_attendance_reports rep
          where rep.tenant_id=s.tenant_id and rep.lesson_session_id=s.id and rep.parse_error is null and rep.expires_at>now()
          order by rep.imported_at desc limit 1),0),
        -- A planilha de presença (quem entrou, a que horas, por quanto tempo) é
        -- dado bruto: só para quem vê a transcrição. Sem o CSV original.
        'attendance',case when v_raw then (select jsonb_build_object('imported_at',rep.imported_at,
            'document_name',rep.document_name,'parse_error',rep.parse_error,
            'teacher_first_join_at',rep.teacher_first_join_at,'teacher_seconds',rep.teacher_seconds,
            'student_first_join_at',rep.student_first_join_at,'student_seconds',rep.student_seconds,
            'participants',rep.participants)
          from private.meeting_attendance_reports rep
          where rep.tenant_id=s.tenant_id and rep.lesson_session_id=s.id and rep.expires_at>now()
          order by rep.imported_at desc limit 1) else null end,
        -- Rascunhos (notas nativas = texto do Google) só para quem vê a fonte;
        -- os demais recebem só o resumo aprovado, como antes.
        'summaries',coalesce((select jsonb_agg(sv order by sv.version desc) from private.lesson_summary_versions sv
          where sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id and (v_raw or sv.status='VERIFIED')),'[]'::jsonb));
    else raise exception 'unknown_google_meet_action' using errcode='22023'; end if;
  end if;
  insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
  values(p_tenant_id,p_actor_id,p_session_id,p_action);
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.google_meet_backend(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.google_meet_backend(text,text,uuid,uuid,jsonb) to service_role;

-- 4. Fila -----------------------------------------------------------------------
-- Grupos de prioridade (20260926170000) mais:
--   0 DISABLE_ARTIFACTS / ENABLE_ARTIFACTS — a documentação da sala acompanha o
--     aceite (revogou → desliga; voltou antes da aula → religa);
--   PREPARE_ROOM só para professor com conta Google confirmada (sem ela a sala
--     não sai, e a sessão entupiria as 30 vagas a cada 15 min), e também para
--     sala pronta cujo coanfitrião não é mais a conta confirmada.
create or replace function public.get_pending_google_meet_sync_sessions()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(x order by x.priority_group, x.priority_at),'[]'::jsonb) from (
    select jobs.* from (
      select r.tenant_id,c.connected_by as actor_id,r.lesson_session_id,'SYNC_ARTIFACTS'::text as operation,
        case when r.last_synced_at is null then 1 else 3 end as priority_group,
        coalesce(r.next_sync_at,r.last_synced_at,s.scheduled_end_at) as priority_at
      from private.google_meet_rooms r
      join public.lesson_sessions s on s.id=r.lesson_session_id and s.tenant_id=r.tenant_id
      join private.google_workspace_connections c on c.tenant_id=r.tenant_id and c.organizer_sub=r.organizer_sub
      join public.profiles a on a.id=c.connected_by
      where c.status='CONNECTED' and r.state='READY' and s.documentation_consent and s.status<>'SUPERSEDED'
        and s.scheduled_end_at<now() and s.scheduled_end_at>now()-interval '7 days'
        and r.sync_status in ('WAITING','PENDING')
        and coalesce(r.next_sync_at,r.last_synced_at+interval '30 minutes','-infinity'::timestamptz)<=now()
        and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
        and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
      union all
      select s.tenant_id,c.connected_by,s.id,'PREPARE_ROOM',
        case when s.scheduled_start_at<now()+interval '3 hours' then 0 else 2 end,
        s.scheduled_start_at
      from public.lesson_sessions s
      join private.google_workspace_connections c on c.tenant_id=s.tenant_id and c.status='CONNECTED'
      join public.profiles a on a.id=c.connected_by
      join private.teacher_google_identities ident on ident.teacher_id=s.teacher_id and ident.tenant_id=s.tenant_id
      left join private.google_meet_rooms r on r.lesson_session_id=s.id
      where s.documentation_consent and s.status='SCHEDULED'
        and s.scheduled_start_at between now() and now()+interval '24 hours'
        and (r.lesson_session_id is null
          or (r.state='COHOST_PENDING' and r.organizer_sub=c.organizer_sub and r.updated_at<now()-interval '1 hour')
          or (r.state='READY' and r.organizer_sub=c.organizer_sub and r.space_name is not null
            and r.cohost_email<>ident.google_email)
          or (r.space_name is null and r.state='FAILED' and r.next_attempt_at<=now())
          or (r.space_name is null and r.state in ('CREATING','NEEDS_RECONCILIATION')
            and r.updated_at<now()-interval '15 minutes' and r.creation_attempts<5))
        and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
        and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
      union all
      -- A documentação da sala segue o aceite. Só a conta que criou a sala
      -- consegue alterá-la (organizer_sub da conexão atual).
      select r.tenant_id,c.connected_by,r.lesson_session_id,
        case when s.documentation_consent then 'ENABLE_ARTIFACTS' else 'DISABLE_ARTIFACTS' end,
        0, s.scheduled_start_at
      from private.google_meet_rooms r
      join public.lesson_sessions s on s.id=r.lesson_session_id and s.tenant_id=r.tenant_id
      join private.google_workspace_connections c on c.tenant_id=r.tenant_id and c.organizer_sub=r.organizer_sub
      join public.profiles a on a.id=c.connected_by
      where c.status='CONNECTED' and r.space_name is not null and r.state in ('READY','COHOST_PENDING')
        and coalesce(r.artifacts_next_attempt_at,'-infinity'::timestamptz)<=now()
        and ((not s.documentation_consent and r.artifacts_state='ENABLED' and s.scheduled_end_at>now()-interval '7 days')
          or (s.documentation_consent and r.artifacts_state='DISABLED' and s.status='SCHEDULED' and s.scheduled_start_at>now()))
        and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
        and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
    ) jobs
    order by jobs.priority_group,jobs.priority_at limit 30
  ) x;
$$;
revoke all on function public.get_pending_google_meet_sync_sessions() from public,anon,authenticated;
grant execute on function public.get_pending_google_meet_sync_sessions() to service_role;

-- 5. Link da aula ---------------------------------------------------------------
-- Partindo de 20260926170000. Mudam duas condições:
--   * sessão sem documentation_consent não volta, mesmo com sala criada: sala da
--     escola só com aceite (decisão da direção). Quem revogou cai no link de
--     sempre, igual ao lembrete do WhatsApp (official_lesson_link);
--   * aceite sem sala só segura o link quando a sala PODE sair: sem conta
--     Google confirmada pelo professor ela nunca sai, e o app usa o link de sempre.
create or replace function public.get_my_lesson_rooms(
  p_from date default null, p_to date default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.profiles%rowtype;
begin
  select * into a from public.profiles where id=auth.uid();
  if a.id is null or lower(coalesce(a.lifecycle_status,''))<>'active' then
    raise exception 'authentication_required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(x order by x.scheduled_start_at) from (
    select s.id as session_id,s.class_date,s.scheduled_start_at,s.scheduled_end_at,
      case when r.state='READY' then r.meeting_uri else null end as meeting_uri,
      coalesce((select jsonb_agg(jsonb_build_object('source_type',o.source_type,'source_id',o.source_id))
        from public.lesson_occurrences o where o.session_id=s.id and o.tenant_id=s.tenant_id and o.status<>'SUPERSEDED'),'[]'::jsonb) as source_references
    from public.lesson_sessions s
    left join private.google_meet_rooms r on r.lesson_session_id=s.id and r.tenant_id=s.tenant_id
    where s.tenant_id=a.tenant_id and s.status<>'SUPERSEDED'
      and s.documentation_consent
      and (r.lesson_session_id is not null or exists (select 1 from private.teacher_google_identities ident
        where ident.teacher_id=s.teacher_id and ident.tenant_id=s.tenant_id))
      and coalesce(r.state,'') not in ('FAILED','NEEDS_RECONCILIATION')
      and (r.state='READY' or s.scheduled_start_at>now()+interval '15 minutes')
      and ((a.role='STUDENT' and s.student_id=a.id) or (a.role='TEACHER' and s.teacher_id=a.id)
        or a.role in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR'))
      and s.class_date between coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)
        and coalesce(p_to,coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)+30)
    order by s.scheduled_start_at limit 300
  ) x),'[]'::jsonb);
end;
$$;
revoke all on function public.get_my_lesson_rooms(date,date) from public,anon;
grant execute on function public.get_my_lesson_rooms(date,date) to authenticated;

-- 6. Identidade confirmada, para a tela do professor -----------------------------
-- {email, verified_at} da conta Google que o próprio usuário confirmou, ou null.
create or replace function public.get_my_google_identity()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid := (select auth.uid()); v_row private.teacher_google_identities;
begin
  if v_uid is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select ident.* into v_row
    from private.teacher_google_identities ident
    join public.profiles me on me.id=ident.teacher_id and me.tenant_id=ident.tenant_id
   where ident.teacher_id=v_uid;
  if v_row.teacher_id is null then return null; end if;
  return jsonb_build_object('email',v_row.google_email,'verified_at',v_row.verified_at);
end;
$$;
alter function public.get_my_google_identity() owner to postgres;
revoke all on function public.get_my_google_identity() from public, anon, authenticated;
grant execute on function public.get_my_google_identity() to authenticated;

-- 7. Aceite do professor exige a conta Google confirmada ---------------------------
-- Partindo da definição viva (20260926120000). Recusar e revogar continuam livres:
-- só AUTORIZAR depende da identidade, porque é ela que entra como coanfitriã.
create or replace function public.set_my_lesson_recording_consent(p_accept boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_decision text;
begin
  if p_accept is null then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if length(btrim(coalesce(v_me.full_name, ''))) < 3 then
    raise exception 'complete_seu_nome_no_perfil' using errcode = '22023';
  end if;
  if p_accept and not exists (
    select 1 from private.teacher_google_identities as ident
    where ident.teacher_id = v_me.id and ident.tenant_id = v_me.tenant_id and ident.email_verified
  ) then
    raise exception 'teacher_google_identity_required' using errcode = '22023';
  end if;

  v_term := private.lesson_recording_current_term('TEACHER');
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, recorded_by
  ) values (
    v_me.tenant_id, v_me.id, 'TEACHER', v_decision, left(btrim(v_me.full_name), 120), 'SELF',
    'TEACHER', v_term.version, 'APP', v_me.id
  );
  return jsonb_build_object('ok', true, 'decision', v_decision);
end;
$$;

-- 8. Marcação manual só pela direção, sem passar por cima de revogação -------------
-- Partindo da definição viva (20260912203213). Antes: coordenação também marcava,
-- e marcar ligava a documentação mesmo de quem tinha recusado ou revogado o termo.
create or replace function public.set_lesson_documentation_consent(p_session_id uuid,p_allowed boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  s public.lesson_sessions;
  v_me public.profiles;
begin
  select * into s from public.lesson_sessions where id=p_session_id for update;
  if not found or not private.can_manage_lesson_quality(s.tenant_id) then
    raise exception 'sem_permissao' using errcode='42501'; end if;
  select * into v_me from public.profiles where id=(select auth.uid());
  if v_me.id is null or v_me.role<>'SCHOOL_ADMIN' or v_me.tenant_id is distinct from s.tenant_id
    or lower(coalesce(v_me.lifecycle_status,''))<>'active' then
    raise exception 'somente_a_direcao' using errcode='42501'; end if;
  if p_allowed is null or length(btrim(coalesce(p_reason,'')))<10 then
    raise exception 'registre_a_base_e_o_comprovante_da_autorizacao' using errcode='22023'; end if;
  -- Ligar a documentação não passa por cima de quem disse não.
  if p_allowed and private.lesson_recording_consent_state(s.student_id) in ('REFUSED','REVOKED') then
    raise exception 'termo_recusado_ou_revogado_pelo_aluno' using errcode='42501'; end if;
  if p_allowed and private.lesson_recording_consent_state(s.teacher_id) in ('REFUSED','REVOKED') then
    raise exception 'termo_recusado_ou_revogado_pelo_professor' using errcode='42501'; end if;
  insert into private.lesson_documentation_consent_events(session_id,actor_id,allowed,reason)
  values(s.id,v_me.id,p_allowed,left(btrim(p_reason),2000));
  update public.lesson_sessions set documentation_consent=p_allowed,updated_at=now() where id=s.id;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.set_lesson_documentation_consent(uuid,boolean,text) from public,anon;
grant execute on function public.set_lesson_documentation_consent(uuid,boolean,text) to authenticated;

-- 9. Revogação que chega depois de uma marcação manual também desmarca ---------------
-- Partindo da definição viva (20260926120000). Antes só a marcação feita pelo
-- próprio termo era desfeita; a manual da escola seguia ligada depois que o aluno
-- (ou responsável) ou o professor revogava — e a sala continuava transcrevendo.
-- Decisão manual de DESLIGAR continua valendo (o termo não liga por cima dela).
create or replace function private.apply_standing_lesson_recording_consent(p_tenant text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_changed integer := 0;
  v_session record;
  v_marker constant text := 'Termo de registro das aulas';
begin
  if not exists (
    select 1 from private.google_workspace_connections as connection
    where connection.tenant_id = p_tenant and connection.status = 'CONNECTED'
  ) then
    return 0;
  end if;
  v_actor := private.management_group_default_actor(p_tenant);
  if v_actor is null then
    return 0;
  end if;

  -- Mesma trava da materialização das sessões (lesson_quality).
  perform pg_advisory_xact_lock(hashtextextended('lesson-quality:' || p_tenant, 0));

  for v_session in
    select session.id, session.student_id, session.teacher_id, session.documentation_consent,
      exists (
        select 1 from private.lesson_documentation_consent_events as event
        where event.session_id = session.id
      ) as has_event,
      exists (
        select 1 from private.lesson_documentation_consent_events as event
        where event.session_id = session.id and event.allowed
          and event.reason like (v_marker || '%')
      ) as marked_by_term,
      private.lesson_recording_consent_state(session.student_id) in ('REFUSED', 'REVOKED')
        or private.lesson_recording_consent_state(session.teacher_id) in ('REFUSED', 'REVOKED') as said_no
    from public.lesson_sessions as session
    where session.tenant_id = p_tenant
      and session.status = 'SCHEDULED'
      and session.scheduled_start_at between pg_catalog.now() and pg_catalog.now() + interval '24 hours'
  loop
    if private.lesson_recording_active(v_session.student_id, v_session.teacher_id) then
      if not v_session.documentation_consent and not v_session.has_event then
        insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason)
        values (v_session.id, v_actor, true,
          v_marker || ': aluno (ou responsável) e professor aceitaram o registro permanente.');
        update public.lesson_sessions
           set documentation_consent = true, updated_at = pg_catalog.now()
         where id = v_session.id;
        v_changed := v_changed + 1;
      end if;
    elsif v_session.documentation_consent and (v_session.marked_by_term or v_session.said_no) then
      insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason)
      values (v_session.id, v_actor, false,
        v_marker || case when v_session.marked_by_term
          then ': autorização revogada ou recusada depois da marcação.'
          else ': aluno (ou responsável) ou professor revogou ou recusou; a marcação manual não passa por cima.' end);
      update public.lesson_sessions
         set documentation_consent = false, updated_at = pg_catalog.now()
       where id = v_session.id;
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$$;
revoke all on function private.apply_standing_lesson_recording_consent(text) from public, anon, authenticated;
