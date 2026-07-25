import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Clock3,
  FileText,
  GraduationCap,
  Headphones,
  Languages,
  Loader2,
  Mic,
  PenLine,
  Play,
  Sparkles,
  Target,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  abandonWolfieActivity,
  createWolfieRequestKey,
  generateWolfieActivity,
  getWolfieOverview,
} from '../../services/wolfieActivityService';
import {
  LEVEL_OPTIONS,
  SECTOR_OPTIONS,
  SUBJECT_OPTIONS,
  getSectorOption,
  getSubjectOption,
} from './catalog';
import type {
  CefrLevel,
  WolfieConversationBrief,
  WolfieCorrectionMode,
  WolfieDifficulty,
  WolfieExperienceMode,
  WolfieLanguageMode,
  WolfieActivityResult,
  WolfieActivitySession,
  WolfieOverview,
  WolfieSelection,
  WolfieSubject,
  WolfieUserSummary,
} from './types';
import {
  focusRing,
  inputClass,
  InlineError,
  primaryButton,
  secondaryButton,
} from './WolfieActivityUI';
import { WolfieQuizActivity } from './WolfieQuizActivity';
import { WolfieWritingActivity } from './WolfieWritingActivity';
import { WolfieMeetingActivity } from './WolfieMeetingActivity';
import { WolfieActivitySummary } from './WolfieActivitySummary';
import { WolfieRepertoire } from './WolfieRepertoire';
import { supabase } from '../../../lib/supabase';

const WolfieConversationTutor = React.lazy(
  () => import('../../../components/WolfieTutor'),
);

type FlowView =
  | 'subject'
  | 'level'
  | 'sector'
  | 'mode'
  | 'conversation_setup'
  | 'loading'
  | 'activity'
  | 'summary'
  | 'repertoire'
  | 'generation_error';

const subjectIcons: Record<WolfieSubject, LucideIcon> = {
  vocabulary: Languages,
  grammar: GraduationCap,
  listening: Headphones,
  reading: BookOpen,
  writing: PenLine,
  global_meetings: BriefcaseBusiness,
};

const loadingMessages = [
  'Conectando seu nível ao contexto certo…',
  'Trazendo repertório de outras práticas…',
  'Calibrando o feedback para você…',
  'Preparando uma situação que parece real…',
];

const EXPERIENCE_OPTIONS: Array<{
  id: WolfieExperienceMode;
  title: string;
  description: string;
}> = [
  {
    id: 'free_conversation',
    title: 'Conversa livre',
    description: 'Converse com naturalidade sem perder o objetivo pedagógico.',
  },
  {
    id: 'guided_lesson',
    title: 'Aula guiada',
    description: 'Aprenda uma ideia, pratique e use em uma situação nova.',
  },
  {
    id: 'roleplay',
    title: 'Simulação real',
    description: 'O Wolfie assume um personagem e reage às suas decisões.',
  },
  {
    id: 'presentation',
    title: 'Apresentação',
    description: 'Construa a mensagem, pratique e responda perguntas.',
  },
  {
    id: 'global_meeting',
    title: 'Reunião',
    description: 'Conduza uma conversa profissional com objetivo e pressão.',
  },
  {
    id: 'interview',
    title: 'Entrevista',
    description: 'Responda como candidato e receba aprofundamentos reais.',
  },
  {
    id: 'exam',
    title: 'Preparação para prova',
    description: 'Treine tarefas, tempo e critérios de uma avaliação oral.',
  },
  {
    id: 'writing',
    title: 'Writing falado',
    description: 'Organize ideias oralmente antes de produzir o texto.',
  },
  {
    id: 'pronunciation',
    title: 'Pronúncia',
    description:
      'Pratique frases, ritmo e clareza em contexto; a avaliação dos sons exige uma atividade com gravação.',
  },
  {
    id: 'vocabulary',
    title: 'Vocabulário ativo',
    description: 'Transforme repertório conhecido em fala espontânea.',
  },
  {
    id: 'storytelling',
    title: 'Storytelling',
    description: 'Conte uma história com contexto, ação e reflexão.',
  },
  {
    id: 'child_mission',
    title: 'Missão infantil',
    description: 'Aprenda por desafio, imaginação e pequenas conquistas.',
  },
  {
    id: 'teen_challenge',
    title: 'Desafio teen',
    description: 'Converse sobre temas atuais com missão e progressão.',
  },
  {
    id: 'examiner',
    title: 'Examinador',
    description: 'Receba perguntas objetivas e um parecer ao final.',
  },
  {
    id: 'fluency',
    title: 'Fluência',
    description: 'Sustente a conversa com menos pausas e mais naturalidade.',
  },
  {
    id: 'emergency',
    title: 'Preparação urgente',
    description: 'Vá direto ao essencial para uma situação próxima.',
  },
];

const CORRECTION_OPTIONS: Array<{
  id: WolfieCorrectionMode;
  title: string;
}> = [
  { id: 'immediate', title: 'Na hora' },
  { id: 'end', title: 'Ao final' },
  { id: 'selective', title: 'Só o essencial' },
  { id: 'examiner', title: 'Modo examinador' },
];

const LANGUAGE_OPTIONS: Array<{
  id: WolfieLanguageMode;
  title: string;
}> = [
  { id: 'pt_support', title: 'Português de apoio' },
  { id: 'bilingual', title: 'Bilíngue' },
  { id: 'immersive', title: 'Inglês imersivo' },
  { id: 'english_rescue', title: 'Inglês com resgate' },
];

const DIFFICULTY_OPTIONS: Array<{
  id: WolfieDifficulty;
  title: string;
}> = [
  { id: 'supportive', title: 'Com bastante apoio' },
  { id: 'balanced', title: 'Equilibrada' },
  { id: 'challenging', title: 'Desafiadora' },
  { id: 'adaptive', title: 'Adaptativa' },
];

const guessProfileLevel = (module?: string): CefrLevel | null => {
  if (!module) return null;
  const match = module.toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  return match ? (match[1] as CefrLevel) : null;
};

