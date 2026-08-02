import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WolfieCoachSheet } from "./WolfieCoachSheet";
import { resolveMeetingVisualState } from "./visualStateResolver";

describe("WolfieCoachSheet", () => {
  it("stays closed while the learner is performing", () => {
    render(
      <WolfieCoachSheet
        state={resolveMeetingVisualState({
          stage: "simulation",
          learnerIntent: "perform",
        })}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains a model request and preserves the exact meeting checkpoint", () => {
    const onResume = vi.fn();
    const state = resolveMeetingVisualState({
      stage: "simulation",
      learnerIntent: "request_model",
      counterpart: "Finance Director",
      pendingQuestion: "What is the expected ROI?",
      pendingDecision: "Approve the pilot budget",
    });

    render(
      <WolfieCoachSheet state={state} onResume={onResume}>
        <p>Good · Better · Executive</p>
      </WolfieCoachSheet>,
    );

    expect(
      screen.getByRole("dialog", { name: /compare good, better e executive/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Finance Director")).toBeInTheDocument();
    expect(screen.getByText("What is the expected ROI?")).toBeInTheDocument();
    expect(screen.getByText("Approve the pilot budget")).toBeInTheDocument();
    expect(screen.getByText("Good · Better · Executive")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retomar reunião/i }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("allows an accessible Escape resume unless resuming is disabled", () => {
    const onResume = vi.fn();
    const state = resolveMeetingVisualState({
      stage: "practice",
      learnerIntent: "ask_doubt",
    });
    const { rerender } = render(
      <WolfieCoachSheet state={state} onResume={onResume} />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onResume).toHaveBeenCalledTimes(1);

    rerender(
      <WolfieCoachSheet
        state={state}
        onResume={onResume}
        resumeDisabled
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus when the parent supplies a new resume callback", () => {
    const state = resolveMeetingVisualState({
      stage: "feedback",
      learnerIntent: "request_feedback",
    });
    const { rerender } = render(
      <WolfieCoachSheet state={state} onResume={vi.fn()} />,
    );
    const resumeButton = screen.getByRole("button", {
      name: /retomar reunião/i,
    });
    resumeButton.focus();
    expect(resumeButton).toHaveFocus();

    rerender(<WolfieCoachSheet state={state} onResume={vi.fn()} />);

    expect(screen.getByRole("button", { name: /retomar reunião/i }))
      .toHaveFocus();
  });
});
