-- Alertas da direção nos grupos (decisão da direção, 05/11/2026).
--
-- Quatro avisos iam para profiles.phone do diretor, que é o próprio número central:
-- a mensagem saía do número para ele mesmo, sem avisar ninguém. Em 30 dias foram 30
-- de saúde do Asaas, 10 de pagamento preso em triagem, 6 de rotina com falha e 30
-- resumos diários da IA (este último muda na edge school-ai-team).
--
-- Agora: Asaas no canal financeiro; rotina com falha no canal direcao. O telefone
-- continua como último recurso, para escola sem grupo configurado não perder o aviso.
-- Só o destino muda: texto, dedupe, teacher_id e tipo do aviso ficam como estavam.
-- Remendos por âncora: não recrie essas funções a partir de texto antigo.

do $patch$
declare s text;anchor text:=E'    admin_row.phone,\n    alert_message,\n';
begin
 s:=pg_get_functiondef('private.notify_asaas_automation_health()'::regprocedure);
 if strpos(s,'tenant_notice_destination')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'asaas_health_destination_anchor_changed';end if;
 s:=replace(s,anchor,E'    coalesce(private.tenant_notice_destination(admin_row.tenant_id, ''financeiro''), admin_row.phone),\n    alert_message,\n');
 execute s;
end;$patch$;

do $patch$
declare s text;anchor text:='admin_row.tenant_id, admin_row.id, admin_row.phone, v_msg, now(), ''pending'',';
begin
 s:=pg_get_functiondef('private.notify_settled_payments_in_triage()'::regprocedure);
 if strpos(s,'tenant_notice_destination')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'asaas_triage_destination_anchor_changed';end if;
 s:=replace(s,anchor,'admin_row.tenant_id, admin_row.id, coalesce(private.tenant_notice_destination(admin_row.tenant_id, ''financeiro''), admin_row.phone), v_msg, now(), ''pending'',');
 execute s;
end;$patch$;

do $patch$
declare s text;anchor text:=E'    v_admin.phone,\n    p_message,\n';
begin
 s:=pg_get_functiondef('private.enqueue_cron_health_alert(text,text,text,date)'::regprocedure);
 if strpos(s,'tenant_notice_destination')>0 then return;end if;
 if strpos(s,anchor)=0 then raise exception 'cron_alert_destination_anchor_changed';end if;
 s:=replace(s,anchor,E'    coalesce(private.tenant_notice_destination(v_admin.tenant_id, ''direcao''), v_admin.phone),\n    p_message,\n');
 execute s;
end;$patch$;
