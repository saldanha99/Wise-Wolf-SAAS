import { isPublicBrandingPath } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("proxy publico aceita apenas logo e favicon do tenant solicitado", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert(
    isPublicBrandingPath(`tenant-a/logo/${id}.png`, "tenant-a", "logo"),
    "logo valida foi recusada",
  );
  assert(
    isPublicBrandingPath(`tenant-a/favicon/${id}.ico`, "tenant-a", "favicon"),
    "favicon valido foi recusado",
  );
  assert(
    !isPublicBrandingPath(`tenant-b/logo/${id}.png`, "tenant-a", "logo"),
    "logo cross-tenant foi aceita",
  );
  assert(
    !isPublicBrandingPath(`tenant-a/signature/${id}.png`, "tenant-a", "logo"),
    "assinatura foi aceita pelo proxy publico",
  );
  assert(
    !isPublicBrandingPath(`tenant-a/logo/${id}.svg`, "tenant-a", "logo"),
    "SVG foi aceito",
  );
});
