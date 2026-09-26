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
--     escola READY, sessão viva, aceite vigente e é dada pelo professor da
--     sessão (o coanfitrião da sala) → o link enviado é o dela;
--   • senão → a mensagem de sempre, sem mudança nenhuma.
--
-- A sala exige documentation_consent = true, e não só "sala existe": a sala
-- transcreve sozinha, e quem revogou o aceite não pode ser mandado para lá pelo
-- WhatsApp (decisão da direção: sala da escola só com aceite). E o aceite
-- EFETIVO: recusa ou revogação que chegou antes do fim da aula, ou o aceite do
-- termo que caiu, barra na hora, antes de o job desmarcar a sessão
-- (private.lesson_session_documentation_blocked, de 20260926180000 — a mesma
-- régua de get_my_lesson_rooms).
--
-- A sala também exige que o professor da sessão seja quem DÁ a aula. Sessão com
-- aceite ou sala fica congelada (private.lesson_session_has_evidence): depois de
-- cobertura confirmada, reposição com professor trocado ou agendamento
-- transferido, o sync não troca o teacher_id da sessão, e a sala continua com o
-- coanfitrião antigo. Mandar o aluno para lá o deixaria esperando alguém que não
-- vem admitir, e dividiria a aula em duas salas. A régua de quem dá a aula é
-- private.lesson_occurrence_giver (20260926180000), a mesma do link do app
-- (get_my_lesson_rooms) e da preparação da sala na fila.
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

-- A primeira versão (sem o professor) nunca foi publicada; se existir num banco
-- de teste, sai, para o PostgREST não ter duas candidatas com o mesmo nome.
drop function if exists public.official_lesson_link(text, text, text, date, time, uuid);

