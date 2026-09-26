-- ─────────────────────────────────────────────────────────────────────────────
-- Lembrete do WhatsApp leva a sala oficial da escola (26/09/2026)
--
-- Aula com termo de registro aceito ganha uma sala do Google Meet criada pela
-- conta central (private.google_meet_rooms). É nela que a transcrição, as
-- anotações e o relatório de presença acontecem. O lembrete de 30 minutos e o
-- botão "Disparar" não sabiam dessa sala: o aluno ia para o link de sempre e a
-- aula saía sem registro (e a Central de Qualidade abria OUTSIDE_ROOM).
--
-- Regra desta migration, igual nos três caminhos (prepare-daily-reminders,
-- process-notification-queue e send-class-notification):
--   • a aula (agendamento, reposição ou antecipação naquela data) tem sala da
--     escola READY, sessão viva e aceite vigente → o link enviado é o dela;
--   • senão → a mensagem de sempre, sem mudança nenhuma.
--
-- A sala exige documentation_consent = true, e não só "sala existe" como o
-- get_my_lesson_rooms: a sala transcreve sozinha, e quem revogou o aceite não
-- pode ser mandado para lá pelo WhatsApp (decisão da direção: sala da escola só
-- com aceite).
--
-- O texto do lembrete tem UMA fonte: public.render_lesson_reminder_message. O
-- worker renderiza por ela e a cerca do banco
-- (begin_notification_delivery_submission) confere com ela. Antes eram dois
-- renderizadores que divergiam: o TypeScript achatava o modelo do professor
-- (safeCommunicationText troca _ e * por espaço e junta as linhas) e ainda punha
-- o link pessoal no {class_link}, enquanto o SQL preservava a formatação e
-- apagava o link. Resultado medido em produção: 45 lembretes da professora
-- Débora recusados como lesson_authorized_snapshot_changed entre 16/09 e 25/09
-- (0 enviados; o modelo dela tem {class_link}).
-- ─────────────────────────────────────────────────────────────────────────────

