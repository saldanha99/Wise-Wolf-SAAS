#!/usr/bin/env bash
# Grava um segredo das edge functions na VPS sem ele aparecer em lugar nenhum.
#
# Quem roda é a pessoa da direção, no próprio computador. O valor é digitado
# (ou colado) sem eco, vai pela entrada padrão do ssh direto para
# /opt/wisewolf/supabase-docker/.env.functions (600, root) e o container das
# functions é recriado para ler o arquivo de novo.
#
# Uso:
#   bash deploy/vps/configurar-segredo.sh GAMMA_API_KEY
set -Eeuo pipefail

HOST="${DEPLOY_SSH_HOST:-wisewolf-vps}"
name="${1:-}"

if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]{2,63}$ ]]; then
  echo "Informe o nome da variável em maiúsculas, por exemplo: GAMMA_API_KEY" >&2
  exit 1
fi
if [[ "$name" == VITE_* ]]; then
  echo "Variável VITE_ vai para o navegador — segredo nunca pode ter esse prefixo." >&2
  exit 1
fi

read -r -s -p "Cole o valor de $name (não aparece na tela) e aperte Enter: " value
echo
if [[ -z "$value" ]]; then
  echo "Valor vazio: nada foi gravado." >&2
  exit 1
fi

remote_program=$(cat <<'PY'
import os, stat, subprocess, sys, tempfile
path = "/opt/wisewolf/supabase-docker/.env.functions"
name = sys.argv[1]
value = sys.stdin.read().rstrip("\n")
if not value or "\n" in value:
    sys.exit("valor inválido")
lines = open(path).read().splitlines() if os.path.exists(path) else []
existed = any(l.split("=", 1)[0].strip() == name for l in lines)
kept = [l for l in lines if l.split("=", 1)[0].strip() != name]
kept.append(f"{name}={value}")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as out:
    out.write("\n".join(kept) + "\n")
os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
os.replace(tmp, path)
subprocess.run(["docker", "compose", "up", "-d", "functions"], cwd="/opt/wisewolf/supabase-docker",
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f"{name} {'atualizada' if existed else 'gravada'}; container das functions recriado")
PY
)

printf '%s' "$value" | ssh -o BatchMode=yes "$HOST" "python3 -c $(printf %q "$remote_program") $(printf %q "$name")"
unset value
