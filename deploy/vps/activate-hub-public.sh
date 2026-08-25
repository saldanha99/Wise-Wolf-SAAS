#!/usr/bin/env bash
# Creates the optional DNS record and activates the dedicated Hub router only
# after public DNS points exclusively to the production VPS.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
HUB_HOSTNAME="hub.wisewolflanguage.com.br"
HUB_ZONE_NAME="wisewolflanguage.com.br"
HUB_PUBLIC_URL="https://$HUB_HOSTNAME"
EXPECTED_VPS_IP="187.127.46.251"
HUB_CREATE_DNS="${HUB_CREATE_DNS:-no}"
HUB_DNS_WAIT_SECONDS="${HUB_DNS_WAIT_SECONDS:-300}"
CLOUDFLARE_API_TOKEN_FILE="${CLOUDFLARE_API_TOKEN_FILE:-}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
CF_SECRET_DIR=""
REMOTE_STAGE=""

SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
)

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  unset CF_API_TOKEN
  if [[ -n "$CF_SECRET_DIR" && -d "$CF_SECRET_DIR" ]]; then
    rm -rf -- "$CF_SECRET_DIR"
  fi
  if [[ -n "$REMOTE_STAGE" && -n "${DEPLOY_SSH_HOST:-}" ]]; then
    ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- "$REMOTE_STAGE" <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
set -Eeuo pipefail
stage_dir=$1
[[ "$stage_dir" =~ ^/opt/wisewolf/frontend/\.hub-activation-stage-[A-Za-z0-9._-]+$ ]]
rm -rf -- "$stage_dir"
REMOTE_CLEANUP
  fi
  exit "$exit_code"
}
trap cleanup EXIT