-- Sala oficial da ocorrência. NULL quando não há sala pronta, quando a sessão foi
-- substituída, quando o aceite não vale mais, ou quando a identidade é ambígua
-- (duas salas diferentes para a mesma aula) — mandar a sala errada é pior do que
-- mandar a mensagem de sempre.
create or replace function public.official_lesson_link(
  p_tenant text,
  p_source_type text,
  p_source_id text,
  p_class_date date,
  p_start_time time default null,
  p_student_id uuid default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when pg_catalog.count(distinct room.meeting_uri) = 1
      then pg_catalog.min(room.meeting_uri)
  end
  from public.lesson_occurrences as occurrence
  join public.lesson_sessions as session
    on session.id = occurrence.session_id
   and session.tenant_id = occurrence.tenant_id
  join private.google_meet_rooms as room
    on room.lesson_session_id = session.id
   and room.tenant_id = session.tenant_id
  where occurrence.tenant_id = p_tenant
    and occurrence.source_type = pg_catalog.lower(
      pg_catalog.btrim(coalesce(p_source_type, ''))
    )
    and occurrence.source_id = pg_catalog.btrim(coalesce(p_source_id, ''))
    and occurrence.class_date = p_class_date
    and occurrence.status <> 'SUPERSEDED'
    and (p_start_time is null or occurrence.start_time = p_start_time)
    and session.status <> 'SUPERSEDED'
    and session.documentation_consent
    and (p_student_id is null or session.student_id = p_student_id)
    and room.state = 'READY'
    and room.meeting_uri ~ '^https://meet[.]google[.]com/[a-z-]+$'
$function$;

alter function public.official_lesson_link(text, text, text, date, time, uuid)
  owner to postgres;
revoke all on function public.official_lesson_link(text, text, text, date, time, uuid)
  from public, anon, authenticated;
grant execute on function public.official_lesson_link(text, text, text, date, time, uuid)
  to service_role;

-- Texto do lembrete. Sem link, devolve EXATAMENTE o que
-- private.render_lesson_notification_message devolvia (decisão de 16/09: o link
-- pessoal não vai no lembrete automático).
--   • p_official_link (só https://meet.google.com/<código>): entra no lugar do
--     {class_link}; se o modelo não tem o marcador, vai numa linha própria no fim,
--     dizendo que a aula é na sala da escola.
--   • p_personal_link: só o botão "Disparar" passa — é o comportamento que ele
--     já tinha. Entra apenas no {class_link}, nunca é acrescentado.
--
-- O resto do modelo passa pelo MESMO renderizador de antes: o marcador vira um
-- sentinela que ele não toca (sem chaves; "~" não sobrevive em nome, que passa
-- por safe_notification_text) e só depois o sentinela vira o link.
create or replace function public.render_lesson_reminder_message(
  p_template text,
  p_student_name text,
  p_class_time text,
  p_teacher_name text,
  p_tenant_name text,
  p_official_link text,
  p_personal_link text default null
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  c_sentinel constant text := '~~WWCLASSLINK~~';
  c_marker constant text := '\{\s*class[ _-]*link\s*\}';
  c_notice constant text :=
    'Esta aula é na sala da escola no Google Meet. Entre por este link:';
  v_official text;
  v_personal text := private.safe_notification_text(p_personal_link, 300);
  v_link text;
  v_template text := private.safe_notification_template(p_template);
  v_message text;
  v_line text;
begin
  if pg_catalog.btrim(coalesce(p_official_link, '')) ~
       '^https://meet[.]google[.]com/[a-z-]+$' then
    v_official := pg_catalog.btrim(p_official_link);
  end if;
  v_link := coalesce(v_official, nullif(v_personal, ''));

  if v_link is null then
    return private.render_lesson_notification_message(
      p_template, p_student_name, p_class_time,
      p_teacher_name, p_tenant_name, null
    );
  end if;

  if v_template ~* c_marker then
    v_message := private.render_lesson_notification_message(
      pg_catalog.regexp_replace(v_template, c_marker, c_sentinel, 'gi'),
      p_student_name, p_class_time, p_teacher_name, p_tenant_name, null
    );
    return pg_catalog.left(
      pg_catalog.replace(v_message, c_sentinel, v_link),
      4096
    );
  end if;

  v_message := private.render_lesson_notification_message(
    p_template, p_student_name, p_class_time,
    p_teacher_name, p_tenant_name, null
  );
  if v_official is null then
    return v_message;
  end if;

  -- O corte de 4096 cai no corpo, nunca no link.
  v_line := c_notice || E'\n' || v_official;
  return pg_catalog.left(
    v_message,
    4096 - pg_catalog.char_length(v_line) - 2
  ) || E'\n\n' || v_line;
end;
$function$;

alter function public.render_lesson_reminder_message(
  text, text, text, text, text, text, text
) owner to postgres;
revoke all on function public.render_lesson_reminder_message(
  text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.render_lesson_reminder_message(
  text, text, text, text, text, text, text
) to service_role;

-- A cerca do envio passa a conferir o lembrete com a sala oficial. Patch por
-- âncora na definição VIVA (a função nasceu por rename em
-- 20260831054448_harden_trial_conversion_lifecycle e tem 760 linhas): só a
-- chamada do renderizador muda. Reexecutável: se a sala já está lá, não faz nada;
-- se a âncora sumiu, a migration falha em vez de deixar a cerca recusando todo
-- lembrete com sala.
do $patch$
declare
  v_signature constant regprocedure :=
    'public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure;
  v_anchor constant text := $anchor$    v_current_message := private.render_lesson_notification_message(
      v_teacher.lesson_reminder_template,
      pg_catalog.split_part(v_student_name, ' ', 1),
      v_class_time,
      private.safe_notification_text(v_teacher.full_name, 180),
      private.safe_notification_text(v_tenant.name, 180),
      v_class_link
    );$anchor$;
  v_replacement constant text := $replacement$    -- Sala oficial da escola (migration 20260926190000): o lembrete confere com
    -- o mesmo renderizador do worker. v_class_link (link pessoal) não entra:
    -- desde 16/09/2026 ele não vai no lembrete automático.
    v_current_message := public.render_lesson_reminder_message(
      v_teacher.lesson_reminder_template,
      pg_catalog.split_part(v_student_name, ' ', 1),
      v_class_time,
      private.safe_notification_text(v_teacher.full_name, 180),
      private.safe_notification_text(v_tenant.name, 180),
      public.official_lesson_link(
        v_notification.tenant_id,
        v_source_type,
        v_notification.source_id::text,
        v_ref_date,
        v_class_time::time,
        v_student_id
      ),
      null
    );$replacement$;
  v_definition text;
  v_occurrences integer;
begin
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if pg_catalog.strpos(v_definition, 'public.official_lesson_link(') > 0 then
    return;
  end if;
  v_occurrences := (
    pg_catalog.char_length(v_definition) - pg_catalog.char_length(
      pg_catalog.replace(v_definition, v_anchor, '')
    )
  ) / pg_catalog.char_length(v_anchor);
  if v_occurrences <> 1 then
    raise exception
      'lembrete com sala oficial: âncora do renderizador encontrada % vez(es) na cerca de envio',
      v_occurrences;
  end if;
  execute pg_catalog.replace(v_definition, v_anchor, v_replacement);
end
$patch$;

alter function public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
  uuid, uuid, text, text, text, text, uuid, bigint
) owner to postgres;

-- As duas RPCs novas são chamadas pelas edge functions via PostgREST.
notify pgrst, 'reload schema';
