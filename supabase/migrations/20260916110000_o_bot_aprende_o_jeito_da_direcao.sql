-- ─────────────────────────────────────────────────────────────────────────────
-- O bot aprende o jeito de conversar da direção (16/09/2026)
--
-- Pedido do dono depois de ler duas conversas reais de 15/09: quando a IA
-- falhou, ele assumiu no áudio e vendeu de um jeito que o bot não sabe imitar —
-- explicou POR QUE a aula é individual, POR QUE são 30 minutos, e adaptou o
-- argumento ao objetivo de cada um (um queria inglês para trabalho, o outro
-- inglês geral). Este módulo guarda esses exemplos reais e devolve os mais
-- parecidos com o lead da vez, para entrarem no prompt da atendente.
--
-- O que NÃO entra, e por quê: `whatsapp_messages.sender_kind = 'human'` inclui
-- todo disparo feito pela mesma instância (convite de experimental ao professor,
-- aviso de qualidade, alerta do Asaas, template de RH). Aprender com isso seria
-- ensinar a atendente a falar como um robô de aviso. Então:
--   • ÁUDIO para conversa de lead entra sempre — automação nunca manda áudio;
--   • TEXTO só entra quando NÃO existe mensagem igual registrada em
--     `ai_wa_messages` (tudo que nossos robôs enviam fica registrado lá) e não
--     tem cara de comunicado.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists private.sdr_style_examples (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  provider_message_id text not null,
  phone_tail text,
  goal_tag text not null default 'geral',
  kind text not null,
  content text not null,
  lead_status text,
  occurred_at timestamptz,
  captured_at timestamptz not null default now()
);

-- A migration roda como supabase_admin e as funções rodam como postgres.
alter table private.sdr_style_examples owner to postgres;
alter table private.sdr_style_examples enable row level security;

create unique index if not exists uq_sdr_style_examples_message
  on private.sdr_style_examples (tenant_id, provider_message_id);
