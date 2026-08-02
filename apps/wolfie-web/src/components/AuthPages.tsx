import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  Mic2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import React, { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadAppUser } from "../../../../lib/auth-user";
import { supabase } from "../../../../lib/supabase";
import { UserRole, type User } from "../../../../types";
import type { CefrLevel, WolfieUserSummary } from "../../../../src/components/wolfie/types";
import type { WolfieInitialIntent } from "../../../../src/components/wolfie/WolfiePracticeFlow";
import type {
  QuizObstacle,
  QuizParticipation,
  QuizUrgency,
} from "../funnel/quizModel";
import { clearQuizResult, readQuizResult } from "../funnel/quizSession";
import { navigate, safeAppNextPath, WolfieLink } from "../router";
import { WolfieBrand } from "./PublicChrome";

const WolfiePracticeFlow = React.lazy(() =>
  import("../../../../src/components/wolfie/WolfiePracticeFlow").then((module) => ({
    default: module.WolfiePracticeFlow,
  }))
);

const PARTICIPATION_INTENT = {
  understand: "entender o que as pessoas dizem",
  respond: "responder com clareza quando for chamado",
  lead: "conduzir a conversa e encaminhar decisões",
  present: "apresentar ideias e responder perguntas",
} satisfies Record<QuizParticipation, string>;

const URGENCY_INTENT = {
  next_7_days: "usar este inglês nos próximos sete dias",
  next_30_days: "usar este inglês nos próximos trinta dias",
  next_90_days: "usar este inglês nos próximos noventa dias",
  ongoing: "construir consistência sem um evento imediato",
} satisfies Record<QuizUrgency, string>;

const CORRECTION_BY_OBSTACLE = {
  thinking_time: "selective",
  listening: "end",
  vocabulary: "selective",
  pronunciation: "immediate",
  structure: "immediate",
} satisfies Record<
  QuizObstacle,
  NonNullable<WolfieInitialIntent["correctionMode"]>
>;

const DIFFICULTY_BY_URGENCY = {
  next_7_days: "challenging",
  next_30_days: "adaptive",
  next_90_days: "balanced",
  ongoing: "balanced",
} satisfies Record<
  QuizUrgency,
  NonNullable<WolfieInitialIntent["difficulty"]>
>;

const toWolfieUser = (user: User): WolfieUserSummary => ({
  id: user.id,
  name: user.name,
  module: user.module,
  occupation: user.occupation,
  studentCategory: user.studentCategory,
  isKids: user.isKids,
  interests: user.interests,
  preferredTopics: user.preferredTopics,
  wolfieSettings: user.wolfieSettings,
  englishFor: user.englishFor,
  shortTermGoal: user.shortTermGoal,
});

