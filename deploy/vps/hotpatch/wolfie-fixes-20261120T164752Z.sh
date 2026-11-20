#!/usr/bin/env bash
# Isolated publication of 4067410 (Wolfie: microphone notice, quick start opens the conversation tutor,
# live voice does not reuse a classic conversation): frontend dist + wolfie-brain (index.ts, realtime-transport.ts).
# No migration, no other function, no container restart.
#   bash wolfie-fixes-20261120T164752Z.sh publish <local-dist-dir> <repo-dir>   # backup + publish
#   bash wolfie-fixes-20261120T164752Z.sh rollback                             # restore the backup
set -euo pipefail
host=${DEPLOY_SSH_HOST:-leiprova-vps}
backup=/opt/wisewolf/backups/wolfie-fixes-20261120T164752Z
dist=/opt/wisewolf/frontend/src/dist
fn=/opt/wisewolf/supabase-docker/volumes/functions/wolfie-brain
case "${1:-}" in
  publish)
    local_dist=$2; repo=$3
    ssh -o BatchMode=yes "$host" "set -e; mkdir -p $backup/fn; [ -d $backup/frontend-dist ] || cp -a $dist $backup/frontend-dist;
      [ -e $backup/fn/index.ts ] || cp -p $fn/index.ts $backup/fn/; rm -rf $backup/stage; mkdir -p $backup/stage/dist $backup/stage/fn"
    tar -C "$local_dist" -cf - . | ssh -o BatchMode=yes "$host" "tar -C $backup/stage/dist -xf -"
    tar -C "$repo/supabase/functions/wolfie-brain" -cf - index.ts realtime-transport.ts realtime-transport.test.ts |
      ssh -o BatchMode=yes "$host" "tar -C $backup/stage/fn -xf -"
    ssh -o BatchMode=yes "$host" "set -e; chmod -R a+rX $backup/stage;
      rsync -a --exclude index.html $backup/stage/dist/ $dist/; cp -p $backup/stage/dist/index.html $dist/index.html;
      rsync -a --delete $backup/stage/dist/ $dist/;
      cp -p $backup/stage/fn/realtime-transport.ts $backup/stage/fn/realtime-transport.test.ts $fn/;
      cp -p $backup/stage/fn/index.ts $fn/.index.ts.new; mv $fn/.index.ts.new $fn/index.ts;
      find $dist -type f | wc -l; sha256sum $fn/index.ts"
    ;;
  rollback)
    ssh -o BatchMode=yes "$host" "set -e; rsync -a --delete $backup/frontend-dist/ $dist/;
      cp -p $backup/fn/index.ts $fn/.index.ts.new; mv $fn/.index.ts.new $fn/index.ts;
      rm -f $fn/realtime-transport.ts $fn/realtime-transport.test.ts; sha256sum $fn/index.ts"
    ;;
  *) echo "usage: $0 publish <local-dist> <repo>|rollback" >&2; exit 2 ;;
esac
