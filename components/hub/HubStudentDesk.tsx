import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, CircleCheck, FileText, Map, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { HubMaterialView, type HubMaterialKind, type HubMaterialRecord } from './HubMaterialGenerator';
import type { HubBootstrap } from './types';

// A mesa do aluno convidado: o que o professor lhe atribuiu — jornada e materiais
// — sempre na versão do aluno. O gabarito não chega aqui: `hub_learner_desk`
// tira as respostas no servidor antes de responder. Marcar como feito (com uma
// nota) é o sinal que o professor vê no painel dele.

interface HubStudentDeskProps {
  bootstrap: HubBootstrap;
}

export interface HubStudentAssignment {
  id: string;
  note: string;
  status: 'ASSIGNED' | 'DONE';
  student_note: string;
  done_at: string | null;
  created_at: string;
  material: HubMaterialRecord;
}

interface DeskState {
  learner: { id: string; display_name: string; level_tag: string | null; objective: string | null };
  teacher_name: string;
  assignments: HubStudentAssignment[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseDesk = (payload: unknown): DeskState | null => {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.learner)) return null;
  const learner = payload.learner;
  const assignments = (Array.isArray(payload.assignments) ? payload.assignments : []).flatMap((item): HubStudentAssignment[] => {
    if (!isRecord(item) || !isRecord(item.material)) return [];
    const material = item.material;
    const body = material.material;
    if (!isRecord(body)) return [];
    return [{
      id: String(item.id),
      note: String(item.note || ''),
      status: item.status === 'DONE' ? 'DONE' : 'ASSIGNED',
      student_note: String(item.student_note || ''),
      done_at: typeof item.done_at === 'string' ? item.done_at : null,
      created_at: String(item.created_at || ''),
      material: {
        id: String(material.id),
        kind: String(material.kind) as HubMaterialKind,
        niche: String(material.niche || 'GENERAL'),
        level_tag: String(material.level_tag || ''),
        topic: String(material.topic || ''),
        goal: typeof material.goal === 'string' ? material.goal : '',
        title: String(material.title || ''),
        created_at: String(material.created_at || ''),
        dropped_items: 0,
        material: body,
      },
    }];
  });
  return {
    learner: {
      id: String(learner.id),
      display_name: String(learner.display_name || ''),
      level_tag: typeof learner.level_tag === 'string' ? learner.level_tag : null,
      objective: typeof learner.objective === 'string' ? learner.objective : null,
    },
    teacher_name: String(payload.teacher_name || ''),
    assignments,
  };
};

