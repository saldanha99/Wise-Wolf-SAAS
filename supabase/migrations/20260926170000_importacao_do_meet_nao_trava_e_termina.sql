-- Núcleo do Meet, parte 1: a importação não trava e termina.
--
-- O que estava errado (medido na leitura do código em 26/09/2026, antes do piloto;
-- em produção: 0 salas, 1 conexão):
--   * um documento que falhasse no export derrubava a sincronização inteira da
--     sessão — nem os outros documentos nem a presença eram lidos, e o erro não
--     dizia qual arquivo;
--   * documento vazio (aula sem fala) virava a MESMA falha a cada 30 min por 28 dias;
--   * criação de sala recusada ou incerta ia para NEEDS_RECONCILIATION e parava
--     ali para sempre, esperando a direção — a aula ficava sem sala;
--   * a fila nunca acabava: toda sala READY voltava a cada 30 min por 28 dias,
--     3 trabalhos por chamada;
--   * a busca de conferências usava ±2 h da agenda: aula remarcada por fora no
--     mesmo dia virava caso falso de "fora da sala".
--
-- Aqui:
--   1. google_meet_rooms ganha FAILED (nova tentativa sozinha: 30 min, 2 h, 6 h;
--      até 5), a reserva de criação (claim_id) e o estado da importação
--      (sync_status WAITING → PENDING → COMPLETE | EXPIRED, next_sync_at).
--   2. google_meet_artifact_imports: situação de CADA documento (PENDING,
--      IMPORTED, EMPTY, FAILED + código do erro), devolvida em session_detail.
--   3. meeting_artifact_revisions.source: DRIVE_EXPORT ou MEET_ENTRIES (plano B
--      da transcrição, montada pelas falas da API do Meet).
--   4. meeting_attendance_reports.source_document_ids: queda e reentrada geram
--      uma planilha por conferência; o registro guarda todas.
--   5. get_pending_google_meet_sync_sessions: sala FAILED vencida e CREATING
--      órfã voltam; a primeira importação depois da aula vem antes das
--      re-consultas; sessão COMPLETE/EXPIRED sai da fila; lote de até 30.
--   6. get_my_lesson_rooms: sala que não sai (FAILED/NEEDS_RECONCILIATION) ou
--      que não ficou pronta até 15 min antes do início não tira o link de sempre.
--   7. meet_attendance_evaluate: "fora da sala" só depois que o DIA da aula acaba
--      (no fuso da escola) e atraso só conta se o professor entrou antes do fim
--      previsto — depois disso é aula remarcada, não atraso.
--
-- Re-executável: add column if not exists, drop/add constraint, create or replace.
-- As funções existentes mantêm o dono (supabase_admin, como na migration
-- 20260912203245; meet_attendance_evaluate/google_meet_attendance_backend são do
-- postgres desde 20260926140000). Nenhuma função SECURITY DEFINER nova.

-- 1. Salas -----------------------------------------------------------------
alter table private.google_meet_rooms add column if not exists claim_id uuid;
alter table private.google_meet_rooms add column if not exists creation_attempts integer not null default 0;
alter table private.google_meet_rooms add column if not exists next_attempt_at timestamptz;
alter table private.google_meet_rooms add column if not exists sync_status text not null default 'WAITING';
alter table private.google_meet_rooms add column if not exists next_sync_at timestamptz;
alter table private.google_meet_rooms add column if not exists sync_completed_at timestamptz;

alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_state_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_state_check
  check (state in ('CREATING','COHOST_PENDING','READY','FAILED','NEEDS_RECONCILIATION'));
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_sync_status_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_sync_status_check
  check (sync_status in ('WAITING','PENDING','COMPLETE','EXPIRED'));
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_creation_attempts_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_creation_attempts_check
  check (creation_attempts >= 0);
-- FAILED é só para criação: sala com link salvo nunca volta a ser criada.
alter table private.google_meet_rooms drop constraint if exists google_meet_rooms_failed_without_space_check;
alter table private.google_meet_rooms add constraint google_meet_rooms_failed_without_space_check
  check (state <> 'FAILED' or space_name is null);

create index if not exists google_meet_rooms_retry_idx
  on private.google_meet_rooms(next_attempt_at) where state = 'FAILED';
