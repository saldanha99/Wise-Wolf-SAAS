-- =============================================================================
-- Lead de "Professor Negócio" avisa o grupo da Gestão — e a conversão em tenant
-- tem uma porta só, no servidor.
--
-- O que motivou (medido em 17/09/2026): o formulário `/seja-professor` gravava
-- em `saas_leads` e NINGUÉM era avisado — só o SUPER_ADMIN, se abrisse a aba
-- "Professores" do painel. E a ativação manual dali inseria o tenant pelo
-- navegador e gerava `/teacher-onboarding?tenant=…`, que a tela recusa ("Link
-- de convite inválido"): o professor recebia um link morto. Zero leads na
-- história, então nunca doeu — mas é o único caminho do upsell do Hub para o
-- tenant, e ele precisa funcionar antes de mandar tráfego para a Biblioteca.
--
-- 1) `saas_lead_notify_management` (AFTER INSERT em saas_leads): enfileira um
--    aviso no grupo da Gestão da escola operadora da plataforma, pela mesma
--    `notification_queue` (MANAGEMENT_NOTICE) que os avisos de cobertura usam —
--    passa pela régua de envio e pela instância central. Qual escola recebe vem
--    de `hub_settings.metadata.salesNoticeTenantId` (dado, não código). Falha no
--    aviso NUNCA derruba o lead: o insert é mais importante que o alerta.
-- 2) `convert_teacher_lead_to_tenant` (service_role): cria tenant tipo
--    `teacher` + assinatura em trial, marca o lead como CONVERTED. Idempotente:
--    lead já convertido devolve o tenant existente. Quem cria a conta do dono e
--    manda o e-mail de ativação é a edge `activate-teacher-tenant` — o mesmo
--    `sendAccountActivation` de professor e aluno.
--
-- ⚠️ Roda a cada release: tudo re-executável, sem begin/commit.
-- =============================================================================

-- Escola operadora (quem vende a plataforma) — só grava se ainda não houver
-- decisão, para o release não desfazer uma troca feita depois.
update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('salesNoticeTenantId', 'school-wise-wolf')
 where settings_key = 'default'
   and not (coalesce(metadata, '{}'::jsonb) ? 'salesNoticeTenantId');

create or replace function private.saas_lead_notify_management()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant text;
  v_group_jid text;
  v_director uuid;
  v_phone text;
  v_email text;
  v_name text;
  v_kind text;
  v_body text;
begin
  begin
    select nullif(btrim(s.metadata ->> 'salesNoticeTenantId'), '')
      into v_tenant
      from public.hub_settings s
     where s.settings_key = 'default';
    if v_tenant is null then
      return new;
    end if;

    select s.destino into v_group_jid
      from public.dre_report_settings s
     where s.tenant_id = v_tenant
       and s.is_active
       and s.destino ~ '^[0-9]{10,25}@g[.]us$';
    if v_group_jid is null then
      return new;
    end if;

    v_director := private.management_group_default_actor(v_tenant);
    if v_director is null then
      return new;
    end if;

    v_name := btrim(coalesce(nullif(new.owner_name, ''), new.name, 'sem nome'));
    v_email := lower(btrim(coalesce(nullif(new.owner_email, ''), new.email, '')));
    v_phone := regexp_replace(coalesce(nullif(new.owner_phone, ''), new.phone, ''), '\D', '', 'g');
    if v_phone <> '' and length(v_phone) between 10 and 11 then
      v_phone := '55' || v_phone;
    end if;
    v_kind := lower(coalesce(new.lead_type, 'school'));

    v_body := case when v_kind = 'teacher'
        then E'🧑‍🏫 *Novo lead — Professor Negócio* (Hub)\n'
        else E'🏫 *Novo lead — Diagnóstico de escola*\n' end
      || format(E'👤 %s\n', v_name)
      || case when v_phone <> '' then format(E'📱 wa.me/%s\n', v_phone) else E'📱 sem WhatsApp\n' end
      || case when v_email <> '' then format(E'✉️ %s\n', v_email) else '' end
      || case when nullif(btrim(coalesce(new.school_name, '')), '') is not null
           then format(E'🏷️ %s\n', btrim(new.school_name)) else '' end
      || case when new.estimated_students is not null
           then format(E'🎓 ~%s alunos', new.estimated_students) else '' end
      || case when v_kind <> 'teacher' and new.estimated_teachers is not null
           then format(E' · ~%s professores', new.estimated_teachers) else '' end
      || case when new.estimated_students is not null then E'\n' else '' end
      || case when nullif(btrim(coalesce(new.notes, '')), '') is not null
           then format(E'📝 %s\n', left(btrim(new.notes), 400)) else '' end
      || case when nullif(btrim(coalesce(new.source, '')), '') is not null
           then format(E'🔗 origem: %s\n', new.source) else '' end
      || case when v_kind = 'teacher'
        then E'\nAtivar o ambiente: painel Super Admin → aba *Professores* → Ativar (cria o tenant em trial e manda o e-mail de acesso).'
        else E'\nRetorno: agendar o diagnóstico com a escola.' end;

    insert into public.notification_queue (
      tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
      source_type, notification_kind, idempotency_key
    ) values (
      v_tenant, v_director, 'Gestão', v_group_jid, v_body, pg_catalog.now(), 'pending',
      'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('saas_lead:%s', new.id)
    )
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
  exception when others then
    -- O lead vale mais que o aviso: registra e segue.
    raise warning '[saas_leads] aviso à gestão falhou para o lead %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

