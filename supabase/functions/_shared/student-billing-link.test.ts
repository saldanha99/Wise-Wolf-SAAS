import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStudentBillingLink,
  DEFAULT_STUDENT_PORTAL,
  isStudentBillingMethodLink,
  STUDENT_BILLING_METHOD_PATH,
} from "./student-billing-link.ts";

Deno.test("financial navigation link is fixed and has no payer or credential", () => {
  const defaultUrl = `${DEFAULT_STUDENT_PORTAL}${STUDENT_BILLING_METHOD_PATH}`;
  assertEquals(buildStudentBillingLink(), defaultUrl);
  for (
    const invalid of [
      "javascript:alert(1)",
      "http://school.example",
      "https://user:password@school.example",
      "https://school.example:8443",
      "not a url",
    ]
  ) {
    assertEquals(buildStudentBillingLink(invalid), defaultUrl);
  }
  assertEquals(
    buildStudentBillingLink(
      "https://verified-school.example/old?student_id=private#secret",
    ),
    `https://verified-school.example${STUDENT_BILLING_METHOD_PATH}`,
  );
});

Deno.test("financial route has an exact allowlist and never interprets query or hash", () => {
  assertEquals(
    isStudentBillingMethodLink({ pathname: STUDENT_BILLING_METHOD_PATH }),
    true,
  );
  assertEquals(
    isStudentBillingMethodLink({
      pathname: STUDENT_BILLING_METHOD_PATH,
      search: "?user_id=other",
    }),
    false,
  );
  assertEquals(
    isStudentBillingMethodLink({
      pathname: STUDENT_BILLING_METHOD_PATH,
      hash: "#token=secret",
    }),
    false,
  );
  assertEquals(
    isStudentBillingMethodLink({
      pathname: `${STUDENT_BILLING_METHOD_PATH}/other`,
    }),
    false,
  );
});
