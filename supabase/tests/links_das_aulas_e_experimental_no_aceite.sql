-- Links das aulas e sala da experimental no aceite (migration 20261102140000).
-- Roda dentro da transação do release; nada sai da transação.
begin;

do $test$
declare
  v_def text;
  v_admin uuid;
  v_tenant text;
  v_student uuid;
  v_res jsonb;
  v_denied boolean := false;
begin
  -- A sala da experimental nasce até 30 dias antes (antes: 24 h).
  v_def := pg_catalog.pg_get_functiondef('public.trial_meet_backend(text,jsonb)'::regprocedure);
  if v_def not like '%interval ''30 days''%' or v_def like '%now() + interval ''24 hours''%' then
    raise exception 'trial_meet_backend ainda espera 24 h para criar a sala';
  end if;

  -- O aviso ao lead não repete quem já recebeu para aquela data.
  v_def := pg_catalog.pg_get_functiondef('public.trial_meet_link_notices(integer)'::regprocedure);
  if v_def not like '%TRIAL_MEET_LINK%' then
    raise exception 'trial_meet_link_notices não filtra quem já recebeu o link';
  end if;

  -- Privilégios: logado chama; anônimo não.
  if has_function_privilege('anon', 'public.my_lesson_links(date,date)', 'EXECUTE') then
    raise exception 'my_lesson_links não pode ser chamada sem login';
  end if;
  if not has_function_privilege('authenticated', 'public.my_lesson_links(date,date)', 'EXECUTE') then
    raise exception 'my_lesson_links precisa estar liberada para quem está logado';
  end if;
  if has_function_privilege('authenticated', 'public.trial_meet_link_notices(integer)', 'EXECUTE') then
    raise exception 'trial_meet_link_notices é só do servidor';
  end if;

  select p.id, p.tenant_id into v_admin, v_tenant
    from public.profiles p
   where p.role = 'SCHOOL_ADMIN' and coalesce(p.lifecycle_status, 'active') = 'active'
   order by p.created_at limit 1;
  if v_admin is null then
    raise notice 'links_das_aulas: sem diretor ativo; parte de leitura pulada';
    return;
  end if;

  -- A direção vê todas as aulas da escola; cada aula traz um link_kind válido.
  perform set_config('request.jwt.claims', pg_catalog.json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_res := public.my_lesson_links(current_date, current_date + 1);
  if pg_catalog.jsonb_typeof(v_res -> 'lessons') <> 'array' then
    raise exception 'my_lesson_links não devolveu a lista de aulas';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_res -> 'lessons') e
              where e ->> 'link_kind' not in ('escola', 'preparando', 'pessoal', 'sem_link')
                 or (e ->> 'link_kind' in ('preparando', 'sem_link') and e ->> 'link' is not null)) then
    raise exception 'my_lesson_links devolveu link para aula sem link válido';
  end if;

  -- O aluno só vê as próprias aulas, e nunca o e-mail da conta central.
  select s.student_id into v_student from public.lesson_sessions s
   where s.tenant_id = v_tenant and s.class_date between current_date and current_date + 1
     and s.status <> 'SUPERSEDED'
   limit 1;
  if v_student is not null then
    perform set_config('request.jwt.claims', pg_catalog.json_build_object('sub', v_student, 'role', 'authenticated')::text, true);
    v_res := public.my_lesson_links(current_date, current_date + 1);
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_res -> 'lessons') e
                where e ->> 'student_id' is distinct from v_student::text) then
      raise exception 'aluno viu aula de outra pessoa';
    end if;
    if v_res ->> 'organizer_email' is not null then
      raise exception 'aluno recebeu o e-mail da conta central';
    end if;
  end if;

  -- Sem login: recusa.
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.my_lesson_links();
  exception when others then v_denied := true;
  end;
  if not v_denied then
    raise exception 'my_lesson_links respondeu sem login';
  end if;
end
$test$;

rollback;
