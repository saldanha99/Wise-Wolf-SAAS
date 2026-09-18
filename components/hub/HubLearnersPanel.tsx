import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, CircleCheck, Copy, Link2, MessageCircle, Plus, RefreshCw, Send, UserPlus, Users, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { HUB_MARKETING_ORIGIN } from './hubRoutes';
import type { HubBootstrap } from './types';

// Meus alunos: os assentos do plano. O professor cria o perfil do aluno, gera
// um link de convite (14 dias) e manda pelo WhatsApp; quando o aluno entra, o
// professor atribui materiais e acompanha o que foi feito. Tudo passa por RPC —
// a tabela de perfis de aluno não tem leitura direta.

interface HubLearnersPanelProps {
  bootstrap: HubBootstrap;
}

export interface HubLearnerSeat {
  id: string;
  display_name: string;
  level_tag: string | null;
  objective: string | null;
  seat: 'ACTIVE' | 'INVITED' | 'NONE';
  invite_token: string | null;
  invite_expires_at: string | null;
  joined_at: string | null;
  assignments: Array<{ id: string; material_id: string; title: string; kind: string; status: 'ASSIGNED' | 'DONE'; note: string; student_note: string; done_at: string | null; created_at: string }>;
}

interface MaterialOption { id: string; title: string; kind: string; level_tag: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const hubInviteUrl = (token: string) => `${HUB_MARKETING_ORIGIN}/?convite=${token}`;

export const hubInviteWhatsAppUrl = (learnerName: string, teacherName: string, token: string) =>
  `https://wa.me/?text=${encodeURIComponent(`Oi, ${learnerName.split(' ')[0]}! Reservei o seu lugar na minha plataforma de aulas. Entre por aqui para receber seus materiais e sua jornada: ${hubInviteUrl(token)} — ${teacherName}`)}`;

const parseSeats = (payload: unknown): HubLearnerSeat[] => (Array.isArray(payload) ? payload : []).flatMap((item): HubLearnerSeat[] => {
  if (!isRecord(item) || typeof item.id !== 'string') return [];
  return [{
    id: item.id,
    display_name: String(item.display_name || ''),
    level_tag: typeof item.level_tag === 'string' ? item.level_tag : null,
    objective: typeof item.objective === 'string' ? item.objective : null,
    seat: item.seat === 'ACTIVE' ? 'ACTIVE' : item.seat === 'INVITED' ? 'INVITED' : 'NONE',
    invite_token: typeof item.invite_token === 'string' ? item.invite_token : null,
    invite_expires_at: typeof item.invite_expires_at === 'string' ? item.invite_expires_at : null,
    joined_at: typeof item.joined_at === 'string' ? item.joined_at : null,
    assignments: (Array.isArray(item.assignments) ? item.assignments : []).flatMap((assignment) => isRecord(assignment) && typeof assignment.id === 'string'
      ? [{
        id: assignment.id,
        material_id: String(assignment.material_id || ''),
        title: String(assignment.title || ''),
        kind: String(assignment.kind || ''),
        status: assignment.status === 'DONE' ? 'DONE' as const : 'ASSIGNED' as const,
        note: String(assignment.note || ''),
        student_note: String(assignment.student_note || ''),
        done_at: typeof assignment.done_at === 'string' ? assignment.done_at : null,
        created_at: String(assignment.created_at || ''),
      }]
      : []),
  }];
});

const INVITE_ERRORS: Record<string, string> = {
  SEATS_EXHAUSTED: 'Todos os assentos do seu plano estão ocupados. Libere um ou veja um plano com mais alunos.',
  LEARNER_ALREADY_JOINED: 'Este aluno já está dentro.',
};

const HubLearnersPanel: React.FC<HubLearnersPanelProps> = ({ bootstrap }) => {
  const teacherName = bootstrap.memberProfile?.display_name || bootstrap.account.name;
  const [seats, setSeats] = useState<HubLearnerSeat[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number | null }>({ used: 0, limit: 0 });
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<{ learnerId: string; materialId: string; note: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('A2');
  const [newObjective, setNewObjective] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [seatsResult, usageResult, materialsResult] = await Promise.all([
      supabase.rpc('hub_list_learner_seats', { p_account_id: bootstrap.account.id }),
      supabase.rpc('hub_learner_seats', { p_account_id: bootstrap.account.id }),
      supabase.from('hub_educator_materials').select('id,title,kind,level_tag').eq('account_id', bootstrap.account.id).order('created_at', { ascending: false }).limit(50),
    ]);
    setLoading(false);
    if (seatsResult.error) {
      setError('Não foi possível carregar seus alunos.');
      return;
    }
    setError('');
    setSeats(parseSeats(seatsResult.data));
    const usagePayload = isRecord(usageResult.data) ? usageResult.data : {};
    setUsage({ used: Number(usagePayload.used || 0), limit: usagePayload.limit === null || usagePayload.limit === undefined ? null : Number(usagePayload.limit) });
    setMaterials(((materialsResult.data || []) as unknown[]).flatMap((row) => isRecord(row) && typeof row.id === 'string'
      ? [{ id: row.id, title: String(row.title || ''), kind: String(row.kind || ''), level_tag: String(row.level_tag || '') }]
      : []));
  }, [bootstrap.account.id]);

