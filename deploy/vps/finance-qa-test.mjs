#!/usr/bin/env node
// Runner limitado ao container efêmero criado pelo bootstrap, nunca supabase-db.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const container = 'wisewolf-finance-qa-20260914';
const fixtureLabel = 'finance-20260914';
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'wisewolf-vps'];
const check = spawnSync('ssh', [...ssh,
  `docker inspect --format '{{index .Config.Labels "wisewolf.test_fixture"}} {{.HostConfig.NetworkMode}}' ${container}`],
  { encoding: 'utf8', timeout: 20000 });
if (check.status !== 0 || check.stdout.trim() !== `${fixtureLabel} none`) {
  throw new Error('QA ausente ou isolamento inválido. Nenhum SQL foi executado.');
}

const migrations = [
  'supabase/migrations/20260914100000_competencia_e_pagamento_completo.sql',
  'supabase/migrations/20260914195230_monthly_reserve_notification_outbox.sql',
  'supabase/migrations/20260914195606_prepayment_coverage_and_management.sql',
  'supabase/migrations/20260914200843_cancel_prepaid_invoice_intents.sql',
  'supabase/migrations/20260914202244_corroborated_bound_payment_observation.sql',
  'supabase/migrations/20260914205041_private_asaas_payment_adjudication.sql',
  'supabase/migrations/20260914210351_unclassified_receipt_reporting.sql',
];
const tests = process.argv.slice(2);
if (!tests.length) throw new Error('Informe pelo menos um arquivo supabase/tests/*.sql.');
for (const test of tests) {
  if (!/^supabase\/tests\/[a-z0-9_]+\.sql$/.test(test)) throw new Error('Arquivo de teste fora do escopo.');
}
const definitions = migrations.map(path => {
  const sql = readFileSync(resolve(root, path), 'utf8');
  if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) throw new Error(`Envelope de migration inválido: ${path}`);
  return sql;
}).join('\n');

let failures = 0;
for (const test of tests) {
  const source = readFileSync(resolve(root, test), 'utf8');
  if (/^\s*commit\s*;/im.test(source)) throw new Error('Teste não pode confirmar uma transação.');
  const body = source.replace(/^\s*(begin|rollback)\s*;[^\n]*$/gim, '');
  const sql = `\nBEGIN;\nSET LOCAL statement_timeout='30s';\nSET LOCAL lock_timeout='5s';\n` +
    `SET LOCAL idle_in_transaction_session_timeout='45s';\nSET LOCAL client_min_messages=warning;\n` +
    definitions + '\n' + definitions + '\n' + body + '\nROLLBACK;\n';
  const run = spawnSync('ssh', [...ssh,
    `docker exec -i ${container} psql -X -h /tmp -U postgres -d postgres -v ON_ERROR_STOP=1 -q`],
    { input: sql, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(`${run.status === 0 ? 'PASS' : 'FAIL'} ${test}\n`);
  if (run.status !== 0) {
    failures++;
    process.stdout.write(run.stderr || String(run.error || 'Falha de execução'));
    process.stdout.write(run.stdout.slice(-5000));
  }
}
process.exitCode = failures ? 1 : 0;
