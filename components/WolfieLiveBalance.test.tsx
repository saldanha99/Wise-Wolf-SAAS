import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// O componente lê o saldo por RPC; mockamos só isso para testar a mensagem.
const rpc = vi.fn();
vi.mock("../lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { WolfieLiveBalance } from "./WolfieLiveBalance";

const saldo = (data: unknown) => {
  rpc.mockResolvedValue({ data, error: null });
};

describe("WolfieLiveBalance", () => {
  beforeEach(() => rpc.mockReset());

  it("deixa claro que a prática por escrita continua ilimitada quando os minutos acabam", async () => {
    // Regra de negócio: a cota fecha SÓ a voz ao vivo. Se a tela sugerir que o
    // aluno ficou sem Wolfie, ele deixa de praticar no modo que é quase de graça.
    saldo({ enforced: true, allowed: false, used: 30, limit: 30, remaining: 0 });
    render(<WolfieLiveBalance />);
    expect(await screen.findByText(/acabaram/i)).toBeInTheDocument();
    expect(screen.getByText(/ilimitada/i)).toBeInTheDocument();
  });

  it("mostra o saldo restante e o total", async () => {
    saldo({ enforced: true, allowed: true, used: 18, limit: 30, remaining: 12 });
    render(<WolfieLiveBalance />);
    expect(await screen.findByText("12 / 30 min")).toBeInTheDocument();
  });

  it("oferece o upgrade quando os minutos estão acabando", async () => {
    saldo({ enforced: true, allowed: true, used: 27, limit: 30, remaining: 3 });
    const onUpgrade = vi.fn();
    render(<WolfieLiveBalance onUpgrade={onUpgrade} />);
    expect(await screen.findByRole("button", { name: /mais minutos/i }))
      .toBeInTheDocument();
  });

  it("não oferece upgrade com saldo confortável — seria cobrança sem motivo", async () => {
    saldo({ enforced: true, allowed: true, used: 2, limit: 30, remaining: 28 });
    render(<WolfieLiveBalance onUpgrade={vi.fn()} />);
    await screen.findByText("28 / 30 min");
    expect(screen.queryByRole("button", { name: /mais minutos/i })).toBeNull();
  });

  it("escola sem cota configurada vê prática ilimitada, não um medidor zerado", async () => {
    saldo({ enforced: false, allowed: true });
    render(<WolfieLiveBalance />);
    expect(await screen.findByText(/ilimitada/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
  });

  it("falha na RPC não trava a tela nem inventa saldo", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "falhou" } });
    const { container } = render(<WolfieLiveBalance />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/\d+ \/ \d+ min/);
  });
});
