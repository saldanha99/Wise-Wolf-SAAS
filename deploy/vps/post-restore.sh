#!/bin/bash
# Reaplica ownership, extensoes e recursos que nao entram no dump do schema public.
set -euo pipefail

cd /opt/wisewolf/migration
export PGPASSWORD
PGPASSWORD=$(cat /opt/wisewolf/.pghosted)
HCONN="host=db.dvalxbtngopxopzcbfdm.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"
L() { docker exec -i supabase-db psql -U supabase_admin -d postgres "$@"; }

echo "=== 1. ownership public -> postgres ==="
L -tAq <<'SQL' > /tmp/chown.sql
select format('ALTER TABLE public.%I OWNER TO postgres;', tablename) from pg_tables where schemaname='public'
union all
select format('ALTER SEQUENCE public.%I OWNER TO postgres;', sequencename) from pg_sequences where schemaname='public'
union all
select format('ALTER VIEW public.%I OWNER TO postgres;', viewname) from pg_views where schemaname='public'
union all
select format('ALTER FUNCTION public.%I(%s) OWNER TO postgres;', p.proname, pg_get_function_identity_arguments(p.oid))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
SQL
wc -l /tmp/chown.sql
L -v ON_ERROR_STOP=1 -q < /tmp/chown.sql

echo "=== 2. extensoes ==="
L -v ON_ERROR_STOP=1 -q -c 'create extension if not exists pg_cron; create extension if not exists pg_net; create extension if not exists pgcrypto; create extension if not exists "uuid-ossp"; create extension if not exists pg_stat_statements;'
L -tAc "select extname from pg_extension order by 1" | tr '\n' ' '
echo

echo "=== 3. buckets ==="
while IFS=$'\t' read -r id name pub limit mimes; do
  [ "$limit" = "-" ] && limit=NULL
  if [ "$mimes" = "-" ]; then
    mimes=NULL
  else
    mimes="ARRAY['${mimes//,/\',\'}']"
  fi
  L -v ON_ERROR_STOP=1 -q -c "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('$id','$name',$pub,$limit,$mimes) on conflict (id) do update set public=excluded.public, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;"
done < buckets.tsv
L -tAc "select id, public from storage.buckets order by 1"

echo "=== 4. politicas RLS do storage ==="
psql "$HCONN" -v ON_ERROR_STOP=1 -tAq <<'SQL' > storage-policies.sql
select format('drop policy if exists %I on storage.objects; create policy %I on storage.objects as %s for %s to %s %s %s;',
  policyname, policyname, lower(permissive), lower(cmd), array_to_string(roles, ', '),
  coalesce('using ('||qual||')', ''), coalesce('with check ('||with_check||')', ''))
from pg_policies where schemaname='storage' and tablename='objects';
SQL
wc -l storage-policies.sql
L -v ON_ERROR_STOP=1 -q < storage-policies.sql

echo "=== 5. vault: atualiza service role key ==="
NEWKEY=$(sed -n 's/^SERVICE_ROLE_KEY=//p' /opt/wisewolf/supabase-docker/.env)
SECRET_ID=$(L -tAc "select id from vault.secrets where name='wisewolf_service_role_key' limit 1")
if [ -n "$SECRET_ID" ]; then
  L -v ON_ERROR_STOP=1 -q -c "select vault.update_secret('$SECRET_ID'::uuid, '$NEWKEY', 'wisewolf_service_role_key', 'Chave interna das automacoes Wise Wolf');"
else
  L -v ON_ERROR_STOP=1 -q -c "select vault.create_secret('$NEWKEY', 'wisewolf_service_role_key', 'Chave interna das automacoes Wise Wolf');"
fi
L -tAc "select name from vault.decrypted_secrets where name='wisewolf_service_role_key'"

echo "=== POS-RESTORE OK ==="
