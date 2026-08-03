import {
  AudioLines,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cpu,
  FlaskConical,
  Gem,
  Globe2,
  Headphones,
  HeartPulse,
  Hotel,
  InfinityIcon,
  Keyboard,
  ListTree,
  Loader2,
  MessageCircle,
  MessageCircleMore,
  MessagesSquare,
  Mic2,
  Network,
  Plane,
  Presentation,
  RotateCcw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sprout,
  Target,
  Timer,
  Truck,
  UsersRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  PUBLIC_QUIZ_STEPS,
  PUBLIC_QUIZ_STORAGE_KEY,
  answerQuizStep,
  createQuizSnapshot,
  isQuizComplete,
  resolveQuizStart,
  serializeQuizSnapshot,
  type QuizAnswers,
  type QuizContext,
  type QuizGoal,
  type QuizStepId,
} from "../funnel/quizModel";
import { submitWolfieLead } from "../funnel/leadIntake";
import {
  clearQuizResult,
  markQuizLeadSent,
  readQuizResult,
  saveQuizResult,
  wasQuizLeadSent,
} from "../funnel/quizSession";
import { navigate, WolfieLink } from "../router";
import { WOLFIE_PRIVACY_NOTICE_VERSION } from "../privacy";
import { WolfieBrand } from "./PublicChrome";

const goalArt: Record<QuizGoal, { image: string; label: string }> = {
  global_meeting: {
    image: "/assets/wolfie/scenes/global-meetings/meetings-business/desktop.a5fc36b14418.webp",
    label: "Reunião global",
  },
  interview: {
    image: "/assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp",
    label: "Entrevista",
  },
  presentation: {
    image: "/assets/wolfie/scenes/skill-labs/presentation-lab/desktop.45863e9a8305.webp",
    label: "Apresentação",
  },
  travel: {
    image: "/assets/wolfie/scenes/daily-life/services/desktop.f4718b4b2fcc.webp",
    label: "Viagem",
  },
  conversation: {
    image: "/assets/wolfie/scenes/speaking/give-your-opinion/desktop.66b5facc2154.webp",
    label: "Conversação",
  },
};

const meetingContextArt: Record<QuizContext, string> = {
  business: "/assets/wolfie/scenes/global-meetings/meetings-business/desktop.a5fc36b14418.webp",
  technology: "/assets/wolfie/scenes/global-meetings/meetings-technology/desktop.cc9f82869f7f.webp",
  health: "/assets/wolfie/scenes/global-meetings/meetings-medicine/desktop.9d63442a60df.webp",
  laboratory: "/assets/wolfie/scenes/global-meetings/meetings-laboratories/desktop.cb1b23039a24.webp",
  beauty: "/assets/wolfie/scenes/global-meetings/meetings-beauty/desktop.d6a3e3f056eb.webp",
  retail: "/assets/wolfie/scenes/global-meetings/meetings-retail/desktop.4a0c5a2ff773.webp",
  logistics: "/assets/wolfie/scenes/global-meetings/meetings-logistics/desktop.b5f1816863cd.webp",
  tourism: "/assets/wolfie/scenes/global-meetings/meetings-tourism/desktop.8ff421493764.webp",
  aviation: "/assets/wolfie/scenes/global-meetings/meetings-aviation/desktop.cc878f5bad08.webp",
  general: "/assets/wolfie/scenes/global-meetings/meetings-business/desktop.a5fc36b14418.webp",
};

const iconForGoal: Record<QuizGoal, typeof BriefcaseBusiness> = {
  global_meeting: BriefcaseBusiness,
  interview: MessageCircleMore,
  presentation: Presentation,
  travel: Plane,
  conversation: Mic2,
};

const quizStepPresentation: Record<QuizStepId, {
  label: string;
  icon: LucideIcon;
}> = {
  goal: { label: "Objetivo", icon: Target },
  context: { label: "Contexto", icon: Building2 },
  participation: { label: "Ação", icon: MessageCircleMore },
  declaredAbility: { label: "Seu inglês", icon: BadgeCheck },
  obstacle: { label: "Foco", icon: Sparkles },
  modality: { label: "Formato", icon: Mic2 },
  urgency: { label: "Ritmo", icon: CalendarClock },
  practiceMinutes: { label: "Rotina", icon: Timer },
};

