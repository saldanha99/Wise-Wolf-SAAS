import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { X, CalendarClock, FileText, ShieldAlert, Flame, AlertTriangle, BellRing } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL DE AVISOS DO PROFESSOR (funil pós-contratação)
// Pop-up diário no dashboard com as responsabilidades que ele precisa exercer:
//   • aulas sem lançar          → lançar no dia (fechamento + antifraude dependem disso)
//   • nota fiscal pendente      → NFS-e do CNPJ dele após receber o repasse
//   • conflito de presença      → responder a coordenação p/ liberar pagamento
//   • agenda desatualizada      → disponibilidade correta = mais alunos, zero conflito
//   • status do turbo           → reforço de assiduidade (ativo: não pode faltar)
// Mostra no máximo 1x por dia (localStorage). Falha de qualquer consulta não quebra
// o dashboard — o aviso simplesmente não aparece.
// ─────────────────────────────────────────────────────────────────────────────

interface Nudge {
    id: string;
    icon: React.ReactNode;
    title: string;
    text: string;
    tone: 'red' | 'amber' | 'blue' | 'emerald';
    cta?: { label: string; tab: string };
}

interface Props {
    userId: string;
    pendingLessons?: number;
    onNavigate?: (tab: string) => void;
}

const TeacherNudges: React.FC<Props> = ({ userId, pendingLessons = 0, onNavigate }) => {
    const [nudges, setNudges] = useState<Nudge[]>([]);
    const [open, setOpen] = useState(false);
    const todayKey = `ww_nudges_${new Date().toISOString().slice(0, 10)}_${userId}`;

    useEffect(() => {
        (async () => {
            try {
                const found: Nudge[] = [];

                // 1. Aulas sem lançar (contagem vem do App)
                if (pendingLessons > 0) {
                    found.push({
                        id: 'pending', tone: 'red', icon: <AlertTriangle size={18} />,
                        title: `${pendingLessons} aula(s) sem lançar`,
                        text: 'Lance no mesmo dia: aula não lançada não entra no seu fechamento e trava a confirmação de presença do aluno.',
                        cta: { label: 'Lançar agora', tab: 'pending' },
                    });
                }

                // 2. Nota fiscal pendente (fechamento pago sem NF) — professor isento não vê
                const { data: prof } = await supabase
                    .from('profiles')
                    .select('nf_exempt')
                    .eq('id', userId)
                    .maybeSingle();
                const { data: closings } = await supabase
                    .from('teacher_closings')
                    .select('id, month_year, total_amount, status, nf_link')
                    .eq('teacher_id', userId)
                    .in('status', ['PAID_WAITING_NF', 'REJECTED', 'REJEITADO']);
                const semNf = prof?.nf_exempt ? [] : (closings || []).filter(c => !c.nf_link && Number(c.total_amount) > 0);
                if (semNf.length) {
                    found.push({
                        id: 'nf', tone: 'amber', icon: <FileText size={18} />,
                        title: `Nota fiscal pendente: ${semNf.map(c => c.month_year).join(', ')}`,
                        text: 'Você já recebeu esses fechamentos — emita a NFS-e do seu CNPJ (gov.br/nfse ou app MEI) no valor pago e anexe o PDF aqui na plataforma.',
                        cta: { label: 'Enviar NF', tab: 'invoices' },
                    });
                }

                // 3. Conflito de presença aberto (antifraude)
                const { count: conf } = await supabase
                    .from('attendance_confirmations')
                    .select('id', { count: 'exact', head: true })
                    .eq('teacher_id', userId)
                    .eq('status', 'CONFLICT');
                if (conf && conf > 0) {
                    found.push({
                        id: 'conflict', tone: 'red', icon: <ShieldAlert size={18} />,
                        title: `${conf} aula(s) em análise por divergência com o aluno`,
                        text: 'A coordenação te chamou no WhatsApp — responda explicando o que houve. O pagamento dessas aulas fica retido até resolvermos juntos.',
                    });
                }

                // 4. Agenda/disponibilidade
                const { data: avail } = await supabase
                    .from('teacher_availability')
                    .select('created_at')
                    .eq('teacher_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(1);
                if (!avail?.length) {
                    found.push({
                        id: 'cal0', tone: 'blue', icon: <CalendarClock size={18} />,
                        title: 'Sua disponibilidade não está cadastrada',
                        text: 'Sem agenda cadastrada você não recebe novos alunos. Calendário atualizado é obrigação contratual e é o que faz sua carteira crescer.',
                        cta: { label: 'Atualizar agenda', tab: 'schedule' },
                    });
                } else if (Date.now() - new Date(avail[0].created_at).getTime() > 30 * 86400000) {
                    found.push({
                        id: 'cal30', tone: 'blue', icon: <CalendarClock size={18} />,
                        title: 'Sua disponibilidade tem 30+ dias sem revisão',
                        text: 'Confere se seus horários continuam valendo: agenda correta evita conflito de reposição e garante novos alunos pra você.',
                        cta: { label: 'Revisar agenda', tab: 'schedule' },
                    });
                }

                // 5. Turbo (assiduidade → remuneração progressiva)
                const { data: turbo } = await supabase.rpc('teacher_turbo_status', { p_teacher: userId });
                if (turbo) {
                    const studentsMissing = Number(turbo.students_missing || 0);
                    if (turbo.active) {
                        found.push({
                            id: 'turboOn', tone: 'emerald', icon: <Flame size={18} />,
                            title: 'Turbo ATIVO 🔥 — não pode faltar!',
                            text: 'Seus alunos do 5º ao 9º valem R$ 9,50 e do 10º em diante R$ 10,50 por aula. Uma falta OU um conflito de lançamento (aula que o aluno não confirmou) zera o turbo por 30 dias.',
                        });
                    } else if (studentsMissing > 0) {
                        // Regra 04/07/2026: turbo só ativa a partir de 10 alunos ativos
                        found.push({
                            id: 'turboLockedStudents', tone: 'amber', icon: <Flame size={18} />,
                            title: `Faltam ${studentsMissing} aluno${studentsMissing === 1 ? '' : 's'} para você poder ativar o turbo`,
                            text: `O turbo (R$ 9,50/10,50 por aula) destrava a partir de 10 alunos na sua agenda — hoje você tem ${Number(turbo.students_active || 0)}. Também é preciso 30 dias sem falta e sem conflito de lançamento.`,
                        });
                    } else if (Number(turbo.days_to_activate) > 0 && Number(turbo.days_clean) > 0) {
                        found.push({
                            id: 'turboOff', tone: 'amber', icon: <Flame size={18} />,
                            title: `Faltam ${turbo.days_to_activate} dias sem falta para destravar o turbo`,
                            text: 'Assiduidade paga: 30 dias sem falta e sem conflito de lançamento destravam R$ 9,50/10,50 por aula a partir do seu 5º aluno.',
                        });
                    }
                }

                setNudges(found);
                if (found.length && localStorage.getItem(todayKey) !== 'seen') setOpen(true);
            } catch (e) {
                console.warn('TeacherNudges:', e);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, pendingLessons]);

    if (!open || !nudges.length) return null;

    const close = () => { localStorage.setItem(todayKey, 'seen'); setOpen(false); };
    const toneCls: Record<string, string> = {
        red: 'border-red-500/30 bg-red-500/5',
        amber: 'border-amber-500/30 bg-amber-500/5',
        blue: 'border-blue-500/30 bg-blue-500/5',
        emerald: 'border-emerald-500/30 bg-emerald-500/5',
    };
    const iconCls: Record<string, string> = {
        red: 'text-red-500', amber: 'text-amber-500', blue: 'text-blue-500', emerald: 'text-emerald-500',
    };

    return (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-brand-surface w-full max-w-lg rounded-3xl border border-brand-border shadow-2xl max-h-[90dvh] overflow-y-auto">
                <div className="p-5 border-b border-brand-border flex items-center justify-between sticky top-0 bg-brand-surface z-10">
                    <h3 className="font-black text-brand-text flex items-center gap-2">
                        <BellRing size={18} className="text-brand-accent" /> Avisos do dia
                    </h3>
                    <button onClick={close} className="p-2 rounded-xl hover:bg-brand-surface-2" aria-label="Fechar">
                        <X size={18} className="text-brand-muted" />
                    </button>
                </div>
                <div className="p-4 space-y-3">
                    {nudges.map(n => (
                        <div key={n.id} className={`rounded-2xl border p-4 ${toneCls[n.tone]}`}>
                            <div className="flex items-start gap-3">
                                <span className={`mt-0.5 shrink-0 ${iconCls[n.tone]}`}>{n.icon}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="font-black text-sm text-brand-text">{n.title}</p>
                                    <p className="text-xs text-brand-muted mt-1 leading-relaxed">{n.text}</p>
                                    {n.cta && onNavigate && (
                                        <button
                                            onClick={() => { close(); onNavigate(n.cta!.tab); }}
                                            className="mt-2 text-[11px] font-black uppercase tracking-wider text-brand-accent hover:underline"
                                        >
                                            {n.cta.label} →
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="p-4 pt-0">
                    <button onClick={close} className="w-full py-3 rounded-2xl bg-brand-accent text-white font-black text-sm uppercase tracking-wider hover:bg-brand-accent-hover transition-colors">
                        Entendi, bora! 🐺
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TeacherNudges;