create index if not exists google_meet_rooms_next_sync_idx
  on private.google_meet_rooms(next_sync_at) where state = 'READY' and sync_status in ('WAITING','PENDING');

comment on column private.google_meet_rooms.claim_id is
  'Reserva da criação da sala. Só quem tem a reserva grava o link; space criado por reserva perdida nunca é distribuído.';
comment on column private.google_meet_rooms.sync_status is
  'WAITING (nunca importada), PENDING (volta em next_sync_at), COMPLETE (tudo importado e presença avaliada), EXPIRED (janela de 7 dias passou).';

-- 2. Situação de cada documento ------------------------------------------------
create table if not exists private.google_meet_artifact_imports (
  lesson_session_id uuid not null,
  tenant_id text not null,
  provider_name text not null
    check (provider_name ~ '^conferenceRecords/[A-Za-z0-9_-]+/(transcripts|smartNotes)/[A-Za-z0-9_-]+$'),
  kind text not null check (kind in ('TRANSCRIPT','SMART_NOTES')),
  provider_state text check (provider_state is null or provider_state ~ '^[A-Z_]{1,40}$'),
  status text not null check (status in ('PENDING','IMPORTED','EMPTY','FAILED')),
  source text check (source is null or source in ('DRIVE_EXPORT','MEET_ENTRIES')),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,80}$'),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  revision_id uuid references private.meeting_artifact_revisions(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (lesson_session_id, provider_name),
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id)
);
alter table private.google_meet_artifact_imports enable row level security;
revoke all on private.google_meet_artifact_imports from public, anon, authenticated;
comment on table private.google_meet_artifact_imports is
  'Situação de cada documento do Meet por sessão (sem conteúdo). EMPTY é final; FAILED tenta de novo na próxima importação.';

-- 3. Origem do texto importado --------------------------------------------------
alter table private.meeting_artifact_revisions
  add column if not exists source text not null default 'DRIVE_EXPORT'
  check (source in ('DRIVE_EXPORT','MEET_ENTRIES'));