create index if not exists ix_sdr_style_examples_goal
  on private.sdr_style_examples (tenant_id, goal_tag, occurred_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sdr_style_examples_kind_chk') then
    alter table private.sdr_style_examples
      add constraint sdr_style_examples_kind_chk check (kind in ('text', 'audio'));
  end if;
end $$;

-- O objetivo do lead em poucas famílias: é por ele que o exemplo é escolhido.
create or replace function private.sdr_style_goal_tag(p_goal text)
returns text language sql immutable set search_path = '' as $$
  select case
    when g ~ '(trabalh|carreir|empres|profission|entrevista|reuni|corporat)' then 'trabalho'
    when g ~ '(viag|turism|intercamb|morar fora|exterior)' then 'viagem'
    when g ~ '(filh|crianc|kids|infantil|adolescent)' then 'kids'
    when g ~ '(prova|exame|toefl|ielts|toeic|concurs|vestibul)' then 'prova'
    else 'geral'
  end
  from (
    select pg_catalog.lower(pg_catalog.translate(coalesce(p_goal, ''),
      'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
      'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) as g
  ) as normalizado;
$$;

-- O que ainda não foi aprendido. Devolve o id da mensagem no provedor para o
-- áudio ser baixado e transcrito por quem chama (o worker do whatsapp-inbound,
-- onde o transcritor já existe).
create or replace function public.sdr_style_pending(p_limit integer default 5)
returns table(
  provider_message_id text, tenant_id text, instance_name text, kind text,
  body text, phone_tail text, goal_tag text, lead_status text, occurred_at timestamptz
)
language sql security definer set search_path = '' as $$
  select
    m.provider_message_id,
    m.tenant_id,
    i.instance_name,
    case when m.message_type = 'audio' then 'audio' else 'text' end,
    m.body,
    pg_catalog.right(pg_catalog.regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 8),
    private.sdr_style_goal_tag(lead.goal),
    lead.status,
    m.occurred_at
  from public.whatsapp_messages as m
  join public.whatsapp_instances as i on i.id = m.instance_id
  join public.whatsapp_conversations as c on c.id = m.conversation_id
  left join public.crm_leads as lead
    on lead.tenant_id = m.tenant_id
   and pg_catalog.right(pg_catalog.regexp_replace(coalesce(lead.phone, ''), '[^0-9]', '', 'g'), 8)
     = pg_catalog.right(pg_catalog.regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 8)
  where m.direction = 'out'
    and m.sender_kind = 'human'
    and c.contact_kind = 'lead'
    and m.occurred_at > pg_catalog.now() - interval '30 days'
    and coalesce(m.provider_message_id, '') <> ''
    and (
      m.message_type = 'audio'
      or (
        m.message_type = 'text'
        and pg_catalog.length(coalesce(m.body, '')) between 60 and 1200
        -- comunicado da escola começa com selo; conversa de gente, não
        and coalesce(m.body, '') !~ '^[[:space:]]*[⚡🐺⚠🏫🔴🔵🤖📌🎯✅🔹]'
        and coalesce(m.body, '') not like '%Novo Lead!%'
        and coalesce(m.body, '') not like '%equipe de qualidade%'
        and coalesce(m.body, '') not like '%Processo Seletivo%'
        and coalesce(m.body, '') not like '%EXPERIMENTAL%'
        -- tudo que nossos robôs mandam fica registrado em ai_wa_messages:
        -- se o texto está lá, não foi uma pessoa que escreveu.
        and not exists (
          select 1 from public.ai_wa_messages as a
          where a.tenant_id = m.tenant_id
            and a.direction = 'out'
            and pg_catalog.right(a.phone, 8)
              = pg_catalog.right(pg_catalog.regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 8)
            and a.content = m.body
        )
      )
    )
    and not exists (
      select 1 from private.sdr_style_examples as e
      where e.tenant_id = m.tenant_id and e.provider_message_id = m.provider_message_id
    )
  order by m.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

create or replace function public.sdr_style_capture(
  p_tenant text, p_provider_message_id text, p_kind text, p_content text,
  p_phone_tail text, p_goal_tag text, p_lead_status text, p_occurred_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_content text := pg_catalog.btrim(coalesce(p_content, ''));
begin
  if p_tenant is null or coalesce(pg_catalog.btrim(coalesce(p_provider_message_id, '')), '') = ''
     or p_kind not in ('text', 'audio')
     or pg_catalog.length(v_content) not between 40 and 4000 then
    return false;
  end if;
  insert into private.sdr_style_examples (
    tenant_id, provider_message_id, phone_tail, goal_tag, kind, content, lead_status, occurred_at
  ) values (
    p_tenant, p_provider_message_id, pg_catalog.right(coalesce(p_phone_tail, ''), 8),
    coalesce(nullif(pg_catalog.btrim(coalesce(p_goal_tag, '')), ''), 'geral'),
    p_kind, v_content, p_lead_status, coalesce(p_occurred_at, pg_catalog.now())
  )
  on conflict (tenant_id, provider_message_id) do nothing;
  return true;
end $$;

-- Os exemplos que a atendente vê antes de responder ESTE lead: primeiro os do
-- mesmo objetivo, depois os de conversa que virou aluno, depois os áudios (é
-- onde o argumento aparece inteiro), e só então os mais recentes.
create or replace function public.sdr_style_examples_for(
  p_tenant text, p_goal text, p_limit integer default 4
)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('goal', goal_tag, 'kind', kind, 'content', content)
      order by ordem
    ),
    '[]'::jsonb
  )
  from (
    select e.goal_tag, e.kind, e.content,
      pg_catalog.row_number() over (
        order by
          case when e.goal_tag = private.sdr_style_goal_tag(p_goal) then 0 else 1 end,
          case when pg_catalog.upper(coalesce(e.lead_status, '')) in ('WON', 'TRIAL_DONE') then 0 else 1 end,
          case when e.kind = 'audio' then 0 else 1 end,
          e.occurred_at desc
      ) as ordem
    from private.sdr_style_examples as e
    where e.tenant_id = p_tenant
      and pg_catalog.length(e.content) between 60 and 1500
  ) as ranqueado
  where ordem <= greatest(1, least(coalesce(p_limit, 4), 8));
$$;

alter function private.sdr_style_goal_tag(text) owner to postgres;
alter function public.sdr_style_pending(integer) owner to postgres;
alter function public.sdr_style_capture(text, text, text, text, text, text, text, timestamptz) owner to postgres;
alter function public.sdr_style_examples_for(text, text, integer) owner to postgres;

revoke all on function public.sdr_style_pending(integer) from public, anon, authenticated;
revoke all on function public.sdr_style_capture(text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sdr_style_examples_for(text, text, integer) from public, anon, authenticated;

grant execute on function public.sdr_style_pending(integer) to service_role;
grant execute on function public.sdr_style_capture(text, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.sdr_style_examples_for(text, text, integer) to service_role;
