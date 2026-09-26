-- A Direção pode autorizar pontualmente a entrega de uma contraproposta
-- durante um handoff humano. A autorização fica no plano do fluxo específico;
-- mensagens novas ao aluno e a trava de envio único continuam obrigatórias.
do $migration$
declare
  original_sql text;
  patched_sql text;
  old_open text := E'    and not exists (\n      select 1 from public.whatsapp_conversations as conversation';
  new_open text := E'    and (flow.plan ? ''teacher_counterproposal_override_authorized_at'' or not exists (\n      select 1 from public.whatsapp_conversations as conversation';
  old_close text := E'        and conversation.human_handoff_until > pg_catalog.now()\n    )';
  new_close text := E'        and conversation.human_handoff_until > pg_catalog.now()\n    ))';
begin
  select pg_get_functiondef(
    'public.trial_closing_claim_teacher_counterproposal_student(uuid)'::regprocedure
  ) into original_sql;

  if original_sql is null then
    raise exception 'trial_closing_counterproposal_claim_missing';
  end if;
  if position('''teacher_counterproposal_override_authorized_at''' in original_sql) > 0 then
    return;
  end if;
  if position(old_open in original_sql) = 0
     or position(old_close in original_sql) = 0 then
    raise exception 'trial_closing_counterproposal_claim_definition_changed';
  end if;

  patched_sql := replace(replace(original_sql, old_open, new_open), old_close, new_close);
  execute patched_sql;
end;
$migration$;