  useEffect(() => { void load(); }, [load]);

  const seatsLabel = useMemo(() => usage.limit === null ? `${usage.used} alunos · sem limite` : `${usage.used} de ${usage.limit} assentos usados`, [usage]);

  const invite = async (learner: HubLearnerSeat) => {
    setBusy(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('hub_invite_learner', { p_account_id: bootstrap.account.id, p_learner_id: learner.id });
    setBusy(false);
    const payload = isRecord(data) ? data : null;
    if (rpcError || !payload) {
      setError('Não foi possível gerar o convite agora.');
      return;
    }
    if (payload.ok !== true) {
      setError(INVITE_ERRORS[String(payload.code)] || 'Não foi possível gerar o convite.');
      return;
    }
    await load();
  };

  const copyLink = async (learner: HubLearnerSeat) => {
    if (!learner.invite_token) return;
    try {
      await navigator.clipboard.writeText(hubInviteUrl(learner.invite_token));
      setCopiedId(learner.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError('Não foi possível copiar. Use o botão do WhatsApp.');
    }
  };

  const assign = async () => {
    if (!assigning || !assigning.materialId) return;
    setBusy(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('hub_assign_material', {
      p_account_id: bootstrap.account.id,
      p_learner_id: assigning.learnerId,
      p_material_id: assigning.materialId,
      p_note: assigning.note.trim(),
    });
    setBusy(false);
    if (rpcError || !isRecord(data) || data.ok !== true) {
      setError('Não foi possível enviar o material.');
      return;
    }
    setAssigning(null);
    await load();
  };

  const createLearner = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newName.trim().length < 2) {
      setError('Informe o nome do aluno.');
      return;
    }
    setBusy(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('hub_create_educator_learner', {
      p_account_id: bootstrap.account.id,
      p_name: newName.trim(),
      p_level: newLevel,
      p_objective: newObjective.trim() || null,
      p_interests: [],
      p_notes: null,
    });
    setBusy(false);
    if (rpcError) {
      setError('Não foi possível criar o perfil do aluno.');
      return;
    }
    setNewName('');
    setNewObjective('');
    setCreating(false);
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-4 rounded-3xl border border-brand-border bg-brand-surface p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary"><Users className="mr-1 inline" size={12} />Meus alunos</p>
          <p className="mt-1 text-sm font-bold text-brand-text">Cada aluno entra no seu ambiente pelo link de convite e recebe os materiais que você enviar — sem gabarito.</p>
          <p className="mt-1 text-xs text-brand-muted" data-testid="hub-seats-usage">{seatsLabel}</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-4 py-3 text-xs font-black text-white"><Plus size={16} /> Novo aluno</button>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}

      {loading ? (
        <div role="status" className="flex min-h-40 items-center justify-center gap-3 text-sm font-bold text-brand-muted"><RefreshCw className="animate-spin text-tenant-primary" size={18} /> Carregando alunos...</div>
      ) : seats.length === 0 ? (
        <p className="rounded-[2rem] border border-brand-border bg-brand-surface p-6 text-sm text-brand-muted">Crie o primeiro perfil de aluno. Depois, gere o convite e mande pelo WhatsApp.</p>
      ) : (
        <ul className="space-y-3">
          {seats.map((learner) => (
            <li key={learner.id} className="rounded-[2rem] border border-brand-border bg-brand-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-base font-black text-brand-text">{learner.display_name} {learner.level_tag && <span className="ml-1 rounded-full bg-brand-surface-2 px-2 py-0.5 text-[10px] font-black text-brand-muted">{learner.level_tag}</span>}</p>
                  {learner.objective && <p className="text-xs text-brand-muted">{learner.objective}</p>}
                </div>
                <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${learner.seat === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : learner.seat === 'INVITED' ? 'bg-amber-100 text-amber-800' : 'bg-brand-surface-2 text-brand-muted'}`}>
                  {learner.seat === 'ACTIVE' ? 'Dentro da plataforma' : learner.seat === 'INVITED' ? 'Convite enviado' : 'Sem convite'}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {learner.seat !== 'ACTIVE' && (
                  <button type="button" disabled={busy} onClick={() => void invite(learner)} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-2.5 text-xs font-black text-brand-text disabled:opacity-60"><Link2 size={15} />{learner.seat === 'INVITED' ? 'Gerar novo link' : 'Gerar link de convite'}</button>
                )}
                {learner.seat === 'INVITED' && learner.invite_token && (
                  <>
                    <button type="button" onClick={() => void copyLink(learner)} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-2.5 text-xs font-black text-brand-text">{copiedId === learner.id ? <Check size={15} /> : <Copy size={15} />}{copiedId === learner.id ? 'Copiado' : 'Copiar link'}</button>
                    <a href={hubInviteWhatsAppUrl(learner.display_name, teacherName, learner.invite_token)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2.5 text-xs font-black text-white"><MessageCircle size={15} />Mandar pelo WhatsApp</a>
                  </>
                )}
                {learner.seat === 'ACTIVE' && (
                  <button type="button" onClick={() => setAssigning({ learnerId: learner.id, materialId: materials[0]?.id || '', note: '' })} className="inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-4 py-2.5 text-xs font-black text-white"><Send size={15} />Enviar material</button>
                )}
              </div>
              {learner.seat === 'INVITED' && learner.invite_expires_at && <p className="mt-2 text-xs text-brand-muted">Link válido até {new Date(learner.invite_expires_at).toLocaleDateString('pt-BR')}.</p>}

              {learner.assignments.length > 0 && (
                <ul className="mt-4 divide-y divide-brand-border rounded-2xl border border-brand-border">
                  {learner.assignments.map((assignment) => (
                    <li key={assignment.id} className="flex items-start gap-3 p-3">
                      <span className={`mt-0.5 shrink-0 ${assignment.status === 'DONE' ? 'text-emerald-600' : 'text-amber-500'}`}>{assignment.status === 'DONE' ? <CircleCheck size={16} /> : <Send size={16} />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-brand-text">{assignment.title}</span>
                        <span className="block text-xs text-brand-muted">{assignment.status === 'DONE' ? `Feito${assignment.done_at ? ` em ${new Date(assignment.done_at).toLocaleDateString('pt-BR')}` : ''}${assignment.student_note ? ` · “${assignment.student_note}”` : ''}` : `Enviado em ${new Date(assignment.created_at).toLocaleDateString('pt-BR')}${assignment.note ? ` · ${assignment.note}` : ''}`}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {assigning && (
        <div className="fixed inset-0 z-[150] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="hub-assign-title">
          <div className="w-full max-w-lg rounded-[2rem] border border-brand-border bg-brand-surface p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <h2 id="hub-assign-title" className="text-xl font-black text-brand-text">Enviar material</h2>
              <button type="button" onClick={() => setAssigning(null)} className="grid size-10 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label="Fechar"><X size={18} /></button>
            </div>
            {materials.length === 0 ? (
              <p className="mt-4 text-sm text-brand-muted">Você ainda não gerou material. Gere um em “Gerar material” e volte aqui.</p>
            ) : (
              <>
                <label className="mt-4 block"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Material</span>
                  <select value={assigning.materialId} onChange={(event) => setAssigning({ ...assigning, materialId: event.target.value })} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">
                    {materials.map((material) => <option key={material.id} value={material.id}>{material.title} · {material.level_tag}</option>)}
                  </select>
                </label>
                <label className="mt-3 block"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Recado (opcional)</span>
                  <input value={assigning.note} onChange={(event) => setAssigning({ ...assigning, note: event.target.value })} maxLength={600} placeholder="Ex.: faça até quinta e traga as dúvidas" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" />
                </label>
                <button type="button" disabled={busy || !assigning.materialId} onClick={() => void assign()} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-3.5 text-sm font-black text-white disabled:opacity-60"><Send size={16} />{busy ? 'Enviando...' : 'Enviar para o aluno'}</button>
              </>
            )}
          </div>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-[150] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="hub-new-learner-title">
          <form onSubmit={createLearner} className="w-full max-w-lg rounded-[2rem] border border-brand-border bg-brand-surface p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <h2 id="hub-new-learner-title" className="text-xl font-black text-brand-text"><UserPlus className="mr-2 inline" size={20} />Novo aluno</h2>
              <button type="button" onClick={() => setCreating(false)} className="grid size-10 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label="Fechar"><X size={18} /></button>
            </div>
            <label className="mt-4 block"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nome</span>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none" autoFocus />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nível</span>
                <select value={newLevel} onChange={(event) => setNewLevel(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none">{['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((level) => <option key={level}>{level}</option>)}</select>
              </label>
              <label className="sm:col-span-2"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Objetivo</span>
                <input value={newObjective} onChange={(event) => setNewObjective(event.target.value)} maxLength={800} placeholder="Ex.: entrevista em inglês em 3 meses" className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none" />
              </label>
            </div>
            <button disabled={busy} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-3.5 text-sm font-black text-white disabled:opacity-60"><UserPlus size={16} />{busy ? 'Criando...' : 'Criar perfil do aluno'}</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default HubLearnersPanel;
