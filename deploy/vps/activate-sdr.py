#!/usr/bin/env python3
"""Activate an immutable, scoped SDR package on the VPS, with backup and rollback.
The manifest must contain reviewed baseline hashes; this script never deploys
unlisted files and never prints credentials, database content or provider bodies.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

os.umask(0o077)
stage = Path(sys.argv[1]).resolve()
if not re.fullmatch(r"/opt/wisewolf/releases/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}", str(stage)):
    raise SystemExit("invalid_stage")
manifest = json.loads((stage / "sdr-manifest.json").read_text())
base = Path('/opt/wisewolf/supabase-docker/volumes/functions')
backup = Path('/opt/wisewolf/backups') / ('sdr-' + stage.name)
lock = open('/opt/wisewolf/releases/.deploy.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
allowed = {
    'whatsapp-inbound/index.ts', 'whatsapp-inbound/sdr-work.ts',
    'whatsapp-inbound/sdr-conversation.ts', 'whatsapp-inbound/holidays.ts',
    'whatsapp-inbound/billing-method-intent.ts', '_shared/trial-timeout.ts',
    'funnel-sweeper/index.ts', 'sdr-followups/index.ts',
}
if set(manifest['files']) != allowed:
    raise SystemExit('invalid_file_scope')
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
for relative, expected in manifest['files'].items():
    if digest(stage / 'functions' / relative) != expected['sha256']:
        raise SystemExit('artifact_changed:' + relative)
    if digest(base / relative) != expected['baseline']:
        raise SystemExit('remote_drift:' + relative)
markers = Path('/opt/wisewolf/releases/.migration-checksums')
for name, checksum in manifest['migrations'].items():
    if not re.fullmatch(r'[0-9]{14}_[a-z0-9_]+\.sql', name):
        raise SystemExit('invalid_migration_name')
    if digest(stage / 'migrations' / name) != checksum:
        raise SystemExit('migration_artifact_changed')
    for marker in markers.glob(name[:14] + '-*.sha256'):
        if marker.name != name[:14] + '-' + checksum + '.sha256':
            raise SystemExit('migration_checksum_conflict')
backup.mkdir(parents=True, exist_ok=False)
shutil.copy2(stage / 'sdr-manifest.json', backup / 'sdr-manifest.json')

def sql(text, check=True):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase-db', 'psql', '-U',
        'supabase_admin', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'],
        input=text.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with open(backup / 'database-operations.log', 'ab') as log:
        log.write(result.stderr)
    if check and result.returncode:
        raise RuntimeError('database_operation_failed')
    return result.stdout.decode().strip()

print('Backing up database and reviewed runtime files.', flush=True)
with open(backup / 'postgres-before.dump', 'wb') as dump:
    subprocess.run(['docker', 'exec', 'supabase-db', 'pg_dump', '-U', 'supabase_admin',
        '-d', 'postgres', '-Fc', '--no-owner', '--no-privileges'], stdout=dump, check=True)
with open(backup / 'postgres-before.dump', 'rb') as dump:
    subprocess.run(['docker', 'exec', '-i', 'supabase-db', 'pg_restore', '--list'],
        stdin=dump, stdout=subprocess.DEVNULL, check=True)
for relative in allowed:
    if (base / relative).exists():
        target = backup / 'functions' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(base / relative, target)
original_expiry = sql("select pg_get_functiondef('public.expire_trial_opportunity_atomic(text,uuid)'::regprocedure);")
(backup / 'original-expiration.sql').write_text(original_expiry)
original_schedule = sql("select schedule from cron.job where jobname='wisewolf-funnel-sweeper';")
(backup / 'original-schedule.txt').write_text(original_schedule)
(backup / 'pending-requests.json').write_text(sql("select coalesce(jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'created_at',created_at)),'[]') from public.trial_reschedule_requests where status='PENDING';"))
for relative, expected in manifest['files'].items():
    if digest(base / relative) != expected['baseline']:
        raise SystemExit('remote_changed_during_backup')
checksum = hashlib.sha256((stage / 'sdr-manifest.json').read_bytes()).hexdigest()
stopped = False
committed = False
swapped = False

def smoke(path, expected):
    request = urllib.request.Request('https://api.wisewolflanguage.com.br/functions/v1/' + path,
        data=b'{}', headers={'Content-Type':'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    if status != expected:
        raise RuntimeError('runtime_smoke_failed:' + path.split('?')[0] + ':' + str(status))

try:
    print('Activating database changes and the three SDR services.', flush=True)
    subprocess.run(['docker','stop','-t','30','supabase-edge-functions'], stdout=subprocess.DEVNULL, check=True)
    stopped = True
    migrations = '\n'.join((stage / 'migrations' / n).read_text() for n in sorted(manifest['migrations']))
    transaction = "begin; select pg_advisory_xact_lock(982451653,1431655765);\n" + migrations
    transaction += f"\ninsert into private.release_commit_journal(release_id,release_manifest_checksum,release_state,committed_at) values('{stage.name}','{checksum}','COMMITTED',clock_timestamp());\ncommit;"
    sql(transaction, check=False)
    outcome = sql(f"select release_state from private.release_commit_journal where release_id='{stage.name}' and release_manifest_checksum='{checksum}';")
    if outcome != 'COMMITTED':
        raise RuntimeError('database_not_committed')
    committed = True
    # Shared/new modules first; old workers are stopped throughout the promotion.
    swapped = True
    for relative in sorted(allowed, key=lambda x: x.endswith('/index.ts')):
        destination = base / relative
        temporary = destination.with_name(destination.name + '.sdr-next')
        shutil.copy2(stage / 'functions' / relative, temporary)
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    subprocess.run(['docker','start','supabase-edge-functions'], stdout=subprocess.DEVNULL, check=True)
    stopped = False
    time.sleep(3)
    for path, expected in [('whatsapp-inbound?worker=sdr',403),('whatsapp-inbound',403),
                           ('funnel-sweeper',403),('sdr-followups',403)]:
        smoke(path, expected)
    for relative, expected in manifest['files'].items():
        if digest(base / relative) != expected['sha256']:
            raise RuntimeError('active_artifact_mismatch')
    schedules = sql("select jobname||':'||schedule||':'||active from cron.job where jobname in ('wisewolf-funnel-sweeper','wisewolf-sdr-work') order by jobname;")
    if 'wisewolf-funnel-sweeper:*/5 * * * *:true' not in schedules or 'wisewolf-sdr-work:* * * * *:true' not in schedules:
        raise RuntimeError('cron_verification_failed')
    markers.mkdir(exist_ok=True)
    for name, migration_checksum in manifest['migrations'].items():
        (markers / (name[:14] + '-' + migration_checksum + '.sha256')).write_text(migration_checksum + '\n')
    # Update only reviewed functions in the existing drift manifest.
    manifest_path = Path('/opt/wisewolf/releases/.published-functions.md5')
    lines = manifest_path.read_text().splitlines() if manifest_path.exists() else []
    current = {line.split()[1]: line.split()[0] for line in lines if len(line.split()) == 2}
    for name in ('whatsapp-inbound','funnel-sweeper','sdr-followups'):
        command = f"find '{base / name}' -type f -print0 | sort -z | xargs -0 md5sum | md5sum"
        current[name] = subprocess.check_output(['bash','-c',command]).decode().split()[0]
    temporary = manifest_path.with_suffix('.sdr-next')
    temporary.write_text(''.join(f'{hash_value} {name}\n' for name, hash_value in current.items()))
    os.replace(temporary, manifest_path)
    (backup / 'status.json').write_text(json.dumps({'status':'ACTIVE','release':stage.name,'verified_at':time.time()}))
    print('ACTIVE: ' + stage.name, flush=True)
    print('Backup: ' + str(backup), flush=True)
except BaseException:
    print('Activation failed; restoring prior runtime.', flush=True)
    if swapped:
        subprocess.run(['docker','stop','-t','15','supabase-edge-functions'], stdout=subprocess.DEVNULL)
        for relative in allowed:
            old = backup / 'functions' / relative
            if old.exists(): shutil.copy2(old, base / relative)
            elif (base / relative).exists(): (base / relative).unlink()
    if committed:
        # Additive queue schema remains, but its cron is disabled. Do not restore
        # the full database over new business records created after the backup.
        sql("select cron.unschedule(jobid) from cron.job where jobname='wisewolf-sdr-work';\n" + original_expiry +
            "\ndrop trigger if exists cap_trial_reschedule_deadline on public.trial_reschedule_requests;\n" +
            "alter table public.trial_reschedule_requests alter column expires_at set default(now()+interval '24 hours');\n" +
            "select cron.alter_job(jobid,schedule:='" + original_schedule.replace("'","''") + "') from cron.job where jobname='wisewolf-funnel-sweeper';", check=False)
    subprocess.run(['docker','start','supabase-edge-functions'], stdout=subprocess.DEVNULL)
    (backup / 'status.json').write_text(json.dumps({'status':'ROLLED_BACK_RUNTIME','database_committed':committed}))
    raise SystemExit('activation_failed; inspect protected backup logs')
