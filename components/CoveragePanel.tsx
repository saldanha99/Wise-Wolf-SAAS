import React, { useEffect, useMemo, useState } from 'react';
import { CalendarOff, Loader2, Search, UserCheck, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import AbsenceCoverageManager from './AbsenceCoverageManager';

// Cobertura de professor em tela própria.
//
// O mecanismo já existia (AbsenceCoverageManager), mas estava escondido atrás de
// um botão no card do professor, dentro de Professores — na prática ninguém usava.
// O efeito colateral disso é caro: quando o professor A não pode dar a aula e o B
// cobre, sem passar por aqui a aula continua lançada no A, e a folha paga o
// professor errado. Foi o que aconteceu com o João Pedro em julho/2026.

interface Props {
    user: User;
    tenantId?: string;
}

interface TeacherRow {
    id: string;
    full_name: string;
    alunos: number;
}

const CoveragePanel: React.FC<Props> = ({ tenantId }) => {
    const [teachers, setTeachers] = useState<TeacherRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const { data: profs } = await supabase
                    .from('profiles')
                    .select('id, full_name, lifecycle_status')
                    .eq('role', 'TEACHER')
                    .eq('tenant_id', tenantId || '');

                const { data: bookings } = await supabase
                    .from('bookings')
                    .select('teacher_id, student_id')
                    .eq('tenant_id', tenantId || '');

                const porProf = new Map<string, Set<string>>();
                (bookings || []).forEach((b: any) => {
                    if (!b.teacher_id || !b.student_id) return;
                    if (!porProf.has(b.teacher_id)) porProf.set(b.teacher_id, new Set());
                    porProf.get(b.teacher_id)!.add(b.student_id);
                });

                setTeachers((profs || [])
                    .filter((p: any) => p.lifecycle_status !== 'offboarded')
                    .map((p: any) => ({
                        id: p.id,
                        full_name: p.full_name || 'Sem nome',
                        alunos: porProf.get(p.id)?.size || 0,
                    }))
                    .sort((a, b) => b.alunos - a.alunos));
            } finally {
                setLoading(false);
            }
        })();
    }, [tenantId]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return q ? teachers.filter(t => t.full_name.toLowerCase().includes(q)) : teachers;
    }, [teachers, search]);

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="rounded-[2rem] border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-6">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 rounded-xl bg-amber-100 p-2.5 text-amber-600">
                        <CalendarOff size={22} />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-2xl font-black tracking-tight text-brand-text">Cobertura de Professor</h2>
                        <p className="text-sm font-medium text-brand-muted">
                            O professor não pode dar as aulas de um período? Registre aqui: o sistema lista as
                            aulas afetadas e sugere quem tem horário livre para cobrir.
                        </p>
                    </div>
                </div>

                <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
                    <p className="text-xs font-medium leading-relaxed text-amber-800">
                        <strong>Use sempre este caminho quando um professor cobrir outro.</strong> Se a troca não
                        passar por aqui, a aula continua lançada no professor original e o fechamento paga
                        quem não deu a aula — o substituto fica sem receber.
                    </p>
                </div>
            </div>

            <div className="overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-sm">
                <div className="flex flex-col gap-3 border-b border-brand-border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                    <h3 className="text-xs font-black uppercase tracking-widest text-brand-text">
                        Escolha quem vai faltar
                    </h3>
                    <div className="relative w-full sm:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={14} />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Buscar professor..."
                            aria-label="Buscar professor"
                            className="w-full rounded-xl border border-brand-border bg-brand-surface-2 py-2.5 pl-9 pr-4 text-xs font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                        />
                    </div>
                </div>

                {loading ? (
                    <div className="flex justify-center py-16"><Loader2 className="animate-spin text-brand-muted" /></div>
                ) : filtered.length === 0 ? (
                    <p className="py-16 text-center text-sm font-bold uppercase tracking-widest text-brand-muted">
                        Nenhum professor encontrado.
                    </p>
                ) : (
                    <ul className="divide-y divide-brand-border">
                        {filtered.map((t) => (
                            <li key={t.id}>
                                <button
                                    type="button"
                                    onClick={() => setSelected({ id: t.id, name: t.full_name })}
                                    className="flex w-full items-center justify-between gap-4 p-5 text-left transition-colors hover:bg-brand-surface-2/60 sm:px-6"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-black uppercase text-brand-text">{t.full_name}</p>
                                        <p className="text-xs font-medium text-brand-muted">
                                            {t.alunos} aluno{t.alunos === 1 ? '' : 's'} na agenda
                                        </p>
                                    </div>
                                    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-tenant-primary/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-tenant-primary">
                                        <UserCheck size={13} /> Organizar cobertura
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {selected && (
                <AbsenceCoverageManager
                    teacher={{ id: selected.id, name: selected.name }}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
};

export default CoveragePanel;
