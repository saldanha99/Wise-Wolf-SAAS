import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Sparkles } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { type DeskState, parseDesk } from './HubStudentDesk';
import WolfieTutor from '../WolfieTutor';
import {
  getUniverseForExperience,
  type LearningExperience,
} from '../../src/components/wolfie/experienceCatalog';
import { WolfieDiscoveryHome } from '../../src/components/wolfie/WolfieDiscoveryHome';
import { WolfiePracticeHeader } from '../../src/components/wolfie/WolfiePracticeHeader';
import type {
  CefrLevel,
  WolfieUserSummary,
} from '../../src/components/wolfie/types';
import type { HubBootstrap } from './types';

interface HubWolfieStudioProps {
  bootstrap: HubBootstrap;
  onRefresh: () => Promise<void>;
  onUpgrade: () => void;
}

const HUB_ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const asInterestList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return typeof value === 'string'
    ? value.split(/[,;\n]/u).map((item) => item.trim()).filter(Boolean)
    : [];
};

const asLevel = (value: unknown): CefrLevel =>
  CEFR_LEVELS.includes(value as CefrLevel) ? value as CefrLevel : 'B1';

export interface TeacherTask {
  title: string;
  topic: string;
  objective: string;
  note: string;
  teacherName: string;
  level: CefrLevel | null;
}

/** A prática do aluno convidado: a última tarefa ainda aberta do professor (ou a mais recente) + o objetivo. */
export function teacherTaskFromDesk(desk: DeskState | null): TeacherTask | null {
  if (!desk) return null;
  const tasks = desk.assignments.filter((item) => item.material.kind !== 'journey');
  const task = tasks.find((item) => item.status === 'ASSIGNED') ?? tasks[0];
  const objective = (desk.learner.objective || '').trim();
  if (!task && !objective) return null;
  return {
    title: task?.material.title || 'Prática com o objetivo do seu professor',
    topic: task?.material.topic || '',
    objective,
    note: (task?.note || '').trim(),
    teacherName: desk.teacher_name,
    level: CEFR_LEVELS.includes(desk.learner.level_tag as CefrLevel) ? desk.learner.level_tag as CefrLevel : null,
  };
}

export function teacherTaskScenario(task: TeacherTask): string {
  return [
    `Prática pedida pelo professor${task.teacherName ? ` ${task.teacherName}` : ''}: ${task.title}.`,
    task.topic ? `Tema da atividade: ${task.topic}.` : '',
    task.objective ? `Objetivo do aluno: ${task.objective}.` : '',
    task.note ? `Recado do professor: ${task.note.slice(0, 300)}` : '',
    'Comece pela tarefa e pelo objetivo do aluno; não troque por outro cenário.',
  ].filter(Boolean).join(' ').slice(0, 1200);
}

