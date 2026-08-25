import React, { useMemo, useState } from 'react';
import { AlertCircle, Plus, RefreshCw, UserPlus, X } from 'lucide-react';
import LessonPlannerAI, {
  type LessonPlannerAdapter,
  type LessonPlannerLearnerContext,
  type StudentOption,
  type WolfIntelligence,
} from '../LessonPlannerAI';
import { supabase } from '../../lib/supabase';
import { UserRole } from '../../types';
import type { HubBootstrap } from './types';

interface HubEducatorPlannerProps {
  bootstrap: HubBootstrap;
  userEmail: string;
  onRefresh: () => Promise<void>;
  onUpgrade: () => void;
}

const plannerError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error && value.message) return value;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const message = typeof candidate.code === 'string'
      ? candidate.code
      : typeof candidate.error === 'string'
        ? candidate.error
        : null;
    if (message) return new Error(message);
  }
  return new Error(fallback);
};

const loadLearnerContext = async (
  accountId: string,
  learnerId: string,
): Promise<LessonPlannerLearnerContext> => {
  const { data, error } = await supabase.functions.invoke<unknown>('pedagogical-content', {
    body: {
      hubMode: true,
      action: 'history',
      accountId,
      learnerId,
    },
  });
  if (error) throw plannerError(error, 'Não foi possível carregar o contexto do aluno.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('O Planner AI devolveu um contexto inválido.');
  }
  const payload = data as Record<string, unknown>;
  if ('error' in payload) {
    throw plannerError(payload, 'Não foi possível carregar o contexto do aluno.');
  }
  const learner = payload.learner;
  if (!learner || typeof learner !== 'object' || Array.isArray(learner)) {
    throw new Error('Aluno não encontrado neste ambiente.');
  }
  const learnerRecord = learner as Record<string, unknown>;
  if (typeof learnerRecord.id !== 'string' || learnerRecord.id !== learnerId) {
    throw new Error('O contexto recebido não pertence ao aluno selecionado.');
  }

  return {
    profile: {
      id: learnerRecord.id,
      module: typeof learnerRecord.module === 'string' ? learnerRecord.module : null,
      english_for: typeof learnerRecord.english_for === 'string' ? learnerRecord.english_for : null,
      occupation: typeof learnerRecord.occupation === 'string' ? learnerRecord.occupation : null,
      personality: typeof learnerRecord.personality === 'string' ? learnerRecord.personality : null,
      preferred_topics: Array.isArray(learnerRecord.preferred_topics)
        ? learnerRecord.preferred_topics.filter((item): item is string => typeof item === 'string')
        : [],
    },
    intelligence: payload.memory && typeof payload.memory === 'object' && !Array.isArray(payload.memory)
      ? payload.memory as WolfIntelligence
      : null,
    history: Array.isArray(payload.history)
      ? payload.history.filter((item): item is LessonPlannerLearnerContext['history'][number] => (
        Boolean(item)
        && typeof item === 'object'
        && typeof (item as Record<string, unknown>).id === 'string'
        && typeof (item as Record<string, unknown>).created_at === 'string'
      ))
      : [],
  };
};

