-- Motor de material v2 (18/09/2026): todo material passa a carregar o objetivo
-- do aluno e a faixa etária que o personalizaram — é o que permite reabrir o
-- histórico sabendo "para quem" aquilo foi feito. O conteúdo novo (foco
-- gramatical por nível, porta que abre, homework com IA, estratégias de leitura)
-- vive dentro de `material` (jsonb), sem coluna nova.
-- ⚠️ Roda a cada release: re-executável.

alter table public.hub_educator_materials
  add column if not exists goal text not null default ''
    check (pg_catalog.char_length(goal) <= 200);

alter table public.hub_educator_materials
  add column if not exists audience text not null default 'adults'
    check (audience in ('kids', 'teens', 'adults'));
