import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User, JobApplication, JobStatus } from '../types';
import { Briefcase, FileText, Search, ChevronDown, ChevronUp, Bot, Sparkles, Calendar, MessageCircle, Loader2, BotOff } from 'lucide-react';

// Handoff humano vale 72h (mesma constante do whatsapp-inbound). Depois disso a
// Michelle volta a responder quem escrever — o painel mostra o estado REAL, não
// só o booleano, senão o diretor não entende por que a IA voltou a falar.
const HANDOFF_TTL_MS = 72 * 3600 * 1000;
const handoffAtivo = (app: any): boolean => {
    if (app?.ai_handoff !== true || !app?.ai_handoff_at) return false;
    const at = new Date(app.ai_handoff_at).getTime();
    return !Number.isNaN(at) && Date.now() - at < HANDOFF_TTL_MS;
};

// Painel de RH com a triagem da RITA (IA de RH):
// - score 0-10 + recomendação + resumo + red flags por candidato (edge hr-ai-screening)
// - respostas da pré-entrevista feita pela Rita no WhatsApp
// - entrevista agendada (interview_slot)
// - botão PDF gera SIGNED URL (o bucket 'resumes' é PRIVADO — URL pública quebra)

interface HRModuleProps {
    user: User;
    tenantId?: string;
}

