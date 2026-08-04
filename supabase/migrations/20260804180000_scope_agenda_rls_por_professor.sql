-- Escopo de reposição por professor no BANCO, não só na tela.
--
-- Políticas permissivas do Postgres são OR: basta UMA liberar para o resto não
-- valer nada. Em `reschedules` conviviam duas —
--
--   Reschedules: Access control  FOR ALL  USING (tenant AND (dono OU admin))   <- certa
--   reschedules_tenant_scope     FOR ALL  USING (tenant OU aluno OU professor) <- anula a de cima
--
-- — e a segunda deixava QUALQUER usuário autenticado da escola ler, alterar e
-- APAGAR a reposição de qualquer professor. Nenhuma tela explorava isso (todas
-- filtram por teacher_id), mas a API do PostgREST é pública para quem está logado:
-- bastava o id da linha. E reposição é dinheiro — é o `fault_type` dela que decide
-- se a aula paga —, então reatribuir ou apagar uma linha mexe direto na folha.
--
-- Regra que fica: o professor mexe no que é DELE; admin/coordenador no tenant;
-- o aluno LÊ a própria reposição. Aluno nunca escreveu em agenda e continua sem.
--
-- ⚠️ ESCOPO DELIBERADO: `bookings` e `class_coverages` têm exatamente o mesmo furo
-- (`bookings_admin_write` e `cc_write`, ambas FOR ALL com USING só de tenant —
-- qualquer TEACHER escreve qualquer agendamento da escola). NÃO foram corrigidas
-- aqui porque apertar `bookings` quebra a cobertura de aulas: `LessonLauncher` lê
-- de propósito o agendamento de OUTRO professor para montar a aula assumida
-- (`assumedBookings`). Fechar isso exige liberar leitura via `class_coverages` e
-- reauditar ~20 pontos de acesso — mudança própria, com verificação própria.

begin;

drop policy if exists "reschedules_tenant_scope" on public.reschedules;
drop policy if exists "Reschedules: Access control" on public.reschedules;

-- Leitura: dono, aluno da reposição, ou admin do tenant.
create policy reschedules_select on public.reschedules
  for select to authenticated
  using (
    teacher_id = (select auth.uid())
    or student_id = (select auth.uid())
    or (
      tenant_id = public._my_tenant_id()
      and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  );

-- Escrita: só professor dono e admin, sempre dentro do tenant.
-- O `with check` repete a condição de propósito: sem ele dá para gravar a linha já
-- apontando para OUTRO professor — o `using` só enxerga a linha ANTES do update, e
-- era justamente reatribuir dono que movia a reposição de agenda.
create policy reschedules_write on public.reschedules
  for all to authenticated
  using (
    tenant_id = public._my_tenant_id()
    and (
      teacher_id = (select auth.uid())
      or public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  )
  with check (
    tenant_id = public._my_tenant_id()
    and (
      teacher_id = (select auth.uid())
      or public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  );

commit;
