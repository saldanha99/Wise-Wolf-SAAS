import {
  isValidProviderCnpj,
  parseTeacherProviderIdentity,
} from "./provider-identity.ts";

const identity = {
  companyName: "Empresa Fixture",
  cnpj: "12.ABC.345/01DE-35",
  companyAddress: "Rua Fixture, 1",
  representativeCpf: "529.982.247-25",
  representativeHasAuthority: true,
};
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

Deno.test("CNPJ do prestador aceita os exemplos numérico e alfanumérico da Receita, sem apagar letras", () => {
  assert(isValidProviderCnpj("11.222.333/0001-81"), "numérico válido recusado");
  assert(isValidProviderCnpj(identity.cnpj), "alfanumérico válido recusado");
  for (
    const value of [
      "00000000000000",
      "12ABC34501DE36",
      "12ABC34501DE",
      "12_ABC34501DE35",
      "",
      "11222333000182",
    ]
  ) {
    assert(!isValidProviderCnpj(value), `CNPJ inválido aceito: ${value}`);
  }
});

Deno.test("identidade PJ exige partes, CPF, endereço e declaração de poderes, e congela campos normalizados", () => {
  const parsed = parseTeacherProviderIdentity(identity);
  assert(
    parsed?.cnpj === "12ABC34501DE35" &&
      parsed.representativeCpf === "52998224725",
    "normalização incorreta",
  );
  for (
    const value of [
      null,
      [],
      {},
      { ...identity, representativeHasAuthority: false },
      { ...identity, companyName: 123 },
      { ...identity, representativeCpf: "529A98224725" },
      { ...identity, companyAddress: "" },
      { ...identity, companyName: "x".repeat(161) },
    ]
  ) {
    assert(
      parseTeacherProviderIdentity(value) === null,
      "identidade incompleta foi aceita",
    );
  }
});
