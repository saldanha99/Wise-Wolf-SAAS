import { describe, expect, it } from "vitest";
import {
  canonicalClaimPath,
  deriveOpportunityClaimSlot,
  isClaimGeneration,
  normalizeWhatsAppPhone,
} from "./opportunityClaim";

describe("opportunity claim", () => {
  it("mantem somente o ID opaco na rota", () => {
    expect(
      canonicalClaimPath("00000000-0000-4000-8000-000000000001", 3),
    ).toBe(
      "/claim-opportunity?id=00000000-0000-4000-8000-000000000001&g=3",
    );
    expect(
      canonicalClaimPath("id&studentPhone=5511999999999", 1),
    ).not.toContain("&studentPhone=");
  });

  it("aceita apenas geracoes inteiras positivas", () => {
    expect(isClaimGeneration("1")).toBe(true);
    expect(isClaimGeneration(2147483647)).toBe(true);
    expect(isClaimGeneration("0")).toBe(false);
    expect(isClaimGeneration("1.5")).toBe(false);
    expect(isClaimGeneration(2147483648)).toBe(false);
  });

  it("deriva data e hora somente do slot canonico", () => {
    expect(
      deriveOpportunityClaimSlot([{ date: "2026-09-15", time: "19:30" }]),
    ).toEqual({
      date: "2026-09-15",
      time: "19:30",
      label: "15/09/2026 às 19:30",
    });
    expect(
      deriveOpportunityClaimSlot([
        { date: "2026-09-15", time: "19:30" },
        { date: "2026-09-16", time: "20:00" },
      ]),
    ).toBeNull();
    expect(
      deriveOpportunityClaimSlot([{ date: "2026-02-31", time: "19:30" }]),
    ).toBeNull();
  });

  it("nao duplica o codigo do Brasil", () => {
    expect(normalizeWhatsAppPhone("(11) 99999-9999")).toBe("5511999999999");
    expect(normalizeWhatsAppPhone("55 11 99999-9999")).toBe("5511999999999");
    expect(normalizeWhatsAppPhone("123")).toBeNull();
  });
});
