import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Lightbulb,
  Mic,
  RotateCcw,
  Send,
  Sparkles,
  Target,
} from 'lucide-react';
import {
  analyzeWolfieSpeech,
  createWolfieRequestKey,
  generateWolfieActivity,
  saveWolfieMemorization,
  submitWolfieText,
} from '../../services/wolfieActivityService';
import type {
  MeetingSection,
  MeetingSectionState,
  MemorizationState,
  WolfieActivityResult,
  WolfieActivitySession,
} from './types';
import {
  ActivityHeader,
  BusyLabel,
  Checklist,
  focusRing,
  InlineError,
  inputClass,
  primaryButton,
  ReadinessCard,
  secondaryButton,
  VocabularyCard,
} from './WolfieActivityUI';
import {
  WolfieAudioRecorder,
  type RecordedAudioPayload,
} from './WolfieAudioRecorder';
import { SECTOR_OPTIONS } from './catalog';

type MeetingStage = 'construction' | 'memorization' | 'readaptation';
type ResponseMode = 'text' | 'voice';

interface WolfieMeetingActivityProps {
  session: WolfieActivitySession;
  onSessionChange: (session: WolfieActivitySession) => void;
  onComplete: (
    result: WolfieActivityResult,
    completedSession: WolfieActivitySession,
  ) => void;
  onExit: () => void;
}

const meetingStageLabels: Array<{
  id: MeetingStage;
  step: string;
  title: string;
}> = [
  { id: 'construction', step: '1', title: 'Construir' },
  { id: 'memorization', step: '2', title: 'Memorizar' },
  { id: 'readaptation', step: '3', title: 'Readaptar' },
];

const stageIndex = (stage: MeetingStage) =>
  meetingStageLabels.findIndex((item) => item.id === stage);

