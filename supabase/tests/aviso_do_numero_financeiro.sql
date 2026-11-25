-- Aviso do número financeiro: só aluno logado vê, e só na escola cadastrada.
begin;
do $$
declare v_tenant text; v_student uuid; v_admin uuid; v_result jsonb;
begin
  if has_function_privilege('anon', 'public.my_finance_whatsapp_notice()', 'EXECUTE') then
    raise exception 'anon não pode consultar o aviso do financeiro';
  end if;
  if has_table_privilege('authenticated', 'private.finance_whatsapp_contacts', 'SELECT') then
    raise exception 'o telefone do financeiro não pode ser lido direto';
  end if;

  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  if public.my_finance_whatsapp_notice() is not null then
    raise exception 'sem login não há aviso';
  end if;

  select p.tenant_id, p.id into v_tenant, v_student from public.profiles p
  where p.role = 'STUDENT' and p.tenant_id is not null
    and public.is_student_notifiable(p.id)
    and not exists (select 1 from public.feature_tour_views v where v.user_id = p.id and v.tour_id = 'aviso-2026-11-22-numero-financeiro')
  limit 1;
  if v_student is null then return; end if; -- banco sem aluno (cópia de estrutura)

  insert into private.finance_whatsapp_contacts (tenant_id, phone, notice_starts_on)
  values (v_tenant, '5511900000000', (now() at time zone 'America/Sao_Paulo')::date)
  on conflict (tenant_id) do update set phone = excluded.phone,
    notice_starts_on = excluded.notice_starts_on, notice_until = null;

  perform set_config('request.jwt.claims', json_build_object('sub', v_student, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_student::text, true);
  v_result := public.my_finance_whatsapp_notice();
  if v_result is null or v_result->>'phone' <> '5511900000000' then
    raise exception 'aluno da escola cadastrada deveria ver o aviso: %', v_result;
  end if;

  insert into public.feature_tour_views (user_id, tour_id) values (v_student, v_result->>'notice_id');
  if public.my_finance_whatsapp_notice() is not null then
    raise exception 'depois do Entendi o aviso não volta';
  end if;

  select p.id into v_admin from public.profiles p
  where p.tenant_id = v_tenant and p.role = 'SCHOOL_ADMIN' limit 1;
  if v_admin is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_admin::text, true);
    if public.my_finance_whatsapp_notice() is not null then
      raise exception 'o aviso é só para aluno';
    end if;
  end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
end $$;
rollback;