const HRModule: React.FC<HRModuleProps> = ({ user, tenantId }) => {
    const [applications, setApplications] = useState<JobApplication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [screeningId, setScreeningId] = useState<string | null>(null);

    const fetchApplications = async () => {
        if (!tenantId) return;
        setIsLoading(true);
        try {
            const { data, error } = await supabase
                .from('job_applications')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            // Melhores candidatos primeiro; sem triagem vai para o fim
            const sorted = (data || []).sort((a: JobApplication, b: JobApplication) => {
                const sa = a.ai_score ?? -1, sb = b.ai_score ?? -1;
                if (sb !== sa) return sb - sa;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
            setApplications(sorted);
        } catch (error: any) {
            console.error('Error fetching job applications:', error);
            alert('Erro ao carregar currículos.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchApplications();
    }, [tenantId]);

    // Devolver o candidato à Michelle (ou tirar dela) na hora, sem esperar as 72h.
    const toggleHandoff = async (app: any) => {
        const querSilenciar = !handoffAtivo(app);
        const { data, error } = await supabase.rpc('set_ai_handoff', {
            p_kind: 'candidato', p_id: app.id, p_handoff: querSilenciar,
        });
        if (error || !(data as any)?.ok) {
            alert('Não consegui alterar: ' + (error?.message || (data as any)?.error || 'erro'));
            return;
        }
        setApplications(prev => prev.map(a => a.id === app.id
            ? { ...a, ai_handoff: querSilenciar, ai_handoff_at: querSilenciar ? new Date().toISOString() : null } as JobApplication
            : a));
    };

    const updateStatus = async (id: string, newStatus: JobStatus) => {
        try {
            const { error } = await supabase
                .from('job_applications')
                .update({ status: newStatus })
                .eq('id', id);

            if (error) throw error;

            setApplications(apps => apps.map(app =>
                app.id === id ? { ...app, status: newStatus } : app
            ));
        } catch (error: any) {
            console.error('Error updating status:', error);
            alert('Erro ao atualizar status.');
        }
    };

    // Triagem manual (re-processa um candidato pela Rita; não dispara WhatsApp)
    const screenNow = async (id: string) => {
        setScreeningId(id);
        try {
            const { data, error } = await supabase.functions.invoke('hr-ai-screening', {
                body: { application_id: id, send_preinterview: false }
            });
            if (error) throw new Error(error.message);
            if (data?.error) throw new Error(data.error);
            await fetchApplications();
        } catch (e: any) {
            alert('Falha na triagem: ' + (e.message || 'erro desconhecido'));
        } finally {
            setScreeningId(null);
        }
    };

    const getStatusBadge = (status: JobStatus) => {
        const styles: Record<JobStatus, string> = {
            'Novo': 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20',
            'Em Análise': 'bg-yellow-100 dark:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-500/20',
            'Entrevistado': 'bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/20',
            'Contratado': 'bg-green-100 dark:bg-green-500/10 text-green-600 dark:text-green-400 border-green-200 dark:border-green-500/20',
            'Rejeitado': 'bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20'
        };

        return (
            <span className={`px-3 py-1.5 flex items-center justify-center w-full max-w-[120px] rounded-full text-xs font-semibold border ${styles[status]}`}>
                {status}
            </span>
        );
    };

    // Badge da nota da Rita: verde >=7, âmbar 4-6.9, vermelho <4
    const getScoreBadge = (app: JobApplication) => {
        if (app.ai_score === null || app.ai_score === undefined) {
            return (
                <button onClick={() => screenNow(app.id)} disabled={screeningId === app.id}
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:text-blue-600 hover:border-blue-400 transition-colors flex items-center gap-1 disabled:opacity-50">
                    {screeningId === app.id ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />}
                    {screeningId === app.id ? 'Triando…' : 'Triar (IA)'}
                </button>
            );
        }
        const score = Number(app.ai_score);
        const cls = score >= 7
            ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
            : score >= 4
                ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20'
                : 'bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20';
        return (
            <div className="flex items-center gap-1.5">
                <span className={`px-2 py-1 rounded-lg text-xs font-black border ${cls}`}>{score.toFixed(1)}</span>
                {app.ai_recommendation && (
                    <span className="text-[9px] font-black uppercase tracking-wider text-gray-500 dark:text-gray-400">{app.ai_recommendation}</span>
                )}
            </div>
        );
    };

    // O bucket 'resumes' é privado — gera signed URL a partir do path salvo
    const openResume = async (url?: string) => {
        if (!url) { alert('Currículo não anexado.'); return; }
        const m = url.match(/\/object\/(?:public|sign|authenticated)\/resumes\/(.+?)(?:\?|$)/);
        if (m) {
            const path = decodeURIComponent(m[1]);
            const { data, error } = await supabase.storage.from('resumes').createSignedUrl(path, 3600);
            if (!error && data?.signedUrl) { window.open(data.signedUrl, '_blank'); return; }
        }
        window.open(url, '_blank');
    };

    const PREINT_LABEL: Record<string, string> = {
        SENT: 'Pré-entrevista enviada',
        IN_PROGRESS: 'Pré-entrevista em andamento',
        DONE: 'Pré-entrevista concluída ✓',
    };

    const ANSWER_LABEL: Record<string, string> = {
        disponibilidade: 'Disponibilidade',
        pretensao: 'Pretensão por aula',
        nivel_ingles: 'Nível de inglês',
        experiencia: 'Experiência',
        apresentacao_en: 'Apresentação em inglês',
        nota_ingles: 'Nota do inglês escrito (Rita)',
    };

    const filteredApps = applications.filter(app =>
        app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        app.whatsapp.includes(searchTerm)
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 flex items-center gap-2">
                        <Briefcase className="w-8 h-8 text-blue-500" />
                        Recursos Humanos
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1.5">
                        <Bot size={14} className="text-blue-500" />
                        A <strong>Rita (IA)</strong> tria cada candidatura: nota, resumo e pré-entrevista pelo WhatsApp. Você só decide.
                    </p>
                </div>
            </div>

            <div className="bg-brand-surface/80 dark:bg-brand-surface/80 backdrop-blur-xl border border-gray-200 dark:border-gray-800 rounded-3xl p-6 shadow-sm overflow-hidden relative">
                <div className="flex flex-col md:flex-row justify-between mb-6 gap-4 relative z-10">
                    <div className="relative w-full md:w-96">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Buscar candidato por nome ou whatsapp..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 bg-gray-50 dark:bg-brand-surface-2/80 border border-gray-200 dark:border-gray-700 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-gray-200 shadow-sm"
                        />
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center p-16 relative z-10">
                        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="mt-4 text-sm text-gray-500 font-medium animate-pulse">Carregando currículos...</p>
                    </div>
                ) : filteredApps.length === 0 ? (
                    <div className="text-center p-16 bg-gray-50/50 dark:bg-brand-surface-2/20 rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 relative z-10">
                        <Briefcase className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
                        <h3 className="text-base font-bold text-gray-700 dark:text-gray-300">Nenhum candidato encontrado</h3>
                        <p className="text-sm text-gray-500 mt-2 max-w-sm mx-auto">
                            {searchTerm
                                ? "Não encontramos nenhum candidato com os termos buscados."
                                : "Ainda não há nenhuma candidatura de emprego registrada em seu sistema."}
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto relative z-10 -mx-6 px-6 pb-4">
                        <table className="w-full text-sm text-left border-separate border-spacing-y-2 min-w-[640px]">
                            <thead className="text-xs text-gray-500 uppercase font-semibold">
                                <tr>
                                    <th className="px-4 py-3">Candidato</th>
                                    <th className="px-4 py-3">Nota IA</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3">Inscrição</th>
                                    <th className="px-4 py-3 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredApps.map((app) => (
                                    <React.Fragment key={app.id}>
                                        <tr className="bg-gray-50 dark:bg-brand-surface-2/40 hover:bg-gray-100 dark:hover:bg-brand-surface-2/80 transition-colors group shadow-sm rounded-xl">
                                            <td className="px-4 py-4 rounded-l-xl">
                                                <div className="font-bold text-gray-900 dark:text-gray-100">{app.name}</div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-2 mt-0.5">
                                                    {app.whatsapp}
                                                    {app.preinterview_status && (
                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                                            <MessageCircle size={9} /> {PREINT_LABEL[app.preinterview_status] || app.preinterview_status}
                                                        </span>
                                                    )}
                                                    {app.interview_slot && (
                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400">
                                                            <Calendar size={9} /> Entrevista {new Date(app.interview_slot).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    )}
                                                    {handoffAtivo(app) && (
                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400" title="Um humano assumiu este contato — a Michelle não responde até 72h após o último toque manual">
                                                            <BotOff size={9} /> Atendimento humano
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-4">{getScoreBadge(app)}</td>
                                            <td className="px-4 py-4">{getStatusBadge(app.status)}</td>
                                            <td className="px-4 py-4 text-gray-500 dark:text-gray-500 font-medium whitespace-nowrap">
                                                {new Date(app.created_at).toLocaleDateString('pt-BR')}
                                            </td>
                                            <td className="px-4 py-4 text-right rounded-r-xl">
                                                <div className="flex items-center justify-end gap-2">
                                                    {(app.ai_summary || app.preinterview_answers) && (
                                                        <button
                                                            onClick={() => setExpandedId(expandedId === app.id ? null : app.id)}
                                                            className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-500/20 rounded-lg transition-colors font-medium text-xs flex items-center gap-1"
                                                            title="Ver análise da Rita"
                                                        >
                                                            <Sparkles className="w-4 h-4" />
                                                            {expandedId === app.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => openResume(app.resume_url)}
                                                        disabled={!app.resume_url}
                                                        className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-500/20 rounded-lg transition-colors font-medium text-xs flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                                        title="Visualizar Currículo (PDF)"
                                                    >
                                                        <FileText className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => toggleHandoff(app)}
                                                        className={`p-2 rounded-lg transition-colors font-medium text-xs flex items-center gap-1.5 ${handoffAtivo(app)
                                                            ? 'text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-500/20'
                                                            : 'text-gray-500 hover:text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-500/20'}`}
                                                        title={handoffAtivo(app)
                                                            ? 'Devolver este candidato para a Michelle responder'
                                                            : 'Silenciar a Michelle neste contato (atendimento humano)'}
                                                    >
                                                        {handoffAtivo(app) ? <Bot className="w-4 h-4" /> : <BotOff className="w-4 h-4" />}
                                                    </button>
                                                    <div className="h-6 w-px bg-gray-200 dark:bg-gray-700"></div>
                                                    <select
                                                        value={app.status}
                                                        onChange={(e) => updateStatus(app.id, e.target.value as JobStatus)}
                                                        className="text-xs bg-brand-surface border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 font-semibold text-gray-700 dark:text-gray-200 outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-all cursor-pointer"
                                                    >
                                                        <option value="Novo">Novo</option>
                                                        <option value="Em Análise">Em Análise</option>
                                                        <option value="Entrevistado">Entrevistado</option>
                                                        <option value="Contratado">Contratado</option>
                                                        <option value="Rejeitado">Rejeitado</option>
                                                    </select>
                                                </div>
                                            </td>
                                        </tr>
                                        {expandedId === app.id && (
                                            <tr>
                                                <td colSpan={5} className="px-4 pb-2">
                                                    <div className="bg-blue-50/60 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/15 rounded-xl p-4 space-y-3">
                                                        {app.ai_summary && (
                                                            <div>
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-blue-600 dark:text-blue-400 flex items-center gap-1 mb-1"><Bot size={11} /> Análise da Rita</p>
                                                                <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{app.ai_summary}</p>
                                                            </div>
                                                        )}
                                                        <div className="grid sm:grid-cols-2 gap-3">
                                                            {(app.ai_flags?.pontos_fortes?.length ?? 0) > 0 && (
                                                                <div>
                                                                    <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">Pontos fortes</p>
                                                                    <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                                                                        {app.ai_flags!.pontos_fortes!.map((p, i) => <li key={i}>• {p}</li>)}
                                                                    </ul>
                                                                </div>
                                                            )}
                                                            {(app.ai_flags?.red_flags?.length ?? 0) > 0 && (
                                                                <div>
                                                                    <p className="text-[10px] font-black uppercase tracking-widest text-red-500 mb-1">Red flags</p>
                                                                    <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                                                                        {app.ai_flags!.red_flags!.map((p, i) => <li key={i}>• {p}</li>)}
                                                                    </ul>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {app.preinterview_answers && Object.keys(app.preinterview_answers).length > 0 && (
                                                            <div>
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-blue-600 dark:text-blue-400 flex items-center gap-1 mb-1"><MessageCircle size={11} /> Pré-entrevista (WhatsApp)</p>
                                                                <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
                                                                    {Object.entries(app.preinterview_answers).map(([k, v]) => (
                                                                        <div key={k} className="text-xs">
                                                                            <span className="font-bold text-gray-700 dark:text-gray-300">{ANSWER_LABEL[k] || k}: </span>
                                                                            <span className="text-gray-600 dark:text-gray-400">{String(v)}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default HRModule;