const optionIconByValue: Readonly<Record<string, LucideIcon>> = {
  global_meeting: BriefcaseBusiness,
  interview: MessageCircleMore,
  presentation: Presentation,
  travel: Plane,
  conversation: Mic2,
  business: Building2,
  technology: Cpu,
  health: HeartPulse,
  laboratory: FlaskConical,
  beauty: Sparkles,
  retail: ShoppingBag,
  logistics: Truck,
  tourism: Hotel,
  aviation: Plane,
  general: Globe2,
  understand: Headphones,
  respond: MessageCircle,
  lead: UsersRound,
  present: Presentation,
  starting: Sprout,
  short_exchanges: MessageCircle,
  routine_conversations: MessagesSquare,
  complex_conversations: Network,
  nuanced_conversations: Gem,
  thinking_time: Clock3,
  listening: AudioLines,
  vocabulary: BookOpen,
  pronunciation: Volume2,
  structure: ListTree,
  voice: Mic2,
  text: Keyboard,
  mixed: MessagesSquare,
  next_7_days: CalendarDays,
  next_30_days: CalendarClock,
  next_90_days: CalendarRange,
  ongoing: InfinityIcon,
  "5": Timer,
  "10": Timer,
  "15": Timer,
};

const calculationSteps = [
  "Organizando objetivo e contexto",
  "Combinando habilidade e formato",
  "Ajustando ritmo e tempo de prática",
] as const;

type QuizPhase = "questions" | "calculating" | "error";

const getAnswerLabel = (stepId: QuizStepId, value: string | undefined) =>
  PUBLIC_QUIZ_STEPS
    .find((candidate) => candidate.id === stepId)
    ?.options.find((option) => option.value === value)?.label;

const getAnsweredChoices = (answers: QuizAnswers) =>
  PUBLIC_QUIZ_STEPS.flatMap((candidate) => {
    const value = answers[candidate.id];
    const label = getAnswerLabel(candidate.id, value);
    return label ? [{ id: candidate.id, label }] : [];
  });

const readQuizStart = () => resolveQuizStart(
  window.location.search,
  localStorage.getItem(PUBLIC_QUIZ_STORAGE_KEY),
);

