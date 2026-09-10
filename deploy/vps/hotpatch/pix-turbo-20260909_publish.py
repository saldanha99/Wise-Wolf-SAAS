import fcntl,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path
stage=Path(sys.argv[1]);front=Path('/opt/wisewolf/frontend/src/dist');backup=Path('/opt/wisewolf/backups/pix-turbo-ui-20260909')
os.umask(0o077)
lock=open('/opt/wisewolf/releases/.deploy.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
m=json.loads((stage/'manifest.json').read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
for n,h in m['baseline'].items():assert sha(front/n)==h,'frontend changed: '+n
for n,h in m['files'].items():assert sha(stage/n)==h,'package changed: '+n
backup.mkdir(exist_ok=False)
# Pause frontend while replacing the small package; always restart on failure.
subprocess.run(['docker','compose','stop','frontend'],cwd='/opt/wisewolf/frontend',check=True,stdout=subprocess.DEVNULL)
written=[]
try:
 for n in m['files']:
  p=front/n
  if p.exists():
   b=backup/n;b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,b)
  temp=p.with_suffix(p.suffix+'.next');shutil.copy2(stage/n,temp);temp.chmod(0o644);os.replace(temp,p);written.append(n)
except Exception:
 for n in written:
  if (backup/n).exists():shutil.copy2(backup/n,front/n)
  else:(front/n).unlink()
 raise
finally:
 subprocess.run(['docker','compose','up','-d','--force-recreate','frontend'],cwd='/opt/wisewolf/frontend',check=True,stdout=subprocess.DEVNULL)
print('Scoped Pix/Turbo UI published; backup: '+str(backup))
