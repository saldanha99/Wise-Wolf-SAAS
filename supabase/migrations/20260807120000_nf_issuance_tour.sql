-- Tour obrigatório de emissão de Nota Fiscal para o professor.
--
-- O problema: todo mês, todo professor pergunta à coordenação o CNPJ do tomador,
-- a razão social e o código de tributação. A informação existe, mas mora num
-- print no WhatsApp de alguém — então a coordenação responde a mesma coisa
-- dezenas de vezes e a nota volta errada quando o professor lembra de cabeça.
--
-- A regra: quando o financeiro autoriza o pagamento, o professor vê as
-- instruções UMA VEZ por fechamento, antes de olhar o dinheiro. Confirmou a
-- leitura, não vê mais naquele fechamento.
--
-- ⚠️ OS DADOS DO TOMADOR NÃO ENTRAM NO REPOSITÓRIO. Duas razões, ambas
-- eliminatórias:
--   1. O CLAUDE.md proíbe dado sensível da escola (CNPJ, razão social) em
--      código versionado.
--   2. Isto é um SaaS multi-tenant. CNPJ chumbado faria a escola B emitir nota
--      contra o CNPJ da escola A — erro fiscal, não erro de tela.
-- Por isso a migration cria a TABELA vazia e o diretor preenche (tela de
-- configuração ou insert direto na VPS). Sem configuração, o tour não aparece:
-- é melhor não aparecer do que aparecer com o CNPJ errado.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL: o release.sh aplica a lista INTEIRA
-- de migrations a cada deploy, dentro da transação dele.

---------------------------------------------------------------------------
-- 1. Configuração fiscal por escola (o "tomador do serviço").
---------------------------------------------------------------------------
create table if not exists public.tenant_nf_settings (
  tenant_id             text primary key,
  cnpj                  text,
  razao_social          text,
  nome_fantasia         text,
  codigo_tributacao     text,
  -- Texto legal do código (ex.: "Instrução, treinamento, orientação
  -- pedagógica..."). Guardado junto porque o professor copia isso para a nota.
  descricao_tributacao  text,
  descricao_servico     text,
  portal_url            text,
  observacoes           text,
  is_active             boolean not null default true,
  updated_by            uuid,
  updated_at            timestamptz not null default now()
);

alter table public.tenant_nf_settings owner to postgres;
alter table public.tenant_nf_settings enable row level security;

grant select on public.tenant_nf_settings to authenticated;

-- Leitura: qualquer pessoa autenticada da escola. O professor PRECISA ler para
-- emitir a nota, e não há nada aqui que não esteja na nota que ele mesmo emite.
-- Escrita é exclusividade da RPC — dado fiscal não se edita pela API.
drop policy if exists tns_select on public.tenant_nf_settings;
create policy tns_select on public.tenant_nf_settings
  for select to authenticated
  using (tenant_id = public._my_tenant_id() or public._my_role() = 'SUPER_ADMIN');

---------------------------------------------------------------------------
-- 2. O aceite vive no próprio fechamento.
--
-- "Uma vez por fechamento" é literalmente uma coluna no fechamento: um
-- fechamento pertence a um professor, então não existe cardinalidade a modelar.
-- Tabela separada só criaria uma junção para responder a mesma pergunta.
---------------------------------------------------------------------------
alter table public.teacher_closings
  add column if not exists nf_tour_ack_at timestamptz;

---------------------------------------------------------------------------
-- 3. Quais fechamentos exigem o tour.
--
-- Gatilho = pagamento autorizado E nota ainda não anexada E leitura não
-- confirmada. Os três estados de "autorizado" convivem por história do sistema:
-- `PAID_WAITING_NF` (fluxo atual), `PAGO` (o que AdminFinancialApproval grava)
-- e `COMPLETED`. Cobrir os três evita que o tour dependa de qual tela o
-- financeiro usou para liberar.
---------------------------------------------------------------------------
create or replace function public.nf_tour_is_pending(
  p_status text,
  p_nf_link text,
  p_ack_at timestamptz
)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select p_ack_at is null
     and coalesce(btrim(p_nf_link), '') = ''
     and upper(coalesce(p_status, '')) in ('PAID_WAITING_NF', 'PAGO', 'COMPLETED');
$$;

alter function public.nf_tour_is_pending(text, text, timestamptz) owner to postgres;

---------------------------------------------------------------------------
-- 4. O que a tela do professor pede: instruções + o fechamento que as exige.
--
-- Uma chamada só. A tela não monta a regra de "precisa mostrar?" no navegador —
-- ela pergunta ao servidor, que é quem sabe o status real do fechamento.
---------------------------------------------------------------------------
create or replace function public.get_nf_issuance_context()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := (select auth.uid());
  v_tenant text;
  v_settings public.tenant_nf_settings%rowtype;
  v_pending jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Não autenticado');
  end if;

  select tenant_id into v_tenant from public.profiles where id = v_uid;
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'Perfil sem escola');
  end if;

  select * into v_settings
    from public.tenant_nf_settings
   where tenant_id = v_tenant and is_active;

  -- O fechamento autorizado MAIS RECENTE ainda sem nota.
  --
  -- ⚠️ Era `asc` (mais antigo primeiro) até o teste contra produção mostrar o
  -- estrago: um professor tem cinco fechamentos pagos de 2026-02 a 2026-06 sem
  -- NF, e o tour anunciaria "seu pagamento de fevereiro foi autorizado" por
  -- R$ 7,50 — seis meses atrasado e trivial. O pedido é "quando houver um NOVO
  -- pagamento autorizado", então o recente é o certo.
  --
  -- Os antigos não somem: cada um reaparece, um por vez, conforme o mais novo é
  -- resolvido. Cobrar NF atrasada em lote é trabalho do diretor no InvoiceManager,
  -- não de um modal que abre na frente do professor.
  select jsonb_build_object(
           'id', c.id,
           'month_year', c.month_year,
           'total_amount', c.total_amount,
           'total_lessons', c.total_lessons,
           'status', c.status
         )
    into v_pending
    from public.teacher_closings c
   where c.teacher_id = v_uid
     and public.nf_tour_is_pending(c.status, c.nf_link, c.nf_tour_ack_at)
   order by c.month_year desc
   limit 1;

  return jsonb_build_object(
    'ok', true,
    -- `configured` false = a escola ainda não preencheu o tomador. A tela mostra
    -- um aviso para procurar a coordenação em vez de instruções pela metade.
    'configured', v_settings.tenant_id is not null
                  and coalesce(btrim(v_settings.cnpj), '') <> '',
    'settings', case
      when v_settings.tenant_id is null then null
      else jsonb_build_object(
        'cnpj', v_settings.cnpj,
        'razao_social', v_settings.razao_social,
        'nome_fantasia', v_settings.nome_fantasia,
        'codigo_tributacao', v_settings.codigo_tributacao,
        'descricao_tributacao', v_settings.descricao_tributacao,
        'descricao_servico', v_settings.descricao_servico,
        'portal_url', v_settings.portal_url,
        'observacoes', v_settings.observacoes
      )
    end,
    'pending', v_pending
  );
