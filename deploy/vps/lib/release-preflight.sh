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
# chamador. Ele não lê segredo nem contata a VPS: falha antes de qualquer
# alteração remota.

# Uso: assert_release_tree_is_publishable <diretório-do-projeto>
assert_release_tree_is_publishable() {
  local project_dir=$1
  local dirty_files branch head_sha head_subject remote_ref

  command -v git >/dev/null 2>&1 || die "comando obrigatório ausente: git"
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

  head_sha="$(git -C "$project_dir" rev-parse --short=12 HEAD)"
  head_subject="$(git -C "$project_dir" log -1 --pretty=%s)"
  echo "== Árvore de release =="
  echo "checkout: $project_dir"
  echo "branch:   $branch"
  echo "commit:   $head_sha — $head_subject"
}
