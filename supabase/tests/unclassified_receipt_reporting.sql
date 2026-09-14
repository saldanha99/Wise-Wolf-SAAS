-- QA-only: never populate fixtures in a real school or trigger real queues.
begin;
do $$ begin
 if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
   or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
   or exists(select 1 from vault.secrets) then
   raise exception 'isolated_empty_finance_qa_required';
 end if;
end $$;
set local timezone='America/Sao_Paulo';
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$
begin if not coalesce(v,false) then raise exception 'assertion failed: %',m; end if; end $$;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled)
values('unclassified-report-qa','Synthetic report school','unclassified-report-qa','active',false);
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,
 due_date,payment_date,paid_at,credited_at,payment_type,description,raw_payload)
values
 ('97000000-0000-4000-8000-000000000001','unclassified-report-qa',null,'pay_reportlegacy','cus_reportlegacy',100,'RECEIVED','RECEIVED',
  '2026-09-01','2026-09-10','2026-09-10 12:00:00+00','2026-09-10 12:00:00+00','SUBSCRIPTION','Mensalidade legada','{}'),
 ('97000000-0000-4000-8000-000000000002','unclassified-report-qa',null,'pay_reportunassigned','cus_reportunassigned',30,'RECEIVED','RECEIVED',
  '2026-09-01','2026-09-10','2026-09-10 12:00:00+00','2026-09-10 12:00:00+00','UNASSIGNED_RECEIPT','Recebimento a classificar','{"source":"OPERATOR_ADJUDICATION"}'),
 ('97000000-0000-4000-8000-000000000003','unclassified-report-qa',null,'pay_reportconfirmed','cus_reportconfirmed',999,'CONFIRMED','CONFIRMED',
  '2026-09-01',null,null,null,'UNASSIGNED_RECEIPT','Cartão ainda não recebido','{"source":"OPERATOR_ADJUDICATION"}'),
 ('97000000-0000-4000-8000-000000000004','unclassified-report-qa',null,'pay_reportdifferent','cus_reportdifferent',5,'RECEIVED','RECEIVED',
  '2026-09-01','2026-09-10','2026-09-10 12:00:00+00','2026-09-10 12:00:00+00','UNASSIGNED_RECEIPT','Outro fluxo não adjudicado','{}');
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare d jsonb; b jsonb; begin
 d:=public.dre_gerencial('2026-09','unclassified-report-qa');
 b:=public.balancete_professores('2026-09','unclassified-report-qa');
 perform pg_temp.assert_true((d->>'receita_bruta')::numeric=105,'DRE excludes only the exact unclassified operator marker');
 perform pg_temp.assert_true((d->>'recebimentos_a_classificar')::numeric=30,'DRE separately reports received money awaiting classification');
 perform pg_temp.assert_true(d->'alertas' @> '[{"nivel":"atencao"}]'::jsonb and (d->'alertas')::text like '%sem classificação%', 'DRE visibly explains the excluded cash');
 perform pg_temp.assert_true((b->>'receita_total')::numeric=105 and (b->>'receita_sem_aluno')::numeric=105,'balancete still agrees with DRE without rewriting legacy unassigned receipts');
 perform pg_temp.assert_true((b->>'recebimentos_a_classificar')::numeric=30,'balancete keeps unclassified cash visible separately');
 perform pg_temp.assert_true((select sum(amount)=135 from public.financial_transactions where tenant_id='unclassified-report-qa' and type='ENTRADA'),'real cash remains intact and CONFIRMED does not create cash');
 perform pg_temp.assert_true((public.dre_gerencial('2026-10','unclassified-report-qa')->>'recebimentos_a_classificar')::numeric=0,'receipts do not leak into another month');
end $$;
savepoint report_refunds;
update public.student_payments set refunded_amount=10
 where id='97000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(
 (public.dre_gerencial('2026-09','unclassified-report-qa')->>'recebimentos_a_classificar')::numeric=20
 and (public.balancete_professores('2026-09','unclassified-report-qa')->>'recebimentos_a_classificar')::numeric=20
 and (public.dre_gerencial('2026-09','unclassified-report-qa')->>'receita_bruta')::numeric=105,
 'partial refund reduces only the separate unclassified amount');
update public.student_payments set refunded_amount=30,status='REFUNDED',provider_status='REFUNDED',
 last_provider_event_id='evt_report_fullrefund',last_provider_event_at='2026-09-11 12:00:00+00',last_provider_event_rank=100
 where id='97000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(
 (public.dre_gerencial('2026-09','unclassified-report-qa')->>'recebimentos_a_classificar')::numeric=0
 and (public.balancete_professores('2026-09','unclassified-report-qa')->>'recebimentos_a_classificar')::numeric=0
 and (public.dre_gerencial('2026-09','unclassified-report-qa')->>'receita_bruta')::numeric=105,
 'full refund removes unclassified balance without changing school revenue');
rollback to savepoint report_refunds;
select pg_temp.assert_true(not has_function_privilege('anon','public.dre_gerencial(text,text)','EXECUTE')
 and not has_function_privilege('anon','public.balancete_professores(text,text)','EXECUTE')
 and not has_function_privilege('authenticated','private.unclassified_receipt_total(text,text)','EXECUTE'), 'report helper remains private');
set local request.jwt.claims='{"role":"authenticated","app_metadata":{"role":"SUPER_ADMIN"}}';
do $$ begin
 begin perform public.dre_gerencial('2026-09','unclassified-report-qa'); raise exception 'missing membership accepted'; exception when insufficient_privilege then null; end;
 begin perform public.balancete_professores('2026-09','unclassified-report-qa'); raise exception 'missing membership accepted'; exception when insufficient_privilege then null; end;
end $$;
rollback;
