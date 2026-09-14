#!/usr/bin/env node
// Two real PostgreSQL sessions, ONLY inside the network-less finance QA
// container. A dedicated schema-only database is created and destroyed; the
// production container is never accessed and no provider calls are made.
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const container = 'wisewolf-finance-qa-20260914';
const database = 'prepayment_concurrency_qa_20260914';
const fixture = 'finance-prepayment-concurrency-20260914';
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'wisewolf-vps'];
const migrations = [
  'supabase/migrations/20260914100000_competencia_e_pagamento_completo.sql',
  'supabase/migrations/20260914195230_monthly_reserve_notification_outbox.sql',
  'supabase/migrations/20260914195606_prepayment_coverage_and_management.sql',
  'supabase/migrations/20260914200843_cancel_prepaid_invoice_intents.sql',
];
const student = '7e140001-0000-4000-8000-000000000011';
const payment = n => `7e140001-0000-4000-8000-0000000000a${n}`;
const tenant = 'prepayment-concurrency-qa';
const sessions = new Set();
let created = false;

function run(command, input, timeout = 30000) {
  const result = spawnSync('ssh', [...ssh, command], {
    input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error || 'QA command failed'));
  return result.stdout.trim();
}
function sql(source, db = database, timeout = 30000) {
  if (![database, 'postgres'].includes(db)) throw new Error('Unexpected QA database');
  return run(`docker exec -i ${container} psql -X -h /tmp -U postgres -d ${db} -qAt -v ON_ERROR_STOP=1`, source, timeout);
}
function assert(value, message) { if (!value) throw new Error(message); }
function assertIsolation() {
  assert(run(`docker inspect --format '{{index .Config.Labels "wisewolf.test_fixture"}} {{.HostConfig.NetworkMode}}' ${container}`)
    === 'finance-20260914 none', 'QA fixture/network guard failed');
  assert(sql("select current_setting('cron.launch_active_jobs');", 'postgres') === 'off', 'Cron must remain disabled');
}
function session(name) {
  assert(/^prepayment_qa_[a-z0-9_]+$/.test(name), 'Invalid session name');
  const proc = spawn('ssh', [...ssh,
    `docker exec -i ${container} psql -X -h /tmp -U postgres -d ${database} -qAt -v ON_ERROR_STOP=1`],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '', closed = false;
  const waiters = new Set();
  const done = new Promise(resolveDone => proc.on('close', code => {
    closed = true;
    for (const wake of waiters) wake();
    resolveDone(code);
  }));
  proc.stdout.on('data', chunk => { output += chunk; for (const wake of waiters) wake(); });
  proc.stderr.on('data', chunk => { error += chunk; });
  const client = {
    name,
    send(source) { proc.stdin.write(source + '\n'); },
    async expect(marker, timeout = 20000) {
      await new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => { waiters.delete(wake); rejectWait(new Error(`Timeout ${name}: ${marker}; ${error}`)); }, timeout);
        function wake() {
          if (output.includes(marker)) { clearTimeout(timer); waiters.delete(wake); resolveWait(); }
          else if (closed) { clearTimeout(timer); waiters.delete(wake); rejectWait(new Error(`Closed ${name}: ${marker}; ${error}`)); }
        }
        waiters.add(wake); wake();
      });
      return output;
    },
    async close() { proc.stdin.end('\\q\n'); assert(await done === 0, `${name} failed: ${error}`); sessions.delete(client); },
    abort() { proc.stdin.destroy(); proc.kill('SIGTERM'); sessions.delete(client); },
  };
  sessions.add(client);
  client.send(`set application_name='${name}'; set statement_timeout='20s'; set lock_timeout='15s'; set idle_in_transaction_session_timeout='20s';`);
  return client;
}
async function assertBlocked(waiter, holder) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const blocked = sql(`select exists(select 1 from pg_stat_activity waiting
      join pg_stat_activity holding on holding.pid=any(pg_blocking_pids(waiting.pid))
      where waiting.datname='${database}' and waiting.application_name='${waiter.name}'
        and holding.application_name='${holder.name}' and waiting.wait_event_type='Lock');`);
    if (blocked === 't') return;
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`${waiter.name} did not wait for ${holder.name}'s financial fence`);
}
function register(n, month) {
  return `public.register_prepayment('${payment(n)}','2001-${month}-01',2,'MENSAL')`;
}
function inbox(n) {
  return `insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash)
    values('evt_concurrency_qa_${n}','PAYMENT_PARTIALLY_REFUNDED','pay_concurrency_qa_${n}',now(),
      '{"payment":{"id":"pay_concurrency_qa_${n}","status":"REFUNDED"}}',repeat('e',64));`;
}
async function race(label, holderSql, waiterSql, assertionSql) {
  const a = session(`prepayment_qa_${label}_a`), b = session(`prepayment_qa_${label}_b`);
  a.send(`begin; ${holderSql} select 'QA_HOLDER_READY';`);
  await a.expect('QA_HOLDER_READY');
  b.send(`begin; ${waiterSql} commit; select 'QA_WAITER_DONE';`);
  await assertBlocked(b, a);
  a.send("commit; select 'QA_HOLDER_DONE';");
  await Promise.all([a.expect('QA_HOLDER_DONE'), b.expect('QA_WAITER_DONE')]);
  await Promise.all([a.close(), b.close()]);
  assert(sql(assertionSql) === 't', `${label}: financial invariant failed`);
  process.stdout.write(`PASS ${label}: observed PostgreSQL lock wait and checked committed invariant\n`);
}

