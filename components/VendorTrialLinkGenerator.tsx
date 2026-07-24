import React, { useState, useEffect } from 'react';
import { Zap, User, Phone, Search, Copy, Check, ChevronDown, Calendar, Clock, Link as LinkIcon, Sparkles, Filter } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { TEACHER_SPECIALIZATIONS } from '../constants';

interface VendorTrialLinkGeneratorProps {
    user: any;
    tenantId?: string;
    teachers?: any[];
}

const WEEKDAY_OPTIONS = [
    { value: 'Segunda', label: 'Segunda-feira' },
    { value: 'Terça', label: 'Terça-feira' },
    { value: 'Quarta', label: 'Quarta-feira' },
    { value: 'Quinta', label: 'Quinta-feira' },
    { value: 'Sexta', label: 'Sexta-feira' },
    { value: 'Sábado', label: 'Sábado' },
];

const VendorTrialLinkGenerator: React.FC<VendorTrialLinkGeneratorProps> = ({ user, tenantId, teachers = [] }) => {
    const [prospectName, setProspectName] = useState('');
    const [prospectPhone, setProspectPhone] = useState('');
    const [specFilter, setSpecFilter] = useState('');
    const [selectedTeacher, setSelectedTeacher] = useState('');
    const [teacherSearch, setTeacherSearch] = useState('');
    const [showTeacherList, setShowTeacherList] = useState(false);
    const [selectedDay, setSelectedDay] = useState('');
    const [selectedTime, setSelectedTime] = useState('');
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    const [availableTeachers, setAvailableTeachers] = useState<any[]>([]);

    useEffect(() => {
        if (teachers.length > 0) {
            setAvailableTeachers(teachers);
            return;
        }
        if (!tenantId) return;
        supabase
            .from('profiles')
            .select('id, full_name, specializations, avatar_url')
            .eq('tenant_id', tenantId)
            .eq('role', 'TEACHER')
            .then(({ data }) => setAvailableTeachers(data || []));
    }, [tenantId, teachers]);

    const filteredTeachers = availableTeachers.filter(t => {
        const matchSpec = !specFilter || (t.specializations || []).includes(specFilter);
        const matchSearch = !teacherSearch || (t.full_name || t.name || '').toLowerCase().includes(teacherSearch.toLowerCase());
        return matchSpec && matchSearch;
    });

    const selectedTeacherObj = availableTeachers.find(t => t.id === selectedTeacher);

    const handleGenerate = async () => {
        if (!prospectName.trim()) return alert('Informe o nome do prospect.');
        if (prospectPhone.replace(/\D/g, '').length < 10) return alert('Informe um WhatsApp válido.');
        if (!selectedTeacher || !selectedDay || !selectedTime) return alert('Selecione professor, dia e horário.');
        if (!tenantId) return alert('Tenant ID não encontrado.');

        setSaving(true);
        try {
            const dayIndex: Record<string, number> = {
                Domingo: 0, Segunda: 1, Terça: 2, Quarta: 3, Quinta: 4, Sexta: 5, Sábado: 6,
            };
            const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
            let delta = (dayIndex[selectedDay] - brtNow.getUTCDay() + 7) % 7;
            let selectedDate = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate() + delta));
            let ymd = selectedDate.toISOString().split('T')[0];
            let startAt = new Date(`${ymd}T${selectedTime}:00-03:00`);
            if (startAt.getTime() < Date.now() + 60 * 60 * 1000) {
                delta += 7;
                selectedDate = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate() + delta));
                ymd = selectedDate.toISOString().split('T')[0];
                startAt = new Date(`${ymd}T${selectedTime}:00-03:00`);
            }

            const { data: opp, error: oppErr } = await supabase
                .from('opportunities')
                .insert({
                    tenant_id: tenantId,
                    student_name: prospectName.trim(),
                    student_phone: prospectPhone.replace(/\D/g, '') || null,
                    status: 'CLAIMED',
                    trial_status: 'SCHEDULED',
                    conversion_status: 'OPEN',
                    winner_teacher_id: selectedTeacher || null,
                    slots_proposed: [{
                        day: selectedDay,
                        time: selectedTime,
                        formatted: selectedDay,
                        start_time: startAt.toISOString(),
                    }],
                    created_by_vendor_id: user.id,
                })
                .select()
                .single();

            if (oppErr) throw oppErr;

            const linkToken = crypto.randomUUID();
            const trialUrl = `${APP_BASE_URL}/experimental?token=${linkToken}`;

            // Save enrollment link record
            const { error: linkError } = await supabase.from('enrollment_links').insert({
                tenant_id: tenantId,
                opportunity_id: opp.id,
                link_token: linkToken,
                link_url: trialUrl,
                student_name: prospectName.trim(),
                student_phone: prospectPhone.replace(/\D/g, '') || null,
                professor_id: selectedTeacher || null,
                status: 'PENDING',
                created_by_vendor_id: user.id,
            });
            if (linkError) {
                await supabase.from('opportunities').delete().eq('id', opp.id);
                throw linkError;
            }

            setGeneratedLink(trialUrl);
            await navigator.clipboard.writeText(trialUrl).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
        } catch (err: any) {
            console.error(err);
            alert('Erro ao gerar link: ' + err.message);
        } finally {
            setSaving(false);
        }
    };

    const reset = () => {
        setProspectName('');
        setProspectPhone('');
        setSelectedTeacher('');
        setSelectedDay('');
        setSelectedTime('');
        setGeneratedLink('');
        setCopied(false);
        setTeacherSearch('');
    };

    return (
        <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-500 pb-20">
            {/* Header */}
            <div className="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-[2.5rem] p-8 text-white relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-2">
                        <Zap size={24} className="text-yellow-300" />
                        <h2 className="text-2xl font-black tracking-tight">Gerar Link de Aula Experimental</h2>
                    </div>
                    <p className="text-indigo-100/80 text-sm">Crie um link de oportunidade de aula experimental para um prospect e envie direto no WhatsApp.</p>
                </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800 p-8 space-y-6 shadow-sm">

                {/* Prospect Info */}
                <div>
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                        <User size={14} /> Dados do Prospect
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Nome completo *</label>
                            <input
                                type="text"
                                value={prospectName}
                                onChange={e => setProspectName(e.target.value)}
                                placeholder="Ex: João Silva"
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">WhatsApp</label>
                            <div className="relative">
                                <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="tel"
                                    value={prospectPhone}
                                    onChange={e => setProspectPhone(e.target.value)}
                                    placeholder="(11) 99999-9999"
                                    className="w-full pl-9 pr-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Teacher Selection */}
                <div>
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                        <Filter size={14} /> Professor (Opcional)
                    </h3>

                    {/* Spec Filter */}
                    <div className="mb-3">
                        <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Filtrar por especialização</label>
                        <select
                            value={specFilter}
                            onChange={e => { setSpecFilter(e.target.value); setSelectedTeacher(''); }}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                        >
                            <option value="">Todas as especializações</option>
                            {TEACHER_SPECIALIZATIONS.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>

                    {/* Teacher Search */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                        <input
                            type="text"
                            placeholder={selectedTeacherObj ? (selectedTeacherObj.full_name || selectedTeacherObj.name) : 'Buscar professor...'}
                            value={selectedTeacher ? '' : teacherSearch}
                            onChange={e => { setTeacherSearch(e.target.value); setSelectedTeacher(''); setShowTeacherList(true); }}
                            onFocus={() => setShowTeacherList(true)}
                            className="w-full pl-9 pr-10 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                        />
                        {selectedTeacherObj && (
                            <span className="absolute left-9 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-700 dark:text-slate-200 pointer-events-none">
                                {selectedTeacherObj.full_name || selectedTeacherObj.name}
                            </span>
                        )}
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={14} />

                        {showTeacherList && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowTeacherList(false)} />
                                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-52 overflow-y-auto z-50">
                                    <button
                                        onClick={() => { setSelectedTeacher(''); setShowTeacherList(false); setTeacherSearch(''); }}
                                        className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-500 text-xs font-medium italic"
                                    >
                                        Nenhum professor específico
                                    </button>
                                    {filteredTeachers.map(t => (
                                        <button
                                            key={t.id}
                                            onClick={() => { setSelectedTeacher(t.id); setShowTeacherList(false); setTeacherSearch(''); }}
                                            className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-sm font-medium transition-colors flex items-center justify-between"
                                        >
                                            <div>
                                                <p className="font-bold">{t.full_name || t.name}</p>
                                                {(t.specializations || []).length > 0 && (
                                                    <p className="text-[10px] text-slate-400 truncate">{(t.specializations || []).slice(0, 2).join(' · ')}</p>
                                                )}
                                            </div>
                                            {selectedTeacher === t.id && <Check size={14} className="text-indigo-500 shrink-0" />}
                                        </button>
                                    ))}
                                    {filteredTeachers.length === 0 && (
                                        <p className="px-4 py-3 text-xs text-slate-400 italic">Nenhum professor encontrado</p>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Suggested Date/Time */}
                <div>
                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                        <Calendar size={14} /> Data e Horário Sugerido (Opcional)
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Dia da semana</label>
                            <select
                                value={selectedDay}
                                onChange={e => setSelectedDay(e.target.value)}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            >
                                <option value="">Selecionar...</option>
                                {WEEKDAY_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400 mb-1 block">Horário</label>
                            <div className="relative">
                                <Clock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="time"
                                    value={selectedTime}
                                    onChange={e => setSelectedTime(e.target.value)}
                                    className="w-full pl-9 pr-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Generate Button */}
                {!generatedLink ? (
                    <button
                        onClick={handleGenerate}
                        disabled={saving || !prospectName.trim()}
                        className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-indigo-500/20 hover:brightness-110 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                    >
                        {saving ? (
                            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> Gerando...</>
                        ) : (
                            <><Sparkles size={16} /> Gerar Link Experimental</>
                        )}
                    </button>
                ) : (
                    <div className="space-y-3">
                        {/* Link Display */}
                        <div className="bg-slate-900 rounded-2xl p-4 flex items-center gap-4 border border-slate-800">
                            <LinkIcon size={18} className="text-emerald-400 shrink-0" />
                            <div className="flex-1 overflow-hidden">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Link Gerado ✨</p>
                                <input
                                    readOnly
                                    value={generatedLink}
                                    className="w-full bg-transparent border-none p-0 text-sm font-mono text-emerald-400 focus:ring-0 truncate"
                                />
                            </div>
                            <button
                                onClick={() => { navigator.clipboard.writeText(generatedLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                                className={`px-4 py-2 rounded-xl font-black text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${copied ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                            >
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                                {copied ? 'Copiado!' : 'Copiar'}
                            </button>
                        </div>

                        {/* WhatsApp Quick Send */}
                        {prospectPhone && (
                            <a
                                href={`https://wa.me/55${prospectPhone.replace(/\D/g, '')}?text=${encodeURIComponent(`Olá ${prospectName.split(' ')[0]}! 🐺\n\nTenho uma aula experimental gratuita para você conhecer nosso método de inglês.\n\nClique aqui para confirmar seu horário: ${generatedLink}`)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="w-full py-3 bg-green-500 hover:bg-green-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-lg shadow-green-500/20"
                            >
                                Enviar via WhatsApp
                            </a>
                        )}

                        <button
                            onClick={reset}
                            className="w-full py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl font-bold text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                        >
                            Gerar novo link
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VendorTrialLinkGenerator;
