#!/usr/bin/env bash
# Guarda o cliente OAuth do Google (integração do Meet) na VPS.
#
# Quem roda é a pessoa da direção, no próprio computador: o segredo sai do
# arquivo baixado do Google Cloud direto para /opt/wisewolf/supabase-docker/
# .env.functions (600, root) pela entrada padrão do ssh — não aparece na tela,
# em log, na lista de processos nem no chat.
#
# Uso:
#   bash deploy/vps/configurar-google-meet.sh [caminho/do/client_secret.json]
# Sem argumento, usa o client_secret_*.json mais novo da pasta Downloads.
#
# O que grava (só o que faltar ou mudar):
#   GOOGLE_MEET_OAUTH_CLIENT_ID / _CLIENT_SECRET  ← do arquivo
#   GOOGLE_MEET_OAUTH_REDIRECT_URI                ← endereço de retorno fixo
#   GOOGLE_MEET_TOKEN_ENCRYPTION_KEY              ← gerada NA VPS se não existir
#                                                   (nunca troque: invalida a conexão)
#   GOOGLE_MEET_PEDAGOGY_ENABLED=true             ← liga salas e importação
#   GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED=true    ← relatório de presença (Business Plus)
# Depois recria o container das functions e apaga o arquivo baixado.
set -Eeuo pipefail

HOST="${DEPLOY_SSH_HOST:-wisewolf-vps}"
REDIRECT_URI="https://api.wisewolflanguage.com.br/functions/v1/google-meet"

json="${1:-}"
if [[ -z "$json" ]]; then
  json="$(ls -t "$HOME"/Downloads/client_secret_*.apps.googleusercontent.com.json 2>/dev/null | head -1 || true)"
fi
if [[ -z "$json" || ! -f "$json" ]]; then
  echo "Não achei o client_secret_*.json na pasta Downloads." >&2
  echo "Baixe de novo em console.cloud.google.com → Google Auth Platform → Clientes." >&2
  exit 1
fi

# Confere o arquivo sem mostrar o segredo.
python3 - "$json" "$REDIRECT_URI" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
web = data.get("web") or {}
if not web.get("client_id") or not web.get("client_secret"):
    sys.exit("O arquivo não é de um cliente do tipo 'Aplicativo da Web'.")
if sys.argv[2] not in (web.get("redirect_uris") or []):
    sys.exit("O cliente não tem o endereço de retorno " + sys.argv[2])
PY

# O programa remoto vai no argumento do ssh (não tem segredo); o segredo vai
# pela entrada padrão.
remote_program=$(cat <<'PY'
import base64, json, os, stat, subprocess, sys, tempfile
path = "/opt/wisewolf/supabase-docker/.env.functions"
data = json.load(sys.stdin)
web = data["web"]
wanted = {
    "GOOGLE_MEET_OAUTH_CLIENT_ID": web["client_id"],
    "GOOGLE_MEET_OAUTH_CLIENT_SECRET": web["client_secret"],
    "GOOGLE_MEET_OAUTH_REDIRECT_URI": sys.argv[1],
    "GOOGLE_MEET_PEDAGOGY_ENABLED": "true",
    "GOOGLE_MEET_ATTENDANCE_REPORT_ENABLED": "true",
}
lines = open(path).read().splitlines() if os.path.exists(path) else []
current = {}
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        current[key.strip()] = value
if not current.get("GOOGLE_MEET_TOKEN_ENCRYPTION_KEY"):
    wanted["GOOGLE_MEET_TOKEN_ENCRYPTION_KEY"] = base64.b64encode(os.urandom(32)).decode()
changed = [k for k, v in wanted.items() if current.get(k) != v]
kept = [l for l in lines if l.split("=", 1)[0].strip() not in wanted]
for key in wanted:
    kept.append(f"{key}={wanted[key]}")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as out:
    out.write("\n".join(kept) + "\n")
os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
os.replace(tmp, path)
print("variáveis gravadas/atualizadas:", ", ".join(changed) or "nenhuma (já estavam iguais)")
subprocess.run(["docker", "compose", "up", "-d", "functions"], cwd="/opt/wisewolf/supabase-docker",
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print("container das functions recriado")
PY
)

ssh -o BatchMode=yes "$HOST" "python3 -c $(printf %q "$remote_program") $(printf %q "$REDIRECT_URI")" < "$json"

rm -f -- "$json"
echo "Pronto. O arquivo baixado foi apagado deste computador."
echo "Próximo passo: no sistema, Qualidade das aulas → Conta central Google → Conectar conta central."
