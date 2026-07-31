import React, { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  AudioLines,
  BookOpen,
  BrainCircuit,
  BriefcaseBusiness,
  CheckCircle2,
  Compass,
  Gamepad2,
  Globe2,
  Mic2,
  Orbit,
  Palette,
  Puzzle,
  Rocket,
  ScanFace,
  Sparkles,
  Star,
  Target,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  getExperienceById,
  type LearningExperience,
} from './experienceCatalog';
import type { CefrLevel } from './types';
import { focusRing } from './WolfieActivityUI';

interface PremiumImmersionHeroProps {
  firstName: string;
  profileLevel: CefrLevel | null;
  onStart: () => void;
  onExplore: () => void;
}

interface KidsAdventureZoneProps {
  onChoose: (experience: LearningExperience) => void;
}

const immersionModes: Array<{
  label: string;
  detail: string;
  icon: LucideIcon;
}> = [
  {
    label: 'Voice Studio',
    detail: 'Fale e tente novamente',
    icon: AudioLines,
  },
  {
    label: 'Story Worlds',
    detail: 'Sua vida vira narrativa',
    icon: Sparkles,
  },
  {
    label: 'Global Rooms',
    detail: 'Reuniões e carreira',
    icon: Globe2,
  },
  {
    label: 'Kids Quests',
    detail: 'Missões por escolha',
    icon: Gamepad2,
  },
];

const stimulusSteps: Array<{
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    label: 'Escolha',
    description: 'Você decide o universo e o objetivo.',
    icon: Compass,
  },
  {
    label: 'Entre na cena',
    description: 'O contexto transforma conteúdo em experiência.',
    icon: Orbit,
  },
  {
    label: 'Produza',
    description: 'Fale, escreva, responda ou tome uma decisão.',
    icon: Mic2,
  },
  {
    label: 'Evolua',
    description: 'Feedback específico, nova tentativa e transferência.',
    icon: Target,
  },
];

