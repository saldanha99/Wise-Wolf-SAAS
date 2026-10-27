#!/usr/bin/env bash
# Add the first-party tracker to the currently published institutional site,
# preserving every current HTML page and using its official atomic activation.
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
asset="$root/public/school-origin-tracking.js"
[[ -s "$asset" ]]
checksum=$(shasum -a 256 "$asset" | awk '{print $1}')
# The application release must already serve this exact version.
temp_asset=$(mktemp)
trap 'rm -f -- "$temp_asset"' EXIT
curl -fsS https://system.wisewolflanguage.com.br/school-origin-tracking.js -o "$temp_asset"
[[ "$(shasum -a 256 "$temp_asset" | awk '{print $1}')" = "$checksum" ]]
release_id=$(date -u +%Y%m%dT%H%M%SZ)
ssh -o BatchMode=yes wisewolf-vps python3 - "$release_id" "$checksum" <<'PY'
import pathlib,sys,re,shutil,subprocess,hashlib,json
release,checksum=sys.argv[1:]
assert re.fullmatch(r'[0-9]{8}T[0-9]{6}Z',release) and re.fullmatch(r'[a-f0-9]{64}',checksum)
base=pathlib.Path('/opt/wisewolf/institucional');stage=base/'releases'/release
assert not stage.exists()
stage.mkdir(mode=0o700)
shutil.copytree(base/'src/dist',stage/'site',symlinks=True)
shutil.copy2(base/'nginx.conf',stage/'nginx.conf');shutil.copy2(base/'docker-compose.yml',stage/'docker-compose.yml')
script='<script data-ww-origin="1" src="https://system.wisewolflanguage.com.br/school-origin-tracking.js?v='+checksum[:12]+'"></script>'
files=list((stage/'site').rglob('*.html'));assert len(files)>=3000
before={};changed=0
for p in files:
 assert not p.is_symlink()
 original=p.read_text();updated=re.sub(r'<script\b[^>]*data-ww-origin="1"[^>]*></script>','',original)
 assert '</head>' in updated,p
 assert re.search(r'<head(?:\s[^>]*)?>',updated),p
 # Install fetch capture before deferred/module bundles bind their fetch client.
 updated=re.sub(r'(<head(?:\s[^>]*)?>)',lambda match:match.group(1)+script,updated,count=1)
 before[str(p.relative_to(stage/'site'))]=hashlib.sha256(original.encode()).hexdigest()
 p.write_text(updated);changed+=1
(stage/'origin-tracking-provenance.json').write_text(json.dumps({'release':release,'tracker_sha256':checksum,'pages':changed,'previous_page_hashes':before}))
subprocess.run([str(base/'activate-release.sh'),release],check=True)
print('Institutional first-party origin tracking published:',release,'pages:',changed)
PY
