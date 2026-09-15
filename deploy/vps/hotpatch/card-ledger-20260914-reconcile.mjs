#!/usr/bin/env node
// Finish the exact post-commit release, retaining its original failure evidence.
// No code replacement, migration replay, receipt reclassification or gate skip.
import { readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = new URL('../../../', import.meta.url);
const publisher = readFileSync(new URL('deploy/vps/release.sh', root), 'utf8');
const sql = publisher.match(/^do \$verify\$\n[\s\S]*?^\$verify\$;/m)?.[0];
const start = publisher.indexOf('\nwait_for_http_status() {');
const end = publisher.indexOf('\n[[ ! -e "$current_marker_tmp"', start);
if (!sql || start < 0 || end < 0) throw new Error('Publisher verification boundaries changed');
const smokes = publisher.slice(start, end);
for (const required of ['student-card-notify', 'testMode', 'wolfie-live-proxy', 'asaas-reconcile']) {
  if (!smokes.includes(required)) throw new Error(`Missing smoke contract: ${required}`);
}
if (!sql.includes("then 'RECEBIMENTO_NAO_CLASSIFICADO'")) throw new Error('Publisher category repair missing');
const repairCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(repairCommit)) throw new Error('Invalid commit');
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('src/components/wolfie/visuals/visualAssetManifest.json', root), 'utf8'));
const assetCount = manifest.scenes.length * 2 + manifest.characters.length + manifest.legacyAliases.length;
const script = String.raw`set -Eeuo pipefail
umask 077
stage=state
relative=none
trap 'printf "Recovery blocked at line %s, stage %s, file %s\n" "$LINENO" "$stage" "$relative" >&2' ERR
release_id=20260915T002102Z-eee35753080f
release_dir=/opt/wisewolf/releases/$release_id
original_backup=/opt/wisewolf/backups/release-$release_id
runtime=/opt/wisewolf/supabase-docker/volumes/functions
frontend=/opt/wisewolf/frontend/src/dist
public_url=https://system.wisewolflanguage.com.br
api_url=https://api.wisewolflanguage.com.br
exec 9>/opt/wisewolf/releases/.deploy.lock
flock -n 9
exec 8>/opt/wisewolf/frontend/.hub-activation.lock
flock -n 8
grep -Fxq "post_commit_failed:$release_id" "$original_backup/ACTIVATION_STATE"
grep -Fxq "post_commit_validation_failed:$release_id" "$original_backup/POST_COMMIT_FAILURE"
grep -Fxq "$release_id" /opt/wisewolf/releases/current
grep -Fxq 'source_git_sha=01c982292ed81225c837367282e46d72e19b3d1e' "$release_dir/release-provenance.txt"
stage=immutable-package
(cd "$release_dir" && sha256sum --check --status release-inputs.sha256)
stage=active-files-and-migration-markers
verified=0
while read -r expected relative; do
  target=
  case "$relative" in
    functions/_shared/*.test.ts) continue ;;
    functions/*) target="$runtime/$(echo "$relative" | cut -d/ -f2-)" ;;
    frontend-dist/*) target="$frontend/$(echo "$relative" | cut -d/ -f2-)" ;;
    nginx.conf) target=/opt/wisewolf/frontend/nginx.conf ;;
    migrations/*)
      migration_file=$(basename "$relative")
      version=$(echo "$migration_file" | cut -d_ -f1)
      grep -Fxq "$expected" "/opt/wisewolf/releases/.migration-checksums/$version-$expected.sha256"
      continue ;;
    *) continue ;;
  esac
  [[ -f "$target" && ! -L "$target" ]]
  [[ "$(sha256sum "$target" | cut -d' ' -f1)" = "$expected" ]]
  verified=$((verified + 1))
done < "$release_dir/release-inputs.sha256"
[[ "$verified" -gt 100 ]]
manifest_sha=$(sha256sum "$release_dir/release-inputs.sha256" | cut -d' ' -f1)
[[ "$manifest_sha" =~ ^[a-f0-9]{64}$ ]]
stage=database-journal
db_status=$(docker exec supabase-db psql -X -U supabase_admin -d postgres -Atc "select release_state from private.release_commit_journal where release_id='$release_id' and release_manifest_checksum='$manifest_sha' and committed_at is not null")
[[ "$db_status" = COMMITTED ]]
backup_dir=$(mktemp -d "$original_backup/card-ledger-recovery.XXXXXX")
stage=read-only-invariants
printf '%s' '__SQL_B64__' | base64 -d > "$backup_dir/verification.sql"
printf '%s' '__SMOKES_B64__' | base64 -d > "$backup_dir/smokes.sh"
[[ "$(sha256sum "$backup_dir/verification.sql" | cut -d' ' -f1)" = __SQL_SHA__ ]]
[[ "$(sha256sum "$backup_dir/smokes.sh" | cut -d' ' -f1)" = __SMOKES_SHA__ ]]
bash -n "$backup_dir/smokes.sh"
docker exec -i supabase-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "$backup_dir/verification.sql"
echo 'PASS: immutable package, active code, migration markers, database journal and read-only invariants'
wolfie_asset_count=__ASSET_COUNT__
while read -r expected relative; do
    case "$relative" in
      frontend-dist/assets/wolfie/*.webp)
        url=/$(echo "$relative" | cut -d/ -f2-)
        bytes=$(stat -c '%s' "$release_dir/$relative")
        printf '%s\t%s\t%s\n' "$url" "$bytes" "$expected" ;;
    esac
done < "$release_dir/release-inputs.sha256" > "$backup_dir/asset-lock.tsv"
wolfie_asset_lock_b64=$(base64 -w0 "$backup_dir/asset-lock.tsv")
stage=publisher-smokes
source "$backup_dir/smokes.sh"
stage=completion
[[ "$(docker inspect --format '{{.State.Running}}' frontend-frontend-1)" = true ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' supabase-edge-functions)" = healthy ]]
[[ ! -e "$original_backup/POST_COMMIT_FAILURE.resolved" ]]
printf 'release=%s\nrepair_commit=__REPAIR_COMMIT__\nmanifest_sha256=%s\nverified_files=%s\ndatabase=COMMITTED\nread_only_invariants=PASS\nall_publisher_smokes=PASS\nreceipts_changed_by_repair=0\n' "$release_id" "$manifest_sha" "$verified" > "$backup_dir/RESULT"
cp -a "$original_backup/ACTIVATION_STATE" "$backup_dir/ACTIVATION_STATE.before"
mv "$original_backup/POST_COMMIT_FAILURE" "$original_backup/POST_COMMIT_FAILURE.resolved"
printf 'active:%s\n' "$release_id" > "$original_backup/.ACTIVATION_STATE.card-ledger-recovery"
mv "$original_backup/.ACTIVATION_STATE.card-ledger-recovery" "$original_backup/ACTIVATION_STATE"
printf 'Release reconciled and active: %s; evidence: %s\n' "$release_id" "$backup_dir"
`.replaceAll('__SQL_B64__', Buffer.from(`begin read only; set local statement_timeout='30s';\n${sql}\nrollback;\n`).toString('base64'))
  .replaceAll('__SQL_SHA__', sha(`begin read only; set local statement_timeout='30s';\n${sql}\nrollback;\n`))
  .replaceAll('__SMOKES_B64__', Buffer.from(smokes).toString('base64'))
  .replaceAll('__SMOKES_SHA__', sha(smokes))
  .replaceAll('__ASSET_COUNT__', String(assetCount))
  .replaceAll('__REPAIR_COMMIT__', repairCommit);
execFileSync('bash', ['-n'], { input: script });
if (process.argv[2] !== '--execute') {
  console.log(`Recovery syntax and extraction verified; ${assetCount} HTTP assets; no remote action.`);
} else {
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit recovery evidence before execution');
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'wisewolf-vps', 'bash', '-s'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(script);
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
