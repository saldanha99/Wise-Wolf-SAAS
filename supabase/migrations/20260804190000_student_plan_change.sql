-- Troca de plano do aluno COM assinatura do próprio aluno.
--
-- Antes isso era um UPDATE na mão no banco: mudar `monthly_fee` e
-- `class_frequency` no perfil e pronto. O contrato que o aluno assinou continuava
-- dizendo outra frequência e outro valor — a escola cobrava um número que não
-- estava em documento nenhum.
--
-- REGRA CENTRAL: o valor só muda QUANDO O ALUNO ASSINA. O diretor propõe; a
-- assinatura aplica. Enquanto ninguém assina, a mensalidade continua a antiga —
-- por isso o `update` em `profiles` vive dentro de `sign_student_plan_change`, e
-- em lugar nenhum antes dele.
--
-- A carência (`fidelity_plan`) NÃO é tocada: a troca é de frequência e valor
-- dentro do compromisso que já existe. Ela é só registrada no aditivo para o
-- documento sair completo.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL: o release.sh aplica a lista INTEIRA
-- de migrations a cada deploy, dentro da transação dele. Um `commit;` aqui
-- fecharia a transação do release no meio, e um `create policy` sem o `drop`
-- correspondente derruba o deploy no segundo release (foi o que aconteceu).

create table if not exists public.student_plan_changes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        text not null,
  student_id       uuid not null references public.profiles(id) on delete cascade,
  created_by       uuid,
  -- Token longo: é a única credencial do link público de assinatura.
  token            text not null unique default encode(gen_random_bytes(24), 'hex'),
  from_frequency   text,
  to_frequency     text not null,
  from_monthly_fee numeric(10,2),
  to_monthly_fee   numeric(10,2) not null,
  fidelity_plan    text,
  status           text not null default 'PENDING',
  typed_signature  text,
  signature_ip     text,
  signed_at        timestamptz,
  cancelled_at     timestamptz,
  expires_at       timestamptz not null default (now() + interval '14 days'),
  created_at       timestamptz not null default now(),
  constraint student_plan_changes_status_chk
    check (status in ('PENDING', 'SIGNED', 'CANCELLED'))
);

-- Uma proposta aberta por aluno. Duas em pé fariam o aluno assinar a que chegasse
-- primeiro no WhatsApp, não a que a escola quis valer.
create unique index if not exists uq_plan_change_one_pending
  on public.student_plan_changes (student_id)
  where status = 'PENDING';

create index if not exists ix_plan_change_student on public.student_plan_changes (student_id, created_at desc);

-- A migration roda como supabase_admin; as RPCs SECURITY DEFINER são de postgres.
-- Sem alinhar o dono, as funções não teriam privilégio sobre a própria tabela.
alter table public.student_plan_changes owner to postgres;

alter table public.student_plan_changes enable row level security;

-- Só LEITURA direta (a policy abaixo é que escopa). Gravar é exclusividade das
-- RPCs: aditivo de contrato não se escreve pela API, se assina.
grant select on public.student_plan_changes to authenticated;

-- Leitura: o aluno vê as dele, admin vê as do tenant. Escrita é só pelas RPCs
-- (SECURITY DEFINER) — ninguém grava aditivo direto pela API.
drop policy if exists spc_select on public.student_plan_changes;
create policy spc_select on public.student_plan_changes
  for select to authenticated
  using (
    student_id = (select auth.uid())
    or (
      tenant_id = public._my_tenant_id()
      and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  );

---------------------------------------------------------------------------
-- Normalização de nome para conferir a assinatura.
-- `unaccent` NÃO existe neste banco (conferido) — por isso o translate() na mão.
-- Sem isso, "Victor Hugo de Morais Guimarães" digitado sem o til seria recusado
-- e o aluno ficaria travado sem entender por quê.
---------------------------------------------------------------------------
create or replace function public.normalize_signature_name(p_name text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select btrim(regexp_replace(
    lower(translate(coalesce(p_name, ''),
      'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
      'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')),
    '\s+', ' ', 'g'));
$$;

---------------------------------------------------------------------------
-- 1. O diretor PROPÕE. Nada muda na mensalidade aqui.
---------------------------------------------------------------------------
create or replace function public.create_student_plan_change(
  p_student_id uuid,
  p_to_frequency text,
  p_to_fee numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant text;
  v_from_freq text;
  v_from_fee numeric;
  v_fidelity text;
  v_token text;
  v_freq text;
begin
  select tenant_id, class_frequency, monthly_fee, fidelity_plan
    into v_tenant, v_from_freq, v_from_fee, v_fidelity
    from public.profiles
   where id = p_student_id and role = 'STUDENT';

  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'Aluno não encontrado');
  end if;

  if not (v_tenant = public._my_tenant_id()
          and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])) then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão');
  end if;

  -- Frequência sempre no formato '<n>x' (é assim que o perfil e o contrato leem).
  v_freq := lower(btrim(coalesce(p_to_frequency, '')));
  if v_freq !~ '^[1-9][0-9]?x$' then
    return jsonb_build_object('ok', false, 'error', 'Frequência inválida (use algo como "6x")');
  end if;

  if p_to_fee is null or p_to_fee <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Informe o novo valor da mensalidade');
  end if;

  if v_freq = lower(coalesce(v_from_freq, '')) and p_to_fee = v_from_fee then
    return jsonb_build_object('ok', false, 'error', 'O plano proposto é igual ao atual');
  end if;

  -- Proposta anterior em aberto morre: a última é a que vale.
  update public.student_plan_changes
     set status = 'CANCELLED', cancelled_at = now()
   where student_id = p_student_id and status = 'PENDING';

  insert into public.student_plan_changes (
    tenant_id, student_id, created_by,
    from_frequency, to_frequency, from_monthly_fee, to_monthly_fee, fidelity_plan
  ) values (
    v_tenant, p_student_id, auth.uid(),
    v_from_freq, v_freq, v_from_fee, p_to_fee, v_fidelity
  )
  returning token into v_token;

  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