const defaultExperienceForSubject = (
  subject: WolfieSubject,
): WolfieExperienceMode => {
  if (subject === 'global_meetings') return 'global_meeting';
  if (subject === 'writing') return 'writing';
  if (subject === 'vocabulary') return 'vocabulary';
  if (subject === 'listening') return 'roleplay';
  return 'guided_lesson';
};

const subjectForExperience = (
  experience: WolfieExperienceMode,
): WolfieSubject => {
  if (experience === 'global_meeting' || experience === 'presentation') {
    return 'global_meetings';
  }
  if (experience === 'writing') return 'writing';
  if (experience === 'vocabulary') return 'vocabulary';
  if (experience === 'pronunciation') return 'listening';
  return 'grammar';
};

const conversationTopicForSession = (
  session: WolfieActivitySession,
): string => {
  const content = session.activity_content;
  const focus = content.scenario
    ? `${content.scenario.objective}. Papel: ${content.scenario.role}`
    : content.prompt ||
      content.context ||
      content.readinessGoal ||
      content.questions?.[0]?.prompt ||
      '';
  return `${content.title || getSubjectOption(session.subject).title} — ${focus} — nível ${session.cefr_level}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
};

function JourneySteps({
  view,
}: {
  view: FlowView;
}) {
  const current =
    view === 'subject'
      ? 0
      : view === 'level' || view === 'sector'
        ? 1
        : view === 'mode' || view === 'conversation_setup'
          ? 2
          : 3;
  const steps = ['Assunto', 'Nível', 'Formato', 'Prática'];
  return (
    <nav
      className="border-b border-brand-border bg-brand-surface px-4 py-3 sm:px-7"
      aria-label="Etapas para iniciar uma prática"
    >
      <ol className="mx-auto flex max-w-4xl items-center">
        {steps.map((step, index) => (
          <React.Fragment key={step}>
            <li
              className={`flex shrink-0 items-center gap-2 text-xs font-black sm:text-sm ${
                index <= current ? 'text-brand-accent' : 'text-brand-muted'
              }`}
              aria-current={index === current ? 'step' : undefined}
            >
              <span
                className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${
                  index === current
                    ? 'bg-brand-accent text-white'
                    : index < current
                      ? 'bg-brand-surface-2 text-brand-accent'
                      : 'border border-brand-border bg-brand-bg'
                }`}
              >
                {index + 1}
              </span>
              <span className="hidden xs:inline sm:inline">{step}</span>
            </li>
            {index < steps.length - 1 ? (
              <span
                className={`mx-2 h-px flex-1 sm:mx-4 ${
                  index < current ? 'bg-brand-accent' : 'bg-brand-border'
                }`}
                aria-hidden="true"
              />
            ) : null}
          </React.Fragment>
        ))}
      </ol>
    </nav>
  );
}

function LoadingExperience({
  subject,
  level,
}: {
  subject: WolfieSubject;
  level: CefrLevel;
}) {
  const [messageIndex, setMessageIndex] = useState(0);
  const subjectOption = getSubjectOption(subject);

  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setMessageIndex((index) => (index + 1) % loadingMessages.length),
      2_400,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main
      className="grid min-h-[62vh] place-items-center bg-brand-bg px-4 py-10"
      role="status"
      aria-live="polite"
    >
      <div className="max-w-md text-center">
        <div className="relative mx-auto h-24 w-24">
          <div className="absolute inset-0 rounded-3xl bg-brand-surface-2" />
          <div className="absolute inset-2 grid place-items-center rounded-2xl bg-brand-surface shadow-sm">
            <Loader2
              size={34}
              className="animate-spin text-brand-accent"
              aria-hidden="true"
            />
          </div>
        </div>
        <p className="mt-6 text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
          {subjectOption.shortTitle} · {level}
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-brand-text">
          Wolfie está criando sua prática
        </h1>
        <p className="mt-3 min-h-12 text-sm leading-6 text-brand-muted">
          {loadingMessages[messageIndex]}
        </p>
      </div>
    </main>
  );
}

interface WolfiePracticeFlowProps {
  user: WolfieUserSummary;
}

interface ResumableConversation {
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
  scenario_status: 'active' | 'awaiting_retry';
  last_activity_at: string;
}

