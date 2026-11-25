-- Livros do Gamma com conteúdo escrito e validado por nós (pedido do Chefe 87c4e46c, 23/11/2026).
-- O gerador escreve o livro em blocos (JSON com exercícios estruturados e resposta por item),
-- valida por código (_shared/exercise-validator.ts), confere com o modelo e monta o gabarito;
-- o Gamma só diagrama (textMode preserve). O estado da escrita fica em `content`.
-- Aditiva. Desfazer: as colunas podem ficar (livro antigo, sem `content`, segue o fluxo de antes).
alter table public.school_book_generations
  add column if not exists content jsonb,
  add column if not exists content_lease_until timestamptz,
  add column if not exists image_style text;

do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'school_book_generations_content_check'
                 and conrelid = 'public.school_book_generations'::regclass) then
    alter table public.school_book_generations add constraint school_book_generations_content_check
      check (content is null or jsonb_typeof(content) = 'object');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'school_book_generations_image_style_check'
                 and conrelid = 'public.school_book_generations'::regclass) then
    alter table public.school_book_generations add constraint school_book_generations_image_style_check
      check (image_style is null or char_length(image_style) between 1 and 120);
  end if;
end;
$constraints$;

comment on column public.school_book_generations.content is
  'Escrita do livro em blocos (book-content-v1): páginas, exercícios estruturados, tentativas e feedback do validador. Contém o gabarito: nunca expor a aluno.';
