-- Canal FINANCEIRO (dinheiro sai da Direção) e prévia da folha do mês em aberto.
--
-- O caso (19/09/2026): a direção criou os grupos DIREÇÃO, FINANCEIRO,
-- COORDENAÇÃO e AULAS E COMERCIAL — um a mais do que os 4 canais de 18/09:
-- o dinheiro (rateio, DRE, folha, caixinha, despesa, ajuste de repasse) ganha
-- grupo próprio. Sem grupo financeiro configurado, cai na Direção; sem Direção,
-- na Gestão (a cadeia de antes continua valendo).
--
-- E a folha do mês EM ABERTO: `gestao_payroll_summary` só lia `teacher_closings`,
-- que nasce no dia 1º. Em setembro, a Bruna aparecia com 0 aulas · R$ 0,00 e
-- oito linhas "↪ cobriu …: +R$ 8,00" logo abaixo — "as aulas cobertas não
-- entraram na contabilidade dela". Elas tinham entrado (14 aulas pagáveis,
-- R$ 112 + R$ 8 de ajuste no Financeiro dela); o que faltava era o resumo do
-- mês corrente. Agora, mês sem fechamento = PRÉVIA, com a MESMA conta do
-- Financeiro do professor (v_payable_class_logs + closing_adjustments).
--
-- Também conserta as cercas do outbox de aviso de pagamento: elas comparavam o
-- destino esperado com `dre_report_settings.destino` (o grupo da Gestão). Com
-- canal configurado para outro grupo, TODO aviso de rateio seria suprimido com
-- `management_destination_changed_before_send`. A cerca passa a comparar com o
-- destino do canal de dinheiro.
-- Re-executável: roda a cada release.

-- ---------------------------------------------------------------------------
-- 1) O canal existe
-- ---------------------------------------------------------------------------
alter table public.tenant_notice_channels
  drop constraint if exists tenant_notice_channels_channel_check;
alter table public.tenant_notice_channels
  add constraint tenant_notice_channels_channel_check
  check (channel in ('direcao', 'financeiro', 'coordenacao', 'comercial', 'professores'));
comment on table public.tenant_notice_channels is
  'Grupo de WhatsApp por canal de aviso (direcao, financeiro, coordenacao, comercial, professores). Canal sem grupo cai no grupo da Gestão — financeiro cai antes na Direção (private.tenant_notice_destination).';

create or replace function private.tenant_notice_destination(p_tenant text, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.group_jid
       from public.tenant_notice_channels c
      where c.tenant_id = p_tenant and c.channel = p_channel
        and c.enabled and c.group_jid is not null),
    case when p_channel = 'professores' then
      (select nullif(btrim(p.teachers_group_id), '')
         from public.profiles p
        where p.tenant_id = p_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
          and nullif(btrim(p.teachers_group_id), '') is not null
        order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
        limit 1)
    when p_channel = 'comercial' then
      -- "Grupo de Avisos (Leads / Aceites)": já recebe experimental aceita.
      (select nullif(btrim(p.directors_group_id), '')
         from public.profiles p
        where p.tenant_id = p_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
          and nullif(btrim(p.directors_group_id), '') ~ '^[0-9]{10,25}(-[0-9]+)?@g[.]us$'
        order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
        limit 1)
    when p_channel = 'financeiro' then
      -- Dinheiro sem grupo próprio vai para a Direção (era o desenho de 18/09).
      (select c.group_jid
         from public.tenant_notice_channels c
        where c.tenant_id = p_tenant and c.channel = 'direcao'
          and c.enabled and c.group_jid is not null)
    end,
    private.management_group_destination(p_tenant)
  );
$$;
alter function private.tenant_notice_destination(text, text) owner to postgres;
revoke all on function private.tenant_notice_destination(text, text) from public, anon, authenticated;
grant execute on function private.tenant_notice_destination(text, text) to service_role, postgres;

