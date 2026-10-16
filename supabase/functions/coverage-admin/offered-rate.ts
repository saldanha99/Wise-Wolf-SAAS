/** A oferta é por uma ocorrência de 30 min; só o diretor pode defini-la. */
export function coverageOfferedRate(
  value: unknown,
  role: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (role !== "SCHOOL_ADMIN") {
    throw new Error("Somente o diretor pode definir o valor da cobertura.");
  }
  if (
    typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
    value > 10000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001
  ) {
    throw new Error(
      "Informe um valor entre R$ 0,01 e R$ 10.000,00, com até duas casas decimais.",
    );
  }
  return value;
}

export function coverageRateText(rate: number | null | undefined): string {
  return rate == null
    ? "Tarifa normal do professor por aula de 30 minutos."
    : `Valor oferecido: ${
      new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
        .format(rate)
    } por aula de 30 minutos, após lançamento da aula pagável.`;
}
