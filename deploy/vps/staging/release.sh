#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

release_id="${1:-}"
base_dir=/opt/wisewolf/staging
archive="/tmp/wisewolf-staging-${release_id}.tar.gz"
incoming="${base_dir}/.incoming-${release_id}"
release_dir="${base_dir}/releases/${release_id}"

[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
[[ -f "$archive" && ! -L "$archive" ]]
mkdir -p -- "$base_dir/releases"
[[ "$(readlink -f "$base_dir")" = "$base_dir" ]]
[[ ! -e "$incoming" && ! -L "$incoming" ]]
[[ ! -e "$release_dir" && ! -L "$release_dir" ]]

exec 9>"$base_dir/.deploy.lock"
flock -n 9 || { echo "outro deploy de staging está em andamento" >&2; exit 1; }

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "arquivo de release contém caminho inseguro" >&2
  exit 1
fi

mkdir -- "$incoming"
cleanup() {
  local code=$?
  trap - EXIT
  rm -f -- "$archive"
  if [[ -d "$incoming" && ! -L "$incoming" ]]; then
    rm -rf -- "$incoming"
  fi
  exit "$code"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$incoming"
if find "$incoming" -type l -print -quit | grep -q .; then
  echo "release contém link simbólico" >&2
  exit 1
fi
[[ -s "$incoming/dist/index.html" ]]
[[ -s "$incoming/docker-compose.yml" ]]
[[ -s "$incoming/nginx.conf" ]]

mv -- "$incoming" "$release_dir"
mkdir -p -- "$base_dir"
old_target=""
if [[ -L "$base_dir/current" ]]; then
  old_target="$(readlink -f "$base_dir/current")"
  [[ "$old_target" == "$base_dir"/releases/*/dist ]]
fi

cp -- "$release_dir/docker-compose.yml" "$base_dir/docker-compose.yml.next"
cp -- "$release_dir/nginx.conf" "$base_dir/nginx.conf.next"
ln -s -- "releases/$release_id/dist" "$base_dir/current.next"
mv -Tf -- "$base_dir/docker-compose.yml.next" "$base_dir/docker-compose.yml"
mv -Tf -- "$base_dir/nginx.conf.next" "$base_dir/nginx.conf"
mv -Tf -- "$base_dir/current.next" "$base_dir/current"

rollback() {
  local code=$?
  trap - ERR
  if [[ -n "$old_target" ]]; then
    ln -s -- "$old_target" "$base_dir/current.rollback"
    mv -Tf -- "$base_dir/current.rollback" "$base_dir/current"
    (cd "$base_dir" && docker compose up -d --force-recreate wisewolf-staging) || true
  fi
  exit "$code"
}
trap rollback ERR

cd "$base_dir"
docker compose config --quiet
docker compose up -d --force-recreate wisewolf-staging
for _ in $(seq 1 30); do
  health="$(docker inspect wisewolf-staging --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = healthy ]] && break
  [[ "$health" = unhealthy ]] && { docker logs --tail 80 wisewolf-staging >&2; exit 1; }
  sleep 1
done
[[ "$(docker inspect wisewolf-staging --format '{{.State.Health.Status}}')" = healthy ]]
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
  https://wisewolf-staging.2timeweb.com.br/ >/dev/null
printf '%s\n' "$release_id" > "$base_dir/ACTIVE_RELEASE"
trap - ERR
echo "Staging ativo: $release_id"
