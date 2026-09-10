import fcntl, hashlib, json, os, shutil, subprocess, time, urllib.request, urllib.error
from pathlib import Path
os.umask(0o077)
stage = Path(__file__).resolve().parent
runtime = Path('/opt/wisewolf/supabase-docker/volumes/functions/whatsapp-inbound')
releases = Path('/opt/wisewolf/releases')
lock = open(releases / '.deploy.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
manifest = json.loads((stage/'manifest.json').read_text())
assert set(manifest) == {'index.ts','commercial-response-policy.ts','wise-wolf-lead-training.ts'}
def digest(p):
    assert not p.is_symlink()
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
for name, hashes in manifest.items():
    assert digest(runtime/name) == hashes['baseline'], 'runtime_drift:'+name
    assert digest(stage/name) == hashes['sha256'], 'package_drift:'+name
backup = Path('/opt/wisewolf/backups')/stage.name
backup.mkdir(exist_ok=False)
for name in manifest:
    if (runtime/name).exists(): shutil.copy2(runtime/name, backup/name)
marker = releases/'.published-functions.md5'
shutil.copy2(marker, backup/'published-functions.md5')
shutil.copy2(stage/'manifest.json', backup/'manifest.json')
def command(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def smoke():
    for endpoint in ['whatsapp-inbound', 'whatsapp-inbound?worker=sdr']:
        for attempt in range(8):
            status = None
            try:
                request = urllib.request.Request('https://api.wisewolflanguage.com.br/functions/v1/'+endpoint, data=b'{}', headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(request, timeout=5) as response: status=response.status
            except urllib.error.HTTPError as error: status=error.code
            except (urllib.error.URLError, TimeoutError): pass
            if status == 403: break
            if attempt == 7: raise RuntimeError('smoke_failed:'+endpoint+':'+str(status))
            time.sleep(2)
        print('Verified endpoint: '+endpoint+' (403, unauthorized request rejected)', flush=True)
changed = False
try:
    command(['docker','stop','-t','30','supabase-edge-functions'])
    changed = True
    for name in sorted(manifest, key=lambda n:n=='index.ts'):
        destination=runtime/name
        temporary=runtime/(name+'.lead-policy-next')
        shutil.copy2(stage/name, temporary)
        temporary.chmod(0o644)
        os.replace(temporary,destination)
    command(['docker','start','supabase-edge-functions'])
    smoke()
    for name, hashes in manifest.items(): assert digest(runtime/name)==hashes['sha256']
    # Same path-sensitive algorithm used by the standard release guard; update only this function.
    row=subprocess.check_output(['bash','-c', 'find "$1" -type f -print0 | sort -z | xargs -0 md5sum | md5sum', '_',str(runtime)+'/'],text=True).split()[0]+' whatsapp-inbound'
    rows=marker.read_text().splitlines()
    rows=[line for line in rows if line.split()[-1]!='whatsapp-inbound']+[row]
    temporary=marker.with_name(marker.name+'.lead-policy-next')
    temporary.write_text('\n'.join(rows)+'\n')
    os.replace(temporary,marker)
    (stage/'SUCCESS').write_text('Published and verified\n')
    print('Published 3 files; checksums verified; backup: '+str(backup),flush=True)
except BaseException:
    if changed:
        command(['docker','stop','-t','15','supabase-edge-functions'])
        for name in manifest:
            if (backup/name).exists(): shutil.copy2(backup/name,runtime/name)
            else: (runtime/name).unlink(missing_ok=True)
        shutil.copy2(backup/'published-functions.md5',marker)
        command(['docker','start','supabase-edge-functions'])
        print('Previous runtime restored.',flush=True)
    raise
