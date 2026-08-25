import React, { useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
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

const HubWolfieStudio: React.FC<HubWolfieStudioProps> = ({
  bootstrap,
  onRefresh,
  onUpgrade,
}) => {
  const preferences = bootstrap.memberProfile || {};
  const profileName = bootstrap.memberProfile?.display_name || bootstrap.account.name;
  const profileLevel = asLevel(preferences.level);
  const [selectedExperience, setSelectedExperience] = useState<LearningExperience | null>(null);
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
      <section className="rounded-3xl border border-brand-border bg-brand-surface p-6 text-center shadow-sm sm:p-8">
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
    <div className="min-h-[70vh] overflow-hidden rounded-3xl border border-brand-border bg-brand-bg shadow-sm">
      <WolfiePracticeHeader
        isSubjectView
        actionLabel="Meu acesso"
        onAction={onUpgrade}
      />
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
