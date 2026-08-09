-- A policy que deixava qualquer professor escrever em aluno de QUALQUER escola.
--
-- `Teachers update unlocked_tests` tinha:
--     USING      (role = 'STUDENT')
--     WITH CHECK (_my_role() in ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN'))
--
-- Nenhum filtro de tenant no USING. E policies permissivas se somam com OR — basta
-- UMA liberar para as outras não valerem nada (mesma armadilha da migration
-- 20260804180000, que já custou a agenda).
--
-- Medido em produção (09/08/2026), contando linhas por pessoa real:
--
--   Prof. Lobo (wise-wolf-school)     escopo legítimo 2 → a policy dava 57
--   Ricardo Silva (royal-british)     escopo legítimo 2 → a policy dava 57
--   Diretoria Royal (royal-british)   escopo legítimo 2 → a policy dava 57
--
-- Ou seja: os 55 alunos da Wise Wolf ficavam graváveis por professor e diretor de
-- outra escola. O estrago não acontecia porque a policy de LEITURA
-- (`profiles_scoped_read_p0`) é escopada e os triggers de campo barram o resto —
-- mas a defesa estava apoiada na peça errada. Se alguém mexer na leitura um dia,
-- isto abre sozinho.
--
-- ⚠️ NÃO basta apagar a policy. Ela é a ÚNICA que dá ao SUPER_ADMIN escrita em
-- aluno fora do tenant dele (`master`): as outras cinco exigem
-- `tenant_id = _my_tenant_id()`. Apagar sem repor tiraria do suporte da plataforma
-- a capacidade de corrigir aluno de escola cliente — sem erro visível, só um
-- "não salvou". Por isso a nova policy PRESERVA o SUPER_ADMIN e fecha o resto.
--
-- O nome antigo também mentia: falava de `unlocked_tests`, mas policy não
-- restringe coluna — ela liberava a LINHA inteira.
--
-- Re-executável: `drop policy if exists` antes de criar.

drop policy if exists "Teachers update unlocked_tests" on public.profiles;
drop policy if exists "profiles_update_student_scoped" on public.profiles;

create policy "profiles_update_student_scoped"
  on public.profiles
  for update
  to authenticated
  using (
    role = 'STUDENT'
    and (
      -- Operador da plataforma: atravessa tenant de propósito.
      _my_role() = 'SUPER_ADMIN'
      -- Quem é da escola só alcança aluno da própria escola.
      or (
        tenant_id = _my_tenant_id()
        and _my_role() = any (array['TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR'])
      )
    )
  )
  with check (
    -- O `with check` REPETE a condição de propósito: o `using` só enxerga a linha
    -- ANTES do update. Sem isto dá para gravar a linha já apontando para outro
    -- tenant — que é exatamente como um aluno migraria de escola.
    role = 'STUDENT'
    and (
      _my_role() = 'SUPER_ADMIN'
      or (
        tenant_id = _my_tenant_id()
        and _my_role() = any (array['TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR'])
      )
    )
  );
