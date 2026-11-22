import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseRoleplayCharacter, portraitFor, RoleplayCounterpart } from "./RoleplayCounterpart";

describe("RoleplayCounterpart", () => {
  it("separa nome e cargo do personagem e ignora 'Wolfie plays'", () => {
    expect(parseRoleplayCharacter("your manager Mark")).toEqual({ name: "Mark", role: "your manager" });
    expect(parseRoleplayCharacter("Wolfie plays your manager Mark")).toEqual({ name: "Mark", role: "your manager" });
    expect(parseRoleplayCharacter("a recruiter")).toEqual({ name: "a recruiter", role: "" });
  });

  it("mostra quem está falando e os objetivos", () => {
    render(
      <RoleplayCounterpart
        cast={{ name: "Mark", role: "your manager", objectives: ["Conte o que fez ontem", "Use did", "Proponha data"] }}
        speaker="counterpart"
        inputLevel={0}
        outputLevel={0.5}
      />,
    );
    expect(screen.getByText("Mark está falando")).toBeTruthy();
    expect(screen.getByLabelText("Objetivos da conversa").textContent).toContain("Use did");
  });

  it("escolhe a foto pelo papel e respeita o gênero do nome", () => {
    expect(portraitFor("your manager", "Mark")).toBe("/assets/wolfie/personagens/gerente.webp");
    expect(portraitFor("your manager", "Sarah")).toBe("/assets/wolfie/personagens/recrutadora.webp");
    expect(portraitFor("a recruiter", "Anna")).toBe("/assets/wolfie/personagens/recrutadora.webp");
    expect(portraitFor("your client", "John")).toBe("/assets/wolfie/personagens/cliente.webp");
    expect(portraitFor("your colleague", "Lucy")).toBe("/assets/wolfie/personagens/colega.webp");
    expect(portraitFor("the waiter", "Tom")).toBeNull();
  });
});
