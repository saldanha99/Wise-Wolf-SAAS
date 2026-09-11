import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle,
  ExternalLink,
  RefreshCw,
  Video,
} from "lucide-react";
import { googleMeet } from "../lib/googleMeet";
import { safeMeetingLink } from "../lib/meetingLink";

type Booking = {
  id: string;
  student_id: string;
  day_of_week: string;
  time_slot: string;
  student: { full_name: string } | null;
};
type Room = {
  id: string;
  booking_id: string;
  student_id: string;
  meeting_uri: string | null;
  state: string;
  last_sync_at: string | null;
  sync_error: string | null;
};
type Transcript = {
  id: string;
  occurred_at: string;
  state: string;
  raw_expires_at: string;
  participants: { name: string; displayName: string; isOrganizer: boolean }[];
  proposal: Proposal | null;
};
type Proposal = {
  summary: string;
  professional_context: string;
  interests: string[];
  practiced: string[];
  vocabulary: string[];
  difficulties: string[];
  strengths: string[];
  teacher_preparation: string[];
  next_lesson: string;
  oral_test: string[];
  evidence: { entry: string; quote: string }[];
};
type Status = {
  configured: boolean;
  connected: boolean;
  connection: { email: string } | null;
  analysisConfigured: boolean;
  schoolDomains: string[];
};
const button =
  "px-4 py-2 rounded-xl border border-brand-border font-semibold text-sm disabled:opacity-50 hover:bg-brand-surface-2 flex items-center justify-center gap-2";

