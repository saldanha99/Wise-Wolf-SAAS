#!/usr/bin/env bash
# Targeted recovery of the missing, already-tested helper from commit d4a496e.
# Run on the VPS with the pre-uploaded private staging directory as argument.
# Does not rewrite release provenance, database state or failure markers.
set -Eeuo pipefail
umask 077
stage=${1:?private staging directory required}
release_id=20260912T223800Z-6a2a75eb267a
release_dir=/opt/wisewolf/releases/$release_id
backup_dir=/opt/wisewolf/backups/release-$release_id
runtime=/opt/wisewolf/supabase-docker/volumes/functions
helper_sha=08520077a2ec6d0de5a0b648ce78f2a10142df925d6ae8034d2acc4efd236d54
inbound_sha=a032b9dc8e6ed5facd0a31afa7aa90c1e153f79c1f17583c23642838acdd48b1
[[ "$stage" == /opt/wisewolf/backups/quality-shared-repair.* ]]
[[ -d "$stage" && ! -L "$stage" ]]
exec 9>/opt/wisewolf/releases/.deploy.lock
flock -n 9
grep -Fxq "post_commit_failed:$release_id" "$backup_dir/ACTIVATION_STATE"
grep -Fxq 'source_git_sha=d4a496e4d1ee91210f1f0fcd3b6d2605e2476d40' "$release_dir/release-provenance.txt"
[[ "$(sha256sum "$runtime/whatsapp-inbound/index.ts" | cut -d' ' -f1)" = "$inbound_sha" ]]
[[ -f "$stage/lesson-quality-reply.ts" && ! -L "$stage/lesson-quality-reply.ts" ]]
[[ "$(sha256sum "$stage/lesson-quality-reply.ts" | cut -d' ' -f1)" = "$helper_sha" ]]
[[ ! -e "$runtime/_shared/lesson-quality-reply.ts" && ! -L "$runtime/_shared/lesson-quality-reply.ts" ]]
cp -a -- "$backup_dir/ACTIVATION_STATE" "$stage/ACTIVATION_STATE.before"
cp -a -- "$backup_dir/POST_COMMIT_FAILURE" "$stage/POST_COMMIT_FAILURE.before"
install -m 0644 "$stage/lesson-quality-reply.ts" "$runtime/_shared/lesson-quality-reply.ts"
[[ "$(sha256sum "$runtime/_shared/lesson-quality-reply.ts" | cut -d' ' -f1)" = "$helper_sha" ]]
docker restart supabase-edge-functions >/dev/null
for endpoint in whatsapp-inbound 'whatsapp-inbound?worker=sdr'; do
  status=
  for attempt in {1..8}; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 \
      -X POST "https://api.wisewolflanguage.com.br/functions/v1/$endpoint" \
      -H 'Content-Type: application/json' --data '{}' || true)
    [[ "$status" = 403 ]] && break
    sleep 1
  done
  [[ "$status" = 403 ]]
  printf 'Verified %s: HTTP %s\n' "$endpoint" "$status"
done
printf 'helper_sha256=%s\nsource_git_sha=%s\n' "$helper_sha" \
  d4a496e4d1ee91210f1f0fcd3b6d2605e2476d40 > "$stage/RESTORED"
printf 'Helper restored and WhatsApp authentication verified. Evidence: %s\n' "$stage"
