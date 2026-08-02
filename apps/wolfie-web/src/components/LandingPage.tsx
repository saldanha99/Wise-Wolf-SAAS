import {
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Headphones,
  Languages,
  LockKeyhole,
  MessageCircleMore,
  Mic2,
  Plane,
  Presentation,
  RefreshCcw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { ALL_EXPERIENCES } from "../../../../src/components/wolfie/experienceCatalog";
import { WolfieLink } from "../router";
import { PublicPage } from "./PublicChrome";

const experiences = [
  {
    title: "Reunião global",
    description: "Entre na conversa, faça seu ponto e confirme decisões.",
    image: "/assets/wolfie/scenes/global-meetings/meetings-technology/desktop.cc9f82869f7f.webp",
    icon: BriefcaseBusiness,
  },
  {
    title: "Entrevista",
    description: "Organize exemplos e responda a perguntas de verdade.",
    image: "/assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp",
    icon: MessageCircleMore,
  },
  {
    title: "Apresentação",
    description: "Ensaios objetivos, clareza e perguntas inesperadas.",
    image: "/assets/wolfie/scenes/skill-labs/presentation-lab/desktop.45863e9a8305.webp",
    icon: Presentation,
  },
  {
    title: "Viagem",
    description: "Resolva situações cotidianas com mais autonomia.",
    image: "/assets/wolfie/scenes/daily-life/services/desktop.f4718b4b2fcc.webp",
    icon: Plane,
  },
];

const waveform = [22, 44, 70, 38, 82, 58, 92, 45, 67, 30, 76, 49];

export function LandingPage() {
  return (
    <PublicPage>
      <main>
        <section className="wolfie-hero relative isolate min-h-[790px] overflow-hidden px-5 pb-20 pt-32 sm:pt-36 lg:min-h-[850px]">
          <div className="absolute inset-0 -z-20 bg-[url('/assets/wolfie/standalone/hero-global-studio.webp')] bg-cover bg-[62%_center]" />
          <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#07111f_0%,rgba(7,17,31,.96)_31%,rgba(7,17,31,.48)_61%,rgba(7,17,31,.16)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 -z-10 h-56 bg-gradient-to-t from-[#07111f] to-transparent" />
          <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.02fr_.98fr]">
            <div className="max-w-2xl pt-6 lg:pt-16">
              <p className="inline-flex items-center gap-2 rounded-full border border-amber-200/20 bg-amber-200/10 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.16em] text-amber-200 backdrop-blur-md">
                <Sparkles size={15} aria-hidden="true" /> Inglês para situações reais
              </p>
              <h1 className="mt-7 font-display text-[clamp(3rem,6.5vw,6.4rem)] font-extrabold leading-[.91] tracking-[-0.065em] text-white">
                Treine a conversa <span className="text-[#ffbf69]">antes</span> que ela aconteça.
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-8 text-slate-200 sm:text-xl">O Wolfie transforma seu objetivo em uma simulação por voz ou texto e corrige o que realmente muda sua comunicação.</p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <WolfieLink href="/quiz" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-[#ffbf69] px-7 py-4 font-extrabold text-[#101827] shadow-2xl shadow-orange-500/20 transition hover:-translate-y-0.5 hover:bg-[#ffd09a]">
                  Descobrir meu primeiro treino <ArrowRight size={19} aria-hidden="true" />
                </WolfieLink>
                <WolfieLink href="/entrar" className="inline-flex min-h-14 items-center justify-center rounded-full border border-white/[.18] bg-white/[.08] px-7 py-4 font-bold text-white backdrop-blur-md transition hover:bg-white/[.13]">Já sou aluno</WolfieLink>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold text-slate-300">
                <span className="inline-flex items-center gap-2"><Check size={16} className="text-emerald-300" /> Voz e texto</span>
                <span className="inline-flex items-center gap-2"><Check size={16} className="text-emerald-300" /> Feedback no contexto</span>
                <span className="inline-flex items-center gap-2"><Check size={16} className="text-emerald-300" /> {ALL_EXPERIENCES.length} experiências</span>
              </div>
            </div>

            <div className="relative min-h-[480px] lg:min-h-[620px]" aria-label="Demonstração visual do Wolfie conversando">
              <div className="absolute inset-x-[4%] bottom-[4%] top-[4%] rounded-[48%_48%_34%_34%/44%_44%_24%_24%] border border-white/15 bg-[#03070d]/55 shadow-[0_45px_120px_rgba(0,0,0,.48)] backdrop-blur-[2px]" />
              <div className="wolfie-mascot-cutout absolute inset-x-[7%] bottom-0 top-[1%]">
                <img src="/assets/wolfie/wolfie-tutor-mascot.webp" alt="Wolfie, tutor de inglês em 3D" className="h-full w-full object-cover object-top" fetchPriority="high" />
              </div>
              <div className="absolute right-0 top-[12%] max-w-[245px] rounded-[24px_24px_5px_24px] border border-white/15 bg-[#f8f5ef]/95 p-4 text-[#111827] shadow-2xl backdrop-blur-md sm:right-[2%]">
                <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#925516]">Simulação ao vivo</p>
                <p className="mt-2 text-sm font-bold leading-5">“Let’s rehearse how you’ll open the meeting.”</p>
              </div>
              <div className="absolute bottom-[8%] left-0 right-0 mx-auto flex w-[min(88%,420px)] items-center gap-4 rounded-3xl border border-white/[.14] bg-[#07111f]/[.88] p-4 shadow-2xl backdrop-blur-xl">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-emerald-300 text-[#07111f]"><Mic2 size={21} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-emerald-200">Wolfie está ouvindo</p>
                  <div className="mt-2 flex h-6 items-center gap-1" aria-hidden="true">
                    {waveform.map((height, index) => <span key={index} className="wolfie-wavebar w-1 rounded-full bg-emerald-300" style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }} />)}
                  </div>
                </div>
                <Volume2 size={20} className="text-slate-300" />
              </div>
            </div>
          </div>
        </section>

        <section id="experiencias" className="bg-[#07111f] px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl">
              <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#ffbf69]">Seu inglês tem um destino</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold leading-tight tracking-[-0.045em] text-white sm:text-6xl">Não é uma aula genérica. É a situação que você precisa viver.</h2>
              <p className="mt-5 text-lg leading-8 text-slate-400">Cada experiência combina cenário, objetivo, nível e formato. Você pratica decisões de comunicação — não frases soltas.</p>
            </div>
            <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              {experiences.map(({ title, description, image, icon: Icon }) => (
                <article key={title} className="group relative min-h-[390px] overflow-hidden rounded-[30px] border border-white/10 bg-slate-900">
                  <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#050b14] via-[#050b14]/45 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-6">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/15 bg-white/10 text-amber-200 backdrop-blur-md"><Icon size={20} /></span>
                    <h3 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-white">{title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-300">{description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#f5f1e9] px-5 py-24 text-[#111827] sm:py-32">
          <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-2">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#9a5414]">Feedback que não corta sua coragem</p>
              <h2 className="mt-4 font-display text-4xl font-extrabold leading-tight tracking-[-0.05em] sm:text-6xl">Fale primeiro. Entenda o ajuste. Tente de novo.</h2>
              <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">O Wolfie mantém a conversa em movimento e transforma os pontos importantes em uma próxima tentativa mais clara.</p>
              <ul className="mt-8 grid gap-4 text-sm font-bold text-slate-700 sm:grid-cols-2">
                <li className="flex gap-3"><Headphones className="mt-0.5 text-[#9a5414]" size={19} /> Compreensão auditiva no cenário</li>
                <li className="flex gap-3"><Languages className="mt-0.5 text-[#9a5414]" size={19} /> Apoio em português quando necessário</li>
                <li className="flex gap-3"><RefreshCcw className="mt-0.5 text-[#9a5414]" size={19} /> Reformulação sem recomeçar tudo</li>
                <li className="flex gap-3"><Mic2 className="mt-0.5 text-[#9a5414]" size={19} /> Voz ou texto no seu ritmo</li>
              </ul>
            </div>
            <div className="rounded-[36px] bg-[#0b1728] p-5 shadow-2xl sm:p-8">
              <div className="rounded-[28px] border border-white/10 bg-[#101f33] p-5 sm:p-7">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-emerald-300">Sua tentativa</p>
                <p className="mt-3 text-lg font-semibold leading-8 text-white">“I want discuss about the next steps with the team.”</p>
              </div>
              <div className="mx-5 h-6 border-l-2 border-dashed border-amber-300/50" />
              <div className="rounded-[28px] border border-amber-200/15 bg-[#ffbf69] p-5 text-[#111827] sm:p-7">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#6c3b0c]">Ajuste útil</p>
                <p className="mt-3 text-lg font-extrabold leading-8">“I’d like to discuss the next steps with the team.”</p>
                <p className="mt-3 text-sm leading-6 text-[#5b3a18]">Depois de <strong>want</strong>, use <strong>to discuss</strong>. Para soar mais colaborativo, <strong>I’d like to…</strong> funciona bem.</p>
              </div>
              <WolfieLink href="/quiz" className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/[.12] bg-white/[.08] font-bold text-white"><RefreshCcw size={17} /> Preparar minha tentativa</WolfieLink>
            </div>
          </div>
        </section>

        <section className="bg-[#0b1728] px-5 py-24 sm:py-32">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-5 md:grid-cols-3">
              {[
                ["01", "Conte seu objetivo", "Um diagnóstico curto organiza contexto, urgência e formato de prática."],
                ["02", "Receba um ponto de partida", "A recomendação é explicável e usa experiências que já existem no Wolfie."],
                ["03", "Entre na simulação", "Alunos entram com a conta Wise Wolf e praticam no motor pedagógico real."],
              ].map(([number, title, description]) => (
                <article key={number} className="rounded-[30px] border border-white/[.09] bg-white/[.035] p-7">
                  <span className="font-display text-5xl font-extrabold text-white/15">{number}</span>
                  <h3 className="mt-7 font-display text-2xl font-extrabold text-white">{title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-400">{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#07111f] px-5 py-24 sm:py-32">
          <div className="mx-auto grid max-w-7xl gap-8 overflow-hidden rounded-[40px] border border-white/10 bg-[radial-gradient(circle_at_85%_20%,rgba(255,191,105,.18),transparent_34%),linear-gradient(135deg,#13243b,#091321)] p-7 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <span className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-emerald-300"><LockKeyhole size={16} /> Privacidade por princípio</span>
              <h2 className="mt-4 max-w-3xl font-display text-4xl font-extrabold tracking-[-0.045em] text-white sm:text-5xl">Seu diagnóstico público não precisa expor sua vida.</h2>
              <p className="mt-5 max-w-2xl leading-7 text-slate-300">As respostas do quiz são escolhas fechadas, sem dados pessoais na URL. Nome e contato só aparecem no fim, com consentimento, se você quiser conversar com a equipe.</p>
            </div>
            <WolfieLink href="/quiz" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full bg-white px-7 py-4 font-extrabold text-[#111827] transition hover:-translate-y-0.5">Começar agora <ArrowRight size={18} /></WolfieLink>
          </div>
        </section>
      </main>
    </PublicPage>
  );
}

export function HowItWorksPage() {
  return (
    <PublicPage>
      <main className="px-5 pb-24 pt-36 sm:pt-44">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#ffbf69]">Como funciona</p>
          <h1 className="mt-5 max-w-4xl font-display text-5xl font-extrabold leading-[.98] tracking-[-0.055em] text-white sm:text-7xl">Do objetivo à conversa, sem uma trilha genérica no meio.</h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-300">O Wolfie usa seu contexto para escolher uma experiência do catálogo e depois adapta a dificuldade durante a prática.</p>
          <div className="mt-14 grid gap-6 md:grid-cols-2">
            {[
              [Sparkles, "Diagnóstico curto", "Oito perguntas fechadas identificam cenário, participação, ponto de partida, bloqueio, formato e ritmo."],
              [Presentation, "Experiência recomendada", "O resultado aponta uma experiência real do catálogo, alternativas e um plano de frequência — sem fingir uma avaliação clínica ou de proficiência."],
              [Mic2, "Conversa por voz ou texto", "Na área autenticada, o mesmo motor do Wolfie oferece simulação, transcrição e continuidade de sessão."],
              [RefreshCcw, "Tentativa orientada", "O feedback explica o ajuste que importa para a mensagem e abre espaço para uma nova tentativa."],
            ].map(([Icon, title, description]) => {
              const FeatureIcon = Icon as typeof Sparkles;
              return (
                <article key={String(title)} className="rounded-[30px] border border-white/10 bg-white/[.035] p-7">
                  <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#ffbf69] text-[#111827]"><FeatureIcon size={21} /></span>
                  <h2 className="mt-6 font-display text-2xl font-extrabold text-white">{String(title)}</h2>
                  <p className="mt-3 leading-7 text-slate-400">{String(description)}</p>
                </article>
              );
            })}
          </div>
          <div className="mt-12 rounded-[34px] bg-[#f5f1e9] p-7 text-[#111827] sm:p-10">
            <h2 className="font-display text-3xl font-extrabold tracking-tight">Pronto para encontrar seu primeiro cenário?</h2>
            <p className="mt-3 text-slate-600">Leva poucos minutos e você vê o resultado antes de informar seus dados.</p>
            <WolfieLink href="/quiz" className="mt-7 inline-flex min-h-14 items-center gap-2 rounded-full bg-[#111827] px-7 py-4 font-extrabold text-white">Começar diagnóstico <ArrowRight size={18} /></WolfieLink>
          </div>
        </div>
      </main>
    </PublicPage>
  );
}

export function AccessPage() {
  return (
    <PublicPage>
      <main className="px-5 pb-24 pt-36 sm:pt-44">
        <div className="mx-auto max-w-5xl text-center">
          <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#ffbf69]">Acesso ao Wolfie</p>
          <h1 className="mx-auto mt-5 max-w-4xl font-display text-5xl font-extrabold tracking-[-0.055em] text-white sm:text-7xl">Comece pelo caminho certo para você.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-300">Não exibimos preço fictício. O acesso segue sua matrícula ou uma conversa com a equipe Wise Wolf.</p>
          <div className="mt-12 grid gap-6 text-left md:grid-cols-2">
            <article className="rounded-[34px] border border-white/10 bg-white/[.04] p-8">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-emerald-300">Já sou aluno</p>
              <h2 className="mt-4 font-display text-3xl font-extrabold text-white">Entrar com minha conta</h2>
              <p className="mt-4 leading-7 text-slate-400">Use o mesmo e-mail e senha da Wise Wolf. A sessão do subdomínio é independente por segurança.</p>
              <WolfieLink href="/entrar" className="mt-8 inline-flex min-h-[52px] items-center gap-2 rounded-full bg-white px-6 py-3.5 font-extrabold text-[#111827]">Entrar agora <ArrowRight size={17} /></WolfieLink>
            </article>
            <article className="rounded-[34px] border border-amber-200/20 bg-[#ffbf69] p-8 text-[#111827]">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#6d3d0e]">Quero conhecer</p>
              <h2 className="mt-4 font-display text-3xl font-extrabold">Descobrir meu treino</h2>
              <p className="mt-4 leading-7 text-[#5a3b1d]">Faça o diagnóstico, veja a recomendação e escolha se deseja deixar seu contato no final.</p>
              <WolfieLink href="/quiz" className="mt-8 inline-flex min-h-[52px] items-center gap-2 rounded-full bg-[#111827] px-6 py-3.5 font-extrabold text-white">Começar diagnóstico <ArrowRight size={17} /></WolfieLink>
            </article>
          </div>
        </div>
      </main>
    </PublicPage>
  );
}