-- 4. Várias planilhas de presença da mesma sala -----------------------------------
alter table private.meeting_attendance_reports
  add column if not exists source_document_ids text[] not null default '{}'
  check (pg_catalog.array_to_string(source_document_ids, ',') ~ '^([A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*)?$');

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
  v_id uuid; v_version integer; v_parent uuid; v_status text;
  v_sources uuid[]; v_content jsonb; v_admin boolean := false;
  v_state text; v_claim uuid; v_automatic boolean; v_complete boolean;
  v_interval interval; v_closing boolean;
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

  if p_action = 'nonce_create' then
    delete from private.google_meet_oauth_states where expires_at < now() - interval '1 day';
    insert into private.google_meet_oauth_states(state_hash,tenant_id,actor_id,verifier_ciphertext,expires_at)
    values (p_payload->>'state_hash',p_tenant_id,p_actor_id,p_payload->>'verifier_ciphertext',now()+interval '10 minutes');
    return jsonb_build_object('ok',true);
  elsif p_action = 'connection_save' then
    insert into private.google_workspace_connections(tenant_id,organizer_sub,organizer_email,refresh_token_ciphertext,granted_scopes,status,connected_by)
    values (p_tenant_id,p_payload->>'organizer_sub',p_payload->>'organizer_email',p_payload->>'refresh_token_ciphertext',
      array(select jsonb_array_elements_text(p_payload->'granted_scopes')),'CONNECTED',p_actor_id)
    on conflict (tenant_id) do update set organizer_sub=excluded.organizer_sub,organizer_email=excluded.organizer_email,
      refresh_token_ciphertext=excluded.refresh_token_ciphertext,granted_scopes=excluded.granted_scopes,status='CONNECTED',
      connected_by=p_actor_id,connected_at=now(),updated_at=now(),last_error_code=null;
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
      jsonb_build_object('organizer_email',c.organizer_email,'status',c.status,'connected_at',c.connected_at,'last_error_code',c.last_error_code) end);
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
    if a.role='TEACHER' and not exists (
      select 1 from public.profiles student where student.id=s.student_id and student.tenant_id=s.tenant_id
      and (student.professor_id=a.id or student.professor_id2=a.id or exists (
        select 1 from public.bookings b where b.student_id=student.id and b.tenant_id=s.tenant_id
        and b.teacher_id=a.id and b.status='SCHEDULED'
      ))
    ) then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;

    if p_action='room_claim' then
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      if s.status='SUPERSEDED' then raise exception 'lesson_session_superseded' using errcode='22023'; end if;
      if a.role='TEACHER' and s.teacher_id<>a.id then raise exception 'session_teacher_required' using errcode='42501'; end if;
      v_automatic := coalesce((p_payload->>'automatic')::boolean,false);
      insert into private.google_meet_rooms(lesson_session_id,tenant_id,organizer_sub,cohost_email,state,created_by,claim_id,creation_attempts)
      values(s.id,s.tenant_id,p_payload->>'organizer_sub',p_payload->>'cohost_email','CREATING',a.id,pg_catalog.gen_random_uuid(),1)
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
             organizer_sub=p_payload->>'organizer_sub', cohost_email=p_payload->>'cohost_email',
             next_attempt_at=null, last_error_code=null, updated_at=now()
       where room.lesson_session_id=s.id and room.tenant_id=s.tenant_id and room.space_name is null
         and ((room.state='FAILED' and (not v_automatic or (room.next_attempt_at is not null and room.next_attempt_at<=now())))
           or (room.state in ('CREATING','NEEDS_RECONCILIATION') and room.updated_at<now()-interval '15 minutes'
             and (not v_automatic or room.creation_attempts<5)))
      returning * into r;
      if r.lesson_session_id is not null then
        insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_CREATION_RETRY_CLAIMED');
        return jsonb_build_object('claimed',true,'room',to_jsonb(r)); end if;
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
      insert into private.google_meet_generation_leases(lesson_session_id,tenant_id,acquired_at,actor_id)
      values(s.id,s.tenant_id,now(),a.id)
      on conflict (lesson_session_id) do update set acquired_at=now(),actor_id=a.id
      where private.google_meet_generation_leases.acquired_at < now()-interval '2 minutes'
      returning lesson_session_id into v_id;
      if v_id is null then raise exception 'google_summary_generation_rate_limited' using errcode='55000'; end if;
    elsif p_action='summary_save' then
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
    elsif p_action='session_detail' then
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(s.tenant_id,a.id,s.id,'READ_PEDAGOGICAL_DOCUMENTATION');
      return jsonb_build_object('session',to_jsonb(s),
        'room',(select to_jsonb(room)-'claim_id' from private.google_meet_rooms room where room.lesson_session_id=s.id),
        'artifacts',coalesce((select jsonb_agg(ar order by ar.imported_at desc) from private.meeting_artifact_revisions ar
          where ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id and ar.expires_at>now()),'[]'::jsonb),
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
        'summaries',coalesce((select jsonb_agg(sv order by sv.version desc) from private.lesson_summary_versions sv
          where sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id),'[]'::jsonb));
    else raise exception 'unknown_google_meet_action' using errcode='22023'; end if;
  end if;
  insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
  values(p_tenant_id,p_actor_id,p_session_id,p_action);
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.google_meet_backend(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.google_meet_backend(text,text,uuid,uuid,jsonb) to service_role;

-- 5. Fila -----------------------------------------------------------------------
-- Grupos de prioridade:
--   0 sala para aula nas próximas 3 h (sem sala a aula cai no link de sempre);
--   1 primeira importação depois do fim da aula (documentos já prontos);
--   2 sala para aula mais distante;
--   3 re-consulta de importação ainda pendente.
-- Até 30 trabalhos; a edge processa enquanto houver tempo (~100 s de 150 s).
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
      left join private.google_meet_rooms r on r.lesson_session_id=s.id
      where s.documentation_consent and s.status='SCHEDULED'
        and s.scheduled_start_at between now() and now()+interval '24 hours'
        and (r.lesson_session_id is null
          or (r.state='COHOST_PENDING' and r.organizer_sub=c.organizer_sub and r.updated_at<now()-interval '1 hour')
          or (r.space_name is null and r.state='FAILED' and r.next_attempt_at<=now())
          or (r.space_name is null and r.state in ('CREATING','NEEDS_RECONCILIATION')
            and r.updated_at<now()-interval '15 minutes' and r.creation_attempts<5))
        and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
        and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
    ) jobs
    order by jobs.priority_group,jobs.priority_at limit 30
  ) x;
