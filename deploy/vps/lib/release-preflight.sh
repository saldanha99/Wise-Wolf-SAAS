#!/usr/bin/env bash
# Guarda de árvore para os scripts de release.
#
# Os releases são construídos a partir da ÁRVORE DE TRABALHO do checkout onde o
# script roda, não do que está no git. Sem verificação, dois acidentes reais já
# aconteceram: publicar uma árvore ATRASADA (o `App.tsx` antigo voltou ao ar e
# deixou professor sem lançar aula por ~23h) e publicar trabalho NÃO COMMITADO
# que estava no checkout por acaso.
#
# Este módulo é carregado pelos scripts de release e depende de `die()` do
# chamador. Ele não expõe segredo nem contata a VPS: falha antes de qualquer
# alteração remota. O arquivo privado de deploy é lido somente pelo SHA-256.

_release_resolve_existing_path() {
  local input_path=$1
  local path_dir path_name

  case "$input_path" in
    /*) ;;
    *) input_path="$PWD/$input_path" ;;
  esac

  path_dir=${input_path%/*}
  path_name=${input_path##*/}
  [[ -n "$path_dir" ]] || path_dir=/
  (
    cd -P -- "$path_dir" >/dev/null 2>&1 || exit 1
    printf '%s/%s\n' "$PWD" "$path_name"
  )
}

