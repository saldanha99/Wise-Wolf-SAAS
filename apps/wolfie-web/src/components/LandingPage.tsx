import {
  ArrowRight,
  BookOpenCheck,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Headphones,
  Languages,
  LockKeyhole,
  MessageCircleMore,
  Mic2,
  Plane,
  Presentation,
  RefreshCcw,
  Sparkles,
  Target,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import {
  AnimatePresence,
  m,
  useReducedMotion,
} from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ALL_EXPERIENCES } from "../../../../src/components/wolfie/experienceCatalog";
import type { QuizGoal } from "../funnel/quizModel";
import { WolfieLink } from "../router";
import { PublicPage } from "./PublicChrome";
import {
  LandingMotionRoot,
  PageScrollProgress,
  ParallaxVisual,
  Reveal,
} from "./landing/LandingMotion";
import { LandingTutorDemo } from "./landing/LandingTutorDemo";

const experiences = [
  {
    goal: "interview" as const,
    title: "Entrevista",
    description: "Organize exemplos e responda perguntas com mais clareza.",
    image: "/assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp",
    icon: MessageCircleMore,
  },
  {
    goal: "presentation" as const,
    title: "Apresentação",
    description: "Ensaie ideias, transições e perguntas inesperadas.",
    image: "/assets/wolfie/scenes/skill-labs/presentation-lab/desktop.45863e9a8305.webp",
    icon: Presentation,
  },
  {
    goal: "global_meeting" as const,
    title: "Reunião global",
    description: "Entre na conversa, apresente seu ponto e confirme decisões.",
    image: "/assets/wolfie/scenes/global-meetings/meetings-technology/desktop.cc9f82869f7f.webp",
    icon: BriefcaseBusiness,
  },
  {
    goal: "travel" as const,
    title: "Viagem",
    description: "Resolva situações cotidianas com mais autonomia.",
    image: "/assets/wolfie/scenes/daily-life/services/desktop.f4718b4b2fcc.webp",
    icon: Plane,
  },
  {
    goal: "conversation" as const,
    title: "Conversação",
    description: "Fale sobre temas reais sem depender de frases prontas.",
    image: "/assets/wolfie/scenes/speaking/give-your-opinion/desktop.66b5facc2154.webp",
    icon: Mic2,
  },
];

const journeySteps = [
  {
    number: "01 / 05",
    title: "Comece no seu idioma",
    description: "Explique o que você precisa viver em inglês. O Wolfie organiza o contexto sem exigir que você saiba dar o prompt perfeito.",
    icon: Languages,
  },
  {
    number: "02 / 05",
    title: "Receba um plano para a situação",
    description: "O diagnóstico combina objetivo, nível declarado, habilidade, formato e tempo disponível em um ponto de partida explicável.",
    icon: Target,
  },
  {
    number: "03 / 05",
    title: "Entre na conversa com apoio",
    description: "Use voz ou texto, receba sugestões úteis e continue falando sem transformar cada erro numa interrupção.",
    icon: MessageCircleMore,
  },
  {
    number: "04 / 05",
    title: "Aprenda com a tentativa",
    description: "O feedback mostra o ajuste que muda sua mensagem — vocabulário, estrutura, clareza ou pronúncia — e abre uma nova tentativa.",
    icon: RefreshCcw,
  },
  {
    number: "05 / 05",
    title: "Fale sobre o que realmente importa",
    description: "Reunião, entrevista, apresentação, viagem ou uma conversa espontânea: a prática acompanha seu objetivo, não uma trilha genérica.",
    icon: Mic2,
  },
];

const outcomeCards = [
  ["Antes da reunião", "Ensaie sua abertura, organize o argumento e prepare respostas para objeções."],
  ["Quando faltar uma palavra", "Receba uma alternativa natural sem perder o fio da conversa."],
  ["Ao perceber um erro", "Veja uma correção curta, entenda o motivo e tente novamente no mesmo contexto."],
  ["Para falar com mais clareza", "Transforme uma ideia longa em uma mensagem que a outra pessoa consegue acompanhar."],
  ["Quando o ritmo apertar", "Pratique sessões curtas e retome do ponto certo sem recomeçar tudo."],
  ["Em contextos profissionais", "Treine decisões de comunicação, não apenas listas de palavras soltas."],
];

