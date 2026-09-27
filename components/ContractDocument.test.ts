import React from 'react';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContractDocument, getSchoolContractIdentity, type SchoolInfo } from './ContractDocument';
import { TeacherContractDocument, getTeacherContractReadiness } from './TeacherContractDocument';
import { SUPABASE_URL } from '../lib/supabase-config';

const signedSignatureUrl = (tenantId: string) =>
  `${SUPABASE_URL}/storage/v1/object/sign/tenant-legal-assets/${tenantId}/legal-representative-signature/00000000-0000-4000-8000-000000000001.png?token=short-lived-token`;

const completeSchool = (overrides: SchoolInfo = {}): SchoolInfo => ({
  legalName: 'Escola Tenant Exemplo Ltda.',
  cnpj: '11.222.333/0001-81',
  address: 'Endereço jurídico configurado pelo tenant',
  email: 'juridico@tenant.example',
  phone: '(11) 90000-0000',
  city: 'Cidade Exemplo',
  state: 'sp',
  legalRepresentativeName: 'Responsável do Tenant',
  legalRepresentativeSignatureUrl: signedSignatureUrl('tenant-a'),
  ...overrides,
});

describe('identidade jurídica multi-tenant dos contratos', () => {
  it('não herda marca, PII ou assinatura quando o tenant não configurou dados', () => {
    const identity = getSchoolContractIdentity(null);

    expect(identity.isReady).toBe(false);
    expect(identity.name).toContain('NÃO CONFIGURADO');
    expect(identity.name).not.toMatch(/wise wolf/i);
    expect(identity.directorName).not.toMatch(/d[eé]bora/i);
    expect(identity.signatureUrl).toBeNull();
    expect(identity.missingFields).toContain('assinatura privada válida do responsável legal');
  });

  it('preserva exclusivamente a identidade fornecida pelo próprio tenant', () => {
    const identity = getSchoolContractIdentity(completeSchool());

    expect(identity.isReady).toBe(true);
    expect(identity.name).toBe('Escola Tenant Exemplo Ltda.');
    expect(identity.directorName).toBe('Responsável do Tenant');
    expect(identity.state).toBe('SP');
    expect(identity.signatureUrl).toBe(signedSignatureUrl('tenant-a'));
  });

  it('aceita os nomes de campos legados sem criar fallback global', () => {
    const identity = getSchoolContractIdentity(completeSchool({
      legalName: undefined,
      name: 'Nome explícito do tenant',
      legalRepresentativeName: undefined,
      directorName: 'Diretor explícito do tenant',
      legalRepresentativeSignatureUrl: undefined,
      directorSignatureUrl: signedSignatureUrl('tenant-b'),
    }));

    expect(identity.isReady).toBe(true);
    expect(identity.name).toBe('Nome explícito do tenant');
    expect(identity.directorName).toBe('Diretor explícito do tenant');
    expect(identity.signatureUrl).toContain('/tenant-b/');
  });

  it('recusa assinatura pública, externa, relativa ou URL insegura', () => {
    for (const signatureUrl of [
      '/director-signature.png',
      'http://cdn.example.test/signature.png',
      'https://cdn.example.test/signature.png',
      'https://evil.example.test/storage/v1/object/sign/tenant-legal-assets/tenant-a/legal-representative-signature/00000000-0000-4000-8000-000000000001.png?token=fake',
      'https://storage.example.test/storage/v1/object/public/tenant-branding/tenant-a/signature/00000000-0000-4000-8000-000000000001.png',
      'javascript:alert(1)',
    ]) {
      const identity = getSchoolContractIdentity(completeSchool({
        legalRepresentativeSignatureUrl: signatureUrl,
      }));

      expect(identity.isReady).toBe(false);
      expect(identity.signatureUrl).toBeNull();
      expect(identity.missingFields).toContain('assinatura privada válida do responsável legal');
    }
  });

  it('bloqueia CNPJ apenas formatado, mas juridicamente inválido', () => {
    const identity = getSchoolContractIdentity(completeSchool({ cnpj: '00.000.000/0001-00' }));

    expect(identity.isReady).toBe(false);
    expect(identity.missingFields).toContain('CNPJ válido');
  });

  it('mantém uma marca da plataforma apenas quando ela veio explicitamente do tenant', () => {
    const absent = getSchoolContractIdentity(undefined);
    const explicit = getSchoolContractIdentity(completeSchool({ legalName: 'WISE WOLF LANGUAGE' }));

    expect(absent.name).not.toMatch(/wise wolf/i);
    expect(explicit.name).toBe('WISE WOLF LANGUAGE');
  });

  it('não inventa valor financeiro no contrato do professor', () => {
    const missingRate = getTeacherContractReadiness(completeSchool(), undefined);
    const explicitRate = getTeacherContractReadiness(completeSchool(), 42.5);

    expect(missingRate.isReady).toBe(false);
    expect(missingRate.hourlyRate).toBeNull();
    expect(missingRate.missingFields).toContain('valor por aula');
    expect(explicitRate.isReady).toBe(true);
    expect(explicitRate.hourlyRate).toBe(42.5);
  });
});


