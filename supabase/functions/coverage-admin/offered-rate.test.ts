import { coverageOfferedRate, coverageRateText } from "./offered-rate.ts";
function assert(value: unknown) {
  if (!value) throw new Error("assertion failed");
}
Deno.test("diretor pode oferecer centavos e valor por aula até o teto", () => {
  for (const rate of [0.01, 8, 10.5, 12.50, 10000]) {
    assert(coverageOfferedRate(rate, "SCHOOL_ADMIN") === rate);
  }
});
Deno.test("coordenação, professor, aluno e super admin não escolhem valor", () => {
  for (const role of ["COORDINATOR", "TEACHER", "STUDENT", "SUPER_ADMIN", ""]) {
    let blocked = false;
    try {
      coverageOfferedRate(12.5, role);
    } catch {
      blocked = true;
    }
    assert(blocked);
    assert(coverageOfferedRate(null, role) === null);
  }
});
Deno.test("servidor recusa negativo, zero, texto, NaN, infinito e precisão extra", () => {
  for (
    const value of [-1, 0, 10000.01, NaN, Infinity, "12.50", 12.501, {}, true]
  ) {
    let blocked = false;
    try {
      coverageOfferedRate(value, "SCHOOL_ADMIN");
    } catch {
      blocked = true;
    }
    assert(blocked);
  }
});
Deno.test("convite diz o valor por 30 minutos e condiciona ao lançamento pagável", () => {
  assert(coverageRateText(12.5).includes("12,50"));
  assert(coverageRateText(12.5).includes("30 minutos"));
  assert(coverageRateText(12.5).includes("pagável"));
  assert(coverageRateText(null).includes("Tarifa normal"));
});