_release_sha256_regular_file() {
  local file_path=$1
  local digest_line digest

  digest_line="$(shasum -a 256 < "$file_path")" || return 1
  digest=${digest_line%% *}
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

_release_sha256_symlink() {
  local link_path=$1
  local target_with_sentinel target digest_line digest

  # O sentinela preserva inclusive quebras de linha no fim do destino. O
  # conteúdo apontado nunca é escrito: somente o hash entra no fingerprint.
  target_with_sentinel="$(readlink "$link_path" && printf x)" || return 1
  target=${target_with_sentinel%x}
  digest_line="$(printf '%s' "$target" | shasum -a 256)" || return 1
  digest=${digest_line%% *}
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

_release_emit_regular_file_hashes() {
  local project_dir=$1
  shift
  (( $# > 0 )) || return 0
  (
    cd -- "$project_dir" || exit 1
    LC_ALL=C shasum -a 256 "$@" || exit 1
    if stat -f '%Lp' . >/dev/null 2>&1; then
      LC_ALL=C stat -f 'mode:%Lp path:%N' "$@"
    else
      LC_ALL=C stat -c 'mode:%a path:%n' "$@"
    fi
  )
}

# Produz somente um SHA-256. Nenhum conteúdo de arquivo regular — inclusive o
# arquivo privado de deploy — é mantido em variável, arquivo temporário ou log.
_release_tree_fingerprint() {
  local project_dir=$1
  local deploy_env_file=${2:-}
  local head_sha relative_path absolute_path file_type file_hash executable_bit
  local fingerprint_line fingerprint
  local regular_count=0 file_list_complete=0
  local -a regular_paths=()

  head_sha="$(git -C "$project_dir" rev-parse HEAD)" || return 1
  fingerprint_line="$(set -o pipefail; {
    printf 'release-tree-fingerprint-v1\0head\0%s\0' "$head_sha"

    while IFS= read -r -d '' relative_path; do
      if [[ -z "$relative_path" ]]; then
        file_list_complete=1
        continue
      fi
      absolute_path="$project_dir/$relative_path"
      executable_bit=0

      if [[ -L "$absolute_path" ]]; then
        file_type=symlink
        file_hash="$(_release_sha256_symlink "$absolute_path")" || return 1
      elif [[ -f "$absolute_path" ]]; then
        file_type=file
        [[ -x "$absolute_path" ]] && executable_bit=1
        regular_paths[$regular_count]="./$relative_path"
        regular_count=$((regular_count + 1))
      elif [[ -d "$absolute_path" ]] &&
        git -C "$absolute_path" rev-parse --git-dir >/dev/null 2>&1; then
        file_type=git-directory
        file_hash="$(_release_tree_fingerprint "$absolute_path" "")" || return 1
      elif [[ ! -e "$absolute_path" ]]; then
        file_type=missing
        file_hash=-
      else
        echo "ERRO: entrada não regular na árvore de release: $relative_path" >&2
        return 1
      fi

      printf 'path\0%s\0type\0%s\0executable\0%s\0' \
        "$relative_path" "$file_type" "$executable_bit"
      if [[ "$file_type" != file ]]; then
        printf 'hash\0%s\0' "$file_hash"
      elif (( regular_count == 64 )); then
        printf 'regular-file-hashes\0'
        _release_emit_regular_file_hashes \
          "$project_dir" "${regular_paths[@]}" || return 1
        printf '\0'
        regular_paths=()
        regular_count=0
      fi
    done < <(
      {
        LC_ALL=C git -C "$project_dir" \
          ls-files -z --cached --others --exclude-standard &&
          # O Vite copia `public/` literalmente. MP4s, pôsteres e manifestos
          # finais podem ser ignorados pelo Git para não inchar o histórico,
          # mas ainda entram no artefato e portanto pertencem à fotografia.
          LC_ALL=C git -C "$project_dir" \
            ls-files -z --others --ignored --exclude-standard -- public
      } && printf '\0'
    )
    (( file_list_complete == 1 )) || return 1

    if (( regular_count > 0 )); then
      printf 'regular-file-hashes\0'
      _release_emit_regular_file_hashes \
        "$project_dir" "${regular_paths[@]}" || return 1
      printf '\0'
    fi

    if [[ -n "$deploy_env_file" ]]; then
      [[ -f "$deploy_env_file" && -r "$deploy_env_file" ]] || return 1
      file_hash="$(_release_sha256_regular_file "$deploy_env_file")" || return 1
      printf 'deploy-env-hash\0%s\0' "$file_hash"
    else
      printf 'deploy-env-hash\0unset\0'
    fi
  } | shasum -a 256)" || return 1

  fingerprint=${fingerprint_line%% *}
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$fingerprint"
}

# Uso: assert_release_tree_is_publishable <diretório-do-projeto>
assert_release_tree_is_publishable() {
  local project_dir=$1
  local dirty_files branch head_sha head_subject remote_ref
  local deploy_env_file fingerprint_first fingerprint_second

  command -v git >/dev/null 2>&1 || die "comando obrigatório ausente: git"
  command -v readlink >/dev/null 2>&1 ||
    die "comando obrigatório ausente: readlink"
  command -v shasum >/dev/null 2>&1 ||
    die "comando obrigatório ausente: shasum"
  command -v stat >/dev/null 2>&1 ||
    die "comando obrigatório ausente: stat"
  git -C "$project_dir" rev-parse --git-dir >/dev/null 2>&1 ||
    die "o diretório de release não é um repositório git: $project_dir"

  # 1. Nada não commitado pode entrar na release por acaso.
  dirty_files="$(git -C "$project_dir" status --porcelain)"
  if [[ -n "$dirty_files" ]]; then
    printf '%s\n' "$dirty_files" | head -n 20 >&2
    if [[ "${DEPLOY_ALLOW_DIRTY:-0}" = "1" ]]; then
      echo "AVISO: DEPLOY_ALLOW_DIRTY=1 — as alterações acima VÃO para produção." >&2
    else
      die "árvore suja: as alterações acima entrariam na release. Commite ou descarte antes de publicar (DEPLOY_ALLOW_DIRTY=1 força, por sua conta e risco)."
    fi
  fi

  # 2. A branch de produção é declarada, não adivinhada.
  branch="$(git -C "$project_dir" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" != "HEAD" ]] ||
    die "HEAD desanexado em $project_dir: publique a partir de uma branch nomeada."

  [[ -n "${DEPLOY_GIT_BRANCH:-}" ]] ||
    die "DEPLOY_GIT_BRANCH ausente: declare no arquivo de deploy qual branch é produção (ex.: DEPLOY_GIT_BRANCH=$branch)."

  [[ "$branch" = "$DEPLOY_GIT_BRANCH" ]] ||
    die "este checkout está em '$branch', mas produção sai de '$DEPLOY_GIT_BRANCH'. Publicar daqui republicaria código de outra árvore."

  # 3. A árvore não pode estar atrás do que já foi publicado na branch.
  if [[ "${DEPLOY_SKIP_FETCH:-0}" != "1" ]]; then
    git -C "$project_dir" fetch --quiet --no-tags origin "$DEPLOY_GIT_BRANCH" 2>/dev/null ||
      echo "AVISO: não consegui consultar o origin; comparando com as refs locais." >&2
  fi

  remote_ref="refs/remotes/origin/$DEPLOY_GIT_BRANCH"
  if git -C "$project_dir" rev-parse --verify --quiet "$remote_ref" >/dev/null; then
    git -C "$project_dir" merge-base --is-ancestor "$remote_ref" HEAD ||
      die "este checkout está ATRÁS de origin/$DEPLOY_GIT_BRANCH. Atualize (git pull --ff-only) e confira o git log antes de publicar."
  fi

  # 4. Defesa extra: uma árvore que não contém a main é sempre código velho.
  if git -C "$project_dir" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    git -C "$project_dir" merge-base --is-ancestor refs/remotes/origin/main HEAD ||
      die "este checkout não contém origin/main: publicá-lo removeria do ar o que já está na main."
  fi

  deploy_env_file=""
  if [[ -n "${DEPLOY_ENV_FILE:-}" ]]; then
    deploy_env_file="$(_release_resolve_existing_path "$DEPLOY_ENV_FILE")" ||
      die "não foi possível localizar com segurança o arquivo privado de deploy"
    [[ -f "$deploy_env_file" && -r "$deploy_env_file" ]] ||
      die "o arquivo privado de deploy não está legível"
  fi

  # Duas leituras consecutivas impedem aprovar uma fotografia híbrida caso um
  # editor salve no exato momento do preflight.
  fingerprint_first="$(_release_tree_fingerprint \
    "$project_dir" "$deploy_env_file")" ||
    die "não foi possível calcular o fingerprint da árvore de release"
  fingerprint_second="$(_release_tree_fingerprint \
    "$project_dir" "$deploy_env_file")" ||
    die "não foi possível confirmar o fingerprint da árvore de release"
  [[ "$fingerprint_first" = "$fingerprint_second" ]] ||
    die "a árvore está mudando durante o preflight. Pare os editores/agentes que escrevem neste checkout e rode novamente."

  RELEASE_TREE_FINGERPRINT_AT_PREFLIGHT=$fingerprint_first
  RELEASE_DEPLOY_ENV_FILE_AT_PREFLIGHT=$deploy_env_file

  head_sha="$(git -C "$project_dir" rev-parse --short=12 HEAD)"
  head_subject="$(git -C "$project_dir" log -1 --pretty=%s)"
  echo "== Árvore de release =="
  echo "checkout: $project_dir"
  echo "branch:   $branch"
  echo "commit:   $head_sha — $head_subject"
}

