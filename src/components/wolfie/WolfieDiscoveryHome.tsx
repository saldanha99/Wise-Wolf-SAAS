import React, { type RefObject, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FlaskConical,
  Gamepad2,
  Globe2,
  GraduationCap,
  HeartPulse,
  Home,
  Languages,
  Loader2,
  type LucideIcon,
  Mic2,
  Play,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import {
  ALL_EXPERIENCES,
  type ExperienceAudience,
  type ExperienceModality,
  type ExperienceSkill,
  experienceSupportsAudience,
  FEATURED_EXPERIENCES,
  getExperienceById,
  getUniverseForExperience,
  inferExperienceAudience,
  LEARNING_UNIVERSES,
  type LearningExperience,
  pickAudienceCompatibleExperience,
  recommendExperiences,
} from "./experienceCatalog";
import { getSubjectOption } from "./catalog";
import type {
  CefrLevel,
  WolfieActivitySession,
  WolfieCorrectionMode,
  WolfieDifficulty,
  WolfieExperienceMode,
  WolfieLanguageMode,
  WolfieOverview,
  WolfieUserSummary,
} from "./types";
import {
  focusRing,
  InlineError,
  primaryButton,
  secondaryButton,
} from "./WolfieActivityUI";
import {
  KidsAdventureZone,
  PremiumImmersionHero,
} from "./WolfieImmersiveExperience";

export interface ResumableWolfieConversation {
  id: string;
  topic: string;
  student_level: CefrLevel;
  experience_mode: WolfieExperienceMode;
  correction_mode: WolfieCorrectionMode;
  language_mode: WolfieLanguageMode;
  difficulty: WolfieDifficulty;
  scenario_context: string | null;
  student_goal: string | null;
  target_skill: string | null;
  scenario_status: "active" | "awaiting_retry";
  last_activity_at: string;
}

interface WolfieDiscoveryHomeProps {
  user: WolfieUserSummary;
  firstName: string;
  profileLevel: CefrLevel | null;
  overview: WolfieOverview | null;
  overviewError: string;
  resumableConversation: ResumableWolfieConversation | null;
  endingSessionId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onChooseExperience: (experience: LearningExperience) => void;
  onOpenRepertoire: () => void;
  onReloadOverview: () => void;
  onResumeSession: (session: WolfieActivitySession) => void;
  onResumeConversation: (
    session: ResumableWolfieConversation,
  ) => void;
  onEndSession: (sessionId: string) => void;
  onEndConversation: (conversationId: string) => void;
  repertoireAvailable?: boolean;
  /** Cartão de início em um toque, renderizado acima do catálogo. */
  quickStart?: React.ReactNode;
}

type QuickActionTone = "accent" | "blue" | "amber" | "violet";

const quickActionStyles: Record<
  QuickActionTone,
  { icon: string; surface: string }
> = {
  accent: {
    icon: "bg-brand-accent text-white",
    surface: "hover:border-brand-accent",
  },
  blue: {
    icon: "bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300",
    surface: "hover:border-sky-400",
  },
  amber: {
    icon:
      "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300",
    surface: "hover:border-amber-400",
  },
  violet: {
    icon:
      "bg-violet-100 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300",
    surface: "hover:border-violet-400",
  },
};

const universeIcons: Record<string, LucideIcon> = {
  "about-you": UserRound,
  "daily-life": Home,
  speaking: Mic2,
  "kids-teens": Gamepad2,
  career: BriefcaseBusiness,
  "global-meetings": Globe2,
  events: Presentation,
  "international-exams": GraduationCap,
  "skill-labs": FlaskConical,
};

const universeIconStyles: Record<string, string> = {
  "about-you":
    "bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300",
  "daily-life":
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300",
  speaking: "bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300",
  "kids-teens":
    "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300",
  career:
    "bg-violet-100 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300",
  "global-meetings":
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300",
  events:
    "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/70 dark:text-fuchsia-300",
  "international-exams":
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/70 dark:text-cyan-300",
  "skill-labs":
    "bg-orange-100 text-orange-700 dark:bg-orange-950/70 dark:text-orange-300",
};

const featuredStyles = [
  "from-rose-500/15 via-brand-surface to-brand-surface",
  "from-sky-500/15 via-brand-surface to-brand-surface",
  "from-emerald-500/15 via-brand-surface to-brand-surface",
  "from-violet-500/15 via-brand-surface to-brand-surface",
  "from-amber-500/15 via-brand-surface to-brand-surface",
  "from-indigo-500/15 via-brand-surface to-brand-surface",
  "from-cyan-500/15 via-brand-surface to-brand-surface",
];

const kidsFeaturedExperiences = [
  {
    experienceId: "game-worlds",
    title: "Entre em um mundo de missões",
    description:
      "Escolha caminhos, encontre objetos e use inglês para avançar na aventura.",
    callToAction: "Começar uma missão segura e divertida.",
    metaLabel: "Game Worlds",
  },
  {
    experienceId: "create-your-avatar",
    title: "Crie seu próprio avatar",
    description:
      "Escolha aparência, personalidade e poderes enquanto pratica descrições.",
    callToAction: "Dar vida ao personagem em inglês.",
    metaLabel: "Criatividade",
  },
  {
    experienceId: "school-life",
    title: "Viva uma situação na escola",
    description:
      "Converse com colegas e resolva um desafio curto do cotidiano escolar.",
    callToAction: "Usar inglês em uma missão escolar.",
    metaLabel: "School Life",
  },
  {
    experienceId: "mystery-adventures",
    title: "Resolva um mistério",
    description: "Ouça pistas, faça perguntas e descubra o que aconteceu.",
    callToAction: "Investigar em inglês.",
    metaLabel: "Mystery Adventures",
  },
];

const SKILL_FILTERS: Array<{
  value: "all" | ExperienceSkill;
  label: string;
}> = [
  { value: "all", label: "Todas as habilidades" },
  { value: "speaking", label: "Speaking" },
  { value: "listening", label: "Listening" },
  { value: "writing", label: "Writing" },
  { value: "vocabulary", label: "Vocabulário" },
  { value: "pronunciation", label: "Pronúncia" },
  { value: "presentation", label: "Apresentação" },
  { value: "reading", label: "Reading" },
];

const AUDIENCE_FILTERS: Array<{
  value: "all" | ExperienceAudience;
  label: string;
}> = [
  { value: "all", label: "Todos os perfis" },
  { value: "adult", label: "Adultos" },
  { value: "professional", label: "Profissionais" },
  { value: "kids", label: "Crianças" },
  { value: "teens", label: "Adolescentes" },
];

const MODALITY_FILTERS: Array<{
  value: "all" | ExperienceModality;
  label: string;
}> = [
  { value: "all", label: "Áudio ou texto" },
  { value: "voice", label: "Com voz" },
  { value: "text", label: "Por texto" },
  { value: "mixed", label: "Modo misto" },
];

const subjectExperienceFallback: Record<string, string> = {
  vocabulary: "vocabulary-lab",
  grammar: "give-your-opinion",
  listening: "listening-lab",
  reading: "exam-cambridge",
  writing: "writing-lab",
  global_meetings: "meetings-business",
  conversation: "record-a-story",
};

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const experienceSearchText = (experience: LearningExperience) =>
  normalizeSearch(
    [
      experience.title,
      experience.description,
      experience.realWorldGoal,
      ...experience.searchTerms,
    ].join(" "),
  );

const readableSkill = (skill: ExperienceSkill) => {
  const option = SKILL_FILTERS.find((item) => item.value === skill);
  return option?.label ?? skill;
};

const buildFocusSummary = (experience: LearningExperience) =>
  [
    `Experiência: ${experience.title}.`,
    experience.description,
    `Objetivo real: ${experience.realWorldGoal}`,
    `Habilidades: ${experience.skills.map(readableSkill).join(", ")}.`,
    `Modalidades: ${experience.modalities.join(", ")}.`,
  ].join(" ");

export const experienceToSelectionContext = (
  experience: LearningExperience,
) => {
  const universe = getUniverseForExperience(experience.id);
  return {
    experienceId: experience.id,
    experienceTitle: experience.title,
    experienceDescription: experience.description,
    experienceContext: buildFocusSummary(experience),
    experienceUniverse: universe?.id,
    experienceAudiences: experience.audiences,
    realWorldGoal: experience.realWorldGoal,
    experienceMode: experience.experienceMode,
  };
};

const recommendedExperienceFor = (
  user: WolfieUserSummary,
): LearningExperience =>
  recommendExperiences({
    role: [user.occupation, user.studentCategory, user.student_category].filter(
      Boolean,
    ).join(" "),
    goal: [
      user.englishFor,
      user.english_for,
      user.shortTermGoal,
      user.short_term_goal,
    ].filter(Boolean).join(" "),
    interests: [
      ...(user.interests ?? []),
      ...(user.preferredTopics ?? []),
      ...(user.preferred_topics ?? []),
    ],
    audience: inferExperienceAudience(user),
  }, 1)[0] ?? getExperienceById("record-a-story") ?? ALL_EXPERIENCES[0];

const dailyExperience = (audience: ExperienceAudience) => {
  const dailyIds = audience === "kids"
    ? [
      "game-worlds",
      "create-your-avatar",
      "mystery-adventures",
      "roblox-inspired-missions",
    ]
    : audience === "teens"
    ? [
      "school-life",
      "series-characters",
      "mystery-adventures",
      "speak-for-a-minute",
    ]
    : [
      "speak-for-a-minute",
      "describe-what-you-see",
      "give-your-opinion",
      "record-a-story",
      "tell-a-story",
      "introduce-yourself",
    ];
  const today = new Date();
  const dayNumber = Math.floor(
    Date.UTC(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    ) / 86_400_000,
  );
  return (
    getExperienceById(dailyIds[dayNumber % dailyIds.length]) ??
      ALL_EXPERIENCES[0]
  );
};

function QuickAction({
  eyebrow,
  title,
  description,
  cta,
  icon: Icon,
  tone,
  onClick,
}: {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  icon: LucideIcon;
  tone: QuickActionTone;
  onClick: () => void;
}) {
  const styles = quickActionStyles[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-52 flex-col rounded-3xl border border-brand-border bg-brand-surface p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-5 ${styles.surface} ${focusRing}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl ${styles.icon}`}
        >
          <Icon size={19} aria-hidden="true" />
        </span>
        <ArrowRight
          size={17}
          className="text-brand-muted transition group-hover:translate-x-1 group-hover:text-brand-accent"
          aria-hidden="true"
        />
      </div>
      <p className="mt-4 text-[11px] font-black uppercase tracking-[0.14em] text-brand-accent">
        {eyebrow}
      </p>
      <h3 className="mt-2 text-base font-black leading-5 text-brand-text">
        {title}
      </h3>
      <p className="mt-2 flex-1 text-xs leading-5 text-brand-muted">
        {description}
      </p>
      <span className="mt-4 text-xs font-black text-brand-accent">
        {cta}
      </span>
    </button>
  );
}

function ExperienceButton({
  experience,
  onChoose,
}: {
  experience: LearningExperience;
  onChoose: (experience: LearningExperience) => void;
}) {
  const duration = Math.min(...experience.durations);
  return (
    <button
      type="button"
      onClick={() => onChoose(experience)}
      className={`group flex min-h-36 flex-col rounded-2xl border border-brand-border bg-brand-bg p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-accent hover:bg-brand-surface-2 ${focusRing}`}
      aria-label={`${experience.title}. ${experience.description}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-black leading-5 text-brand-text">
          {experience.title}
        </h3>
        <ArrowRight
          size={16}
          className="mt-0.5 shrink-0 text-brand-muted transition group-hover:translate-x-1 group-hover:text-brand-accent"
          aria-hidden="true"
        />
      </div>
      <p className="mt-2 flex-1 text-xs leading-5 text-brand-muted">
        {experience.description}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold text-brand-muted">
        <span className="rounded-full bg-brand-surface px-2 py-1">
          {readableSkill(experience.skills[0])}
        </span>
        <span className="rounded-full bg-brand-surface px-2 py-1">
          a partir de {duration} min
        </span>
      </div>
    </button>
  );
}

export function WolfieDiscoveryHome({
  user,
  firstName,
  profileLevel,
  overview,
  overviewError,
  resumableConversation,
  endingSessionId,
  headingRef,
  onChooseExperience,
  onOpenRepertoire,
  onReloadOverview,
  onResumeSession,
  onResumeConversation,
  onEndSession,
  onEndConversation,
  repertoireAvailable = true,
  quickStart,
}: WolfieDiscoveryHomeProps) {
  const [query, setQuery] = useState("");
  const [universeFilter, setUniverseFilter] = useState("all");
  const [skillFilter, setSkillFilter] = useState<"all" | ExperienceSkill>(
    "all",
  );
  const [audienceFilter, setAudienceFilter] = useState<
    "all" | ExperienceAudience
  >("all");
  const [durationFilter, setDurationFilter] = useState<"all" | number>("all");
  const [modalityFilter, setModalityFilter] = useState<
    "all" | ExperienceModality
  >("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [expandedUniverses, setExpandedUniverses] = useState<
    Record<string, boolean>
  >({});

  const profileAudience = useMemo(
    () => inferExperienceAudience(user),
    [user],
  );
  const activitySupportsProfile = (session: WolfieActivitySession) => {
    if (profileAudience !== "kids" && profileAudience !== "teens") return true;
    const experienceId = session.activity_content.experience?.id;
    const experience = experienceId
      ? getExperienceById(experienceId)
      : undefined;
    if (experience) {
      return experienceSupportsAudience(experience, profileAudience);
    }
    return profileAudience === "teens" && session.subject !== "global_meetings";
  };
  const compatibleConversation = resumableConversation &&
      (profileAudience !== "kids" ||
        resumableConversation.experience_mode === "child_mission" ||
        resumableConversation.experience_mode === "teen_challenge" ||
        /universo selecionado:\s*kids-teens/i.test(
          resumableConversation.scenario_context ?? "",
        )) &&
      (profileAudience !== "teens" ||
        !["global_meeting", "interview"].includes(
          resumableConversation.experience_mode,
        ))
    ? resumableConversation
    : null;
  const compatibleResumableSessions = (overview?.resumableSessions ?? [])
    .filter(activitySupportsProfile);
  const compatibleRecentSessions = (overview?.recentSessions ?? [])
    .filter(activitySupportsProfile);

  const recommendation = useMemo(
    () => recommendedExperienceFor(user),
    [user],
  );
  const challenge = useMemo(
    () => dailyExperience(profileAudience),
    [profileAudience],
  );
  const featuredExperiences = useMemo(() => {
    const candidates = profileAudience === "kids"
      ? kidsFeaturedExperiences
      : FEATURED_EXPERIENCES;
    return candidates.filter((featured) => {
      const item = getExperienceById(featured.experienceId);
      return item && experienceSupportsAudience(item, profileAudience);
    });
  }, [profileAudience]);
  const introExperience = getExperienceById(
    profileAudience === "kids"
      ? "game-worlds"
      : profileAudience === "teens"
      ? "school-life"
      : "introduce-yourself",
  ) ?? ALL_EXPERIENCES[0];
  const resumableActivity = compatibleResumableSessions[0] ?? null;
  const latestRecent = compatibleRecentSessions[0] ?? null;
  const hasActiveSessions = Boolean(
    compatibleConversation || compatibleResumableSessions.length,
  );

  const dueReviewCount = useMemo(() => {
    const now = Date.now();
    return (overview?.repertoire ?? []).filter((item) => {
      if (!item.next_review_at) return false;
      const value = new Date(item.next_review_at).getTime();
      return Number.isFinite(value) && value <= now;
    }).length;
  }, [overview?.repertoire]);

  const latestSubjectFallback = latestRecent
    ? getExperienceById(
      subjectExperienceFallback[latestRecent.subject] ??
        "record-a-story",
    )
    : introExperience;
  const latestFallbackExperience = pickAudienceCompatibleExperience(
    profileAudience,
    [
      latestSubjectFallback,
      recommendation,
      introExperience,
      challenge,
      ...ALL_EXPERIENCES,
    ],
  );

  const continueTitle = compatibleConversation
    ? compatibleConversation.topic
    : resumableActivity
    ? resumableActivity.activity_content.title
    : latestRecent
    ? getSubjectOption(
      latestRecent.subject === "conversation"
        ? "grammar"
        : latestRecent.subject,
    ).title
    : "Comece a falar sobre você";
  const continueDescription = compatibleConversation
    ? compatibleConversation.scenario_status === "awaiting_retry"
      ? "Sua reformulação está esperando uma nova tentativa."
      : "A conversa foi salva no ponto em que você parou."
    : resumableActivity
    ? "Sua atividade está salva e pronta para continuar."
    : latestRecent
    ? "Use sua última habilidade em uma situação diferente."
    : "Construa uma apresentação que soe como você.";
  const continueAction = () => {
    if (compatibleConversation) {
      onResumeConversation(compatibleConversation);
      return;
    }
    if (resumableActivity) {
      onResumeSession(resumableActivity);
      return;
    }
    if (latestFallbackExperience) {
      onChooseExperience(latestFallbackExperience);
    }
  };

  const normalizedQuery = normalizeSearch(query);
  const hasFilters = normalizedQuery.length > 0 ||
    universeFilter !== "all" ||
    skillFilter !== "all" ||
    audienceFilter !== "all" ||
    durationFilter !== "all" ||
    modalityFilter !== "all";

  const filteredUniverses = useMemo(
    () =>
      LEARNING_UNIVERSES.map((universe) => ({
        ...universe,
        items: universe.items.filter((item) => {
          if (
            (profileAudience === "kids" || profileAudience === "teens") &&
            !experienceSupportsAudience(item, profileAudience)
          ) {
            return false;
          }
          if (
            universeFilter !== "all" &&
            universe.id !== universeFilter
          ) {
            return false;
          }
          if (
            normalizedQuery &&
            !experienceSearchText(item).includes(normalizedQuery)
          ) {
            return false;
          }
          if (
            skillFilter !== "all" &&
            !item.skills.includes(skillFilter)
          ) {
            return false;
          }
          if (
            audienceFilter !== "all" &&
            !item.audiences.includes(audienceFilter) &&
            !item.audiences.includes("all")
          ) {
            return false;
          }
          if (
            durationFilter !== "all" &&
            !item.durations.includes(durationFilter)
          ) {
            return false;
          }
          if (
            modalityFilter !== "all" &&
            !item.modalities.includes(modalityFilter)
          ) {
            return false;
          }
          return true;
        }),
      })).filter((universe) => universe.items.length > 0),
    [
      audienceFilter,
      durationFilter,
      modalityFilter,
      normalizedQuery,
      profileAudience,
      skillFilter,
      universeFilter,
    ],
  );

  const resultCount = filteredUniverses.reduce(
    (total, universe) => total + universe.items.length,
    0,
  );

  const resetFilters = () => {
    setQuery("");
    setUniverseFilter("all");
    setSkillFilter("all");
    setAudienceFilter("all");
    setDurationFilter("all");
    setModalityFilter("all");
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-7 sm:py-8">
      {/* Início em um toque acima de tudo: o catálogo continua disponível,
          mas deixa de ser o pedágio para chegar à IA. */}
      {quickStart ? <div className="mb-6">{quickStart}</div> : null}
      <PremiumImmersionHero
        firstName={firstName}
        profileLevel={profileLevel}
        onStart={() => onChooseExperience(introExperience)}
        onExplore={() =>
          document
            .getElementById("wolfie-universes")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />

      {overviewError
        ? (
          <div className="mt-5">
            <InlineError
              message={overviewError}
              onRetry={onReloadOverview}
            />
          </div>
        )
        : null}

      <section className="mt-8" aria-labelledby="continue-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-accent">
              Sua prática agora
            </p>
            <h2
              id="continue-title"
              className="mt-2 text-2xl font-black tracking-tight text-brand-text"
            >
              Continue de onde parou
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-brand-muted">
            Um próximo passo claro, uma revisão útil e um desafio que cabe no
            seu dia.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction
            eyebrow="Última atividade"
            title={continueTitle}
            description={continueDescription}
            cta={hasActiveSessions ? "Continuar agora" : "Começar agora"}
            icon={Clock3}
            tone="accent"
            onClick={continueAction}
          />
          <QuickAction
            eyebrow="Próxima recomendação"
            title={recommendation.title}
            description={recommendation.realWorldGoal}
            cta="Praticar esta situação"
            icon={WandSparkles}
            tone="blue"
            onClick={() => onChooseExperience(recommendation)}
          />
          <QuickAction
            eyebrow={repertoireAvailable ? 'Correção para revisar' : 'Repertório pedagógico'}
            title={!repertoireAvailable
              ? 'Consulte a disponibilidade no seu plano'
              : dueReviewCount > 0
              ? `${dueReviewCount} ${
                dueReviewCount === 1 ? "expressão espera" : "expressões esperam"
              } por você`
              : overview?.repertoireCount
              ? "Fortaleça seu repertório"
              : "Sua revisão nasce da prática"}
            description={!repertoireAvailable
              ? 'A prática continua isolada nesta conta; a revisão inteligente só abre quando estiver incluída na assinatura.'
              : dueReviewCount > 0
              ? "Recupere o que aprendeu antes que a expressão fique distante."
              : overview?.repertoireCount
              ? `${overview.repertoireCount} expressões já estão conectadas às suas atividades.`
              : "As correções e expressões importantes aparecerão aqui para voltar no momento certo."}
            cta={repertoireAvailable ? 'Abrir revisão inteligente' : 'Ver disponibilidade'}
            icon={RefreshCw}
            tone="amber"
            onClick={onOpenRepertoire}
          />
          <QuickAction
            eyebrow="Desafio diário"
            title={challenge.title}
            description={challenge.description}
            cta={`Aceitar desafio · ${Math.min(...challenge.durations)} min`}
            icon={Sparkles}
            tone="violet"
            onClick={() => onChooseExperience(challenge)}
          />
        </div>
      </section>

      {hasActiveSessions
        ? (
          <details className="mt-4 rounded-2xl border border-brand-border bg-brand-surface">
            <summary
              className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-black text-brand-text sm:px-5 ${focusRing}`}
            >
              <span className="inline-flex items-center gap-2">
                <Clock3
                  size={16}
                  className="text-brand-accent"
                  aria-hidden="true"
                />
                Gerenciar práticas em andamento
              </span>
              <ChevronDown
                size={17}
                className="text-brand-muted"
                aria-hidden="true"
              />
            </summary>
            <div className="grid gap-3 border-t border-brand-border p-4 lg:grid-cols-2">
              {compatibleConversation
                ? (
                  <article className="rounded-2xl bg-brand-bg p-4">
                    <p className="text-[11px] font-black uppercase tracking-wider text-brand-accent">
                      Conversa · {compatibleConversation.student_level}
                    </p>
                    <h3 className="mt-2 font-black text-brand-text">
                      {compatibleConversation.topic}
                    </h3>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          onResumeConversation(compatibleConversation)}
                        className={primaryButton}
                      >
                        <Mic2 size={15} aria-hidden="true" />
                        Continuar
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onEndConversation(compatibleConversation.id)}
                        disabled={Boolean(endingSessionId)}
                        className={secondaryButton}
                      >
                        {endingSessionId === compatibleConversation.id
                          ? (
                            <Loader2
                              size={15}
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          )
                          : <Trash2 size={15} aria-hidden="true" />}
                        Encerrar
                      </button>
                    </div>
                  </article>
                )
                : null}
              {compatibleResumableSessions.map((session) => (
                <article
                  key={session.id}
                  className="rounded-2xl bg-brand-bg p-4"
                >
                  <p className="text-[11px] font-black uppercase tracking-wider text-brand-accent">
                    {getSubjectOption(session.subject).shortTitle} ·{" "}
                    {session.cefr_level}
                  </p>
                  <h3 className="mt-2 font-black text-brand-text">
                    {session.activity_content.title}
                  </h3>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onResumeSession(session)}
                      className={primaryButton}
                    >
                      <Play size={15} aria-hidden="true" />
                      Continuar
                    </button>
                    <button
                      type="button"
                      onClick={() => onEndSession(session.id)}
                      disabled={Boolean(endingSessionId)}
                      className={secondaryButton}
                    >
                      {endingSessionId === session.id
                        ? (
                          <Loader2
                            size={15}
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        )
                        : <Trash2 size={15} aria-hidden="true" />}
                      Encerrar
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </details>
        )
        : null}

      <div className="mt-10">
        <KidsAdventureZone onChoose={onChooseExperience} />
      </div>

      <section className="mt-10" aria-labelledby="featured-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-accent">
              Situações para viver
            </p>
            <h2
              id="featured-title"
              className="mt-2 text-2xl font-black tracking-tight text-brand-text"
            >
              Escolha pelo que você quer conseguir fazer
            </h2>
          </div>
          <span className="text-xs font-bold text-brand-muted">
            Arraste para explorar
          </span>
        </div>
        <div className="-mx-4 mt-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-3 sm:-mx-7 sm:px-7">
          {featuredExperiences.map((featured, index) => {
            const item = getExperienceById(featured.experienceId);
            if (!item) return null;
            return (
              <button
                key={featured.title}
                type="button"
                onClick={() => onChooseExperience(item)}
                className={`group flex w-[min(84vw,22rem)] shrink-0 snap-start flex-col rounded-3xl border border-brand-border bg-gradient-to-br p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md sm:min-h-72 ${
                  featuredStyles[index % featuredStyles.length]
                } ${focusRing}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-full bg-brand-bg/80 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.13em] text-brand-accent">
                    {featured.metaLabel}
                  </span>
                  <ArrowRight
                    size={17}
                    className="text-brand-muted transition group-hover:translate-x-1 group-hover:text-brand-accent"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="mt-5 text-xl font-black leading-6 text-brand-text">
                  {featured.title}
                </h3>
                <p className="mt-3 flex-1 text-sm leading-6 text-brand-muted">
                  {featured.description}
                </p>
                <span className="mt-5 inline-flex items-center gap-2 border-t border-brand-border pt-4 text-xs font-black leading-5 text-brand-accent">
                  {featured.callToAction}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        id="wolfie-universes"
        className="mt-10 scroll-mt-6"
        aria-labelledby="universes-title"
      >
        <div className="max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-accent">
            Explore o que existe dentro do Wolfie
          </p>
          <h2
            id="universes-title"
            className="mt-2 text-3xl font-black tracking-tight text-brand-text"
          >
            Um universo inteiro de prática
          </h2>
          <p className="mt-3 text-sm leading-6 text-brand-muted">
            Procure uma situação da sua vida ou navegue por objetivos. A
            habilidade, o nível e o formato entram a serviço da experiência.
          </p>
        </div>

        <div className="mt-6 rounded-3xl border border-brand-border bg-brand-surface p-4 shadow-sm sm:p-5">
          <label className="relative block">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted"
              aria-hidden="true"
            />
            <span className="sr-only">Buscar situações para praticar</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Busque por rotina, medicina, entrevista, TOEFL, cozinha…"
              className={`h-12 w-full rounded-2xl border border-brand-border bg-brand-bg pl-11 pr-11 text-sm text-brand-text outline-none placeholder:text-brand-muted focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 ${focusRing}`}
            />
            {query
              ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className={`absolute right-3 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text ${focusRing}`}
                  aria-label="Limpar busca"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )
              : null}
          </label>

          <div
            className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1"
            aria-label="Filtrar por universo"
          >
            <button
              type="button"
              onClick={() => setUniverseFilter("all")}
              aria-pressed={universeFilter === "all"}
              className={`shrink-0 rounded-full border px-3 py-2 text-xs font-black transition ${focusRing} ${
                universeFilter === "all"
                  ? "border-brand-accent bg-brand-accent text-white"
                  : "border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent hover:text-brand-accent"
              }`}
            >
              Todos os universos
            </button>
            {LEARNING_UNIVERSES.map((universe) => (
              <button
                key={universe.id}
                type="button"
                onClick={() => setUniverseFilter(universe.id)}
                aria-pressed={universeFilter === universe.id}
                className={`shrink-0 rounded-full border px-3 py-2 text-xs font-black transition ${focusRing} ${
                  universeFilter === universe.id
                    ? "border-brand-accent bg-brand-accent text-white"
                    : "border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent hover:text-brand-accent"
                }`}
              >
                {universe.title}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className="sr-only">Filtrar por habilidade</span>
              <select
                value={skillFilter}
                onChange={(event) =>
                  setSkillFilter(
                    event.target.value as "all" | ExperienceSkill,
                  )}
                className={`h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-xs font-bold text-brand-text outline-none focus:border-brand-accent ${focusRing}`}
              >
                {SKILL_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Filtrar por duração</span>
              <select
                value={durationFilter}
                onChange={(event) =>
                  setDurationFilter(
                    event.target.value === "all"
                      ? "all"
                      : Number(event.target.value),
                  )}
                className={`h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-xs font-bold text-brand-text outline-none focus:border-brand-accent ${focusRing}`}
              >
                <option value="all">Qualquer duração</option>
                {[1, 3, 5, 10, 15].map((duration) => (
                  <option key={duration} value={duration}>
                    {duration} {duration === 1 ? "minuto" : "minutos"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowMoreFilters((current) => !current)}
              aria-expanded={showMoreFilters}
              className={`inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-bg px-3 text-xs font-black text-brand-muted hover:border-brand-accent hover:text-brand-accent ${focusRing}`}
            >
              <Target size={15} aria-hidden="true" />
              Perfil e modalidade
              <ChevronDown
                size={15}
                className={`transition ${showMoreFilters ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            <div className="flex items-center justify-between gap-3 px-1 text-xs font-bold text-brand-muted">
              <span aria-live="polite">
                {resultCount} {resultCount === 1 ? "situação" : "situações"}
              </span>
              {hasFilters
                ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className={`text-brand-accent hover:underline ${focusRing}`}
                  >
                    Limpar filtros
                  </button>
                )
                : null}
            </div>
          </div>

          {showMoreFilters
            ? (
              <div className="mt-3 grid gap-3 border-t border-brand-border pt-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-brand-muted">
                    Perfil
                  </span>
                  <select
                    value={audienceFilter}
                    onChange={(event) =>
                      setAudienceFilter(
                        event.target.value as "all" | ExperienceAudience,
                      )}
                    className={`h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-xs font-bold text-brand-text outline-none focus:border-brand-accent ${focusRing}`}
                  >
                    {AUDIENCE_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-brand-muted">
                    Modalidade
                  </span>
                  <select
                    value={modalityFilter}
                    onChange={(event) =>
                      setModalityFilter(
                        event.target.value as "all" | ExperienceModality,
                      )}
                    className={`h-11 w-full rounded-xl border border-brand-border bg-brand-bg px-3 text-xs font-bold text-brand-text outline-none focus:border-brand-accent ${focusRing}`}
                  >
                    {MODALITY_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )
            : null}
        </div>
      </section>

      {filteredUniverses.length
        ? (
          <div className="mt-6 space-y-5">
            {filteredUniverses.map((universe) => {
              const Icon = universeIcons[universe.id] ?? Languages;
              const expanded = hasFilters ||
                Boolean(expandedUniverses[universe.id]);
              const visibleItems = expanded
                ? universe.items
                : universe.items.slice(0, universe.previewLimit);
              const hiddenCount = universe.items.length - visibleItems.length;
              return (
                <section
                  key={universe.id}
                  className="rounded-[2rem] border border-brand-border bg-brand-surface p-4 shadow-sm sm:p-6"
                  aria-labelledby={`${universe.id}-title`}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                      <span
                        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                          universeIconStyles[universe.id] ??
                            "bg-brand-surface-2 text-brand-accent"
                        }`}
                      >
                        <Icon size={21} aria-hidden="true" />
                      </span>
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.14em] text-brand-accent">
                          {universe.eyebrow}
                        </p>
                        <h2
                          id={`${universe.id}-title`}
                          className="mt-1 text-xl font-black text-brand-text"
                        >
                          {universe.title}
                        </h2>
                        <p className="mt-1 max-w-2xl text-xs leading-5 text-brand-muted sm:text-sm sm:leading-6">
                          {universe.description}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-brand-surface-2 px-3 py-1.5 text-[11px] font-black text-brand-muted">
                      {universe.items.length}{" "}
                      {universe.items.length === 1 ? "situação" : "situações"}
                    </span>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleItems.map((item) => (
                      <React.Fragment key={item.id}>
                        <ExperienceButton
                          experience={item}
                          onChoose={onChooseExperience}
                        />
                      </React.Fragment>
                    ))}
                  </div>
                  {hiddenCount > 0
                    ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedUniverses((current) => ({
                            ...current,
                            [universe.id]: true,
                          }))}
                        className={`mt-4 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black text-brand-accent hover:bg-brand-surface-2 ${focusRing}`}
                      >
                        Ver mais {hiddenCount}{" "}
                        {hiddenCount === 1 ? "situação" : "situações"}
                        <ChevronDown size={15} aria-hidden="true" />
                      </button>
                    )
                    : !hasFilters &&
                        universe.items.length > universe.previewLimit
                    ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedUniverses((current) => ({
                            ...current,
                            [universe.id]: false,
                          }))}
                        className={`mt-4 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black text-brand-accent hover:bg-brand-surface-2 ${focusRing}`}
                      >
                        Mostrar menos
                        <ChevronDown
                          size={15}
                          className="rotate-180"
                          aria-hidden="true"
                        />
                      </button>
                    )
                    : null}
                </section>
              );
            })}
          </div>
        )
        : (
          <section className="mt-6 rounded-3xl border-2 border-dashed border-brand-border bg-brand-surface p-10 text-center">
            <Search
              size={28}
              className="mx-auto text-brand-muted"
              aria-hidden="true"
            />
            <h2 className="mt-3 text-lg font-black text-brand-text">
              Nenhuma situação apareceu com esses filtros
            </h2>
            <p className="mt-2 text-sm text-brand-muted">
              Limpe um filtro ou tente uma palavra mais ampla.
            </p>
            <button
              type="button"
              onClick={resetFilters}
              className={`mt-4 ${secondaryButton}`}
            >
              <X size={15} aria-hidden="true" />
              Limpar filtros
            </button>
          </section>
        )}

      <section
        className="mt-10 grid gap-4 lg:grid-cols-2"
        aria-label="Minha jornada e revisão inteligente"
      >
        <article className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent">
              <BarChart3 size={20} aria-hidden="true" />
            </span>
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-brand-accent">
                Minha jornada
              </p>
              <h2 className="mt-1 text-xl font-black text-brand-text">
                Progresso que descreve o que você já consegue fazer
              </h2>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            {[
              {
                label: "práticas",
                value: overview?.completedSessions ?? "—",
                icon: CheckCircle2,
              },
              {
                label: "média",
                value: overview?.averageScore === null ||
                    overview?.averageScore === undefined
                  ? "—"
                  : `${overview.averageScore}%`,
                icon: Target,
              },
              {
                label: "expressões",
                value: overview?.repertoireCount ?? "—",
                icon: Languages,
              },
            ].map((metric) => {
              const MetricIcon = metric.icon;
              return (
                <div
                  key={metric.label}
                  className="rounded-2xl bg-brand-bg p-3"
                >
                  <MetricIcon
                    size={16}
                    className="text-brand-accent"
                    aria-hidden="true"
                  />
                  <p className="mt-2 text-xl font-black text-brand-text">
                    {metric.value}
                  </p>
                  <p className="mt-1 text-[10px] font-bold text-brand-muted">
                    {metric.label}
                  </p>
                </div>
              );
            })}
          </div>
        </article>

        <button
          type="button"
          onClick={onOpenRepertoire}
          className={`group rounded-3xl border border-brand-border bg-brand-surface p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md sm:p-6 ${focusRing}`}
        >
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300">
              <CalendarClock size={20} aria-hidden="true" />
            </span>
            <ArrowRight
              size={18}
              className="text-brand-muted transition group-hover:translate-x-1 group-hover:text-brand-accent"
              aria-hidden="true"
            />
          </div>
          <p className="mt-5 text-[11px] font-black uppercase tracking-wider text-brand-accent">
            {repertoireAvailable ? 'Revisão inteligente' : 'Recurso da assinatura'}
          </p>
          <h2 className="mt-2 text-xl font-black text-brand-text">
            {repertoireAvailable
              ? 'Seus erros viram novas tentativas — não pontos finais'
              : 'Repertório e revisão sem misturar ambientes'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-brand-muted">
            {repertoireAvailable
              ? 'Recupere expressões no momento certo e use o mesmo repertório em situações diferentes até ele ficar disponível de verdade.'
              : 'Confira se a revisão inteligente está incluída antes de abrir esse histórico pessoal.'}
          </p>
          <span className="mt-5 inline-flex items-center gap-2 text-xs font-black text-brand-accent">
            {repertoireAvailable ? 'Abrir meu repertório' : 'Ver disponibilidade'}
          </span>
        </button>
      </section>

      <section className="mt-8 rounded-3xl border border-brand-border bg-brand-surface-2 p-5 text-center sm:p-7">
        <HeartPulse
          size={22}
          className="mx-auto text-brand-accent"
          aria-hidden="true"
        />
        <p className="mx-auto mt-3 max-w-3xl text-sm font-bold leading-6 text-brand-text">
          Transforme sua casa, sua rotina e sua profissão em experiências reais
          de inglês.
        </p>
        <p className="mx-auto mt-1 max-w-3xl text-xs leading-5 text-brand-muted">
          Escolha uma situação, produza, receba feedback e tente novamente com
          mais autonomia.
        </p>
      </section>
    </main>
  );
}