$$;
revoke all on function public.get_pending_google_meet_sync_sessions() from public,anon,authenticated;
grant execute on function public.get_pending_google_meet_sync_sessions() to service_role;

-- 6. Link da aula ---------------------------------------------------------------
-- A sessão só volta (e o app deixa de usar o link de sempre) quando a sala da
-- escola existe ou ainda pode sair a tempo. Não volta quando:
--   * não há aceite nem sala (regra de 20260926160000);
--   * a sala falhou ou ficou para a direção reconciliar (FAILED,
--     NEEDS_RECONCILIATION) — o app cai no link de sempre;
--   * faltam menos de 15 min para o início (ou a aula já começou) e a sala não
--     está pronta — a aula nunca fica sem link.
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
      and (s.documentation_consent or r.lesson_session_id is not null)
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

-- 7. Presença: regras que não acusam aula remarcada por fora ----------------------
-- Partindo da definição viva (20260926140000). Mudam só duas condições:
--   late          — o professor entrou 10+ min depois do início E antes do fim
--                   previsto; entrar depois do fim é outro horário (remarcada),
--                   não atraso;
--   outside-room  — além de 2 h depois do fim, espera o DIA da aula acabar no
--                   fuso da escola: a busca de conferências cobre o dia todo, e
--                   a aula remarcada para a tarde ainda pode acontecer.
create or replace function private.meet_attendance_evaluate(
  p_session uuid,
  p_presence text,
  p_conference_count integer
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_report private.meeting_attendance_reports;
  v_opened text[] := '{}';
  v_flag record;
  v_case uuid;
  v_late_minutes integer;
begin
  select * into v_session from public.lesson_sessions where id = p_session;
  if not found or not v_session.documentation_consent then
    return jsonb_build_object('evaluated', false);
  end if;
  select * into v_report from private.meeting_attendance_reports
   where lesson_session_id = v_session.id and parse_error is null
   order by imported_at desc limit 1;

  for v_flag in
    select * from (values
      ('late', 'LATE_START', 'NORMAL',
        v_report.id is not null and v_report.teacher_first_join_at is not null
          and v_report.teacher_first_join_at > v_session.scheduled_start_at + interval '10 minutes'
          and v_report.teacher_first_join_at < v_session.scheduled_end_at),
      ('no-student', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence = 'COMPLETED' and coalesce(v_report.student_seconds, 0) < 300),
      ('absence-mismatch', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence = 'STUDENT_ABSENCE' and coalesce(v_report.student_seconds, 0) >= 600),
      ('no-teacher', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and coalesce(v_report.teacher_seconds, 0) < 300),
      ('outside-room', 'OUTSIDE_ROOM', 'LOW',
        coalesce(p_conference_count, -1) = 0 and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and v_session.scheduled_end_at < now() - interval '2 hours'
          and now() >= ((v_session.class_date + 1)::timestamp at time zone 'America/Sao_Paulo'))
    ) as rule(slug, category, severity, fires)
    where fires
  loop
    v_late_minutes := case when v_report.teacher_first_join_at is null then null
      else floor(extract(epoch from (v_report.teacher_first_join_at - v_session.scheduled_start_at)) / 60)::integer end;
    insert into public.lesson_quality_cases (tenant_id, session_id, student_id, teacher_id,
      category, source, severity, description, dedupe_key)
    values (v_session.tenant_id, v_session.id, v_session.student_id, v_session.teacher_id,
      v_flag.category, 'SYSTEM', v_flag.severity,
      case v_flag.slug
        when 'late' then 'Relatório de presença do Meet: o professor entrou ' || v_late_minutes
          || ' min depois do horário da aula.'
        when 'no-student' then 'Aula lançada como dada, mas o relatório de presença do Meet mostra o aluno por '
          || round(coalesce(v_report.student_seconds, 0) / 60.0) || ' min na sala da escola.'
        when 'absence-mismatch' then 'Aula lançada como falta do aluno, mas o relatório de presença do Meet mostra o aluno por '
          || round(v_report.student_seconds / 60.0) || ' min na sala da escola.'
        when 'no-teacher' then 'Aula lançada, mas o relatório de presença do Meet mostra o professor por '
          || round(coalesce(v_report.teacher_seconds, 0) / 60.0) || ' min na sala da escola.'
        else 'Aula lançada sem uso da sala da escola no Meet. Combine com o professor o uso da sala oficial.'
      end || ' Isto é um aviso para conversar com o professor: não altera o pagamento.',
      'meet:' || v_session.id || ':' || v_flag.slug)
    on conflict (tenant_id, dedupe_key) do nothing
    returning id into v_case;
    if v_case is not null then
      insert into public.lesson_quality_case_events (tenant_id, case_id, actor_id, event_type, details)
      values (v_session.tenant_id, v_case, null, 'MEET_ATTENDANCE_REPORT', jsonb_build_object(
        'rule', v_flag.slug,
        'logged_presence', p_presence,
        'scheduled_start_at', v_session.scheduled_start_at,
        'teacher_first_join_at', v_report.teacher_first_join_at,
        'teacher_minutes', round(coalesce(v_report.teacher_seconds, 0) / 60.0),
        'student_first_join_at', v_report.student_first_join_at,
        'student_minutes', round(coalesce(v_report.student_seconds, 0) / 60.0),
        'conference_count', p_conference_count,
        'report_id', v_report.id));
      v_opened := v_opened || v_flag.slug;
    end if;
    v_case := null;
  end loop;

  return jsonb_build_object('evaluated', true, 'presence', p_presence,
    'report_id', v_report.id, 'opened', to_jsonb(v_opened));
end;
$$;

-- A porta da presença passa a guardar todas as planilhas da sala.
create or replace function public.google_meet_attendance_backend(
  p_action text,
  p_tenant_id text,
  p_session_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_id uuid;
  v_retention integer;
begin
  select * into v_session from public.lesson_sessions
   where id = p_session_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'lesson_session_not_found' using errcode = '22023';
  end if;
  if not v_session.documentation_consent then
    raise exception 'documentation_consent_required' using errcode = '42501';
  end if;

  if p_action = 'attendance_save' then
    v_retention := greatest(7, least(365, coalesce((p_payload ->> 'retention_days')::integer, 90)));
    insert into private.meeting_attendance_reports (tenant_id, lesson_session_id, conference_name,
      document_id, document_name, content_sha256, source_csv, parse_error, participants,
      teacher_first_join_at, teacher_seconds, student_first_join_at, student_seconds, expires_at,
      source_document_ids)
    values (v_session.tenant_id, v_session.id, nullif(p_payload ->> 'conference_name', ''),
      p_payload ->> 'document_id', left(p_payload ->> 'document_name', 300),
      p_payload ->> 'content_sha256', p_payload ->> 'source_csv', nullif(p_payload ->> 'parse_error', ''),
      coalesce(p_payload -> 'participants', '[]'::jsonb),
      nullif(p_payload ->> 'teacher_first_join_at', '')::timestamptz,
      nullif(p_payload ->> 'teacher_seconds', '')::integer,
      nullif(p_payload ->> 'student_first_join_at', '')::timestamptz,
      nullif(p_payload ->> 'student_seconds', '')::integer,
      now() + make_interval(days => v_retention),
      array(select jsonb_array_elements_text(
        case when jsonb_typeof(p_payload -> 'source_document_ids') = 'array'
          then p_payload -> 'source_document_ids'
          else jsonb_build_array(p_payload ->> 'document_id') end)))
    on conflict (tenant_id, lesson_session_id, content_sha256) do nothing
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'inserted', v_id is not null);
  elsif p_action = 'attendance_evaluate' then
    return private.meet_attendance_evaluate(
      v_session.id,
      private.lesson_session_logged_presence(v_session.id),
      nullif(p_payload ->> 'conference_count', '')::integer
    );
  end if;
  raise exception 'unknown_attendance_action' using errcode = '22023';
end;
$$;
revoke all on function private.meet_attendance_evaluate(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.google_meet_attendance_backend(text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.google_meet_attendance_backend(text,text,uuid,jsonb) to service_role;
