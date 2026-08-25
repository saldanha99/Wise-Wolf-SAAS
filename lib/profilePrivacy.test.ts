import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PROFILE_SAFE_COLS } from '../constants';

const PROTECTED_PROFILE_COLUMNS = [
  'cpf', 'rg', 'birth_date', 'address', 'address_number', 'postal_code',
  'guardian_name', 'guardian_cpf', 'guardian_email', 'guardian_phone', 'guardian_id',
  'bank_name', 'agency', 'account_number', 'pix_key', 'pix_key_type',
  'private_notes', 'monthly_fee', 'monthly_tuition', 'due_day', 'status_financial',
  'asaas_customer_id', 'subscription_id', 'contract_url', 'signature_ip',
] as const;

const frontendFiles = execFileSync(
  'git',
  ['ls-files', 'App.tsx', 'components/*.tsx', 'lib/*.ts'],
  { encoding: 'utf8' },
).split('\n').filter(Boolean).filter(existsSync).filter((file) => !file.endsWith('.test.ts'));

describe('privacidade do diretório de profiles', () => {
  it('a projeção compartilhada contém só dados operacionais', () => {
    const columns = new Set(PROFILE_SAFE_COLS.split(',').map((column) => column.trim()));

    for (const operationalColumn of [
      'id', 'full_name', 'role', 'tenant_id', 'module', 'phone',
      'meeting_link', 'professor_id', 'professor_id2',
    ]) {
      expect(columns.has(operationalColumn), operationalColumn).toBe(true);
    }
    for (const protectedColumn of PROTECTED_PROFILE_COLUMNS) {
      expect(columns.has(protectedColumn), protectedColumn).toBe(false);
    }
  });

  it('nenhuma tela seleciona ou filtra PII diretamente em profiles', () => {
    const violations: string[] = [];

    for (const file of frontendFiles) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes("from('profiles')") && !source.includes('from("profiles")')) continue;

      for (const match of source.matchAll(
        /\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,240}?\.select\(\s*(['"`])([\s\S]*?)\1\s*[,)]/g,
      )) {
        const selected = new Set(
          match[2].split(/[,\s]+/).map((column) => column.trim()).filter(Boolean),
        );
        for (const protectedColumn of PROTECTED_PROFILE_COLUMNS) {
          if (selected.has(protectedColumn)) {
            violations.push(`${file}: SELECT direto de ${protectedColumn}`);
          }
        }
      }

      if (/\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,300}?\.(?:eq|not)\(\s*['"](?:cpf|guardian_id)['"]/.test(source)) {
        violations.push(`${file}: filtro direto por CPF/guardian_id`);
      }
    }

    expect(violations).toEqual([]);
  });
});
