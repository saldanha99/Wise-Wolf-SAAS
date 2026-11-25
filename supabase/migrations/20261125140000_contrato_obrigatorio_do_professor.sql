-- Contrato geral obrigatório para o professor novo (decisão da direção, 25/11/2026).
-- Professor criado direto pela direção (create-teacher-account) nasce sem contrato e
-- só via uma faixa no Início; o Teacher Daniel navegou sem assinar. Agora, para contas
-- criadas a partir de 25/11/2026, sem contrato aceito e sem dispensa da direção, o
-- portal abre um pop-up que só fecha com a assinatura. Contas antigas não mudam (a
-- regularização delas segue pela faixa), e a dispensa (private.teacher_general_contract_waivers)
-- continua valendo.
--
-- Antes de assinar, o professor informa CPF, RG, nascimento e endereço: sem isso o
-- contrato de pessoa física sairia com "---" no lugar dos dados dele.

create or replace function private.teacher_contract_gate_since()
returns timestamptz language sql immutable set search_path = '' as $$
  select timestamptz '2026-11-25 00:00:00-03';
$$;
alter function private.teacher_contract_gate_since() owner to postgres;
revoke all on function private.teacher_contract_gate_since() from public, anon, authenticated, service_role;

create or replace function public.my_teacher_contract_gate()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.profiles; v_missing text[] := '{}';
begin
  if v_uid is null then return jsonb_build_object('required', false); end if;
  select * into p from public.profiles where id = v_uid;
  if p.id is null or p.role is distinct from 'TEACHER'
     or coalesce(p.contract_accepted, false)
     or coalesce(p.lifecycle_status, 'active') <> 'active'
     or p.created_at < private.teacher_contract_gate_since()
     or private.teacher_general_contract_waived(p.tenant_id, p.id) then
    return jsonb_build_object('required', false);
  end if;
  if not public.is_valid_cpf(p.cpf) then v_missing := v_missing || 'cpf'::text; end if;
  if nullif(btrim(coalesce(p.rg, '')), '') is null then v_missing := v_missing || 'rg'::text; end if;
  if p.birth_date is null then v_missing := v_missing || 'birth_date'::text; end if;
  if length(btrim(coalesce(p.address, ''))) < 5 then v_missing := v_missing || 'address'::text; end if;
  return jsonb_build_object('required', true, 'missing', to_jsonb(v_missing));
end;
$$;
alter function public.my_teacher_contract_gate() owner to postgres;
revoke all on function public.my_teacher_contract_gate() from public, anon, service_role;
grant execute on function public.my_teacher_contract_gate() to authenticated;

create or replace function public.save_my_teacher_contract_identity(
  p_cpf text, p_rg text, p_birth_date date, p_address text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.profiles;
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_rg text := btrim(coalesce(p_rg, '')); v_address text := btrim(coalesce(p_address, ''));
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'nao_autenticado'); end if;
  select * into p from public.profiles where id = v_uid;
  if p.id is null or p.role is distinct from 'TEACHER' then
    return jsonb_build_object('ok', false, 'error', 'apenas_professor');
  end if;
  -- Dado pessoal do contrato já assinado não muda por aqui.
  if coalesce(p.contract_accepted, false) then
    return jsonb_build_object('ok', false, 'error', 'contrato_ja_assinado');
  end if;
  if not public.is_valid_cpf(v_cpf) then return jsonb_build_object('ok', false, 'error', 'cpf_invalido'); end if;
  if length(v_rg) not between 3 and 30 then return jsonb_build_object('ok', false, 'error', 'rg_invalido'); end if;
  if p_birth_date is null or p_birth_date > (now() at time zone 'America/Sao_Paulo')::date - interval '16 years'
     or p_birth_date < date '1900-01-01' then
    return jsonb_build_object('ok', false, 'error', 'nascimento_invalido');
  end if;
  if length(v_address) not between 5 and 300 then return jsonb_build_object('ok', false, 'error', 'endereco_invalido'); end if;
  if exists (select 1 from public.profiles other where other.id <> v_uid and other.tenant_id = p.tenant_id
               and other.role = 'TEACHER' and regexp_replace(coalesce(other.cpf, ''), '\D', '', 'g') = v_cpf) then
    return jsonb_build_object('ok', false, 'error', 'cpf_em_uso');
  end if;
  update public.profiles set cpf = v_cpf, rg = v_rg, birth_date = p_birth_date, address = v_address
   where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;
alter function public.save_my_teacher_contract_identity(text, text, date, text) owner to postgres;
revoke all on function public.save_my_teacher_contract_identity(text, text, date, text) from public, anon, service_role;
grant execute on function public.save_my_teacher_contract_identity(text, text, date, text) to authenticated;
