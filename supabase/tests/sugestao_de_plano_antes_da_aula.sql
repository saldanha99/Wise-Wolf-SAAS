-- Preferência do pop-up do plano: cada professor lê e grava só a própria linha.
do $test$
declare
  v_a uuid;
  v_b uuid;
  v_count int;
begin
  select id into v_a from public.profiles where role = 'TEACHER' order by id limit 1;
  select id into v_b from public.profiles where role = 'TEACHER' and id <> v_a order by id limit 1;
  if v_a is null or v_b is null then
    raise notice 'sugestao_de_plano: sem dois professores, teste pulado';
    return;
  end if;
  delete from public.teacher_lesson_plan_prompt_prefs where user_id in (v_a, v_b);
  insert into public.teacher_lesson_plan_prompt_prefs (user_id, disabled) values (v_b, true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.teacher_lesson_plan_prompt_prefs (user_id, disabled) values (v_a, true);
  select count(*) into v_count from public.teacher_lesson_plan_prompt_prefs;
  if v_count <> 1 then
    raise exception 'sugestao_de_plano: professor enxerga preferência de outro (%)', v_count;
  end if;
  begin
    insert into public.teacher_lesson_plan_prompt_prefs (user_id, disabled) values (v_b, false);
    raise exception 'sugestao_de_plano: gravou preferência de outro professor';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  delete from public.teacher_lesson_plan_prompt_prefs where user_id in (v_a, v_b);
end;
$test$;
