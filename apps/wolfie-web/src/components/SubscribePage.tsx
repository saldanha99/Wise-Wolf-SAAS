import type { Session } from "@supabase/supabase-js";
import {
  ArrowLeft,
  ArrowRight,
  Barcode,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  LogOut,
  Mic2,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "../../../../lib/supabase";
import {
  formatWolfiePrice,
  resolveWolfiePlan,
  toWolfieCheckoutPlanCode,
  WOLFIE_STANDALONE_TERMS_VERSION,
} from "../funnel/wolfiePlans";
import { readQuizResult } from "../funnel/quizSession";
import { navigate, useWolfiePath, WolfieLink } from "../router";
import { WolfieBrand } from "./PublicChrome";

type AuthMode = "signup" | "login";
type BillingType = "PIX" | "BOLETO";

type CheckoutResult = {
  planName?: string;
  amount?: number;
  status?: string;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  pix?: {
    copyPaste?: string | null;
    qrCode?: string | null;
  } | null;
};

type PreparedAccount = {
  ok?: boolean;
  accountId?: string;
  tenantId?: string;
  accessKind?: string;
  alreadyIncluded?: boolean;
};

const onlyDigits = (value: string) => value.replace(/\D/g, "");

const formatCpf = (value: string) => {
  const digits = onlyDigits(value).slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
};

const isValidCpf = (value: string) => {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const calculateDigit = (length: number) => {
    const sum = digits
      .slice(0, length)
      .split("")
      .reduce((total, digit, index) =>
        total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return calculateDigit(9) === Number(digits[9]) &&
    calculateDigit(10) === Number(digits[10]);
};

const qrCodeSource = (qrCode: string | null | undefined) => {
  if (!qrCode) return null;
  return qrCode.startsWith("data:")
    ? qrCode
    : `data:image/png;base64,${qrCode}`;
};

const paymentLabel = (billingType: BillingType) =>
  billingType === "PIX" ? "PIX" : "boleto";

export function SubscribePage() {
  const route = useWolfiePath();
  const plan = useMemo(() => {
    const query = route.includes("?") ? route.slice(route.indexOf("?")) : "";
    return resolveWolfiePlan(new URLSearchParams(query).get("planCode"));
  }, [route]);
  const quizResult = useMemo(readQuizResult, []);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [phone, setPhone] = useState("");
  const [billingType, setBillingType] = useState<BillingType>("PIX");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setInitializing(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      setInitializing(false);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    setEmail(session.user.email ?? "");
    setFullName((current) => current ||
      String(session.user.user_metadata?.full_name ?? ""));
    setConfirmationSent(false);
  }, [session]);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (authMode === "signup" && fullName.trim().length < 3) {
      setError("Informe seu nome completo.");
      return;
    }
    if (password.length < 8) {
      setError("Use uma senha com pelo menos 8 caracteres.");
      return;
    }

    setAuthLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (authMode === "signup") {
        const redirectQuery = new URLSearchParams({
          planCode: plan.code,
          source: "checkout",
        });
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            emailRedirectTo:
              `${window.location.origin}/assinar?${redirectQuery.toString()}`,
            data: {
              full_name: fullName.trim(),
              hub_audience: "LEARNER",
              wolfie_plan_code: plan.code,
            },
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setConfirmationSent(true);
          return;
        }
        setSession(data.session);
      } else {
        const { data, error: signInError } =
          await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          });
        if (signInError || !data.session) throw signInError ?? new Error();
        setSession(data.session);
      }
      setPassword("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.toLowerCase() : "";
      if (message.includes("invalid login")) {
        setError("E-mail ou senha não conferem.");
      } else if (message.includes("already registered") || message.includes("already exists")) {
        setError("Este e-mail já tem uma conta. Escolha “Entrar”.");
      } else {
        setError("Não foi possível preparar seu acesso agora. Tente novamente.");
      }
    } finally {
      setAuthLoading(false);
    }
  };

  const reviewCheckout = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (fullName.trim().length < 3) {
      setError("Informe seu nome completo.");
      return;
    }
    if (!isValidCpf(cpfCnpj)) {
      setError("Confira o CPF informado.");
      return;
    }
    const phoneDigits = onlyDigits(phone);
    if (phoneDigits.length < 10 || phoneDigits.length > 13) {
      setError("Informe um telefone com DDD.");
      return;
    }
    if (!acceptedTerms) {
      setError("Leia e aceite os termos antes de continuar.");
      return;
    }
    setReviewing(true);
  };

  const submitCheckout = async () => {
    if (!session?.user?.email) {
      setError("Sua sessão expirou. Entre novamente para continuar.");
      setSession(null);
      return;
    }
    setCheckoutLoading(true);
    setError("");
    try {
      const quizPayload = quizResult
        ? {
          version: quizResult.version,
          answers: quizResult.answers,
          recommendation: quizResult.recommendation,
        }
        : null;
      const { data: accountData, error: accountError } = await supabase.rpc(
        "wolfie_prepare_checkout_account",
        {
          p_full_name: fullName.trim(),
          p_terms_version: WOLFIE_STANDALONE_TERMS_VERSION,
          p_quiz: quizPayload,
        },
      );
      if (accountError) throw accountError;
      const prepared = (Array.isArray(accountData)
        ? accountData[0]
        : accountData) as PreparedAccount | null;
      if (
        prepared?.ok &&
        (prepared.accessKind === "SCHOOL" || prepared.alreadyIncluded)
      ) {
        navigate("/app/praticar", { replace: true });
        return;
      }
      if (
        !prepared?.ok || prepared.accessKind !== "STANDALONE" ||
        !prepared.accountId
      ) {
        throw new Error("ACCOUNT_PREPARATION_FAILED");
      }

      const { data: checkoutData, error: invokeError } =
        await supabase.functions.invoke("create-hub-checkout", {
          body: {
            accountId: prepared.accountId,
            planCode: toWolfieCheckoutPlanCode(plan.code),
            billingCycle: "MONTHLY",
            billingType,
            name: fullName.trim(),
            email: session.user.email,
            cpfCnpj: onlyDigits(cpfCnpj),
            phone: onlyDigits(phone),
            requestKey,
            productFamily: "WOLFIE_STANDALONE",
            termsVersion: WOLFIE_STANDALONE_TERMS_VERSION,
          },
        });
      if (invokeError) {
        let functionCode = invokeError.message;
        const context = (invokeError as { context?: Response }).context;
        if (context) {
          try {
            const payload = await context.clone().json() as {
              code?: string;
              error?: string;
            };
            functionCode = payload.code ?? payload.error ?? functionCode;
          } catch {
            // Mantém a mensagem segura fornecida pelo cliente Supabase.
          }
        }
        throw new Error(functionCode);
      }
      if (checkoutData?.error) {
        throw new Error(String(checkoutData.code ?? checkoutData.error));
      }
      setResult(checkoutData as CheckoutResult);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code.includes("CHECKOUT_IN_PROGRESS")) {
        setError("Sua cobrança já está sendo preparada. Aguarde alguns segundos e tente novamente.");
      } else if (code.includes("WOLFIE_CHECKOUT_TEMPORARILY_UNAVAILABLE")) {
        setError("A abertura de novas assinaturas está em preparação. Nenhuma cobrança foi criada. Tente novamente mais tarde.");
      } else if (code.includes("INVALID_CHECKOUT_DATA")) {
        setError("Algum dado não passou pela validação. Revise CPF e telefone.");
      } else if (code.toLowerCase().includes("session") || code.toLowerCase().includes("jwt")) {
        setError("Sua sessão expirou. Entre novamente para continuar.");
      } else {
        setError("Não foi possível gerar a cobrança. Nenhum pagamento foi confirmado. Tente novamente.");
      }
    } finally {
      setCheckoutLoading(false);
    }
  };

  const switchAccount = async () => {
    setError("");
    await supabase.auth.signOut({ scope: "local" });
    setSession(null);
    setReviewing(false);
    setResult(null);
    setEmail("");
    setPassword("");
    setAuthMode("login");
  };

  const copyPix = async () => {
    const code = result?.pix?.copyPaste;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2400);
  };

  const activeStep = result ? 2 : session ? 1 : 0;
  const paymentUrl = result?.bankSlipUrl || result?.invoiceUrl;
  const qrSource = qrCodeSource(result?.pix?.qrCode);

  return (
    <div className="min-h-screen bg-[#f7f7f8] text-[#202126]">
      <header className="border-b border-black/[.06] bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <WolfieBrand />
          <WolfieLink href="/planos" className="inline-flex items-center gap-2 text-sm font-extrabold text-[#686d77] hover:text-[#202126]">
            <ArrowLeft size={16} aria-hidden="true" /> Planos
          </WolfieLink>
        </div>
      </header>

      <main className="px-5 py-8 sm:py-12 lg:py-16">
        <div className="mx-auto grid max-w-7xl gap-7 lg:grid-cols-[1.08fr_.92fr] lg:items-start">
          <section className="rounded-[34px] border border-black/[.07] bg-white p-6 shadow-[0_24px_75px_rgba(35,36,41,.08)] sm:p-9 lg:p-11">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <p className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.17em] text-[#d1263a]">
                  <LockKeyhole size={15} aria-hidden="true" /> Assinatura Wolfie
                </p>
                <h1 className="mt-3 font-display text-3xl font-extrabold tracking-[-.045em] sm:text-4xl">
                  {result
                    ? "Cobrança criada com segurança"
                    : !session
                    ? "Crie seu acesso"
                    : reviewing
                    ? "Revise antes de gerar"
                    : "Complete seus dados"}
                </h1>
              </div>
              <span className="rounded-full bg-[#fff0ec] px-4 py-2 text-xs font-extrabold text-[#b92333]">
                Plano {plan.name}
              </span>
            </div>

            <div className="mt-8 grid grid-cols-3 gap-2">
              {["Conta", "Dados", "Pagamento"].map((label, index) => (
                <div key={label}>
                  <div className={`h-1.5 rounded-full ${index <= activeStep ? "bg-[#e72d3d]" : "bg-[#ececef]"}`} />
                  <p className={`mt-2 text-[9px] font-extrabold uppercase tracking-[.1em] ${index <= activeStep ? "text-[#b92333]" : "text-[#a2a5ac]"}`}>{label}</p>
                </div>
              ))}
            </div>

            {initializing ? (
              <div className="grid min-h-[430px] place-items-center text-center">
                <div><Loader2 size={30} className="mx-auto animate-spin text-[#e72d3d]" /><p className="mt-4 font-bold text-[#777b84]">Verificando seu acesso...</p></div>
              </div>
            ) : result ? (
              <div className="py-8 text-center">
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-emerald-700"><CheckCircle2 size={30} /></span>
                <h2 className="mt-6 font-display text-3xl font-extrabold">Falta confirmar o pagamento</h2>
                <p className="mx-auto mt-3 max-w-lg leading-7 text-[#6d727c]">O acesso ao Wolfie será liberado automaticamente somente depois que o pagamento for confirmado.</p>

                {qrSource ? <img src={qrSource} alt="QR Code para pagamento por PIX" width={224} height={224} className="mx-auto mt-7 h-56 w-56 rounded-[24px] border border-black/10 bg-white p-3" /> : null}
                {result.pix?.copyPaste ? (
                  <button type="button" onClick={() => void copyPix()} className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-[#202126] px-6 py-3 text-sm font-extrabold text-white">
                    {copied ? <Check size={17} /> : <Copy size={17} />} {copied ? "PIX copiado" : "Copiar código PIX"}
                  </button>
                ) : null}
                {paymentUrl ? (
                  <a href={paymentUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-full bg-[#202126] px-6 py-3 text-sm font-extrabold text-white">
                    Abrir cobrança <ArrowRight size={16} />
                  </a>
                ) : null}

                <div className="mx-auto mt-8 max-w-lg rounded-[24px] border border-amber-200 bg-amber-50 p-5 text-left">
                  <p className="font-extrabold text-amber-900">O que acontece agora</p>
                  <p className="mt-2 text-sm leading-6 text-amber-800">Pague pelo canal escolhido e aguarde a confirmação. PIX costuma ser reconhecido mais rapidamente; boleto depende da compensação bancária.</p>
                </div>
                <WolfieLink href="/entrar?next=/app/praticar" className="mt-7 inline-flex min-h-14 items-center gap-2 rounded-full bg-[#e72d3d] px-7 py-4 font-extrabold text-white shadow-[0_14px_35px_rgba(218,38,57,.2)]">Ir para o acesso do Wolfie <ArrowRight size={18} /></WolfieLink>
                <p className="mt-4 text-xs text-[#858992]">Se o pagamento ainda estiver pendente, a área de prática aguardará a confirmação.</p>
              </div>
            ) : !session ? (
              confirmationSent ? (
                <div className="py-12 text-center">
                  <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#fff0ec] text-[#d1263a]">✉️</span>
                  <h2 className="mt-6 font-display text-3xl font-extrabold">Confirme seu e-mail</h2>
                  <p className="mx-auto mt-3 max-w-md leading-7 text-[#6d727c]">Enviamos um link para <strong className="text-[#202126]">{email}</strong>. Depois da confirmação, você volta para este plano e continua o checkout.</p>
                  <button type="button" onClick={() => { setConfirmationSent(false); setAuthMode("login"); setError(""); }} className="mt-7 font-extrabold text-[#c52335] underline underline-offset-4">Já confirmei: entrar</button>
                </div>
              ) : (
                <div className="mt-8">
                  <div className="grid grid-cols-2 gap-1 rounded-full bg-[#f1f1f3] p-1.5">
                    <button type="button" onClick={() => { setAuthMode("signup"); setError(""); }} className={`rounded-full px-4 py-3 text-sm font-extrabold transition ${authMode === "signup" ? "bg-white text-[#202126] shadow-sm" : "text-[#777b84]"}`}>Criar conta</button>
                    <button type="button" onClick={() => { setAuthMode("login"); setError(""); }} className={`rounded-full px-4 py-3 text-sm font-extrabold transition ${authMode === "login" ? "bg-white text-[#202126] shadow-sm" : "text-[#777b84]"}`}>Já tenho conta</button>
                  </div>
                  <form onSubmit={submitAuth} className="mt-7 grid gap-5">
                    {authMode === "signup" ? (
                      <label className="text-sm font-bold text-[#4a4e56]">Nome completo
                        <input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} className="mt-2 min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" placeholder="Como devemos chamar você?" />
                      </label>
                    ) : null}
                    <label className="text-sm font-bold text-[#4a4e56]">E-mail
                      <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} className="mt-2 min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" placeholder="voce@exemplo.com" />
                    </label>
                    <label className="text-sm font-bold text-[#4a4e56]">Senha
                      <span className="relative mt-2 block">
                        <input required type={showPassword ? "text" : "password"} autoComplete={authMode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 pr-12 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" placeholder="Mínimo de 8 caracteres" />
                        <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-1 grid w-11 place-items-center text-[#858992]" aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
                      </span>
                    </label>
                    {error ? <p role="alert" className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
                    <button type="submit" disabled={authLoading} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-[#e72d3d] px-7 py-4 font-extrabold text-white disabled:cursor-wait disabled:opacity-65">{authLoading ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}{authLoading ? "Preparando..." : authMode === "signup" ? "Criar acesso e continuar" : "Entrar e continuar"}</button>
                  </form>
                  <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-[#858992]"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#e72d3d]" /> A conta é necessária para associar a assinatura ao seu acesso. Nenhuma cobrança é criada nesta etapa.</p>
                </div>
              )
            ) : reviewing ? (
              <div className="mt-8">
                <div className="rounded-[26px] border border-[#e72d3d]/10 bg-[#fff0ec] p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div><p className="text-xs font-extrabold uppercase tracking-[.12em] text-[#b92333]">Plano {plan.name} · mensal</p><p className="mt-2 font-display text-4xl font-extrabold text-[#202126]">R$ {formatWolfiePrice(plan.monthlyPrice)}</p></div>
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-emerald-600"><Check size={20} /></span>
                  </div>
                </div>
                <dl className="mt-5 divide-y divide-black/[.06] rounded-[26px] border border-black/[.07] px-5">
                  <div className="py-4"><dt className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#92959c]">Assinante</dt><dd className="mt-1 font-bold">{fullName}</dd></div>
                  <div className="py-4"><dt className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#92959c]">Conta</dt><dd className="mt-1 break-all font-bold">{session.user.email}</dd></div>
                  <div className="py-4"><dt className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#92959c]">Pagamento</dt><dd className="mt-1 font-bold">{paymentLabel(billingType)} · recorrência mensal</dd></div>
                  <div className="py-4"><dt className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#92959c]">Franquia</dt><dd className="mt-1 font-bold">{plan.liveMinutes} minutos de voz por mês</dd></div>
                </dl>
                {error ? <p role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
                <button type="button" onClick={() => void submitCheckout()} disabled={checkoutLoading} className="mt-6 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[#e72d3d] px-7 py-4 font-extrabold text-white disabled:cursor-wait disabled:opacity-65">{checkoutLoading ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />}{checkoutLoading ? "Gerando cobrança..." : `Confirmar e gerar ${paymentLabel(billingType)}`}</button>
                <button type="button" onClick={() => { setReviewing(false); setError(""); }} disabled={checkoutLoading} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 text-sm font-extrabold text-[#6d727c]"><ArrowLeft size={16} /> Corrigir dados</button>
                <p className="mt-4 text-center text-xs leading-5 text-[#8b8f98]">Ao confirmar, uma cobrança mensal será criada. Isso não significa que o pagamento já foi realizado.</p>
              </div>
            ) : (
              <form onSubmit={reviewCheckout} className="mt-8 grid gap-5">
                <div className="flex items-center justify-between gap-4 rounded-2xl bg-[#f6f6f7] px-4 py-3 text-sm">
                  <div className="min-w-0"><p className="text-xs text-[#858992]">Conta da assinatura</p><p className="truncate font-extrabold">{session.user.email}</p></div>
                  <button type="button" onClick={() => void switchAccount()} className="inline-flex shrink-0 items-center gap-1.5 font-extrabold text-[#b92333]"><LogOut size={15} /> Trocar</button>
                </div>
                <label className="text-sm font-bold text-[#4a4e56]">Nome completo
                  <input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} className="mt-2 min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" />
                </label>
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="text-sm font-bold text-[#4a4e56]">CPF
                    <input required inputMode="numeric" autoComplete="off" value={cpfCnpj} onChange={(event) => setCpfCnpj(formatCpf(event.target.value))} maxLength={14} className="mt-2 min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" placeholder="000.000.000-00" />
                  </label>
                  <label className="text-sm font-bold text-[#4a4e56]">Telefone com DDD
                    <input required inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={20} className="mt-2 min-h-[52px] w-full rounded-2xl border border-black/10 bg-[#fafafa] px-4 outline-none focus:border-[#e72d3d] focus:ring-2 focus:ring-[#e72d3d]/15" placeholder="(11) 99999-9999" />
                  </label>
                </div>
                <fieldset>
                  <legend className="text-sm font-bold text-[#4a4e56]">Como deseja pagar?</legend>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <button type="button" onClick={() => setBillingType("PIX")} className={`rounded-[22px] border p-4 text-left transition ${billingType === "PIX" ? "border-[#e72d3d] bg-[#fff0ec] ring-2 ring-[#e72d3d]/10" : "border-black/10 bg-white"}`}><Smartphone size={20} className={billingType === "PIX" ? "text-[#d1263a]" : "text-[#777b84]"} /><p className="mt-3 font-extrabold">PIX</p><p className="mt-1 text-[11px] text-[#777b84]">Confirmação mais rápida</p></button>
                    <button type="button" onClick={() => setBillingType("BOLETO")} className={`rounded-[22px] border p-4 text-left transition ${billingType === "BOLETO" ? "border-[#e72d3d] bg-[#fff0ec] ring-2 ring-[#e72d3d]/10" : "border-black/10 bg-white"}`}><Barcode size={20} className={billingType === "BOLETO" ? "text-[#d1263a]" : "text-[#777b84]"} /><p className="mt-3 font-extrabold">Boleto</p><p className="mt-1 text-[11px] text-[#777b84]">Aguarda compensação</p></button>
                  </div>
                </fieldset>
                <label className="flex cursor-pointer items-start gap-3 rounded-[22px] border border-black/[.07] bg-[#fafafa] p-4 text-xs leading-5 text-[#5f646e]">
                  <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#e72d3d]" />
                  <span>Li e aceito os <a href="/termos" target="_blank" rel="noreferrer" className="font-extrabold text-[#a91f30] underline underline-offset-2">termos de uso</a> e a <a href="/privacidade" target="_blank" rel="noreferrer" className="font-extrabold text-[#a91f30] underline underline-offset-2">política de privacidade</a>. Entendo que estou solicitando uma cobrança recorrente mensal do plano {plan.name}.</span>
                </label>
                {error ? <p role="alert" className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
                <button type="submit" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-[#202126] px-7 py-4 font-extrabold text-white"><ShieldCheck size={18} /> Revisar assinatura</button>
                <p className="text-center text-xs leading-5 text-[#8b8f98]">A Wise Wolf não solicita dados de cartão nesta fase. A cobrança é processada pelo Asaas.</p>
              </form>
            )}
          </section>

          <aside className="overflow-hidden rounded-[34px] border border-black/[.07] bg-white shadow-[0_24px_75px_rgba(35,36,41,.08)] lg:sticky lg:top-7">
            <div className="relative h-64 overflow-hidden sm:h-80">
              <img src={plan.image} alt={plan.imageAlt} width={960} height={640} className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#15161b]/90 via-[#15161b]/15 to-transparent" />
              <div className="absolute inset-x-6 bottom-6 text-white">
                <p className="inline-flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.16em] text-white/70"><Sparkles size={14} /> Sua escolha</p>
                <h2 className="mt-2 font-display text-4xl font-extrabold">Plano {plan.name}</h2>
              </div>
            </div>
            <div className="p-6 sm:p-8">
              <div className="flex items-end gap-2">
                <span className="pb-1 text-sm font-extrabold text-[#565b65]">R$</span>
                <span className="font-display text-5xl font-extrabold leading-none tracking-[-.055em]">{formatWolfiePrice(plan.monthlyPrice)}</span>
                <span className="pb-1 text-sm font-bold text-[#858992]">/mês</span>
              </div>
              <p className="mt-4 leading-7 text-[#717680]">{plan.description}</p>
              <div className="mt-6 rounded-[22px] border border-[#e7f6e8] bg-[#f2faf3] p-4 text-xs leading-5 text-[#235a3a]">
                <p className="font-extrabold uppercase tracking-[0.15em] text-[#1b5f3c]">Compra segura</p>
                <ul className="mt-2 space-y-1">
                  <li>• Cobrança criada só após sua revisão.</li>
                  <li>• Não solicitamos dados de cartão aqui — só PIX ou boleto.</li>
                  <li>• Acesso liberado depois da confirmação do pagamento.</li>
                </ul>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-[22px] bg-[#fff0ec] p-4"><Mic2 size={18} className="text-[#d1263a]" /><p className="mt-3 text-2xl font-extrabold">{plan.liveMinutes} min</p><p className="text-xs text-[#8c6267]">voz ao vivo / mês</p></div>
                <div className="rounded-[22px] bg-[#f3f4f6] p-4"><Smartphone size={18} className="text-[#555a64]" /><p className="mt-3 text-2xl font-extrabold">Mensal</p><p className="text-xs text-[#777b84]">ciclo da assinatura</p></div>
              </div>
              <ul className="mt-7 space-y-3 text-sm leading-5 text-[#575c66]">
                {plan.features.map((feature) => <li key={feature} className="flex gap-2.5"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"><Check size={12} strokeWidth={3} /></span>{feature}</li>)}
              </ul>
              {quizResult ? <p className="mt-7 rounded-[22px] border border-[#e72d3d]/10 bg-[#fff8f5] p-4 text-xs leading-5 text-[#795d61]"><Sparkles size={15} className="mb-2 text-[#d1263a]" /> Seu diagnóstico será associado à conta para o Wolfie manter o contexto do treino recomendado.</p> : null}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
