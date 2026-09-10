#!/bin/bash
set -e
cd /opt/wisewolf/supabase-docker
cp .env.example .env

# --- segredos aleatórios ---
PG_PASS=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
DASH_PASS=$(openssl rand -base64 18 | tr -d "/+=")
SKB=$(openssl rand -hex 32)
RT_ENC=$(openssl rand -hex 16)
VAULT_KEY=$(openssl rand -hex 16)
PGMETA_KEY=$(openssl rand -hex 16)
LF_PUB=$(openssl rand -hex 16)
LF_PRIV=$(openssl rand -hex 16)
MINIO_USER=wisewolf-storage
MINIO_PASS=$(openssl rand -hex 20)

# --- JWTs anon/service assinados com o novo JWT_SECRET (validade 10 anos) ---
gen_jwt() {
python3 - "$1" "$JWT_SECRET" <<'PY'
import sys, json, hmac, hashlib, base64, time
role, secret = sys.argv[1], sys.argv[2]
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
h = b64(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
p = b64(json.dumps({"role":role,"iss":"supabase","iat":now,"exp":now+315360000},separators=(",",":")).encode())
sig = b64(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{sig}")
PY
}
ANON=$(gen_jwt anon)
SERVICE=$(gen_jwt service_role)

set_var() { sed -i "s|^$1=.*|$1=$2|" .env; }
set_var POSTGRES_PASSWORD "$PG_PASS"
set_var JWT_SECRET "$JWT_SECRET"
set_var ANON_KEY "$ANON"
set_var SERVICE_ROLE_KEY "$SERVICE"
set_var DASHBOARD_USERNAME "wisewolf"
set_var DASHBOARD_PASSWORD "$DASH_PASS"
set_var SECRET_KEY_BASE "$SKB"
set_var REALTIME_DB_ENC_KEY "$RT_ENC"
set_var VAULT_ENC_KEY "$VAULT_KEY"
set_var PG_META_CRYPTO_KEY "$PGMETA_KEY"
set_var LOGFLARE_PUBLIC_ACCESS_TOKEN "$LF_PUB"
set_var LOGFLARE_PRIVATE_ACCESS_TOKEN "$LF_PRIV"
set_var MINIO_ROOT_USER "$MINIO_USER"
set_var MINIO_ROOT_PASSWORD "$MINIO_PASS"

# --- URLs e comportamento ---
set_var SITE_URL "https://system.wisewolflanguage.com.br"
set_var API_EXTERNAL_URL "https://api.wisewolflanguage.com.br"
set_var SUPABASE_PUBLIC_URL "https://api.wisewolflanguage.com.br"
set_var ADDITIONAL_REDIRECT_URLS "https://system.wisewolflanguage.com.br/*"
set_var ENABLE_EMAIL_SIGNUP "true"
set_var ENABLE_EMAIL_AUTOCONFIRM "true"
set_var DISABLE_SIGNUP "false"
set_var STUDIO_DEFAULT_ORGANIZATION "Wise Wolf"
set_var STUDIO_DEFAULT_PROJECT "Wise Wolf School"
set_var SMTP_ADMIN_EMAIL "wisewolflanguague@gmail.com"
set_var SMTP_SENDER_NAME "Wise Wolf School"

chmod 600 .env

# --- cofre local com credenciais de administração ---
cat > /opt/wisewolf/SECRETS.md <<EOF
# Wise Wolf VPS — credenciais geradas $(date -u +%F)
Studio (api.wisewolflanguage.com.br): usuario=wisewolf senha=$DASH_PASS
Postgres (interno): postgres / $PG_PASS
ANON_KEY=$ANON
SERVICE_ROLE_KEY=$SERVICE
EOF
chmod 600 /opt/wisewolf/SECRETS.md
echo "ENV OK — anon key: ${ANON:0:40}..."
