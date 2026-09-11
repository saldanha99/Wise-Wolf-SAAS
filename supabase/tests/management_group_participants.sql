-- Run in a transaction and roll back. No external notifications are generated.
set local request.jwt.claims = '{"role":"service_role"}';
update public.dre_report_settings set destino='120363000000000001@g.us', is_active=true,allow_group_member_actions=true where tenant_id='school-wise-wolf';
insert into public.gestao_acao_pendente(group_jid,tenant_id,acao,resumo,request_id,tool_name,status,requested_by_jid,confirmed_by_jid,confirmed_at,expires_at)
values('120363000000000001@g.us','school-wise-wolf','{"tipo":"ajuste_repasse","teacher_id":"00000000-0000-4000-8000-000000000001","mes":"2099-01","valor":16,"motivo":"Test fixture"}','Test fixture','fixture-group-member','finance.adjust_teacher_payout','executing','123456789012345@lid','123456789012345@lid',now(),now()+interval '5 minutes');
do $$
declare result jsonb;
begin
  assert private.management_group_execution_authorized('school-wise-wolf',null,'fixture-group-member','{"tipo":"ajuste_repasse","valor":16}');
  assert not private.management_group_execution_authorized('another-school',null,'fixture-group-member','{"tipo":"ajuste_repasse"}');
  assert not private.management_group_execution_authorized('school-wise-wolf',null,'fixture-group-member','{"tipo":"ajuste_repasse","valor":32}');
  assert not private.management_group_execution_authorized('school-wise-wolf',null,'wrong-request','{"tipo":"ajuste_repasse"}');
  assert not private.management_group_execution_authorized('school-wise-wolf','00000000-0000-4000-8000-000000000099','fixture-group-member','{"tipo":"ajuste_repasse"}');
  result := public.gestao_lanca_ajuste_idempotente('school-wise-wolf','fixture-group-member',null,'00000000-0000-4000-8000-000000000001','2099-01','Test fixture',16,'Test');
  assert result->>'error' = 'professor_invalido', 'Group actor must pass authorization and reach teacher validation';
  begin
    perform public.gestao_lanca_ajuste_idempotente('school-wise-wolf','fixture-group-member',null,'00000000-0000-4000-8000-000000000001','2099-01','Test fixture',32,'Test');
    raise exception 'Mismatched confirmed amount was authorized';
  exception when insufficient_privilege then null;
  end;
end;
$$;
update public.dre_report_settings set allow_group_member_actions=false where tenant_id='school-wise-wolf';
do $$ begin assert not private.management_group_execution_authorized('school-wise-wolf',null,'fixture-group-member','{"tipo":"ajuste_repasse"}'); end; $$;
