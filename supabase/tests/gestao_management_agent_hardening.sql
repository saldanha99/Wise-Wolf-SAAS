\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

select pg_temp.assert_true(
  to_regclass('public.gestao_action_audit') is not null
  and not has_table_privilege('anon', 'public.gestao_action_audit', 'SELECT')
  and not has_table_privilege('authenticated', 'public.gestao_action_audit', 'SELECT')
  and has_table_privilege('service_role', 'public.gestao_action_audit', 'INSERT'),
  'management audit is missing or exposed to clients'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_attribute
     where attrelid = 'public.gestao_acao_pendente'::regclass
       and attname = 'requested_by_user_id'
       and atttypid = 'uuid'::regtype
       and not attisdropped
  )
  and exists (
    select 1
      from pg_catalog.pg_attribute
     where attrelid = 'public.gestao_acao_pendente'::regclass
       and attname = 'status'
       and not attisdropped
  )
  and to_regclass('public.gestao_acao_pendente_tenant_status_expiry_idx')
        is not null,
  'pending actions are not actor-bound and indexed'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.gestao_acao_pendente'::regclass
       and tgname = 'trg_protect_management_action_execution'
       and not tgisinternal
  )
  and pg_get_functiondef(
    'public.protect_management_action_execution()'::regprocedure
  ) ilike '%management_action_in_progress%'
  and pg_get_functiondef(
    'public.protect_management_action_execution()'::regprocedure
  ) ilike '%OLD.status = ''executing''%',
  'an executing management action can still be overwritten or deleted'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)',
    'EXECUTE'
  ),
  'coverage invite executor is callable outside service role'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  )
  and pg_get_functiondef(
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)'::regprocedure
  ) ilike '%pg_advisory_xact_lock%'
  and pg_get_functiondef(
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)'::regprocedure
  ) ilike '%p_expected_student_id%',
  'management schedule executor is exposed or not transactional'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)'::regprocedure
  ) ilike '%v_booking.date IS NOT NULL%'
  and pg_get_functiondef(
    'public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)'::regprocedure
  ) ilike '%ocorrencia_pontual_exige_remarcacao_por_data%',
  'recurring schedule action can mutate a fixed-date occurrence'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.normalize_booking_occurrence()'::regprocedure
  ) ilike '%schedule:teacher:%'
  and pg_get_functiondef(
    'public.normalize_booking_occurrence()'::regprocedure
  ) ilike '%booking_conflicts_with_active_coverage%',
  'booking writers do not serialize against active coverages'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.class_coverages'::regclass
       and tgname = 'trg_enforce_active_class_coverage_slot'
       and not tgisinternal
  )
  and pg_get_functiondef(
    'public.enforce_active_class_coverage_slot()'::regprocedure
  ) ilike '%pg_advisory_xact_lock%'
  and pg_get_functiondef(
    'public.enforce_active_class_coverage_slot()'::regprocedure
  ) ilike '%active_coverage_slot_conflict%'
  and pg_get_functiondef(
    'public.enforce_active_class_coverage_slot()'::regprocedure
  ) ilike '%public.parse_lesson_date(reschedule.date)%',
  'coverage panel and group do not share an atomic integrity barrier'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'private.lock_coverage_absence_pair(uuid,uuid,date)'::regprocedure
  ) ilike '%least(p_original_teacher::text, p_cover_teacher::text)%'
  and pg_get_functiondef(
    'public.protect_absence_active_coverages()'::regprocedure
  ) ilike '%pg_try_advisory_xact_lock%'
  and pg_get_functiondef(
    'public.protect_booking_source_coverage()'::regprocedure
  ) ilike '%coverage.class_log_id IS NULL%',
  'coverage source rows are missing ordered locks or settlement protection'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.class_logs'::regclass
       and tgname = 'trg_link_class_log_to_confirmed_coverage'
       and not tgisinternal
  )
  and pg_get_functiondef(
    'public.link_class_log_to_confirmed_coverage()'::regprocedure
  ) ilike '%coverage.class_log_id IS NULL%'
  and pg_get_functiondef(
    'public.link_class_log_to_confirmed_coverage()'::regprocedure
  ) ilike '%class_log_match_kind = ''booking_time''%',
  'future confirmed coverage is not linked to its eventual class log'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.gestao_lanca_ajuste_idempotente(text,text,uuid,uuid,text,text,numeric,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.gestao_lanca_ajuste_idempotente(text,text,uuid,uuid,text,text,numeric,text)',
    'EXECUTE'
  )
  and to_regclass('public.closing_adjustments_tenant_request_uidx') is not null
  and pg_get_functiondef(
    'public.gestao_lanca_ajuste_idempotente(text,text,uuid,uuid,text,text,numeric,text)'::regprocedure
  ) ilike '%pg_advisory_xact_lock%',
  'teacher payout adjustment is not service-only and idempotent'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'service_role',
    'public.gestao_lanca_ajuste(text,uuid,text,text,numeric,text)',
    'EXECUTE'
  ),
  'legacy non-idempotent payout adjustment remains callable'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.refresh_teacher_closing_snapshot(text,uuid,text,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.refresh_teacher_closing_snapshot(text,uuid,text,boolean)',
    'EXECUTE'
  )
  and pg_get_functiondef(
    'private.refresh_teacher_closing_snapshot(text,uuid,text,boolean)'::regprocedure
  ) ilike '%closing_adjustments%'
  and pg_get_functiondef(
    'private.refresh_teacher_closing_snapshot(text,uuid,text,boolean)'::regprocedure
  ) ilike '%closing_carryovers%'
  and pg_get_functiondef(
    'public.run_monthly_teacher_closing(text)'::regprocedure
  ) ilike '%private.refresh_teacher_closing_snapshot%'
  and pg_get_functiondef(
    'public.run_monthly_teacher_closing(text)'::regprocedure
  ) ilike '%ORDER BY teacher.tenant_id, teacher.id%'
  and pg_get_functiondef(
    'public.set_closing_adjustment(uuid,text,text,numeric,uuid)'::regprocedure
  ) ilike '%private.lock_teacher_closing_pair%'
  and pg_get_functiondef(
    'public.set_closing_adjustment(uuid,text,text,numeric,uuid)'::regprocedure
  ) ilike '%private.refresh_teacher_closing_snapshot%'
  and pg_get_functiondef(
    'public.set_closing_adjustment(uuid,text,text,numeric,uuid)'::regprocedure
  ) ilike '%actor.lifecycle_status%'
  and pg_get_functiondef(
    'private.teacher_pending_carryover_in_tenant(text,uuid)'::regprocedure
  ) ilike '%payable.tenant_id = p_tenant%'
  and not has_function_privilege(
    'authenticated',
    'public.teacher_pending_carryover_in_tenant(text,uuid)',
    'EXECUTE'
  ),
  'monthly closing and management adjustments do not share a canonical total'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.teacher_transfers'::regclass
       and tgname = 'trg_protect_active_teacher_transfer'
       and not tgisinternal
  )
  and pg_get_functiondef(
    'public.protect_active_teacher_transfer()'::regprocedure
  ) ilike '%active_teacher_transfer_exists%',
  'concurrent active teacher transfers remain possible for one student'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon', 'public.resolve_coverage_invite(text,boolean)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.resolve_coverage_invite(text,boolean)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.resolve_coverage_invite(text,boolean)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.apply_coverage_acceptance(uuid)', 'EXECUTE'
  ),
  'public coverage acceptance can bypass the token resolver'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated', 'public.gestao_resolve_professor(text,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.gestao_resolve_aluno(text,text)', 'EXECUTE'
  )
  and pg_get_functiondef(
    'public.gestao_resolve_professor(text,text)'::regprocedure
  ) ilike '%membership.tenant_id = p_tenant%'
  and pg_get_functiondef(
    'public.gestao_resolve_aluno(text,text)'::regprocedure
  ) ilike '%membership.tenant_id = p_tenant%'
  and not has_function_privilege(
    'authenticated', 'public.gestao_faltas(text,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.gestao_alunos_sem_cobranca(text,text)',
    'EXECUTE'
  ),
  'internal management reports remain exposed through the Data API'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.coverages_for_teacher_in_tenant(text,uuid,date,date)',
    'EXECUTE'
  )
  and pg_get_functiondef(
    'public.coverages_for_teacher_in_tenant(text,uuid,date,date)'::regprocedure
  ) ilike '%membership.tenant_id = p_tenant%'
  and pg_get_functiondef(
    'public.coverages_for_teacher_in_tenant(text,uuid,date,date)'::regprocedure
  ) ilike '%coverage.tenant_id = p_tenant%'
  and
  has_function_privilege(
    'authenticated', 'public.coverages_for_teacher(uuid,date,date)', 'EXECUTE'
  )
  and pg_get_functiondef(
    'public.coverages_for_teacher(uuid,date,date)'::regprocedure
  ) ilike '%actor_membership.user_id = v_actor_id%'
  and pg_get_functiondef(
    'public.coverages_for_teacher(uuid,date,date)'::regprocedure
  ) ilike '%teacher_membership.tenant_id = coverage.tenant_id%',
  'teacher coverage reader lost compatibility or tenant authorization'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)'::regprocedure
  ) ilike '%pg_advisory_xact_lock%'
  and pg_get_functiondef(
    'public.resolve_coverage_invite(text,boolean)'::regprocedure
  ) ilike '%for update%'
  and pg_get_functiondef(
    'public.resolve_coverage_invite(text,boolean)'::regprocedure
  ) ilike '%membership.status = ''ACTIVE''%'
  and pg_get_functiondef(
    'public.resolve_coverage_invite(text,boolean)'::regprocedure
  ) ilike '%conflito_criado_apos_o_convite%'
  and pg_get_functiondef(
    'public.apply_coverage_acceptance(uuid)'::regprocedure
  ) ilike '%class_log.tenant_id = v_cov.tenant_id%'
  and pg_get_functiondef(
    'public.apply_coverage_acceptance(uuid)'::regprocedure
  ) ilike '%class_log.start_time = v_time%'
  and pg_get_functiondef(
    'public.apply_coverage_acceptance(uuid)'::regprocedure
  ) ilike '%class_log_match_kind%'
  and pg_get_functiondef(
    'public.apply_coverage_acceptance(uuid)'::regprocedure
  ) ilike '%FOR UPDATE%'
  and pg_get_functiondef(
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)'::regprocedure
  ) ilike '%public.parse_lesson_date(reschedule.date) = p_class_date%'
  and to_regclass('public.class_coverages_tenant_request_uidx') is not null,
  'coverage writes are missing lock or idempotency protection'
);

rollback;
