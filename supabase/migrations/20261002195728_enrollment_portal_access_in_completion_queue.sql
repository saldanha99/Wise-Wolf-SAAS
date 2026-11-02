-- O aviso durável de conclusão também entrega o acesso. Não depende do navegador.
-- Sem backfill: mensagens antigas e recibos existentes permanecem intactos.
create or replace function private.enrollment_portal_access_text(p_student uuid)
returns text language sql stable security definer set search_path='' as $function$
  select format(E'📧 *Login:* %s\n🔑 *Senha:* use a senha que você criou na matrícula\n🔗 *Portal:* %s\n\nSe não lembrar a senha, toque em *Esqueci minha senha* na tela de acesso.',
    regexp_replace(p.email,'[\n\r*]','','g'),private.lesson_recording_portal_url(p.tenant_id))
  from public.profiles p join auth.users u on u.id=p.id
  where p.id=p_student and p.role='STUDENT' and p.contract_accepted
    and p.lifecycle_status='active' and not coalesce(p.is_test_account,false)
    and lower(btrim(u.email))=lower(btrim(p.email))
    and u.email_confirmed_at is not null
    and nullif(btrim(p.email),'') is not null
    and private.lesson_recording_portal_url(p.tenant_id) is not null;
$function$;
alter function private.enrollment_portal_access_text(uuid) owner to postgres;
revoke all on function private.enrollment_portal_access_text(uuid) from public,anon,authenticated,service_role;

do $durable_access$
declare d text;
  anchor text := $anchor$        v_duration
      ),
      pg_catalog.now(), 'pending', v_offer.id, 'ENROLLMENT_COMPLETION',
      'ENROLLMENT_STUDENT_CONFIRMED',$anchor$;
begin
  select pg_get_functiondef('private.enqueue_enrollment_completion_notifications(uuid,uuid)'::regprocedure) into d;
  if strpos(d,'private.enrollment_portal_access_text')=0 then
    if strpos(d,anchor)=0 then raise exception 'enrollment_student_message_anchor_changed'; end if;
    d:=replace(d,anchor,$replacement$        v_duration
      ) || E'\n\n' || coalesce(private.enrollment_portal_access_text(v_student.id),
        'Solicite à escola a conferência do seu acesso ao portal.'),
      pg_catalog.now(), 'pending', v_offer.id, 'ENROLLMENT_COMPLETION',
      'ENROLLMENT_STUDENT_CONFIRMED',$replacement$);
    execute d;
  end if;
end;
$durable_access$;

create or replace function public.get_enrollment_access_notice_snapshot(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare n public.notification_queue%rowtype; p public.profiles%rowtype; access_text text;
begin
  select * into n from public.notification_queue where id=p_notification_id
    and notification_kind='ENROLLMENT_STUDENT_CONFIRMED' and source_type='ENROLLMENT_COMPLETION';
  select * into p from public.profiles where id=n.student_id and tenant_id=n.tenant_id and role='STUDENT';
  if n.id is null or p.id is null or p.lifecycle_status is distinct from 'active'
     or not public.is_student_notifiable(p.id) or not private.tenant_is_operational(n.tenant_id)
     or coalesce(p.is_test_account,false) or not p.contract_accepted
     or not exists(select 1 from public.tenant_memberships m where m.user_id=p.id
        and m.tenant_id=n.tenant_id and m.role='STUDENT' and m.status='ACTIVE')
     or not exists(select 1 from public.offers o where o.id=n.source_id and o.tenant_id=n.tenant_id
        and o.kind='ENROLLMENT' and o.processing_state='COMPLETED'
        and coalesce(o.consumed_by,o.processing_by)=p.id and o.revoked_at is null
        and not exists(select 1 from public.opportunities t where t.id=o.opportunity_id and t.is_test_fixture))
  then return jsonb_build_object('ok',false,'reason','enrollment_access_source_invalid'); end if;
  if coalesce(p.wa_welcome_sent,false) then
    return jsonb_build_object('ok',false,'reason','enrollment_access_already_sent');
  end if;
  access_text:=private.enrollment_portal_access_text(p.id);
  if access_text is null or right(n.message_body,length(access_text)) is distinct from access_text
     or private.normalize_notification_destination(p.phone) is distinct from
        private.normalize_notification_destination(n.student_phone)
  then return jsonb_build_object('ok',false,'reason','enrollment_access_identity_changed'); end if;
  return jsonb_build_object('ok',true,'destination',private.normalize_notification_destination(p.phone),
    'message',n.message_body);
end;
$function$;
alter function public.get_enrollment_access_notice_snapshot(uuid) owner to postgres;
revoke all on function public.get_enrollment_access_notice_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_enrollment_access_notice_snapshot(uuid) to service_role;

-- Revalidação final antes de autorizar o POST, usando as mesmas fontes do worker.
do $access_fence$
declare d text; anchor text := $anchor$  if v_kind in ('TEACHER_PAYOUT_CONFIRMED','AFFILIATE_PAYOUT_CONFIRMED') then$anchor$;
begin
  select pg_get_functiondef('public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure) into d;
  if strpos(d,'get_enrollment_access_notice_snapshot')=0 then
    if strpos(d,anchor)=0 then raise exception 'enrollment_access_fence_anchor_changed'; end if;
    execute replace(d,anchor,$replacement$  if v_kind='ENROLLMENT_STUDENT_CONFIRMED' then
    begin
      perform id from public.offers where id=v_notification.source_id for share nowait;
      perform id from public.profiles where id=v_notification.student_id for share nowait;
      perform id from auth.users where id=v_notification.student_id for share nowait;
      perform id from public.tenants where id=v_notification.tenant_id for share nowait;
      perform user_id from public.tenant_memberships where user_id=v_notification.student_id for share nowait;
    exception when lock_not_available then
      return jsonb_build_object('ok',false,'action','RETRY','reason','enrollment_access_source_busy');
    end;
    v_snapshot:=public.get_enrollment_access_notice_snapshot(p_notification_id);
    if coalesce((v_snapshot->>'ok')::boolean,false) is false
       or v_snapshot->>'destination' is distinct from p_expected_destination
       or v_snapshot->>'message' is distinct from p_expected_message_body then
      return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED',
        'reason',coalesce(v_snapshot->>'reason','enrollment_access_snapshot_changed'));
    end if;
  end if;

  if v_kind in ('TEACHER_PAYOUT_CONFIRMED','AFFILIATE_PAYOUT_CONFIRMED') then$replacement$);
  end if;
end;
$access_fence$;

create or replace function private.mark_enrollment_access_accepted()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if new.notification_kind='ENROLLMENT_STUDENT_CONFIRMED' and new.source_type='ENROLLMENT_COMPLETION'
     and new.status='sent' and new.accepted_at is not null and new.provider_message_id is not null
     and right(new.message_body,length(private.enrollment_portal_access_text(new.student_id)))=
       private.enrollment_portal_access_text(new.student_id)
  then
    update public.profiles set wa_welcome_sent=true where id=new.student_id and tenant_id=new.tenant_id
      and role='STUDENT' and not coalesce(wa_welcome_sent,false);
  end if;
  return new;
end;
$function$;
alter function private.mark_enrollment_access_accepted() owner to postgres;
revoke all on function private.mark_enrollment_access_accepted() from public,anon,authenticated,service_role;
drop trigger if exists trg_enrollment_access_accepted on public.notification_queue;
create trigger trg_enrollment_access_accepted after update on public.notification_queue
for each row execute function private.mark_enrollment_access_accepted();