const HubWolfieStudio: React.FC<HubWolfieStudioProps> = ({
  bootstrap,
  onRefresh,
  onUpgrade,
}) => {
  const preferences = bootstrap.memberProfile || {};
  const profileName = bootstrap.memberProfile?.display_name || bootstrap.account.name;
  const profileLevel = asLevel(preferences.level);
  const [selectedExperience, setSelectedExperience] = useState<LearningExperience | null>(null);
  // Aluno convidado (LEARNER na conta do professor): o Wolfie abre na tarefa do professor.
  const isInvitedLearner = bootstrap.memberProfile?.subjectRole === 'LEARNER' && bootstrap.account.audience !== 'LEARNER';
  const [teacherTask, setTeacherTask] = useState<TeacherTask | null>(null);
  const [taskOpen, setTaskOpen] = useState(isInvitedLearner);
  const [taskLoading, setTaskLoading] = useState(isInvitedLearner);
  useEffect(() => {
    if (!isInvitedLearner) return;
    let alive = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('hub_learner_desk', { p_account_id: bootstrap.account.id });
        if (!alive) return;
        const task = error ? null : teacherTaskFromDesk(parseDesk(data));
        setTeacherTask(task);
        if (!task) setTaskOpen(false);
      } catch {
        if (alive) setTaskOpen(false);
      } finally {
        if (alive) setTaskLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [bootstrap.account.id, isInvitedLearner]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const entitlement = bootstrap.entitlements['wolfie.turn'];
  const accountContextValid = HUB_ACCOUNT_ID_PATTERN.test(bootstrap.account.id);
  const interests = useMemo(
    () => asInterestList(preferences.interests),
    [preferences.interests],
  );
  const user = useMemo<WolfieUserSummary>(() => ({
    name: profileName,
    full_name: profileName,
    occupation: preferences.role || undefined,
    studentCategory: bootstrap.memberProfile?.subjectRole === 'LEARNER'
      ? 'adult'
      : 'professional',
    interests,
    preferredTopics: interests,
    englishFor: preferences.goal || undefined,
    shortTermGoal: preferences.goal || undefined,
    wolfieSettings: {
      goal: preferences.goal || undefined,
      level: profileLevel,
      preferredCorrectionMode: 'selective',
      preferredLanguageMode: 'bilingual',
    },
  }), [
    bootstrap.memberProfile?.subjectRole,
    profileName,
    interests,
    preferences.goal,
    preferences.role,
    profileLevel,
  ]);
  const firstName = profileName.trim().split(/\s+/u)[0] || 'aluno';

  if (!entitlement || !accountContextValid) {
    return (
      <section className="rounded-3xl border border-brand-border bg-brand-surface p-6 text-center shadow-xs sm:p-8">
        <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent">
          <Sparkles size={24} aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-2xl font-black tracking-tight text-brand-text">
          O Wolfie precisa de um acesso confirmado
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-brand-muted">
          A conversa só começa depois que a conta e o benefício da assinatura estão disponíveis.
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-accent px-5 py-3 text-sm font-black text-white"
        >
          Ver opções de acesso
        </button>
      </section>
    );
  }

  if (taskLoading) {
    return <div role="status" className="flex min-h-60 items-center justify-center rounded-3xl border border-brand-border bg-brand-surface text-sm font-bold text-brand-muted">Preparando a prática do seu professor…</div>;
  }

  if (teacherTask && taskOpen) {
    const taskLevel = teacherTask.level ?? profileLevel;
    return (
      <WolfieTutor
        key={`${bootstrap.account.id}:teacher-task:${taskLevel}`}
        user={{
          ...user,
          levelBadge: taskLevel,
          englishFor: teacherTask.objective || user.englishFor,
          shortTermGoal: teacherTask.objective || user.shortTermGoal,
          wolfieSettings: { ...user.wolfieSettings, level: taskLevel, goal: teacherTask.objective || user.wolfieSettings?.goal },
        }}
        voiceMode={false}
        topic={teacherTask.title}
        correctionMode="selective"
        languageMode="bilingual"
        difficulty="adaptive"
        scenario={teacherTaskScenario(teacherTask)}
        studentGoal={teacherTask.objective || teacherTask.title}
        targetSkill={teacherTask.topic || undefined}
        hubContext={{
          accountId: bootstrap.account.id,
          onUsageCommitted: onRefresh,
        }}
        onClose={() => setTaskOpen(false)}
      />
    );
  }

  if (selectedExperience) {
    const universe = getUniverseForExperience(selectedExperience.id);
    const scenario = [
      `Experiência escolhida: ${selectedExperience.title}.`,
      universe ? `Universo selecionado: ${universe.id}.` : '',
      selectedExperience.description,
      `Objetivo real: ${selectedExperience.realWorldGoal}`,
      'Não mude para outro universo ou cenário.',
    ].filter(Boolean).join(' ');

    return (
      <WolfieTutor
        key={`${bootstrap.account.id}:${selectedExperience.id}:${profileLevel}`}
        user={{ ...user, levelBadge: profileLevel }}
        voiceMode={false}
        topic={selectedExperience.title}
        experienceMode={selectedExperience.experienceMode}
        correctionMode="selective"
        languageMode="bilingual"
        difficulty="adaptive"
        scenario={scenario}
        studentGoal={selectedExperience.realWorldGoal}
        targetSkill={selectedExperience.skills.join(', ')}
        experienceId={selectedExperience.id}
        experienceUniverse={universe?.id}
        experienceAudiences={selectedExperience.audiences}
        hubContext={{
          accountId: bootstrap.account.id,
          onUsageCommitted: onRefresh,
        }}
        onClose={() => setSelectedExperience(null)}
      />
    );
  }

  return (
    <div className="min-h-[70vh] overflow-hidden rounded-3xl border border-brand-border bg-brand-bg shadow-xs">
      <WolfiePracticeHeader
        isSubjectView
        actionLabel="Meu acesso"
        onAction={onUpgrade}
      />
      {teacherTask && (
        <button type="button" onClick={() => setTaskOpen(true)} className="mx-4 mt-4 flex w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-tenant-primary/30 bg-brand-surface p-4 text-left shadow-xs">
          <ClipboardList size={20} className="shrink-0 text-tenant-primary" aria-hidden="true" />
          <span><b className="block text-sm text-brand-text">Praticar a tarefa do professor</b><small className="text-xs text-brand-muted">{teacherTask.title}</small></span>
        </button>
      )}
      <WolfieDiscoveryHome
        user={user}
        firstName={firstName}
        profileLevel={profileLevel}
        overview={null}
        overviewError=""
        repertoireAvailable={false}
        resumableConversation={null}
        endingSessionId=""
        headingRef={headingRef}
        onChooseExperience={setSelectedExperience}
        onOpenRepertoire={onUpgrade}
        onReloadOverview={() => void onRefresh()}
        onResumeSession={() => {}}
        onResumeConversation={() => {}}
        onEndSession={() => {}}
        onEndConversation={() => {}}
      />
    </div>
  );
};

export default HubWolfieStudio;
