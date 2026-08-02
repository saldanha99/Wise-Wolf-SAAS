import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WolfieMeetingHUD } from "./WolfieMeetingHUD";
import { resolveMeetingVisualState } from "./visualStateResolver";

describe("WolfieMeetingHUD", () => {
  it("keeps counterpart, pending question, and decision visible during the meeting", () => {
    const state = resolveMeetingVisualState({
      stage: "simulation",
      counterpart: "Chief Operations Officer",
      pendingQuestion: "Can the team deliver this by Friday?",
      pendingDecision: "Choose the rollout owner and deadline",
    });

    render(<WolfieMeetingHUD state={state} />);

    expect(
      screen.getByRole("region", { name: "Estado da reunião global" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Chief Operations Officer")).toBeInTheDocument();
    expect(
      screen.getByText("Can the team deliver this by Friday?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose the rollout owner and deadline"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Progresso da reunião global" }),
    ).toHaveAttribute("aria-valuenow", String(state.progressValue));
  });

  it("announces a retry with text as well as color", () => {
    const state = resolveMeetingVisualState({
      stage: "retry",
      scenarioStatus: "awaiting_retry",
      requiresRetry: true,
    });

    render(<WolfieMeetingHUD state={state} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Nova tentativa necessária",
    );
    expect(
      screen.getByText(/Aplique o feedback sem trocar o interlocutor/i),
    ).toBeInTheDocument();
  });

  it("uses explicit placeholders instead of removing checkpoint fields", () => {
    render(
      <WolfieMeetingHUD
        state={resolveMeetingVisualState({ stage: "briefing" })}
      />,
    );

    expect(
      screen.getByText("Aguardando definição do interlocutor"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nenhuma pergunta pendente")).toBeInTheDocument();
    expect(screen.getByText("Aguardando definição da decisão"))
      .toBeInTheDocument();
  });
});
