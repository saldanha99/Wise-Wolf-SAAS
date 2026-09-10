type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | null => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null;
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const emptyReference = (v: unknown): boolean => v == null || (typeof v === 'string' && !v.trim());
const cents = (v: unknown): number | null => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
/** A missing externalReference is allowed only for a SETTLED legacy installment
 * of an exact, already-bound subscription. The caller must resolve exactly one
 * local student by BOTH subscription and customer before fetching these objects
 * through that school's current integration. Customer/name/amount alone cannot
 * enter this path. Unknown nonempty references always stay in triage.
 */
export function verifiedLegacySubscriptionPayment(input: {
  eventName: string; eventPayment: unknown; authoritativePayment: unknown;
  authoritativeSubscription: unknown;
  expected: { studentId: string; customerId: string; subscriptionId: string };
}): boolean {
  const e = record(input.eventPayment), p = record(input.authoritativePayment), s = record(input.authoritativeSubscription);
  const expectedStatus = input.eventName === 'PAYMENT_RECEIVED' ? 'RECEIVED' : input.eventName === 'PAYMENT_RECEIVED_IN_CASH' ? 'RECEIVED_IN_CASH' : null;
  const x = input.expected;
  if (!e || !p || !s || !expectedStatus || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.studentId) || !x.customerId || !x.subscriptionId) return false;
  return text(e.id).startsWith('pay_') && text(e.id) === text(p.id)
    && text(e.customer) === x.customerId && text(p.customer) === x.customerId && text(s.customer) === x.customerId
    && text(e.subscription) === x.subscriptionId && text(p.subscription) === x.subscriptionId && text(s.id) === x.subscriptionId
    && emptyReference(e.externalReference) && emptyReference(p.externalReference) && emptyReference(s.externalReference)
    && e.deleted !== true && p.deleted !== true && s.deleted !== true
    && text(e.status) === expectedStatus && text(p.status) === expectedStatus
    && ['ACTIVE','EXPIRED','INACTIVE'].includes(text(s.status))
    && cents(e.value) !== null && cents(e.value) === cents(p.value)
    && /^\d{4}-\d{2}-\d{2}$/.test(text(e.dueDate)) && text(e.dueDate) === text(p.dueDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(text(e.paymentDate)) && text(e.paymentDate) === text(p.paymentDate);
}
