\set ON_ERROR_STOP on
-- Alertas da direção nos grupos (05/11/2026): Asaas no Financeiro, rotina com falha
-- na Direção, telefone só como último recurso. Roda na transação do release, com
-- canais de mentira que somem no rollback; nada é enviado.
begin;
create or replace function pg_temp.ag_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'alertas nos grupos: %',m;end if;end$$;
do $test$
declare
 v_tenant text:='school-wise-wolf';
 v_fin text:='120363000000000901@g.us';
 v_dir text:='120363000000000902@g.us';
 v_admin uuid;
 v_subject text:='fixture-'||gen_random_uuid();
 v_event text:='evt_alerta_grupo_'||gen_random_uuid();
 v_dest text;
 v_teacher uuid;
 v_sent integer;
begin
 select m.user_id into v_admin from public.tenant_memberships m join public.profiles p on p.id=m.user_id
  where m.tenant_id=v_tenant and m.role='SCHOOL_ADMIN' and m.status='ACTIVE'
    and lower(btrim(coalesce(p.lifecycle_status,'')))='active' and nullif(btrim(p.phone),'') is not null
    and coalesce(p.is_test_account,false) is false
  order by m.is_primary desc nulls last,m.created_at,p.id limit 1;
 if v_admin is null then
  raise notice 'alertas nos grupos: escola sem diretor ativo; pulado';
  return;
 end if;

 insert into public.tenant_notice_channels(tenant_id,channel,group_jid) values(v_tenant,'financeiro',v_fin),(v_tenant,'direcao',v_dir)
 on conflict(tenant_id,channel) do update set group_jid=excluded.group_jid;

 -- Rotina com falha vai para a Direção; o restante da linha não muda.
 perform pg_temp.ag_assert(private.enqueue_cron_health_alert('FIXTURE',v_subject,'alerta fixture',current_date),'alerta de rotina nao entrou na fila');
 select q.student_phone,q.teacher_id into v_dest,v_teacher from public.notification_queue q
  where q.tenant_id=v_tenant and q.idempotency_key='cron-health:FIXTURE:'||v_subject||':'||current_date::text;
 perform pg_temp.ag_assert(v_dest=v_dir,'alerta de rotina fora do grupo da direcao: '||coalesce(v_dest,'nulo'));
 perform pg_temp.ag_assert(v_teacher=v_admin,'alerta de rotina mudou o responsavel');

 -- Pagamento preso em triagem vai para o Financeiro.
 insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,payload,payload_hash,status)
 values(v_event,'PAYMENT_RECEIVED','pay_alerta_grupo',jsonb_build_object('id',v_event,'event','PAYMENT_RECEIVED','payment',jsonb_build_object('id','pay_alerta_grupo','value',100,'customer','cus_alerta_grupo')),'hash-alerta-grupo','TRIAGE');
 perform private.notify_settled_payments_in_triage();
 select q.student_phone into v_dest from public.notification_queue q join public.automation_sent a on a.id=q.source_id
  where a.kind='ASAAS_TRIAGE_SETTLED' and a.subject_id=left(v_event,200) and q.notification_kind='ASAAS_TRIAGE_SETTLED';
 perform pg_temp.ag_assert(v_dest=v_fin,'pagamento em triagem fora do financeiro: '||coalesce(v_dest,'nulo'));

 -- Saúde do Asaas vai para o Financeiro. A trava de um notificador por vez pode
 -- estar com o cron real; nesse caso o texto da função responde pelo destino.
 delete from public.automation_sent where kind='ASAAS_HEALTH' and subject_id=v_tenant and ref_date=current_date;
 v_sent:=private.notify_asaas_automation_health();
 if v_sent=1 then
  select q.student_phone into v_dest from public.notification_queue q join public.automation_sent a on a.id=q.source_id
   where a.kind='ASAAS_HEALTH' and a.subject_id=v_tenant and a.ref_date=current_date and q.notification_kind='ASAAS_HEALTH';
  perform pg_temp.ag_assert(v_dest=v_fin,'saude do asaas fora do financeiro: '||coalesce(v_dest,'nulo'));
 end if;

 -- O telefone segue como último recurso, para escola sem grupo não perder o aviso.
 perform pg_temp.ag_assert(position('coalesce(private.tenant_notice_destination(admin_row.tenant_id, ''financeiro''), admin_row.phone)' in pg_get_functiondef('private.notify_asaas_automation_health()'::regprocedure))>0,'saude do asaas sem o canal financeiro');
 perform pg_temp.ag_assert(position('coalesce(private.tenant_notice_destination(admin_row.tenant_id, ''financeiro''), admin_row.phone)' in pg_get_functiondef('private.notify_settled_payments_in_triage()'::regprocedure))>0,'triagem sem o canal financeiro');
 perform pg_temp.ag_assert(position('coalesce(private.tenant_notice_destination(v_admin.tenant_id, ''direcao''), v_admin.phone)' in pg_get_functiondef('private.enqueue_cron_health_alert(text,text,text,date)'::regprocedure))>0,'rotina sem o canal direcao');
end;$test$;
rollback;
