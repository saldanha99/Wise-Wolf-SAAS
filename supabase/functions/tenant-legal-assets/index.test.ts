import {
  normalizeAffiliateCouponInput,
  offerKindMatches,
  publicSchoolBrand,
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("tipo publico da oferta nao pode rebaixar convite de professor", () => {
  assert(
    offerKindMatches("teacher", "TEACHER_INVITE"),
    "professor valido falhou",
  );
  assert(offerKindMatches("vendor", "VENDOR_INVITE"), "vendedor valido falhou");
  assert(
    !offerKindMatches("vendor", "TEACHER_INVITE"),
    "vendedor expos snapshot de professor",
  );
  assert(
    !offerKindMatches("teacher", "VENDOR_INVITE"),
    "professor aceitou convite de vendedor",
  );
});

Deno.test("cupom de afiliado e normalizado antes da validacao autoritativa", () => {
  assert(
    normalizeAffiliateCouponInput("  ww-indica_49  ") === "WW-INDICA_49",
    "cupom nao foi normalizado",
  );
  let rejected = false;
  try {
    normalizeAffiliateCouponInput("x");
  } catch {
    rejected = true;
  }
  assert(rejected, "cupom curto foi aceito");
});

Deno.test("marca da escola no convite de afiliado: so cor hex e logo https", () => {
  const brand = publicSchoolBrand({
    primaryColor: "#06142D",
    secondaryColor: "#320606",
    logoUrl: "https://api.example.test/storage/v1/object/public/logo.png",
    logoPath: "school/logo/interno.png",
    legalSignaturePath: "privado",
  });
  assert(brand.brandPrimary === "#06142D", "cor principal perdida");
  assert(brand.brandSecondary === "#320606", "cor secundaria perdida");
  assert(
    brand.schoolLogoUrl ===
      "https://api.example.test/storage/v1/object/public/logo.png",
    "logo perdido",
  );
  assert(
    Object.keys(brand).sort().join(",") ===
      "brandPrimary,brandSecondary,schoolLogoUrl",
    "a marca publica expos campo alem de cor e logo",
  );

  const invalid = publicSchoolBrand({
    primaryColor: "red",
    secondaryColor: "#FFF",
    logoUrl: "http://inseguro.test/logo.png",
  });
  assert(
    invalid.brandPrimary === null && invalid.brandSecondary === null &&
      invalid.schoolLogoUrl === null,
    "valor fora do formato passou",
  );
  const empty = publicSchoolBrand(null);
  assert(
    empty.brandPrimary === null && empty.schoolLogoUrl === null,
    "marca ausente deveria dar null",
  );
});
