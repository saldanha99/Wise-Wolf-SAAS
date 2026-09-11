import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GoogleMeetClassroom from "./GoogleMeetClassroom";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/googleMeet", () => ({ googleMeet: call }));
const connected = {
  configured: true,
  connected: true,
  connection: { email: "teacher@school.test" },
  analysisConfigured: true,
  schoolDomains: ["school.test"],
};
const booking = {
  id: "booking-a",
  student_id: "student-a",
  day_of_week: "Segunda",
  time_slot: "10:00",
  student: { full_name: "Aluno de teste" },
};
const room = {
  id: "room-a",
  booking_id: "booking-a",
  student_id: "student-a",
  meeting_uri: "https://meet.google.com/abc-defg-hij",
  state: "READY",
};
beforeEach(() => call.mockReset());
describe("Google Meet classroom", () => {
  it("keeps setup explicit and does not offer connection when Google credentials are missing", async () => {
    call.mockImplementation(async (action) =>
      action === "status"
        ? { ...connected, configured: false, connected: false }
        : { bookings: [booking], rooms: [] }
    );
    render(<GoogleMeetClassroom />);
    expect(await screen.findByText(/aguardando a configuração Google/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conectar Google" })).not
      .toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith("connect");
  });
  it("creates a linked room only after the teacher confirms participant consent", async () => {
    call.mockImplementation(async (action) =>
      action === "status"
        ? connected
        : action === "list"
        ? { bookings: [booking], rooms: [] }
        : { room }
    );
    render(<GoogleMeetClassroom />);
    fireEvent.change(await screen.findByLabelText("Agendamento da sala"), {
      target: { value: "booking-a" },
    });
    const create = screen.getByRole("button", {
      name: "Criar sala com transcrição",
    });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(create);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("create_room", {
        bookingId: "booking-a",
        consentConfirmed: true,
      })
    );
  });
  it("student can open a classroom but never sees transcription or teacher controls", async () => {
    call.mockResolvedValue({ rooms: [room] });
    render(<GoogleMeetClassroom studentView />);
    expect(await screen.findByRole("link", { name: "Entrar no Meet" }))
      .toHaveAttribute("href", room.meeting_uri);
    expect(screen.queryByRole("button", { name: "Buscar transcrições" })).not
      .toBeInTheDocument();
    expect(call).toHaveBeenCalledWith("student_rooms");
  });
  it("does not analyze until a non-organizer speaker is selected", async () => {
    call.mockImplementation(async (action) =>
      action === "status"
        ? connected
        : action === "list"
        ? { bookings: [booking], rooms: [room] }
        : action === "transcripts"
        ? {
          transcripts: [{
            id: "t-1",
            occurred_at: "2026-09-10T12:00:00Z",
            state: "IMPORTED",
            raw_expires_at: "2099-01-01",
            participants: [{
              name: "teacher",
              displayName: "Teacher",
              isOrganizer: true,
            }, {
              name: "learner",
              displayName: "Aluno de teste",
              isOrganizer: false,
            }],
          }],
        }
        : {}
    );
    render(<GoogleMeetClassroom />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Histórico e preparação" }),
    );
    const analyze = await screen.findByRole("button", {
      name: "Preparar análise pedagógica",
    });
    expect(analyze).toBeDisabled();
    expect(screen.queryByRole("option", { name: "Teacher" })).not
      .toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText(
        "Qual participante é o aluno? Confirme antes de analisar.",
      ),
      { target: { value: "learner" } },
    );
    fireEvent.click(analyze);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("analyze", {
        transcriptId: "t-1",
        learnerParticipant: "learner",
      })
    );
  });
  it("shows backend failures without claiming a successful sync", async () => {
    call.mockResolvedValueOnce(connected).mockResolvedValueOnce({
      bookings: [booking],
      rooms: [room],
    }).mockRejectedValueOnce(new Error("Conta sem permissão"));
    render(<GoogleMeetClassroom />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Buscar transcrições" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Conta sem permissão");
    expect(screen.queryByText(/Consulta concluída/)).not.toBeInTheDocument();
  });
});
