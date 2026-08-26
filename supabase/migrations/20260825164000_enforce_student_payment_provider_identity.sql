-- A provider payment id is an immutable identity. Prevent future local rows
-- from sharing it; the reconciler also reports any collision before adoption.

do $precheck$
begin
  if exists (
    select 1
      from public.student_payments
     where asaas_payment_id is not null
     group by asaas_payment_id
    having count(*) > 1
  ) then
    raise exception 'student_payment_provider_id_collision_requires_review';
  end if;
  if exists (
    select 1
      from public.student_payments
     where asaas_payment_id is not null
       and pg_catalog.btrim(asaas_payment_id) = ''
  ) then
    raise exception 'blank_student_payment_provider_id_requires_review';
  end if;
end
$precheck$;

alter table public.student_payments
  drop constraint if exists student_payments_asaas_payment_id_nonempty_chk;
alter table public.student_payments
  add constraint student_payments_asaas_payment_id_nonempty_chk
  check (
    asaas_payment_id is null
    or pg_catalog.btrim(asaas_payment_id) <> ''
  );

create unique index if not exists student_payments_asaas_payment_id_uidx
  on public.student_payments (asaas_payment_id)
  where asaas_payment_id is not null;

do $postcheck$
begin
  if not exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'public'
       and tablename = 'student_payments'
       and indexname = 'student_payments_asaas_payment_id_uidx'
       and indexdef ilike 'create unique index%'
  ) then
    raise exception 'student_payment_provider_identity_index_missing';
  end if;
end
$postcheck$;