die() {
  echo "ERRO: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando obrigatório ausente: $1"
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

dns_resolver_ready() {
  local resolver=$1
  local cname addresses
  cname="$(dig +time=3 +tries=1 +short "@$resolver" CNAME "$HUB_HOSTNAME" | tr -d '[:space:]')"
  [[ -z "$cname" ]] || return 1
  addresses="$(dig +time=3 +tries=1 +short "@$resolver" A "$HUB_HOSTNAME" | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')"
  [[ "$addresses" = "$EXPECTED_VPS_IP" ]]
}

public_dns_ready() {
  dns_resolver_ready 1.1.1.1 && dns_resolver_ready 8.8.8.8
}

cloudflare_errors() {
  jq -r '.errors[]? | "Cloudflare \(.code // "sem código"): \(.message // "erro desconhecido")"' "$1" >&2
}

cloudflare_request_succeeded() {
  local response_file=$1
  if ! jq -e '.success == true' "$response_file" >/dev/null; then
    cloudflare_errors "$response_file"
    return 1
  fi
}

ensure_cloudflare_dns_record() {
  local token_mode token_mode_decimal zone_response zone_id account_id
  local records_response record_count record_type record_content record_proxied
  local payload_response payload_file token_verify_url

  [[ -n "$CLOUDFLARE_API_TOKEN_FILE" ]] ||
    die "CLOUDFLARE_API_TOKEN_FILE é obrigatório com HUB_CREATE_DNS=yes"
  [[ -f "$CLOUDFLARE_API_TOKEN_FILE" && ! -L "$CLOUDFLARE_API_TOKEN_FILE" ]] ||
    die "o token Cloudflare deve estar em um arquivo regular, não simbólico"
  token_mode="$(file_mode "$CLOUDFLARE_API_TOKEN_FILE")"
  [[ "$token_mode" =~ ^[0-7]{3,4}$ ]] || die "não foi possível validar as permissões do token"
  token_mode_decimal=$((8#$token_mode))
  (( (token_mode_decimal & 077) == 0 )) ||
    die "o arquivo do token deve ser privado (chmod 600 ou 400)"

  CF_API_TOKEN="$(tr -d '\r\n' < "$CLOUDFLARE_API_TOKEN_FILE")"
  [[ "$CF_API_TOKEN" =~ ^[A-Za-z0-9_-]{20,200}$ ]] ||
    die "o arquivo não contém um token Cloudflare válido"
  [[ -z "$CLOUDFLARE_ACCOUNT_ID" || "$CLOUDFLARE_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]] ||
    die "CLOUDFLARE_ACCOUNT_ID inválido"

  CF_SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wisewolf-hub-cloudflare.XXXXXX")"
  printf 'header = "Authorization: Bearer %s"\n' "$CF_API_TOKEN" > "$CF_SECRET_DIR/auth.conf"
  chmod 0600 "$CF_SECRET_DIR/auth.conf"

  token_verify_url='https://api.cloudflare.com/client/v4/user/tokens/verify'
  if [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]]; then
    token_verify_url="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"
  fi
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 --max-redirs 0 \
    --config "$CF_SECRET_DIR/auth.conf" \
    --output "$CF_SECRET_DIR/token.json" \
    "$token_verify_url"
  cloudflare_request_succeeded "$CF_SECRET_DIR/token.json" ||
    die "o novo token Cloudflare não pôde ser verificado"
  [[ "$(jq -r '.result.status // empty' "$CF_SECRET_DIR/token.json")" = "active" ]] ||
    die "o novo token Cloudflare não está ativo"

  zone_response="$CF_SECRET_DIR/zone.json"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 --max-redirs 0 \
    --config "$CF_SECRET_DIR/auth.conf" --get \
    --data-urlencode "name=$HUB_ZONE_NAME" \
    --data-urlencode 'status=active' \
    --output "$zone_response" \
    'https://api.cloudflare.com/client/v4/zones'
  cloudflare_request_succeeded "$zone_response" || die "falha ao consultar a zona Cloudflare"
  [[ "$(jq '.result | length' "$zone_response")" = "1" ]] ||
    die "o token deve enxergar exatamente uma zona ativa chamada $HUB_ZONE_NAME"
  zone_id="$(jq -r '.result[0].id' "$zone_response")"
  account_id="$(jq -r '.result[0].account.id // empty' "$zone_response")"
  [[ "$zone_id" =~ ^[a-f0-9]{32}$ ]] || die "a Cloudflare retornou um zone ID inválido"
  if [[ -n "$CLOUDFLARE_ACCOUNT_ID" && "$account_id" != "$CLOUDFLARE_ACCOUNT_ID" ]]; then
    die "a zona não pertence ao CLOUDFLARE_ACCOUNT_ID informado"
  fi

  records_response="$CF_SECRET_DIR/records.json"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 --max-redirs 0 \
    --config "$CF_SECRET_DIR/auth.conf" --get \
    --data-urlencode "name=$HUB_HOSTNAME" \
    --data-urlencode 'per_page=100' \
    --output "$records_response" \
    "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records"
  cloudflare_request_succeeded "$records_response" || die "falha ao consultar o DNS do Hub"
  record_count="$(jq '.result | length' "$records_response")"
  [[ "$record_count" =~ ^[0-9]+$ ]] || die "resposta DNS inesperada da Cloudflare"

  if [[ "$record_count" = "1" ]]; then
    record_type="$(jq -r '.result[0].type' "$records_response")"
    record_content="$(jq -r '.result[0].content' "$records_response")"
    record_proxied="$(jq -r '.result[0].proxied // false' "$records_response")"
    [[ "$record_type" = "A" && "$record_content" = "$EXPECTED_VPS_IP" && "$record_proxied" = "false" ]] ||
      die "já existe um registro conflitante para $HUB_HOSTNAME; nenhuma alteração foi feita"
    echo "DNS Cloudflare já está correto; nenhuma alteração necessária."
    return 0
  fi
  [[ "$record_count" = "0" ]] ||
    die "existem múltiplos registros para $HUB_HOSTNAME; corrija o conflito manualmente"

  payload_file="$CF_SECRET_DIR/create-record.json"
  payload_response="$CF_SECRET_DIR/create-response.json"
  jq -n \
    --arg name "$HUB_HOSTNAME" \
    --arg content "$EXPECTED_VPS_IP" \
    '{type:"A", name:$name, content:$content, ttl:300, proxied:false}' > "$payload_file"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 --max-redirs 0 \
    --config "$CF_SECRET_DIR/auth.conf" \
    --header 'Content-Type: application/json' \
    --request POST --data-binary "@$payload_file" \
    --output "$payload_response" \
    "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records"
  cloudflare_request_succeeded "$payload_response" || die "a Cloudflare recusou a criação do registro"
  [[ "$(jq -r '.result.type' "$payload_response")" = "A" &&
    "$(jq -r '.result.name' "$payload_response")" = "$HUB_HOSTNAME" &&
    "$(jq -r '.result.content' "$payload_response")" = "$EXPECTED_VPS_IP" &&
    "$(jq -r '.result.proxied' "$payload_response")" = "false" ]] ||
    die "a Cloudflare retornou um registro diferente do solicitado"
  echo "Registro A do Hub criado em modo DNS-only."
}

wait_for_public_dns() {
  local attempts attempt
  [[ "$HUB_DNS_WAIT_SECONDS" =~ ^[0-9]+$ ]] || die "HUB_DNS_WAIT_SECONDS deve ser numérico"
  (( HUB_DNS_WAIT_SECONDS >= 0 && HUB_DNS_WAIT_SECONDS <= 900 )) ||
    die "HUB_DNS_WAIT_SECONDS deve ficar entre 0 e 900"
  attempts=$((HUB_DNS_WAIT_SECONDS / 5 + 1))
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if public_dns_ready; then
      echo "DNS público confirmado por 1.1.1.1 e 8.8.8.8."
      return 0
    fi
    (( attempt < attempts )) && sleep 5
  done
  die "$HUB_HOSTNAME ainda não aponta exclusivamente para $EXPECTED_VPS_IP nos dois resolvedores"
}

for command_name in awk curl date dig jq mktemp rsync sed shasum ssh stat tr; do
  require_command "$command_name"
done
[[ "$HUB_CREATE_DNS" = "yes" || "$HUB_CREATE_DNS" = "no" ]] ||
  die "HUB_CREATE_DNS deve ser yes ou no"
[[ -s "$DEPLOY_ENV_FILE" ]] || die "arquivo de deploy ausente: $DEPLOY_ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
set +a
: "${DEPLOY_SSH_HOST:?DEPLOY_SSH_HOST ausente}"
: "${DEPLOY_HOST:?DEPLOY_HOST ausente}"
: "${DEPLOY_COMPOSE_DIR:?DEPLOY_COMPOSE_DIR ausente}"
: "${DEPLOY_BACKUPS_DIR:?DEPLOY_BACKUPS_DIR ausente}"
[[ "$DEPLOY_HOST" = "$EXPECTED_VPS_IP" ]] || die "VPS de destino inesperada"
[[ "$DEPLOY_COMPOSE_DIR" = "/opt/wisewolf/frontend" ]] || die "diretório frontend inesperado"
[[ "$DEPLOY_BACKUPS_DIR" = "/opt/wisewolf/backups" ]] || die "diretório de backup inesperado"
[[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "DEPLOY_SSH_HOST inválido"

if [[ "$HUB_CREATE_DNS" = "yes" ]]; then
  [[ "${RUN:-}" = "yes" ]] ||
    die "a criação DNS exige RUN=yes e um novo token DNS-only em arquivo privado"
  ensure_cloudflare_dns_record
fi

if ! public_dns_ready; then
  if [[ "${RUN:-}" = "yes" ]]; then
    wait_for_public_dns
  else
    echo "$HUB_HOSTNAME ainda não possui o registro A público esperado."
    echo "Nenhuma alteração foi feita."
    exit 0
  fi
fi

if [[ "${RUN:-}" != "yes" ]]; then
  echo "DNS pronto. Ensaio encerrado sem alterar o proxy. Use RUN=yes para ativar."
  exit 0
fi

NGINX_SOURCE="$SCRIPT_DIR/proxy/nginx-spa.conf"
COMPOSE_OVERRIDE_SOURCE="$SCRIPT_DIR/proxy/docker-compose.hub.override.yml"
[[ -s "$NGINX_SOURCE" && ! -L "$NGINX_SOURCE" ]] || die "template Nginx ausente"
[[ -s "$COMPOSE_OVERRIDE_SOURCE" && ! -L "$COMPOSE_OVERRIDE_SOURCE" ]] ||
  die "override Compose do Hub ausente"

activation_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
REMOTE_STAGE="$DEPLOY_COMPOSE_DIR/.hub-activation-stage-$activation_id"
nginx_sha="$(shasum -a 256 "$NGINX_SOURCE" | awk '{print $1}')"
override_sha="$(shasum -a 256 "$COMPOSE_OVERRIDE_SOURCE" | awk '{print $1}')"

ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- "$REMOTE_STAGE" <<'REMOTE_PREPARE'
set -Eeuo pipefail
umask 077
stage_dir=$1
[[ "$stage_dir" =~ ^/opt/wisewolf/frontend/\.hub-activation-stage-[A-Za-z0-9._-]+$ ]]
[[ ! -e "$stage_dir" && ! -L "$stage_dir" ]]
mkdir -- "$stage_dir"
REMOTE_PREPARE

rsync -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2" \
  -a -- "$NGINX_SOURCE" "$DEPLOY_SSH_HOST:$REMOTE_STAGE/nginx.conf"
rsync -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2" \
  -a -- "$COMPOSE_OVERRIDE_SOURCE" "$DEPLOY_SSH_HOST:$REMOTE_STAGE/docker-compose.override.yml"

ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_COMPOSE_DIR" "$DEPLOY_BACKUPS_DIR" "$REMOTE_STAGE" \
  "$activation_id" "$nginx_sha" "$override_sha" "$HUB_PUBLIC_URL" \
  "$EXPECTED_VPS_IP" <<'REMOTE_ACTIVATE'
set -Eeuo pipefail
umask 077
compose_dir=$1
backups_dir=$2
stage_dir=$3
activation_id=$4
expected_nginx_sha=$5
expected_override_sha=$6
public_url=$7
expected_vps_ip=$8
nginx_path="$compose_dir/nginx.conf"
base_compose="$compose_dir/docker-compose.yml"
override_path="$compose_dir/docker-compose.override.yml"
marker_path="$compose_dir/HUB_PUBLIC_ACTIVE"
backup_dir="$backups_dir/hub-proxy-$activation_id"
nginx_next="$compose_dir/nginx.conf.next.$activation_id"
override_next="$compose_dir/docker-compose.override.yml.next.$activation_id"
marker_next="$compose_dir/HUB_PUBLIC_ACTIVE.next.$activation_id"
expected_pre_hub="$stage_dir/nginx.pre-hub.conf"
override_existed=false
files_changed=false
checkpoint="remote-preflight"

for command_name in awk cmp curl docker flock grep install mktemp sed seq sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "comando obrigatório ausente na VPS: $command_name" >&2
    exit 1
  }
done

[[ "$compose_dir" = "/opt/wisewolf/frontend" ]]
[[ "$backups_dir" = "/opt/wisewolf/backups" ]]
[[ "$stage_dir" =~ ^/opt/wisewolf/frontend/\.hub-activation-stage-[A-Za-z0-9._-]+$ ]]
[[ "$activation_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]
[[ "$expected_nginx_sha" =~ ^[a-f0-9]{64}$ ]]
[[ "$expected_override_sha" =~ ^[a-f0-9]{64}$ ]]
[[ "$public_url" = "https://hub.wisewolflanguage.com.br" ]]
[[ "$expected_vps_ip" = "187.127.46.251" ]]
for required_file in "$base_compose" "$nginx_path" \
  "$stage_dir/nginx.conf" "$stage_dir/docker-compose.override.yml"; do
  [[ -f "$required_file" && ! -L "$required_file" ]]
done
[[ "$(sha256sum "$stage_dir/nginx.conf" | awk '{print $1}')" = "$expected_nginx_sha" ]]
[[ "$(sha256sum "$stage_dir/docker-compose.override.yml" | awk '{print $1}')" = "$expected_override_sha" ]]
[[ ! -e "$backup_dir" && ! -L "$backup_dir" ]]
for next_path in "$nginx_next" "$override_next" "$marker_next"; do
  [[ ! -e "$next_path" && ! -L "$next_path" ]]
done

exec 9>"$compose_dir/.hub-activation.lock"
flock -n 9 || { echo "outra ativação do Hub está em andamento" >&2; exit 1; }

sed 's/ hub\.wisewolflanguage\.com\.br//' "$stage_dir/nginx.conf" > "$expected_pre_hub"
if ! cmp -s "$nginx_path" "$stage_dir/nginx.conf" && ! cmp -s "$nginx_path" "$expected_pre_hub"; then
  echo "nginx.conf divergiu do estado auditado; ativação recusada" >&2
  exit 1
fi
if [[ -e "$override_path" || -L "$override_path" ]]; then
  [[ -f "$override_path" && ! -L "$override_path" ]] || {
    echo "override Compose existente não é um arquivo regular" >&2
    exit 1
  }
  cmp -s "$override_path" "$stage_dir/docker-compose.override.yml" || {
    echo "já existe um override Compose diferente; ativação recusada" >&2
    exit 1
  }
  override_existed=true
fi

base_render="$(mktemp /tmp/wisewolf-hub-base-compose.XXXXXX)"
trap 'rm -f -- "$base_render"' EXIT
docker compose -f "$base_compose" config > "$base_render"
grep -Fq 'traefik.http.services.wisewolf-app.loadbalancer.server.port: "80"' "$base_render"
grep -Fq 'traefik.http.routers.wisewolf-app.tls.certresolver: le' "$base_render"
docker inspect traefik --format '{{range .Config.Cmd}}{{println .}}{{end}}' | \
  grep -Fxq -- '--certificatesresolvers.le.acme.httpchallenge=true'
docker inspect traefik --format '{{range .Config.Cmd}}{{println .}}{{end}}' | \
  grep -Fxq -- '--certificatesresolvers.le.acme.httpchallenge.entrypoint=web'

docker compose -f "$base_compose" \
  -f "$stage_dir/docker-compose.override.yml" config --quiet
frontend_id="$(cd "$compose_dir" && docker compose ps -q frontend)"
[[ -n "$frontend_id" ]]
frontend_image="$(docker inspect "$frontend_id" --format '{{.Image}}')"
[[ "$frontend_image" =~ ^sha256:[a-f0-9]{64}$ ]]
docker run --rm --entrypoint nginx \
  -v "$stage_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  "$frontend_image" -t >/dev/null

mkdir -- "$backup_dir"
cp -a -- "$nginx_path" "$backup_dir/nginx.conf"
if [[ "$override_existed" = "true" ]]; then
  cp -a -- "$override_path" "$backup_dir/docker-compose.override.yml"
fi

rollback() {
  local exit_code=$?
  trap - ERR INT TERM EXIT
  set +e
  rm -f -- "$base_render"
  rm -f -- "$nginx_next" "$override_next" "$marker_next"
  if [[ "$files_changed" = "true" ]]; then
    cp -a -- "$backup_dir/nginx.conf" "$nginx_next" && mv -Tf -- "$nginx_next" "$nginx_path"
    if [[ "$override_existed" = "true" ]]; then
      cp -a -- "$backup_dir/docker-compose.override.yml" "$override_next" &&
        mv -Tf -- "$override_next" "$override_path"
    else
      rm -f -- "$override_path"
    fi
    rm -f -- "$marker_path"
    (cd "$compose_dir" && docker compose up -d --force-recreate frontend) >/dev/null 2>&1 || true
  fi
  echo "ativação do Hub falhou em $checkpoint; proxy anterior restaurado" >&2
  exit "$exit_code"
}
trap rollback ERR INT TERM

if ! cmp -s "$nginx_path" "$stage_dir/nginx.conf" || [[ "$override_existed" = "false" ]]; then
  install -m 0644 -- "$stage_dir/nginx.conf" "$nginx_next"
  install -m 0644 -- "$stage_dir/docker-compose.override.yml" "$override_next"
  mv -Tf -- "$nginx_next" "$nginx_path"
  mv -Tf -- "$override_next" "$override_path"
  files_changed=true
  cd "$compose_dir"
  docker compose config --quiet
  docker compose up -d --force-recreate frontend
else
  cd "$compose_dir"
  docker compose config --quiet
  docker compose up -d frontend
fi

for attempt in $(seq 1 30); do
  frontend_id="$(cd "$compose_dir" && docker compose ps -q frontend)"
  if [[ -n "$frontend_id" && "$(docker inspect "$frontend_id" --format '{{.State.Running}}')" = "true" ]]; then
    break
  fi
  sleep 1
done
[[ -n "$frontend_id" ]]
[[ "$(docker inspect "$frontend_id" --format '{{.State.Running}}')" = "true" ]]
docker exec "$frontend_id" nginx -t >/dev/null
docker inspect "$frontend_id" --format '{{range $key, $value := .Config.Labels}}{{printf "%s=%s\n" $key $value}}{{end}}' | \
  grep -Fqx 'traefik.http.routers.wisewolf-hub.rule=Host(`hub.wisewolflanguage.com.br`)'
checkpoint="hub-router-health"

hub_ready=false
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --resolve "hub.wisewolflanguage.com.br:443:$expected_vps_ip" \
    "$public_url/" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      --resolve "hub.wisewolflanguage.com.br:443:$expected_vps_ip" \
      "$public_url/biblioteca" >/dev/null 2>&1; then
    hub_ready=true
    break
  fi
  sleep 5
done
[[ "$hub_ready" = "true" ]] || {
  echo "o roteador dedicado não respondeu com sucesso após a ativação" >&2
  exit 1
}
checkpoint="system-host-health"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  'https://system.wisewolflanguage.com.br/' >/dev/null || {
  echo "o domínio principal system deixou de responder após a ativação" >&2
  exit 1
}
checkpoint="app-host-health"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  'https://app.wisewolflanguage.com.br/' >/dev/null || {
  echo "o domínio principal app deixou de responder após a ativação" >&2
  exit 1
}

checkpoint="activation-marker"
printf '%s\n' "$activation_id $expected_override_sha" > "$marker_next"
chmod 0644 "$marker_next"
mv -Tf -- "$marker_next" "$marker_path"
trap - ERR INT TERM
rm -f -- "$base_render"
trap - EXIT
echo "Hub ativado com TLS válido em $public_url"
REMOTE_ACTIVATE

echo "Hub público ativo em $HUB_PUBLIC_URL"