export function PremiumImmersionHero({
  firstName,
  profileLevel,
  onStart,
  onExplore,
}: PremiumImmersionHeroProps) {
  const reduceMotion = useReducedMotion();
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduceMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: y * -7, y: x * 9 });
  };

  return (
    <section
      className="relative isolate overflow-hidden rounded-[2.25rem] border border-white/10 bg-[#071120] text-white shadow-[0_32px_90px_rgba(2,8,23,0.32)]"
      aria-labelledby="wolfie-immersive-title"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-45"
        style={{
          backgroundImage:
            'linear-gradient(rgba(96,165,250,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.08) 1px, transparent 1px)',
          backgroundSize: '42px 42px',
          maskImage:
            'linear-gradient(to bottom, black 15%, transparent 88%)',
        }}
        aria-hidden="true"
      />
      <motion.div
        className="pointer-events-none absolute -left-24 top-0 h-80 w-80 rounded-full bg-blue-500/25 blur-[90px]"
        animate={
          reduceMotion
            ? undefined
            : { x: [0, 70, 0], y: [0, 35, 0], scale: [1, 1.16, 1] }
        }
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden="true"
      />
      <motion.div
        className="pointer-events-none absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-violet-500/20 blur-[100px]"
        animate={
          reduceMotion
            ? undefined
            : { x: [0, -60, 0], y: [0, -25, 0], scale: [1, 1.1, 1] }
        }
        transition={{ duration: 13, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden="true"
      />

      <div className="relative grid min-h-[620px] lg:grid-cols-[minmax(0,1.03fr)_minmax(420px,.97fr)]">
        <div className="flex flex-col justify-center px-6 py-10 sm:px-10 lg:px-12 lg:py-14">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200 backdrop-blur-xl">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
                </span>
                Immersive Learning System
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold text-slate-300 backdrop-blur-xl">
                Olá, {firstName}
                {profileLevel ? ` · ${profileLevel}` : ''}
              </span>
            </div>

            <h1
              id="wolfie-immersive-title"
              className="mt-6 max-w-3xl text-4xl font-black leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl lg:text-[4.25rem]"
            >
              Viva o inglês.
              <span className="mt-1 block bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-400 bg-clip-text text-transparent">
                Não apenas estude.
              </span>
            </h1>
            <p className="mt-6 max-w-2xl text-base font-medium leading-7 text-slate-300 sm:text-lg">
              Sua rotina, sua profissão e sua imaginação se transformam em
              cenas que reagem a você — com voz, escolhas, feedback e novas
              tentativas.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onStart}
                className={`group inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-blue-500 to-indigo-500 px-5 py-3 text-sm font-black text-white shadow-[0_14px_35px_rgba(59,130,246,.35)] transition hover:-translate-y-0.5 hover:from-blue-400 hover:to-indigo-400 ${focusRing}`}
              >
                <Mic2 size={18} aria-hidden="true" />
                Iniciar minha imersão
                <ArrowRight
                  size={16}
                  className="transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                onClick={onExplore}
                className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-black text-white backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-white/10 ${focusRing}`}
              >
                <Orbit size={18} className="text-cyan-300" aria-hidden="true" />
                Explorar mundos
              </button>
            </div>

            <div className="mt-8 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4">
              {immersionModes.map((mode, index) => {
                const Icon = mode.icon;
                return (
                  <motion.div
                    key={mode.label}
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.12 + index * 0.07 }}
                    className="rounded-2xl border border-white/10 bg-white/[0.045] p-3 backdrop-blur-xl"
                  >
                    <Icon size={16} className="text-cyan-300" aria-hidden="true" />
                    <p className="mt-2 text-xs font-black text-white">
                      {mode.label}
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-slate-400">
                      {mode.detail}
                    </p>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </div>

        <div
          className="relative min-h-[470px] overflow-hidden px-4 pb-8 sm:px-8 lg:min-h-0 lg:overflow-visible lg:px-6 lg:py-8"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setTilt({ x: 0, y: 0 })}
          style={{ perspective: '1400px' }}
          aria-label="Visualização tridimensional dos modos de imersão"
        >
          <motion.div
            className="relative mx-auto h-full min-h-[430px] max-w-[520px]"
            animate={{ rotateX: tilt.x, rotateY: tilt.y }}
            transition={{ type: 'spring', stiffness: 120, damping: 18 }}
            style={{ transformStyle: 'preserve-3d' }}
          >
            <motion.div
              className="absolute left-1/2 top-1/2 h-72 w-72 rounded-full border border-cyan-300/15"
              animate={reduceMotion ? { z: 8 } : { rotate: 360, z: 8 }}
              transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
              style={{
                marginLeft: '-9rem',
                marginTop: '-9rem',
                transformStyle: 'preserve-3d',
              }}
              aria-hidden="true"
            >
              <span className="absolute -top-2 left-1/2 h-4 w-4 rounded-full bg-cyan-300 shadow-[0_0_24px_rgba(103,232,249,.9)]" />
              <span className="absolute -bottom-1 left-10 h-3 w-3 rounded-full bg-violet-400 shadow-[0_0_20px_rgba(167,139,250,.85)]" />
            </motion.div>
            <motion.div
              className="absolute left-1/2 top-1/2 h-52 w-52 rounded-full border border-blue-300/20"
              animate={reduceMotion ? { z: 22 } : { rotate: -360, z: 22 }}
              transition={{ duration: 17, repeat: Infinity, ease: 'linear' }}
              style={{ marginLeft: '-6.5rem', marginTop: '-6.5rem' }}
              aria-hidden="true"
            >
              <span className="absolute right-3 top-2 h-2.5 w-2.5 rounded-full bg-blue-300 shadow-[0_0_16px_rgba(147,197,253,.9)]" />
            </motion.div>

            <motion.div
              className="absolute left-1/2 top-1/2 grid h-40 w-40 place-items-center rounded-[2.75rem] border border-cyan-200/25 bg-gradient-to-br from-blue-500/80 via-indigo-600/80 to-violet-700/80 shadow-[0_0_90px_rgba(59,130,246,.42),inset_0_1px_0_rgba(255,255,255,.35)] backdrop-blur-2xl"
              animate={
                reduceMotion
                  ? { z: 70 }
                  : {
                      y: [-8, 8, -8],
                      rotateZ: [-1.5, 1.5, -1.5],
                      z: 70,
                    }
              }
              transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                marginLeft: '-5rem',
                marginTop: '-5rem',
                transformStyle: 'preserve-3d',
              }}
            >
              <div className="text-center">
                <BrainCircuit
                  size={42}
                  className="mx-auto text-white"
                  aria-hidden="true"
                />
                <p className="mt-2 text-xs font-black uppercase tracking-[0.2em] text-cyan-100">
                  Wolfie Core
                </p>
                <p className="mt-1 text-[10px] text-blue-100">
                  adaptação em tempo real
                </p>
              </div>
            </motion.div>

            <motion.div
              initial={
                reduceMotion
                  ? false
                  : {
                      opacity: 0,
                      y: 18,
                      scale: 0.96,
                      z: 115,
                      rotateY: 8,
                    }
              }
              animate={{ opacity: 1, y: 0, scale: 1, z: 115, rotateY: 8 }}
              transition={{ delay: 0.15, duration: 0.5 }}
              className="absolute left-0 top-[12%] w-44 rounded-3xl border border-white/15 bg-white/[0.085] p-4 shadow-2xl backdrop-blur-2xl sm:left-[2%]"
              style={{ transformStyle: 'preserve-3d' }}
            >
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-2xl bg-cyan-300/15 text-cyan-200">
                  <Mic2 size={17} aria-hidden="true" />
                </span>
                <AudioLines size={17} className="text-cyan-300" aria-hidden="true" />
              </div>
              <p className="mt-4 text-xs font-black text-white">Story Mode</p>
              <p className="mt-1 text-[10px] leading-4 text-slate-300">
                Grave 30 segundos. Receba uma correção. Tente de novo.
              </p>
            </motion.div>

            <motion.div
              initial={
                reduceMotion
                  ? false
                  : {
                      opacity: 0,
                      y: 18,
                      scale: 0.96,
                      z: 92,
                      rotateY: -9,
                    }
              }
              animate={{ opacity: 1, y: 0, scale: 1, z: 92, rotateY: -9 }}
              transition={{ delay: 0.28, duration: 0.5 }}
              className="absolute right-0 top-[18%] w-44 rounded-3xl border border-white/15 bg-white/[0.085] p-4 shadow-2xl backdrop-blur-2xl sm:right-[1%]"
              style={{ transformStyle: 'preserve-3d' }}
            >
              <span className="grid h-9 w-9 place-items-center rounded-2xl bg-violet-300/15 text-violet-200">
                <BriefcaseBusiness size={17} aria-hidden="true" />
              </span>
              <p className="mt-4 text-xs font-black text-white">Global Room</p>
              <p className="mt-1 text-[10px] leading-4 text-slate-300">
                Apresente, responda e readapte sua mensagem.
              </p>
            </motion.div>

            <motion.div
              initial={
                reduceMotion
                  ? false
                  : {
                      opacity: 0,
                      y: 18,
                      scale: 0.96,
                      z: 135,
                      rotateX: 4,
                    }
              }
              animate={{ opacity: 1, y: 0, scale: 1, z: 135, rotateX: 4 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              className="absolute bottom-[8%] left-[12%] w-48 rounded-3xl border border-amber-200/20 bg-gradient-to-br from-amber-300/15 to-fuchsia-400/10 p-4 shadow-2xl backdrop-blur-2xl"
              style={{ transformStyle: 'preserve-3d' }}
            >
              <div className="flex items-center gap-2">
                <span className="grid h-9 w-9 place-items-center rounded-2xl bg-amber-300/20 text-amber-200">
                  <Gamepad2 size={18} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-black text-white">Kids Quest</p>
                  <p className="text-[9px] uppercase tracking-wider text-amber-200">
                    missão por escolhas
                  </p>
                </div>
              </div>
              <div className="mt-3 flex gap-1.5" aria-hidden="true">
                {[0, 1, 2, 3].map((step) => (
                  <span
                    key={step}
                    className={`h-1.5 flex-1 rounded-full ${
                      step < 2 ? 'bg-amber-300' : 'bg-white/15'
                    }`}
                  />
                ))}
              </div>
            </motion.div>

            <motion.div
              className="absolute bottom-[14%] right-[6%] rounded-2xl border border-emerald-200/20 bg-emerald-300/10 px-3 py-2 text-[10px] font-black text-emerald-200 backdrop-blur-xl"
              animate={
                reduceMotion ? { z: 82 } : { y: [0, -8, 0], z: 82 }
              }
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
              style={{ transformStyle: 'preserve-3d' }}
            >
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 size={13} aria-hidden="true" />
                Feedback + retry
              </span>
            </motion.div>
          </motion.div>
        </div>
      </div>

      <div className="relative grid border-t border-white/10 bg-black/15 sm:grid-cols-2 lg:grid-cols-4">
        {stimulusSteps.map((step, index) => {
          const Icon = step.icon;
          return (
            <div
              key={step.label}
              className="flex gap-3 border-white/10 px-5 py-4 sm:[&:nth-child(odd)]:border-r lg:border-r lg:last:border-r-0"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5 text-cyan-300">
                <Icon size={16} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-black text-white">
                  {index + 1}. {step.label}
                </p>
                <p className="mt-1 text-[10px] leading-4 text-slate-400">
                  {step.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const kidsWorlds = [
  {
    id: 'game-worlds',
    label: 'Game Worlds',
    tagline: 'Explore, escolha e complete a missão.',
    icon: Gamepad2,
    gradient:
      'from-violet-500 via-fuchsia-500 to-pink-500 shadow-fuchsia-500/25',
    glow: 'bg-fuchsia-300',
    symbol: '01',
  },
  {
    id: 'create-your-avatar',
    label: 'Avatar Lab',
    tagline: 'Crie um personagem e dê voz a ele.',
    icon: ScanFace,
    gradient:
      'from-cyan-500 via-blue-500 to-indigo-600 shadow-blue-500/25',
    glow: 'bg-cyan-300',
    symbol: '02',
  },
  {
    id: 'mystery-adventures',
    label: 'Mystery Island',
    tagline: 'Ouça pistas, faça perguntas e resolva.',
    icon: Puzzle,
    gradient:
      'from-amber-400 via-orange-500 to-rose-500 shadow-orange-500/25',
    glow: 'bg-amber-200',
    symbol: '03',
  },
];

const extraKidsIds = [
  'roblox-inspired-missions',
  'school-life',
  'series-characters',
];

export function KidsAdventureZone({ onChoose }: KidsAdventureZoneProps) {
  const reduceMotion = useReducedMotion();
  const extraKids = useMemo(
    () =>
      extraKidsIds
        .map((id) => getExperienceById(id))
        .filter((item): item is LearningExperience => Boolean(item)),
    [],
  );

  return (
    <section
      className="relative isolate overflow-hidden rounded-[2.25rem] border border-indigo-200/60 bg-[#f7f7ff] p-5 shadow-[0_28px_80px_rgba(79,70,229,.12)] dark:border-white/10 dark:bg-[#0c1022] sm:p-7 lg:p-8"
      aria-labelledby="kids-adventure-title"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(circle at 15% 10%, rgba(217,70,239,.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(34,211,238,.18), transparent 28%), radial-gradient(circle at 60% 100%, rgba(251,146,60,.18), transparent 30%)',
        }}
        aria-hidden="true"
      />
      <motion.div
        className="pointer-events-none absolute right-[8%] top-8 text-fuchsia-400"
        animate={reduceMotion ? undefined : { y: [0, -10, 0], rotate: [0, 8, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden="true"
      >
        <Star size={28} fill="currentColor" />
      </motion.div>
      <motion.div
        className="pointer-events-none absolute bottom-8 left-[4%] text-cyan-400"
        animate={reduceMotion ? undefined : { x: [0, 12, 0], rotate: [0, -8, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden="true"
      >
        <Rocket size={32} />
      </motion.div>

      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-200 bg-white/70 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-fuchsia-700 backdrop-blur-xl dark:border-fuchsia-300/20 dark:bg-white/5 dark:text-fuchsia-200">
            <Gamepad2 size={14} aria-hidden="true" />
            Wolfie Kids Adventure Zone
          </div>
          <h2
            id="kids-adventure-title"
            className="mt-4 text-3xl font-black tracking-[-0.04em] text-slate-950 dark:text-white sm:text-5xl"
          >
            Inglês vira missão.
            <span className="block bg-gradient-to-r from-fuchsia-600 via-violet-600 to-blue-600 bg-clip-text text-transparent dark:from-fuchsia-300 dark:via-violet-300 dark:to-cyan-300">
              A criança vira protagonista.
            </span>
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base">
            Mundos seguros, histórias ramificadas, vocabulário visual e
            correções curtas que mantêm a aventura em movimento.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-wider">
          {['Escolha real', 'Narrativa', 'Feedback curto', 'Nova tentativa'].map(
            (item) => (
              <span
                key={item}
                className="rounded-full border border-indigo-200 bg-white/70 px-3 py-2 text-indigo-700 backdrop-blur-xl dark:border-white/10 dark:bg-white/5 dark:text-indigo-200"
              >
                {item}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="relative mt-8 grid gap-4 lg:grid-cols-3">
        {kidsWorlds.map((world, index) => {
          const experience = getExperienceById(world.id);
          const Icon = world.icon;
          if (!experience) return null;
          return (
            <motion.button
              key={world.id}
              type="button"
              onClick={() => onChoose(experience)}
              initial={reduceMotion ? false : { opacity: 0, y: 22 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ delay: index * 0.08, duration: 0.45 }}
              whileHover={reduceMotion ? undefined : { y: -7, rotateX: 2, rotateY: -2 }}
              className={`group relative min-h-72 overflow-hidden rounded-[2rem] bg-gradient-to-br ${world.gradient} p-5 text-left text-white shadow-2xl ${focusRing}`}
              style={{ perspective: '900px', transformStyle: 'preserve-3d' }}
              aria-label={`${world.label}. ${world.tagline}`}
            >
              <div
                className={`pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full ${world.glow} opacity-35 blur-3xl transition group-hover:scale-125`}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    'linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)',
                  backgroundSize: '30px 30px',
                  maskImage: 'linear-gradient(to bottom, black, transparent 80%)',
                }}
                aria-hidden="true"
              />
              <div className="relative flex items-start justify-between">
                <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/20 bg-white/15 shadow-lg backdrop-blur-xl transition group-hover:scale-110 group-hover:rotate-3">
                  <Icon size={26} aria-hidden="true" />
                </span>
                <span className="text-5xl font-black tracking-[-0.08em] text-white/20">
                  {world.symbol}
                </span>
              </div>
              <div className="relative mt-10">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
                  Interactive world
                </p>
                <h3 className="mt-2 text-2xl font-black">{world.label}</h3>
                <p className="mt-2 max-w-xs text-sm leading-6 text-white/85">
                  {world.tagline}
                </p>
                <span className="mt-5 inline-flex items-center gap-2 rounded-full bg-black/15 px-3 py-2 text-xs font-black backdrop-blur-xl">
                  Entrar na missão
                  <ArrowRight
                    size={15}
                    className="transition-transform group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </span>
              </div>
            </motion.button>
          );
        })}
      </div>

      <div className="relative mt-5 grid gap-4 rounded-[1.75rem] border border-indigo-200/70 bg-white/75 p-4 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.045] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center sm:p-5">
        <div>
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-indigo-700 dark:text-cyan-200">
            <WandSparkles size={16} aria-hidden="true" />
            Como a missão estimula
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {[
              'Escolher personagem',
              'Ver vocabulário',
              'Tomar uma decisão',
              'Falar ou escrever',
              'Receber correção curta',
              'Tentar novamente',
            ].map((step, index) => (
              <React.Fragment key={step}>
                <span className="inline-flex min-h-9 items-center rounded-xl bg-indigo-50 px-3 py-2 text-[11px] font-bold text-indigo-950 dark:bg-white/5 dark:text-slate-200">
                  <span className="mr-2 text-indigo-500 dark:text-cyan-300">
                    {index + 1}
                  </span>
                  {step}
                </span>
                {index < 5 ? (
                  <ArrowRight
                    size={13}
                    className="hidden text-indigo-300 sm:block"
                    aria-hidden="true"
                  />
                ) : null}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {extraKids.map((experience, index) => {
            const Icon = [Rocket, BookOpen, Palette][index] ?? Star;
            return (
              <button
                key={experience.id}
                type="button"
                onClick={() => onChoose(experience)}
                className={`group grid min-h-24 min-w-24 place-items-center rounded-2xl border border-indigo-100 bg-white p-3 text-center shadow-sm transition hover:-translate-y-1 hover:border-indigo-300 hover:shadow-md dark:border-white/10 dark:bg-white/5 ${focusRing}`}
              >
                <Icon
                  size={18}
                  className="text-indigo-600 transition group-hover:scale-110 dark:text-cyan-300"
                  aria-hidden="true"
                />
                <span className="mt-2 text-[10px] font-black leading-4 text-slate-800 dark:text-slate-200">
                  {experience.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