const GoogleMeetClassroom: React.FC<{ studentView?: boolean }> = (
  { studentView = false },
) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewRoom, setReviewRoom] = useState("");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const alive = useRef(true);
  const reviewGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reviewGeneration.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (studentView) {
      const data = await googleMeet<{ rooms: Room[] }>("student_rooms");
      if (alive.current) setRooms(data.rooms);
    } else {
      const next = await googleMeet<Status>("status");
      if (alive.current) setStatus(next);
      const data = await googleMeet<{ bookings: Booking[]; rooms: Room[] }>(
        "list",
      );
      if (alive.current) {
        setBookings(data.bookings);
        setRooms(data.rooms);
      }
    }
  }, [studentView]);
  useEffect(() => {
    refresh().catch((e) => {
      if (alive.current) setError(e.message);
    }).finally(() => {
      if (alive.current) setLoading(false);
    });
  }, [refresh]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "Não foi possível concluir.");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const loadTranscripts = async (roomId: string) => {
    const generation = ++reviewGeneration.current;
    setReviewRoom(roomId);
    setTranscripts([]);
    const data = await googleMeet<{ transcripts: Transcript[] }>(
      "transcripts",
      { roomId },
    );
    if (alive.current && generation === reviewGeneration.current) {
      setTranscripts(data.transcripts);
    }
  };
  const connect = () => {
    const popup = window.open(
      "about:blank",
      "wise-wolf-google",
      "width=620,height=760",
    );
    if (popup) popup.opener = null;
    void act(async () => {
      try {
        const data = await googleMeet<{ url: string }>("connect");
        const url = new URL(data.url);
        if (url.origin !== "https://accounts.google.com") {
          throw new Error("Endereço de autorização inválido.");
        }
        if (popup) popup.location.href = data.url;
        else window.location.assign(data.url);
        setNotice(
          "Depois de autorizar no Google, clique em Atualizar conexão.",
        );
      } catch (e) {
        popup?.close();
        throw e;
      }
    });
  };
  if (studentView && !loading && !rooms.length && !error) return null;
  return (
    <section
      className="bg-brand-surface border border-brand-border rounded-3xl p-5 sm:p-7 space-y-5 text-brand-text"
      aria-label="Aulas conectadas ao Google Meet"
    >
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Video size={22} /> Aulas conectadas
          </h3>
          <p className="text-sm text-brand-muted mt-1">
            Sala, histórico e preparação pedagógica no mesmo lugar.
          </p>
        </div>
        <button
          className={button}
          disabled={busy || loading}
          onClick={() => void act(refresh)}
        >
          <RefreshCw size={15} />
          {studentView ? "Atualizar salas" : "Atualizar conexão"}
        </button>
      </div>
      {loading && <p role="status">Carregando suas aulas…</p>}
      {error && <p role="alert" className="text-red-500">{error}</p>}
      {notice && <p role="status" className="text-emerald-600">{notice}</p>}
      {!studentView && status && !status.configured && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm">
          A integração está aguardando a configuração Google da escola. Seus
          links atuais continuam disponíveis abaixo.
        </div>
      )}
      {!studentView && status?.configured && (
        <div className="space-y-3">
          <p className="text-sm">
            {status.connected
              ? (
                <>
                  Conta organizadora:{" "}
                  <strong>{status.connection?.email}</strong>
                </>
              )
              : "Conecte a conta Google que você usará como professor. A escola recomenda uma conta Workspace com transcrição."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={connect}>
              {status.connected ? "Reconectar Google" : "Conectar Google"}
            </button>
            {status.connected && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await googleMeet("disconnect");
                    await refresh();
                    setNotice(
                      "Conta desconectada da plataforma. As salas e memórias já criadas foram preservadas.",
                    );
                  })}
              >
                Desconectar
              </button>
            )}
          </div>
          {status.connected && (
            <div className="p-4 bg-brand-surface-2 rounded-2xl space-y-3">
              <label
                className="text-sm font-semibold block"
                htmlFor="meet-booking"
              >
                Agendamento da sala
              </label>
              <select
                id="meet-booking"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setConsent(false);
                }}
                className="w-full p-3 rounded-xl bg-brand-surface border border-brand-border"
              >
                <option value="">Selecione o aluno e horário</option>
                {bookings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.student?.full_name || "Aluno"} · {b.day_of_week}{" "}
                    {b.time_slot}
                  </option>
                ))}
              </select>
              <label className="flex gap-2 items-start text-sm">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1"
                />Confirmei com os participantes a transcrição para
                acompanhamento pedagógico. Para menores, sigo a autorização do
                responsável.
              </label>
              <button
                className={button + " bg-blue-600 text-white"}
                disabled={busy || !selected || !consent}
                onClick={() =>
                  void act(async () => {
                    await googleMeet("create_room", {
                      bookingId: selected,
                      consentConfirmed: consent,
                    });
                    await refresh();
                    setNotice(
                      "Sala disponível. Entre com a mesma conta Google conectada e confira se a transcrição foi iniciada no Meet.",
                    );
                  })}
              >
                Criar sala com transcrição
              </button>
              <p className="text-xs text-brand-muted">
                A chamada abre no Google Meet. O vídeo não é gravado por esta
                integração. A transcrição depende da licença, das permissões e
                da entrada do organizador.
              </p>
            </div>
          )}
        </div>
      )}
      <div className="space-y-3">
        {rooms.map((room) => {
          const b = bookings.find((x) => x.id === room.booking_id);
          const link = safeMeetingLink(room.meeting_uri);
          return (
            <article
              key={room.id}
              className="p-4 rounded-2xl border border-brand-border space-y-2"
            >
              <strong>
                {studentView
                  ? "Sua sala de aula"
                  : b?.student?.full_name || "Aluno"}
                {b && (
                  <span className="font-normal text-brand-muted">
                    · {b.day_of_week} {b.time_slot}
                  </span>
                )}
              </strong>
              <div className="flex flex-wrap gap-2">
                {link && room.state === "READY"
                  ? (
                    <a
                      className={button}
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={15} />Entrar no Meet
                    </a>
                  )
                  : (
                    <p className="text-amber-600 text-sm">
                      Criação pendente de conferência pela equipe.
                    </p>
                  )}
                {!studentView && (
                  <>
                    <button
                      className={button}
                      disabled={busy || room.state !== "READY"}
                      onClick={() =>
                        void act(async () => {
                          const result = await googleMeet("sync", {
                            roomId: room.id,
                          });
                          await refresh();
                          await loadTranscripts(room.id);
                          setNotice(
                            result.busy
                              ? "Sincronização já em andamento."
                              : "Consulta concluída. As transcrições aparecem quando o Google termina de prepará-las.",
                          );
                        })}
                    >
                      <RefreshCw size={15} />Buscar transcrições
                    </button>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void act(() => loadTranscripts(room.id))}
                    >
                      <BookOpen size={15} />Histórico e preparação
                    </button>
                  </>
                )}
              </div>
              {!studentView && room.sync_error && (
                <p className="text-amber-600 text-sm">
                  A última sincronização não terminou. Verifique a conexão e
                  tente novamente.
                </p>
              )}
            </article>
          );
        })}
      </div>
      {!studentView && reviewRoom && (
        <div className="space-y-4 border-t border-brand-border pt-5">
          <h4 className="font-bold">Revisão do acompanhamento</h4>
          {!transcripts.length && (
            <p className="text-sm text-brand-muted">
              Ainda não há transcrições disponíveis para esta sala.
            </p>
          )}
          {transcripts.map((t) => (
            <TranscriptReview
              key={t.id}
              transcript={t}
              busy={busy}
              analysisConfigured={Boolean(status?.analysisConfigured)}
              onAnalyze={(learner) =>
                act(async () => {
                  await googleMeet("analyze", {
                    transcriptId: t.id,
                    learnerParticipant: learner,
                  });
                  await loadTranscripts(reviewRoom);
                })}
              onReview={(approve) =>
                act(async () => {
                  await googleMeet("review", { transcriptId: t.id, approve });
                  await loadTranscripts(reviewRoom);
                  setNotice(
                    approve
                      ? "Memória aprovada e disponível para o planejador e o teste oral."
                      : "Proposta rejeitada. Ela não será usada como memória do aluno.",
                  );
                })}
            />
          ))}
        </div>
      )}
    </section>
  );
};
const TranscriptReview: React.FC<
  {
    transcript: Transcript;
    busy: boolean;
    analysisConfigured: boolean;
    onAnalyze: (learner: string) => Promise<void>;
    onReview: (approve: boolean) => Promise<void>;
  }
