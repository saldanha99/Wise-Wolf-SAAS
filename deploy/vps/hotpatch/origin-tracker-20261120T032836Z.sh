#!/usr/bin/env bash
# Hotpatch 2026-11-20T03:28:36Z: published only public/school-origin-tracking.js (commit e26c05a)
# on system.wisewolflanguage.com.br, without release.sh, so nothing else from this branch went live.
#   before: sha256 647c488147b9… (backup in /opt/wisewolf/backups/origin-tracker-20261120T032836Z/)
#   after:  sha256 cada0a1e7aee…
# The institutional site was then republished (release 20261120T032952Z) to pick up the new file.
#
#   bash origin-tracker-20261120T032836Z.sh publish    # what was run
#   bash origin-tracker-20261120T032836Z.sh rollback   # restore the previous tracker file
set -Eeuo pipefail
host="${DEPLOY_SSH_HOST:-wisewolf-vps}"
dist=/opt/wisewolf/frontend/src/dist
backup=/opt/wisewolf/backups/origin-tracker-20261120T032836Z
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"

case "${1:-}" in
  publish)
    asset="$root/public/school-origin-tracking.js"
    sum=$(shasum -a 256 "$asset" | awk '{print $1}')
    ssh -o BatchMode=yes "$host" "set -e; mkdir -p $backup; [ -e $backup/school-origin-tracking.js ] || cp -p $dist/school-origin-tracking.js $backup/;
      t=$dist/.school-origin-tracking.js.new; cat > \$t; chown 501:staff \$t; chmod 644 \$t;
      echo '$sum  '\$t | sha256sum -c; mv -f \$t $dist/school-origin-tracking.js" < "$asset"
    ;;
  rollback)
    ssh -o BatchMode=yes "$host" "set -e; t=$dist/.school-origin-tracking.js.new; cp -p $backup/school-origin-tracking.js \$t;
      echo '647c488147b9da2564d2708f3c75fa19c8fcb3b6b2c23cd3a13c2c33ffd86345  '\$t | sha256sum -c; mv -f \$t $dist/school-origin-tracking.js"
    echo "Tracker restored. Republish the institutional site (or activate its previous release) to reference it again."
    ;;
  *) echo "usage: $0 publish|rollback" >&2; exit 2 ;;
esac
curl -fsS https://system.wisewolflanguage.com.br/school-origin-tracking.js | shasum -a 256