export function QuizPage() {
  const [quizStart] = useState(readQuizStart);
  const initial = quizStart.snapshot;
  const [answers, setAnswers] = useState<QuizAnswers>(initial.answers);
  const [stepIndex, setStepIndex] = useState(() =>
    Math.max(0, PUBLIC_QUIZ_STEPS.findIndex((step) => step.id === initial.currentStep))
  );
  const [phase, setPhase] = useState<QuizPhase>("questions");
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [calculationStage, setCalculationStage] = useState(0);
  const [direction, setDirection] = useState(1);
  const [quizError, setQuizError] = useState("");
  const step = PUBLIC_QUIZ_STEPS[stepIndex];
  const baseArt = answers.goal ? goalArt[answers.goal] : goalArt.global_meeting;
  const art = answers.goal === "global_meeting" && answers.context
    ? { ...baseArt, image: meetingContextArt[answers.context] }
    : baseArt;
  const answeredChoices = useMemo(() => getAnsweredChoices(answers), [answers]);
  const answeredCount = answeredChoices.length;
  const calculationProgress = [24, 58, 84, 100][calculationStage] ?? 24;
  const reducedMotion = Boolean(useReducedMotion());
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const calculationHeadingRef = useRef<HTMLHeadingElement>(null);
  const optionTimerRef = useRef<number | null>(null);
  const completionStartedRef = useRef(false);

  useEffect(() => {
    if (quizStart.cleanSearch !== null) {
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${quizStart.cleanSearch ? `?${quizStart.cleanSearch}` : ""}${window.location.hash}`,
      );
    }

    if (quizStart.shouldStartNew) {
      clearQuizResult();
      localStorage.setItem(
        PUBLIC_QUIZ_STORAGE_KEY,
        serializeQuizSnapshot(quizStart.snapshot),
      );
    } else if (quizStart.shouldRemoveStoredSnapshot) {
      localStorage.removeItem(PUBLIC_QUIZ_STORAGE_KEY);
    }
  }, [quizStart]);

  useEffect(() => {
    if (phase === "calculating") return;
    window.scrollTo({ top: 0, behavior: "auto" });
    const frame = window.requestAnimationFrame(() => questionHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [phase, stepIndex]);

  useEffect(() => () => {
    if (optionTimerRef.current !== null) window.clearTimeout(optionTimerRef.current);
  }, []);

  useEffect(() => {
    if (phase !== "calculating") return;

    window.scrollTo({ top: 0, behavior: "auto" });
    const frame = window.requestAnimationFrame(() => calculationHeadingRef.current?.focus());
    const timers: number[] = [];

    if (reducedMotion) {
      setCalculationStage(3);
    } else {
      timers.push(window.setTimeout(() => setCalculationStage(1), 650));
      timers.push(window.setTimeout(() => setCalculationStage(2), 1_300));
      timers.push(window.setTimeout(() => setCalculationStage(3), 1_900));
    }

    timers.push(window.setTimeout(
      () => navigate("/quiz/resultado", { replace: true }),
      reducedMotion ? 1_200 : 2_450,
    ));

    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [phase, reducedMotion]);

  const persist = (nextAnswers: QuizAnswers, nextIndex: number) => {
    const nextStep = PUBLIC_QUIZ_STEPS[nextIndex]?.id ?? step.id;
    localStorage.setItem(
      PUBLIC_QUIZ_STORAGE_KEY,
      serializeQuizSnapshot(createQuizSnapshot(nextAnswers, nextStep)),
    );
  };

  const selectOption = (value: string) => {
    if (pendingValue !== null || phase === "calculating" || completionStartedRef.current) return;

    const nextAnswers = answerQuizStep(answers, step.id, value as never);
    if (stepIndex === PUBLIC_QUIZ_STEPS.length - 1 && isQuizComplete(nextAnswers)) {
      completionStartedRef.current = true;
      try {
        localStorage.setItem(
          PUBLIC_QUIZ_STORAGE_KEY,
          serializeQuizSnapshot(createQuizSnapshot(nextAnswers, step.id)),
        );
        saveQuizResult(nextAnswers);
      } catch {
        completionStartedRef.current = false;
        setPhase("error");
        setQuizError("Não conseguimos guardar sua última escolha neste navegador. Tente novamente.");
        return;
      }
      setQuizError("");
      setAnswers(nextAnswers);
      setPendingValue(value);
      optionTimerRef.current = window.setTimeout(() => {
        setPendingValue(null);
        setCalculationStage(0);
        setPhase("calculating");
      }, reducedMotion ? 20 : 320);
      return;
    }

    const nextIndex = Math.min(stepIndex + 1, PUBLIC_QUIZ_STEPS.length - 1);
    try {
      persist(nextAnswers, nextIndex);
    } catch {
      setPhase("error");
      setQuizError("Não conseguimos guardar esta escolha neste navegador. Tente novamente.");
      return;
    }
    setQuizError("");
    setPhase("questions");
    setAnswers(nextAnswers);
    setPendingValue(value);
    setDirection(1);
    optionTimerRef.current = window.setTimeout(() => {
      setStepIndex(nextIndex);
      setPendingValue(null);
    }, reducedMotion ? 20 : 320);
  };

  const goBack = () => {
    if (pendingValue !== null || phase === "calculating") return;
    if (stepIndex === 0) {
      navigate("/");
      return;
    }
    const nextIndex = stepIndex - 1;
    try {
      persist(answers, nextIndex);
    } catch {
      setPhase("error");
      setQuizError("Não conseguimos atualizar esta etapa. Tente novamente.");
      return;
    }
    setQuizError("");
    setPhase("questions");
    setDirection(-1);
    setStepIndex(nextIndex);
  };

  return (
    <LazyMotion features={domAnimation}>
      <div className="min-h-screen bg-[#fffdfb] text-[#1d1e22]">
        <header className="sticky top-0 z-50 border-b border-black/[.06] bg-white/95 shadow-[0_8px_30px_rgba(24,25,30,.04)] backdrop-blur-xl">
          <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between px-5 sm:min-h-[72px] sm:px-8">
            <WolfieBrand />
            <div className="text-right">
              <p className="hidden text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#6f727a] sm:block">
                {phase === "calculating" ? "Preparando resultado" : "Diagnóstico personalizado"}
              </p>
              <p className="mt-0.5 text-xs font-extrabold text-[#34363b] sm:text-sm">
                <span className="sm:hidden">{phase === "calculating" ? `${calculationProgress}%` : `${answeredCount} resp.`}</span>
                <span className="hidden sm:inline">{phase === "calculating"
                  ? `${calculationProgress}% concluído`
                  : `${answeredCount} de ${PUBLIC_QUIZ_STEPS.length} ${answeredCount === 1 ? "resposta" : "respostas"}`}</span>
              </p>
            </div>
          </div>

          <div className="mx-auto max-w-[1600px] px-5 pb-3 sm:px-8 sm:pb-4">
            <div
              className="sr-only"
              role="progressbar"
              aria-label={phase === "calculating" ? "Preparação do diagnóstico" : "Respostas concluídas no diagnóstico"}
              aria-valuemin={0}
              aria-valuemax={phase === "calculating" ? 100 : PUBLIC_QUIZ_STEPS.length}
              aria-valuenow={phase === "calculating" ? calculationProgress : answeredCount}
              aria-valuetext={phase === "calculating" ? `${calculationProgress}% do diagnóstico preparado` : `${answeredCount} de ${PUBLIC_QUIZ_STEPS.length} respostas concluídas`}
            />
            <div className="mb-2 flex items-center justify-between gap-4 lg:hidden">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.13em] text-[#e72d3d]">
                {phase === "calculating" ? "Diagnóstico" : quizStepPresentation[step.id].label}
              </span>
              <span className="text-[11px] font-bold text-[#656870]">
                {phase === "calculating" ? "8 escolhas organizadas" : `Etapa ${stepIndex + 1} de 8`}
              </span>
            </div>
            <ol aria-label="Etapas do diagnóstico" className="grid grid-cols-8 gap-1.5 sm:gap-2">
              {PUBLIC_QUIZ_STEPS.map((candidate, index) => {
                const completed = Boolean(answers[candidate.id]) || phase === "calculating";
                const current = phase !== "calculating" && index === stepIndex;
                return (
                  <li key={candidate.id} aria-current={current ? "step" : undefined} className="min-w-0">
                    <span className="sr-only">{quizStepPresentation[candidate.id].label}{completed ? ", concluída" : current ? ", etapa atual" : ", ainda não respondida"}</span>
                    <span aria-hidden="true" className={`quiz-progress-segment block h-1.5 rounded-full transition-colors duration-300 ${completed ? "bg-[#e72d3d]" : current ? "bg-[#ff9a77] shadow-[0_0_0_3px_rgba(231,45,61,.10)]" : "bg-[#e8e8ea]"}`} />
                    <span aria-hidden="true" className={`mt-2 hidden truncate text-[10px] font-extrabold uppercase tracking-[0.09em] lg:block ${current ? "text-[#e72d3d]" : completed ? "text-[#47494f]" : "text-[#73767e]"}`}>
                      {quizStepPresentation[candidate.id].label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </header>

        {phase === "calculating" ? (
          <main className="px-5 py-7 sm:px-8 sm:py-10">
            <section className="mx-auto grid min-h-[calc(100vh-180px)] max-w-6xl overflow-hidden rounded-[34px] border border-black/[.07] bg-white shadow-[0_30px_100px_rgba(38,39,45,.10)] lg:grid-cols-[.9fr_1.1fr]">
              <div className="relative min-h-[210px] overflow-hidden lg:order-2 lg:min-h-full">
                <img src={art.image} alt={`Cenário de ${art.label}`} className="absolute inset-0 h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#17181c]/80 via-transparent to-white/10" />
                <div className="quiz-calculating-aura absolute left-1/2 top-1/2 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 bg-white/10 shadow-[0_0_80px_rgba(255,255,255,.30)] backdrop-blur-[2px]" />
                <div className="absolute inset-x-5 bottom-5 flex flex-wrap gap-2 lg:inset-x-8 lg:bottom-8">
                  {answeredChoices.slice(0, 4).map((choice) => (
                    <span key={choice.id} className="rounded-full border border-white/25 bg-white/90 px-3 py-1.5 text-[10px] font-extrabold text-[#37393e] shadow-lg backdrop-blur-md">
                      {choice.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center p-7 sm:p-10 lg:order-1 lg:p-14">
                <div className="w-full max-w-xl">
                  <p className="inline-flex items-center gap-2 rounded-full bg-[#fff0ec] px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.15em] text-[#bd2735]">
                    <Sparkles size={14} aria-hidden="true" /> Diagnóstico em construção
                  </p>
                  <h1 ref={calculationHeadingRef} tabIndex={-1} className="mt-5 font-display text-4xl font-extrabold leading-[1.02] tracking-[-0.05em] outline-none focus-visible:outline-none sm:text-5xl">
                    Calculando seu diagnóstico
                  </h1>
                  <p role="status" aria-live="polite" aria-atomic="true" className="mt-4 max-w-lg text-base leading-7 text-[#71757e]">
                    Estamos combinando somente as oito escolhas que você informou para montar seu primeiro treino.
                  </p>

                  <div className="mt-8 flex items-center gap-5 rounded-[26px] border border-[#e72d3d]/10 bg-[#fff8f5] p-5 sm:p-6">
                    <div className="relative grid h-20 w-20 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#e72d3d ${calculationProgress}%, #f0deda 0)` }} aria-hidden="true">
                      <div className="grid h-[66px] w-[66px] place-items-center rounded-full bg-white shadow-inner">
                        <span className="text-lg font-extrabold text-[#e72d3d]">{calculationProgress}%</span>
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="h-2 overflow-hidden rounded-full bg-[#eadfdb]" aria-hidden="true">
                        <m.div
                          className="h-full rounded-full bg-gradient-to-r from-[#e72d3d] via-[#ff7658] to-[#ffad77]"
                          animate={{ width: `${calculationProgress}%` }}
                          transition={{ duration: reducedMotion ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
                        />
                      </div>
                      <p className="mt-3 text-sm font-extrabold text-[#34363b]">
                        {calculationStage === 3 ? "Seu primeiro treino está pronto" : calculationSteps[Math.min(calculationStage, 2)]}
                      </p>
                      <p className="mt-1 text-xs text-[#8a8d95]">Sem teste secreto ou inferência de personalidade.</p>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3">
                    {calculationSteps.map((label, index) => {
                      const complete = calculationStage > index || calculationStage === 3;
                      const active = calculationStage === index && calculationStage < 3;
                      return (
                        <div key={label} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition ${complete ? "border-emerald-200 bg-emerald-50/70" : active ? "border-[#f2b7ae] bg-[#fff8f5]" : "border-black/[.06] bg-[#fafafa]"}`}>
                          <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${complete ? "bg-emerald-600 text-white" : active ? "bg-[#e72d3d] text-white" : "bg-[#e9e9eb] text-[#9c9fa6]"}`}>
                            {complete ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : active ? <Loader2 size={14} className="quiz-calculating-spinner animate-spin" aria-hidden="true" /> : <span className="text-[10px] font-extrabold">{index + 1}</span>}
                          </span>
                          <span className={`text-sm font-bold ${complete || active ? "text-[#35373c]" : "text-[#6d7078]"}`}>{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          </main>
        ) : (
          <main className="grid min-h-[calc(100vh-124px)] lg:grid-cols-[1.04fr_.96fr]">
            <section className="px-5 py-7 sm:px-10 sm:py-10 lg:px-[7vw] lg:py-12">
              <div className="mx-auto w-full max-w-2xl">
                <button disabled={pendingValue !== null} type="button" onClick={goBack} className="inline-flex min-h-11 items-center gap-2 rounded-full text-sm font-bold text-[#777b84] transition hover:text-[#202126] disabled:cursor-wait disabled:opacity-45">
                  <ArrowLeft size={17} aria-hidden="true" /> Voltar
                </button>

                <m.div
                  key={step.id}
                  initial={reducedMotion ? false : { opacity: 0, x: direction * 22 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.36, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="mt-5 flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#fff0ec] text-[#e72d3d]">
                      {(() => {
                        const StepIcon = quizStepPresentation[step.id].icon;
                        return <StepIcon size={17} aria-hidden="true" />;
                      })()}
                    </span>
                    <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#e72d3d]">{step.eyebrow}</p>
                  </div>
                  <h1 ref={questionHeadingRef} tabIndex={-1} className="mt-4 font-display text-[2.25rem] font-extrabold leading-[1.02] tracking-[-0.045em] outline-none focus-visible:outline-none sm:text-5xl">{step.title}</h1>
                  <p className="mt-4 text-base leading-7 text-[#737781]">{step.supportingText}</p>

                  <div className="relative mt-6 min-h-[148px] overflow-hidden rounded-[26px] bg-[#27282d] shadow-[0_18px_45px_rgba(38,39,44,.14)] lg:hidden">
                    <img src={art.image} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/25 to-transparent" />
                    <div className="absolute inset-0 flex flex-col justify-between p-4 text-white">
                      <div className="flex items-center justify-between gap-3">
                        <span className="rounded-full border border-white/20 bg-white/90 px-3 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#b92333] backdrop-blur-md">
                          {answers.goal ? art.label : "Seu cenário"}
                        </span>
                        <span className="rounded-full bg-black/35 px-3 py-1.5 text-[10px] font-bold backdrop-blur-md">{answeredCount} resp.</span>
                      </div>
                      <div>
                        <p className="max-w-[260px] font-display text-lg font-extrabold leading-tight">
                          {answeredCount ? "Seu treino já está tomando forma." : "Escolha o primeiro cenário da sua prática."}
                        </p>
                        {answeredChoices.length ? (
                          <div className="mt-2 flex max-w-full gap-1.5 overflow-hidden">
                            {answeredChoices.slice(-2).map((choice) => <span key={choice.id} className="max-w-[150px] truncate rounded-full bg-white/90 px-2.5 py-1 text-[9px] font-bold text-[#34363b]">{choice.id === "goal" && answers.goal ? goalArt[answers.goal].label : choice.label}</span>)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {quizError ? <p role="alert" className="mt-5 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" /> {quizError}</p> : null}

                  <div className={`mt-7 grid gap-3 ${step.id === "context" ? "min-[360px]:grid-cols-2" : step.id === "modality" || step.id === "practiceMinutes" ? "sm:grid-cols-3" : ""}`} role="group" aria-label={`Respostas para: ${step.title}`} aria-busy={pendingValue !== null}>
                    {step.options.map((option) => {
                      const selected = answers[step.id] === option.value;
                      const OptionIcon = optionIconByValue[option.value] ?? quizStepPresentation[step.id].icon;
                      const compact = step.id === "context";
                      const isMinutes = step.id === "practiceMinutes";
                      return (
                        <m.button
                          key={option.value}
                          type="button"
                          aria-label={option.label}
                          aria-pressed={selected}
                          disabled={pendingValue !== null}
                          onClick={() => selectOption(option.value)}
                          whileTap={reducedMotion ? undefined : { scale: 0.985 }}
                          className={`quiz-option-card group relative flex min-h-[72px] items-center gap-3 overflow-hidden rounded-[20px] border text-left transition duration-200 disabled:cursor-wait ${compact ? "px-3 py-3 sm:px-4" : "px-4 py-4 sm:px-5"} ${isMinutes ? "sm:flex-col sm:justify-center sm:text-center" : ""} ${selected ? "border-[#e72d3d] bg-[#fff1ed] shadow-[0_13px_36px_rgba(231,45,61,.11)]" : "border-black/[.08] bg-white shadow-[0_4px_14px_rgba(32,33,38,.025)] hover:-translate-y-0.5 hover:border-[#e72d3d]/40 hover:shadow-[0_12px_30px_rgba(32,33,38,.08)]"}`}
                        >
                          <span className={`grid shrink-0 place-items-center rounded-xl transition ${compact ? "h-9 w-9" : "h-11 w-11"} ${selected ? "bg-[#e72d3d] text-white" : "bg-[#f5f5f6] text-[#555860] group-hover:bg-[#fff0ec] group-hover:text-[#e72d3d]"}`}>
                            {selected ? <Check size={compact ? 17 : 19} strokeWidth={3} aria-hidden="true" /> : <OptionIcon size={compact ? 17 : 19} aria-hidden="true" />}
                          </span>
                          <span className={`min-w-0 flex-1 font-bold text-[#303238] ${compact ? "text-xs leading-[1.25] sm:text-sm" : "text-sm leading-5 sm:text-base"}`}>
                            {isMinutes ? <><strong className="block text-2xl leading-none sm:text-3xl">{option.value}</strong><span className="mt-1 block text-xs font-bold text-[#777b84]">minutos</span></> : option.label}
                          </span>
                          {selected ? <span className="hidden text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#b92333] sm:block">Escolhido</span> : !compact && !isMinutes ? <ChevronRight size={17} className="shrink-0 text-[#b3b5ba] transition group-hover:translate-x-0.5 group-hover:text-[#e72d3d]" aria-hidden="true" /> : null}
                        </m.button>
                      );
                    })}
                  </div>
                  <p className="mt-7 flex items-start gap-2 text-xs leading-5 text-[#878b94]"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#e72d3d]" aria-hidden="true" /> Guardamos aqui apenas escolhas do quiz, sem nome, e-mail ou telefone.</p>
                </m.div>
              </div>
            </section>

            <aside className="hidden p-5 pl-0 lg:block">
              <div className="sticky top-[138px] min-h-[620px] overflow-hidden rounded-[34px] bg-[#f4f4f5] shadow-[0_24px_80px_rgba(34,35,40,.12)]" style={{ height: "calc(100vh - 158px)" }}>
                <m.img key={art.image} src={art.image} alt={`Cenário de ${answers.goal ? art.label : "prática com o Wolfie"}`} className="absolute inset-0 h-full w-full object-cover" initial={reducedMotion ? false : { opacity: 0.6, scale: 1.03 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reducedMotion ? 0 : 0.55 }} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-white/10" />

                <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-7">
                  <p className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/90 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#b92333] shadow-lg backdrop-blur-md"><Target size={15} aria-hidden="true" /> {answers.goal ? art.label : "Seu cenário"}</p>
                  <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full p-1 shadow-xl" style={{ background: `conic-gradient(#e72d3d ${(answeredCount / PUBLIC_QUIZ_STEPS.length) * 100}%, rgba(255,255,255,.72) 0)` }} aria-hidden="true">
                    <div className="grid h-full w-full place-items-center rounded-full bg-white/95 text-center backdrop-blur-md"><span className="text-sm font-extrabold text-[#e72d3d]">{answeredCount}<small className="text-[9px] text-[#8d9097]">/8</small></span></div>
                  </div>
                </div>

                <div className="absolute inset-x-0 bottom-0 p-7 xl:p-9">
                  <div className="rounded-[28px] border border-white/30 bg-white/[.92] p-6 text-[#202126] shadow-[0_18px_60px_rgba(0,0,0,.18)] backdrop-blur-xl xl:p-7">
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#e72d3d]">Seu treino está tomando forma</p>
                      <Sparkles size={17} className="text-[#e72d3d]" aria-hidden="true" />
                    </div>
                    <p className="mt-3 font-display text-2xl font-extrabold leading-[1.08] tracking-[-0.03em]">
                      {answeredCount
                        ? `${answers.goal ? art.label : "Uma prática real"}${getAnswerLabel("context", answers.context) ? ` para ${getAnswerLabel("context", answers.context)?.toLowerCase()}` : ""}.`
                        : "Comece pela situação que você quer destravar."}
                    </p>
                    <div className="mt-5 flex min-h-16 flex-wrap content-start gap-2">
                      {answeredChoices.slice(-5).map((choice) => (
                        <m.span key={choice.id} layout initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-full truncate rounded-full border border-[#e72d3d]/10 bg-[#fff0ec] px-3 py-2 text-[10px] font-extrabold text-[#83303a]">
                          {choice.label}
                        </m.span>
                      ))}
                      {Array.from({ length: Math.max(0, 3 - answeredChoices.length) }).map((_, index) => <span key={`placeholder-${index}`} className="h-8 w-24 rounded-full border border-dashed border-black/15 bg-black/[.025]" aria-hidden="true" />)}
                    </div>
                    <p className="mt-4 border-t border-black/[.06] pt-4 text-xs leading-5 text-[#777b84]">A recomendação usa somente as respostas visíveis deste quiz — sem análise secreta.</p>
                  </div>
                </div>
              </div>
            </aside>
          </main>
        )}
      </div>
    </LazyMotion>
  );
}

export function QuizResultPage() {
  const result = useMemo(readQuizResult, []);
  const [lead, setLead] = useState({ name: "", email: "", phone: "", consent: false });
  const [state, setState] = useState<"idle" | "sending" | "sent">(() =>
    result && wasQuizLeadSent(result.leadRequestId) ? "sent" : "idle"
  );
  const [error, setError] = useState("");

  if (!result) {
    return (
      <div className="grid min-h-screen place-items-center bg-white px-5 text-[#202126]">
        <div className="max-w-lg text-center">
          <CircleAlert size={34} className="mx-auto text-[#e72d3d]" />
          <h1 className="mt-5 font-display text-3xl font-extrabold">Seu resultado ainda não está pronto</h1>
          <p className="mt-3 text-[#777b84]">Complete as oito etapas para receber uma recomendação coerente.</p>
          <WolfieLink href="/quiz" className="mt-7 inline-flex min-h-[52px] items-center gap-2 rounded-full bg-[#e72d3d] px-6 py-3.5 font-extrabold text-white">Continuar diagnóstico <ArrowRight size={17} /></WolfieLink>
        </div>
      </div>
    );
  }

  const { answers, recommendation } = result;
  const GoalIcon = iconForGoal[recommendation.goal];
  const image = goalArt[recommendation.goal].image;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setState("sending");
    try {
      await submitWolfieLead(
        lead,
        answers,
        recommendation,
        result.leadRequestId,
      );
      markQuizLeadSent(result.leadRequestId);
      setState("sent");
    } catch (cause) {
      setState("idle");
      setError(cause instanceof Error ? cause.message : "Não foi possível enviar.");
    }
  };

  return (
    <div className="min-h-screen bg-[#fbfbfc] text-[#202126]">
      <header className="flex min-h-20 items-center justify-between border-b border-black/[.06] bg-white px-5 sm:px-8"><WolfieBrand /><WolfieLink href="/quiz?novo=1" className="inline-flex items-center gap-2 text-sm font-bold text-[#747881] hover:text-[#202126]"><RotateCcw size={16} /> Refazer</WolfieLink></header>
      <main className="px-5 pb-20 pt-8 sm:pt-12">
        <div className="mx-auto max-w-6xl">
          <div className="grid overflow-hidden rounded-[36px] border border-black/[.07] bg-white shadow-[0_28px_90px_rgba(37,38,44,.09)] lg:grid-cols-[1.04fr_.96fr]">
            <section className="p-7 sm:p-10 lg:p-12">
              <p className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-[#e72d3d]"><BadgeCheck size={17} /> Recomendação pronta</p>
              <h1 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] tracking-[-0.05em] sm:text-6xl">{recommendation.title}</h1>
              <p className="mt-5 text-lg leading-8 text-[#6d727c]">{recommendation.summary}</p>
              <div className="mt-8 rounded-[26px] border border-[#e72d3d]/10 bg-[#fff0ec] p-6 text-[#202126]">
                <div className="flex items-start gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#e72d3d] text-white"><GoalIcon size={21} /></span>
                  <div>
                    <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#b92333]">Primeira experiência</p>
                    <h2 className="mt-1 font-display text-2xl font-extrabold">{recommendation.primary.title}</h2>
                    <p className="mt-2 text-sm font-semibold text-[#76555a]">{recommendation.primary.matchScore}% de aderência às escolhas · nível inicial autodeclarado {recommendation.startingLevel}</p>
                  </div>
                </div>
              </div>
              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-black/[.06] bg-[#fafafa] p-4"><CalendarClock size={19} className="text-[#e72d3d]" /><p className="mt-3 text-2xl font-extrabold">{recommendation.practicePlan.minutesPerSession} min</p><p className="text-xs text-[#858992]">por prática</p></div>
                <div className="rounded-2xl border border-black/[.06] bg-[#fafafa] p-4"><Target size={19} className="text-[#e72d3d]" /><p className="mt-3 text-2xl font-extrabold">{recommendation.practicePlan.sessionsPerWeek}×</p><p className="text-xs text-[#858992]">por semana</p></div>
                <div className="rounded-2xl border border-black/[.06] bg-[#fafafa] p-4"><Mic2 size={19} className="text-[#e72d3d]" /><p className="mt-3 text-2xl font-extrabold">{answers.modality === "voice" ? "Voz" : answers.modality === "text" ? "Texto" : "Misto"}</p><p className="text-xs text-[#858992]">formato inicial</p></div>
              </div>
              <div className="mt-7 rounded-2xl border border-black/[.06] bg-[#fafafa] p-5">
                <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#8b8f98]">Foco sugerido</p>
                <p className="mt-2 font-bold text-[#383a40]">{recommendation.practicePlan.focus}</p>
              </div>
              <p className="mt-5 text-xs leading-5 text-[#8b8f98]">{recommendation.disclaimer}</p>
              <WolfieLink href="/entrar?next=/app/praticar" className="mt-8 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[#202126] px-7 py-4 font-extrabold text-white sm:w-auto">Já sou aluno: praticar agora <ArrowRight size={18} /></WolfieLink>
            </section>
            <aside className="relative min-h-[360px] lg:min-h-full">
              <img src={image} alt="Cenário da experiência recomendada" className="absolute inset-0 h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent lg:bg-gradient-to-r lg:from-white/20 lg:via-transparent" />
              <div className="absolute inset-x-6 bottom-6 rounded-[24px] border border-white/[.14] bg-[#07111f]/[.82] p-5 backdrop-blur-xl">
                <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#ffb9ad]">Outras rotas possíveis</p>
                <div className="mt-3 grid gap-2">{recommendation.alternatives.map((item) => <div key={item.experienceId} className="flex items-center justify-between gap-4 rounded-xl bg-white/[.06] px-4 py-3"><span className="text-sm font-bold">{item.title}</span><span className="text-xs font-bold text-slate-400">{item.matchScore}%</span></div>)}</div>
              </div>
            </aside>
          </div>

          <section className="mx-auto mt-10 max-w-3xl rounded-[34px] bg-[#f5f1e9] p-7 text-[#111827] sm:p-10">
            {state === "sent" ? (
              <div className="py-5 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-emerald-700"><Check size={25} strokeWidth={3} /></span><h2 className="mt-5 font-display text-3xl font-extrabold">Plano enviado para a equipe</h2><p className="mt-3 text-slate-600">Seu pedido foi registrado. Não criaremos uma conta automaticamente nem faremos cobrança por este formulário.</p></div>
            ) : (
              <form onSubmit={submit}>
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#8c4d12]">Ainda não é aluno?</p>
                <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight">Peça para a equipe conversar com você.</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">Se preferir, você pode sair agora: seu resultado já apareceu e nenhum contato é obrigatório.</p>
                <div className="mt-7 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-bold text-slate-700">Nome<input required value={lead.name} onChange={(event) => setLead({ ...lead, name: event.target.value })} autoComplete="name" maxLength={120} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 font-medium outline-none focus:border-[#8c4d12] focus:ring-2 focus:ring-[#ffbf69]/40" /></label>
                  <label className="text-sm font-bold text-slate-700">E-mail<input required type="email" value={lead.email} onChange={(event) => setLead({ ...lead, email: event.target.value })} autoComplete="email" maxLength={254} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 font-medium outline-none focus:border-[#8c4d12] focus:ring-2 focus:ring-[#ffbf69]/40" /></label>
                  <label className="text-sm font-bold text-slate-700 sm:col-span-2">WhatsApp <span className="font-normal text-slate-500">(opcional)</span><input value={lead.phone} onChange={(event) => setLead({ ...lead, phone: event.target.value })} autoComplete="tel" inputMode="tel" maxLength={32} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 font-medium outline-none focus:border-[#8c4d12] focus:ring-2 focus:ring-[#ffbf69]/40" /></label>
                </div>
                <div className="mt-5 flex items-start gap-3 text-xs leading-5 text-slate-600">
                  <input id="wolfie-lead-consent" type="checkbox" checked={lead.consent} onChange={(event) => setLead({ ...lead, consent: event.target.checked })} aria-describedby="wolfie-consent-details" className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 accent-[#111827]" />
                  <div id="wolfie-consent-details">
                    <label htmlFor="wolfie-lead-consent" className="cursor-pointer">Autorizo a Wise Wolf a usar estes dados para entrar em contato sobre o Wolfie. Posso pedir a interrupção do contato a qualquer momento.</label>{" "}
                    <span>Li o <a href="/privacidade" target="_blank" rel="noreferrer" className="font-bold text-[#71410f] underline underline-offset-2">aviso de privacidade</a> e os <a href="/termos" target="_blank" rel="noreferrer" className="font-bold text-[#71410f] underline underline-offset-2">termos de uso</a> (versão {WOLFIE_PRIVACY_NOTICE_VERSION}).</span>
                  </div>
                </div>
                {error ? <p role="alert" className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><CircleAlert size={17} /> {error}</p> : null}
                <button disabled={state === "sending"} type="submit" className="mt-6 inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[#111827] px-7 py-3.5 font-extrabold text-white disabled:cursor-wait disabled:opacity-70">{state === "sending" ? <><Loader2 size={18} className="animate-spin" /> Enviando</> : <>Quero conversar com a equipe <ArrowRight size={18} /></>}</button>
              </form>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
