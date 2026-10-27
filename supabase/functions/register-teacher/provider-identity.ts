/** Validação estrutural; não substitui a conferência cadastral da empresa. */
export interface TeacherProviderIdentity {
  companyName: string;
  cnpj: string;
  companyAddress: string;
  representativeCpf: string;
  representativeHasAuthority: true;
}

export function normalizeProviderCnpj(value: string): string {
  return value.trim().toUpperCase().replace(/[.\/\-\s]/g, "");
}

/** Receita Federal: valores ASCII menos 48; compatível com CNPJ numérico e alfanumérico. */
export function isValidProviderCnpj(value: string): boolean {
  const cnpj = normalizeProviderCnpj(value);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) {
    return false;
  }
  const digit = (base: string): string => {
    let weight = base.length === 12 ? 5 : 6;
    let sum = 0;
    for (const character of base) {
      sum += (character.charCodeAt(0) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const remainder = sum % 11;
    return String(remainder < 2 ? 0 : 11 - remainder);
  };
  const first = digit(cnpj.slice(0, 12));
  return cnpj.slice(12) === first + digit(cnpj.slice(0, 12) + first);
}

function validCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  for (const length of [9, 10]) {
    const sum = [...value.slice(0, length)].reduce(
      (total, d, i) => total + Number(d) * (length + 1 - i),
      0,
    );
    const remainder = (sum * 10) % 11;
    if (Number(value[length]) !== (remainder === 10 ? 0 : remainder)) {
      return false;
    }
  }
  return true;
}

export function parseTeacherProviderIdentity(
  value: unknown,
): TeacherProviderIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    ["companyName", "cnpj", "companyAddress", "representativeCpf"].some((key) =>
      typeof input[key] !== "string"
    )
  ) return null;
  const companyName = (input.companyName as string).trim();
  const cnpj = normalizeProviderCnpj(input.cnpj as string);
  const companyAddress = (input.companyAddress as string).trim();
  const representativeCpf = (input.representativeCpf as string).trim().replace(
    /[.\-\s]/g,
    "",
  );
  if (
    companyName.length < 2 || companyName.length > 160 ||
    companyAddress.length < 5 || companyAddress.length > 300 ||
    !isValidProviderCnpj(cnpj) || !validCpf(representativeCpf) ||
    input.representativeHasAuthority !== true
  ) return null;
  return {
    companyName,
    cnpj,
    companyAddress,
    representativeCpf,
    representativeHasAuthority: true,
  };
}
