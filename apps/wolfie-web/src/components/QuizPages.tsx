import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  MessageCircleMore,
  Mic2,
  Plane,
  Presentation,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
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
  type QuizGoal,
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

const iconForGoal: Record<QuizGoal, typeof BriefcaseBusiness> = {
  global_meeting: BriefcaseBusiness,
  interview: MessageCircleMore,
  presentation: Presentation,
  travel: Plane,
  conversation: Mic2,
};

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
  const step = PUBLIC_QUIZ_STEPS[stepIndex];
  const progress = ((stepIndex + 1) / PUBLIC_QUIZ_STEPS.length) * 100;
  const art = answers.goal ? goalArt[answers.goal] : goalArt.global_meeting;
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);

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
    window.scrollTo({ top: 0, behavior: "auto" });
    questionHeadingRef.current?.focus();
  }, [stepIndex]);

  const persist = (nextAnswers: QuizAnswers, nextIndex: number) => {
    const nextStep = PUBLIC_QUIZ_STEPS[nextIndex]?.id ?? step.id;
    localStorage.setItem(
      PUBLIC_QUIZ_STORAGE_KEY,
      serializeQuizSnapshot(createQuizSnapshot(nextAnswers, nextStep)),
    );
  };

  const selectOption = (value: string) => {
    const nextAnswers = answerQuizStep(answers, step.id, value as never);
    setAnswers(nextAnswers);
    if (stepIndex === PUBLIC_QUIZ_STEPS.length - 1 && isQuizComplete(nextAnswers)) {
      localStorage.setItem(
        PUBLIC_QUIZ_STORAGE_KEY,
        serializeQuizSnapshot(createQuizSnapshot(nextAnswers, step.id)),
      );
      saveQuizResult(nextAnswers);
      navigate("/quiz/resultado");
      return;
    }
    const nextIndex = Math.min(stepIndex + 1, PUBLIC_QUIZ_STEPS.length - 1);
    persist(nextAnswers, nextIndex);
    setStepIndex(nextIndex);
  };

  const goBack = () => {
    if (stepIndex === 0) {
      navigate("/");
      return;
    }
    const nextIndex = stepIndex - 1;
    persist(answers, nextIndex);
    setStepIndex(nextIndex);
  };

  return (
    <div className="min-h-screen bg-white text-[#1d1e22]">
      <header className="flex min-h-20 items-center justify-between border-b border-black/[.06] px-5 sm:px-8">
        <WolfieBrand />
        <span aria-live="polite" className="rounded-full bg-[#f5f5f6] px-4 py-2 text-xs font-extrabold text-[#727680]">Etapa {stepIndex + 1} de {PUBLIC_QUIZ_STEPS.length}</span>
      </header>
      <div role="progressbar" aria-label="Progresso do diagnóstico" aria-valuemin={1} aria-valuemax={PUBLIC_QUIZ_STEPS.length} aria-valuenow={stepIndex + 1} className="h-1 bg-black/[.05]"><div className="h-full bg-gradient-to-r from-[#e72d3d] to-[#ff8b61] transition-[width] duration-300" style={{ width: `${progress}%` }} /></div>
      <main className="grid min-h-[calc(100vh-84px)] lg:grid-cols-[1.02fr_.98fr]">
        <section className="flex px-5 py-10 sm:px-10 lg:px-[8vw] lg:py-16">
          <div className="m-auto w-full max-w-2xl">
            <button type="button" onClick={goBack} className="inline-flex min-h-11 items-center gap-2 rounded-full text-sm font-bold text-[#777b84] transition hover:text-[#202126]"><ArrowLeft size={17} /> Voltar</button>
            <p className="mt-7 text-xs font-extrabold uppercase tracking-[0.18em] text-[#e72d3d]">{step.eyebrow}</p>
            <h1 ref={questionHeadingRef} tabIndex={-1} className="mt-4 font-display text-4xl font-extrabold leading-[1.02] tracking-[-0.045em] outline-none sm:text-5xl">{step.title}</h1>
            <p className="mt-4 text-base leading-7 text-[#737781]">{step.supportingText}</p>
            <div className="mt-8 grid gap-3" role="group" aria-label={`Respostas para: ${step.title}`}>
              {step.options.map((option) => {
                const selected = answers[step.id] === option.value;
                return (
                  <button key={option.value} type="button" aria-pressed={selected} onClick={() => selectOption(option.value)} className={`group flex min-h-[68px] items-center gap-4 rounded-[20px] border px-5 py-4 text-left transition ${selected ? "border-[#e72d3d] bg-[#fff1ed] shadow-[0_10px_30px_rgba(231,45,61,.08)]" : "border-black/[.08] bg-white hover:border-black/20 hover:bg-[#fafafa]"}`}>
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${selected ? "border-[#e72d3d] bg-[#e72d3d] text-white" : "border-black/20"}`}>{selected ? <Check size={14} strokeWidth={3} /> : null}</span>
                    <span className="flex-1 font-bold text-[#303238]">{option.label}</span>
                    <ChevronRight size={18} className="text-[#b3b5ba] transition group-hover:translate-x-0.5 group-hover:text-[#686c75]" />
                  </button>
                );
              })}
            </div>
            <p className="mt-7 flex items-center gap-2 text-xs leading-5 text-[#878b94]"><ShieldCheck size={15} className="shrink-0 text-[#e72d3d]" /> Guardamos aqui apenas escolhas do quiz, sem nome, e-mail ou telefone.</p>
          </div>
        </section>
        <aside className="relative m-5 hidden overflow-hidden rounded-[34px] bg-[#f4f4f5] lg:block">
          <img src={art.image} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-12">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/90 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.14em] text-[#b92333] backdrop-blur-md"><Target size={15} /> {art.label}</p>
            <div className="mt-5 rounded-[28px] border border-white/30 bg-white/90 p-6 text-[#202126] shadow-xl backdrop-blur-xl">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#e72d3d]">O que estamos organizando</p>
              <p className="mt-3 text-2xl font-extrabold leading-tight">Um primeiro treino que combine situação, habilidade, nível declarado e tempo disponível.</p>
              <p className="mt-4 text-sm leading-6 text-[#6d727c]">Nada de análise secreta: a lógica do resultado usa somente as escolhas que você vê.</p>
            </div>
          </div>
        </aside>
      </main>
    </div>
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
