import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * As portas que GRAVAM a versão do contrato no aceite. Sem a linha em
 * contract_terms_acceptances o contrato é lido como o texto de antes, e sem a
 * mesma versão na tela e no servidor a pessoa assina um texto e fica gravado
 * outro. Nenhuma tela de assinatura deixa isso aparecer num teste de
 * componente — a ordem e o valor enviados são o contrato, então a varredura é
 * do código-fonte (mesmo padrão de lib/profileColumns.test.ts).
 * A edge register-teacher tem o próprio teste (Deno):
 * supabase/functions/register-teacher/contract-terms.test.ts.
 */
const ROOT = join(__dirname, '..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const positionOf = (text: string, needle: string) => {
  const index = text.indexOf(needle);
  expect(index, `trecho ausente: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('matrícula (PublicRegistration)', () => {
  const page = source('components/PublicRegistration.tsx');

  it('grava a versão depois do aceite e ANTES de qualquer cobrança', () => {
    const begin = positionOf(page, "supabase.rpc('begin_enrollment_offer'");
    const record = positionOf(page, 'await recordEnrollmentContractTerms({');
    const customer = positionOf(page, 'await asaasService.syncStudent(');
    expect(begin).toBeLessThan(record);
    expect(record).toBeLessThan(customer);
    // A gravação fica no mesmo bloco da submissão, entre o aceite e o cliente
    // no provedor (a retomada de cobrança no topo do arquivo é outro fluxo).
    expect(page.slice(begin, customer)).toContain('await recordEnrollmentContractTerms({');
  });

  it('matrícula já concluída não grava de novo; a versão gravada é a que a página mostrou', () => {
    const record = page.slice(positionOf(page, 'await recordEnrollmentContractTerms({'));
    const call = record.slice(0, record.indexOf('});') + 3);
    expect(call).toContain('alreadyCompleted: claimResult.already_completed === true');
    expect(call).toContain("termsVersion: offeredContractTermsVersion('STUDENT', contractData)");
    // A tela de assinatura mostra a mesma versão que é gravada.
    expect(page).toContain("const offeredTermsVersion = offeredContractTermsVersion('STUDENT', contractData);");
    expect(page).toMatch(/<ContractModal[\s\S]*?termsVersion=\{offeredTermsVersion\}/);
    // Nada de versão fixa: a versão é da escola da oferta.
    expect(page).not.toContain('CURRENT_CONTRACT_TERMS_VERSION');
  });
});

describe('professor que regulariza o aceite pelo app (TeacherContractAccept)', () => {
  const screen = source('components/TeacherContractAccept.tsx');

  it('envia ao servidor a mesma versão que mostrou, lida da escola dele', () => {
    expect(screen).toContain("loadContractTerms(userId, 'TEACHER')");
    expect(screen).toMatch(/supabase\.rpc\('accept_teacher_contract',\s*\{\s*p_typed_signature: finalSignature,\s*p_terms_version: termsVersion,\s*\}\)/);
    expect(screen).toMatch(/<TeacherContractDocument[\s\S]*?termsVersion=\{termsVersion\}/);
    expect(screen).toContain('const termsVersion = offeredTermsVersion ?? LEGACY_CONTRACT_TERMS_VERSION;');
    expect(screen).not.toContain('CURRENT_CONTRACT_TERMS_VERSION');
  });

  it('o destaque da cláusula só aparece quando o texto a traz', () => {
    expect(screen).toContain('{withLessonRecording && <LessonRecordingClauseNotice clauseLabel="Cláusula 11ª" />}');
  });
});

describe('professor por convite (TeacherOnboarding)', () => {
  const screen = source('components/TeacherOnboarding.tsx');

  it('envia na assinatura a versão que mostrou e congelou no PDF (a da escola do convite)', () => {
    expect(screen).toContain("const contractTermsVersion = offeredContractTermsVersion('TEACHER', offerData);");
    const invoke = screen.slice(positionOf(screen, "supabase.functions.invoke('register-teacher'"));
    const body = invoke.slice(0, invoke.indexOf('}\n            });'));
    expect(body).toMatch(/\n\s*contractTermsVersion,\n/);
    expect(screen).toMatch(/<TeacherContractDocument[\s\S]*?termsVersion=\{contractTermsVersion\}/);
    expect(screen).not.toContain('CURRENT_CONTRACT_TERMS_VERSION');
  });
});