end;
$$;

alter function public.get_nf_issuance_context() owner to postgres;
grant execute on function public.get_nf_issuance_context() to authenticated;

---------------------------------------------------------------------------
-- 5. "Entendi" — o aceite.
--
-- Só o dono do fechamento marca, e só marca ESTA coluna. Por isso é RPC e não
-- um update pelo navegador: o professor tem UPDATE em `teacher_closings`, e um
-- update livre a partir da tela é como se escreve num campo que não era para
-- ser escrito.
---------------------------------------------------------------------------
create or replace function public.ack_nf_tour(p_closing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := (select auth.uid());
  v_owner uuid;
  v_ack timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Não autenticado');
  end if;

  select teacher_id, nf_tour_ack_at into v_owner, v_ack
    from public.teacher_closings
   where id = p_closing_id;

  if v_owner is null then
    return jsonb_build_object('ok', false, 'error', 'Fechamento não encontrado');
  end if;

  if v_owner <> v_uid then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão');
  end if;

  -- Idempotente: reconfirmar não reescreve a data do primeiro aceite.
  if v_ack is not null then
    return jsonb_build_object('ok', true, 'already', true, 'acked_at', v_ack);
  end if;

  update public.teacher_closings
     set nf_tour_ack_at = now()
   where id = p_closing_id;

  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

alter function public.ack_nf_tour(uuid) owner to postgres;
grant execute on function public.ack_nf_tour(uuid) to authenticated;

---------------------------------------------------------------------------
-- 6. O diretor configura o tomador.
---------------------------------------------------------------------------
create or replace function public.save_nf_settings(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := (select auth.uid());
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
begin
  if v_uid is null or v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'Não autenticado');
  end if;

  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão');
  end if;

  insert into public.tenant_nf_settings as t (
    tenant_id, cnpj, razao_social, nome_fantasia, codigo_tributacao,
    descricao_tributacao, descricao_servico, portal_url, observacoes,
    is_active, updated_by, updated_at
  ) values (
    v_tenant,
    btrim(p_payload->>'cnpj'),
    btrim(p_payload->>'razao_social'),
    btrim(p_payload->>'nome_fantasia'),
    btrim(p_payload->>'codigo_tributacao'),
    btrim(p_payload->>'descricao_tributacao'),
    btrim(p_payload->>'descricao_servico'),
    btrim(p_payload->>'portal_url'),
    btrim(p_payload->>'observacoes'),
    coalesce((p_payload->>'is_active')::boolean, true),
    v_uid,
    now()
  )
  on conflict (tenant_id) do update set
    cnpj                 = excluded.cnpj,
    razao_social         = excluded.razao_social,
    nome_fantasia        = excluded.nome_fantasia,
    codigo_tributacao    = excluded.codigo_tributacao,
    descricao_tributacao = excluded.descricao_tributacao,
    descricao_servico    = excluded.descricao_servico,
    portal_url           = excluded.portal_url,
    observacoes          = excluded.observacoes,
    is_active            = excluded.is_active,
    updated_by           = excluded.updated_by,
    updated_at           = now();

  return jsonb_build_object('ok', true);
end;
$$;

alter function public.save_nf_settings(jsonb) owner to postgres;
grant execute on function public.save_nf_settings(jsonb) to authenticated;
