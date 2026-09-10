#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "Uso: $0 AAAAMMDDTHHMMSSZ" >&2
  exit 64
fi

release_id="$1"
case "$release_id" in
  *[!0-9TZ]*)
    echo "Identificador de release inválido: $release_id" >&2
    exit 64
    ;;
esac

base_dir="/opt/wisewolf/institucional"
release_dir="$base_dir/releases/$release_id"
release_site="$release_dir/site"
release_nginx="$release_dir/nginx.conf"
release_compose="$release_dir/docker-compose.yml"
live_site="$base_dir/src/dist"
live_nginx="$base_dir/nginx.conf"
live_compose="$base_dir/docker-compose.yml"
backup_site="$base_dir/backups/dist-before-$release_id"
backup_nginx="$base_dir/backups/nginx-before-$release_id.conf"
backup_compose="$base_dir/backups/docker-compose-before-$release_id.yml"
failed_site="$release_dir/failed-site"

if [ ! -d "$release_site" ] || [ ! -f "$release_nginx" ] || [ ! -f "$release_compose" ]; then
  echo "Release incompleta em $release_dir" >&2
  exit 66
fi

html_count="$(find "$release_site" -name index.html -type f | wc -l | tr -d ' ')"
if [ "$html_count" -lt 3000 ]; then
  echo "Release rejeitada: somente $html_count páginas HTML" >&2
  exit 65
fi

mkdir -p "$base_dir/backups"

docker run --rm \
  -v "$release_nginx:/etc/nginx/conf.d/default.conf:ro" \
  -v "$release_site:/usr/share/nginx/html:ro" \
  nginx:1.27-alpine nginx -t
docker compose -f "$release_compose" config >/dev/null

if [ -e "$backup_site" ] || [ -e "$backup_nginx" ] || [ -e "$backup_compose" ] || [ -e "$failed_site" ]; then
  echo "Já existe artefato com o identificador $release_id" >&2
  exit 73
fi

cp "$live_nginx" "$backup_nginx"
cp "$live_compose" "$backup_compose"
mv "$live_site" "$backup_site"
mv "$release_site" "$live_site"
cp "$release_nginx" "$live_nginx"
cp "$release_compose" "$live_compose"

activated=1
rollback() {
  exit_code="$?"
  if [ "${activated:-0}" -eq 1 ]; then
    echo "Falha na validação; restaurando a versão anterior." >&2
    mv "$live_site" "$failed_site"
    mv "$backup_site" "$live_site"
    cp "$backup_nginx" "$live_nginx"
    cp "$backup_compose" "$live_compose"
    cd "$base_dir"
    docker compose up -d --force-recreate institucional || true
  fi
  exit "$exit_code"
}
trap rollback HUP INT TERM EXIT

cd "$base_dir"
docker compose up -d --force-recreate institucional

echo "Validando página inicial..."
curl -fsS https://wisewolflanguage.com.br/ \
  | grep -F "Escola de inglês online com aulas particulares 1:1" >/dev/null
echo "Validando acesso do buscador da OpenAI..."
curl -fsS -A "OAI-SearchBot/1.0" https://wisewolflanguage.com.br/escola-de-ingles-online \
  | grep -F "Como escolher uma escola de inglês online" >/dev/null
echo "Validando glossário e arquivos de descoberta..."
curl -fsS https://wisewolflanguage.com.br/glossario/aplicativo-de-ingles-online \
  | grep -F "Aplicativo de Inglês Online" >/dev/null
curl -fsS https://wisewolflanguage.com.br/blog/como-negociar-salario-e-aumento-em-ingles-dicas-praticas-para-profissionais \
  | grep -F "Como Negociar Salário e Aumento em Inglês" >/dev/null
curl -fsS https://wisewolflanguage.com.br/robots.txt \
  | grep -F "User-agent: OAI-SearchBot" >/dev/null
curl -fsS https://wisewolflanguage.com.br/sitemap.xml \
  | grep -F "escola-de-ingles-online" >/dev/null
curl -fsS https://wisewolflanguage.com.br/llms.txt \
  | grep -F "Wise Wolf Language" >/dev/null
curl -fsS "https://wisewolflanguage.com.br/3366fca1b8ecdf3f4e49351604f5f72e.txt" \
  | grep -F "3366fca1b8ecdf3f4e49351604f5f72e" >/dev/null

not_found_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  https://wisewolflanguage.com.br/rota-inexistente-geo-check)"
if [ "$not_found_status" != "404" ]; then
  echo "A rota inexistente respondeu $not_found_status, não 404." >&2
  false
fi

www_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  https://www.wisewolflanguage.com.br/)"
if [ "$www_status" != "301" ]; then
  echo "O domínio www respondeu $www_status, não 301." >&2
  false
fi

blog_location=""
blog_attempt=0
while [ "$blog_attempt" -lt 20 ]; do
  blog_location="$(curl -ksS -o /dev/null -w '%{redirect_url}' \
    --resolve blog.wisewolflanguage.com.br:443:127.0.0.1 \
    https://blog.wisewolflanguage.com.br/hello-world/ || true)"
  [ "$blog_location" = "https://wisewolflanguage.com.br/blog/hello-world" ] && break
  blog_attempt=$((blog_attempt + 1))
  sleep 1
done
if [ "$blog_location" != "https://wisewolflanguage.com.br/blog/hello-world" ]; then
  echo "O redirecionamento interno do blog respondeu $blog_location." >&2
  false
fi

activated=0
trap - HUP INT TERM EXIT

echo "Release $release_id ativada: $html_count páginas HTML."