---------------------------------------------------------------------------
-- 2. A página pública lê a proposta pelo token (aluno deslogado).
--    Devolve só o necessário para montar o aditivo — nada de CPF, endereço,
--    telefone: o link circula por WhatsApp e pode ser repassado.
---------------------------------------------------------------------------
create or replace function public.get_plan_change_public(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
           'student_name', p.full_name,
           'from_frequency', c.from_frequency,
           'to_frequency', c.to_frequency,
           'from_monthly_fee', c.from_monthly_fee,
           'to_monthly_fee', c.to_monthly_fee,
           'fidelity_plan', c.fidelity_plan,
           'due_day', p.due_day,
           'status', c.status,
           'signed_at', c.signed_at,
           'expired', (c.expires_at < now()),
           'school_name', t.name
         )
    into v
    from public.student_plan_changes c
    join public.profiles p on p.id = c.student_id
    left join public.tenants t on t.id = c.tenant_id
   where c.token = p_token;

  if v is null then
    return jsonb_build_object('ok', false, 'error', 'Proposta não encontrada');
  end if;

  return jsonb_build_object('ok', true, 'data', v);
end;
$$;

---------------------------------------------------------------------------
-- 3. A ASSINATURA aplica. É o único lugar que mexe na mensalidade.
---------------------------------------------------------------------------
create or replace function public.sign_student_plan_change(
  p_token text,
  p_typed_signature text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_change public.student_plan_changes%rowtype;
  v_name text;
begin
  select * into v_change from public.student_plan_changes where token = p_token for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Proposta não encontrada');
  end if;

  -- Reassinar não cobra de novo nem reaplica: o link volta a abrir e diz que já foi.
  if v_change.status = 'SIGNED' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if v_change.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta foi substituída por outra. Peça o link novo à escola.');
  end if;

  if v_change.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta expirou. Peça um link novo à escola.');
  end if;

  select full_name into v_name from public.profiles where id = v_change.student_id;

  if public.normalize_signature_name(p_typed_signature) is distinct from public.normalize_signature_name(v_name)
     or btrim(coalesce(p_typed_signature, '')) = '' then
    return jsonb_build_object('ok', false, 'error', 'A assinatura precisa ser exatamente o nome completo do aluno.');
  end if;

  -- AQUI o plano passa a valer. Antes desta linha, a escola cobra o valor antigo.
  update public.profiles
     set monthly_fee = v_change.to_monthly_fee,
         class_frequency = v_change.to_frequency
   where id = v_change.student_id;

  update public.student_plan_changes
     set status = 'SIGNED',
         typed_signature = btrim(p_typed_signature),
         signature_ip = coalesce(
           nullif(btrim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
           'Via Web (Digital)'
         ),
         signed_at = now()
   where id = v_change.id;

  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

---------------------------------------------------------------------------
-- 4. Histórico para a ficha do aluno.
---------------------------------------------------------------------------
create or replace function public.list_student_plan_changes(p_student_id uuid)
returns setof public.student_plan_changes
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.*
    from public.student_plan_changes c
   where c.student_id = p_student_id
     and (
       c.student_id = (select auth.uid())
       or (c.tenant_id = public._my_tenant_id()
           and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN']))
     )
   order by c.created_at desc;
$$;

-- SECURITY DEFINER roda com os poderes do DONO. A migration é aplicada como
-- supabase_admin (SUPERUSER) — sem trocar o dono, estas funções virariam
-- superusuário disfarçado de RPC.
alter function public.normalize_signature_name(text) owner to postgres;
alter function public.create_student_plan_change(uuid, text, numeric) owner to postgres;
alter function public.get_plan_change_public(text) owner to postgres;
alter function public.sign_student_plan_change(text, text) owner to postgres;
alter function public.list_student_plan_changes(uuid) owner to postgres;

grant execute on function public.create_student_plan_change(uuid, text, numeric) to authenticated;
grant execute on function public.list_student_plan_changes(uuid) to authenticated;
-- O aluno assina deslogado, pelo link — por isso anon.
grant execute on function public.get_plan_change_public(text) to anon, authenticated;
grant execute on function public.sign_student_plan_change(text, text) to anon, authenticated;