const HubEducatorPlanner: React.FC<HubEducatorPlannerProps> = ({
  bootstrap,
  userEmail,
  onRefresh,
  onUpgrade,
}) => {
  const [adapterVersion, setAdapterVersion] = useState(0);
  const [creatingLearner, setCreatingLearner] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [levelTag, setLevelTag] = useState('B1');
  const [objective, setObjective] = useState('');
  const [interests, setInterests] = useState('');
  const [notes, setNotes] = useState('');
  const [savingLearner, setSavingLearner] = useState(false);
  const [learnerError, setLearnerError] = useState('');
  const entitlement = bootstrap.entitlements['educator_ai.generate'];

  const adapter = useMemo<LessonPlannerAdapter>(() => ({
    contextKey: `hub:${bootstrap.account.id}:${adapterVersion}`,
    capabilities: {
      canPersist: true,
      hasPedagogicalMemory: true,
    },
    listLearners: async (): Promise<StudentOption[]> => {
      const { data, error } = await supabase.rpc('hub_list_educator_learners', {
        p_account_id: bootstrap.account.id,
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('A lista de alunos recebida é inválida.');
      return data.flatMap((learner) => {
        if (!learner || typeof learner !== 'object') return [];
        const record = learner as Record<string, unknown>;
        if (typeof record.id !== 'string') return [];
        return [{
          id: record.id,
          full_name: typeof record.display_name === 'string' ? record.display_name : null,
          module: typeof record.level_tag === 'string' ? record.level_tag : null,
        }];
      });
    },
    loadLearnerContext: (learnerId) => loadLearnerContext(bootstrap.account.id, learnerId),
    generate: async (input) => {
      const requestKey = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke<unknown>('pedagogical-content', {
        body: {
          hubMode: true,
          action: 'generate',
          accountId: bootstrap.account.id,
          learnerId: input.learnerId,
          task_mode: input.taskMode,
          bilingual: input.bilingual,
          duration_minutes: input.durationMinutes,
          teacher_request: input.teacherRequest,
          requestKey,
        },
      });
      if (error) throw plannerError(error, 'Falha ao consultar o Planner AI.');
      if (data && typeof data === 'object' && 'error' in data) {
        throw plannerError(data, 'Falha ao consultar o Planner AI.');
      }
      await onRefresh();
      return data;
    },
    save: async (runId) => {
      const { data, error } = await supabase.functions.invoke<unknown>('pedagogical-content', {
        body: {
          hubMode: true,
          action: 'save',
          accountId: bootstrap.account.id,
          run_id: runId,
        },
      });
      if (error) throw plannerError(error, 'Falha ao salvar o plano.');
      if (data && typeof data === 'object' && 'error' in data) {
        throw plannerError(data, 'Falha ao salvar o plano.');
      }
      await onRefresh();
    },
  }), [adapterVersion, bootstrap.account.id, onRefresh]);

  const createLearner = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    if (normalizedName.length < 2) {
      setLearnerError('Informe o nome do aluno.');
      return;
    }
    setSavingLearner(true);
    setLearnerError('');
    try {
      const parsedInterests = interests
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 12);
      const { error } = await supabase.rpc('hub_create_educator_learner', {
        p_account_id: bootstrap.account.id,
        p_name: normalizedName,
        p_level: levelTag,
        p_objective: objective.trim() || null,
        p_interests: parsedInterests,
        p_notes: notes.trim() || null,
      });
      if (error) throw error;
      setDisplayName('');
      setObjective('');
      setInterests('');
      setNotes('');
      setCreatingLearner(false);
      setAdapterVersion((current) => current + 1);
    } catch (error) {
      setLearnerError(plannerError(error, 'Não foi possível criar o perfil do aluno.').message);
    } finally {
      setSavingLearner(false);
    }
  };

  const plannerUser = {
    id: bootstrap.account.id,
    tenantId: '',
    name: bootstrap.memberProfile?.display_name || bootstrap.account.name,
    email: userEmail,
    role: UserRole.NON_STUDENT,
  };

  if (!entitlement) {
    return (
      <section className="mx-auto max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-sm sm:p-12">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><AlertCircle size={24} /></div>
        <h1 className="mt-5 text-3xl font-black tracking-tight text-brand-text">Educador IA não incluído neste plano</h1>
        <p className="mx-auto mt-3 max-w-lg leading-7 text-brand-muted">Escolha uma assinatura para professores ou escolas antes de criar perfis e planejamentos.</p>
        <button type="button" onClick={onUpgrade} className="mt-7 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver opções de acesso</button>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-4 rounded-3xl border border-brand-border bg-brand-surface p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Ambiente da assinatura</p>
          <p className="mt-1 text-sm font-bold text-brand-text">Os perfis e planos abaixo pertencem somente a {bootstrap.account.name}.</p>
          <p className="mt-1 text-xs text-brand-muted">
            {entitlement?.limit == null
              ? `${entitlement?.used || 0} gerações usadas · ilimitado`
              : `${entitlement?.used || 0} de ${entitlement?.limit || 0} gerações usadas`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setCreatingLearner(true)} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-4 py-3 text-xs font-black text-white">
            <Plus size={16} /> Novo aluno
          </button>
          <button type="button" onClick={onUpgrade} className="rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-xs font-black text-brand-text">
            Ver limite do plano
          </button>
        </div>
      </div>

      <LessonPlannerAI user={plannerUser} adapter={adapter} />

      {creatingLearner && (
        <div className="fixed inset-0 z-[150] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="hub-learner-title">
          <form onSubmit={createLearner} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[2rem] border border-brand-border bg-brand-surface p-6 shadow-2xl sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="grid size-11 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><UserPlus size={20} /></div>
                <h2 id="hub-learner-title" className="mt-4 text-2xl font-black text-brand-text">Novo perfil de aluno</h2>
                <p className="mt-2 text-sm leading-6 text-brand-muted">Somente membros autorizados deste ambiente poderão usar este contexto.</p>
              </div>
              <button type="button" onClick={() => setCreatingLearner(false)} className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label="Fechar"><X size={18} /></button>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nome do aluno</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-4 focus:ring-tenant-primary/10" autoFocus /></label>
              <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nível</span><select value={levelTag} onChange={(event) => setLevelTag(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">{['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((level) => <option key={level}>{level}</option>)}</select></label>
              <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Interesses</span><input value={interests} onChange={(event) => setInterests(event.target.value)} maxLength={400} placeholder="viagens, negócios, tecnologia" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" /></label>
              <label className="sm:col-span-2"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Objetivo</span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={800} className="min-h-24 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" /></label>
              <label className="sm:col-span-2"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Notas pedagógicas</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1200} className="min-h-24 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" /></label>
            </div>
            {learnerError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><AlertCircle className="mt-0.5 shrink-0" size={17} />{learnerError}</div>}
            <button disabled={savingLearner} className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-4 text-xs font-black uppercase tracking-widest text-white disabled:opacity-60">
              {savingLearner ? <RefreshCw className="animate-spin" size={17} /> : <UserPlus size={17} />}
              {savingLearner ? 'Criando perfil...' : 'Criar perfil isolado'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default HubEducatorPlanner;
