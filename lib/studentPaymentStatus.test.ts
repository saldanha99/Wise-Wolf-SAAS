import { describe, expect, it } from 'vitest';
import {
  isSettledStudentPayment,
  isStudentPaymentAwaitingCredit,
} from './studentPaymentStatus';

describe('student payment status', () => {
  it('considera pago somente o valor efetivamente recebido', () => {
    expect(isSettledStudentPayment('RECEIVED')).toBe(true);
    expect(isSettledStudentPayment('RECEIVED_IN_CASH')).toBe(true);
    expect(isSettledStudentPayment('CONFIRMED')).toBe(false);
    expect(isSettledStudentPayment('PENDING')).toBe(false);
  });

  it('separa confirmação da entrada em caixa', () => {
    expect(isStudentPaymentAwaitingCredit('CONFIRMED')).toBe(true);
    expect(isStudentPaymentAwaitingCredit('RECEIVED')).toBe(false);
  });
});
