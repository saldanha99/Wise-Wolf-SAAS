#!/usr/bin/env bash
# Publica a conciliação do caixa Asaas e CONFERE o resultado no banco.
#
# Por que este script existe: "Deploy concluído" não é prova. O release pode
# terminar com sucesso e o objetivo do deploy não estar no ar — já aconteceu
# neste projeto. Aqui o deploy e a verificação andam juntos, e o script só diz
# "no ar" depois de olhar o banco.
#
# Uso:  bash deploy/vps/publicar-conciliacao-caixa.sh
#
# Ele NÃO escreve nada em produção por conta própria: quem escreve é o
# release.sh (que aplica as migrations registradas). A última seção apenas
# CONTA o que o reconcile-ledger recuperaria — chamar a função é decisão sua,
# num passo separado.

set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

azul()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
falha() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; }

psql_vps() {
  ssh -o ConnectTimeout=30 wisewolf-vps \
    'docker exec -i supabase-db psql -U postgres -At -v ON_ERROR_STOP=1'
}

# ---------------------------------------------------------------------------
azul "1/4  Pré-condições do release"
# ---------------------------------------------------------------------------
sujos=$(git status --porcelain -uall | wc -l | tr -d ' ')
[[ "$sujos" == "0" ]] || { falha "árvore suja ($sujos arquivos) — commite ou descarte"; exit 1; }
ok "árvore limpa"

branch=$(git rev-parse --abbrev-ref HEAD)
esperada=$(grep -h '^DEPLOY_GIT_BRANCH=' .env.deploy.local | cut -d= -f2 | tr -d '"')
[[ "$branch" == "$esperada" ]] || { falha "branch '$branch' ≠ produção '$esperada'"; exit 1; }
ok "branch $branch"

git merge-base --is-ancestor origin/main HEAD \
  || { falha "HEAD não contém origin/main — o preflight recusaria"; exit 1; }
ok "origin/main contido"

# ---------------------------------------------------------------------------
azul "2/4  Estado ANTES (para comparar depois)"
# ---------------------------------------------------------------------------
antes=$(psql_vps <<'SQL'
select
  (select count(*) from student_payments
    where status in ('RECEIVED','RECEIVED_IN_CASH') and paid_at is null) || '|' ||
  (select count(*) from financial_transactions where amount_cents is null) || '|' ||
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
      and (p.proacl::text like '%anon=X%' or p.proacl is null)
      and pg_get_functiondef(p.oid) ~ 'NOT IN\s*\(\s*''(SCHOOL_ADMIN|SUPER_ADMIN)');
SQL
)
IFS='|' read -r a_sem_paid a_sem_cents a_anon <<<"$antes"
printf '  sem paid_at: %s | sem amount_cents: %s | funções abertas ao anon: %s\n' \
  "$a_sem_paid" "$a_sem_cents" "$a_anon"

# ---------------------------------------------------------------------------
azul "3/4  Publicando (release.sh — typecheck, testes, build, migrations, smoke)"
# ---------------------------------------------------------------------------
bash deploy/vps/release.sh

# ---------------------------------------------------------------------------
azul "4/4  Conferindo no banco o que era o objetivo do deploy"
# ---------------------------------------------------------------------------
depois=$(psql_vps <<'SQL'
select
  (select count(*) from pg_trigger where tgname='trg_student_payment_paid_at') || '|' ||
  (select count(*) from pg_trigger where tgname='trg_sync_financial_amounts') || '|' ||
  (select count(*) from student_payments
    where status in ('RECEIVED','RECEIVED_IN_CASH') and paid_at is null) || '|' ||
  (select count(*) from financial_transactions where amount_cents is null) || '|' ||
  (select count(*) from schema_one_shots where key='caixa_occurred_at_20260824') || '|' ||
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
      and (p.proacl::text like '%anon=X%' or p.proacl is null)
      and pg_get_functiondef(p.oid) ~ 'NOT IN\s*\(\s*''(SCHOOL_ADMIN|SUPER_ADMIN)') || '|' ||
  (select count(*) from pg_attribute
    where attrelid='public.financial_transactions'::regclass
      and attname='amount_cents' and attnotnull)::text;
SQL
)
IFS='|' read -r t_paid t_amt d_sem_paid d_sem_cents one_shot d_anon cents_nn <<<"$depois"

erros=0
[[ "$t_paid"     == "1" ]] && ok "trigger trg_student_payment_paid_at instalado"        || { falha "trigger paid_at AUSENTE"; erros=1; }
[[ "$t_amt"      == "1" ]] && ok "trigger trg_sync_financial_amounts instalado"         || { falha "trigger de amounts AUSENTE"; erros=1; }
[[ "$one_shot"   == "1" ]] && ok "reparo de datas do histórico aplicado (one-shot)"     || { falha "one-shot NÃO registrado"; erros=1; }
[[ "$d_sem_cents" == "0" ]] && ok "amount_cents preenchido em todos os lançamentos"     || { falha "$d_sem_cents lançamentos ainda sem amount_cents"; erros=1; }
[[ "$cents_nn"   == "1" ]] && ok "amount_cents agora é NOT NULL"                        || { falha "amount_cents ainda aceita nulo"; erros=1; }
[[ "$d_anon"     == "0" ]] && ok "nenhuma função com guarda frouxa aberta ao anon"      || { falha "$d_anon funções ainda abertas ao anon"; erros=1; }

printf '  paid_at pendente: %s → %s  (os que sobram não têm payment_date; caem no vencimento, por desenho)\n' \
  "$a_sem_paid" "$d_sem_paid"

# ---------------------------------------------------------------------------
azul "Pendente: o que o reconcile-ledger recuperaria (NADA foi escrito aqui)"
# ---------------------------------------------------------------------------
psql_vps <<'SQL'
select '  ' || count(*) || ' pagamentos sem lançamento, somando R$ ' ||
       to_char(coalesce(sum(value),0), 'FM999G999D00') ||
       '  (meses: ' || coalesce(string_agg(distinct to_char(coalesce(paid_at, payment_date, due_date),'MM/YYYY'), ', '), '—') || ')'
  from student_payments sp
 where sp.status in ('RECEIVED','RECEIVED_IN_CASH')
   and sp.tenant_id is not null
   and not exists (select 1 from financial_transactions ft where ft.student_payment_id = sp.id);
SQL

if [[ "$erros" == "0" ]]; then
  printf '\n\033[1;32m✓ Conciliação do caixa no ar e verificada no banco.\033[0m\n'
  printf '  Falta chamar o reconcile-ledger para recuperar os pagamentos acima — passo separado.\n\n'
else
  printf '\n\033[1;31m✗ O release terminou mas a verificação falhou. NÃO considere publicado.\033[0m\n\n'
  exit 1
fi
