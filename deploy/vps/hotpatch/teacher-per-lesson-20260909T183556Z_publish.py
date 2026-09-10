import fcntl, hashlib, json, os, shutil, subprocess, sys, time, urllib.request
from pathlib import Path
os.umask(0o077)
stage=Path(sys.argv[1]).resolve()
assert stage.parent == Path('/opt/wisewolf/releases') and stage.name.startswith('teacher-per-lesson-')
front=Path('/opt/wisewolf/frontend/src/dist')
runtime=Path('/opt/wisewolf/supabase-docker/volumes/functions')
backup=Path('/opt/wisewolf/backups')/stage.name
lock=open('/opt/wisewolf/releases/.deploy.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
def run(args,**kw):return subprocess.run(args,check=True,**kw)
def sql(s):return subprocess.check_output(['docker','exec','-i','supabase-db','psql','-U','supabase_admin','-d','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1'],input=s.encode()).decode().strip()
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
man=json.loads((stage/'manifest.json').read_text())
for name,sha in man['baseline'].items():assert digest(front/name)==sha, 'frontend drift: '+name
for name,sha in man['runtime'].items():assert digest(runtime/name)==sha,'runtime drift: '+name
for name,sha in man['package'].items():assert digest(stage/name)==sha,'package changed: '+name
backup.mkdir(exist_ok=False)
(backup/'offer-before.json').write_text(sql("select row_to_json(o) from public.offers o where id='c55c30ad-f9e2-45c5-a827-fb6da92bab85'"))
(backup/'rate-function-before.sql').write_text(sql("select pg_get_functiondef('public.teacher_student_rate(uuid,uuid,date)'::regprocedure)")+ ';')
for name in man['runtime']:
 p=backup/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(runtime/name,p)
next_front=front.with_name('dist-teacher-per-lesson-next')
assert not next_front.exists()
# Hard links preserve the large unchanged media; unlink each overlaid file first.
shutil.copytree(front,next_front,copy_function=os.link)
for p in (stage/'frontend').rglob('*'):
 if p.is_file():
  dest=next_front/p.relative_to(stage/'frontend');dest.parent.mkdir(parents=True,exist_ok=True)
  if dest.exists():dest.unlink()
  shutil.copy2(p,dest);dest.chmod(0o644)
for p in next_front.rglob('*'):
 if p.is_dir():p.chmod(0o755)
next_front.chmod(0o755)
patches={
 'register-teacher/index.ts':[
 ('    const body = await requestBody(req);','    const body = await requestBody(req);\n    if (body.rateUnit !== "PER_LESSON") {\n      return json({ error: "Atualize a pagina para revisar o valor por aula antes de assinar." }, 409);\n    }'),
 ('commercial_snapshot: { hourlyRate, subject },','commercial_snapshot: { hourlyRate, subject, rateUnit: "PER_LESSON" },')],
 'tenant-legal-assets/index.ts': [('hourly_rate: commercial.hourlyRate,','hourly_rate: commercial.hourlyRate,\n    rateUnit: commercial.rateUnit,')]
}
for name,pairs in patches.items():
 s=(runtime/name).read_text()
 for a,b in pairs:assert s.count(a)==1;s=s.replace(a,b)
 dest=stage/'functions'/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(s)
run(['docker','stop','-t','20','supabase-edge-functions'],stdout=subprocess.DEVNULL)
try:
 migration=(stage/'migration.sql').read_text()
 sql("BEGIN; select pg_advisory_xact_lock(982451653,1431655765);\n"+migration+"""
DO $$ DECLARE n integer; BEGIN
 UPDATE public.offers SET payload=jsonb_set(payload,'{hourlyRate}','8'::jsonb)
 WHERE id='c55c30ad-f9e2-45c5-a827-fb6da92bab85' AND kind='TEACHER_INVITE'
 AND consumed_at IS NULL AND revoked_at IS NULL AND invite_claim_token IS NULL
 AND (payload->>'hourlyRate')::numeric=16;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'invite_changed_during_release'; END IF;
END $$;
COMMIT;
""")
 for name in patches:
  temp=(runtime/name).with_suffix('.teacher-next');shutil.copy2(stage/'functions'/name,temp);temp.chmod(0o644);os.replace(temp,runtime/name)
 run(['docker','compose','stop','frontend'],cwd='/opt/wisewolf/frontend',stdout=subprocess.DEVNULL)
 front.rename(backup/'frontend-dist');next_front.rename(front)
 run(['docker','compose','up','-d','--force-recreate','frontend'],cwd='/opt/wisewolf/frontend',stdout=subprocess.DEVNULL)
finally:
 run(['docker','start','supabase-edge-functions'],stdout=subprocess.DEVNULL)
# Read-only smoke and transactional fixture test; never submit a real registration.
sql((stage/'tests.sql').read_text())
for attempt in range(10):
 try:
  data=urllib.request.urlopen('https://system.wisewolflanguage.com.br/teacher-onboarding?offer=c55c30ad-f9e2-45c5-a827-fb6da92bab85',timeout=15).read()
  assert data == (front/'index.html').read_bytes()
  break
 except Exception:
  if attempt==9:raise
  time.sleep(2)
assert sql("select payload->>'hourlyRate' from public.offers where id='c55c30ad-f9e2-45c5-a827-fb6da92bab85' and consumed_at is null")=='8'
(stage/'published.json').write_text(json.dumps({'published_at':time.time(),'backup':str(backup),'scope':'teacher per lesson rate','baseline_verified':len(man['baseline'])}))
print('Published teacher per-lesson rate; invitation remains unused; fixture tests passed.')
