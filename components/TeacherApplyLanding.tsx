import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { GraduationCap, Loader2, CheckCircle, MessageCircle, Sparkles } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// BANCO DE TALENTOS (/quero-ensinar) — destino do tráfego pago de professores.
// Candidato preenche nome + WhatsApp + mini-currículo → entra em job_applications
// (status BANCO_DE_TALENTOS, source ADS, dedupe por WhatsApp em 30 dias) e é
// convidado para o grupo de talentos no WhatsApp (tenants.talent_group_link).
// Mobile-first: quem vem de anúncio chega pelo celular.
// ─────────────────────────────────────────────────────────────────────────────

const TeacherApplyLanding: React.FC = () => {
    const [name, setName] = useState('');
    const [whatsapp, setWhatsapp] = useState('');
    const [notes, setNotes] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [groupLink, setGroupLink] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSending(true);
        setError(null);
        try {
            const { data, error: rpcErr } = await supabase.rpc('apply_teacher_candidate', {
                p_name: name,
                p_whatsapp: whatsapp,
                p_notes: notes || null,
            });
            if (rpcErr) throw rpcErr;
            if (!data?.ok) throw new Error('Confira seu nome e WhatsApp (com DDD) e tente de novo.');
            setGroupLink(data.group_link || null);
            setDone(true);
        } catch (err: any) {
            setError(err.message || 'Erro ao enviar. Tente novamente.');
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-950 text-white font-sans flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                {!done ? (
                    <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-8 backdrop-blur">
                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mb-5 shadow-lg shadow-violet-500/30">
                            <GraduationCap size={28} />
                        </div>
                        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-violet-300 mb-2">Wise Wolf · Banco de Talentos</p>
                        <h1 className="text-2xl font-black leading-tight">Ensina inglês? Entra pro nosso time de espera 🐺</h1>
                        <p className="text-sm text-white/60 mt-2 leading-relaxed">
                            Você prestará serviços como <b className="text-white/85">parceiro PJ</b>, ganhando por aula, com pagamento
                            garantido e alunos entregues pela escola. Quando abrir vaga compatível, chamamos direto do banco.
                        </p>

                        <form onSubmit={submit} className="mt-6 space-y-4">
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-white/50 mb-1.5">Seu nome completo</label>
                                <input value={name} onChange={e => setName(e.target.value)} required
                                    placeholder="Nome e sobrenome"
                                    className="w-full px-4 py-3.5 rounded-2xl bg-white/10 border border-white/15 text-white placeholder:text-white/30 outline-none focus:border-violet-400" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-white/50 mb-1.5">WhatsApp (com DDD)</label>
                                <input value={whatsapp} onChange={e => setWhatsapp(e.target.value)} required inputMode="tel"
                                    placeholder="(12) 99999-9999"
                                    className="w-full px-4 py-3.5 rounded-2xl bg-white/10 border border-white/15 text-white placeholder:text-white/30 outline-none focus:border-violet-400" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-white/50 mb-1.5">Sua experiência com inglês (resumo)</label>
                                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                                    placeholder="Ex.: 3 anos dando aula particular, morei fora, nível C1, tenho MEI..."
                                    className="w-full px-4 py-3.5 rounded-2xl bg-white/10 border border-white/15 text-white placeholder:text-white/30 outline-none focus:border-violet-400 resize-none" />
                            </div>
                            {error && <p className="text-sm font-bold text-rose-300">{error}</p>}
                            <button type="submit" disabled={sending}
                                className="w-full py-4 rounded-2xl bg-gradient-to-r from-violet-500 to-indigo-500 font-black uppercase tracking-widest text-sm hover:brightness-110 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-xl shadow-violet-500/25">
                                {sending ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={16} />} Entrar no banco de talentos
                            </button>
                            <p className="text-[10px] text-white/35 text-center leading-relaxed">
                                Sem compromisso dos dois lados: entrar no banco não é contratação — é ficar na fila certa.
                            </p>
                        </form>
                    </div>
                ) : (
                    <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-8 backdrop-blur text-center">
                        <div className="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center mx-auto mb-4">
                            <CheckCircle size={32} className="text-emerald-400" />
                        </div>
                        <h2 className="text-xl font-black">Você está no banco, {name.split(' ')[0]}! 🎉</h2>
                        <p className="text-sm text-white/60 mt-2 leading-relaxed">
                            Quando abrir uma vaga compatível, chamamos você no WhatsApp.
                            {groupLink ? ' Enquanto isso, entra no nosso grupo de talentos — é por lá que as vagas saem primeiro:' : ''}
                        </p>
                        {groupLink && (
                            <a href={groupLink} target="_blank" rel="noopener noreferrer"
                                className="mt-5 w-full py-4 rounded-2xl bg-emerald-500 text-white font-black uppercase tracking-widest text-sm hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2">
                                <MessageCircle size={18} /> Entrar no grupo de talentos
                            </a>
                        )}
                        <p className="text-[10px] text-white/35 mt-4">Wise Wolf Language School · Santa Isabel/SP</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TeacherApplyLanding;