try {
  assertIsolation();
  assert(sql(`select exists(select 1 from pg_database where datname='${database}');`, 'postgres') === 'f',
    'Dedicated QA database already exists; inspect it instead of overwriting');
  assert(sql("select (select count(*) from public.profiles)=0 and (select count(*) from auth.users)=0 and (select count(*) from vault.secrets)=0;", 'postgres') === 't',
    'Schema-only QA source must contain no profiles/auth users/secrets');
  // TEMPLATE postgres is occupied by the disabled scheduler's background
  // sessions. Dump only the QA schema, excluding pg_cron: no worker is stopped.
  run(`docker exec ${container} createdb -h /tmp -U postgres -T template0 ${database}`);
  created = true;
  sql(`comment on database ${database} is '${fixture}';`);
  const schema = run(`docker exec ${container} pg_dump -h /tmp -U postgres -d postgres --schema-only --no-owner --no-publications --no-subscriptions --exclude-extension=pg_cron --exclude-schema=cron`, undefined, 60000);
  sql(schema, database, 120000);
  const definitions = migrations.map(path => readFileSync(resolve(root, path), 'utf8')).join('\n');
  assert(!/^\s*(begin|commit|rollback)\s*;/im.test(definitions), 'Migration transaction envelope found');
  sql(`begin; set local statement_timeout='30s'; set local client_min_messages=warning;\n${definitions}\n${definitions}\ncommit;`, database, 120000);
  assert(sql("select not exists(select 1 from pg_extension where extname='pg_cron');") === 't', 'Dedicated test must have no scheduler extension');
  sql(`begin;
    insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
      ('default','QA signup default','qa-concurrency-default','active',false),
      ('school-wise-wolf','QA signup fallback','qa-concurrency-fallback','active',false),
      ('${tenant}','Concurrency QA','${tenant}','active',false) on conflict(id) do nothing;
    insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      values('${student}','authenticated','authenticated','prepayment-concurrency@example.invalid',
      '{"provider":"email","providers":["email"]}','{"full_name":"Concurrency Fixture"}',now(),now());
    set local app.enrollment_claim='1';
    update public.profiles set tenant_id='${tenant}',role='STUDENT',status='Ativo',lifecycle_status='active',
      status_financial='PENDING',is_test_account=true,test_fixture_key='${fixture}',monthly_fee=0
      where id='${student}';
    set local app.enrollment_claim='';
    delete from public.tenant_memberships where user_id='${student}';
    insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
      values('${student}','${tenant}','STUDENT','ACTIVE',true);
    insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,due_date,payment_date,paid_at,payment_type,description)
      values ${['01','03','05','07'].map((month,index) => `('${payment(index+1)}','${tenant}','${student}','pay_concurrency_qa_${index+1}',600,'RECEIVED','RECEIVED',
        '2001-${month}-01','2001-${month}-01','2001-${month}-01 12:00:00+00','SUBSCRIPTION','Isolated concurrency fixture')`).join(',')};
    commit;`);

  await race('refund_then_register',
    `update public.student_payments set refunded_amount=50 where id='${payment(1)}';`,
    `do $$begin if (${register(1,'01')}->>'error') is distinct from 'pagamento_requer_revisao' then raise exception 'refund not reread'; end if; end$$;`,
    `select coalesce(refunded_amount,0)=50 and not exists(select 1 from public.student_payment_allocations where payment_id='${payment(1)}')
      from public.student_payments where id='${payment(1)}';`);
  await race('register_then_refund',
    `do $$begin if (${register(2,'03')}->>'ok') is distinct from 'true' then raise exception 'registration failed'; end if; end$$;`,
    `update public.student_payments set refunded_amount=50 where id='${payment(2)}';`,
    `select count(*)=2 and bool_and(status='REVIEW' and not private.prepayment_allocation_is_valid(id))
      and (select count(*)=2 from private.prepayment_allocation_events where payment_id='${payment(2)}' and event_type='REVIEW')
      from public.student_payment_allocations where payment_id='${payment(2)}';`);
  await race('inbox_then_register',
    inbox(3),
    `do $$begin if (${register(3,'05')}->>'error') is distinct from 'pagamento_requer_revisao' then raise exception 'inbox not reread'; end if; end$$;`,
    `select not exists(select 1 from public.student_payment_allocations where payment_id='${payment(3)}')
      and private.prepayment_payment_review_reason('${payment(3)}')='PAYMENT_PROVIDER_OBSERVATION_REVIEW';`);
  const versionBefore = Number(sql(`select version from private.prepayment_financial_recompute_queue where tenant_id='${tenant}' and student_id='${student}';`));
  await race('register_then_inbox',
    `do $$begin if (${register(4,'07')}->>'ok') is distinct from 'true' then raise exception 'registration failed'; end if; end$$;`,
    inbox(4),
    `select count(*)=2 and bool_and(status='ACTIVE' and not private.prepayment_allocation_is_valid(id))
      and (select version=${versionBefore+3} from private.prepayment_financial_recompute_queue where tenant_id='${tenant}' and student_id='${student}')
      and (select status='RECEIVED' and coalesce(refunded_amount,0)=0 from public.student_payments where id='${payment(4)}')
      from public.student_payment_allocations where payment_id='${payment(4)}';`);
  assert(sql(`set request.jwt.claims='{"role":"service_role"}';
    select public.recompute_student_financial_status('${tenant}','${student}')->>'status';`) === 'PENDING',
  'Inbox-only refund must leave access PENDING without manufacturing a source refund');
  process.stdout.write('PASS inbox-only observation: PENDING access without source/payment mutation\n');
} finally {
  for (const active of sessions) active.abort();
  if (created) {
    assertIsolation();
    assert(sql(`select shobj_description(oid,'pg_database')='${fixture}' from pg_database where datname='${database}';`, 'postgres') === 't',
      'Refusing cleanup: dedicated database fixture marker mismatch');
    run(`docker exec ${container} dropdb -h /tmp -U postgres --force ${database}`);
    assert(sql(`select not exists(select 1 from pg_database where datname='${database}');`, 'postgres') === 't', 'QA database cleanup not confirmed');
    process.stdout.write(`CLEANUP removed dedicated fixture database ${database}; shared QA and production untouched\n`);
  }
}
