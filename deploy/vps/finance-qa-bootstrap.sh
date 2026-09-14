#!/usr/bin/env bash
# Executar na VPS: espelha SOMENTE estrutura em container efêmero sem rede.
# Não copia dados, credenciais ou jobs de cron. Não altera o banco de produção.
set -euo pipefail

qa_container=wisewolf-finance-qa-20260914
source_container=supabase-db

if docker container inspect "$qa_container" >/dev/null 2>&1; then
  printf 'Container de QA já existe: %s. Inspecione antes de reutilizar.\n' "$qa_container" >&2
  exit 1
fi

qa_image=$(docker inspect --format '{{.Config.Image}}' "$source_container")
case "$qa_image" in supabase/postgres:17.*) ;; *) exit 1 ;; esac

docker run --detach --name "$qa_container" \
  --label wisewolf.test_fixture=finance-20260914 \
  --network none --memory 1g --cpus 1 --pids-limit 256 \
  --tmpfs /var/lib/postgresql/finance-qa:rw,size=768m,uid=100,gid=101,mode=0700 \
  --user postgres --entrypoint /bin/sh "$qa_image" -c '
    initdb -D /var/lib/postgresql/finance-qa -U postgres --auth=trust >/dev/null
    exec postgres -D /var/lib/postgresql/finance-qa \
      -c shared_preload_libraries=pg_cron,pg_net \
      -c cron.database_name=postgres -c cron.launch_active_jobs=off \
      -c listen_addresses= -c unix_socket_directories=/tmp \
      -c max_connections=25 -c shared_buffers=128MB \
      -c log_min_messages=warning -c log_statement=none
  '

for attempt in $(seq 1 30); do
  if docker exec "$qa_container" pg_isready -h /tmp -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$qa_container" pg_isready -h /tmp -U postgres -d postgres

# Metadados de papel sem LOGIN nem hashes de senha. BYPASSRLS é necessário
# para simular o service_role dentro deste ambiente inacessível pela rede.
docker exec "$source_container" psql -X -U postgres -d postgres -At -c \
  "select format('create role %I nologin %s %s %s;', rolname,
    case when rolbypassrls then 'bypassrls' else 'nobypassrls' end,
    case when rolsuper then 'superuser' else 'nosuperuser' end,
    case when rolinherit then 'inherit' else 'noinherit' end)
   from pg_roles where rolname <> 'postgres' and left(rolname, 3) <> 'pg_' order by rolname" \
  | docker exec -i "$qa_container" psql -X -h /tmp -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null

docker exec "$source_container" pg_dump -U postgres -d postgres \
  --schema-only --no-owner --no-publications --no-subscriptions \
  | docker exec -i "$qa_container" psql -X -h /tmp -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null

docker exec "$qa_container" psql -X -h /tmp -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c \
  "select 'profiles=' || count(*) from public.profiles;
   select 'auth_users=' || count(*) from auth.users;
   select 'cron_jobs=' || count(*) from cron.job;
   select 'vault_secrets=' || count(*) from vault.secrets;
   select 'cron_enabled=' || current_setting('cron.launch_active_jobs');"

printf 'QA pronto: %s; network=none, schema-only, cron desabilitado.\n' "$qa_container"