alter function private.saas_lead_notify_management() owner to postgres;
revoke all on function private.saas_lead_notify_management() from public, anon, authenticated;

drop trigger if exists zzz_saas_lead_notify_management on public.saas_leads;
create trigger zzz_saas_lead_notify_management
  after insert on public.saas_leads
  for each row execute function private.saas_lead_notify_management();

comment on function private.saas_lead_notify_management() is
  'Avisa o grupo da Gestão da escola operadora (hub_settings.metadata.salesNoticeTenantId) sobre lead novo de escola ou de Professor Negócio, pela notification_queue. Nunca bloqueia o insert.';

-- -----------------------------------------------------------------------------
-- Conversão do lead de professor em tenant (trial), chamada pela edge
-- `activate-teacher-tenant` com service_role.
-- -----------------------------------------------------------------------------
create or replace function public.convert_teacher_lead_to_tenant(
  p_lead_id uuid,
  p_plan_id uuid,
  p_slug text,
  p_school_name text,
  p_trial_days integer default 14,
  p_owner_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_lead public.saas_leads%rowtype;
  v_plan public.saas_plans%rowtype;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_school_name, ''));
  v_trial_days integer := coalesce(p_trial_days, 14);
  v_trial_ends timestamptz;
  v_owner_email text;
  v_owner_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;

  select * into v_lead from public.saas_leads where id = p_lead_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'lead_nao_encontrado');
  end if;
  if lower(coalesce(v_lead.lead_type, '')) <> 'teacher' then
    return jsonb_build_object('ok', false, 'error', 'lead_nao_e_de_professor');
  end if;

  -- O painel pode corrigir o e-mail digitado no formulário; sem correção vale o do lead.
  v_owner_email := lower(btrim(coalesce(nullif(p_owner_email, ''), nullif(v_lead.owner_email, ''), v_lead.email, '')));
  v_owner_name := btrim(coalesce(nullif(v_lead.owner_name, ''), v_lead.name, ''));
  if v_owner_email = '' or position('@' in v_owner_email) <= 1 then
    return jsonb_build_object('ok', false, 'error', 'lead_sem_email');
  end if;

  -- Já convertido: devolve o que existe (a edge pode reenviar a ativação).
  if v_lead.converted_tenant_id is not null then
    return jsonb_build_object(
      'ok', true, 'already_converted', true,
      'tenant_id', v_lead.converted_tenant_id,
      'owner_email', v_owner_email, 'owner_name', v_owner_name
    );
  end if;

  if v_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$' then
    return jsonb_build_object('ok', false, 'error', 'slug_invalido');
  end if;
  if v_slug in ('master', 'admin', 'api', 'app', 'hub', 'system', 'www', 'wolfie', 'wisewolf', 'wise-wolf') then
    return jsonb_build_object('ok', false, 'error', 'slug_reservado');
  end if;
  if exists (select 1 from public.tenants t where t.id = v_slug or lower(t.slug) = v_slug) then
    return jsonb_build_object('ok', false, 'error', 'slug_em_uso');
  end if;
  if char_length(v_name) not between 2 and 160 then
    return jsonb_build_object('ok', false, 'error', 'nome_invalido');
  end if;
  if v_trial_days not between 0 and 90 then
    return jsonb_build_object('ok', false, 'error', 'trial_invalido');
  end if;

  select * into v_plan from public.saas_plans p where p.id = p_plan_id and p.active is true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'plano_inativo');
  end if;
  if coalesce(v_plan.plan_type, '') <> 'teacher' then
    return jsonb_build_object('ok', false, 'error', 'plano_nao_e_de_professor');
  end if;

  v_trial_ends := case when v_trial_days > 0 then pg_catalog.now() + make_interval(days => v_trial_days) else null end;

  -- Mesma forma do provisionamento pago (`provision_paid_saas_checkout`):
  -- id = slug, branding padrão, tipo vindo do plano. `domain` fica nulo de
  -- propósito — "tenants.domain não é o portal" (ver CLAUDE.md).
  insert into public.tenants (
    id, name, slug, owner_email, owner_phone, saas_status, plan_id,
    trial_ends_at, current_period_end, branding, tenant_type, parent_tenant_id
  ) values (
    v_slug, v_name, v_slug, v_owner_email,
    nullif(regexp_replace(coalesce(nullif(v_lead.owner_phone, ''), v_lead.phone, ''), '\D', '', 'g'), ''),
    case when v_trial_ends is null then 'active' else 'trial' end,
    v_plan.id, v_trial_ends, coalesce(v_trial_ends, pg_catalog.now() + interval '1 month'),
    jsonb_build_object('primaryColor', '#081a33', 'secondaryColor', '#d5a94e'),
    'teacher',
    case when v_lead.parent_tenant_id is not null and v_lead.parent_tenant_id <> 'master' then v_lead.parent_tenant_id else null end
  );

  insert into public.saas_subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_end, parent_tenant_id)
  values (
    v_slug, v_plan.id,
    case when v_trial_ends is null then 'active' else 'trial' end,
    v_trial_ends, coalesce(v_trial_ends, pg_catalog.now() + interval '1 month'),
    case when v_lead.parent_tenant_id is not null and v_lead.parent_tenant_id <> 'master' then v_lead.parent_tenant_id else null end
  );

  update public.saas_leads
     set status = 'CONVERTED',
         converted_tenant_id = v_slug,
         updated_at = pg_catalog.now()
   where id = v_lead.id;

  return jsonb_build_object(
    'ok', true, 'already_converted', false,
    'tenant_id', v_slug, 'plan', v_plan.name,
    'trial_ends_at', v_trial_ends,
    'owner_email', v_owner_email, 'owner_name', v_owner_name
  );
end;
$function$;

-- A assinatura antiga (sem e-mail) não pode sobreviver: duas candidatas fariam o
-- PostgREST recusar a chamada por ambiguidade.
drop function if exists public.convert_teacher_lead_to_tenant(uuid, uuid, text, text, integer);
alter function public.convert_teacher_lead_to_tenant(uuid, uuid, text, text, integer, text) owner to postgres;
revoke all on function public.convert_teacher_lead_to_tenant(uuid, uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.convert_teacher_lead_to_tenant(uuid, uuid, text, text, integer, text) to service_role;

comment on function public.convert_teacher_lead_to_tenant(uuid, uuid, text, text, integer, text) is
  'Converte um lead de Professor Negócio em tenant tipo teacher com assinatura em trial. Idempotente por saas_leads.converted_tenant_id. A conta do dono e o e-mail de ativação ficam com a edge activate-teacher-tenant.';