const HubStudentDesk: React.FC<HubStudentDeskProps> = ({ bootstrap }) => {
  const [desk, setDesk] = useState<DeskState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc('hub_learner_desk', { p_account_id: bootstrap.account.id });
    setLoading(false);
    if (rpcError) {
      setError('Não foi possível carregar seus materiais agora.');
      return;
    }
    const parsed = parseDesk(data);
    if (!parsed) {
      setError('Sua conta ainda não está ligada a um professor neste ambiente.');
      return;
    }
    setError('');
    setDesk(parsed);
  }, [bootstrap.account.id]);

  useEffect(() => { void load(); }, [load]);

  const complete = async (assignment: HubStudentAssignment) => {
    setSaving(true);
    const { data, error: rpcError } = await supabase.rpc('hub_complete_assignment', { p_assignment_id: assignment.id, p_note: note.trim() });
    setSaving(false);
    if (rpcError || !isRecord(data) || data.ok !== true) {
      setError('Não foi possível marcar como feito. Tente de novo.');
      return;
    }
    setNote('');
    await load();
  };

  if (loading) {
    return <div role="status" className="flex min-h-60 items-center justify-center gap-3 rounded-[2.5rem] border border-brand-border bg-brand-surface text-sm font-bold text-brand-muted"><RefreshCw className="animate-spin text-tenant-primary" size={18} /> Carregando seus materiais...</div>;
  }
  if (error && !desk) {
    return <div role="alert" className="rounded-[2rem] border border-amber-200 bg-amber-50 p-6 text-sm font-bold text-amber-900"><AlertCircle className="mr-2 inline" size={16} />{error}</div>;
  }
  if (!desk) return null;

  const journey = desk.assignments.find((item) => item.material.kind === 'journey');
  const materials = desk.assignments.filter((item) => item.material.kind !== 'journey');
  const open = openId ? desk.assignments.find((item) => item.id === openId) : null;

  if (open) {
    return (
      <div className="space-y-4">
        <style>{`@media print { body * { visibility: hidden; } #hub-material-print, #hub-material-print * { visibility: visible; } #hub-material-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <button type="button" onClick={() => { setOpenId(null); setNote(''); }} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text"><ArrowLeft size={15} />Meus materiais</button>
          {open.note && <p className="rounded-2xl bg-tenant-primary/10 px-4 py-2 text-xs font-bold text-tenant-primary">Recado de {desk.teacher_name}: {open.note}</p>}
        </div>
        <HubMaterialView record={open.material} teacher={false} />
        <section className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 print:hidden">
          {open.status === 'DONE' ? (
            <p className="flex items-center gap-2 text-sm font-bold text-emerald-700"><CircleCheck size={18} />Você marcou como feito{open.done_at ? ` em ${new Date(open.done_at).toLocaleDateString('pt-BR')}` : ''}.{open.student_note ? ` Sua nota: “${open.student_note}”` : ''}</p>
          ) : (
            <>
              <p className="text-sm font-black text-brand-text">Terminou? Deixe um recado para {desk.teacher_name} (dúvidas, o que achou fácil ou difícil).</p>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1200} placeholder="Ex.: fiz tudo, travei na questão 3" className="mt-3 min-h-24 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" />
              {error && <p role="alert" className="mt-2 text-sm font-bold text-red-600">{error}</p>}
              <button type="button" disabled={saving} onClick={() => void complete(open)} className="mt-3 inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-5 py-3 text-sm font-black text-white disabled:opacity-60"><Check size={16} />{saving ? 'Salvando...' : 'Marcar como feito'}</button>
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[2.25rem] border border-brand-border bg-brand-surface p-7 shadow-sm sm:p-9">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Aluno de {desk.teacher_name}</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-brand-text">Olá, {desk.learner.display_name.split(' ')[0]}.</h1>
        <p className="mt-2 text-sm text-brand-muted">{desk.learner.objective ? `Objetivo: ${desk.learner.objective}` : 'Seus materiais e sua jornada ficam aqui.'}{desk.learner.level_tag ? ` · Nível ${desk.learner.level_tag}` : ''}</p>
        {materials.length === 0 && !journey && <p className="mt-4 rounded-2xl bg-brand-surface-2 p-4 text-sm text-brand-muted">Seu professor ainda não enviou material. Quando enviar, aparece aqui.</p>}
      </section>

      {journey && (
        <section className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary"><Map className="mr-1 inline" size={12} />Sua jornada de 90 dias</p>
              <h2 className="mt-1 text-xl font-black text-brand-text">{journey.material.title}</h2>
              {typeof journey.material.material.promise_pt === 'string' && <p className="mt-1 text-sm text-brand-muted">{journey.material.material.promise_pt}</p>}
            </div>
            <button type="button" onClick={() => setOpenId(journey.id)} className="shrink-0 rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-2.5 text-xs font-black text-brand-text">Ver as 12 semanas</button>
          </div>
        </section>
      )}

      <section className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 sm:p-6">
        <h2 className="text-base font-black text-brand-text">Meus materiais</h2>
        {materials.length === 0 ? (
          <p className="mt-3 text-sm text-brand-muted">Nenhum material ainda.</p>
        ) : (
          <ul className="mt-3 divide-y divide-brand-border">
            {materials.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => setOpenId(item.id)} className="flex w-full items-center gap-3 py-3 text-left">
                  <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${item.status === 'DONE' ? 'bg-emerald-100 text-emerald-700' : 'bg-tenant-primary/10 text-tenant-primary'}`}>{item.status === 'DONE' ? <CircleCheck size={16} /> : <FileText size={16} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-black text-brand-text">{item.material.title}</span>
                    <span className="block text-xs text-brand-muted">{item.material.level_tag} · {new Date(item.created_at).toLocaleDateString('pt-BR')}{item.note ? ` · ${item.note}` : ''}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${item.status === 'DONE' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{item.status === 'DONE' ? 'Feito' : 'A fazer'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default HubStudentDesk;