export function WolfiePracticeFlow({ user }: WolfiePracticeFlowProps) {
  const [view, setView] = useState<FlowView>('subject');
  const [selectedSubject, setSelectedSubject] =
    useState<WolfieSubject | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<CefrLevel | null>(null);
  const [selectedSector, setSelectedSector] = useState<string>('');
  const [selection, setSelection] = useState<WolfieSelection | null>(null);
  const [activeSession, setActiveSession] =
    useState<WolfieActivitySession | null>(null);
  const [completedSession, setCompletedSession] =
    useState<WolfieActivitySession | null>(null);
  const [result, setResult] = useState<WolfieActivityResult | null>(null);
  const [generationError, setGenerationError] = useState('');
  const [overview, setOverview] = useState<WolfieOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [endingSessionId, setEndingSessionId] = useState('');
  const [resumableConversation, setResumableConversation] =
    useState<ResumableConversation | null>(null);
  const [conversationBrief, setConversationBrief] =
    useState<WolfieConversationBrief | null>(null);
  const [conversationDraft, setConversationDraft] =
    useState<WolfieConversationBrief | null>(null);
  const [repertoireReturn, setRepertoireReturn] =
    useState<'subject' | 'summary'>('subject');
  const mainHeadingRef = useRef<HTMLHeadingElement>(null);
  const generationRequest = useRef<{
    signature: string;
    requestKey: string;
  } | null>(null);
  const wolfieSettings = user.wolfieSettings ?? user.wolfie_settings;
  const profileLevel = useMemo(
    () => wolfieSettings?.level ?? guessProfileLevel(user.module),
    [user.module, wolfieSettings?.level],
  );
  const firstName =
    (user.name ?? user.full_name)?.trim().split(/\s+/)[0] || 'aluno';

  const loadOverview = useCallback(async (showLoading = false) => {
    if (showLoading) setOverviewLoading(true);
    setOverviewError('');
    try {
      const conversationRequest = user.id
        ? supabase
            .from('wolfie_sessions')
            .select(
              'id, topic, student_level, experience_mode, correction_mode, language_mode, difficulty, scenario_context, student_goal, target_skill, scenario_status, last_activity_at',
            )
            .eq('student_id', user.id)
            .is('finished_at', null)
            .in('scenario_status', ['active', 'awaiting_retry'])
            .order('last_activity_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null });
      const [nextOverview, conversationResult] = await Promise.all([
        getWolfieOverview(),
        conversationRequest,
      ]);
      if (conversationResult.error) throw conversationResult.error;
      setOverview(nextOverview);
      setResumableConversation(
        (conversationResult.data as ResumableConversation | null) ?? null,
      );
    } catch (cause) {
      setOverviewError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível carregar seu repertório.',
      );
    } finally {
      if (showLoading) setOverviewLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  useEffect(() => {
    if (
      view === 'subject' ||
      view === 'level' ||
      view === 'sector' ||
      view === 'mode' ||
      view === 'conversation_setup' ||
      view === 'generation_error'
    ) {
      mainHeadingRef.current?.focus();
    }
  }, [view]);

  const startActivity = async (
    nextSelection: WolfieSelection,
    retry = false,
  ) => {
    setSelection(nextSelection);
    setGenerationError('');
    setResult(null);
    setCompletedSession(null);
    setView('loading');
    try {
      const signature = JSON.stringify(nextSelection);
      const requestKey =
        !retry && generationRequest.current?.signature === signature
          ? generationRequest.current.requestKey
          : createWolfieRequestKey();
      generationRequest.current = { signature, requestKey };
      const session = await generateWolfieActivity({
        subject: nextSelection.subject,
        level: nextSelection.level,
        sector: nextSelection.sector,
        phase:
          nextSelection.subject === 'global_meetings'
            ? 'construction'
            : 'standard',
        modality: 'text',
        requestKey,
      });
      generationRequest.current = null;
      setActiveSession(session);
      setView('activity');
    } catch (cause) {
      setGenerationError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível criar sua atividade.',
      );
      setView('generation_error');
    }
  };

  const chooseSubject = (subject: WolfieSubject) => {
    setSelectedSubject(subject);
    setSelectedLevel(null);
    setSelectedSector('');
    setView('level');
  };

  const chooseLevel = (level: CefrLevel) => {
    if (!selectedSubject) return;
    setSelectedLevel(level);
    if (selectedSubject === 'global_meetings') {
      setView('sector');
      return;
    }
    setView('mode');
  };

  const continueMeeting = () => {
    if (!selectedSubject || !selectedLevel || !selectedSector) return;
    setView('mode');
  };

  const selectedPractice = (): WolfieSelection | null => {
    if (!selectedSubject || !selectedLevel) return null;
    if (selectedSubject === 'global_meetings' && !selectedSector) return null;
    return {
      subject: selectedSubject,
      level: selectedLevel,
      sector: selectedSector || undefined,
    };
  };

  const buildConversationBrief = (
    nextSelection: WolfieSelection,
  ): WolfieConversationBrief => {
    const subject = getSubjectOption(nextSelection.subject);
    const sector = getSectorOption(nextSelection.sector);
    const savedGoal =
      user.shortTermGoal ??
      user.short_term_goal ??
      wolfieSettings?.goal ??
      user.englishFor ??
      user.english_for ??
      '';
    const interests =
      user.preferredTopics ??
      user.preferred_topics ??
      user.interests ??
      [];
    const studentCategory =
      user.studentCategory ?? user.student_category ?? '';
    const personalContext = [
      user.occupation ? `Profissão: ${user.occupation}.` : '',
      studentCategory
        ? `Perfil: ${studentCategory}.`
        : '',
      interests.length ? `Interesses: ${interests.slice(0, 4).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const languageMode =
      wolfieSettings?.preferredLanguageMode ??
      (nextSelection.level === 'A1' || nextSelection.level === 'A2'
        ? 'pt_support'
        : nextSelection.level === 'B1' || nextSelection.level === 'B2'
          ? 'bilingual'
          : 'immersive');
    const correctionMode =
      wolfieSettings?.preferredCorrectionMode ??
      (wolfieSettings?.correctionStrictness === 3
        ? 'immediate'
        : wolfieSettings?.correctionStrictness === 1
          ? 'selective'
          : 'selective');
    const scenario = [
      sector
        ? `${sector.title}: ${sector.context}`
        : `${subject.title}: ${subject.description}`,
      personalContext,
      savedGoal ? `Meta já conhecida: ${savedGoal}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      topic: [
        subject.title,
        `nível ${nextSelection.level}`,
        sector?.title,
      ]
        .filter(Boolean)
        .join(' — ')
        .slice(0, 160),
      scenario: scenario.slice(0, 1_200),
      studentGoal: (savedGoal || subject.outcome).slice(0, 320),
      targetSkill: subject.outcome.slice(0, 240),
      experienceMode: defaultExperienceForSubject(nextSelection.subject),
      correctionMode,
      languageMode,
      difficulty: 'adaptive',
    };
  };

  const beginWrittenPractice = () => {
    const nextSelection = selectedPractice();
    if (nextSelection) void startActivity(nextSelection);
  };

  const beginConversation = () => {
    const nextSelection = selectedPractice();
    if (!nextSelection) return;
    setConversationDraft(buildConversationBrief(nextSelection));
    setView('conversation_setup');
  };

  const beginSessionConversation = (session: WolfieActivitySession) => {
    const base = buildConversationBrief({
      subject: session.subject,
      level: session.cefr_level,
      sector: session.sector ?? undefined,
    });
    const content = session.activity_content;
    const scenario = content.scenario
      ? [
          `${content.scenario.title}.`,
          `Você é ${content.scenario.role} na ${content.scenario.company}.`,
          `Objetivo: ${content.scenario.objective}.`,
          `Restrição: ${content.scenario.constraint}.`,
        ].join(' ')
      : [
          content.context,
          content.prompt,
          content.instructionsPt,
        ]
          .filter(Boolean)
          .join(' ');
    setConversationBrief({
      ...base,
      topic: conversationTopicForSession(session),
      scenario: (scenario || base.scenario).slice(0, 1_200),
      studentGoal: (content.readinessGoal || base.studentGoal).slice(0, 320),
      targetSkill: [
        base.targetSkill,
        content.targetVocabulary
          ?.slice(0, 8)
          .map((item) => item.term)
          .join(', '),
      ]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 320),
    });
  };

  const completeActivity = (
    nextResult: WolfieActivityResult,
    nextSession?: WolfieActivitySession,
  ) => {
    const source = nextSession ?? activeSession;
    if (!source) return;
    const complete: WolfieActivitySession = {
      ...source,
      status: 'COMPLETED',
      score: nextResult.score,
      xp_earned: nextResult.xpEarned ?? source.xp_earned,
    };
    setCompletedSession(complete);
    setActiveSession(complete);
    setResult(nextResult);
    setView('summary');
    void loadOverview(false);
  };

  const resumeSession = (session: WolfieActivitySession) => {
    const nextSelection: WolfieSelection = {
      subject: session.subject,
      level: session.cefr_level,
      sector: session.sector ?? undefined,
    };
    setSelection(nextSelection);
    setSelectedSubject(session.subject);
    setSelectedLevel(session.cefr_level);
    setSelectedSector(session.sector ?? '');
    setCompletedSession(null);
    setResult(null);
    setActiveSession(session);
    setView('activity');
  };

  const resumeConversation = (session: ResumableConversation) => {
    setSelectedSubject(subjectForExperience(session.experience_mode));
    setSelectedLevel(session.student_level);
    setConversationBrief({
      topic: session.topic,
      scenario: session.scenario_context ?? '',
      studentGoal: session.student_goal ?? '',
      targetSkill: session.target_skill ?? '',
      experienceMode: session.experience_mode,
      correctionMode: session.correction_mode,
      languageMode: session.language_mode,
      difficulty: session.difficulty,
    });
  };

  const endSavedSession = async (sessionId: string) => {
    if (endingSessionId) return;
    setEndingSessionId(sessionId);
    setOverviewError('');
    try {
      await abandonWolfieActivity(sessionId);
      await loadOverview(false);
    } catch (cause) {
      setOverviewError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível encerrar esta tentativa.',
      );
    } finally {
      setEndingSessionId('');
    }
  };

  const endSavedConversation = async (conversationId: string) => {
    if (endingSessionId) return;
    setEndingSessionId(conversationId);
    setOverviewError('');
    try {
      const { data, error } = await supabase.functions.invoke('wolfie-brain', {
        body: { action: 'abandon', conversationId },
      });
      if (error || data?.success !== true) {
        throw new Error(
          data?.error ||
            error?.message ||
            'Não foi possível encerrar esta conversa.',
        );
      }
      setResumableConversation((current) =>
        current?.id === conversationId ? null : current,
      );
      await loadOverview(false);
    } catch (cause) {
      setOverviewError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível encerrar esta conversa.',
      );
    } finally {
      setEndingSessionId('');
    }
  };

  const exitActivity = () => {
    setActiveSession(null);
    setCompletedSession(null);
    setResult(null);
    setSelection(null);
    setSelectedSubject(null);
    setSelectedLevel(null);
    setSelectedSector('');
    setConversationBrief(null);
    setConversationDraft(null);
    setView('subject');
    void loadOverview(false);
  };

  const resetToSubject = () => {
    setActiveSession(null);
    setCompletedSession(null);
    setResult(null);
    setSelection(null);
    setSelectedSubject(null);
    setSelectedLevel(null);
    setSelectedSector('');
    setConversationBrief(null);
    setConversationDraft(null);
    setGenerationError('');
    setView('subject');
  };

  const openRepertoire = (returnTo: 'subject' | 'summary') => {
    setRepertoireReturn(returnTo);
    setView('repertoire');
    void loadOverview(true);
  };

  const conversationOverlay =
    conversationBrief && selectedLevel ? (
      <React.Suspense
        fallback={
          <LoadingExperience
            subject={selectedSubject}
            level={selectedLevel}
          />
        }
      >
        <WolfieConversationTutor
          user={{
            ...user,
            levelBadge: selectedLevel,
          }}
          voiceMode
          topic={conversationBrief.topic}
          experienceMode={conversationBrief.experienceMode}
          correctionMode={conversationBrief.correctionMode}
          languageMode={conversationBrief.languageMode}
          difficulty={conversationBrief.difficulty}
          scenario={conversationBrief.scenario}
          studentGoal={conversationBrief.studentGoal}
          targetSkill={conversationBrief.targetSkill}
          onClose={() => {
            setConversationBrief(null);
            void loadOverview(false);
          }}
        />
      </React.Suspense>
    ) : null;

  if (view === 'activity' && activeSession) {
    if (
      activeSession.subject === 'vocabulary' ||
      activeSession.subject === 'grammar' ||
      activeSession.subject === 'listening' ||
      activeSession.subject === 'reading'
    ) {
      return (
        <>
          <WolfieQuizActivity
            session={activeSession}
            onComplete={(nextResult) => completeActivity(nextResult)}
            onExit={exitActivity}
            onConversation={() => beginSessionConversation(activeSession)}
          />
          {conversationOverlay}
        </>
      );
    }

    if (activeSession.subject === 'writing') {
      return (
        <>
          <WolfieWritingActivity
            session={activeSession}
            onComplete={(nextResult) => completeActivity(nextResult)}
            onExit={exitActivity}
            onConversation={() => beginSessionConversation(activeSession)}
          />
          {conversationOverlay}
        </>
      );
    }

    return (
      <>
        <WolfieMeetingActivity
          session={activeSession}
          onSessionChange={setActiveSession}
          onComplete={(nextResult, nextSession) =>
            completeActivity(nextResult, nextSession)
          }
          onExit={exitActivity}
          onConversation={() => beginSessionConversation(activeSession)}
        />
        {conversationOverlay}
      </>
    );
  }

  if (view === 'summary' && completedSession && result && selection) {
    return (
      <>
        <WolfieActivitySummary
          session={completedSession}
          result={result}
          onRetry={() => void startActivity(selection)}
          onNewActivity={resetToSubject}
          onOpenRepertoire={() => openRepertoire('summary')}
          onConversation={() =>
            beginSessionConversation(completedSession)
          }
        />
        {conversationOverlay}
      </>
    );
  }

  if (view === 'repertoire') {
    return (
      <WolfieRepertoire
        overview={overview}
        loading={overviewLoading}
        error={overviewError}
        onReload={() => void loadOverview(true)}
        onBack={() =>
          setView(
            repertoireReturn === 'summary' && completedSession && result
              ? 'summary'
              : 'subject',
          )
        }
        onPractice={resetToSubject}
      />
    );
  }

  return (
    <>
      <div className="min-h-[70vh] overflow-hidden rounded-3xl border border-brand-border bg-brand-bg shadow-sm">
      <header className="bg-brand-surface px-4 py-5 sm:px-7">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-accent text-white shadow-sm">
              <Sparkles size={22} aria-hidden="true" />
            </span>
            <div>
              <p className="font-black tracking-tight text-brand-text">
                Wolfie Tutor
              </p>
              <p className="text-xs text-brand-muted">
                Prática autônoma com IA
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => openRepertoire('subject')}
            className={secondaryButton}
          >
            <BookOpen size={17} aria-hidden="true" />
            <span className="hidden sm:inline">Meu repertório</span>
            {overview?.repertoireCount ? (
              <span className="rounded-full bg-brand-surface-2 px-2 py-0.5 text-[11px] text-brand-accent">
                {overview.repertoireCount}
              </span>
            ) : null}
          </button>
        </div>
      </header>
      <JourneySteps view={view} />

      {view === 'subject' ? (
        <main className="mx-auto max-w-6xl px-4 py-7 sm:px-7 sm:py-10">
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
                Olá, {firstName}
              </p>
              <h1
                ref={mainHeadingRef}
                tabIndex={-1}
                className="mt-3 max-w-3xl text-3xl font-black tracking-tight text-brand-text outline-none sm:text-5xl sm:leading-[1.08]"
              >
                O que você quer estar pronto para usar em inglês?
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-brand-muted sm:text-base">
                Escolha um assunto. Depois, o Wolfie calibra a prática ao seu
                nível e reaproveita o que você já aprendeu.
              </p>
            </div>
            <div className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-brand-accent">
                <BarChart3 size={16} aria-hidden="true" />
                Sua memória ativa
              </div>
              <p className="mt-3 text-3xl font-black text-brand-text">
                {overview?.repertoireCount ?? '—'}
              </p>
              <p className="mt-1 text-xs leading-5 text-brand-muted">
                expressões conectadas entre as atividades
              </p>
            </div>
          </section>

          {overviewError ? (
            <div className="mt-6">
              <InlineError
                message={overviewError}
                onRetry={() => void loadOverview(true)}
              />
            </div>
          ) : null}

          {resumableConversation || overview?.resumableSessions?.length ? (
            <section
              className="mt-7 rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-6"
              aria-labelledby="wolfie-continue-title"
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent">
                  <Clock3 size={21} aria-hidden="true" />
                </span>
                <div>
                  <h2
                    id="wolfie-continue-title"
                    className="text-lg font-black text-brand-text"
                  >
                    Continue de onde parou
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-brand-muted">
                    Seu progresso foi salvo. Retome agora ou encerre uma
                    tentativa que não quer mais manter.
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-3 lg:grid-cols-2">
                {resumableConversation ? (
                  <article className="rounded-2xl border border-brand-border bg-brand-bg p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-black uppercase tracking-wider text-brand-accent">
                          Conversa real · {resumableConversation.student_level}
                        </p>
                        <h3 className="mt-2 font-black text-brand-text">
                          {resumableConversation.topic}
                        </h3>
                        <p className="mt-1 text-xs text-brand-muted">
                          {resumableConversation.scenario_status ===
                          'awaiting_retry'
                            ? 'Reformulação pendente'
                            : 'Conversa em andamento'}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          resumeConversation(resumableConversation)
                        }
                        className={primaryButton}
                      >
                        <Mic size={16} aria-hidden="true" />
                        Continuar conversa
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void endSavedConversation(resumableConversation.id)
                        }
                        disabled={Boolean(endingSessionId)}
                        className={secondaryButton}
                      >
                        {endingSessionId === resumableConversation.id ? (
                          <Loader2
                            size={16}
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 size={16} aria-hidden="true" />
                        )}
                        Encerrar
                      </button>
                    </div>
                  </article>
                ) : null}
                {(overview?.resumableSessions ?? []).map((savedSession) => {
                  const option = getSubjectOption(savedSession.subject);
                  const isMemorization =
                    savedSession.subject === 'global_meetings' &&
                    savedSession.phase === 'construction' &&
                    savedSession.status === 'COMPLETED';
                  const stageLabel =
                    savedSession.phase === 'readaptation'
                      ? 'Readaptação em andamento'
                      : isMemorization
                        ? 'Memorização e independência'
                        : 'Prática em andamento';
                  return (
                    <article
                      key={savedSession.id}
                      className="rounded-2xl border border-brand-border bg-brand-bg p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-black uppercase tracking-wider text-brand-accent">
                            {option.shortTitle} · {savedSession.cefr_level}
                          </p>
                          <h3 className="mt-2 font-black text-brand-text">
                            {savedSession.activity_content.title}
                          </h3>
                          <p className="mt-1 text-xs text-brand-muted">
                            {stageLabel}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => resumeSession(savedSession)}
                          className={primaryButton}
                        >
                          <Play size={16} aria-hidden="true" />
                          Continuar
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void endSavedSession(savedSession.id)
                          }
                          disabled={Boolean(endingSessionId)}
                          className={secondaryButton}
                        >
                          {endingSessionId === savedSession.id ? (
                            <Loader2
                              size={16}
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Trash2 size={16} aria-hidden="true" />
                          )}
                          Encerrar
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section
            className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
            aria-label="Assuntos disponíveis"
          >
            {SUBJECT_OPTIONS.map((subject) => {
              const Icon = subjectIcons[subject.id];
              const progress = overview?.subjectProgress.find(
                (item) => item.subject === subject.id,
              );
              return (
                <button
                  key={subject.id}
                  type="button"
                  onClick={() => chooseSubject(subject.id)}
                  className={`group flex min-h-56 flex-col rounded-3xl border border-brand-border bg-brand-surface p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md ${focusRing}`}
                  aria-label={`${subject.title}. ${subject.description}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent transition group-hover:bg-brand-accent group-hover:text-white">
                      <Icon size={23} aria-hidden="true" />
                    </span>
                    {progress?.completed ? (
                      <span className="rounded-full bg-brand-surface-2 px-2.5 py-1 text-[11px] font-bold text-brand-muted">
                        {progress.completed} concluída
                        {progress.completed === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="rounded-full bg-brand-surface-2 px-2.5 py-1 text-[11px] font-bold text-brand-muted">
                        Explorar
                      </span>
                    )}
                  </div>
                  <h2 className="mt-5 text-lg font-black leading-6 text-brand-text">
                    {subject.title}
                  </h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-brand-muted">
                    {subject.description}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-2 text-xs font-black text-brand-accent">
                    {subject.outcome}
                    <ArrowRight
                      size={15}
                      className="transition-transform group-hover:translate-x-1"
                      aria-hidden="true"
                    />
                  </span>
                </button>
              );
            })}
          </section>
        </main>
      ) : null}

      {view === 'level' && selectedSubject ? (
        <main className="mx-auto max-w-5xl px-4 py-7 sm:px-7 sm:py-10">
          <button
            type="button"
            onClick={() => setView('subject')}
            className={`inline-flex items-center gap-2 text-sm font-bold text-brand-muted hover:text-brand-accent ${focusRing}`}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            Trocar assunto
          </button>
          <div className="mt-6 max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
              {getSubjectOption(selectedSubject).shortTitle}
            </p>
            <h1
              ref={mainHeadingRef}
              tabIndex={-1}
              className="mt-3 text-3xl font-black tracking-tight text-brand-text outline-none sm:text-4xl"
            >
              Em qual nível a atividade deve conversar com você?
            </h1>
            <p className="mt-3 text-sm leading-6 text-brand-muted">
              Escolha pela frase que melhor descreve o que você consegue fazer
              hoje. Não é uma prova.
            </p>
            {profileLevel ? (
              <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand-surface-2 px-3 py-1.5 text-xs font-bold text-brand-muted">
                <Target size={14} className="text-brand-accent" aria-hidden="true" />
                Seu perfil atual indica {profileLevel}; você continua livre
                para escolher.
              </p>
            ) : null}
          </div>

          <section
            className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3"
            aria-label="Níveis CEFR"
          >
            {LEVEL_OPTIONS.map((level) => (
              <button
                key={level.id}
                type="button"
                onClick={() => chooseLevel(level.id)}
                className={`group rounded-3xl border border-brand-border bg-brand-surface p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md ${focusRing}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-3xl font-black text-brand-accent">
                    {level.id}
                  </span>
                  <ArrowRight
                    size={19}
                    className="text-brand-muted transition group-hover:translate-x-1 group-hover:text-brand-accent"
                    aria-hidden="true"
                  />
                </div>
                <h2 className="mt-4 font-black text-brand-text">
                  {level.label}
                </h2>
                <p className="mt-2 text-sm leading-6 text-brand-muted">
                  {level.reference}
                </p>
                <p className="mt-4 border-t border-brand-border pt-3 text-xs leading-5 text-brand-accent">
                  {level.coaching}
                </p>
              </button>
            ))}
          </section>
        </main>
      ) : null}

      {view === 'sector' && selectedSubject && selectedLevel ? (
        <main className="mx-auto max-w-5xl px-4 py-7 sm:px-7 sm:py-10">
          <button
            type="button"
            onClick={() => setView('level')}
            className={`inline-flex items-center gap-2 text-sm font-bold text-brand-muted hover:text-brand-accent ${focusRing}`}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            Trocar nível
          </button>
          <div className="mt-6 max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
              Reuniões globais · {selectedLevel}
            </p>
            <h1
              ref={mainHeadingRef}
              tabIndex={-1}
              className="mt-3 text-3xl font-black tracking-tight text-brand-text outline-none sm:text-4xl"
            >
              Escolha o ambiente da sua reunião
            </h1>
            <p className="mt-3 text-sm leading-6 text-brand-muted">
              O Wolfie vai criar um cenário específico do setor, com decisões,
              restrições e vocabulário que parecem reais.
            </p>
          </div>

          <section
            className="mt-8 grid gap-3 md:grid-cols-2"
            aria-label="Setores corporativos"
          >
            {SECTOR_OPTIONS.map((sector) => {
              const selected = selectedSector === sector.id;
              return (
                <button
                  key={sector.id}
                  type="button"
                  onClick={() => setSelectedSector(sector.id)}
                  aria-pressed={selected}
                  className={`rounded-2xl border p-4 text-left transition ${
                    selected
                      ? 'border-brand-accent bg-brand-surface-2 shadow-sm'
                      : 'border-brand-border bg-brand-surface hover:border-brand-accent'
                  } ${focusRing}`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? 'border-brand-accent bg-brand-accent text-white'
                          : 'border-brand-border bg-brand-bg text-brand-muted'
                      }`}
                    >
                      {selected ? (
                        <Sparkles size={15} aria-hidden="true" />
                      ) : (
                        <BriefcaseBusiness size={15} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong className="block text-sm font-black text-brand-text">
                        {sector.title}
                      </strong>
                      <span className="mt-1 block text-xs leading-5 text-brand-muted">
                        {sector.context}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </section>

          <div className="mt-7 flex justify-end">
            <button
              type="button"
              onClick={continueMeeting}
              disabled={!selectedSector}
              className={primaryButton}
            >
              Continuar
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
        </main>
      ) : null}

      {view === 'mode' && selectedSubject && selectedLevel ? (
        <main className="mx-auto max-w-5xl px-4 py-7 sm:px-7 sm:py-10">
          <button
            type="button"
            onClick={() =>
              setView(
                selectedSubject === 'global_meetings' ? 'sector' : 'level',
              )
            }
            className={`inline-flex items-center gap-2 text-sm font-bold text-brand-muted hover:text-brand-accent ${focusRing}`}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            Voltar
          </button>
          <div className="mt-6 max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
              {getSubjectOption(selectedSubject).shortTitle} · {selectedLevel}
              {getSectorOption(selectedSector)
                ? ` · ${getSectorOption(selectedSector)?.title}`
                : ''}
            </p>
            <h1
              ref={mainHeadingRef}
              tabIndex={-1}
              className="mt-3 text-3xl font-black tracking-tight text-brand-text outline-none sm:text-4xl"
            >
              Como você quer praticar?
            </h1>
            <p className="mt-3 text-sm leading-6 text-brand-muted">
              Você pode construir a resposta com calma por escrito ou treinar
              uma conversa real com o Wolfie usando sua voz.
            </p>
          </div>

          <section
            className="mt-8 grid gap-4 md:grid-cols-2"
            aria-label="Formatos da prática"
          >
            <button
              type="button"
              onClick={beginWrittenPractice}
              className={`group flex min-h-64 flex-col rounded-3xl border border-brand-border bg-brand-surface p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md ${focusRing}`}
            >
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent transition group-hover:bg-brand-accent group-hover:text-white">
                <PenLine size={25} aria-hidden="true" />
              </span>
              <h2 className="mt-6 text-xl font-black text-brand-text">
                Por escrita
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-brand-muted">
                Faça a atividade no seu ritmo, escreva suas respostas e receba
                correções calibradas ao seu nível.
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-brand-accent">
                Começar por escrita
                <ArrowRight
                  size={17}
                  className="transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </span>
            </button>

            <button
              type="button"
              onClick={beginConversation}
              className={`group flex min-h-64 flex-col rounded-3xl border border-brand-border bg-brand-surface p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-accent hover:shadow-md ${focusRing}`}
            >
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent transition group-hover:bg-brand-accent group-hover:text-white">
                <Mic size={25} aria-hidden="true" />
              </span>
              <h2 className="mt-6 text-xl font-black text-brand-text">
                Conversa real
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-brand-muted">
                Fale com o Wolfie em tempo real e treine espontaneidade,
                fluidez e naturalidade dentro do assunto escolhido.
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-brand-accent">
                Iniciar conversa
                <ArrowRight
                  size={17}
                  className="transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </span>
            </button>
          </section>
        </main>
      ) : null}

      {view === 'conversation_setup' &&
      selectedSubject &&
      selectedLevel &&
      conversationDraft ? (
        <main className="mx-auto max-w-6xl px-4 py-7 sm:px-7 sm:py-10">
          <button
            type="button"
            onClick={() => setView('mode')}
            className={`inline-flex items-center gap-2 text-sm font-bold text-brand-muted hover:text-brand-accent ${focusRing}`}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            Voltar aos formatos
          </button>

          <div className="mt-6 max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
              Conversa real · {selectedLevel}
            </p>
            <h1
              ref={mainHeadingRef}
              tabIndex={-1}
              className="mt-3 text-3xl font-black tracking-tight text-brand-text outline-none sm:text-4xl"
            >
              Transforme o tema em uma situação de verdade
            </h1>
            <p className="mt-3 text-sm leading-6 text-brand-muted">
              O Wolfie já vai entrar sabendo o assunto, seu objetivo e o papel
              que deve interpretar. Você pode ajustar só o que quiser.
            </p>
          </div>

          <form
            className="mt-8 space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              const normalized: WolfieConversationBrief = {
                ...conversationDraft,
                topic: conversationDraft.topic.trim().slice(0, 160),
                scenario: conversationDraft.scenario.trim().slice(0, 1_200),
                studentGoal: conversationDraft.studentGoal
                  .trim()
                  .slice(0, 320),
                targetSkill: conversationDraft.targetSkill
                  .trim()
                  .slice(0, 320),
              };
              setConversationBrief(normalized);
              setView('mode');
            }}
          >
            <section className="grid gap-4 rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm md:grid-cols-2 sm:p-6">
              <label className="block md:col-span-2">
                <span className="text-sm font-black text-brand-text">
                  Assunto da conversa
                </span>
                <input
                  value={conversationDraft.topic}
                  onChange={(event) =>
                    setConversationDraft((current) =>
                      current
                        ? { ...current, topic: event.target.value }
                        : current,
                    )
                  }
                  maxLength={160}
                  className={`${inputClass} mt-2`}
                  placeholder="Ex.: alinhar um atraso com um cliente"
                  required
                />
              </label>

              <label className="block md:col-span-2">
                <span className="text-sm font-black text-brand-text">
                  Situação real
                </span>
                <span className="mt-1 block text-xs leading-5 text-brand-muted">
                  Diga quem participa, o que aconteceu e qual decisão precisa
                  sair da conversa.
                </span>
                <textarea
                  value={conversationDraft.scenario}
                  onChange={(event) =>
                    setConversationDraft((current) =>
                      current
                        ? { ...current, scenario: event.target.value }
                        : current,
                    )
                  }
                  maxLength={1_200}
                  rows={4}
                  className={`${inputClass} mt-2 resize-y`}
                  placeholder="Ex.: você precisa negociar um novo prazo com um gestor americano sem comprometer a qualidade."
                  required
                />
              </label>

              <label className="block">
                <span className="text-sm font-black text-brand-text">
                  Quero sair pronto para…
                </span>
                <input
                  value={conversationDraft.studentGoal}
                  onChange={(event) =>
                    setConversationDraft((current) =>
                      current
                        ? { ...current, studentGoal: event.target.value }
                        : current,
                    )
                  }
                  maxLength={320}
                  className={`${inputClass} mt-2`}
                  placeholder="Ex.: explicar o problema e propor próximos passos"
                  required
                />
              </label>

              <label className="block">
                <span className="text-sm font-black text-brand-text">
                  Habilidade em foco
                </span>
                <input
                  value={conversationDraft.targetSkill}
                  onChange={(event) =>
                    setConversationDraft((current) =>
                      current
                        ? { ...current, targetSkill: event.target.value }
                        : current,
                    )
                  }
                  maxLength={320}
                  className={`${inputClass} mt-2`}
                  placeholder="Ex.: naturalidade, negociação e vocabulário"
                  required
                />
              </label>
            </section>

            <fieldset>
              <legend className="text-lg font-black text-brand-text">
                Escolha a experiência
              </legend>
              <p className="mt-1 text-sm leading-6 text-brand-muted">
                A conversa muda de comportamento, não só de título.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {EXPERIENCE_OPTIONS.map((option) => {
                  const selected =
                    conversationDraft.experienceMode === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setConversationDraft((current) =>
                          current
                            ? { ...current, experienceMode: option.id }
                            : current,
                        )
                      }
                      className={`min-h-32 rounded-2xl border p-4 text-left transition ${
                        selected
                          ? 'border-brand-accent bg-brand-surface-2 shadow-sm'
                          : 'border-brand-border bg-brand-surface hover:border-brand-accent'
                      } ${focusRing}`}
                    >
                      <span className="block text-sm font-black text-brand-text">
                        {option.title}
                      </span>
                      <span className="mt-2 block text-xs leading-5 text-brand-muted">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid gap-5 lg:grid-cols-3">
              <fieldset className="rounded-3xl border border-brand-border bg-brand-surface p-5">
                <legend className="px-1 text-sm font-black text-brand-text">
                  Quando corrigir
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CORRECTION_OPTIONS.map((option) => {
                    const selected =
                      conversationDraft.correctionMode === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setConversationDraft((current) =>
                            current
                              ? { ...current, correctionMode: option.id }
                              : current,
                          )
                        }
                        className={`rounded-full border px-3 py-2 text-xs font-bold transition ${
                          selected
                            ? 'border-brand-accent bg-brand-accent text-white'
                            : 'border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent'
                        } ${focusRing}`}
                      >
                        {option.title}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="rounded-3xl border border-brand-border bg-brand-surface p-5">
                <legend className="px-1 text-sm font-black text-brand-text">
                  Idioma e apoio
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {LANGUAGE_OPTIONS.map((option) => {
                    const selected =
                      conversationDraft.languageMode === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setConversationDraft((current) =>
                            current
                              ? { ...current, languageMode: option.id }
                              : current,
                          )
                        }
                        className={`rounded-full border px-3 py-2 text-xs font-bold transition ${
                          selected
                            ? 'border-brand-accent bg-brand-accent text-white'
                            : 'border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent'
                        } ${focusRing}`}
                      >
                        {option.title}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="rounded-3xl border border-brand-border bg-brand-surface p-5">
                <legend className="px-1 text-sm font-black text-brand-text">
                  Nível de desafio
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {DIFFICULTY_OPTIONS.map((option) => {
                    const selected =
                      conversationDraft.difficulty === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setConversationDraft((current) =>
                            current
                              ? { ...current, difficulty: option.id }
                              : current,
                          )
                        }
                        className={`rounded-full border px-3 py-2 text-xs font-bold transition ${
                          selected
                            ? 'border-brand-accent bg-brand-accent text-white'
                            : 'border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent'
                        } ${focusRing}`}
                      >
                        {option.title}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </div>

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-xs leading-5 text-brand-muted">
                A conversa seguirá o ciclo praticar → corrigir → reformular →
                repetir → improvisar em um novo cenário.
              </p>
              <button type="submit" className={`${primaryButton} shrink-0`}>
                <Mic size={18} aria-hidden="true" />
                Entrar na conversa
              </button>
            </div>
          </form>
        </main>
      ) : null}

      {view === 'loading' && selection ? (
        <LoadingExperience
          subject={selection.subject}
          level={selection.level}
        />
      ) : null}

      {view === 'generation_error' && selection ? (
        <main className="mx-auto grid min-h-[58vh] max-w-2xl place-items-center px-4 py-10 sm:px-7">
          <div className="w-full rounded-3xl border border-brand-border bg-brand-surface p-6 text-center sm:p-8">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent">
              <FileText size={25} aria-hidden="true" />
            </span>
            <h1
              ref={mainHeadingRef}
              tabIndex={-1}
              className="mt-5 text-2xl font-black text-brand-text outline-none"
            >
              A prática não ficou pronta
            </h1>
            <div className="mt-5 text-left">
              <InlineError message={generationError} />
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={resetToSubject}
                className={secondaryButton}
              >
                Escolher outro assunto
              </button>
              <button
                type="button"
                onClick={() => void startActivity(selection, true)}
                className={primaryButton}
              >
                Tentar gerar de novo
              </button>
            </div>
          </div>
        </main>
      ) : null}
      </div>
      {conversationOverlay}
    </>
  );
}
