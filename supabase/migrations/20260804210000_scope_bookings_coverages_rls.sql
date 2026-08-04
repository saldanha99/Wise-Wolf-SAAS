-- Fecha em `bookings` e `class_coverages` o mesmo furo já corrigido em
-- `reschedules`: políticas permissivas do Postgres são OR, então
--
--   bookings_admin_write  FOR ALL  USING (tenant AND role IN (ADMIN, TEACHER, ...))
--
-- deixava QUALQUER professor da escola criar, alterar e APAGAR o agendamento de
-- qualquer colega pela API. E agendamento é dinheiro: o pagamento do professor é
-- `class_logs` pagáveis × tarifa, e o log nasce do booking.
--
-- ⚠️ O QUE QUASE QUEBROU A PRODUÇÃO: a primeira versão só liberava leitura do
-- booking próprio — e isso derruba a COBERTURA DE AULA. O `LessonLauncher` lê de
-- propósito o agendamento de OUTRO professor para montar a aula assumida
-- (`assumedBookings`, via `.in('id', ids)`); sem isso o professor que assumiu a
-- aula não a vê e não consegue lançar, ou seja, não recebe. Por isso o `select`
-- abaixo tem o ramo de `class_coverages`.
--
-- Sem recursão: `bookings_select` consulta `class_coverages`, e as policies de
-- `class_coverages` não consultam `bookings`.

---------------------------------------------------------------------------
-- bookings
---------------------------------------------------------------------------
-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL: o release.sh aplica a lista INTEIRA
-- de migrations a cada deploy, dentro da transação dele. Um `commit;` aqui
-- fecharia a transação do release no meio, e um `create policy` sem o `drop`
-- correspondente derruba o deploy no segundo release (foi o que aconteceu).

drop policy if exists "bookings_admin_write" on public.bookings;
drop policy if exists "bookings_tenant_select" on public.bookings;
drop policy if exists "Bookings: Access control" on public.bookings;

drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (
    teacher_id = (select auth.uid())
    or student_id = (select auth.uid())
    -- Aula assumida por cobertura: quem vai dar a aula precisa enxergar o
    -- agendamento do colega para lançá-la.
    or exists (
      select 1 from public.class_coverages c
       where c.booking_id = bookings.id
         and c.cover_teacher_id = (select auth.uid())
    )
    or (
      tenant_id = public._my_tenant_id()
      and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  );

-- Escrita: o professor mexe na PRÓPRIA agenda; admin/coordenador na da escola.
-- O `with check` repete a condição porque o `using` só enxerga a linha ANTES do
-- update — sem ele daria para reatribuir o booking para outro professor.
drop policy if exists bookings_write on public.bookings;
create policy bookings_write on public.bookings
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

---------------------------------------------------------------------------
-- class_coverages
-- Cobertura tem DOIS donos legítimos: quem cede e quem assume — um oferece, o
-- outro aceita. Por isso a condição cita os dois lados.
---------------------------------------------------------------------------
drop policy if exists "cc_write" on public.class_coverages;

drop policy if exists cc_write on public.class_coverages;
create policy cc_write on public.class_coverages
  for all to authenticated
  using (
    tenant_id = public._my_tenant_id()
    and (
      original_teacher_id = (select auth.uid())
      or cover_teacher_id = (select auth.uid())
      or public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  )
  with check (
    tenant_id = public._my_tenant_id()
    and (
      original_teacher_id = (select auth.uid())
      or cover_teacher_id = (select auth.uid())
      or public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])
    )
  );