describe('remuneração por aula no contrato', () => {
  const render = (rate: number, extra = {}) => renderToStaticMarkup(React.createElement(TeacherContractDocument, {
    teacherName: 'Professor de teste', teacherRG: '', teacherCPF: '', teacherAddress: '', teacherBirthDate: '',
    school: completeSchool(), hourlyRate: rate, showPrintButton: false, ...extra,
  }));
  it.each([8, 12.5])('exibe R$ %s integral por aula sem converter para hora', (rate) => {
    const html = render(rate);
    expect(html).toContain(`R$ ${rate.toFixed(2).replace('.', ',')} por aula de 30`);
    expect(html).not.toContain('equivalente a');
  });
  it('preserva valores dos contratos antigos já assinados', () => {
    expect(render(16, { acceptedAt: '2026-09-09T17:00:00Z' })).toContain('R$ 8,00 por cada 30');
  });
  it('mantém o valor integral na consulta de um novo contrato assinado', () => {
    expect(render(8, { acceptedAt: '2026-09-09T19:00:00Z', rateUnit: 'PER_LESSON' })).toContain('R$ 8,00 por aula de 30');
  });
});

describe('termos comerciais do contrato do aluno', () => {
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ContractDocument, {
    studentName: 'Aluna de teste', studentCPF: '52998224725', studentAddress: 'Endereço de teste',
    studentEmail: 'aluna@example.test', studentPhone: '5511999999999', planName: 'Plano Semestral',
    planValue: '261,00', totalValue: '1.566,00', planDuration: 6, startDate: '23/09/2026',
    endDate: '23/03/2027', dueDay: 10, classFrequency: 2, school: completeSchool(),
    showPrintButton: false, ...extra,
  }));

  it('preserva os seis meses escolhidos e quatro reposições por mês', () => {
    const html = render();
    expect(html).toContain('6 (seis) meses');
    expect(html).toContain('4 (quatro) aulas por mês');
    expect(html).not.toContain('4 (uma) aula por mês');
  });

  it('flexiona corretamente uma reposição quando houver exceção explícita', () => {
    expect(render({ repositionLimit: 1 })).toContain('1 (uma) aula por mês');
  });

  it('mantém os termos anuais da oferta 4x sem herdar o semestral nem uma reposição', () => {
    const html = render({
      studentName: 'Aluno de teste', planName: 'Plano Anual',
      planValue: '299,00', totalValue: '3.637,90', planDuration: 12,
      startDate: '05/10/2026', endDate: '05/10/2027', dueDay: 5,
      classFrequency: 4, enrollmentFee: 49.90,
    });
    expect(html).toContain('Plano Anual');
    expect(html).toContain('12 (doze) meses');
    expect(html).toContain('12 (doze) parcelas mensais');
    expect(html).toContain('4 (quatro) vezes por semana');
    expect(html).toContain('4 (quatro) aulas por mês');
    expect(html).toContain('Dia 5 de cada mês');
    expect(html).toContain('05/10/2026 a 05/10/2027');
    expect(html).toContain('R$ 3.637,90');
    expect(html).not.toContain('Plano Semestral');
    expect(html).not.toContain('6 (seis) meses');
    expect(html).not.toContain('1 (uma) aula por mês');
  });
});

