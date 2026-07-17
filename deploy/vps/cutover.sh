#!/bin/bash
# CUTOVER Wise Wolf: hosted -> VPS. Rodar na madrugada com RUN=yes.
# Pre-requisitos: DNS api. e app. apontando para a VPS; TLS emitido; testes ok.
set -e
[ "$RUN" = "yes" ] || { echo "Ensaio. Para executar: RUN=yes $0"; }

cd /opt/wisewolf/migration
export PGPASSWORD=$(cat /opt/wisewolf/.pghosted)
HCONN="host=db.dvalxbtngopxopzcbfdm.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"

runtime_env() {
  docker inspect supabase-edge-functions --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n "s/^$1=//p"
}

ASAAS_API_KEY="$(runtime_env ASAAS_API_KEY)"
ASAAS_API_URL="$(runtime_env ASAAS_API_URL)"
ASAAS_WEBHOOK_TOKEN="$(runtime_env ASAAS_WEBHOOK_TOKEN)"
EVOLUTION_API_KEY="$(runtime_env EVOLUTION_API_KEY)"
EVOLUTION_API_URL="$(runtime_env EVOLUTION_API_URL)"
WHATSAPP_INBOUND_TOKEN="$(runtime_env WHATSAPP_INBOUND_TOKEN)"

for required in ASAAS_API_KEY ASAAS_API_URL ASAAS_WEBHOOK_TOKEN EVOLUTION_API_KEY EVOLUTION_API_URL WHATSAPP_INBOUND_TOKEN; do
  [ -n "${!required}" ] || { echo "ERRO: variavel $required ausente no runtime"; exit 1; }
done

echo "== PASSO 1: pausar crons no HOSTED (congela automacoes/fila la) =="
[ "$RUN" = "yes" ] && psql "$HCONN" -c "update cron.job set active=false;" || echo "  (dry) 21 crons hosted -> inactive"

echo "== PASSO 2: re-dump dados (delta desde o ensaio) =="
if [ "$RUN" = "yes" ]; then
  pg_dump "$HCONN" -t auth.users -t auth.identities --data-only --column-inserts -f auth-data-final.sql
  pg_dump "$HCONN" --schema=public --no-owner -f public-final.sql
  sed -e "s|https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1|http://kong:8000/functions/v1|g" \
      -e "s|https://dvalxbtngopxopzcbfdm.supabase.co|https://api.wisewolflanguage.com.br|g" \
      public-final.sql > public-final-vps.sql
  echo "  -- limpando public local e restaurando final --"
  docker exec supabase-db psql -U supabase_admin -d postgres -c "drop schema public cascade; create schema public; grant usage on schema public to postgres, anon, authenticated, service_role; grant all on schema public to postgres, service_role;"
  docker exec supabase-db psql -U supabase_admin -d postgres -c "truncate auth.identities, auth.users cascade;"
  docker exec -i supabase-db psql -U supabase_admin -d postgres -q < auth-data-final.sql
  docker exec -i supabase-db psql -U supabase_admin -d postgres -q < public-final-vps.sql 2>final-restore.err || true
  bash /opt/wisewolf/migration/post-restore.sh
  /opt/wisewolf/migration/sync-storage2.sh
  echo "  -- recriando crons (desativados) --"
  while IFS=$'\t' read -r job sched cmd; do
    docker exec supabase-db psql -U supabase_admin -d postgres -q -c "select cron.schedule(\$q\$$job\$q\$, \$q\$$sched\$q\$, \$q\$$cmd\$q\$);" < /dev/null
  done < cron-jobs.tsv
fi

echo "== PASSO 3: DNS system.wisewolflanguage.com.br -> 187.127.46.251 (Cloudflare, nuvem cinza) =="
echo "   + adicionar Host(system...) no router traefik do frontend e reiniciar frontend"

echo "== PASSO 4: webhook ASAAS -> https://api.wisewolflanguage.com.br/functions/v1/asaas-webhook =="
if [ "$RUN" = "yes" ]; then
  WEBHOOKS="$(curl -fsS "$ASAAS_API_URL/v3/webhooks" -H "access_token: $ASAAS_API_KEY")"
  WEBHOOK_ID="$(printf '%s' "$WEBHOOKS" | jq -r '.data[] | select(.name == "SaasWise" or (.url | contains("/asaas-webhook"))) | .id' | head -n 1)"
  [ -n "$WEBHOOK_ID" ] && [ "$WEBHOOK_ID" != "null" ] || { echo "ERRO: webhook SaasWise nao encontrado"; exit 1; }

  CURRENT_WEBHOOK="$(curl -fsS "$ASAAS_API_URL/v3/webhooks/$WEBHOOK_ID" -H "access_token: $ASAAS_API_KEY")"
  ASAAS_PAYLOAD="$(printf '%s' "$CURRENT_WEBHOOK" | jq \
    --arg url "https://api.wisewolflanguage.com.br/functions/v1/asaas-webhook" \
    --arg auth "$ASAAS_WEBHOOK_TOKEN" \
    '{name:(.name // "SaasWise"),url:$url,sendType:(.sendType // "SEQUENTIALLY"),enabled:true,interrupted:false,authToken:$auth,events:.events}')"
  curl -fsS -X PUT "$ASAAS_API_URL/v3/webhooks/$WEBHOOK_ID" \
    -H "access_token: $ASAAS_API_KEY" -H "Content-Type: application/json" \
    -d "$ASAAS_PAYLOAD" | jq '{id,name,url,enabled,interrupted,event_count:(.events|length)}'
fi

echo "== PASSO 5: webhook Evolution (whatsapp-inbound) para instancia central =="
if [ "$RUN" = "yes" ]; then
  INBOUND_URL="https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound?token=$WHATSAPP_INBOUND_TOKEN"
  PAYLOAD="$(jq -nc --arg url "$INBOUND_URL" '{webhook:{enabled:true,url:$url,events:["MESSAGES_UPSERT"]}}')"
  curl -fsS -X POST "$EVOLUTION_API_URL/webhook/set/prof-diretorww-d6bg" \
    -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
    -d "$PAYLOAD"
fi

echo "== PASSO 6: ativar crons no VPS =="
[ "$RUN" = "yes" ] && docker exec supabase-db psql -U supabase_admin -d postgres -c "update cron.job set active=true; select count(*) filter (where active) from cron.job;" < /dev/null

echo "== PASSO 7: smoke tests =="
echo "   login em system.wisewolflanguage.com.br / lancar aula teste / conferir asaas-webhook logs"
