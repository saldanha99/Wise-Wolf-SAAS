import { describe, expect, it } from 'vitest';
import { studentBillingDestination } from './studentBillingNavigation';
import { STUDENT_BILLING_METHOD_PATH } from '../supabase/functions/_shared/student-billing-link';

describe('link de navegação financeira sem identidade', () => {
  const location = { pathname: STUDENT_BILLING_METHOD_PATH, search: '', hash: '' };

  it('aguarda login e abre apenas o financeiro da conta de aluno autenticada', () => {
    expect(studentBillingDestination(location, null)).toBeNull();
    expect(studentBillingDestination(location, { id: '', role: 'STUDENT' })).toBeNull();
    expect(studentBillingDestination(location, { id: 'authenticated-student', role: 'STUDENT' })).toBe('financial');
    expect(studentBillingDestination(location, { id: 'another-authenticated-student', role: 'STUDENT' })).toBe('financial');
  });

  it.each(['TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'GUARDIAN', 'NON_STUDENT', ''])('não eleva acesso de %s', (role) => {
    expect(studentBillingDestination(location, { id: 'signed-in-account', role })).toBeNull();
  });

  it.each([
    { ...location, search: '?user_id=another-student' },
    { ...location, search: '?token=anything' },
    { ...location, search: '?redirectTo=https://other.example' },
    { ...location, hash: '#access_token=anything' },
    { ...location, pathname: '/financeiro/forma-pagamento/another-student' },
    { ...location, pathname: '/other' },
  ])('não interpreta parâmetros, credenciais ou destino arbitrário: %o', (input) => {
    expect(studentBillingDestination(input, { id: 'authenticated-student', role: 'STUDENT' })).toBeNull();
  });
});
