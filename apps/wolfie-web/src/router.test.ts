import { describe, expect, it } from "vitest";
import { safeAppNextPath } from "./router";

describe("safeAppNextPath", () => {
  const origin = "https://wolfie.wisewolflanguage.com.br";

  it("aceita somente caminhos internos do aplicativo", () => {
    expect(safeAppNextPath("/app/praticar?intent=abc", origin))
      .toBe("/app/praticar?intent=abc");
  });

  it.each([
    "https://example.com/roubo",
    "//example.com/roubo",
    "/entrar",
    "javascript:alert(1)",
  ])("bloqueia redirect não permitido: %s", (target) => {
    expect(safeAppNextPath(target, origin)).toBe("/app");
  });
});
