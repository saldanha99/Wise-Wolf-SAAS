import { describe, expect, it } from 'vitest';
import { getSchoolContractIdentity, type SchoolInfo } from './ContractDocument';
import { getTeacherContractReadiness } from './TeacherContractDocument';
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
    expect(missingRate.missingFields).toContain('valor da hora/aula');
    expect(explicitRate.isReady).toBe(true);
    expect(explicitRate.hourlyRate).toBe(42.5);
  });
});
