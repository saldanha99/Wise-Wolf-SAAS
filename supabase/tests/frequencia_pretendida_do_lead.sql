begin;
-- Frequência pretendida do lead: coluna existe e só aceita 1 a 6.
do $test$
declare v_id uuid;
begin
  select id into v_id from public.crm_leads limit 1;
  if v_id is null then return; end if;
  update public.crm_leads set weekly_frequency = 3 where id = v_id;
  begin
    update public.crm_leads set weekly_frequency = 9 where id = v_id;
    raise exception 'frequencia_pretendida: aceitou 9x por semana';
  exception when check_violation then null;
  end;
end;
$test$;
rollback;