/**
 * Cláusula do registro das aulas (decisão da direção de 27/09/2026) e a regra
 * que protege quem já assinou: contrato assinado NUNCA muda de texto.
 *
 * Os hashes abaixo são do texto das cláusulas (das partes até a declaração
 * final — sem data de assinatura, que depende do fuso) renderizado pelos
 * componentes de 59dda7b4, ANTES da cláusula nova, com as mesmas props. Na
 * troca, o HTML do contrato assinado sem versão foi conferido byte a byte com
 * o componente antigo (a4 e tela; aluno recorrente e avulso; professor por
 * aula e horista antigo). Se um destes testes falhar, o texto de um contrato
 * JÁ ASSINADO mudou: não edite o texto antigo — crie versão nova em
 * lib/contractTerms.ts.
 */
describe('versão do texto do contrato: a cláusula do registro das aulas', () => {
  const LEGACY_CLAUSES_SHA256 = {
    student: '74045a8d1f360ae8ada153c72d825c7fec862bf28a26a404df648908ee2c0e32',
    studentOneTime: '8880eb71dc3ee9ebd58fc703e01338991535707ff9bfb623633df903edf65e35',
    teacher: '76fbe0bd9f9e1194dde9e047bb4ac6d646a795eb9e42cff2658bb0cc55b4a1ac',
    teacherHourly: '911ece8b5aed8710bc22bcebc8420e8c38d67789cbdb40c8859f0b0312591c46',
  };

  const school = completeSchool({ legalName: 'Escola Tenant Exemplo Ltda.', address: 'Endereço jurídico configurado pelo tenant' });
  const studentProps = {
    studentName: 'Aluna de teste', studentCPF: '52998224725', studentAddress: 'Endereço de teste',
    studentEmail: 'aluna@example.test', studentPhone: '5511999999999', planName: 'Plano Semestral',
    planValue: '261,00', totalValue: '1.566,00', planDuration: 6, startDate: '23/09/2026',
    endDate: '23/03/2027', dueDay: 10, classFrequency: 2, school, showPrintButton: false,
    userIp: '203.0.113.9', subscriptionId: 'sub_legacy_0001',
  };
  const teacherProps = {
    teacherName: 'Professor de teste', teacherRG: '12.345.678-9', teacherCPF: '529.982.247-25',
    teacherAddress: 'Rua Teste, 1', teacherBirthDate: '01/01/1990', school, hourlyRate: 8,
    rateUnit: 'PER_LESSON', showPrintButton: false, userIp: '203.0.113.10',
    subscriptionId: 'teacher-legacy-0001',
  };
  const SIGNED_AT = '2026-09-20T15:00:00Z';

  const text = (html: string) => html
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clausesOf = (html: string, start: string, end: string) => {
    const content = text(html);
    const from = content.indexOf(start);
    const to = content.indexOf(end);
    expect(from, `marcador "${start}"`).toBeGreaterThanOrEqual(0);
    expect(to, `marcador "${end}"`).toBeGreaterThan(from);
    return content.slice(from, to);
  };
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const student = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(ContractDocument, { ...studentProps, ...extra }));
  const teacher = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(TeacherContractDocument, { ...teacherProps, ...extra }));
  const studentClauses = (html: string) => clausesOf(html, 'I. Das Partes', 'Por estarem justas');
  const teacherClauses = (html: string) => clausesOf(html, 'CONTRATANTE:', 'E, por estarem justos');

  it('aluno que assinou antes (sem versão gravada) vê exatamente o texto que assinou', () => {
    const html = student({ acceptedAt: SIGNED_AT });
    expect(sha256(studentClauses(html))).toBe(LEGACY_CLAUSES_SHA256.student);
    expect(sha256(studentClauses(student({ acceptedAt: SIGNED_AT, planDuration: 0 }))))
      .toBe(LEGACY_CLAUSES_SHA256.studentOneTime);
    expect(html).toContain('Cláusula 8 — Do Foro');
    expect(html).not.toContain('Registro das Aulas');
    expect(html).not.toContain('Versão do texto');
  });

  it('versão 1 gravada e versão desconhecida valem como o texto de antes', () => {
    const legacy = student({ acceptedAt: SIGNED_AT });
    expect(student({ acceptedAt: SIGNED_AT, termsVersion: 1 })).toBe(legacy);
    expect(student({ acceptedAt: SIGNED_AT, termsVersion: 99 })).toBe(legacy);
  });

  it('contrato não assinado sem a versão da escola mostra o texto de antes (nunca uma cláusula não decidida)', () => {
    const html = student();
    expect(studentClauses(html)).toContain('Cláusula 8 — Do Foro');
    expect(html).not.toContain('Registro das Aulas');
    // Escola que não decidiu registrar as aulas oferece a versão 1.
    expect(studentClauses(student({ termsVersion: 1 }))).toBe(studentClauses(html));
    expect(teacher()).not.toContain('REGISTRO DAS AULAS');
  });

  it('contrato ainda não assinado na escola que oferece a versão 2: Cláusula 8 do registro e o Foro na 9', () => {
    const html = student({ termsVersion: 2 });
    const clauses = studentClauses(html);
    expect(clauses).toContain('Cláusula 8 — Do Registro das Aulas');
    expect(clauses).toContain('Cláusula 9 — Do Foro');
    expect(clauses).not.toContain('Cláusula 8 — Do Foro');
    expect(clauses.indexOf('Cláusula 7 — Da Proteção de Dados')).toBeLessThan(clauses.indexOf('Cláusula 8 — Do Registro das Aulas'));
    expect(clauses.indexOf('Cláusula 8 — Do Registro das Aulas')).toBeLessThan(clauses.indexOf('Cláusula 9 — Do Foro'));
    // As cláusulas 1 a 7 não mudam uma vírgula.
    const legacyClauses = studentClauses(student({ acceptedAt: SIGNED_AT }));
    const upToLgpd = (value: string) => value.slice(0, value.indexOf('Cláusula 8'));
    expect(upToLgpd(clauses)).toBe(upToLgpd(legacyClauses));
  });

  it('quem assinou a versão 2 continua vendo a cláusula, com a versão no selo', () => {
    const html = student({ acceptedAt: SIGNED_AT, termsVersion: 2 });
    expect(studentClauses(html)).toBe(studentClauses(student({ termsVersion: 2 })));
    expect(html).toContain('Cláusula 8 — Do Registro das Aulas');
    expect(text(html)).toContain('Versão do texto: 2');
  });

  it('a cláusula do aluno resume o essencial do aviso completo', () => {
    const clause = studentClauses(student({ termsVersion: 2 }));
    for (const expected of [
      'sem gravação em vídeo',
      'transcrição automática',
      'relatório com os horários de entrada e saída',
      'aprovado pelo professor',
      'planejar as próximas aulas e as tarefas',
      'link que só abre com login',
      'Google Workspace',
      'OpenRouter',
      'treinar modelos desligado',
      '90 (noventa) dias',
      'pedir, pelo WhatsApp da CONTRATADA, que as aulas deixem de ser registradas',
      'a exclusão do que já foi registrado',
      'menor de 18 (dezoito) anos, este contrato é assinado pelo seu responsável legal',
      'aviso completo',
      // Prazos como o sistema faz e o termo v3 diz: cópias contam de quando
      // chegam ao sistema; trechos copiados e originais, da aula.
      'contados de quando chegam ao sistema (logo depois da aula)',
      'os trechos da aula copiados para o resumo são apagados',
      'elimina os arquivos originais de sua conta Google',
      // O caso aberto pela divergência de presença guarda os horários.
      'registro do caso aberto para a coordenação',
      'ressalvado o registro de caso previsto no Parágrafo 4º',
      // O cartão inteiro, inclusive o texto livre do professor.
      'temas a evitar',
      'observações pedagógicas anotados pelo professor',
      // A Cláusula 7 exige consentimento expresso para terceiros.
      'não são terceiros para os fins da Cláusula 7',
      'consente expressamente',
    ]) {
      expect(clause, expected).toContain(expected);
    }
    // A primeira redação prometia 90 dias depois da aula para tudo, e o
    // sistema conta as cópias de quando chegam.
    expect(clause).not.toContain('inclusive os trechos copiados para o resumo, são eliminados');
  });

  it('professor que assinou antes (sem versão gravada) vê exatamente o texto que assinou', () => {
    const html = teacher({ acceptedAt: SIGNED_AT });
    expect(sha256(teacherClauses(html))).toBe(LEGACY_CLAUSES_SHA256.teacher);
    expect(sha256(teacherClauses(teacher({ acceptedAt: SIGNED_AT, hourlyRate: 16, rateUnit: undefined }))))
      .toBe(LEGACY_CLAUSES_SHA256.teacherHourly);
    expect(html).not.toContain('REGISTRO DAS AULAS');
    expect(html).not.toContain('Versão do texto');
    expect(teacher({ acceptedAt: SIGNED_AT, termsVersion: 1 })).toBe(html);
  });

  it('contrato do professor ainda não assinado traz a Cláusula 11ª no fim, sem renumerar nada', () => {
    const clauses = teacherClauses(teacher({ termsVersion: 2 }));
    expect(clauses).toContain('CLÁUSULA 11ª – REGISTRO DAS AULAS');
    expect(clauses.indexOf('CLÁUSULA 10ª')).toBeLessThan(clauses.indexOf('CLÁUSULA 11ª'));
    const legacy = teacherClauses(teacher({ acceptedAt: SIGNED_AT }));
    expect(clauses.slice(0, clauses.indexOf('CLÁUSULA 11ª')).trim()).toBe(legacy.trim());
    for (const expected of [
      'sem gravação em vídeo',
      'coanfitrião pela conta Google',
      'aprovado pelo CONTRATADO',
      'EXTRATO DE PONTUALIDADE',
      'sem nota, sem ranking e sem comparação com outros professores',
      'não altera a remuneração prevista na Cláusula 3ª',
      'nenhum ajuste de pagamento é automático',
      'Google Workspace',
      'OpenRouter',
      '90 (noventa) dias',
      'que as suas aulas deixem de ser registradas',
      'aviso completo',
      'contados de quando chegam ao sistema (logo depois da aula)',
      'elimina os arquivos originais de sua conta Google',
      'registro do caso aberto para a coordenação',
      'ressalvado o registro de caso previsto no item 11.6',
      'atuam como operadores',
      'Para os fins da Cláusula 8ª',
    ]) {
      expect(clauses, expected).toContain(expected);
    }
    expect(clauses).not.toContain('inclusive os trechos copiados para o resumo, são eliminados');
  });

  it('professor que assinou a versão 2 continua vendo a Cláusula 11ª', () => {
    const html = teacher({ acceptedAt: SIGNED_AT, termsVersion: 2 });
    expect(html).toContain('CLÁUSULA 11ª – REGISTRO DAS AULAS');
    expect(text(html)).toContain('Versão do texto: 2');
  });
});
