#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wisewolf-release-preflight-test.XXXXXX")"

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ -d "$TEST_ROOT" && ! -L "$TEST_ROOT" &&
    "$TEST_ROOT" == "${TMPDIR:-/tmp}"/wisewolf-release-preflight-test.* ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

die() {
  echo "ERRO: $*" >&2
  exit 1
}

# shellcheck source=release-preflight.sh
source "$SCRIPT_DIR/release-preflight.sh"

new_fixture() {
  local fixture_name=$1

  FIXTURE_DIR="$TEST_ROOT/$fixture_name"
  mkdir -p -- "$FIXTURE_DIR"
  git -C "$FIXTURE_DIR" init -q
  git -C "$FIXTURE_DIR" config user.email release-preflight@example.invalid
  git -C "$FIXTURE_DIR" config user.name "Release Preflight Test"
  git -C "$FIXTURE_DIR" checkout -q -b main
  printf 'base\n' > "$FIXTURE_DIR/tracked.txt"
  printf '.env.deploy.local\nignored.txt\n/public/*.mp4\n' > \
    "$FIXTURE_DIR/.gitignore"
  chmod 0644 "$FIXTURE_DIR/.gitignore" "$FIXTURE_DIR/tracked.txt"
  git -C "$FIXTURE_DIR" add .gitignore tracked.txt
  git -C "$FIXTURE_DIR" commit -qm base
  printf 'DEPLOY_TEST_SENTINEL=valor-inicial\n' > \
    "$FIXTURE_DIR/.env.deploy.local"

  DEPLOY_ALLOW_DIRTY=1
  DEPLOY_GIT_BRANCH=main
  DEPLOY_SKIP_FETCH=1
  DEPLOY_ENV_FILE="$FIXTURE_DIR/.env.deploy.local"
}

capture_baseline() {
  assert_release_tree_is_publishable "$FIXTURE_DIR" >/dev/null 2>&1
  FIXTURE_HEAD="$(git -C "$FIXTURE_DIR" rev-parse HEAD)"
}

expect_snapshot_failure() {
  local case_name=$1
  local output_file="$TEST_ROOT/$case_name.output"

  if (assert_release_tree_unchanged "$FIXTURE_DIR" "$FIXTURE_HEAD") \
    >"$output_file" 2>&1; then
    echo "ERRO: $case_name deveria ter bloqueado o release" >&2
    exit 1
  fi
  grep -Fq 'a árvore MUDOU durante o release' "$output_file" || {
    echo "ERRO: $case_name falhou sem a mensagem de proteção esperada" >&2
    exit 1
  }
}

new_fixture unchanged-dirty
printf 'alteração inicial\n' >> "$FIXTURE_DIR/tracked.txt"
capture_baseline
assert_release_tree_unchanged "$FIXTURE_DIR" "$FIXTURE_HEAD"

new_fixture tracked-content
printf 'alteração inicial\n' >> "$FIXTURE_DIR/tracked.txt"
capture_baseline
printf 'alteração durante release\n' >> "$FIXTURE_DIR/tracked.txt"
expect_snapshot_failure tracked-content

new_fixture untracked-content
printf 'rascunho inicial\n' > "$FIXTURE_DIR/untracked.txt"
capture_baseline
printf 'rascunho alterado\n' > "$FIXTURE_DIR/untracked.txt"
expect_snapshot_failure untracked-content

new_fixture added-untracked
capture_baseline
printf 'arquivo novo\n' > "$FIXTURE_DIR/new-during-release.txt"
expect_snapshot_failure added-untracked

new_fixture ignored-public-asset
mkdir -p -- "$FIXTURE_DIR/public"
printf 'vídeo inicial\n' > "$FIXTURE_DIR/public/tour.mp4"
capture_baseline
printf 'vídeo alterado\n' > "$FIXTURE_DIR/public/tour.mp4"
expect_snapshot_failure ignored-public-asset

new_fixture symlink-target
printf 'mesmo conteúdo\n' > "$FIXTURE_DIR/target-a.txt"
printf 'mesmo conteúdo\n' > "$FIXTURE_DIR/target-b.txt"
ln -s target-a.txt "$FIXTURE_DIR/current.txt"
capture_baseline
ln -sfn target-b.txt "$FIXTURE_DIR/current.txt"
expect_snapshot_failure symlink-target

new_fixture file-mode
capture_baseline
chmod 0600 "$FIXTURE_DIR/tracked.txt"
expect_snapshot_failure file-mode

new_fixture deploy-env
capture_baseline
env_sentinel='SEGREDO_QUE_NUNCA_PODE_APARECER_NO_LOG'
printf 'DEPLOY_TEST_SENTINEL=%s\n' "$env_sentinel" > "$DEPLOY_ENV_FILE"
expect_snapshot_failure deploy-env
if grep -R -Fq "$env_sentinel" "$TEST_ROOT"/*.output; then
  echo "ERRO: conteúdo do arquivo privado de deploy vazou no log" >&2
  exit 1
fi

new_fixture ignored-file
printf 'ignorado antes\n' > "$FIXTURE_DIR/ignored.txt"
capture_baseline
printf 'ignorado depois\n' > "$FIXTURE_DIR/ignored.txt"
assert_release_tree_unchanged "$FIXTURE_DIR" "$FIXTURE_HEAD"

echo "release-preflight: todos os cenários passaram"
