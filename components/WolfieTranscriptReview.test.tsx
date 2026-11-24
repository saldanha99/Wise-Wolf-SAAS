import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WolfieTranscriptReview } from "./WolfieTranscriptReview";

// Caso real de 24/11/2026: a aluna tocou ~10 vezes em "Falar novamente" no ao
// vivo e nada aconteceu (o botão era recusado de propósito e o aviso ficava
// atrás do modal). Aqui o botão sempre age e o erro aparece dentro do modal.
describe("WolfieTranscriptReview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Falar novamente sempre chama onRetry", () => {
    const onRetry = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="Ok, vamos lá."
        onConfirm={vi.fn()}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /falar novamente/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a frase é editável na própria linha e Enter envia o texto editado", () => {
    const onConfirm = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="My name is Gabriella"
        reason="personal_fact"
        onConfirm={onConfirm}
        onRetry={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/editar o que o wolfie ouviu/i);
    fireEvent.change(input, { target: { value: "My name is Gabriela" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("My name is Gabriela");
  });

  it("confiança média: envia sozinho depois de 5 s", () => {
    const onConfirm = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="My seat is row 29."
        reason="uncertain_detail"
        autoConfirmAfterMs={5000}
        onConfirm={onConfirm}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /enviar \(5s\)/i })).toBeInTheDocument();
    for (let i = 0; i < 25; i += 1) act(() => vi.advanceTimersByTime(250));
    expect(onConfirm).toHaveBeenCalledWith("My seat is row 29.");
  });

  it("mexer na frase cancela o envio automático", () => {
    const onConfirm = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="My seat is row 29."
        reason="uncertain_detail"
        autoConfirmAfterMs={5000}
        onConfirm={onConfirm}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/editar o que o wolfie ouviu/i), {
      target: { value: "My seat is row 19." },
    });
    for (let i = 0; i < 40; i += 1) act(() => vi.advanceTimersByTime(250));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /está correto/i })).toBeInTheDocument();
  });

  it("erro aparece dentro do modal com Tentar de novo", () => {
    const onConfirm = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="I live in Niterói."
        reason="personal_fact"
        errorMessage="Ainda não foi possível concluir este turno."
        onConfirm={onConfirm}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/não foi possível/i);
    fireEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onConfirm).toHaveBeenCalledWith("I live in Niterói.");
  });

  it("enquanto envia, mostra carregando e não aceita clique duplo", () => {
    const onConfirm = vi.fn();
    render(
      <WolfieTranscriptReview
        transcript="I live in Niterói."
        busy
        onConfirm={onConfirm}
        onRetry={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /enviando/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("eco da instrução do reconhecimento abre vazio para falar ou escrever", () => {
    render(
      <WolfieTranscriptReview
        transcript="English tutoring with Brazilian Portuguese code-switching."
        reason="unreliable_transcript"
        onConfirm={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/não deu para entender/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/editar o que o wolfie ouviu/i)).toHaveValue("");
  });
});
