/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getHolidayBR, isHolidayBR } from "./holidays.ts";

Deno.test("detects 2026-09-07 as Brazilian Independence holiday", () => {
  assertEquals(isHolidayBR("2026-09-07"), true);
  assertEquals(getHolidayBR("2026-09-07"), "Independência do Brasil");
});

Deno.test("detects 2026-10-12 as Nossa Senhora Aparecida holiday", () => {
  assertEquals(isHolidayBR("2026-10-12"), true);
  assertEquals(getHolidayBR("2026-10-12"), "Nossa Senhora Aparecida");
});

Deno.test("normal business day returns null and false", () => {
  assertEquals(isHolidayBR("2026-09-08"), false);
  assertEquals(getHolidayBR("2026-09-08"), null);
  assertEquals(isHolidayBR("2026-09-05"), false);
});

Deno.test("future years fixed holidays match via annual pattern", () => {
  assertEquals(isHolidayBR("2028-09-07"), true);
  assertEquals(getHolidayBR("2028-09-07"), "Independência do Brasil");
  assertEquals(isHolidayBR("2028-12-25"), true);
  assertEquals(getHolidayBR("2028-12-25"), "Natal");
});

Deno.test("ponto facultativo não é feriado nacional: Carnaval e Corpus Christi têm aula", () => {
  assertEquals(isHolidayBR("2026-02-16"), false);
  assertEquals(isHolidayBR("2026-02-17"), false);
  assertEquals(isHolidayBR("2026-06-04"), false);
  assertEquals(isHolidayBR("2027-05-27"), false);
  assertEquals(getHolidayBR("2026-04-03"), "Paixão de Cristo");
  assertEquals(getHolidayBR("2027-03-26"), "Paixão de Cristo");
});
