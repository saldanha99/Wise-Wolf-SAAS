import {
  ArrowRight,
  BadgeCheck,
  Check,
  Headphones,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import {
  recommendWolfiePlanCode,
  WOLFIE_STANDALONE_PLANS,
} from "../funnel/wolfiePlans";
import { readQuizResult } from "../funnel/quizSession";
import { WolfieLink } from "../router";
import { PublicPage } from "./PublicChrome";
import { WolfiePlanCards } from "./WolfiePlanCards";

const journey = [
  {
    number: "01",
    title: "Escolha seu ritmo",
    description:
      "Você escolhe a franquia mensal de voz. Texto, cenários e feedback continuam disponíveis em todos os planos.",
  },
  {
    number: "02",
    title: "Crie seu acesso",
    description:
      "Sua conta Wolfie é individual e separada de uma matrícula na escola. Você entra com seu próprio e-mail.",
  },
  {
    number: "03",
    title: "Confirme o pagamento",
    description:
      "Gere PIX ou boleto. O acesso é liberado depois que o pagamento for confirmado pelo provedor.",
  },
] as const;

const faq = [
  {
    question: "Preciso ser aluno da escola Wise Wolf?",
    answer:
      "Não. A assinatura Wolfie é independente e dá acesso somente ao Wolfie AI Tutor. Quem já é aluno também pode entrar com sua conta ativa.",
  },
  {
    question: "O que muda entre os três planos?",
    answer:
      "A inteligência, os cenários, o feedback e a prática por texto são os mesmos. O que muda é a quantidade mensal de conversa por voz ao vivo.",
  },
  {
    question: "Os minutos não usados acumulam?",
    answer:
      "A franquia é mensal e segue o ciclo vigente da assinatura. Antes de confirmar, o checkout mostra o plano e a recorrência aplicáveis.",
  },
  {
    question: "Quando o acesso começa?",
    answer:
      "A cobrança é criada primeiro. A assinatura só fica ativa depois que o pagamento é confirmado pelo provedor financeiro.",
  },
] as const;

export function AccessPage() {
  const quizResult = useMemo(readQuizResult, []);
  const recommendedCode = quizResult
    ? recommendWolfiePlanCode(
      quizResult.answers,
      quizResult.recommendation,
    )
    : "RITMO";
  const recommendedPlan = WOLFIE_STANDALONE_PLANS.find(
    (plan) => plan.code === recommendedCode,
  ) ?? WOLFIE_STANDALONE_PLANS[1];

  return (
    <PublicPage>
      <main className="overflow-hidden pt-24">
        <section className="relative px-5 pb-20 pt-14 sm:pb-28 sm:pt-24">
          <div
            aria-hidden="true"
            className="absolute -left-24 top-16 h-80 w-80 rounded-full bg-[#ff8a71]/20 blur-[90px]"
          />
          <div
            aria-hidden="true"
            className="absolute -right-24 top-52 h-96 w-96 rounded-full bg-[#ffc76f]/20 blur-[100px]"
          />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[.92fr_1.08fr] lg:gap-16">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-[#e72d3d]/10 bg-[#fff1ed] px-4 py-2 text-[11px] font-extrabold uppercase tracking-[.15em] text-[#bd2133]">
                <Sparkles size={15} aria-hidden="true" /> Wolfie independente
              </p>
              <h1 className="mt-7 max-w-3xl font-display text-5xl font-extrabold leading-[.94] tracking-[-.065em] text-[#191a1e] sm:text-7xl lg:text-[5.35rem]">
                Seu inglês em movimento, no seu ritmo.
              </h1>
              <p className="mt-7 max-w-2xl text-lg leading-8 text-[#6d727c] sm:text-xl">
                Assine somente o Wolfie AI Tutor. Pratique situações reais por
                voz ou texto, receba feedback e continue de onde parou — sem
                precisar estar matriculado na escola.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href="#planos-wolfie"
                  className="inline-flex min-h-14 items-center gap-2 rounded-full bg-[#e72d3d] px-7 py-4 font-extrabold text-white shadow-[0_16px_38px_rgba(218,38,57,.2)] transition hover:-translate-y-0.5 hover:bg-[#ca2032]"
                >
                  Ver os planos <ArrowRight size={18} aria-hidden="true" />
                </a>
                <WolfieLink
                  href="/quiz"
                  className="inline-flex min-h-14 items-center gap-2 rounded-full border border-black/10 bg-white px-7 py-4 font-extrabold text-[#292b31] transition hover:border-black/20 hover:bg-[#f8f8f9]"
                >
                  Fazer diagnóstico
                </WolfieLink>
              </div>
              <div className="mt-9 grid max-w-xl gap-3 text-sm font-bold text-[#575c66] sm:grid-cols-3">
                <p className="flex items-center gap-2"><Check size={17} className="text-emerald-600" /> Só mensal</p>
                <p className="flex items-center gap-2"><Check size={17} className="text-emerald-600" /> PIX ou boleto</p>
                <p className="flex items-center gap-2"><Check size={17} className="text-emerald-600" /> Sem matrícula</p>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-[620px]">
              <div className="absolute inset-7 rounded-[46px] bg-[linear-gradient(145deg,#ffddd4,#fff0c9)] blur-2xl" aria-hidden="true" />
              <div className="relative min-h-[540px] overflow-hidden rounded-[44px] border border-black/[.06] bg-[#f5f2ef] shadow-[0_38px_100px_rgba(40,38,44,.15)] sm:min-h-[660px]">
                <img
                  src="/assets/wolfie/standalone/hero-light-phone-v2.webp"
                  alt="Wolfie AI Tutor em uma experiência de prática"
                  width={1080}
                  height={1280}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#14151a]/80 via-transparent to-white/10" />
                <div className="absolute inset-x-5 bottom-5 rounded-[28px] border border-white/50 bg-white/[.92] p-5 text-[#22242a] shadow-2xl backdrop-blur-xl sm:inset-x-8 sm:bottom-8 sm:p-7">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#d1263a]">
                        {quizResult ? "Escolhido pelo seu diagnóstico" : "Mais escolhido para criar rotina"}
                      </p>
                      <p className="mt-2 font-display text-3xl font-extrabold">
                        Plano {recommendedPlan.name}
                      </p>
                    </div>
                    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[#fff0ec] text-[#d1263a]">
                      <Headphones size={24} aria-hidden="true" />
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[#6e727b]">
                    {recommendedPlan.liveMinutes} minutos de voz por mês, texto
                    ilimitado e todos os cenários do Wolfie.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="planos-wolfie" className="scroll-mt-28 bg-[#f7f7f8] px-5 py-20 sm:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">
                Planos mensais
              </p>
              <h2 className="mt-5 font-display text-4xl font-extrabold leading-[1.02] tracking-[-.055em] text-[#191a1e] sm:text-6xl">
                A mesma inteligência. Você escolhe quanto quer falar.
              </h2>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#70757f]">
                {quizResult
                  ? `Pelo ritmo que você descreveu, o plano ${recommendedPlan.name} é o ponto de partida mais equilibrado.`
                  : "Comece com uma rotina confortável e aumente sua franquia quando precisar ensaiar mais."}
              </p>
            </div>
            <div className="mt-14">
              <WolfiePlanCards
                recommendedCode={recommendedCode}
                source="plans"
              />
            </div>
          </div>
        </section>

        <section className="px-5 py-20 sm:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-12 lg:grid-cols-[.72fr_1.28fr] lg:items-start">
              <div className="lg:sticky lg:top-32">
                <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Compare com clareza</p>
                <h2 className="mt-5 font-display text-4xl font-extrabold tracking-[-.05em] text-[#202126] sm:text-5xl">Sem plano capado.</h2>
                <p className="mt-5 max-w-md text-lg leading-8 text-[#717680]">Todos os assinantes conversam com o mesmo Wolfie, acessam os mesmos cenários e recebem o mesmo tipo de feedback.</p>
              </div>
              <div className="overflow-hidden rounded-[32px] border border-black/[.07] bg-white shadow-[0_24px_70px_rgba(35,36,41,.07)]">
                <div className="grid grid-cols-[1.4fr_repeat(3,1fr)] border-b border-black/[.06] bg-[#f8f8f9] px-4 py-5 text-center text-xs font-extrabold sm:px-7">
                  <span className="text-left text-[#777b84]">Incluído</span>
                  {WOLFIE_STANDALONE_PLANS.map((plan) => <span key={plan.code}>{plan.name}</span>)}
                </div>
                {[
                  ["Voz ao vivo", ...WOLFIE_STANDALONE_PLANS.map((plan) => `${plan.liveMinutes} min`)],
                  ["Texto com Wolfie", "Ilimitado", "Ilimitado", "Ilimitado"],
                  ["Cenários de prática", "Todos", "Todos", "Todos"],
                  ["Feedback e histórico", "Incluído", "Incluído", "Incluído"],
                ].map((row) => (
                  <div key={row[0]} className="grid grid-cols-[1.4fr_repeat(3,1fr)] items-center border-b border-black/[.055] px-4 py-5 text-center text-xs last:border-0 sm:px-7 sm:text-sm">
                    <span className="text-left font-bold text-[#50545d]">{row[0]}</span>
                    {row.slice(1).map((value, index) => <span key={`${row[0]}-${index}`} className="font-extrabold text-[#25272d]">{value}</span>)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-[#1d1e23] px-5 py-20 text-white sm:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#ff9d8d]">Da escolha à conversa</p>
              <h2 className="mt-5 font-display text-4xl font-extrabold tracking-[-.05em] sm:text-6xl">Três passos. A prática começa após a confirmação.</h2>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {journey.map((step) => (
                <article key={step.number} className="rounded-[30px] border border-white/10 bg-white/[.055] p-7">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-sm font-extrabold text-[#d1263a]">{step.number}</span>
                  <h3 className="mt-7 font-display text-2xl font-extrabold">{step.title}</h3>
                  <p className="mt-4 leading-7 text-white/65">{step.description}</p>
                </article>
              ))}
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-5 rounded-[28px] border border-white/10 bg-white/[.055] p-6 sm:p-8">
              <ShieldCheck size={28} className="text-[#ff9584]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-display text-xl font-extrabold">Cobrança processada pelo Asaas</p>
                <p className="mt-1 text-sm leading-6 text-white/60">A Wise Wolf não solicita dados de cartão nesta fase. O checkout oferece PIX ou boleto.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 py-20 sm:py-28">
          <div className="mx-auto max-w-4xl">
            <div className="text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Perguntas frequentes</p>
              <h2 className="mt-5 font-display text-4xl font-extrabold tracking-[-.05em] text-[#202126] sm:text-5xl">Antes de assinar</h2>
            </div>
            <div className="mt-12 divide-y divide-black/[.07] border-y border-black/[.07]">
              {faq.map((item) => (
                <details key={item.question} className="group py-6">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-display text-lg font-extrabold text-[#27292f] marker:hidden sm:text-xl">
                    {item.question}
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f3f3f5] text-[#e72d3d] transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="max-w-3xl pt-4 leading-7 text-[#6f747e]">{item.answer}</p>
                </details>
              ))}
            </div>
            <div className="mt-14 rounded-[34px] bg-[linear-gradient(135deg,#e52e41,#ff8265)] p-8 text-center text-white shadow-[0_25px_70px_rgba(218,39,59,.2)] sm:p-12">
              <BadgeCheck size={32} className="mx-auto" aria-hidden="true" />
              <h2 className="mt-5 font-display text-3xl font-extrabold sm:text-4xl">Ainda não sabe qual ritmo escolher?</h2>
              <p className="mx-auto mt-4 max-w-xl leading-7 text-white/80">O diagnóstico combina objetivo, formato e frequência para destacar o plano mais coerente para sua rotina.</p>
              <WolfieLink href="/quiz" className="mt-7 inline-flex min-h-14 items-center gap-2 rounded-full bg-white px-7 py-4 font-extrabold text-[#ba2032]">Descobrir meu plano <ArrowRight size={18} /></WolfieLink>
            </div>
          </div>
        </section>
      </main>
    </PublicPage>
  );
}
