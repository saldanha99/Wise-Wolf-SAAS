-- Mensalidade do aluno passa a ter UMA fonte: `profiles.monthly_fee`.
--
-- Conviviam duas colunas para o mesmo número. `monthly_fee` é lida por 21
-- funções do banco e por 23 arquivos do frontend; `monthly_tuition`, por 2
-- funções e três telas. Telas diferentes gravavam colunas diferentes.
--
-- Medido em produção (09/08/2026) — três alunos divergentes, e o padrão mostra
-- qual das duas é a verdade:
--
--   Yasmin   monthly_fee 188,00 | monthly_tuition 189,00 | COBRADA: 188,00
--   Beatriz  monthly_fee   0,00 | monthly_tuition 169,00 | sem cobrança
--   EVI      monthly_fee   0,00 | monthly_tuition 187,00 | sem cobrança
--
-- A cobrança real seguiu `monthly_fee`. O perigo estava do outro lado: a edge
-- `sync-payments` PREFERIA `monthly_tuition` quando > 0 — ou seja, estava a um
-- sync de gerar mensalidade de R$ 169 e R$ 187 para dois alunos cuja mensalidade
-- é zero. Nunca disparou por sorte, não por desenho.
--
-- O que esta migration faz:
--   1. reconcilia — `monthly_tuition` passa a espelhar `monthly_fee`;
--   2. instala um gatilho que mantém o espelho, para não divergir de novo.
--
-- Por que espelhar em vez de largar a coluna: `register_advance_payment` já
-- gravava as duas iguais, e leitores legados (inclusive fora deste repositório)
-- continuam corretos. Derrubar a coluna é um passo separado, depois que ninguém
-- mais a ler.
--
-- ⚠️ O gatilho só age quando `monthly_fee` MUDA. Se espelhasse em todo UPDATE,
-- um professor editando o telefone de um aluno divergente faria `monthly_tuition`
-- mudar junto — e `enforce_profile_authorization_fields` barraria a edição com
-- «financial profile fields cannot be changed by this role», criando um bug novo
-- exatamente igual ao que acabamos de consertar.
--
-- Re-executável: update idempotente, `drop trigger if exists`, `create or replace`.

-- 1. Reconciliação. `is distinct from` cobre NULL dos dois lados.
update public.profiles
   set monthly_tuition = monthly_fee
 where monthly_fee is not null
   and monthly_tuition is distinct from monthly_fee;

-- 2. Espelho.
create or replace function public.mirror_monthly_tuition()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- INSERT precisa entrar: matrícula nova grava `monthly_fee` e, sem espelho,
  -- `monthly_tuition` nasceria NULL — quem ainda lê a coluna antiga veria aluno
  -- sem mensalidade. Em BEFORE INSERT o registro OLD não existe, daí o TG_OP.
  if tg_op = 'INSERT' then
    if new.monthly_fee is not null then
      new.monthly_tuition := new.monthly_fee;
    end if;
    return new;
  end if;

  -- No UPDATE, só quando a mensalidade de verdade muda. Ver o aviso no topo.
  if new.monthly_fee is distinct from old.monthly_fee then
    new.monthly_tuition := new.monthly_fee;
  end if;
  return new;
end;
$function$;

alter function public.mirror_monthly_tuition() owner to postgres;

drop trigger if exists trg_mirror_monthly_tuition on public.profiles;
create trigger trg_mirror_monthly_tuition
  before insert or update on public.profiles
  for each row
  execute function public.mirror_monthly_tuition();

comment on column public.profiles.monthly_tuition is
  'DEPRECADA — espelho de monthly_fee, mantido por trg_mirror_monthly_tuition '
  'para leitores legados. Não escreva aqui: a mensalidade é monthly_fee.';
