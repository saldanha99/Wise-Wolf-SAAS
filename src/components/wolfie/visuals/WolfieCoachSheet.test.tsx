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

  it("keeps Tab and Shift+Tab inside the dialog", () => {
    const state = resolveMeetingVisualState({
      stage: "practice",
      learnerIntent: "ask_doubt",
    });
    render(
      <>
        <button type="button">Fora do diálogo</button>
        <WolfieCoachSheet state={state} onResume={vi.fn()}>
          <button type="button">Primeira ação</button>
          <button type="button" disabled>Ação indisponível</button>
        </WolfieCoachSheet>
      </>,
    );

    const heading = screen.getByRole("heading", {
      name: /tire a dúvida e volte ao mesmo ponto/i,
    });
    const firstAction = screen.getByRole("button", { name: "Primeira ação" });
    const resumeButton = screen.getByRole("button", { name: /retomar reunião/i });
    const outsideButton = screen.getByRole("button", { name: "Fora do diálogo" });

    expect(heading).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstAction).toHaveFocus();

    resumeButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstAction).toHaveFocus();

    firstAction.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(resumeButton).toHaveFocus();

    outsideButton.focus();
    expect(firstAction).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstAction).toHaveFocus();
  });

  it("keeps summary focusable and ignores hidden controls inside details", () => {
    const state = resolveMeetingVisualState({
      stage: "practice",
      learnerIntent: "ask_doubt",
    });
    render(
      <WolfieCoachSheet state={state}>
        <button type="button" style={{ display: "none" }}>
          Oculta por display
        </button>
        <div style={{ visibility: "hidden" }}>
          <button type="button">Oculta por ancestral</button>
        </div>
        <details>
          <summary>Detalhes fechados</summary>
          <button type="button">Oculta em detalhes</button>
        </details>
        <button type="button">Ação visível</button>
      </WolfieCoachSheet>,
    );

    const heading = screen.getByRole("heading", {
      name: /tire a dúvida e volte ao mesmo ponto/i,
    });
    const summary = screen.getByText("Detalhes fechados");
    const visibleAction = screen.getByRole("button", { name: "Ação visível" });

    expect(heading).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(summary).toHaveFocus();

    visibleAction.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(summary).toHaveFocus();
  });

  it("keeps focus on the heading when no enabled control is available", () => {
    const state = resolveMeetingVisualState({
      stage: "feedback",
      learnerIntent: "request_feedback",
    });
    render(
      <WolfieCoachSheet state={state}>
        <button type="button" disabled>Ação indisponível</button>
      </WolfieCoachSheet>,
    );

    const heading = screen.getByRole("heading", {
      name: /observe a evidência e escolha uma prioridade/i,
    });
    expect(heading).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(heading).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(heading).toHaveFocus();
  });

  it("restores the focus that was active before opening", () => {
    const state = resolveMeetingVisualState({
      stage: "feedback",
      learnerIntent: "request_feedback",
    });
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Abrir apoio";
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(
      <WolfieCoachSheet state={state} open onResume={vi.fn()} />,
    );
    expect(screen.getByRole("heading", {
      name: /observe a evidência e escolha uma prioridade/i,
    })).toHaveFocus();

    rerender(
      <WolfieCoachSheet state={state} open={false} onResume={vi.fn()} />,
    );
    expect(opener).toHaveFocus();
    opener.remove();
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
