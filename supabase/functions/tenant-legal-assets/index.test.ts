import {
  normalizeAffiliateCouponInput,
  offeredContractTermsVersion,
  offerKindMatches,
  publicSchoolBrand,
  teacherContractRateUnit,
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

Deno.test("versao do contrato da oferta vem da escola, e resposta estranha nao vira texto", () => {
  assert(offeredContractTermsVersion(2) === 2, "versao 2 da escola recusada");
  assert(offeredContractTermsVersion(1) === 1, "versao 1 da escola recusada");
  for (const value of [null, undefined, 0, -1, 1.5, "2", {}]) {
    let rejected = false;
    try {
      offeredContractTermsVersion(value);
    } catch {
      rejected = true;
    }
    assert(rejected, `versao ${JSON.stringify(value)} virou contrato`);
  }
});

Deno.test("copia do aceite pelo app mostra o valor por aula sem mudar a regua de pagamento", () => {
  // Convite (register-teacher): rateUnit gravado, e e o que a folha le.
  assert(
    teacherContractRateUnit({ rateUnit: "PER_LESSON" }) === "PER_LESSON",
    "contrato por convite perdeu a unidade",
  );
  // Aceite pelo app: sem rateUnit (a folha nao muda), exibido por aula como
  // a tela assinada mostrou.
  assert(
    teacherContractRateUnit({
      acceptedVia: "TEACHER_CONTRACT_ACCEPT",
      displayRateUnit: "PER_LESSON",
    }) === "PER_LESSON",
    "copia do aceite pelo app exibida como contrato antigo por hora",
  );
  // Contrato antigo por hora: nada gravado, continua como era.
  assert(
    teacherContractRateUnit({}) === undefined,
    "contrato antigo ganhou unidade",
  );
  // So PER_LESSON e aceito como exibicao.
  assert(
    teacherContractRateUnit({ displayRateUnit: "PER_HOUR" }) === undefined,
    "unidade de exibicao desconhecida aceita",
  );
});
