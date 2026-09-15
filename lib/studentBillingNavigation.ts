import { isStudentBillingMethodLink } from '../supabase/functions/_shared/student-billing-link';

/** A UI destination, not authorization. ProtectedRoute, StudentProvider and
 * payment-auth remain responsible for the account, membership and tenant. */
export function studentBillingDestination(
  location: Parameters<typeof isStudentBillingMethodLink>[0],
  user: { id: string; role: string } | null | undefined,
): 'financial' | null {
  return user?.id && user.role === 'STUDENT' && isStudentBillingMethodLink(location)
    ? 'financial'
    : null;
}

export { isStudentBillingMethodLink };