function MeetingJourneyProgress({ stage }: { stage: MeetingStage }) {
  const currentIndex = stageIndex(stage);
  return (
    <nav
      aria-label="Etapas da jornada de reunião"
      className="border-b border-brand-border bg-brand-bg px-4 py-3 sm:px-7"
    >
      <ol className="mx-auto grid max-w-3xl grid-cols-3 gap-2">
        {meetingStageLabels.map((item, index) => {
          const complete = index < currentIndex;
          const current = index === currentIndex;
          return (
            <li
              key={item.id}
              aria-current={current ? 'step' : undefined}
              className={`flex min-w-0 items-center justify-center gap-1 rounded-xl px-1 py-2 text-[11px] font-bold sm:gap-2 sm:px-2 sm:text-sm ${
                current
                  ? 'bg-brand-accent text-white'
                  : complete
                    ? 'bg-brand-surface-2 text-brand-accent'
                    : 'text-brand-muted'
              }`}
            >
              <span
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  current
                    ? 'bg-white text-brand-accent'
                    : complete
                      ? 'bg-brand-accent text-white'
                      : 'border border-brand-border bg-brand-surface'
                }`}
              >
                {complete ? <Check size={14} aria-hidden="true" /> : item.step}
              </span>
              <span className="truncate">{item.title}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ScenarioCard({
  session,
  compact = false,
}: {
  session: WolfieActivitySession;
  compact?: boolean;
}) {
  const scenario = session.activity_content.scenario;
  if (!scenario) return null;

  return (
    <section className="rounded-2xl border border-brand-border bg-brand-surface-2 p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
        <Target size={16} aria-hidden="true" />
        Seu cenário
      </div>
      <h2 className="mt-3 text-xl font-black text-brand-text">
        {scenario.title}
      </h2>
      <dl
        className={`mt-4 grid gap-3 text-sm ${
          compact ? '' : 'sm:grid-cols-2'
        }`}
      >
        <div>
          <dt className="font-bold text-brand-muted">Seu papel</dt>
          <dd className="mt-1 text-brand-text">{scenario.role}</dd>
        </div>
        <div>
          <dt className="font-bold text-brand-muted">Empresa / setor</dt>
          <dd className="mt-1 text-brand-text">
            {scenario.company}
            {scenario.sector ? ` · ${scenario.sector}` : ''}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-brand-muted">Objetivo</dt>
          <dd className="mt-1 leading-6 text-brand-text">
            {scenario.objective}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-brand-muted">Restrição real</dt>
          <dd className="mt-1 leading-6 text-brand-text">
            {scenario.constraint}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function SectionEvaluation({
  evaluation,
  onUseNatural,
  onRewrite,
}: {
  evaluation: MeetingSectionState;
  onUseNatural: () => void;
  onRewrite: () => void;
}) {
  return (
    <div
      className="mt-5 rounded-2xl border border-green-300 bg-green-50 p-4 dark:border-green-900/60 dark:bg-green-950/20"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-black text-brand-text">
          <CheckCircle2
            size={20}
            className="text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
          Bloco refinado
        </div>
        <span className="rounded-full bg-brand-surface px-3 py-1 text-xs font-black text-brand-accent">
          {evaluation.score}/100
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-brand-surface p-3">
          <p className="text-xs font-black uppercase tracking-wider text-brand-muted">
            Correção
          </p>
          <p className="mt-2 text-sm leading-6 text-brand-text">
            {evaluation.corrected}
          </p>
        </div>
        <div className="rounded-xl border border-brand-accent bg-brand-surface p-3">
          <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-brand-accent">
            <Sparkles size={14} aria-hidden="true" />
            Mais natural
          </p>
          <p className="mt-2 text-sm leading-6 text-brand-text">
            {evaluation.naturalVersion}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onRewrite} className={secondaryButton}>
          <RotateCcw size={16} aria-hidden="true" />
          Reescrever
        </button>
        <button type="button" onClick={onUseNatural} className={primaryButton}>
          <Check size={16} aria-hidden="true" />
          Usar versão natural
        </button>
      </div>
    </div>
  );
}

export function WolfieMeetingActivity({
  session,
  onSessionChange,
  onComplete,
  onExit,
}: WolfieMeetingActivityProps) {
  const initialStage: MeetingStage =
    session.phase === 'readaptation'
      ? 'readaptation'
      : session.status === 'COMPLETED'
        ? 'memorization'
        : 'construction';
  const [stage, setStage] = useState<MeetingStage>(initialStage);
  const [constructionSession] = useState(session);
  const [readaptationSession, setReadaptationSession] =
    useState<WolfieActivitySession | null>(
      session.phase === 'readaptation' ? session : null,
    );
  const sections = constructionSession.activity_content.sections ?? [];
  const [currentSectionIndex, setCurrentSectionIndex] = useState(() => {
    const firstIncomplete = sections.findIndex(
      (section) => !constructionSession.learner_state.sections?.[section.key],
    );
    return firstIncomplete >= 0
      ? firstIncomplete
      : Math.max(0, sections.length - 1);
  });
  const [sectionInputs, setSectionInputs] = useState<
    Partial<Record<MeetingSection['key'], string>>
  >(() => {
    const values: Partial<Record<MeetingSection['key'], string>> = {};
    sections.forEach((section) => {
      values[section.key] =
        constructionSession.learner_state.sections?.[section.key]?.original ??
        '';
    });
    return values;
  });
  const [evaluations, setEvaluations] = useState<
    Partial<Record<MeetingSection['key'], MeetingSectionState>>
  >(() => constructionSession.learner_state.sections ?? {});
  const [memorization, setMemorization] = useState<MemorizationState>(() => ({
    hiddenSections:
      constructionSession.learner_state.memorization?.hiddenSections ?? [],
    rehearsalCount:
      constructionSession.learner_state.memorization?.rehearsalCount ?? 0,
    confidence:
      constructionSession.learner_state.memorization?.confidence ?? 50,
  }));
  const [responseMode, setResponseMode] = useState<ResponseMode>('text');
  const [readaptationSector, setReadaptationSector] = useState(
    constructionSession.sector ?? SECTOR_OPTIONS[0]?.id ?? '',
  );
  const [readaptationText, setReadaptationText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const stageStartedAt = useRef(Date.now());
  const sectionRequests = useRef<
    Partial<
      Record<MeetingSection['key'], { text: string; requestKey: string }>
    >
  >({});
  const constructionFinalRequest = useRef<{
    text: string;
    requestKey: string;
  } | null>(null);
  const readaptationGenerateRequestKey = useRef('');
  const readaptationTextRequest = useRef<{
    text: string;
    requestKey: string;
  } | null>(null);

  const currentSection = sections[currentSectionIndex];
  const currentEvaluation = currentSection
    ? evaluations[currentSection.key]
    : undefined;
  const completedSectionCount = sections.filter(
    (section) => evaluations[section.key],
  ).length;

  const polishedSections = useMemo(
    () =>
      sections.map((section) => {
        const evaluation = evaluations[section.key];
        return {
          ...section,
          text:
            evaluation?.naturalVersion ||
            evaluation?.corrected ||
            sectionInputs[section.key] ||
            '',
        };
      }),
    [evaluations, sectionInputs, sections],
  );

  useEffect(() => {
    stageHeadingRef.current?.focus();
    stageStartedAt.current = Date.now();
  }, [stage]);

  useEffect(() => {
    if (stage !== 'memorization') return;
    const timer = window.setTimeout(() => {
      void saveWolfieMemorization(
        constructionSession.id,
        memorization,
      ).catch(() => {
        // A chamada final antes da readaptação continua sendo a garantia forte.
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [constructionSession.id, memorization, stage]);

  const durationSeconds = () =>
    Math.max(
      1,
      Math.round((Date.now() - stageStartedAt.current) / 1_000),
    );

  const saveAndExit = async () => {
    if (busy) return;
    if (stage === 'memorization') {
      setBusy(true);
      setError('');
      try {
        await saveWolfieMemorization(
          constructionSession.id,
          memorization,
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível salvar antes de sair.',
        );
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onExit();
  };

  const submitCurrentSection = async () => {
    if (!currentSection || busy) return;
    const text = (sectionInputs[currentSection.key] ?? '').trim();
    if (text.length < 3) {
      setError(
        'Escreva ao menos uma frase em inglês para receber uma correção útil.',
      );
      return;
    }

    setBusy(true);
    setError('');
    try {
      if (sectionRequests.current[currentSection.key]?.text !== text) {
        sectionRequests.current[currentSection.key] = {
          text,
          requestKey: createWolfieRequestKey(),
        };
      }
      const result = await submitWolfieText({
        sessionId: constructionSession.id,
        text,
        durationSeconds: durationSeconds(),
        stepKey: currentSection.key,
        complete: false,
        modality: 'text',
        requestKey:
          sectionRequests.current[currentSection.key]?.requestKey,
      });
      const evaluation: MeetingSectionState = {
        original: text,
        corrected: result.correctedText || text,
        naturalVersion: result.naturalVersion || result.correctedText || text,
        score: result.score,
        savedAt: new Date().toISOString(),
      };
      setEvaluations((current) => ({
        ...current,
        [currentSection.key]: evaluation,
      }));
      delete sectionRequests.current[currentSection.key];
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível corrigir este bloco.',
      );
    } finally {
      setBusy(false);
    }
  };

  const finalizeConstruction = async () => {
    if (completedSectionCount !== sections.length || busy) return;
    const completeScript = polishedSections
      .map((section) => section.text)
      .join('\n\n');
    setBusy(true);
    setError('');
    try {
      if (constructionFinalRequest.current?.text !== completeScript) {
        constructionFinalRequest.current = {
          text: completeScript,
          requestKey: createWolfieRequestKey(),
        };
      }
      await submitWolfieText({
        sessionId: constructionSession.id,
        text: completeScript,
        durationSeconds: durationSeconds(),
        stepKey: 'final',
        complete: true,
        modality: 'text',
        requestKey: constructionFinalRequest.current.requestKey,
      });
      setStage('memorization');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível consolidar seu roteiro.',
      );
    } finally {
      setBusy(false);
    }
  };

  const continueConstruction = () => {
    if (currentSectionIndex < sections.length - 1) {
      setCurrentSectionIndex((index) => index + 1);
      setError('');
      return;
    }
    void finalizeConstruction();
  };

  const startReadaptation = async () => {
    if (memorization.rehearsalCount < 1 || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveWolfieMemorization(
        constructionSession.id,
        memorization,
      );
      const nextSession = await generateWolfieActivity({
        subject: 'global_meetings',
        level: constructionSession.cefr_level,
        sector:
          readaptationSector || constructionSession.sector || undefined,
        phase: 'readaptation',
        modality: 'mixed',
        sourceSessionId: constructionSession.id,
        requestKey:
          readaptationGenerateRequestKey.current ||
          (readaptationGenerateRequestKey.current =
            createWolfieRequestKey()),
      });
      setReadaptationSession(nextSession);
      onSessionChange(nextSession);
      setStage('readaptation');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível preparar o novo cenário.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitReadaptationText = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !readaptationSession ||
      readaptationText.trim().length < 3 ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const submittedText = readaptationText.trim();
      if (readaptationTextRequest.current?.text !== submittedText) {
        readaptationTextRequest.current = {
          text: submittedText,
          requestKey: createWolfieRequestKey(),
        };
      }
      const result = await submitWolfieText({
        sessionId: readaptationSession.id,
        text: submittedText,
        durationSeconds: durationSeconds(),
        stepKey: 'final',
        complete: true,
        modality: 'text',
        requestKey: readaptationTextRequest.current.requestKey,
      });
      onComplete(result, readaptationSession);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível avaliar sua readaptação.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitReadaptationAudio = async (
    payload: RecordedAudioPayload,
  ): Promise<void> => {
    if (!readaptationSession || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await analyzeWolfieSpeech({
        sessionId: readaptationSession.id,
        audioBase64: payload.audioBase64,
        mimeType: payload.mimeType,
        durationSeconds: payload.durationSeconds,
        stepKey: 'final_speech',
        complete: true,
        requestKey: payload.requestKey,
      });
      onComplete(result, readaptationSession);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível analisar sua fala.',
      );
    } finally {
      setBusy(false);
    }
  };

  const activeSession = readaptationSession ?? constructionSession;
  const headerKicker =
    stage === 'construction'
      ? 'Fase 1 · Construção'
      : stage === 'memorization'
        ? 'Fase 1 · Memorização'
        : 'Fase 2 · Independência';

  if (sections.length !== 6 && stage !== 'readaptation') {
    return (
      <div className="min-h-[60vh] bg-brand-bg">
        <ActivityHeader
          session={constructionSession}
          kicker="Reuniões globais"
          onBack={() => void saveAndExit()}
        />
        <div className="mx-auto max-w-3xl px-4 py-10">
          <InlineError
            message="O roteiro não trouxe os seis marcos necessários. Volte e gere um novo cenário."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[75vh] bg-brand-bg">
      <ActivityHeader
        session={activeSession}
        kicker={headerKicker}
        progress={
          stage === 'construction'
            ? `${completedSectionCount} de 6 blocos`
            : undefined
        }
        onBack={() => void saveAndExit()}
      />
      <MeetingJourneyProgress stage={stage} />

      {stage === 'construction' && currentSection ? (
        <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[minmax(0,1fr)_19rem] lg:py-8">
          <div className="min-w-0 space-y-5">
            <ScenarioCard session={constructionSession} />

            <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                    Bloco {currentSectionIndex + 1} de 6
                  </p>
                  <h2
                    ref={stageHeadingRef}
                    tabIndex={-1}
                    className="mt-2 text-2xl font-black text-brand-text outline-none"
                  >
                    {currentSection.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-brand-muted">
                    {currentSection.objective}
                  </p>
                </div>
                <div className="rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-muted">
                  {completedSectionCount}/6 refinados
                </div>
              </div>

              <div className="mt-5 flex items-start gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
                <Lightbulb
                  size={19}
                  className="mt-0.5 shrink-0 text-brand-accent"
                  aria-hidden="true"
                />
                <div className="text-sm leading-6">
                  <p className="font-bold text-brand-text">Como pensar</p>
                  <p className="text-brand-muted">{currentSection.coachTipPt}</p>
                  {currentSection.starter ? (
                    <p className="mt-2 text-brand-text">
                      <span className="font-bold">Você pode começar:</span>{' '}
                      <span lang="en">“{currentSection.starter}”</span>
                    </p>
                  ) : null}
                </div>
              </div>

              <label
                htmlFor={`meeting-section-${currentSection.key}`}
                className="mt-5 block text-sm font-black text-brand-text"
              >
                Escreva este trecho em inglês
              </label>
              <textarea
                id={`meeting-section-${currentSection.key}`}
                value={sectionInputs[currentSection.key] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setSectionInputs((current) => ({
                    ...current,
                    [currentSection.key]: value,
                  }));
                }}
                rows={6}
                maxLength={12_000}
                lang="en"
                spellCheck
                disabled={busy || Boolean(currentEvaluation)}
                placeholder={currentSection.starter || 'Write this part here…'}
                className={`${inputClass} mt-2 resize-y leading-7 disabled:opacity-70`}
              />

              {currentEvaluation ? (
                <SectionEvaluation
                  evaluation={currentEvaluation}
                  onUseNatural={() =>
                    setSectionInputs((current) => ({
                      ...current,
                      [currentSection.key]:
                        currentEvaluation.naturalVersion,
                    }))
                  }
                  onRewrite={() => {
                    setEvaluations((current) => {
                      const next = { ...current };
                      delete next[currentSection.key];
                      return next;
                    });
                    setError('');
                  }}
                />
              ) : null}

              {error ? (
                <div className="mt-5">
                  <InlineError
                    message={error}
                    onRetry={() => void submitCurrentSection()}
                  />
                </div>
              ) : null}

              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                <button
                  type="button"
                  onClick={() =>
                    setCurrentSectionIndex((index) => Math.max(0, index - 1))
                  }
                  disabled={currentSectionIndex === 0 || busy}
                  className={secondaryButton}
                >
                  Voltar um bloco
                </button>
                {currentEvaluation ? (
                  <button
                    type="button"
                    onClick={continueConstruction}
                    disabled={busy}
                    className={primaryButton}
                  >
                    {busy ? (
                      <BusyLabel>Consolidando roteiro…</BusyLabel>
                    ) : currentSectionIndex === sections.length - 1 ? (
                      <>
                        Ir para memorização
                        <Brain size={18} aria-hidden="true" />
                      </>
                    ) : (
                      <>
                        Próximo bloco
                        <ChevronRight size={18} aria-hidden="true" />
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void submitCurrentSection()}
                    disabled={
                      busy ||
                      (sectionInputs[currentSection.key] ?? '').trim().length < 3
                    }
                    className={primaryButton}
                  >
                    {busy ? (
                      <BusyLabel>Refinando este bloco…</BusyLabel>
                    ) : (
                      <>
                        <Sparkles size={17} aria-hidden="true" />
                        Corrigir este bloco
                      </>
                    )}
                  </button>
                )}
              </div>
            </section>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
            <ReadinessCard
              goal={constructionSession.activity_content.readinessGoal}
            />
            <section className="rounded-2xl border border-brand-border bg-brand-surface p-4">
              <h2 className="text-xs font-black uppercase tracking-[0.14em] text-brand-muted">
                Estrutura da reunião
              </h2>
              <ol className="mt-3 space-y-2">
                {sections.map((section, index) => {
                  const complete = Boolean(evaluations[section.key]);
                  const current = index === currentSectionIndex;
                  return (
                    <li key={section.key}>
                      <button
                        type="button"
                        onClick={() => setCurrentSectionIndex(index)}
                        disabled={
                          index > currentSectionIndex &&
                          !evaluations[sections[index - 1]?.key]
                        }
                        aria-current={current ? 'step' : undefined}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold ${
                          current
                            ? 'bg-brand-surface-2 text-brand-accent'
                            : 'text-brand-muted hover:bg-brand-surface-2'
                        } disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                      >
                        <span
                          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                            complete
                              ? 'bg-brand-accent text-white'
                              : 'border border-brand-border bg-brand-bg'
                          }`}
                        >
                          {complete ? (
                            <Check size={13} aria-hidden="true" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        {section.title}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
            <VocabularyCard
              items={
                constructionSession.activity_content.targetVocabulary ?? []
              }
            />
          </aside>
        </main>
      ) : null}

      {stage === 'memorization' ? (
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-7 lg:py-8">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <section className="min-w-0">
              <div className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                      Memorização guiada
                    </p>
                    <h2
                      ref={stageHeadingRef}
                      tabIndex={-1}
                      className="mt-2 text-2xl font-black text-brand-text outline-none sm:text-3xl"
                    >
                      Memorize a lógica, não cada palavra
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-muted">
                      Oculte blocos aos poucos e reconstrua a ideia em voz alta.
                      Seu objetivo é lembrar a sequência e a intenção.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setMemorization((current) => ({
                          ...current,
                          hiddenSections: sections.map(
                            (section) => section.key,
                          ),
                        }))
                      }
                      className={secondaryButton}
                    >
                      <EyeOff size={16} aria-hidden="true" />
                      Ocultar tudo
                    </button>
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  {polishedSections.map((section, index) => {
                    const hidden = memorization.hiddenSections.includes(
                      section.key,
                    );
                    return (
                      <article
                        key={section.key}
                        className="rounded-2xl border border-brand-border bg-brand-bg p-4"
                      >
                        <div className="flex items-start gap-3">
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-surface-2 text-xs font-black text-brand-accent">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h3 className="font-black text-brand-text">
                                {section.title}
                              </h3>
                              <button
                                type="button"
                                onClick={() =>
                                  setMemorization((current) => ({
                                    ...current,
                                    hiddenSections: hidden
                                      ? current.hiddenSections.filter(
                                          (key) => key !== section.key,
                                        )
                                      : [
                                          ...current.hiddenSections,
                                          section.key,
                                        ],
                                  }))
                                }
                                className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-brand-accent hover:bg-brand-surface-2 ${focusRing}`}
                                aria-expanded={!hidden}
                              >
                                {hidden ? (
                                  <>
                                    <Eye size={15} aria-hidden="true" />
                                    Revelar
                                  </>
                                ) : (
                                  <>
                                    <EyeOff size={15} aria-hidden="true" />
                                    Ocultar
                                  </>
                                )}
                              </button>
                            </div>
                            <p className="mt-1 text-xs leading-5 text-brand-muted">
                              {section.objective}
                            </p>
                            {hidden ? (
                              <div className="mt-3 rounded-xl border border-dashed border-brand-border bg-brand-surface-2 p-4 text-sm font-bold text-brand-muted">
                                Diga este trecho sem olhar. Depois revele e
                                compare.
                              </div>
                            ) : (
                              <p
                                lang="en"
                                className="mt-3 text-sm leading-7 text-brand-text"
                              >
                                {section.text}
                              </p>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="mt-6 rounded-2xl border border-brand-border bg-brand-surface-2 p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-black text-brand-text">
                        Rodadas concluídas: {memorization.rehearsalCount}
                      </p>
                      <p className="mt-1 text-sm text-brand-muted">
                        Passe pelos seis blocos em voz alta e marque uma rodada.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setMemorization((current) => ({
                          ...current,
                          rehearsalCount: current.rehearsalCount + 1,
                        }))
                      }
                      className={secondaryButton}
                    >
                      <CheckCircle2 size={17} aria-hidden="true" />
                      Concluí uma rodada
                    </button>
                  </div>

                  <label
                    htmlFor="meeting-confidence"
                    className="mt-5 flex justify-between gap-3 text-sm font-bold text-brand-text"
                  >
                    <span>Quão confiante você está sem o roteiro?</span>
                    <span className="text-brand-accent">
                      {memorization.confidence}%
                    </span>
                  </label>
                  <input
                    id="meeting-confidence"
                    type="range"
                    min="0"
                    max="100"
                    step="10"
                    value={memorization.confidence}
                    onChange={(event) =>
                      setMemorization((current) => ({
                        ...current,
                        confidence: Number(event.target.value),
                      }))
                    }
                    className={`mt-3 w-full accent-[var(--brand-accent)] ${focusRing}`}
                  />
                </div>

                <div className="mt-5 rounded-2xl border border-brand-border bg-brand-bg p-4 sm:p-5">
                  <label
                    htmlFor="meeting-readaptation-sector"
                    className="text-sm font-black text-brand-text"
                  >
                    Onde será o novo desafio?
                  </label>
                  <p className="mt-1 text-xs leading-5 text-brand-muted">
                    Mantenha o setor para aprofundar o contexto ou escolha outro
                    para provar que a estrutura viaja com você.
                  </p>
                  <select
                    id="meeting-readaptation-sector"
                    value={readaptationSector}
                    onChange={(event) => {
                      setReadaptationSector(event.target.value);
                      readaptationGenerateRequestKey.current = '';
                      setError('');
                    }}
                    className={`${inputClass} mt-3`}
                  >
                    {SECTOR_OPTIONS.map((sector) => (
                      <option key={sector.id} value={sector.id}>
                        {sector.title}
                        {sector.id === constructionSession.sector
                          ? ' · mesmo setor'
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {error ? (
                  <div className="mt-5">
                    <InlineError
                      message={error}
                      onRetry={() => void startReadaptation()}
                    />
                  </div>
                ) : null}

                <div className="mt-6 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void startReadaptation()}
                    disabled={busy || memorization.rehearsalCount < 1}
                    className={primaryButton}
                  >
                    {busy ? (
                      <BusyLabel>Criando um novo desafio…</BusyLabel>
                    ) : (
                      <>
                        Testar minha independência
                        <ArrowRight size={18} aria-hidden="true" />
                      </>
                    )}
                  </button>
                </div>
                {memorization.rehearsalCount < 1 ? (
                  <p className="mt-2 text-right text-xs text-brand-muted">
                    Conclua ao menos uma rodada antes de readaptar.
                  </p>
                ) : null}
              </div>
            </section>

            <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
              <ReadinessCard
                goal="Reconstruir a sequência abertura → contexto → dados → proposta → próximos passos → encerramento sem depender de um texto decorado."
              />
              <ScenarioCard session={constructionSession} compact />
            </aside>
          </div>
        </main>
      ) : null}

      {stage === 'readaptation' && readaptationSession ? (
        <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[minmax(0,1fr)_19rem] lg:py-8">
          <div className="min-w-0 space-y-5">
            <ScenarioCard session={readaptationSession} />

            <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                  Desafio de transferência
                </p>
                <h2
                  ref={stageHeadingRef}
                  tabIndex={-1}
                  className="mt-2 text-2xl font-black text-brand-text outline-none sm:text-3xl"
                >
                  Conduza a nova reunião com suas próprias palavras
                </h2>
                <p className="mt-2 text-sm leading-6 text-brand-muted">
                  Preserve a lógica dos seis marcos, mas não copie o roteiro
                  anterior. É aqui que o aprendizado vira autonomia.
                </p>
              </div>

              <div
                className="mt-6 grid grid-cols-2 rounded-xl border border-brand-border bg-brand-surface-2 p-1"
                role="tablist"
                aria-label="Formato da resposta"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={responseMode === 'text'}
                  onClick={() => setResponseMode('text')}
                  className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold ${
                    responseMode === 'text'
                      ? 'bg-brand-surface text-brand-accent shadow-sm'
                      : 'text-brand-muted'
                  } ${focusRing}`}
                >
                  <FileText size={17} aria-hidden="true" />
                  Texto
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={responseMode === 'voice'}
                  onClick={() => setResponseMode('voice')}
                  className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold ${
                    responseMode === 'voice'
                      ? 'bg-brand-surface text-brand-accent shadow-sm'
                      : 'text-brand-muted'
                  } ${focusRing}`}
                >
                  <Mic size={17} aria-hidden="true" />
                  Áudio
                </button>
              </div>

              {responseMode === 'text' ? (
                <form onSubmit={submitReadaptationText} className="mt-5">
                  <label
                    htmlFor="meeting-readaptation-text"
                    className="text-sm font-black text-brand-text"
                  >
                    Sua nova fala em inglês
                  </label>
                  <textarea
                    id="meeting-readaptation-text"
                    value={readaptationText}
                    onChange={(event) =>
                      setReadaptationText(event.target.value)
                    }
                    rows={13}
                    maxLength={12_000}
                    lang="en"
                    spellCheck
                    disabled={busy}
                    placeholder="Open the meeting, explain the context, use data, propose a solution, confirm next steps and close…"
                    className={`${inputClass} mt-2 min-h-72 resize-y leading-7`}
                  />
                  <div className="mt-2 text-right text-xs text-brand-muted">
                    {readaptationText
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean).length}{' '}
                    palavras
                  </div>

                  {error ? (
                    <div className="mt-5">
                      <InlineError message={error} />
                    </div>
                  ) : null}

                  <div className="mt-6 flex justify-end">
                    <button
                      type="submit"
                      disabled={
                        busy || readaptationText.trim().length < 3
                      }
                      className={primaryButton}
                    >
                      {busy ? (
                        <BusyLabel>Avaliando sua autonomia…</BusyLabel>
                      ) : (
                        <>
                          <Send size={18} aria-hidden="true" />
                          Avaliar minha reunião
                        </>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-5">
                  <WolfieAudioRecorder
                    busy={busy}
                    onAnalyze={submitReadaptationAudio}
                  />
                  {error ? (
                    <div className="mt-5">
                      <InlineError message={error} />
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
            <ReadinessCard
              goal={readaptationSession.activity_content.readinessGoal}
            />
            <section className="rounded-2xl border border-brand-border bg-brand-surface p-4">
              <h2 className="text-xs font-black uppercase tracking-[0.14em] text-brand-muted">
                Seus seis marcos
              </h2>
              <ol className="mt-3 space-y-3">
                {(readaptationSession.activity_content.sections ?? []).map(
                  (section, index) => (
                    <li
                      key={section.key}
                      className="flex gap-2 text-sm leading-5 text-brand-muted"
                    >
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-surface-2 text-xs font-black text-brand-accent">
                        {index + 1}
                      </span>
                      <span>
                        <strong className="block text-brand-text">
                          {section.title}
                        </strong>
                        {section.objective}
                      </span>
                    </li>
                  ),
                )}
              </ol>
            </section>
            <section className="rounded-2xl border border-brand-border bg-brand-surface p-4">
              <h2 className="text-xs font-black uppercase tracking-[0.14em] text-brand-muted">
                Regras do desafio
              </h2>
              <div className="mt-3">
                <Checklist
                  items={
                    readaptationSession.activity_content.readaptationRules ??
                    [
                      'Use o novo cenário.',
                      'Mantenha os seis marcos.',
                      'Fale com suas próprias palavras.',
                    ]
                  }
                />
              </div>
            </section>
            <VocabularyCard
              items={
                readaptationSession.activity_content.targetVocabulary ?? []
              }
              title="Repertório para transferir"
            />
          </aside>
        </main>
      ) : null}
    </div>
  );
}