# Uso: assert_release_tree_unchanged <diretório-do-projeto> <sha-completo-de-quando-checamos>
#
# A checagem acima roda UMA VEZ, no começo. Entre ela e a leitura dos arquivos
# passam-se minutos (install, typecheck, testes, build) — e nessa janela alguém
# pode salvar arquivo no mesmo checkout. Aconteceu em 12/08/2026: a árvore foi
# aprovada às 23:05, um colega salvou 248 linhas de uma feature em andamento às
# ~23:07, e o release de 23:09 EMPACOTOU esse trabalho não commitado. Ele só foi
# commitado dez minutos depois; a publicação não sabia o que estava levando.
#
# Por isso a árvore é reconferida imediatamente antes de empacotar, e o HEAD tem
# de ser o mesmo — trocar de commit no meio do release também invalida tudo que
# já foi verificado.
assert_release_tree_unchanged() {
  local project_dir=$1 expected_head=$2
  local dirty_files head_now fingerprint_now fingerprint_confirm deploy_env_file

  dirty_files="$(git -C "$project_dir" status --porcelain)"
  if [[ -n "$dirty_files" ]]; then
    if [[ "${DEPLOY_ALLOW_DIRTY:-0}" != "1" ]]; then
      printf '%s\n' "$dirty_files" | head -n 20 >&2
      die "a árvore MUDOU durante o release (arquivos acima). Alguém salvou algo no checkout depois da verificação inicial: o pacote levaria trabalho não commitado. Rode de novo com a árvore parada."
    fi
  fi

  head_now="$(git -C "$project_dir" rev-parse HEAD)"
  [[ "$head_now" = "$expected_head" ]] ||
    die "o HEAD mudou durante o release ($expected_head → $head_now). Tudo que foi verificado até aqui vale para outro commit; rode de novo."

  [[ "${RELEASE_TREE_FINGERPRINT_AT_PREFLIGHT:-}" =~ ^[a-f0-9]{64}$ ]] ||
    die "fingerprint inicial da árvore ausente; rode novamente desde o começo do release."
  deploy_env_file=${RELEASE_DEPLOY_ENV_FILE_AT_PREFLIGHT:-}
  fingerprint_now="$(_release_tree_fingerprint \
    "$project_dir" "$deploy_env_file")" ||
    die "não foi possível recalcular o fingerprint da árvore de release"
  fingerprint_confirm="$(_release_tree_fingerprint \
    "$project_dir" "$deploy_env_file")" ||
    die "não foi possível confirmar o fingerprint atual da árvore de release"
  [[ "$fingerprint_now" = "$fingerprint_confirm" ]] ||
    die "a árvore está mudando enquanto o release a reconfere. Pare os editores/agentes deste checkout e rode novamente."

  if [[ "$fingerprint_now" != "$RELEASE_TREE_FINGERPRINT_AT_PREFLIGHT" ]]; then
    [[ -z "$dirty_files" ]] || printf '%s\n' "$dirty_files" | head -n 20 >&2
    die "a árvore MUDOU durante o release, mesmo com DEPLOY_ALLOW_DIRTY=1. Arquivo rastreado, não rastreado ou a configuração privada de deploy diverge do preflight; rode novamente com o checkout parado."
  fi
}
