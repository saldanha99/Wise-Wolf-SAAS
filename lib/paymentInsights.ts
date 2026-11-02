// Leitura das mensalidades do mês para a tela Dinheiro → Mensalidades.
//
// A régua de status é a mesma de lib/studentPaymentStatus.ts: RECEIVED e
// RECEIVED_IN_CASH são dinheiro no caixa; CONFIRMED é cartão aprovado ainda sem
// crédito (não é recebido). Cancelada não entra no previsto — cobrança que não
// existe mais não é dinheiro que a escola espera.

import { isSettledStudentPayment, isStudentPaymentAwaitingCredit } from './studentPaymentStatus';

export interface PaymentLike {
  status: string;
  value: number | string | null;
  due_date: string | null;
}

export type PaymentBucket = 'SETTLED' | 'CONFIRMED' | 'PENDING' | 'OVERDUE' | 'CANCELLED' | 'OTHER';

export const paymentBucket = (status: string): PaymentBucket => {
  if (isSettledStudentPayment(status)) return 'SETTLED';
  if (isStudentPaymentAwaitingCredit(status)) return 'CONFIRMED';
  const s = String(status || '').trim().toUpperCase();
  if (s === 'PENDING') return 'PENDING';
  if (s === 'OVERDUE') return 'OVERDUE';
  if (s === 'CANCELLED') return 'CANCELLED';
  return 'OTHER';
};

export interface BucketTotal { count: number; total: number }

export interface PaymentSummary {
  expected: BucketTotal;
  byBucket: Record<PaymentBucket, BucketTotal>;
  // 0–100: quanto do previsto já entrou no caixa.
  settledPct: number;
  // PENDENTE que vence nos próximos 7 dias (inclui hoje).
  dueThisWeek: BucketTotal;
}

const toNumber = (v: number | string | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const daysBetween = (fromYMD: string, toYMD: string): number => {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
};

export const summarizePayments = (payments: PaymentLike[], todayYMD: string): PaymentSummary => {
  const empty = (): BucketTotal => ({ count: 0, total: 0 });
  const byBucket: Record<PaymentBucket, BucketTotal> = {
    SETTLED: empty(), CONFIRMED: empty(), PENDING: empty(), OVERDUE: empty(), CANCELLED: empty(), OTHER: empty(),
  };
  const expected = empty();
  const dueThisWeek = empty();
  for (const p of payments) {
    const bucket = paymentBucket(p.status);
    const value = toNumber(p.value);
    byBucket[bucket].count++;
    byBucket[bucket].total += value;
    if (bucket !== 'CANCELLED') {
      expected.count++;
      expected.total += value;
    }
    if (bucket === 'PENDING' && p.due_date) {
      const d = daysBetween(todayYMD, p.due_date.slice(0, 10));
      if (d >= 0 && d <= 7) {
        dueThisWeek.count++;
        dueThisWeek.total += value;
      }
    }
  }
  const settledPct = expected.total > 0 ? Math.round((100 * byBucket.SETTLED.total) / expected.total) : 0;
  return { expected, byBucket, settledPct, dueThisWeek };
};

/**
 * Frase curta sobre o prazo, ao lado da data: "vence hoje", "vence em 3 dias",
 * "atrasada há 5 dias". Pago e cancelado não ganham frase (o prazo deixou de
 * importar).
 */
export const dueHint = (status: string, dueDate: string | null, todayYMD: string): string | null => {
  if (!dueDate) return null;
  const bucket = paymentBucket(status);
  if (bucket !== 'PENDING' && bucket !== 'OVERDUE') return null;
  const d = daysBetween(todayYMD, dueDate.slice(0, 10));
  if (d === 0) return 'vence hoje';
  if (d === 1) return 'vence amanhã';
  if (d > 1) return `vence em ${d} dias`;
  return `atrasada há ${-d} dia${d === -1 ? '' : 's'}`;
};

/** Rótulo de gente para o billing_type do Asaas. */
export const billingLabel = (billingType: string | null | undefined): string => {
  switch (String(billingType || '').toUpperCase()) {
    case 'PIX': return 'Pix';
    case 'CREDIT_CARD': return 'Cartão';
    case 'BOLETO': return 'Boleto';
    case 'DEBIT_CARD': return 'Débito';
    case 'TRANSFER': return 'Transferência';
    case 'DEPOSIT': return 'Depósito';
    case '':
    case 'UNDEFINED': return 'A definir';
    default: return String(billingType);
  }
};