const phoneScreenMeta = [
  { eyebrow: "Comece no seu idioma", title: "Contexto primeiro", icon: Languages },
  { eyebrow: "Plano pessoal", title: "Reunião global", icon: Target },
  { eyebrow: "Sugestão no momento", title: "Continue falando", icon: MessageCircleMore },
  { eyebrow: "Aprenda tentando", title: "Feedback claro", icon: RefreshCcw },
  { eyebrow: "Conversa livre", title: "Escolha um tema", icon: Mic2 },
] as const;

function PhoneScreenContent({ activeStep }: { activeStep: number }) {
  if (activeStep === 0) {
    return (
      <div className="space-y-3">
        <div className="max-w-[88%] rounded-[20px_20px_20px_6px] bg-[#f2f2f4] px-4 py-3 text-sm font-semibold leading-5 text-[#42464f]">Conte em português: qual conversa você precisa preparar?</div>
        <div className="ml-auto max-w-[86%] rounded-[20px_20px_6px_20px] bg-[#e72d3d] px-4 py-3 text-sm font-bold leading-5 text-white">Tenho uma reunião global na próxima semana.</div>
        <div className="rounded-[22px] border border-[#e72d3d]/10 bg-[#fff2ed] p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[.15em] text-[#b92333]">Entendi o contexto</p>
          <p className="mt-2 text-sm font-bold leading-5 text-[#4d3438]">Vamos treinar como entrar na conversa, defender seu ponto e confirmar os próximos passos.</p>
        </div>
      </div>
    );
  }

  if (activeStep === 1) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-bold leading-6 text-[#25272d]">O que você mais precisa fazer nessa situação?</p>
        {["Responder sem travar", "Conduzir próximos passos", "Explicar uma ideia"].map((label, index) => (
          <div key={label} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-bold ${index === 1 ? "border-[#ff7a61] bg-[#fff2ed] text-[#b92233]" : "border-black/[.07] bg-[#fafafa] text-[#555b65]"}`}>
            <span className={`h-4 w-4 rounded-full border ${index === 1 ? "border-[#e72d3d] bg-[#e72d3d] shadow-[inset_0_0_0_4px_white]" : "border-black/20"}`} />
            {label}
          </div>
        ))}
        <div className="rounded-[20px] bg-[#17191f] px-4 py-3 text-sm font-bold text-white">Plano inicial: 10 min · 3× por semana</div>
      </div>
    );
  }

  if (activeStep === 2) {
    return (
      <div className="space-y-3">
        <div className="rounded-[24px] bg-[#17191f] p-5 text-white">
          <p className="text-[10px] font-extrabold uppercase tracking-[.15em] text-[#ffb45f]">Simulação ao vivo</p>
          <p className="mt-3 text-sm font-semibold leading-6 text-white/75">“What do you think we should prioritize?”</p>
          <div className="mt-4 flex h-10 items-center gap-1" aria-hidden="true">
            {[28, 55, 36, 78, 48, 86, 42, 68, 32, 58, 38].map((height, index) => <span key={index} className="wolfie-wavebar w-1.5 rounded-full bg-[#ff785f]" style={{ height: `${height}%`, animationDelay: `${index * 65}ms` }} />)}
          </div>
        </div>
        <div className="rounded-[20px] border border-[#7c62e8]/15 bg-[#f3f0ff] p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[.15em] text-[#6952c4]">Se precisar de apoio</p>
          <p className="mt-2 text-sm font-bold leading-5 text-[#39344f]">Try: “From my perspective, the first priority should be…”</p>
        </div>
      </div>
    );
  }

  if (activeStep === 3) {
    return (
      <div className="space-y-3">
        <div className="rounded-[20px] bg-[#fafafa] p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[.15em] text-[#90949d]">Sua tentativa</p>
          <p className="mt-2 text-sm font-bold text-[#373940]">“I want discuss about the next steps.”</p>
        </div>
        <div className="rounded-[22px] border border-[#e72d3d]/10 bg-[#fff0ec] p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[.15em] text-[#b92333]">Uma forma mais natural</p>
          <p className="mt-2 text-base font-extrabold text-[#b92333]">“I’d like to discuss the next steps.”</p>
          <p className="mt-3 text-xs font-semibold leading-5 text-[#77575c]">Depois do ajuste, você tenta novamente no mesmo contexto.</p>
        </div>
        <div className="flex items-center gap-2 text-xs font-bold text-[#666b75]"><Check size={15} className="text-emerald-600" /> Mensagem mais clara</div>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {["Reuniões", "Tecnologia", "Viagens", "Conversação"].map((topic, index) => (
          <div key={topic} className={`rounded-[18px] border px-3 py-4 text-center text-xs font-extrabold ${index === 0 ? "border-[#e72d3d] bg-[#fff0ec] text-[#b92333]" : "border-black/[.07] bg-[#fafafa] text-[#646973]"}`}>{topic}</div>
        ))}
      </div>
      <div className="mt-4 rounded-full bg-[#e72d3d] px-5 py-4 text-center text-sm font-extrabold text-white shadow-[0_12px_28px_rgba(231,45,61,.2)]">Começar conversa por voz</div>
      <p className="mt-4 text-center text-xs font-semibold leading-5 text-[#858992]">Fale sobre o que importa para você, com apoio quando precisar.</p>
    </div>
  );
}

function ProductPhone({ activeStep = 0, compact = false }: { activeStep?: number; compact?: boolean }) {
  const reducedMotion = useReducedMotion();
  const screen = phoneScreenMeta[activeStep] ?? phoneScreenMeta[0];
  const ScreenIcon = screen.icon;

  return (
    <div aria-hidden="true" className={`relative mx-auto w-full ${compact ? "max-w-[310px]" : "max-w-[390px]"}`}>
      <div className={`${compact ? "rounded-[44px] border-[8px]" : "rounded-[54px] border-[10px]"} border-[#17191f] bg-[#17191f] p-2 shadow-[0_38px_90px_rgba(35,31,44,.2)]`}>
        <div className={`${compact ? "rounded-[31px]" : "rounded-[38px]"} overflow-hidden bg-white`}>
          <div className="flex items-center justify-between border-b border-black/[.06] px-5 py-4">
            <div>
              <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#e72d3d]">{screen.eyebrow}</p>
              <p className="mt-1 font-display text-lg font-extrabold text-[#171717]">{screen.title}</p>
            </div>
            <span className="grid h-10 w-10 place-items-center rounded-full bg-[#fff0ec] text-[#e72d3d]"><ScreenIcon size={18} /></span>
          </div>
          <div className={`${compact ? "min-h-[315px]" : "min-h-[350px]"} p-5`}>
            <AnimatePresence initial={false} mode="wait">
              <m.div
                key={activeStep}
                initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -8, scale: 0.99 }}
                transition={{ duration: reducedMotion ? 0 : 0.4, ease: [0.1, 0, 0.25, 1] }}
              >
                <PhoneScreenContent activeStep={activeStep} />
              </m.div>
            </AnimatePresence>
          </div>
          <div className="mx-auto mb-3 h-1.5 w-24 rounded-full bg-[#17191f]" />
        </div>
      </div>
      {!compact ? (
        <div className="absolute -left-12 top-[28%] hidden rounded-2xl border border-black/[.06] bg-white p-4 shadow-[0_20px_50px_rgba(38,34,48,.13)] sm:block">
          <p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8b8f98]">Etapa ativa</p>
          <p className="mt-1 font-display text-xl font-extrabold text-[#e72d3d]">0{activeStep + 1}</p>
        </div>
      ) : null}
    </div>
  );
}

function StickyLearningJourney() {
  const journeyRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<Array<HTMLElement | null>>([]);
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    let frame = 0;

    const updateActiveStep = () => {
      frame = 0;
      const viewportAnchor = window.innerHeight * 0.5;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      stepRefs.current.forEach((element, index) => {
        if (!element) return;
        const bounds = element.getBoundingClientRect();
        const distance = Math.abs(bounds.top + bounds.height / 2 - viewportAnchor);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      setActiveStep((current) => current === closestIndex ? current : closestIndex);
    };

    const requestUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateActiveStep);
    };

    updateActiveStep();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={journeyRef} className="mt-20 grid items-start gap-12 lg:grid-cols-[.88fr_1.12fr] lg:gap-20">
      <div>
        {journeySteps.map(({ number, title, description, icon: Icon }, index) => (
          <article ref={(element) => { stepRefs.current[index] = element; }} key={number} aria-current={activeStep === index ? "step" : undefined} className={`premium-journey-step flex flex-col justify-center border-b border-black/[.055] py-14 last:border-b-0 lg:min-h-[58vh] lg:py-20 ${activeStep === index ? "is-active" : ""}`}>
            <Reveal amount={0.24}>
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fff0ec] text-[#e72d3d]"><Icon size={19} /></span>
                <span className="text-xs font-extrabold uppercase tracking-[.17em] text-[#a3a6ad]">{number}</span>
              </div>
              <h3 className="mt-5 font-display text-3xl font-extrabold leading-tight tracking-[-.045em] text-[#1c1d21] sm:text-4xl">{title}</h3>
              <p className="mt-4 text-base leading-7 text-[#6b707b] sm:text-lg sm:leading-8">{description}</p>
              <div className="mt-8 rounded-[36px] bg-[radial-gradient(circle_at_50%_12%,#fff4ed_0%,#faf8ff_52%,#f5f6f8_100%)] px-5 py-8 lg:hidden">
                <ProductPhone activeStep={index} compact />
              </div>
            </Reveal>
          </article>
        ))}
      </div>
      <div className="premium-sticky-phone sticky top-[106px] hidden h-[calc(100vh-130px)] min-h-[630px] max-h-[840px] items-center rounded-[44px] bg-[radial-gradient(circle_at_50%_18%,#fff4ed_0%,#faf8ff_47%,#f5f6f8_100%)] px-10 py-12 lg:flex">
        <ProductPhone activeStep={activeStep} />
      </div>
    </div>
  );
}

