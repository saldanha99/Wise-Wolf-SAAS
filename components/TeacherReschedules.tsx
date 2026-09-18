import React, { useEffect, useState } from 'react';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { describeRescheduleEvent, hasSlot, isSoon, reasonRequired, type RescheduleEventRow } from '../lib/rescheduleRules';
import {
    Repeat,
    Settings,
    Filter,
    Search,
    Calendar,
    X,
    User,
    Clock,
    Save,
    Bell,
    AlertTriangle,
    History,
    CalendarX
} from 'lucide-react';
import { Reschedule } from '../types';

interface TeacherReschedulesProps {
    reschedules?: Reschedule[];
    students?: { id: string; name: string; module: string; }[];
    onAdd?: (data: any) => void;
    /** Volta a reposição para "Pendente" com motivo (RPC unschedule_reschedule). */
    onUnschedule?: (id: string, reason: string) => Promise<void> | void;
}

const TeacherReschedules: React.FC<TeacherReschedulesProps> = ({ reschedules = [], students = [], onAdd, onUnschedule }) => {
    const [activeTab, setActiveTab] = useState('schedule');
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | number | null>(null);
    const [formData, setFormData] = useState({
        studentId: '',
        date: '',
        time: '',
        reason: ''
    });
    // Trilha: o último evento de cada reposição (marcada/remarcada/desmarcada…),
    // gravado pelo servidor venha de onde vier a mudança. Sem isso a direção
    // não sabia quando nem por que uma reposição mudou de horário.
    const [lastEvents, setLastEvents] = useState<Record<string, RescheduleEventRow>>({});
    const [historyOf, setHistoryOf] = useState<string | null>(null);
    const [history, setHistory] = useState<RescheduleEventRow[]>([]);

    useEffect(() => {
        const ids = reschedules.map(r => String(r.id)).filter(Boolean);
        if (ids.length === 0) { setLastEvents({}); return; }
        let cancelled = false;
        (async () => {
            const { data } = await supabase
                .from('reschedule_events')
                .select('id, reschedule_id, action, from_date, from_time, to_date, to_time, source, reason, em_cima_da_hora, created_at')
                .in('reschedule_id', ids)
                .neq('action', 'criada')
                .order('created_at', { ascending: false });
            if (cancelled) return;
            const latest: Record<string, RescheduleEventRow> = {};
            for (const row of (data || []) as RescheduleEventRow[]) {
                if (!latest[row.reschedule_id]) latest[row.reschedule_id] = row;
            }
            setLastEvents(latest);
        })();
        return () => { cancelled = true; };
    }, [reschedules]);

    const openHistory = async (id: string) => {
        setHistoryOf(id);
        const { data } = await supabase
            .from('reschedule_events')
            .select('id, reschedule_id, action, from_date, from_time, to_date, to_time, source, reason, em_cima_da_hora, created_at')
            .eq('reschedule_id', id)
            .order('created_at', { ascending: false });
        setHistory((data || []) as RescheduleEventRow[]);
    };

    const handleUnschedule = async (item: any) => {
        if (!onUnschedule) return;
        const reason = window.prompt(`Desmarcar a reposição de ${item.studentName} (${item.date} ${item.time})?\n\nA coordenação e a família são avisadas. Motivo:`);
        if (reason === null) return;
        if (reason.trim().length < 3) { alert('Escreva o motivo (mínimo 3 letras).'); return; }
        await onUnschedule(String(item.id), reason.trim());
    };

    const tabs = [
        { id: 'schedule', label: 'Agendar Reposição' },
        { id: 'form', label: 'Formulário Reposição' },
    ];

    const filteredReschedules = reschedules.filter(r =>
        r.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.date.includes(searchTerm)
    );

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // A origem financeira da reposição nasce somente do lançamento da
        // falta. Esta tela agenda um crédito existente; nunca cria outro.
        if (onAdd && editingId !== null) {
            const current = reschedules.find(r => String(r.id) === String(editingId));
            const needsReason = reasonRequired({ date: current?.date, time: current?.time }, { date: formData.date, time: formData.time });
            if (needsReason && formData.reason.trim().length < 3) {
                alert('Remarcar exige um motivo (mínimo 3 letras). Ele vai para a coordenação e para a família.');
                return;
            }
            onAdd({
                id: editingId,
                studentId: formData.studentId,
                date: formData.date,
                time: formData.time,
                reason: formData.reason.trim() || null
            });
            setIsModalOpen(false);
            setFormData({ studentId: '', date: '', time: '', reason: '' });
            setEditingId(null);
        }
    };

    const handleEdit = (item: any) => {
        setFormData({
            studentId: item.studentId || '',
            date: item.date === 'Pendente' ? '' : item.date,
            time: item.time === 'Pendente' ? '' : item.time,
            reason: ''
        });
        setEditingId(item.id);
        setIsModalOpen(true);
    };

    const editingItem = editingId === null ? null : reschedules.find(r => String(r.id) === String(editingId));
    const editingHadSlot = !!editingItem && hasSlot(editingItem.date, editingItem.time);
    const editingNeedsReason = !!editingItem && formData.date !== '' && formData.time !== ''
        && reasonRequired({ date: editingItem.date, time: editingItem.time }, { date: formData.date, time: formData.time });
    const editingSoon = (!!editingItem && isSoon(editingItem.date, editingItem.time)) || (formData.date !== '' && formData.time !== '' && isSoon(formData.date, formData.time));

    const handleNotify = async (item: any) => {
        if (!confirm(`Enviar notificação de reposição para ${item.studentName}?`)) return;

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('Sessão expirada. Entre novamente.');

            const response = await fetch(`${FUNCTIONS_URL}/send-class-notification`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    action: 'RESCHEDULE_SCHEDULED',
                    source_id: item.id,
                    source_type: 'RESCHEDULE',
                    class_date: item.date,
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result?.error) {
                throw new Error(result?.error || `status_${response.status}`);
            }
            if (
                result?.delivery !== 'accepted' ||
                typeof result?.provider_message_id !== 'string' ||
                !result.provider_message_id.trim()
            ) {
                throw new Error('delivery_not_confirmed');
            }
            alert("Notificação enviada com sucesso!");

        } catch (error) {
            console.error(error);
            alert("Erro ao enviar notificação.");
        }
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <h2 className="text-2xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-tight flex items-center gap-3">
                    Reposições
                </h2>
            </div>

            <div className="bg-brand-surface rounded-[2rem] border border-brand-border shadow-[0_8px_30px_rgba(0,0,0,0.12)] overflow-hidden">
                {/* Tabs */}
                <div className="border-b border-brand-border bg-brand-surface-2/50 px-6 pt-4 flex gap-6 overflow-x-auto custom-scrollbar">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`pb-4 text-xs font-bold uppercase tracking-wide transition-colors relative whitespace-nowrap ${activeTab === tab.id
                                ? 'text-brand-accent'
                                : 'text-brand-muted hover:text-brand-text'
                                }`}
                        >
                            {tab.label}
                            {activeTab === tab.id && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-accent rounded-t-full shadow-[0_0_8px_rgba(var(--brand-accent),0.8)]" />
                            )}
                        </button>
                    ))}
                </div>

                <div className="p-6 space-y-6">
                    {activeTab === 'schedule' ? (
                        <>
                            {/* Actions Bar */}
                            <div className="flex flex-col md:flex-row md:items-center md:justify-end gap-4">
                                <div className="relative w-full md:w-64">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={14} />
                                    <input
                                        type="text"
                                        placeholder="Buscar..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2.5 bg-brand-bg border border-brand-border rounded-xl text-xs outline-none focus:ring-2 focus:ring-brand-accent/20 focus:border-brand-accent text-brand-text placeholder:text-brand-muted transition-all"
                                    />
                                </div>
                            </div>

                            {/* Table */}
                            <div className="overflow-x-auto rounded-xl border border-brand-border custom-scrollbar">
                                <table className="w-full text-left border-collapse min-w-[500px]">
                                    <thead>
                                        <tr className="bg-brand-surface-2 border-b border-brand-border">
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider w-24 text-center">
                                                Ações
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-brand-text">
                                                    Agendamento <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-brand-text">
                                                    Teacher <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-brand-text">
                                                    Student <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-brand-text">
                                                    Origem <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-brand-muted tracking-wider">
                                                Status
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-brand-border bg-brand-bg/30">
                                        {filteredReschedules.map((item) => (
                                            <tr key={item.id} className="hover:bg-brand-surface-2 transition-colors">
                                                <td className="p-4 flex items-center gap-2 justify-center">
                                                    <button
                                                        onClick={() => handleEdit(item)}
                                                        className="p-1.5 text-blue-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors border border-transparent hover:border-blue-500/30"
                                                        title={item.date === 'Pendente' ? 'Marcar data e hora' : 'Remarcar (pede motivo)'}
                                                    >
                                                        <Settings size={14} />
                                                    </button>
                                                    <button
                                                        onClick={() => openHistory(String(item.id))}
                                                        className="p-1.5 text-brand-muted hover:text-brand-text hover:bg-brand-surface-2 rounded-lg transition-colors border border-transparent hover:border-brand-border"
                                                        title="Histórico desta reposição"
                                                        data-tour="reschedule-history"
                                                    >
                                                        <History size={14} />
                                                    </button>
                                                    {item.date !== 'Pendente' && onUnschedule && (
                                                        <button
                                                            onClick={() => handleUnschedule(item)}
                                                            className="p-1.5 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/30"
                                                            title="Desmarcar (pede motivo; coordenação e família são avisadas)"
                                                        >
                                                            <CalendarX size={14} />
                                                        </button>
                                                    )}
                                                    {item.date !== 'Pendente' && (
                                                        <button
                                                            onClick={() => handleNotify(item)}
                                                            className="p-1.5 text-amber-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors border border-transparent hover:border-amber-500/30"
                                                            title="Notificar Aluno via WhatsApp"
                                                        >
                                                            <Bell size={14} />
                                                        </button>
                                                    )}
                                                </td>
                                                <td className="p-4 text-xs font-bold">
                                                    {item.date === 'Pendente' ? (
                                                        <span className="flex items-center gap-2 text-amber-500 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded w-fit uppercase">
                                                            <Clock size={12} /> Aguardando Data
                                                        </span>
                                                    ) : (
                                                        <span className="text-brand-text font-black whitespace-nowrap">
                                                            {item.date} às {item.time}
                                                            {isSoon(item.date, item.time) && (
                                                                <span className="ml-2 inline-flex items-center gap-1 text-[9px] font-black uppercase text-amber-600 dark:text-amber-400" title="Começa em menos de 3 horas">
                                                                    <AlertTriangle size={10} /> em breve
                                                                </span>
                                                            )}
                                                        </span>
                                                    )}
                                                    {lastEvents[String(item.id)] && (
                                                        <p className="mt-1 text-[10px] font-medium text-brand-muted normal-case max-w-[260px] truncate" title={describeRescheduleEvent(lastEvents[String(item.id)])}>
                                                            {describeRescheduleEvent(lastEvents[String(item.id)])}
                                                        </p>
                                                    )}
                                                </td>
                                                <td className="p-4 text-xs font-medium text-brand-muted max-w-[150px] truncate">
                                                    {item.teacherName}
                                                </td>
                                                <td className="p-4 text-xs font-medium text-brand-muted">
                                                    <span className="font-black text-brand-text uppercase">{item.studentName}</span>
                                                </td>
                                                <td className="p-4 text-xs font-medium text-brand-muted text-[10px] tracking-widest font-black uppercase">
                                                    {item.repoId > 0 ? 'CRÉDITO' : 'AGENDADA'}
                                                </td>
                                                <td className="p-4">
                                                    {item.date === 'Pendente' ? (
                                                        <button
                                                            onClick={() => handleEdit(item)}
                                                            className="text-[10px] font-black uppercase text-brand-accent hover:underline"
                                                        >
                                                            Agendar Agora
                                                        </button>
                                                    ) : (
                                                        <span className="text-[10px] font-black text-emerald-500 uppercase flex items-center gap-1">
                                                            Confirmada
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                        {filteredReschedules.length === 0 && (
                                            <tr>
                                                <td colSpan={6} className="p-12 text-center text-brand-muted text-xs font-black uppercase tracking-[0.2em] opacity-50">
                                                    Nenhuma reposição encontrada
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-brand-muted">
                            <Calendar size={64} strokeWidth={1} className="mb-4 text-brand-accent drop-shadow-[0_0_10px_rgba(var(--brand-accent),0.4)]" />
                            <p className="text-sm font-black uppercase tracking-widest text-brand-text">Formulário de Detalhes</p>
                            <p className="text-xs font-medium mt-1">Recurso em desenvolvimento para relatórios avançados.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Add/Edit Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
                    <div className="bg-brand-surface w-full max-w-md rounded-[3rem] shadow-[0_8px_40px_rgba(0,0,0,0.5)] border border-brand-border overflow-hidden flex flex-col transform animate-in zoom-in-95 duration-300 max-h-[90dvh]">
                        <div className="p-8 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
                            <div>
                                <h3 className="text-xl font-black text-brand-text flex items-center gap-2 uppercase tracking-tight">
                                    <Repeat size={24} className="text-brand-accent drop-shadow-[0_0_8px_rgba(var(--brand-accent),0.6)]" /> Editar Reposição
                                </h3>
                                <p className="text-xs text-brand-muted font-medium mt-0.5">Defina a nova data e horário para a aula.</p>
                            </div>
                            <button
                                onClick={() => {
                                    setIsModalOpen(false);
                                    setEditingId(null);
                                }}
                                className="p-3 hover:bg-brand-bg rounded-2xl transition-all"
                            >
                                <X size={20} className="text-brand-muted" />
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-6 overflow-y-auto">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-muted flex items-center gap-2 ml-1">
                                    <User size={12} className="text-brand-accent" /> Aluno Selecionado
                                </label>
                                {/* Aluno e origem são imutáveis: apenas data/hora podem mudar. */}
                                <select
                                    required
                                    value={formData.studentId}
                                    className="w-full px-5 py-4 bg-brand-bg border border-brand-border rounded-[1.25rem] text-sm font-bold text-brand-text focus:ring-4 focus:ring-brand-accent/20 focus:border-brand-accent outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled
                                >
                                    <option value="">Selecione um aluno...</option>
                                    {students.map(student => (
                                        <option key={student.id} value={student.id}>
                                            {student.name}{student.module && student.module !== 'N/A' ? ` (${student.module})` : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-muted flex items-center gap-2 ml-1">
                                        <Calendar size={12} className="text-brand-accent" /> Data
                                    </label>
                                    <input
                                        type="date"
                                        required
                                        value={formData.date}
                                        onChange={e => setFormData({ ...formData, date: e.target.value })}
                                        className="w-full px-5 py-4 bg-brand-bg border border-brand-border rounded-[1.25rem] text-sm font-bold text-brand-text focus:ring-4 focus:ring-brand-accent/20 focus:border-brand-accent outline-none transition-all [color-scheme:dark]"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-muted flex items-center gap-2 ml-1">
                                        <Clock size={12} className="text-brand-accent" /> Horário
                                    </label>
                                    <input
                                        type="time"
                                        required
                                        value={formData.time}
                                        onChange={e => setFormData({ ...formData, time: e.target.value })}
                                        className="w-full px-5 py-4 bg-brand-bg border border-brand-border rounded-[1.25rem] text-sm font-bold text-brand-text focus:ring-4 focus:ring-brand-accent/20 focus:border-brand-accent outline-none transition-all [color-scheme:dark]"
                                    />
                                </div>
                            </div>

                            {/* Remarcação pede motivo: é o que a direção não tinha. A coordenação e a família recebem o aviso. */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-muted flex items-center gap-2 ml-1">
                                    <Repeat size={12} className="text-brand-accent" /> Motivo {editingNeedsReason ? '(obrigatório ao remarcar)' : '(opcional)'}
                                </label>
                                <input
                                    type="text"
                                    maxLength={300}
                                    required={editingNeedsReason}
                                    value={formData.reason}
                                    onChange={e => setFormData({ ...formData, reason: e.target.value })}
                                    placeholder={editingHadSlot ? 'Ex.: aluno pediu para segunda' : 'Ex.: combinado com a família pelo WhatsApp'}
                                    className="w-full px-5 py-4 bg-brand-bg border border-brand-border rounded-[1.25rem] text-sm font-bold text-brand-text focus:ring-4 focus:ring-brand-accent/20 focus:border-brand-accent outline-none transition-all placeholder:font-medium placeholder:text-brand-muted"
                                />
                                {editingSoon && (
                                    <p className="flex items-center gap-2 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                                        <AlertTriangle size={12} /> Em cima da hora (menos de 3 h): pode, mas sai destacado para a coordenação.
                                    </p>
                                )}
                                <p className="text-[10px] font-medium text-brand-muted">A coordenação e a família são avisadas automaticamente.</p>
                            </div>

                            <button
                                type="submit"
                                className="w-full bg-brand-accent text-white py-5 rounded-[1.5rem] font-black text-[11px] uppercase tracking-[0.2em] hover:bg-brand-accent-hover hover:scale-[1.02] active:scale-[0.98] transition-all shadow-[0_0_15px_rgba(var(--brand-accent),0.4)] flex items-center justify-center gap-3 mt-4"
                            >
                                <Save size={18} /> Salvar Alterações
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Histórico da reposição: cada marcação/remarcação/desmarcação, com origem e motivo. */}
            {historyOf && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-200" onClick={() => setHistoryOf(null)}>
                    <div className="bg-brand-surface w-full max-w-lg rounded-[2rem] border border-brand-border shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="p-6 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
                            <h3 className="text-sm font-black text-brand-text uppercase tracking-tight flex items-center gap-2"><History size={16} className="text-brand-accent" /> Histórico da reposição</h3>
                            <button onClick={() => setHistoryOf(null)} className="p-2 hover:bg-brand-bg rounded-xl"><X size={16} className="text-brand-muted" /></button>
                        </div>
                        <ul className="p-6 space-y-3 max-h-[60vh] overflow-y-auto">
                            {history.length === 0 && <li className="text-xs text-brand-muted font-medium">Nenhuma mudança registrada ainda.</li>}
                            {history.map(e => (
                                <li key={e.id} className="text-xs text-brand-text">
                                    <span className="block text-[10px] font-black uppercase tracking-wider text-brand-muted">{new Date(e.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                                    <span className="font-medium">{describeRescheduleEvent(e)}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherReschedules;
