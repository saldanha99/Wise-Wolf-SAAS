const normalized = (status: unknown): string =>
  typeof status === 'string' ? status.trim().toUpperCase() : '';

/** Dinheiro efetivamente recebido (pelo provedor ou fora dele) e apto ao caixa. */
export const isSettledStudentPayment = (status: unknown): boolean =>
  ['RECEIVED', 'RECEIVED_IN_CASH'].includes(normalized(status));

/** Pagamento autorizado/confirmado pelo provedor, mas ainda sem crédito. */
export const isStudentPaymentAwaitingCredit = (status: unknown): boolean =>
  normalized(status) === 'CONFIRMED';
