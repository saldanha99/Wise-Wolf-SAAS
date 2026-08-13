#!/usr/bin/env bash
# Trava contra publicação ÀS CEGAS de edge function.
#
# O release copia as functions do repositório por cima do que está na VPS, sem
# olhar o que havia lá. Isso é certo quando o repositório é a fonte da verdade —
# e desastroso quando não é.
#
# Aconteceu (medido em 12/08/2026): `send-attendance-confirmations` tinha, NA
# VPS, 38 linhas que o repositório não tinha — a revalidação "anti-fantasma", que
# cancela a confirmação de presença quando a aula não existe mais na agenda em
# vez de perguntar ao aluno se ele teve uma aula que foi apagada. Alguém corrigiu
# direto no servidor (o caminho de hotfix por `scp`, documentado no CLAUDE.md) e
# não commitou de volta. Publicar sem olhar teria apagado a proteção em silêncio,
# e a escola só descobriria pelo aluno reclamando.
#
# COMO A TRAVA SABE A DIFERENÇA entre "estou publicando minha mudança" e "vou
# destruir um hotfix": ela não compara repositório com VPS — comparar isso
# acusaria toda publicação legítima. Ela compara a VPS com o que o ÚLTIMO RELEASE
# publicou, gravado num manifesto no próprio servidor.
#
#   VPS == manifesto  → ninguém mexeu no servidor desde o último deploy; o
#                       repositório é a fonte da verdade e pode sobrescrever.
#   VPS != manifesto  → alguém mexeu por fora. PARA e mostra quais.
#
# O manifesto é reescrito ao fim de cada release bem-sucedido, a partir do que
# ficou no servidor.
#
# Escape consciente: `DEPLOY_ALLOW_FUNCTION_DRIFT=1` publica mesmo assim. Use
# depois de trazer o hotfix para o repositório — ou quando a intenção é
# justamente descartá-lo.
#
# Depende de `die()` do chamador. Não lê segredo.

RELEASE_FUNCTION_MANIFEST="${RELEASE_FUNCTION_MANIFEST:-/opt/wisewolf/releases/.published-functions.md5}"

# Hash por function: todos os arquivos da pasta, em ordem estável.
# `find | sort | md5sum` cobre arquivo novo, apagado e alterado.
_remote_manifest_script() {
  cat <<'REMOTE_SCRIPT'
set -Eeuo pipefail
functions_dir=$1
for function_dir in "$functions_dir"/*/; do
  function_name="$(basename "$function_dir")"
  [[ "$function_name" = _* ]] && continue
  [[ -f "$function_dir/index.ts" ]] || continue
  printf '%s %s\n' \
    "$(find "$function_dir" -type f -print0 | sort -z | xargs -0 md5sum | md5sum | awk '{print $1}')" \
    "$function_name"
done
REMOTE_SCRIPT
}

# Uso: assert_no_out_of_band_function_changes <host> <functions_dir>
assert_no_out_of_band_function_changes() {
  local ssh_host=$1 functions_dir=$2
  local atual manifesto divergentes

  echo "== Trava de publicação às cegas =="

  atual="$(ssh -o BatchMode=yes "$ssh_host" bash -s -- "$functions_dir" \
    <<<"$(_remote_manifest_script)")" ||
    die "não consegui inventariar as functions na VPS"
  [[ -n "$atual" ]] || die "inventário de functions veio vazio — abortando por segurança"

  manifesto="$(ssh -o BatchMode=yes "$ssh_host" \
    "cat '$RELEASE_FUNCTION_MANIFEST' 2>/dev/null" || true)"

  if [[ -z "$manifesto" ]]; then
    # Primeiro release depois desta trava existir. Não dá para acusar deriva sem
    # linha de base — mas dizer isso em voz alta importa: esta publicação é a
    # única que ainda passa sem verificação.
    echo "AVISO: sem manifesto anterior (primeira execução da trava)." >&2
    echo "       Esta publicação NÃO foi verificada contra deriva; a próxima será." >&2
    return 0
  fi

  # Só acusa function que o release conhece: o manifesto guarda o estado do
  # servidor inteiro, e pasta que o release não publica (experimento, sobra) não
  # deve derrubar o deploy.
  divergentes=""
  while read -r hash_esperado nome; do
    [[ -n "$nome" ]] || continue
    local hash_atual
    hash_atual="$(awk -v n="$nome" '$2 == n {print $1}' <<<"$atual")"
    [[ -n "$hash_atual" ]] || { divergentes+="  $nome — sumiu da VPS"$'\n'; continue; }
    [[ "$hash_atual" = "$hash_esperado" ]] ||
      divergentes+="  $nome — mudou na VPS desde o último release"$'\n'
  done <<<"$manifesto"

  if [[ -n "$divergentes" ]]; then
    printf '%s' "$divergentes" >&2
    if [[ "${DEPLOY_ALLOW_FUNCTION_DRIFT:-0}" = "1" ]]; then
      echo "AVISO: DEPLOY_ALLOW_FUNCTION_DRIFT=1 — as versões acima SERÃO SOBRESCRITAS." >&2
      return 0
    fi
    die "a VPS tem edge function alterada por fora do release (lista acima).
Publicar agora sobrescreveria essas versões — foi assim que quase perdemos a
revalidação anti-fantasma do antifraude de presença.

Antes de seguir, para CADA uma:
  ssh $ssh_host 'cat $functions_dir/<nome>/index.ts' > supabase/functions/<nome>/index.ts
  git diff supabase/functions/<nome>/     # entenda o que o servidor tem a mais
e commite o que for para ficar. Se a intenção é mesmo DESCARTAR o que está no
servidor, republique com DEPLOY_ALLOW_FUNCTION_DRIFT=1."
    # O `die` do release encerra o processo, mas um chamador com `die` que apenas
    # retorna faria a execução seguir daqui para a linha de sucesso — anunciando
    # "nenhuma function alterada" logo depois de acusar deriva.
    return 1
  fi

  echo "Nenhuma function alterada por fora do release."
}

# Uso: update_published_function_manifest <host> <functions_dir>
# Chamado DEPOIS do deploy, a partir do que de fato ficou no servidor.
update_published_function_manifest() {
  local ssh_host=$1 functions_dir=$2
  ssh -o BatchMode=yes "$ssh_host" bash -s -- "$functions_dir" "$RELEASE_FUNCTION_MANIFEST" <<'REMOTE'
set -Eeuo pipefail
functions_dir=$1
manifest_path=$2
[[ "$manifest_path" == /opt/wisewolf/* ]]
mkdir -p -- "$(dirname "$manifest_path")"
tmp="$(mktemp)"
for function_dir in "$functions_dir"/*/; do
  function_name="$(basename "$function_dir")"
  [[ "$function_name" = _* ]] && continue
  [[ -f "$function_dir/index.ts" ]] || continue
  printf '%s %s\n' \
    "$(find "$function_dir" -type f -print0 | sort -z | xargs -0 md5sum | md5sum | awk '{print $1}')" \
    "$function_name"
done > "$tmp"
[[ -s "$tmp" ]]
mv -- "$tmp" "$manifest_path"
REMOTE
}