> = ({ transcript: t, busy, analysisConfigured, onAnalyze, onReview }) => {
  const [learner, setLearner] = useState("");
  const labels: Record<string, string> = {
    IMPORTED: "Identificar aluno",
    ANALYZING: "Análise em processamento ou aguardando conferência",
    REVIEW: "Aguardando sua revisão",
    APPROVED: "Aprovada",
    REJECTED: "Rejeitada",
  };
  const p = t.proposal;
  const expired = Date.parse(t.raw_expires_at) < Date.now();
  return (
    <article className="p-4 rounded-2xl bg-brand-surface-2 space-y-3">
      <h5 className="font-bold">
        Aula de {new Date(t.occurred_at).toLocaleString("pt-BR")} ·{" "}
        {labels[t.state] || t.state}
      </h5>
      {t.state === "IMPORTED" && !expired && (
        <>
          <label className="text-sm block" htmlFor={"speaker-" + t.id}>
            Qual participante é o aluno? Confirme antes de analisar.
          </label>
          <select
            id={"speaker-" + t.id}
            className="w-full p-3 rounded-xl bg-brand-surface"
            value={learner}
            onChange={(e) => setLearner(e.target.value)}
          >
            <option value="">Selecione a pessoa</option>
            {t.participants.filter((x) => !x.isOrganizer).map((x) => (
              <option key={x.name} value={x.name}>{x.displayName}</option>
            ))}
          </select>
          <button
            className={button}
            disabled={busy || !learner || !analysisConfigured}
            onClick={() => void onAnalyze(learner)}
          >
            Preparar análise pedagógica
          </button>
          {!analysisConfigured && (
            <p className="text-sm">
              A análise ainda precisa ser habilitada pela escola.
            </p>
          )}
        </>
      )}
      {t.state === "IMPORTED" && expired && (
        <p>O prazo de acesso ao texto desta transcrição terminou.</p>
      )}
      {p && (
        <>
          <p>{p.summary}</p>
          {p.professional_context && (
            <p>
              <strong>Contexto profissional:</strong> {p.professional_context}
            </p>
          )}
          {([
            ["Interesses declarados", p.interests],
            ["Conteúdo praticado", p.practiced],
            ["Vocabulário", p.vocabulary],
            ["Dificuldades observadas", p.difficulties],
            ["Pontos fortes", p.strengths],
            ["Preparação do professor", p.teacher_preparation],
            ["Sugestões para teste oral", p.oral_test],
          ] as [string, string[]][]).map(([label, items]) =>
            items.length > 0 && (
              <div key={label}>
                <h6 className="text-sm font-bold">{label}</h6>
                <ul className="list-disc pl-5 text-sm">
                  {items.map((text, i) => <li key={i}>{text}</li>)}
                </ul>
              </div>
            )
          )}
          <p>
            <strong>Próxima aula:</strong> {p.next_lesson}
          </p>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              Conferir falas que sustentam a proposta
            </summary>
            {p.evidence.map((e, i) => (
              <blockquote key={i} className="border-l-2 pl-3 mt-2 text-sm">
                {e.quote}
              </blockquote>
            ))}
          </details>
          {t.state === "REVIEW" && (
            <>
              <p className="text-sm text-brand-muted">
                Confira o contexto e descarte falas de exercícios fictícios. Só
                aprove informações que correspondam ao aluno.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void onReview(true)}
                >
                  <CheckCircle size={15} />Aprovar memória
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void onReview(false)}
                >
                  Rejeitar proposta
                </button>
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
};

export default GoogleMeetClassroom;
