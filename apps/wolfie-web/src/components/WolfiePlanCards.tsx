import {
  ArrowRight,
  Check,
  Headphones,
  InfinityIcon,
  Mic2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  domAnimation,
  LazyMotion,
  m,
  useReducedMotion,
} from "framer-motion";
import {
  DEFAULT_WOLFIE_PLAN_CODE,
  WOLFIE_STANDALONE_PLANS,
  formatWolfiePrice,
  wolfieSubscribeHref,
  type WolfiePlanCode,
} from "../funnel/wolfiePlans";
import { WolfieLink } from "../router";

export function WolfiePlanCards({
  recommendedCode = DEFAULT_WOLFIE_PLAN_CODE,
  source,
}: {
  recommendedCode?: WolfiePlanCode;
  source: "plans" | "quiz_result";
}) {
  const reducedMotion = useReducedMotion();

  return (
    <LazyMotion features={domAnimation}>
      <div className="grid gap-5 lg:grid-cols-3 lg:items-stretch">
        {WOLFIE_STANDALONE_PLANS.map((plan, index) => {
          const highlighted = plan.code === recommendedCode;
          const voiceShare = Math.round((plan.liveMinutes / 240) * 100);

          return (
            <m.article
              key={plan.code}
              className={`group relative flex min-h-full flex-col overflow-hidden rounded-[34px] border bg-white transition duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_80px_rgba(40,38,44,.13)] ${
                highlighted
                  ? "border-[#ef3446] shadow-[0_28px_85px_rgba(218,40,61,.16)] ring-4 ring-[#ef3446]/[.07]"
                  : "border-black/[.075] shadow-[0_18px_55px_rgba(37,38,44,.07)]"
              }`}
              initial={reducedMotion ? false : { opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.18 }}
              transition={{
                duration: reducedMotion ? 0 : 0.5,
                delay: reducedMotion ? 0 : index * 0.07,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              <div className="relative h-44 overflow-hidden">
                <img
                  src={plan.image}
                  alt={plan.imageAlt}
                  width="960"
                  height="640"
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#111218]/90 via-[#111218]/25 to-white/5" />
                <div className="absolute inset-x-5 bottom-5 flex items-end justify-between gap-4 text-white">
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-white/70">
                      Plano mensal
                    </p>
                    <h3 className="mt-1 font-display text-3xl font-extrabold">
                      {plan.name}
                    </h3>
                  </div>
                  <div
                    className="grid h-[70px] w-[70px] shrink-0 place-items-center rounded-full p-[5px] shadow-xl"
                    style={{
                      background: `conic-gradient(#ff6c5e ${voiceShare}%, rgba(255,255,255,.24) ${voiceShare}% 100%)`,
                    }}
                    aria-label={`${plan.liveMinutes} minutos de voz por mês`}
                  >
                    <span className="grid h-full w-full place-items-center rounded-full bg-[#17191f]/95 text-center text-[10px] font-extrabold leading-none backdrop-blur-md">
                      <span>
                        <strong className="block text-xl text-white">
                          {plan.liveMinutes}
                        </strong>
                        min
                      </span>
                    </span>
                  </div>
                </div>
                {highlighted ? (
                  <span className="absolute left-5 top-5 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#bd2032] shadow-lg">
                    <Sparkles size={13} aria-hidden="true" /> Recomendado
                  </span>
                ) : null}
              </div>

              <div className="flex flex-1 flex-col p-6 sm:p-7">
                <p className="min-h-12 text-base font-extrabold leading-6 text-[#303238]">
                  {plan.tagline}
                </p>
                <p className="mt-3 min-h-[72px] text-sm leading-6 text-[#757983]">
                  {plan.description}
                </p>

                <div className="mt-6 flex items-end gap-2 border-t border-black/[.065] pt-6">
                  <span className="pb-1 text-sm font-extrabold text-[#545861]">
                    R$
                  </span>
                  <span className="font-display text-[2.8rem] font-extrabold leading-none tracking-[-.055em] text-[#191a1f]">
                    {formatWolfiePrice(plan.monthlyPrice)}
                  </span>
                  <span className="pb-1 text-sm font-bold text-[#858992]">
                    /mês
                  </span>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-[#fff1ed] p-3.5">
                    <Mic2 size={17} className="text-[#d7263a]" aria-hidden="true" />
                    <p className="mt-2 text-lg font-extrabold text-[#282a30]">
                      {plan.liveMinutes} min
                    </p>
                    <p className="mt-0.5 text-[11px] font-semibold text-[#8c6267]">
                      voz ao vivo
                    </p>
                  </div>
                  <div className="rounded-2xl bg-[#f3f5f8] p-3.5">
                    <Headphones size={17} className="text-[#444954]" aria-hidden="true" />
                    <p className="mt-2 text-lg font-extrabold text-[#282a30]">
                      {plan.practiceCount} práticas
                    </p>
                    <p className="mt-0.5 text-[11px] font-semibold text-[#787d87]">
                      de 15 min
                    </p>
                  </div>
                </div>

                <ul className="mt-6 space-y-3 text-sm leading-5 text-[#555a64]">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2.5">
                      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                        <Check size={12} strokeWidth={3} aria-hidden="true" />
                      </span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <WolfieLink
                  href={wolfieSubscribeHref(plan.code, source)}
                  className={`mt-7 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full px-5 py-4 text-center text-sm font-extrabold transition hover:-translate-y-0.5 ${
                    highlighted
                      ? "bg-[#ed2f43] text-white shadow-[0_15px_38px_rgba(222,38,59,.22)] hover:bg-[#c92135]"
                      : "bg-[#202126] text-white hover:bg-[#0d0e11]"
                  }`}
                >
                  {plan.cta} <ArrowRight size={17} aria-hidden="true" />
                </WolfieLink>
              </div>
            </m.article>
          );
        })}
      </div>

      <div className="mt-7 grid gap-3 rounded-[26px] border border-black/[.065] bg-white p-5 text-sm text-[#666b75] shadow-[0_14px_45px_rgba(35,36,41,.05)] sm:grid-cols-3 sm:p-6">
        <p className="flex items-center gap-2.5 font-bold">
          <InfinityIcon size={18} className="shrink-0 text-[#e72d3d]" aria-hidden="true" />
          Texto sem descontar minutos de voz
        </p>
        <p className="flex items-center gap-2.5 font-bold">
          <ShieldCheck size={18} className="shrink-0 text-[#e72d3d]" aria-hidden="true" />
          Preço e franquia confirmados no servidor
        </p>
        <p className="flex items-center gap-2.5 font-bold">
          <Mic2 size={18} className="shrink-0 text-[#e72d3d]" aria-hidden="true" />
          Voz medida pelo tempo real de conversa
        </p>
      </div>
    </LazyMotion>
  );
}
