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
  WolfieActivityResult,
  WolfieActivitySession,
  WolfieOverview,
  WolfieSelection,
  WolfieSubject,
  WolfieUserSummary,
} from './types';
import {
  focusRing,
  InlineError,
  primaryButton,
  secondaryButton,
} from './WolfieActivityUI';
import { WolfieQuizActivity } from './WolfieQuizActivity';
import { WolfieWritingActivity } from './WolfieWritingActivity';
import { WolfieMeetingActivity } from './WolfieMeetingActivity';
import { WolfieActivitySummary } from './WolfieActivitySummary';
import { WolfieRepertoire } from './WolfieRepertoire';

const WolfieConversationTutor = React.lazy(
  () => import('../../../components/WolfieTutor'),
);

type FlowView =
  | 'subject'
  | 'level'
  | 'sector'
  | 'mode'
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

const guessProfileLevel = (module?: string): CefrLevel | null => {
  if (!module) return null;
  const match = module.toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  return match ? (match[1] as CefrLevel) : null;
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
        : view === 'mode'
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
  const [conversationTopic, setConversationTopic] = useState('');
  const [repertoireReturn, setRepertoireReturn] =
    useState<'subject' | 'summary'>('subject');
  const mainHeadingRef = useRef<HTMLHeadingElement>(null);
  const generationRequest = useRef<{
    signature: string;
    requestKey: string;
  } | null>(null);
  const profileLevel = useMemo(
    () => user.wolfieSettings?.level ?? guessProfileLevel(user.module),
    [user.module, user.wolfieSettings?.level],
  );
  const firstName = user.name?.trim().split(/\s+/)[0] || 'aluno';

  const loadOverview = useCallback(async (showLoading = false) => {
    if (showLoading) setOverviewLoading(true);
    setOverviewError('');
    try {
      const nextOverview = await getWolfieOverview();
      setOverview(nextOverview);
    } catch (cause) {
      setOverviewError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível carregar seu repertório.',
      );
    } finally {
      if (showLoading) setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  useEffect(() => {
    if (
      view === 'subject' ||
      view === 'level' ||
      view === 'sector' ||
      view === 'mode' ||
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

  const beginWrittenPractice = () => {
    const nextSelection = selectedPractice();
    if (nextSelection) void startActivity(nextSelection);
  };

  const beginConversation = () => {
    const nextSelection = selectedPractice();
    if (!nextSelection) return;
    const subject = getSubjectOption(nextSelection.subject);
    const sector = getSectorOption(nextSelection.sector);
    setConversationTopic(
      [
        subject.title,
        `nível ${nextSelection.level}`,
        sector?.title,
      ].filter(Boolean).join(' — ').slice(0, 160),
    );
  };

  const beginSessionConversation = (session: WolfieActivitySession) => {
    setConversationTopic(conversationTopicForSession(session));
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

  const exitActivity = () => {
    setActiveSession(null);
    setCompletedSession(null);
    setResult(null);
    setSelection(null);
    setSelectedSubject(null);
    setSelectedLevel(null);
    setSelectedSector('');
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
    setGenerationError('');
    setView('subject');
  };

  const openRepertoire = (returnTo: 'subject' | 'summary') => {
    setRepertoireReturn(returnTo);
    setView('repertoire');
    void loadOverview(true);
  };

  const conversationOverlay =
    conversationTopic && selectedLevel ? (
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
            id: user.id,
            levelBadge: selectedLevel,
          }}
          voiceMode
          topic={conversationTopic}
          onClose={() => {
            setConversationTopic('');
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

          {overview?.resumableSessions?.length ? (
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
                {overview.resumableSessions.map((savedSession) => {
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
                Fale com o Wolfie em tempo real, treine espontaneidade,
                pronúncia e naturalidade dentro do assunto escolhido.
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