-- Sala oficial da ocorrência. NULL quando não há sala pronta, quando a sessão foi
-- substituída, quando o aceite não vale mais, quando a sessão é de outro
-- professor, ou quando a identidade é ambígua (duas salas diferentes para a
-- mesma aula) — mandar a sala errada é pior do que mandar a mensagem de sempre.
--
-- p_teacher_id é o professor da agenda (booking/reposição/experimental). Em
-- cobertura viva do agendamento naquela data quem dá a aula é o substituto — a
-- mesma regra de private.lesson_quality_sources — e a sala só vale se a sessão
-- for dele. A cobertura é casada pelo agendamento + data, sem o horário: ela fica
-- amarrada ao slot do booking mesmo quando o horário combinado é outro, e o
-- índice único class_coverages_live_booking_date_uidx já é por (booking, data).
create or replace function public.official_lesson_link(
  p_tenant text,
  p_source_type text,
  p_source_id text,
  p_class_date date,
  p_teacher_id uuid,
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
  where p_teacher_id is not null
    and occurrence.tenant_id = p_tenant
    and occurrence.source_type = pg_catalog.lower(
      pg_catalog.btrim(coalesce(p_source_type, ''))
    )
    and occurrence.source_id = pg_catalog.btrim(coalesce(p_source_id, ''))
    and occurrence.class_date = p_class_date
    and occurrence.status <> 'SUPERSEDED'
    and (p_start_time is null or occurrence.start_time = p_start_time)
    and session.status <> 'SUPERSEDED'
    and session.documentation_consent
    -- Aceite EFETIVO, a mesma régua de get_my_lesson_rooms e da porta do Meet
    -- (20260926180000): recusa ou revogação que chegou antes do fim da aula já
    -- vale, mesmo antes de o job de 15 min desmarcar a sessão.
    and not private.lesson_session_documentation_blocked(session.id)
    and (p_student_id is null or session.student_id = p_student_id)
    -- Quem dá a aula: o professor da agenda, ou o substituto da cobertura viva.
    -- Duas coberturas com substitutos diferentes (ou sem substituto) não têm
    -- dono claro: nenhuma sala. A régua é a do link do app e da fila
    -- (private.lesson_occurrence_giver, 20260926180000).
    and session.teacher_id = private.lesson_occurrence_giver(
      occurrence.tenant_id, occurrence.source_type, occurrence.source_id,
      occurrence.class_date, p_teacher_id
    )
    and room.state = 'READY'
    and room.meeting_uri ~ '^https://meet[.]google[.]com/[a-z-]+$'
$function$;

alter function public.official_lesson_link(text, text, text, date, uuid, time, uuid)
  owner to postgres;
revoke all on function public.official_lesson_link(text, text, text, date, uuid, time, uuid)
  from public, anon, authenticated;
grant execute on function public.official_lesson_link(text, text, text, date, uuid, time, uuid)
  to service_role;

-- Texto do lembrete. Sem link, devolve o que
-- private.render_lesson_notification_message devolvia (decisão de 16/09: o link
-- pessoal não vai no lembrete automático), só que sem quebra de linha sobrando
-- nas pontas.
--   • p_official_link (só https://meet.google.com/<código>): entra no lugar do
--     {class_link}; se o modelo não tem o marcador, vai numa linha própria no fim,
--     dizendo que a aula é na sala da escola.
--   • p_personal_link: só o botão "Disparar" passa — é o comportamento que ele
--     já tinha. Entra apenas no {class_link}, nunca é acrescentado.
--
-- O resto do modelo passa pelo MESMO renderizador de antes: o marcador vira um
-- sentinela que ele não toca (sem chaves; "~" não sobrevive em nome, que passa
-- por safe_notification_text) e só depois o sentinela vira o link.
--
-- Pontas: o renderizador antigo apara só espaço. Modelo terminado (ou começado)
-- em {class_link} numa aula sem link sobrava com "\n\n" na ponta; o worker, que
-- apara, mandava o texto sem ela e a cerca recusava o lembrete inteiro. Aqui as
-- pontas saem sem espaço, tabulação nem quebra de linha — o worker e a cerca
-- recebem o MESMO texto limpo.
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
  c_edges constant text := E' \t\n';
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
    return pg_catalog.btrim(
      private.render_lesson_notification_message(
        p_template, p_student_name, p_class_time,
        p_teacher_name, p_tenant_name, null
      ),
      c_edges
    );
  end if;

  if v_template ~* c_marker then
    v_message := private.render_lesson_notification_message(
      pg_catalog.regexp_replace(v_template, c_marker, c_sentinel, 'gi'),
      p_student_name, p_class_time, p_teacher_name, p_tenant_name, null
    );
    return pg_catalog.btrim(
      pg_catalog.left(
        pg_catalog.replace(v_message, c_sentinel, v_link),
        4096
      ),
      c_edges
    );
  end if;

  v_message := pg_catalog.btrim(
    private.render_lesson_notification_message(
      p_template, p_student_name, p_class_time,
      p_teacher_name, p_tenant_name, null
    ),
    c_edges
  );
  if v_official is null then
    return v_message;
  end if;

  -- O corte de 4096 cai no corpo, nunca no link.
  v_line := c_notice || E'\n' || v_official;
  return pg_catalog.rtrim(
    pg_catalog.left(
      v_message,
      4096 - pg_catalog.char_length(v_line) - 2
    ),
    c_edges
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
-- renderização e a conferência do lembrete mudam. Reexecutável: se a cerca já
-- tem o patch, não faz nada; se a âncora sumiu, a migration falha em vez de
-- deixar a cerca recusando todo lembrete com sala.
--
-- Conferência nova, além da sala:
--   • a sala sai de official_lesson_link com o professor da agenda
--     (v_teacher_id), o mesmo que o worker passa;
--   • a sala pode ficar pronta — ou deixar de valer — entre a montagem do texto
--     no worker e esta conferência (o worker ainda resolve o JID e pede licença
--     à régua de envio, que pode dormir 12 s). Se o texto recebido é exatamente
--     o lembrete desta aula com o OUTRO estado da sala desta aula, nada mais
--     mudou: RETRY devolve à fila e o worker remonta. Antes do patch isso virava
--     REVIEW_REQUIRED e o lembrete era descartado para sempre ('skipped'; o
--     prepare-daily-reminders não reenfileira, por causa da idempotência).
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
    );

    if v_current_destination <> v_expected_destination
       or not private.notification_phones_same_recipient(
         v_current_destination,
         v_provider_destination
       )
       or v_current_message is distinct from v_expected_message then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'lesson_authorized_snapshot_changed'
      );
    end if;$anchor$;
  v_replacement constant text := $replacement$    -- Sala oficial da escola (migration 20260926190000): o lembrete confere com
    -- o mesmo renderizador do worker e a sala da aula de quem a dá. v_class_link
    -- (link pessoal) não entra: desde 16/09/2026 ele não vai no lembrete
    -- automático.
    declare
      v_official_room text := public.official_lesson_link(
        v_notification.tenant_id,
        v_source_type,
        v_notification.source_id::text,
        v_ref_date,
        v_teacher_id,
        v_class_time::time,
        v_student_id
      );
      v_expected_room text;
    begin
      v_current_message := public.render_lesson_reminder_message(
        v_teacher.lesson_reminder_template,
        pg_catalog.split_part(v_student_name, ' ', 1),
        v_class_time,
        private.safe_notification_text(v_teacher.full_name, 180),
        private.safe_notification_text(v_tenant.name, 180),
        v_official_room,
        null
      );

      if v_current_destination <> v_expected_destination
         or not private.notification_phones_same_recipient(
           v_current_destination,
           v_provider_destination
         ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'lesson_authorized_snapshot_changed'
        );
      end if;

      if v_current_message is distinct from v_expected_message then
        -- Só a sala mudou? O link citado no texto recebido tem de ser uma sala
        -- desta aula (qualquer estado); o texto, o deste lembrete com essa sala
        -- (sala nova, ou outra sala desta aula) ou sem sala nenhuma (a sala que
        -- ficou pronta agora). Qualquer outra diferença continua REVIEW.
        v_expected_room := (pg_catalog.regexp_match(
          v_expected_message,
          'https://meet[.]google[.]com/[a-z-]+'
        ))[1];
        if v_expected_room is not null and not exists (
          select 1
          from public.lesson_occurrences as occurrence
          join private.google_meet_rooms as room
            on room.lesson_session_id = occurrence.session_id
           and room.tenant_id = occurrence.tenant_id
          where occurrence.tenant_id = v_notification.tenant_id
            and occurrence.source_type = pg_catalog.lower(v_source_type)
            and occurrence.source_id = v_notification.source_id::text
            and occurrence.class_date = v_ref_date
            and room.meeting_uri = v_expected_room
        ) then
          v_expected_room := null;
        end if;

        if v_expected_message = public.render_lesson_reminder_message(
             v_teacher.lesson_reminder_template,
             pg_catalog.split_part(v_student_name, ' ', 1),
             v_class_time,
             private.safe_notification_text(v_teacher.full_name, 180),
             private.safe_notification_text(v_tenant.name, 180),
             case
               when v_expected_room is distinct from v_official_room
                 then v_expected_room
             end,
             null
           ) then
          return pg_catalog.jsonb_build_object(
            'ok', false,
            'action', 'RETRY',
            'reason', 'official_lesson_room_changed'
          );
        end if;

        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'lesson_authorized_snapshot_changed'
        );
      end if;
    end;$replacement$;
  v_definition text;
  v_occurrences integer;
begin
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if pg_catalog.strpos(v_definition, v_replacement) > 0 then
    return;
  end if;
  v_occurrences := (
    pg_catalog.char_length(v_definition) - pg_catalog.char_length(
      pg_catalog.replace(v_definition, v_anchor, '')
    )
  ) / pg_catalog.char_length(v_anchor);
  if v_occurrences <> 1 then
    raise exception
      'lembrete com sala oficial: âncora da conferência do lembrete encontrada % vez(es) na cerca de envio',
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
