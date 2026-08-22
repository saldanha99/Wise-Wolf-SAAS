import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  Clock,
  Lock,
  MessageCircle,
  TrendingUp,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import {
  canonicalClaimPath,
  deriveOpportunityClaimSlot,
  isClaimGeneration,
  isOpportunityId,
  normalizeWhatsAppPhone,
  type OpportunityClaimRecord,
} from "../lib/opportunityClaim";

interface ClaimProps {
  opportunityId: string | null;
  generation: string | null;
}

interface ClaimResult {
  ok: boolean;
  idempotent?: boolean;
  opportunityId?: string;
  appointmentId?: string;
  kind?: string;
  studentName?: string;
  studentPhone?: string | null;
  startTime?: string;
  teacherName?: string;
  error?: string;
  message?: string;
}

function formatClaimInstant(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(timestamp));
}

const ClaimOpportunity: React.FC<ClaimProps> = ({ opportunityId, generation }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [professorName, setProfessorName] = useState("Professor(a)");
  const [opportunity, setOpportunity] = useState<OpportunityClaimRecord | null>(
    null,
  );
  const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);

  const slot = useMemo(
    () => deriveOpportunityClaimSlot(opportunity?.slots_proposed),
    [opportunity?.slots_proposed],
  );
  const isTraining = (claimResult?.kind || opportunity?.kind) === "TRAINING";
  const studentName = claimResult?.studentName || opportunity?.student_name ||
    (isTraining ? "Treinamento" : "Aluno(a)");
  const studentPhone = claimResult?.studentPhone ?? opportunity?.student_phone ??
    null;
  const confirmedDate = formatClaimInstant(claimResult?.startTime) || slot?.label ||
    "horário confirmado no painel";

  useEffect(() => {
    let active = true;

    const init = async () => {
      if (!isOpportunityId(opportunityId) || !isClaimGeneration(generation)) {
        window.history.replaceState(null, "", "/claim-opportunity");
        if (active) {
          setError("Este link de oportunidade é inválido.");
          setIsLoading(false);
        }
        return;
      }

      const claimGeneration = Number(generation);
      const cleanPath = canonicalClaimPath(opportunityId, claimGeneration);
      if (`${window.location.pathname}${window.location.search}` !== cleanPath) {
        window.history.replaceState(null, "", cleanPath);
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          setRedirecting(true);
          window.location.replace(
            `/login?redirectTo=${encodeURIComponent(cleanPath)}`,
          );
          return;
        }

        const { data: authData, error: authError } = await supabase.auth.getUser();
        if (authError || !authData.user) {
          setRedirecting(true);
          window.location.replace(
            `/login?redirectTo=${encodeURIComponent(cleanPath)}`,
          );
          return;
        }
        if (!active) return;
        setCurrentUserId(authData.user.id);

        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", authData.user.id)
          .maybeSingle();
        if (!active) return;
        setProfessorName(
          profile?.full_name?.trim() || authData.user.email || "Professor(a)",
        );

        const { data, error: opportunityError } = await supabase.rpc(
          "get_teacher_opportunity_preview_secure",
          {
            p_opportunity_id: opportunityId,
            p_claim_generation: claimGeneration,
          },
        );
        if (!active) return;
        const preview = data as (OpportunityClaimRecord & {
          ok?: boolean;
          error?: string;
        }) | null;
        if (opportunityError || !preview?.ok) {
          if (preview?.error === "claim_link_expired") {
            setError("Este link pertence a uma rodada anterior da oportunidade.");
            return;
          }
          setError("Esta oportunidade não foi encontrada ou não pertence à sua escola.");
          return;
        }

        const canonicalOpportunity = preview as OpportunityClaimRecord;
        if (canonicalOpportunity.claim_generation !== claimGeneration) {
          setError("Este link pertence a uma rodada anterior da oportunidade.");
          return;
        }
        const canonicalSlot = deriveOpportunityClaimSlot(
          canonicalOpportunity.slots_proposed,
        );
        if (!canonicalSlot) {
          setError("O horário desta oportunidade precisa ser revisado pela escola.");
          return;
        }
        setOpportunity(canonicalOpportunity);

        if ((canonicalOpportunity.status || "").toUpperCase() !== "OPEN") {
          if (
            canonicalOpportunity.winner_teacher_id === authData.user.id &&
            canonicalOpportunity.trial_appointment_id
          ) {
            setClaimResult({
              ok: true,
              idempotent: true,
              opportunityId: canonicalOpportunity.id,
              appointmentId: canonicalOpportunity.trial_appointment_id,
              kind: canonicalOpportunity.kind || "TRIAL",
              studentName: canonicalOpportunity.student_name,
              teacherName: profile?.full_name || "Professor(a)",
            });
          } else {
            setError("Esta oportunidade já foi preenchida.");
          }
        }
      } catch {
        if (active) {
          setError("Não foi possível validar esta oportunidade agora.");
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void init();
    return () => {
      active = false;
    };
  }, [generation, opportunityId]);

  const handleClaim = async () => {
    if (!opportunity || !currentUserId || !slot || claiming) return;
    setClaiming(true);
    setError("");
    try {
      const { data, error: invokeError } = await supabase.functions.invoke<ClaimResult>(
        "accept-opportunity",
        {
          body: {
            opportunityId: opportunity.id,
            generation: opportunity.claim_generation,
          },
        },
      );
      if (invokeError || !data?.ok) {
        throw new Error(
          data?.message ||
            "Não foi possível aceitar esta oportunidade. Atualize a página e tente novamente.",
        );
      }
      setClaimResult(data);
      setProfessorName(data.teacherName || professorName);
    } catch (claimError) {
      setError(
        claimError instanceof Error
          ? claimError.message
          : "Não foi possível aceitar esta oportunidade.",
      );
    } finally {
      setClaiming(false);
    }
  };

  if (redirecting) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface text-white">
        <div className="animate-spin mb-4">
          <Lock size={48} className="text-indigo-500" />
        </div>
        <p className="text-sm font-medium tracking-wider animate-pulse">
          REDIRECIONANDO PARA LOGIN...
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface text-white">
        <div className="animate-spin mb-4">
          <Lock size={48} className="text-indigo-500" />
        </div>
        <p className="text-sm font-medium tracking-wider animate-pulse">
          VERIFICANDO DISPONIBILIDADE...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-brand-surface-2 p-6 text-center">
        <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-6">
          <AlertCircle size={40} className="text-red-500" />
        </div>
        <h1 className="text-2xl font-bold text-brand-text mb-2">{error}</h1>
        <button
          onClick={() => window.location.href = "/"}
          className="mt-6 px-8 py-3 bg-slate-200 text-brand-text rounded-lg font-bold hover:bg-slate-300 transition-colors"
        >
          Voltar
        </button>
      </div>
    );
  }

  if (claimResult?.ok) {
    const firstName = studentName.trim().split(/\s+/)[0] || "Olá";
    const phone = normalizeWhatsAppPhone(studentPhone);
    const message = isTraining
      ? `Olá ${firstName}, sou ${professorName}. Confirmei minha participação no treinamento de ${confirmedDate}.`
      : `Olá ${firstName}, sou o professor ${professorName}! Sua aula experimental foi confirmada para ${confirmedDate}. Tudo certo para nosso encontro?`;
    const whatsappLink = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : null;

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-emerald-50 p-6 text-center animate-in zoom-in-95 duration-500">
        <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mb-6 shadow-lg shadow-emerald-200">
          <Check size={48} className="text-emerald-600" />
        </div>
        <h1 className="text-3xl font-black text-brand-text mb-2">
          {isTraining ? "🎉 Participação Confirmada!" : "🎉 Aula Confirmada!"}
        </h1>
        <p className="text-brand-muted mb-8 max-w-md mx-auto leading-relaxed">
          O agendamento está confirmado para <strong>{confirmedDate}</strong>.
        </p>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          {whatsappLink && !isTraining && (
            <a
              href={whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-4 bg-emerald-500 text-white rounded-xl font-bold shadow-lg shadow-emerald-200 flex items-center justify-center gap-2 hover:translate-y-[-2px] transition-all"
            >
              <MessageCircle size={24} />
              CHAMAR ALUNO AGORA
            </a>
          )}
          <button
            onClick={() => window.location.href = "/"}
            className="w-full py-4 bg-slate-200 text-brand-text rounded-xl font-bold hover:bg-slate-300 transition-colors"
          >
            Voltar ao Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-surface-2 flex flex-col font-sans">
      <div className="bg-brand-surface text-white pt-12 pb-24 px-6 rounded-b-[3rem] shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-400 via-slate-900 to-slate-900" />
        <div className="relative z-10 text-center">
          <span
            className={`inline-block py-1 px-3 rounded-full border text-[10px] font-black tracking-widest uppercase mb-4 backdrop-blur-md ${
              isTraining
                ? "bg-amber-500/20 border-amber-500/30 text-amber-300"
                : "bg-indigo-500/20 border-indigo-500/30 text-indigo-300"
            }`}
          >
            {isTraining ? "TREINAMENTO AO VIVO" : "AULA EXPERIMENTAL"}
          </span>
          <h1 className="text-4xl font-black mb-2 tracking-tight">
            {studentName}
          </h1>
        </div>
      </div>

      <div className="flex-1 px-6 -mt-16 pb-8 max-w-lg mx-auto w-full relative z-20">
        <div className="bg-brand-surface rounded-3xl shadow-xl p-1 border-4 border-white/50 backdrop-blur-sm">
          <div className="bg-brand-surface rounded-[1.3rem] p-6 border border-brand-border">
            <div className="grid gap-4 mb-8">
              <div className="flex items-center gap-4 p-4 bg-brand-surface-2 rounded-2xl border border-brand-border">
                <div className="w-12 h-12 rounded-xl bg-brand-surface shadow-sm flex items-center justify-center text-indigo-600 border border-indigo-50">
                  <Calendar size={24} />
                </div>
                <div>
                  <p className="text-[10px] text-brand-muted font-black uppercase tracking-wider">
                    DATA CONFIRMADA
                  </p>
                  <p className="text-lg font-bold text-brand-text leading-tight">
                    {slot?.label || "Horário indisponível"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4 p-4 bg-brand-surface-2 rounded-2xl border border-brand-border">
                <div className="w-12 h-12 rounded-xl bg-brand-surface shadow-sm flex items-center justify-center text-orange-600 border border-orange-50">
                  <Clock size={24} />
                </div>
                <div>
                  <p className="text-[10px] text-brand-muted font-black uppercase tracking-wider">
                    HORÁRIO
                  </p>
                  <p className="text-xl font-bold text-brand-text">
                    {slot?.time || "--:--"}
                  </p>
                </div>
              </div>
            </div>

            {opportunity?.interests && (
              <div className="mb-6 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                <p className="text-[10px] text-indigo-400 font-black uppercase tracking-wider mb-2 flex items-center gap-2">
                  <TrendingUp size={14} />
                  {isTraining ? "FOCO DO TREINAMENTO" : "INTERESSE DO ALUNO"}
                </p>
                <p className="text-sm font-medium text-indigo-900 leading-relaxed">
                  {opportunity.interests}
                </p>
              </div>
            )}

            <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-4 rounded-xl border border-amber-100/50 mb-6">
              <p className="text-amber-800 text-xs font-semibold leading-relaxed text-center flex items-start justify-center gap-2">
                <Clock size={14} className="mt-0.5 shrink-0" />
                <span>
                  Ao aceitar, o servidor validará sua associação e agenda antes
                  de confirmar este horário.
                </span>
              </p>
            </div>

            <button
              onClick={handleClaim}
              disabled={claiming || !slot}
              className="group w-full py-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-lg shadow-xl shadow-indigo-200 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-70 disabled:grayscale"
            >
              {claiming
                ? (
                  <>
                    <div className="w-6 h-6 border-4 border-white border-t-transparent rounded-full animate-spin" />
                    <span>VALIDANDO AGENDA...</span>
                  </>
                )
                : (
                  <>
                    <span>
                      {isTraining
                        ? "PARTICIPAR DO TREINAMENTO"
                        : "ACEITAR AULA"}
                    </span>
                    <ArrowRight
                      className="group-hover:translate-x-1 transition-transform"
                      strokeWidth={3}
                      size={20}
                    />
                  </>
                )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClaimOpportunity;