export function LandingPage() {
  const reducedMotion = useReducedMotion();
  const [selectedGoal, setSelectedGoal] = useState<QuizGoal>("global_meeting");
  const selectedExperience = experiences.find(({ goal }) => goal === selectedGoal)
    ?? experiences[2];

  return (
    <LandingMotionRoot>
      <PublicPage>
        <PageScrollProgress />
        <main>
        <section className="px-5 pb-14 pt-28 sm:pt-32">
          <div className="mx-auto grid max-w-7xl overflow-hidden rounded-[34px] bg-[linear-gradient(135deg,#d9273a_0%,#f6534b_48%,#ffad57_100%)] shadow-[0_30px_90px_rgba(196,42,58,.18)] lg:min-h-[610px] lg:grid-cols-[.93fr_1.07fr]">
            <Reveal className="flex flex-col justify-center p-7 text-white sm:p-12 lg:p-16" amount={0.08}>
              <p className="inline-flex w-fit items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2 text-xs font-extrabold uppercase tracking-[.16em] backdrop-blur-sm"><Sparkles size={15} /> Inglês para situações reais</p>
              <h1 className="mt-7 max-w-xl font-display text-[clamp(3.2rem,6vw,5.8rem)] font-extrabold leading-[.94] tracking-[-.065em]">A conversa chega. Você chega preparado.</h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-white/85">Treine reuniões, entrevistas, apresentações e viagens com uma IA que entende seu objetivo, escuta sua tentativa e ajuda você a responder melhor.</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <WolfieLink href="/quiz" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-white px-7 py-4 font-extrabold text-[#b91f32] shadow-[0_16px_38px_rgba(111,20,39,.18)] transition hover:-translate-y-0.5">Descobrir meu treino <ArrowRight size={18} /></WolfieLink>
                <WolfieLink href="/entrar" className="inline-flex min-h-14 items-center justify-center rounded-full border border-white/30 bg-white/10 px-7 py-4 font-extrabold text-white backdrop-blur-sm transition hover:bg-white/20">Já sou aluno</WolfieLink>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm font-bold text-white/80">
                <span className="inline-flex items-center gap-2"><Check size={16} /> Voz e texto</span>
                <span className="inline-flex items-center gap-2"><Check size={16} /> Feedback no contexto</span>
                <span className="inline-flex items-center gap-2"><Check size={16} /> Resultado antes do cadastro</span>
              </div>
            </Reveal>
            <Reveal className="relative flex min-h-[500px] items-end justify-center p-5 lg:min-h-[610px] lg:justify-end lg:p-8" direction="scale" delay={0.08} amount={0.08}>
              <div className="absolute inset-8 rounded-[34px] bg-white/15 blur-2xl" />
              <ParallaxVisual className="relative h-full w-full max-w-[530px] rounded-[34px] bg-white shadow-[0_30px_80px_rgba(107,18,38,.25)]" distance={14}>
                <img src="/assets/wolfie/standalone/hero-light-phone-v2.webp" alt="Wolfie, tutor de inglês em 3D, dentro de um smartphone" width="971" height="1619" className="h-full w-full object-cover" fetchPriority="high" decoding="async" />
              </ParallaxVisual>
            </Reveal>
          </div>
          <div className="mx-auto grid max-w-5xl grid-cols-2 gap-x-8 gap-y-7 py-10 text-center sm:grid-cols-4">
            {[
              ["Wise Wolf", "Produto educacional"],
              [String(ALL_EXPERIENCES.length), "experiências catalogadas"],
              ["Voz + texto", "no seu ritmo"],
              ["Privacidade", "desde o diagnóstico"],
            ].map(([value, label], index) => (
              <div key={value}>
                <Reveal delay={index * 0.07} amount={0.3}>
                  <p className="font-display text-xl font-extrabold tracking-[-.04em] text-[#202126]">{value}</p>
                  <p className="mt-1 text-xs font-bold text-[#9296a0]">{label}</p>
                </Reveal>
              </div>
            ))}
          </div>
        </section>

        <section className="px-5 py-20 sm:py-28">
          <div className="mx-auto max-w-7xl">
            <Reveal className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Como funciona</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold leading-[1.04] tracking-[-.055em] text-[#18191d] sm:text-6xl">Qualidade de tutor particular. Liberdade para praticar quando quiser.</h2>
            </Reveal>
            <StickyLearningJourney />
          </div>
        </section>

        <section id="experiencias" className="landing-section-anchor overflow-hidden bg-[#fbfbfc] px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-7xl text-center">
            <Reveal>
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Cenários que lembram o seu contexto</p>
              <h2 className="mx-auto mt-4 max-w-3xl font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">Escolha a conversa. O Wolfie ajuda você a entrar nela.</h2>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#737781]">Cada experiência combina ambiente, objetivo, nível e formato para treinar uma decisão real de comunicação.</p>
            </Reveal>
            <Reveal className="relative mt-14" direction="scale" amount={0.12}>
              <div className="premium-scenario-aura" aria-hidden="true" />
              <div className="premium-scene-rail relative flex flex-col gap-4 md:h-[520px] md:flex-row md:items-center">
                {experiences.map(({ goal, title, description, image, icon: Icon }) => {
                  const selected = goal === selectedGoal;
                  return (
                  <button
                    key={goal}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedGoal(goal)}
                    className={`premium-scene-card group relative min-h-[360px] overflow-hidden rounded-[32px] bg-[#17191f] text-left shadow-[0_18px_45px_rgba(34,35,40,.1)] outline-none md:h-[430px] md:min-h-0 ${selected ? "is-selected md:h-[500px]" : ""}`}
                  >
                    <img src={image} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-105 group-focus:scale-105" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="grid h-10 w-10 place-items-center rounded-2xl border border-white/20 bg-white/15 text-white backdrop-blur-md"><Icon size={18} /></span>
                        {selected ? <span className="rounded-full border border-white/20 bg-white/90 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#b92333]">Selecionado</span> : null}
                      </div>
                      <h3 className="mt-4 font-display text-xl font-extrabold text-white">{title}</h3>
                      <p className="premium-scene-description mt-2 text-sm leading-6 text-white/75">{description}</p>
                    </div>
                  </button>
                  );
                })}
              </div>
              <m.div
                key={selectedGoal}
                initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="relative mx-auto mt-7 flex max-w-3xl flex-col items-center justify-between gap-5 rounded-[28px] border border-black/[.07] bg-white p-5 text-left shadow-[0_20px_55px_rgba(38,39,44,.08)] sm:flex-row sm:p-6"
              >
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#e72d3d]">Seu ponto de partida</p>
                  <p className="mt-2 font-display text-xl font-extrabold text-[#202126]">{selectedExperience.title}</p>
                  <p className="mt-1 text-sm leading-6 text-[#777b84]">Você vê a recomendação antes de informar seus dados.</p>
                </div>
                <WolfieLink href={`/quiz?novo=1&objetivo=${selectedGoal}`} className="inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-[#c91f30] px-6 py-3 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(201,31,48,.2)] transition hover:bg-[#af1828] sm:w-auto">
                  Montar meu treino <ArrowRight size={17} />
                </WolfieLink>
              </m.div>
            </Reveal>
          </div>
        </section>

        <section className="px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-7xl">
            <Reveal className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Presença em tempo real</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">O personagem ouve, responde e acompanha o ritmo da fala.</h2>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#737781]">A animação tem uma função: deixar claro quando o Wolfie está ouvindo, pensando ou falando, sem transformar a prática em distração.</p>
            </Reveal>
            <Reveal className="mt-14" direction="scale" amount={0.08}>
              <LandingTutorDemo />
            </Reveal>
          </div>
        </section>

        <section id="feedback" className="landing-section-anchor px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-6xl">
            <Reveal className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Feedback em tempo real</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">Corrija a mensagem sem sair da conversa.</h2>
            </Reveal>
            <div className="mt-14 grid gap-5 md:grid-cols-2">
              <Reveal direction="left">
                <article className="h-full rounded-[34px] bg-[#fff0ec] p-7 sm:p-9">
                  <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#b92333]">Sua tentativa</p>
                  <p className="mt-4 font-display text-2xl font-extrabold leading-tight text-[#292126]">“I want discuss about the next steps.”</p>
                  <div className="my-6 border-t border-[#e72d3d]/15" />
                  <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#b92333]">Uma forma mais natural</p>
                  <p className="mt-3 font-display text-2xl font-extrabold leading-tight text-[#b92333]">“I’d like to discuss the next steps.”</p>
                  <p className="mt-4 text-sm leading-6 text-[#74555b]">O ajuste aparece com explicação curta e espaço para uma nova tentativa.</p>
                </article>
              </Reveal>
              <Reveal direction="right" delay={0.07}>
                <article className="h-full rounded-[34px] bg-[#f3f0ff] p-7 sm:p-9">
                  <div className="flex items-center justify-between">
                    <div><p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#6151a6]">Intensidade do apoio</p><h3 className="mt-3 font-display text-3xl font-extrabold text-[#292531]">No ponto certo.</h3></div>
                    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-[#7259d6] shadow-sm"><Zap size={20} /></span>
                  </div>
                  <div className="mt-8 grid grid-cols-3 gap-3 text-center text-xs font-extrabold">
                    <div className="rounded-2xl bg-white p-4 text-[#55a876]"><span className="mx-auto block h-10 w-10 rounded-full bg-[#67d38e]" /><p className="mt-3">Leve</p></div>
                    <div className="scale-105 rounded-2xl bg-white p-4 text-[#5a70c8] shadow-md"><span className="mx-auto block h-10 w-10 rounded-xl bg-[#6f8cff]" /><p className="mt-3">Equilibrado</p></div>
                    <div className="rounded-2xl bg-white p-4 text-[#d45366]"><span className="mx-auto block h-10 w-10 bg-[#f46a80] [clip-path:polygon(50%_0,100%_100%,0_100%)]" /><p className="mt-3">Direto</p></div>
                  </div>
                </article>
              </Reveal>
              <Reveal className="md:col-span-2" delay={0.12}>
                <article className="rounded-[34px] border border-black/[.07] bg-white p-7 shadow-[0_22px_70px_rgba(40,39,48,.08)] sm:p-9">
                  <div className="grid items-center gap-8 md:grid-cols-[1fr_auto_1fr]">
                    <div>
                      <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#e72d3d]">Voz, texto e contexto</p>
                      <h3 className="mt-3 font-display text-3xl font-extrabold tracking-[-.04em] text-[#202126]">A prática não termina na gramática.</h3>
                      <p className="mt-4 leading-7 text-[#6b707a]">Compreensão, escolha de palavras, clareza, ritmo e continuidade entram no mesmo treino.</p>
                    </div>
                    <div className="premium-voice-orb mx-auto grid h-36 w-36 place-items-center rounded-full bg-[radial-gradient(circle,#ffebe7_0%,#fff7f3_48%,white_49%)] text-[#e72d3d] shadow-[0_20px_45px_rgba(226,47,63,.12)]"><Volume2 size={40} /></div>
                    <div className="space-y-3 text-sm font-bold text-[#464b55]">
                      <p className="flex items-center gap-3"><Headphones size={17} className="text-[#e72d3d]" /> Compreensão no cenário</p>
                      <p className="flex items-center gap-3"><Languages size={17} className="text-[#e72d3d]" /> Apoio em português</p>
                      <p className="flex items-center gap-3"><RefreshCcw size={17} className="text-[#e72d3d]" /> Nova tentativa orientada</p>
                    </div>
                  </div>
                </article>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="bg-[#fbfbfc] px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-7xl">
            <Reveal className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Prova de produto, sem número inventado</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">{ALL_EXPERIENCES.length} experiências. Uma lógica: preparar você para usar o inglês.</h2>
            </Reveal>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {outcomeCards.map(([title, description], index) => (
                <div key={title} className="h-full">
                  <Reveal className="h-full" delay={index * 0.06}>
                    <article className="h-full rounded-[28px] border border-black/[.06] bg-white p-6 shadow-[0_12px_40px_rgba(38,39,44,.05)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_55px_rgba(38,39,44,.09)]">
                      <div className="flex items-start justify-between gap-4"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#fff0ec] text-[#e72d3d]"><Check size={18} strokeWidth={2.7} /></span><span className="text-xs font-extrabold text-[#b4b7bd]">0{index + 1}</span></div>
                      <h3 className="mt-5 font-display text-xl font-extrabold text-[#24252a]">{title}</h3>
                      <p className="mt-3 text-sm leading-6 text-[#777b84]">{description}</p>
                    </article>
                  </Reveal>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-5xl">
            <Reveal className="mx-auto max-w-3xl text-center">
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Uma comparação honesta</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">Treino personalizado sem depender de uma agenda fixa.</h2>
            </Reveal>
            <div className="mt-14 grid gap-5 md:grid-cols-2">
              <Reveal direction="left">
                <article className="h-full rounded-[34px] bg-[linear-gradient(145deg,#e72d3d,#ff7b5c)] p-8 text-white shadow-[0_24px_65px_rgba(206,38,56,.18)]">
                  <p className="text-xs font-extrabold uppercase tracking-[.17em] text-white/75">Com Wolfie</p>
                  <h3 className="mt-3 font-display text-4xl font-extrabold">Prática no momento em que você precisa.</h3>
                  <ul className="mt-8 space-y-4 text-sm font-bold">
                    {["Escolha o cenário que importa agora", "Pratique por voz ou texto", "Retome sem perder o contexto", "Receba feedback durante a tentativa", "Acesse com sua conta Wise Wolf"].map((item) => <li key={item} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-[#d9273a]"><Check size={14} strokeWidth={3} /></span>{item}</li>)}
                  </ul>
                  <WolfieLink href="/quiz" className="mt-9 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-5 py-3 font-extrabold text-[#ba2032]">Descobrir meu treino <ArrowRight size={17} /></WolfieLink>
                </article>
              </Reveal>
              <Reveal direction="right" delay={0.08}>
                <article className="h-full rounded-[34px] border border-black/[.08] bg-white p-8">
                  <p className="text-xs font-extrabold uppercase tracking-[.17em] text-[#9a9da4]">Sem um treino contextual</p>
                  <h3 className="mt-3 font-display text-4xl font-extrabold text-[#2b2c31]">Muito conteúdo. Pouca preparação para a conversa.</h3>
                  <ul className="mt-8 space-y-4 text-sm font-bold text-[#70747d]">
                    {["Trilha igual para objetivos diferentes", "Frases soltas fora do seu ambiente", "Correção que interrompe o raciocínio", "Pouca continuidade entre tentativas", "Dificuldade para transferir o estudo ao trabalho"].map((item) => <li key={item} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#f4f4f5] text-[#a2a5ab]"><X size={14} strokeWidth={2.7} /></span>{item}</li>)}
                  </ul>
                </article>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="bg-[#fff7f3] px-5 py-24 sm:py-32">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[.9fr_1.1fr]">
            <Reveal direction="left">
              <ParallaxVisual className="relative mx-auto aspect-[4/3] w-full max-w-xl rounded-[36px] bg-white shadow-[0_26px_70px_rgba(86,51,48,.11)]" distance={12}>
                <img src="/assets/wolfie/standalone/hero-light-phone-v2.webp" alt="Wolfie em uma experiência de conversa por voz" width="971" height="1619" loading="lazy" decoding="async" className="h-full w-full object-cover object-[center_36%]" />
              </ParallaxVisual>
            </Reveal>
            <Reveal direction="right" delay={0.08}>
              <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Criado pela Wise Wolf</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold tracking-[-.055em] text-[#1c1d21] sm:text-6xl">Tecnologia com uma intenção pedagógica clara.</h2>
              <p className="mt-6 text-lg leading-8 text-[#686d77]">O Wolfie nasceu dentro de uma operação de ensino de inglês. Por isso, não começa perguntando apenas o seu nível: começa entendendo a conversa que você precisa ter.</p>
              <p className="mt-5 text-lg leading-8 text-[#686d77]">A IA conduz a prática, mas a arquitetura continua comprometida com clareza, tentativa, feedback e autonomia do aluno.</p>
              <a href="https://wisewolflanguage.com.br" rel="noreferrer" className="mt-8 inline-flex min-h-12 items-center gap-2 rounded-full border border-black/10 bg-white px-6 py-3 font-extrabold text-[#25262b] transition hover:-translate-y-0.5 hover:shadow-lg">Conhecer a Wise Wolf <ArrowRight size={17} /></a>
            </Reveal>
          </div>
        </section>

        <section className="px-5 py-24 sm:py-32">
          <Reveal className="mx-auto max-w-4xl text-center" direction="scale">
            <span className="mx-auto grid h-20 w-20 place-items-center rounded-[25px] bg-gradient-to-br from-[#ffb45f] via-[#ff785f] to-[#e72d3d] text-[#1f1513] shadow-[0_18px_45px_rgba(231,45,61,.2)]"><Sparkles size={34} /></span>
            <h2 className="mx-auto mt-8 max-w-3xl font-display text-4xl font-extrabold tracking-[-.055em] text-[#191a1e] sm:text-6xl">Pratique antes da conversa. Chegue diferente nela.</h2>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#727680]">Faça o diagnóstico, veja a recomendação antes de informar seus dados e escolha seu próximo treino.</p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <WolfieLink href="/quiz" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-[#e72d3d] px-7 py-4 font-extrabold text-white shadow-[0_16px_35px_rgba(231,45,61,.18)]">Descobrir meu treino <ArrowRight size={18} /></WolfieLink>
              <WolfieLink href="/entrar" className="inline-flex min-h-14 items-center justify-center rounded-full border border-black/10 px-7 py-4 font-extrabold text-[#25262b]">Já sou aluno</WolfieLink>
            </div>
            <p className="mt-7 inline-flex items-center gap-2 text-xs font-bold text-[#8b8f98]"><LockKeyhole size={15} /> Sem dados pessoais na URL e sem contato obrigatório.</p>
          </Reveal>
        </section>
        </main>
      </PublicPage>
    </LandingMotionRoot>
  );
}

export function HowItWorksPage() {
  const features = [
    [Sparkles, "Diagnóstico curto", "Oito perguntas fechadas identificam cenário, participação, ponto de partida, bloqueio, formato e ritmo."],
    [BookOpenCheck, "Experiência recomendada", "O resultado aponta uma experiência real do catálogo, alternativas e um plano inicial explicável."],
    [Mic2, "Conversa por voz ou texto", "Na área autenticada, o Wolfie conduz simulação, transcrição e continuidade de sessão."],
    [RefreshCcw, "Tentativa orientada", "O feedback explica o ajuste que importa para a mensagem e abre espaço para tentar novamente."],
  ] as const;

  return (
    <PublicPage>
      <main className="px-5 pb-24 pt-36 sm:pt-44">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-4xl text-center">
            <p className="text-xs font-extrabold uppercase tracking-[.18em] text-[#e72d3d]">Como funciona</p>
            <h1 className="mt-5 font-display text-5xl font-extrabold leading-[.98] tracking-[-.06em] text-[#191a1e] sm:text-7xl">Do objetivo à conversa, sem uma trilha genérica no meio.</h1>
            <p className="mx-auto mt-7 max-w-2xl text-lg leading-8 text-[#6d727c]">O Wolfie usa seu contexto para escolher uma experiência e adapta a dificuldade durante a prática.</p>
          </div>
          <div className="mt-16 grid gap-5 md:grid-cols-2">
            {features.map(([Icon, title, description]) => (
              <article key={title} className="rounded-[30px] border border-black/[.07] bg-[#fbfbfc] p-7">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#fff0ec] text-[#e72d3d]"><Icon size={21} /></span>
                <h2 className="mt-6 font-display text-2xl font-extrabold text-[#202126]">{title}</h2>
                <p className="mt-3 leading-7 text-[#737781]">{description}</p>
              </article>
            ))}
          </div>
          <div className="mt-12 rounded-[34px] bg-[linear-gradient(135deg,#d9273a,#ff795d)] p-8 text-white sm:p-11">
            <h2 className="font-display text-3xl font-extrabold tracking-tight">Pronto para encontrar seu primeiro cenário?</h2>
            <p className="mt-3 text-white/80">Leva poucos minutos e você vê o resultado antes de informar seus dados.</p>
            <WolfieLink href="/quiz" className="mt-7 inline-flex min-h-14 items-center gap-2 rounded-full bg-white px-7 py-4 font-extrabold text-[#b91f32]">Começar diagnóstico <ArrowRight size={18} /></WolfieLink>
          </div>
        </div>
      </main>
    </PublicPage>
  );
}
