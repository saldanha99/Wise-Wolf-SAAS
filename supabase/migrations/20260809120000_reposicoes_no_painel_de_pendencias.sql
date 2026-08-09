-- Reposição pendente entra no painel de pendências do diretor.
--
-- Medido em produção (09/08/2026): 109 reposições abertas, 102 SEM DATA — a mais
-- antiga de 04/03/2026, cinco meses parada. Um único professor acumulava 71.
-- Nenhuma delas aparecia em contador nenhum: `director_pending_counts` media
-- acolhimento, presença, materiais, experimentais, fechamentos e reconciliação,
-- mas ignorava reposição por completo.
--
-- Reposição sem data é dívida da escola com o aluno: a aula foi paga (falta do
-- aluno) ou é obrigação do professor (falta dele) e ainda não aconteceu. Enquanto
-- não tem data, ela não aparece em "Lançar Aula" nem em "Pendentes" — só na aba
-- Reposições, que ninguém abre sem motivo. Por isso o passivo cresceu em silêncio.
--
-- Duas contagens separadas, porque exigem ações opostas:
--   `reposicoes`        — sem data: alguém precisa AGENDAR.
--   `reposicoes_vencidas` — com data no passado e ainda não lançada: a aula
--                           passou e ninguém lançou (ou não aconteceu).
--
-- Re-executável: `create or replace`, sem begin/commit (o release.sh roda a lista
-- inteira a cada deploy, dentro da transação dele).

create or replace function public.director_pending_counts()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_tenant text;
  v_recon jsonb;
  v_renov jsonb;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then return '{}'::jsonb; end if;

  v_recon := financial_reconciliation(v_tenant);
  v_renov := contratos_para_renovar(v_tenant);

  return jsonb_build_object(
    'acolhimento', (select count(*) from profiles
        where tenant_id = v_tenant and role = 'STUDENT' and documentation_status = 'PENDING'),
    'presenca', (select count(*) from attendance_confirmations ac
        join class_logs cl on cl.id = ac.class_log_id
        where cl.tenant_id = v_tenant and ac.status = 'CONFLICT'),
    'materiais', (select count(*) from pedagogical_materials
        where tenant_id = v_tenant and approval_status = 'PENDING'),
    'trials', (select count(*) from appointments a
        where a.tenant_id = v_tenant and a.type in ('experimental', 'training')
          and a.status = 'scheduled' and a.start_time <= now()
          and a.start_time >= '2026-06-01'::timestamptz
          and not exists (select 1 from class_logs cl where cl.appointment_id = a.id::text)),
    -- `reschedules.date` é TEXT e guarda 'Pendente' quando ainda não foi
    -- agendada — comparar com data aqui daria erro de cast, então o filtro é
    -- por igualdade de texto mesmo.
    'reposicoes', (select count(*) from reschedules r
        where r.tenant_id = v_tenant and r.used_at is null and r.date = 'Pendente'),
    'reposicoes_vencidas', (select count(*) from reschedules r
        where r.tenant_id = v_tenant and r.used_at is null
          and r.date <> 'Pendente'
          and r.date ~ '^\d{4}-\d{2}-\d{2}$'
          and r.date < to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')),
    'pagamentos_retidos', (select count(*) from class_logs
        where tenant_id = v_tenant and coalesce(payment_hold, false) = true),
    'fechamentos', (select count(*) from teacher_closings
        where tenant_id = v_tenant and status = 'PENDENTE'),
    'sem_assinatura', coalesce((alunos_sem_assinatura(v_tenant)->>'alunos')::int, 0),
    'reconciliacao', coalesce((v_recon->'sem_cobertura'->>'qtd')::int, 0)
                   + coalesce((v_recon->'cobrado_sem_estudar'->>'qtd')::int, 0)
                   + coalesce((v_recon->'arquivado_com_fatura'->>'qtd')::int, 0)
                   + coalesce((v_recon->'pago_sem_nf'->>'qtd')::int, 0)
                   + coalesce((v_recon->'parado_com_nf'->>'qtd')::int, 0)
                   + coalesce((v_recon->'aula_nao_lancada'->>'qtd')::int, 0)
                   + coalesce((v_renov->'vencendo'->>'qtd')::int, 0)
                   + coalesce((v_renov->'encerrado'->>'qtd')::int, 0)
  );
end;
$function$;

-- A migration é aplicada como `supabase_admin` (SUPERUSER) e SECURITY DEFINER
-- roda com os poderes do dono — sem isto a função ganharia poder demais.
alter function public.director_pending_counts() owner to postgres;
grant execute on function public.director_pending_counts() to authenticated;
