-- Jornada de 90 dias (18/09/2026): o gerador ganha o tipo `journey` — plano de
-- 12 semanas por objetivo do aluno, com progressão gramatical dentro do nível,
-- checkpoints e ações de retenção. É a "estrutura" que o professor mostra na
-- primeira aula e o que atravessa o 3º mês, onde o aluno autônomo costuma sair.
-- ⚠️ Roda a cada release: re-executável.

alter table public.hub_educator_materials
  drop constraint if exists hub_educator_materials_kind_check;
alter table public.hub_educator_materials
  add constraint hub_educator_materials_kind_check
  check (kind in ('worksheet', 'quiz', 'vocab_cards', 'grammar_drill', 'reading', 'conversation', 'journey'));