create or replace function public.get_notice_channels()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_gestao text;
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  v_gestao := private.management_group_destination(v_tenant);
  return (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'channel', ch.channel,
      'group_jid', cfg.group_jid,
      'enabled', coalesce(cfg.enabled, true),
      'effective_jid', private.tenant_notice_destination(v_tenant, ch.channel),
      'fallback', case
        when cfg.group_jid is not null and coalesce(cfg.enabled, true) then 'configurado'
        when private.tenant_notice_destination(v_tenant, ch.channel) is not distinct from v_gestao then 'gestao'
        when ch.channel = 'professores' then 'grupo_dos_professores'
        when ch.channel = 'comercial' then 'grupo_de_avisos'
        when ch.channel = 'financeiro' then 'direcao'
        else 'gestao' end
    ) order by ch.ord)
    from (values ('direcao', 1), ('financeiro', 2), ('coordenacao', 3), ('comercial', 4), ('professores', 5)) as ch(channel, ord)
    left join public.tenant_notice_channels cfg
      on cfg.tenant_id = v_tenant and cfg.channel = ch.channel
  );
end;
$$;
alter function public.get_notice_channels() owner to postgres;
revoke all on function public.get_notice_channels() from public, anon;
grant execute on function public.get_notice_channels() to authenticated;