export function LoginPage() {
  const nextPath = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("next");
    return safeAppNextPath(raw, window.location.origin);
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) navigate(nextPath, { replace: true });
    });
    return () => { active = false; };
  }, [nextPath]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError || !data.user) {
        throw new Error("E-mail ou senha não conferem.");
      }

      const profile = await loadAppUser(data.user.id);
      if (!profile || profile.role !== UserRole.STUDENT) {
        await supabase.auth.signOut({ scope: "local" });
        throw new Error("Esta área está disponível para perfis de aluno com acesso ativo.");
      }
      navigate(nextPath, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível entrar.");
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen bg-[#07111f] text-white lg:grid-cols-[.92fr_1.08fr]">
      <main className="flex min-h-screen px-5 py-8 sm:px-10 lg:px-[8vw]">
        <div className="m-auto w-full max-w-md">
          <WolfieBrand />
          <WolfieLink href="/" className="mt-12 inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-white"><ArrowLeft size={16} /> Voltar ao início</WolfieLink>
          <p className="mt-10 text-xs font-extrabold uppercase tracking-[0.17em] text-[#ffbf69]">Área do aluno</p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-[-0.045em] sm:text-5xl">Continue sua prática.</h1>
          <p className="mt-4 leading-7 text-slate-400">Use as mesmas credenciais do sistema Wise Wolf. Por segurança, o subdomínio mantém uma sessão própria.</p>
          <form onSubmit={submit} className="mt-9 grid gap-5">
            <label className="text-sm font-bold text-slate-200">E-mail
              <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 min-h-[52px] w-full rounded-2xl border border-white/[.12] bg-white/[.055] px-4 text-base text-white outline-none transition placeholder:text-slate-600 focus:border-[#ffbf69] focus:ring-2 focus:ring-[#ffbf69]/20" placeholder="voce@exemplo.com" />
            </label>
            <label className="text-sm font-bold text-slate-200">Senha
              <span className="relative mt-2 block">
                <input required type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-[52px] w-full rounded-2xl border border-white/[.12] bg-white/[.055] px-4 pr-12 text-base text-white outline-none transition focus:border-[#ffbf69] focus:ring-2 focus:ring-[#ffbf69]/20" />
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-1 grid w-11 place-items-center text-slate-400 hover:text-white" aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
              </span>
            </label>
            {error ? <p role="alert" className="flex items-start gap-2 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"><CircleAlert size={17} className="mt-0.5 shrink-0" /> {error}</p> : null}
            <button type="submit" disabled={loading} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-[#ffbf69] px-7 py-4 font-extrabold text-[#111827] shadow-xl shadow-orange-500/15 transition hover:bg-[#ffd09a] disabled:cursor-wait disabled:opacity-70">{loading ? <><Loader2 size={18} className="animate-spin" /> Entrando</> : <>Entrar no Wolfie <ArrowRight size={18} /></>}</button>
          </form>
          <p className="mt-6 flex items-center gap-2 text-xs leading-5 text-slate-400"><ShieldCheck size={15} className="shrink-0" /> Sua senha é processada pelo serviço de autenticação e não é enviada para o quiz.</p>
        </div>
      </main>
      <aside className="relative hidden overflow-hidden border-l border-white/[.08] lg:block">
        <img src="/assets/wolfie/standalone/hero-global-studio.webp" alt="" className="absolute inset-0 h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#07111f] via-[#07111f]/15 to-transparent" />
        <div className="absolute inset-x-10 bottom-10 rounded-[32px] border border-white/[.14] bg-[#07111f]/[.78] p-7 backdrop-blur-xl">
          <p className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-emerald-300"><Mic2 size={16} /> Seu cenário continua aqui</p>
          <p className="mt-4 max-w-xl font-display text-3xl font-extrabold leading-tight">Entre, confirme o treino recomendado e comece pela situação que importa agora.</p>
        </div>
      </aside>
    </div>
  );
}

type AuthState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; user: User };

export function AuthenticatedWolfieApp() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const initialQuizResult = useRef(readQuizResult()).current;
  const [quizResult, setQuizResult] = useState(initialQuizResult);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session?.user) {
          const currentAppPath = safeAppNextPath(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
            window.location.origin,
          );
          navigate(`/entrar?next=${encodeURIComponent(currentAppPath)}`, { replace: true });
          return;
        }
        const user = await loadAppUser(data.session.user.id);
        if (!active) return;
        if (!user || user.role !== UserRole.STUDENT) {
          setAuth({ status: "error", message: "Seu perfil não possui acesso de aluno ao Wolfie." });
          return;
        }
        setAuth({ status: "ready", user });
        if (initialQuizResult) clearQuizResult();
      } catch {
        if (active) setAuth({ status: "error", message: "Não foi possível carregar sua conta agora." });
      }
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") navigate("/entrar", { replace: true });
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [initialQuizResult]);

  if (auth.status === "loading") {
    return <div className="grid min-h-screen place-items-center bg-[#07111f] text-white"><div className="text-center"><Loader2 size={32} className="mx-auto animate-spin text-[#ffbf69]" /><p className="mt-4 text-sm font-bold text-slate-400">Preparando seu Wolfie…</p></div></div>;
  }

  if (auth.status === "error") {
    return (
      <div className="grid min-h-screen place-items-center bg-[#07111f] px-5 text-white">
        <div className="max-w-lg text-center"><CircleAlert size={36} className="mx-auto text-amber-300" /><h1 className="mt-5 font-display text-3xl font-extrabold">Acesso não disponível</h1><p className="mt-3 text-slate-400">{auth.message}</p><button type="button" onClick={async () => { await supabase.auth.signOut({ scope: "local" }); }} className="mt-7 inline-flex min-h-[52px] items-center gap-2 rounded-full bg-white px-6 py-3.5 font-extrabold text-[#111827]"><LogOut size={17} /> Sair desta conta</button></div>
      </div>
    );
  }

  const wolfieUser = toWolfieUser(auth.user);
  const initialLevel = quizResult?.recommendation.startingLevel as CefrLevel | undefined;
  const initialIntent: WolfieInitialIntent | undefined = quizResult
    ? {
      modality: quizResult.answers.modality,
      minutesPerSession: quizResult.recommendation.practicePlan.minutesPerSession,
      focus: quizResult.recommendation.practicePlan.focus,
      participation: PARTICIPATION_INTENT[quizResult.answers.participation],
      urgency: URGENCY_INTENT[quizResult.answers.urgency],
      correctionMode: CORRECTION_BY_OBSTACLE[quizResult.answers.obstacle],
      difficulty: DIFFICULTY_BY_URGENCY[quizResult.answers.urgency],
    }
    : undefined;

  return (
    <div className="wolfie-product min-h-screen bg-[#07111f]">
      <header className="sticky top-0 z-40 border-b border-white/[.08] bg-[#07111f]/[.92] px-4 py-3 text-white backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4">
          <WolfieBrand />
          <div className="flex items-center gap-3">
            <span className="hidden text-right sm:block"><span className="block text-sm font-extrabold">{auth.user.name?.split(" ")[0]}</span><span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Aluno Wise Wolf</span></span>
            <button type="button" onClick={async () => { await supabase.auth.signOut({ scope: "local" }); }} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 text-slate-300 hover:bg-white/[.08] hover:text-white" aria-label="Sair"><LogOut size={18} /></button>
          </div>
        </div>
      </header>
      {quizResult ? (
        <div className="border-b border-amber-200/10 bg-[#ffbf69] px-4 py-3 text-[#111827]">
          <div className="mx-auto flex max-w-[1500px] items-center gap-3 text-sm"><Sparkles size={17} className="shrink-0" /><p><strong>Seu primeiro treino foi preparado:</strong> cenário {quizResult.recommendation.primary.title}, nível autodeclarado {quizResult.recommendation.startingLevel} e foco {quizResult.recommendation.practicePlan.focus}. Você confirma o formato antes de começar.</p></div>
        </div>
      ) : null}
      <main className="mx-auto max-w-[1500px] px-3 py-4 sm:px-5 sm:py-6">
        <Suspense fallback={<div className="grid min-h-[70vh] place-items-center rounded-3xl bg-white"><Loader2 size={30} className="animate-spin text-blue-600" /></div>}>
          <WolfiePracticeFlow
            user={wolfieUser}
            initialExperienceId={quizResult?.recommendation.primary.experienceId}
            initialLevel={initialLevel}
            initialIntent={initialIntent}
            onInitialIntentConsumed={() => setQuizResult(null)}
          />
        </Suspense>
      </main>
    </div>
  );
}
