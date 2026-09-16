-- ─────────────────────────────────────────────────────────────────────────────
-- O aluno confirma se a experimental aconteteu (16/09/2026)
--
-- Pergunta da direção: "e se o professor mentir que a aula foi feita?". Hoje o
-- "sim" dele lança a aula e libera o pagamento — uma fonte só, e é a parte
-- interessada. A escola já resolveu isso para a aula regular (o aluno confirma
-- em `attendance_confirmations` e divergência trava o pagamento com
-- `class_logs.payment_hold`). Falta a experimental.
--
-- Aqui a segunda fonte é a MESMA conversa que já acontece: logo depois do "sim"
-- do professor, o aluno recebe a mensagem sobre a matrícula, que começa
-- confirmando a aula. Se ele desmentir, a aula sai da folha na hora, a Gestão é
-- avisada e a venda para — não vale seguir vendendo para quem não teve aula.
--
-- Não se marca falta do professor automaticamente: quem decide isso é gente,
-- com os dois lados. O que o bot faz é segurar o dinheiro e avisar.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'trial_closing_flows_stage_chk') then
    alter table private.trial_closing_flows drop constraint trial_closing_flows_stage_chk;
  end if;
  alter table private.trial_closing_flows
    add constraint trial_closing_flows_stage_chk
    check (stage in ('ASK_TEACHER', 'ASK_STUDENT', 'OFFER_SENT', 'NO_SHOW', 'DISPUTED'));
end $$;

create or replace function public.trial_closing_student_denies(p_tenant text, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_teacher text;
  v_held integer := 0;
begin
  if p_tenant is null or coalesce(pg_catalog.btrim(coalesce(p_phone, '')), '') = '' then
    return pg_catalog.jsonb_build_object('handled', false);
  end if;
  select * into v_flow
    from private.trial_closing_flows
   where tenant_id = p_tenant
     and stage in ('ASK_STUDENT', 'OFFER_SENT')
     and private.notification_phones_same_recipient(lead_phone, private.trial_closing_phone(p_phone))
   order by created_at desc
   limit 1
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;

  -- O dinheiro para aqui: a folha e o fechamento já ignoram aula em payment_hold.
  update public.class_logs
     set payment_hold = true
   where appointment_id = v_flow.appointment_id::text
     and tenant_id = v_flow.tenant_id;
  get diagnostics v_held = row_count;

  update private.trial_closing_flows
     set stage = 'DISPUTED', last_error = 'aluno_nega_a_aula', updated_at = pg_catalog.now()
   where id = v_flow.id;

  select full_name into v_teacher from public.profiles where id = v_flow.teacher_id;

  perform private.notify_management_group(
    v_flow.tenant_id, null, v_flow.teacher_id, v_flow.id,
    'trial-closing-disputed:' || v_flow.id::text,
    '🚨 Experimental contestada pelo aluno' || chr(10) ||
    'Aluno: ' || coalesce(v_flow.lead_name, 'sem nome') || chr(10) ||
    'Professor: ' || coalesce(v_teacher, '—') || chr(10) ||
    'O professor registrou que a aula aconteceu; o aluno diz que não. ' ||
    'O pagamento dessa aula ficou retido até alguém conferir os dois lados' ||
    case when v_held = 0 then ' (não havia aula lançada para reter).' else '.' end
  );

  return pg_catalog.jsonb_build_object(
    'handled', true, 'flow_id', v_flow.id, 'lead_name', v_flow.lead_name,
    'teacher_name', v_teacher, 'payment_held', v_held > 0
  );
end $fn$;

alter function public.trial_closing_student_denies(text, text) owner to postgres;
revoke all on function public.trial_closing_student_denies(text, text) from public, anon, authenticated;
grant execute on function public.trial_closing_student_denies(text, text) to service_role;