create or replace function public.save_notice_channel(p_channel text, p_group_jid text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_jid text := nullif(btrim(coalesce(p_group_jid, '')), '');
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if p_channel not in ('direcao', 'financeiro', 'coordenacao', 'comercial', 'professores') then
    raise exception using errcode = '22023', message = 'canal_invalido';
  end if;
  if v_jid is not null and v_jid !~ '^[0-9]{10,25}(-[0-9]+)?@g[.]us$' then
    raise exception using errcode = '22023', message = 'grupo_invalido';
  end if;
  insert into public.tenant_notice_channels (tenant_id, channel, group_jid, enabled, updated_by, updated_at)
  values (v_tenant, p_channel, v_jid, true, auth.uid(), pg_catalog.now())
  on conflict (tenant_id, channel) do update
    set group_jid = excluded.group_jid, enabled = true,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return pg_catalog.jsonb_build_object('ok', true, 'channel', p_channel, 'group_jid', v_jid,
    'effective_jid', private.tenant_notice_destination(v_tenant, p_channel));
end;
$$;
alter function public.save_notice_channel(text, text) owner to postgres;
revoke all on function public.save_notice_channel(text, text) from public, anon;
grant execute on function public.save_notice_channel(text, text) to authenticated;

create or replace function public.notice_channel_jids(p_tenant text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(auth.role(), '') = 'service_role' then pg_catalog.jsonb_build_object(
    'gestao', private.management_group_destination(p_tenant),
    'direcao', private.tenant_notice_destination(p_tenant, 'direcao'),
    'financeiro', private.tenant_notice_destination(p_tenant, 'financeiro'),
    'coordenacao', private.tenant_notice_destination(p_tenant, 'coordenacao'),
    'comercial', private.tenant_notice_destination(p_tenant, 'comercial'),
    'professores', private.tenant_notice_destination(p_tenant, 'professores')
  ) end;
$$;
alter function public.notice_channel_jids(text) owner to postgres;
revoke all on function public.notice_channel_jids(text) from public, anon, authenticated;
grant execute on function public.notice_channel_jids(text) to service_role;

-- O grupo financeiro fala com o bot (despesa, ajuste de repasse, folha, perguntas
-- de gestão). O dos professores continua só disparo.
create or replace function private.management_group_jid_is_authorized(p_tenant text, p_jid text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(btrim(coalesce(p_jid, '')), '') is not null and (
    exists (select 1 from public.dre_report_settings s
             where s.tenant_id = p_tenant and s.is_active is true
               and lower(btrim(s.destino)) = lower(btrim(p_jid)))
    or exists (select 1 from public.tenant_notice_channels c
                where c.tenant_id = p_tenant and c.enabled and c.group_jid is not null
                  and lower(btrim(c.group_jid)) = lower(btrim(p_jid))
                  and c.channel in ('direcao', 'financeiro', 'coordenacao', 'comercial'))
  );
$$;
alter function private.management_group_jid_is_authorized(text, text) owner to postgres;
revoke all on function private.management_group_jid_is_authorized(text, text) from public, anon, authenticated;
grant execute on function private.management_group_jid_is_authorized(text, text) to postgres, service_role;

-- ---------------------------------------------------------------------------
-- 2) Cercas do outbox de aviso de pagamento: o destino esperado é o do canal
--    de dinheiro, não o grupo da Gestão. A trava de "is_active" e o FOR SHARE
--    em dre_report_settings continuam — só muda o que é comparado.
-- ---------------------------------------------------------------------------
do $outbox_fences$
declare
  fn text;
  d text;
  a text := $a$  select private.normalize_management_group_destination(management.destino)
  into v_current_destination
  from public.dre_report_settings as management$a$;
  b text := $b$  select private.normalize_management_group_destination(
           private.tenant_notice_destination(v_outbox.tenant_id, 'financeiro'))
  into v_current_destination
  from public.dre_report_settings as management$b$;
begin
  foreach fn in array array[
    'public.begin_management_payment_notification_submission',
    'public.authorize_management_payment_notification_submission'
  ] loop
    select pg_get_functiondef(fn::regproc) into d;
    if strpos(d, 'tenant_notice_destination') = 0 then
      if strpos(d, a) = 0 then
        raise exception '%: âncora do destino da Gestão não encontrada', fn;
      end if;
      execute replace(d, a, b);
    end if;
  end loop;
end;
$outbox_fences$;

-- ---------------------------------------------------------------------------
-- 3) Folha do mês por professor — com PRÉVIA para o mês em aberto
-- ---------------------------------------------------------------------------
create or replace function private.payroll_month_rows(p_tenant text, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_month text := left(btrim(coalesce(p_month, '')), 7);
  v_start date;
  v_end date;
  v_rows jsonb;
  v_total numeric := 0;
  v_lessons int := 0;
  v_previa int := 0;
begin
  if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'mes_invalido');
  end if;
  v_start := (v_month || '-01')::date;
  v_end := (v_start + interval '1 month')::date;

  with closings as (
    select distinct on (c.teacher_id)
           c.teacher_id, c.total_lessons, c.total_amount, c.status
      from public.teacher_closings c
     where c.tenant_id = p_tenant and c.month_year = v_month
     order by c.teacher_id, c.created_at desc
  ),
  -- Mês sem fechamento: a prévia lê as aulas já lançadas — a MESMA conta do
  -- Financeiro do professor (get_teacher_closing_report: v_payable_class_logs
  -- + closing_adjustments). Cobertura já está no dono certo aqui: o log é de
  -- quem deu a aula.
  live as (
    select v.teacher_id, count(*)::int as lessons, coalesce(sum(v.rate_efetivo), 0) as amount
      from public.v_payable_class_logs v
     where v.tenant_id = p_tenant and v.class_date >= v_start and v.class_date < v_end
     group by v.teacher_id
  ),
  adj as (
    select a.teacher_id, coalesce(sum(a.amount), 0) as amount
      from public.closing_adjustments a
     where a.tenant_id = p_tenant and a.month_year = v_month
     group by a.teacher_id
  ),
  cov as (
    select cc.cover_teacher_id, cc.original_teacher_id, cc.class_date, cc.class_time, cc.student_id,
           v.rate_efetivo, s.full_name as student_name, o.full_name as original_name, k.full_name as cover_name,
           cc.class_log_id is not null as lancada
      from public.class_coverages cc
      left join public.v_payable_class_logs v on v.id = cc.class_log_id
      left join public.profiles s on s.id = cc.student_id
      left join public.profiles o on o.id = cc.original_teacher_id
      left join public.profiles k on k.id = cc.cover_teacher_id
     where cc.tenant_id = p_tenant and lower(cc.status) = 'confirmed'
       and cc.class_date >= v_start and cc.class_date < v_end
  ),
  teachers as (
    select t.id, t.full_name
      from public.profiles t
      join public.tenant_memberships m on m.user_id = t.id and m.tenant_id = p_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE'
     where t.role = 'TEACHER' and t.tenant_id = p_tenant
       and coalesce(t.is_test_account, false) = false
       and (exists (select 1 from closings c where c.teacher_id = t.id)
            or exists (select 1 from live l where l.teacher_id = t.id)
            or exists (select 1 from adj a where a.teacher_id = t.id)
            or exists (select 1 from cov where cov.cover_teacher_id = t.id or cov.original_teacher_id = t.id))
  ),
  base as (
    select t.id, t.full_name,
           c.teacher_id is not null as fechado,
           coalesce(c.total_lessons, l.lessons, 0) as lessons,
           case when c.teacher_id is not null then coalesce(c.total_amount, 0)
                else coalesce(l.amount, 0) + coalesce(a.amount, 0) end as amount,
           coalesce(c.status, 'PREVIA') as status,
           case when c.teacher_id is null then coalesce(a.amount, 0) end as adjustments
      from teachers t
      left join closings c on c.teacher_id = t.id
      left join live l on l.teacher_id = t.id
      left join adj a on a.teacher_id = t.id
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'teacher_id', b.id,
           'name', b.full_name,
           'lessons', b.lessons,
           'amount', b.amount,
           'status', b.status,
           'previa', not b.fechado,
           'adjustments', b.adjustments,
           'received', (select pg_catalog.jsonb_build_object(
                          'count', count(*), 'amount', coalesce(sum(rate_efetivo), 0),
                          'pending', count(*) filter (where not lancada),
                          'items', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                             'date', class_date, 'time', left(class_time, 5), 'student', student_name,
                             'from', original_name, 'amount', rate_efetivo, 'logged', lancada)
                             order by class_date, class_time), '[]'::jsonb))
                          from cov where cov.cover_teacher_id = b.id),
           'ceded', (select pg_catalog.jsonb_build_object(
                          'count', count(*),
                          'items', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                             'date', class_date, 'time', left(class_time, 5), 'student', student_name, 'to', cover_name)
                             order by class_date, class_time), '[]'::jsonb))
                          from cov where cov.original_teacher_id = b.id),
           'projected', b.amount
                        - coalesce((select sum(rate_efetivo) from cov where cov.cover_teacher_id = b.id), 0)
                        + coalesce((select sum(rate_efetivo) from cov where cov.original_teacher_id = b.id), 0)
         ) order by b.full_name),
         coalesce(sum(b.amount), 0), coalesce(sum(b.lessons), 0), count(*) filter (where not b.fechado)
    into v_rows, v_total, v_lessons, v_previa
    from base b;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'month', v_month,
    'teachers', coalesce(v_rows, '[]'::jsonb),
    'total_amount', v_total, 'total_lessons', v_lessons,
    'previa', v_previa > 0,
    'previa_count', v_previa
  );
end;
$function$;
alter function private.payroll_month_rows(text, text) owner to postgres;
revoke all on function private.payroll_month_rows(text, text) from public, anon, authenticated, service_role;
grant execute on function private.payroll_month_rows(text, text) to postgres;

-- Comando do grupo e cron do dia 1º (service_role) — mesma assinatura de antes.
create or replace function public.gestao_payroll_summary(p_tenant text, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  return private.payroll_month_rows(p_tenant, p_month);
end;
$function$;
alter function public.gestao_payroll_summary(text, text) owner to postgres;
revoke all on function public.gestao_payroll_summary(text, text) from public, anon, authenticated;
grant execute on function public.gestao_payroll_summary(text, text) to service_role;

-- "Repasse a Profs" no mês em aberto: a direção vê a prévia por professor
-- (antes a tela ficava vazia até o dia 1º).
create or replace function public.payroll_month_preview(p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return private.payroll_month_rows(v_tenant, p_month);
end;
$function$;
alter function public.payroll_month_preview(text) owner to postgres;
revoke all on function public.payroll_month_preview(text) from public, anon;
grant execute on function public.payroll_month_preview(text) to authenticated;
