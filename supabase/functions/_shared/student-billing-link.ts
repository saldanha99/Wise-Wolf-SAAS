/** Navigation only: this path grants no access and carries no payer identity. */
export const STUDENT_BILLING_METHOD_PATH = "/financeiro/forma-pagamento";
export const DEFAULT_STUDENT_PORTAL = "https://system.wisewolflanguage.com.br";

/** Use only a portal origin obtained from the verified tenant identity broker,
 * never a message, request parameter, invoice URL, or arbitrary redirect. */
export function buildStudentBillingLink(
  trustedPortalUrl?: string | null,
): string {
  let origin = DEFAULT_STUDENT_PORTAL;
  if (trustedPortalUrl) {
    try {
      const portal = new URL(trustedPortalUrl);
      if (
        portal.protocol === "https:" && !portal.username && !portal.password &&
        !portal.port
      ) {
        origin = portal.origin;
      }
    } catch {
      // A malformed configured portal never becomes an executable URL.
    }
  }
  return `${origin}${STUDENT_BILLING_METHOD_PATH}`;
}

/** No query/hash values are interpreted, especially student IDs and tokens. */
export function isStudentBillingMethodLink(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): boolean {
  return location.pathname === STUDENT_BILLING_METHOD_PATH &&
    !location.search && !location.hash;
}
