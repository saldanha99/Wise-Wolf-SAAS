-- Material e parte do livro em cada aula; último material do aluno; resumo PENDING no lançamento.
begin;
do $$
declare cl public.class_logs; v_other uuid; v_mat public.pedagogical_materials; r jsonb; v_src text;
begin
  if has_function_privilege('anon', 'public.save_class_log_materials(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.last_class_materials(uuid[])', 'EXECUTE') then
    raise exception 'anon não mexe no material da aula';
  end if;
  if has_table_privilege('authenticated', 'public.class_log_materials', 'SELECT') then
    raise exception 'a tabela só se lê pelas funções';
  end if;
  v_src := pg_get_functiondef('public.get_class_log_meet_drafts(jsonb)'::regprocedure);
  if strpos(v_src, 'material_reference') = 0 or strpos(v_src, $a$'status','PENDING'$a$) = 0 then
    raise exception 'resumo do lançamento sem a parte/página ou sem a aula pendente';
  end if;

  select c.* into cl from public.class_logs c join public.profiles p on p.id = c.teacher_id
   where c.presence = 'COMPLETED' and c.student_id is not null and p.role = 'TEACHER'
     and coalesce(p.lifecycle_status, 'active') = 'active'
   order by c.class_date desc limit 1;
  if cl.id is null then return; end if; -- cópia sem dados
  select p.id into v_other from public.profiles p where p.role = 'TEACHER' and p.tenant_id = cl.tenant_id
     and p.id <> cl.teacher_id and coalesce(p.lifecycle_status, 'active') = 'active' limit 1;
  select * into v_mat from public.pedagogical_materials where tenant_id = cl.tenant_id and approval_status = 'APPROVED' limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', cl.teacher_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', cl.teacher_id::text, true);
  r := public.save_class_log_materials(jsonb_build_array(jsonb_build_object(
    'class_log_id', cl.id, 'material_id', v_mat.id, 'title', 'Livro escrito', 'reference', 'Unit 3, página 34')));
  if (r->>'saved')::int <> 1 then raise exception 'material não gravado: %', r; end if;
  r := public.last_class_materials(array[cl.student_id]);
  if r->cl.student_id::text->>'reference' <> 'Unit 3, página 34' then raise exception 'último material não volta: %', r; end if;
  if v_mat.id is not null and r->cl.student_id::text->>'title' is distinct from v_mat.title then
    raise exception 'material da biblioteca guarda o nome dela: %', r;
  end if;

  -- Limpar.
  r := public.save_class_log_materials(jsonb_build_array(jsonb_build_object('class_log_id', cl.id)));
  if exists (select 1 from public.class_log_materials where class_log_id = cl.id) then raise exception 'limpar não apagou'; end if;

  -- Outro professor não grava na aula de quem deu.
  if v_other is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_other::text, true);
    begin
      perform public.save_class_log_materials(jsonb_build_array(jsonb_build_object('class_log_id', cl.id, 'reference', 'p. 1')));
      raise exception 'outro professor gravou';
    exception when insufficient_privilege then null;
    end;
  end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
end $$;
rollback;
