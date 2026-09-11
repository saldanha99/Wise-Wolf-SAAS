#!/usr/bin/env python3
"""Publish a reviewed SDR/CRM package without changing unrelated live services.

Run on the VPS with an immutable quality-manifest.json and exact baseline hashes.
The migration is additive. Runtime rollback preserves the existing SDR queue and
60-minute deadline; it never restores the full DB over new customer activity.
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
import traceback
import urllib.error
import urllib.request

os.umask(0o077)
stage = Path(sys.argv[1]).resolve()
if not re.fullmatch(r'/opt/wisewolf/releases/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}', str(stage)):
    raise SystemExit('invalid_stage')
manifest = json.loads((stage / 'quality-manifest.json').read_text())
runtime = Path('/opt/wisewolf/supabase-docker/volumes/functions')
frontend = Path('/opt/wisewolf/frontend/src/dist')
releases = Path('/opt/wisewolf/releases')
backup = Path('/opt/wisewolf/backups') / ('sdr-quality-' + stage.name)
allowed = {
    'whatsapp-inbound/index.ts', 'whatsapp-inbound/sdr-work.ts',
    'whatsapp-inbound/sdr-conversation.ts', 'whatsapp-inbound/holidays.ts',
    'whatsapp-inbound/billing-method-intent.ts', '_shared/trial-timeout.ts',
    '_shared/sdr-scheduling.ts', '_shared/sdr-lifecycle.ts',
    '_shared/sdr-teacher-reminders.ts', 'funnel-sweeper/index.ts',
    'sdr-followups/index.ts',
}
if set(manifest['files']) != allowed:
    raise SystemExit('invalid_runtime_scope')
if set(manifest['migrations']) != {'20260906165120_sdr_attention_quality_and_slots.sql'}:
    raise SystemExit('invalid_migration_scope')
lock = open(releases / '.deploy.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def digest(path):
    if path.is_symlink():
        raise RuntimeError('symlink_not_allowed')
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def tree_digest(root):
    rows = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('symlink_not_allowed')
        if path.is_file():
            rows.append(str(path.relative_to(root)) + ':' + digest(path))
    return hashlib.sha256('\n'.join(rows).encode()).hexdigest()


def validate():
    for name, expected in manifest['files'].items():
        if digest(stage / 'functions' / name) != expected['sha256']:
            raise RuntimeError('package_changed:' + name)
        if digest(runtime / name) != expected['baseline']:
            raise RuntimeError('runtime_drift:' + name)
    if tree_digest(frontend) != manifest['frontend']['baseline']:
        raise RuntimeError('frontend_drift')
    if tree_digest(stage / 'frontend-dist') != manifest['frontend']['sha256']:
        raise RuntimeError('frontend_package_changed')
    if (releases / 'current').read_text().strip() != manifest['base_release']:
        raise RuntimeError('concurrent_release')
    for name, checksum in manifest['migrations'].items():
        if digest(stage / 'migrations' / name) != checksum:
            raise RuntimeError('migration_changed')
        for marker in (releases / '.migration-checksums').glob(name[:14] + '-*.sha256'):
            if marker.name != name[:14] + '-' + checksum + '.sha256':
                raise RuntimeError('migration_history_conflict')


validate()
backup.mkdir(parents=True, exist_ok=False)
shutil.copy2(stage / 'quality-manifest.json', backup / 'quality-manifest.json')
log = open(backup / 'activation.log', 'ab')


def command(args, **kwargs):
    return subprocess.run(args, stdout=log, stderr=log, check=True, **kwargs)


def sql(statement):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase-db', 'psql', '-X',
                             '-U', 'supabase_admin', '-d', 'postgres', '-At',
                             '-v', 'ON_ERROR_STOP=1'], input=statement.encode(),
                            stdout=subprocess.PIPE, stderr=log)
    if result.returncode:
        raise RuntimeError('database_operation_failed')
    return result.stdout.decode().strip()


def http(path, expected, post=False):
    req = urllib.request.Request(path, data=b'{}' if post else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            status = response.status
            body = response.read() if not post else b''
    except urllib.error.HTTPError as error:
        status, body = error.code, b''
    if status != expected:
        raise RuntimeError('http_verification_failed:' + str(status))
    return body


print('Validating backup and preparing frontend.', flush=True)
with open(backup / 'postgres-before.dump', 'wb') as dump:
    subprocess.run(['docker', 'exec', 'supabase-db', 'pg_dump', '-U', 'supabase_admin',
                    '-d', 'postgres', '-Fc', '--no-owner', '--no-privileges'],
                   stdout=dump, stderr=log, check=True)
with open(backup / 'postgres-before.dump', 'rb') as dump:
    command(['docker', 'exec', '-i', 'supabase-db', 'pg_restore', '--list'], stdin=dump)
for name in allowed:
    if (runtime / name).exists():
        target = backup / 'functions' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(runtime / name, target)
shutil.copy2(releases / 'current', backup / 'previous-current')
shutil.copy2(releases / '.published-functions.md5', backup / 'previous-functions.md5')
next_frontend = frontend.with_name('dist-sdr-quality-next')
if next_frontend.exists():
    raise SystemExit('stale_frontend_stage')
shutil.copytree(stage / 'frontend-dist', next_frontend)
for path in next_frontend.rglob('*'):
    path.chmod(0o755 if path.is_dir() else 0o644)
next_frontend.chmod(0o755)
validate()
swapped_frontend = False
swapped_runtime = False
database_committed = False
checksum = digest(stage / 'quality-manifest.json')
try:
    print('Publishing database, SDR services and CRM panel.', flush=True)
    command(['docker', 'stop', '-t', '30', 'supabase-edge-functions'])
    migration = '\n'.join((stage / 'migrations' / name).read_text() for name in sorted(manifest['migrations']))
    transaction = "begin; select pg_advisory_xact_lock(982451653,1431655765);\n" + migration
    transaction += f"\ninsert into private.release_commit_journal(release_id,release_manifest_checksum,release_state,committed_at) values('{stage.name}','{checksum}','COMMITTED',clock_timestamp());\ncommit;"
    try:
        sql(transaction)
    except RuntimeError:
        # A connection loss after COMMIT is resolved through the journal.
        if sql(f"select release_state from private.release_commit_journal where release_id='{stage.name}' and release_manifest_checksum='{checksum}'") != 'COMMITTED':
            raise
    database_committed = True
    swapped_runtime = True
    for name in sorted(allowed, key=lambda name: name.endswith('/index.ts')):
        target = runtime / name
        temporary = target.with_name(target.name + '.quality-next')
        shutil.copy2(stage / 'functions' / name, temporary)
        temporary.chmod(0o644)
        os.replace(temporary, target)
    command(['docker', 'start', 'supabase-edge-functions'])
    for endpoint in ('whatsapp-inbound', 'whatsapp-inbound?worker=sdr', 'funnel-sweeper', 'sdr-followups'):
        # The proxy can be ready before the restarted runtime opens its socket.
        for attempt in range(6):
            try:
                http('https://api.wisewolflanguage.com.br/functions/v1/' + endpoint, 403, post=True)
                break
            except (RuntimeError, urllib.error.URLError) as error:
                log.write(f'Runtime smoke {endpoint}: {error}\n'.encode())
                log.flush()
                if attempt == 5:
                    raise
                time.sleep(2)
    command(['docker', 'compose', 'stop', 'frontend'], cwd='/opt/wisewolf/frontend')
    frontend.rename(backup / 'frontend-dist')
    swapped_frontend = True
    next_frontend.rename(frontend)
    command(['docker', 'compose', 'up', '-d', '--force-recreate', 'frontend'], cwd='/opt/wisewolf/frontend')
    # Cold Nginx startup can briefly return 502. Retry only the read-only smoke.
    for attempt in range(5):
        try:
            html = http('https://system.wisewolflanguage.com.br/', 200)
            break
        except (RuntimeError, urllib.error.URLError):
            if attempt == 4:
                raise
            time.sleep(2)
    for asset in re.findall(rb'(?:src|href)="(/assets/[^" ]+\.(?:js|css))"', html):
        relative = asset.decode().lstrip('/')
        served = http('https://system.wisewolflanguage.com.br/' + relative, 200)
        if hashlib.sha256(served).hexdigest() != digest(frontend / relative):
            raise RuntimeError('served_asset_mismatch')
    if tree_digest(frontend) != manifest['frontend']['sha256']:
        raise RuntimeError('published_frontend_mismatch')
    for name, expected in manifest['files'].items():
        if digest(runtime / name) != expected['sha256']:
            raise RuntimeError('published_runtime_mismatch')
    current = {}
    for line in (releases / '.published-functions.md5').read_text().splitlines():
        if len(line.split()) == 2:
            value, name = line.split()
            current[name] = value
    for name in ('whatsapp-inbound', 'funnel-sweeper', 'sdr-followups'):
        cmd = f"find '{runtime / name}' -type f -print0 | sort -z | xargs -0 md5sum | md5sum"
        current[name] = subprocess.check_output(['bash', '-c', cmd]).decode().split()[0]
    temporary = releases / '.quality-functions-next'
    temporary.write_text(''.join(f'{value} {name}\n' for name, value in current.items()))
    os.replace(temporary, releases / '.published-functions.md5')
    markers = releases / '.migration-checksums'
    markers.mkdir(exist_ok=True)
    for name, value in manifest['migrations'].items():
        (markers / (name[:14] + '-' + value + '.sha256')).write_text(value + '\n')
    temporary = releases / '.quality-current-next'
    temporary.write_text(stage.name + '\n')
    os.replace(temporary, releases / 'current')
    (backup / 'status.json').write_text(json.dumps({'status': 'ACTIVE', 'release': stage.name, 'verified_at': time.time()}))
    print('ACTIVE: ' + stage.name, flush=True)
    print('Backup: ' + str(backup), flush=True)
except BaseException:
    log.write(traceback.format_exc().encode())
    log.flush()
    print('Activation failed; restoring the prior runtime and frontend.', flush=True)
    if swapped_runtime:
        command(['docker', 'stop', '-t', '15', 'supabase-edge-functions'])
        for name in allowed:
            old = backup / 'functions' / name
            if old.exists():
                shutil.copy2(old, runtime / name)
            elif (runtime / name).exists():
                (runtime / name).unlink()
    if swapped_frontend:
        command(['docker', 'compose', 'stop', 'frontend'], cwd='/opt/wisewolf/frontend')
        if frontend.exists():
            frontend.rename(backup / 'failed-frontend-dist')
        (backup / 'frontend-dist').rename(frontend)
        command(['docker', 'compose', 'up', '-d', '--force-recreate', 'frontend'], cwd='/opt/wisewolf/frontend')
    command(['docker', 'start', 'supabase-edge-functions'])
    shutil.copy2(backup / 'previous-current', releases / 'current')
    shutil.copy2(backup / 'previous-functions.md5', releases / '.published-functions.md5')
    (backup / 'status.json').write_text(json.dumps({'status': 'ROLLED_BACK_RUNTIME', 'database_committed': database_committed}))
    raise SystemExit('activation_failed; inspect protected backup logs')
