import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizedResumePath } from "./authorized-resume-path.ts";

const base = "https://api.wisewolflanguage.com.br/storage/v1/object/public/resumes";
const tenant = "school-wise-wolf";

Deno.test("accepts canonical and safe legacy resume paths", () => {
  assertEquals(
    authorizedResumePath(`${base}/${tenant}/00000000-0000-4000-8000-000000000001.pdf`, tenant),
    `${tenant}/00000000-0000-4000-8000-000000000001.pdf`,
  );
  assertEquals(
    authorizedResumePath(`${base}/${tenant}/Curr%C3%ADculo%20Professor.pdf`, tenant),
    `${tenant}/Currículo Professor.pdf`,
  );
});

Deno.test("rejects tenant and bucket traversal variants", () => {
  const attempts = [
    `${base}/${tenant}/../../contracts/private.pdf`,
    `${base}/${tenant}/%2e%2e/%2e%2e/contracts/private.pdf`,
    `${base}/${tenant}/%252e%252e%252fcontracts%252fprivate.pdf`,
    `${base}/other-tenant/private.pdf`,
    `https://api.wisewolflanguage.com.br/storage/v1/object/public/contracts/${tenant}/private.pdf`,
    `https://evil.invalid/storage/v1/object/public/resumes/${tenant}/private.pdf`,
  ];

  for (const attempt of attempts) assertEquals(authorizedResumePath(attempt, tenant), null);
});

Deno.test("rejects unsafe names and malformed encoding", () => {
  const attempts = [
    `${base}/${tenant}/nested/private.pdf`,
    `${base}/${tenant}/private.exe`,
    `${base}/${tenant}/%ZZ.pdf`,
    `${base}/${tenant}/private%255c..%255csecret.pdf`,
  ];

  for (const attempt of attempts) assertEquals(authorizedResumePath(attempt, tenant), null);
});
