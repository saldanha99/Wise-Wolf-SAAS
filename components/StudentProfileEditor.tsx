import React, { useState, useEffect } from 'react';
import { X, Save, Brain, Target, User, BookOpen, Heart, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface StudentProfileEditorProps {
    studentId: string;
    studentName: string;
    onClose: () => void;
    onSaved?: () => void;
}

const ENGLISH_FOR_OPTIONS = [
    'Inglês Geral / Conversação',
    'Business English',
    'TOEFL / IELTS',
    'Inglês para Crianças',
    'Inglês para Viagens',
    'Inglês Acadêmico',
    'Inglês para Tecnologia',
    'Inglês para Saúde / Medicina',
];

const STUDENT_CATEGORIES = [
    'Executivo / Profissional',
    'Estudante Universitário',
    'Estudante Ensino Médio',
    'Criança (até 12 anos)',
    'Adolescente (13-17)',
    'Viajante Frequente',
    'Aposentado / Adulto Maduro',
];

const PERSONALITY_OPTIONS = [
    'Extrovertido e comunicativo',
    'Introvertido, prefere escrita',
    'Analítico, gosta de regras',
    'Visual, aprende com exemplos',
    'Prático, foco em conversação',
];

const StudentProfileEditor: React.FC<StudentProfileEditorProps> = ({ studentId, studentName, onClose, onSaved }) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [englishFor, setEnglishFor] = useState('');
    const [studentCategory, setStudentCategory] = useState('');
    const [learningObjective, setLearningObjective] = useState('');
    const [personality, setPersonality] = useState('');
    const [preferredTopics, setPreferredTopics] = useState('');
    const [avoidedTopics, setAvoidedTopics] = useState('');
    const [shortTermGoal, setShortTermGoal] = useState('');
    const [longTermGoal, setLongTermGoal] = useState('');

    const [wolfIntelligence, setWolfIntelligence] = useState<any>(null);

    useEffect(() => {
        fetchProfile();
    }, [studentId]);

    const fetchProfile = async () => {
        setLoading(true);
        try {
            const { data: profile } = await supabase
                .from('profiles')
                .select('english_for, student_category, learning_objective, personality, preferred_topics, avoided_topics, short_term_goal, long_term_goal')
                .eq('id', studentId)
                .single();

            if (profile) {
                setEnglishFor(profile.english_for || '');
                setStudentCategory(profile.student_category || '');
                setLearningObjective(profile.learning_objective || '');
                setPersonality(profile.personality || '');
                setPreferredTopics((profile.preferred_topics || []).join(', '));
                setAvoidedTopics((profile.avoided_topics || []).join(', '));
                setShortTermGoal(profile.short_term_goal || '');
                setLongTermGoal(profile.long_term_goal || '');
            }

            const { data: wolfData } = await supabase
                .from('wolf_intelligence')
                .select('*')
                .eq('student_id', studentId)
                .single();

            if (wolfData) setWolfIntelligence(wolfData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    english_for: englishFor || null,
                    student_category: studentCategory || null,
                    learning_objective: learningObjective || null,
                    personality: personality || null,
                    preferred_topics: preferredTopics ? preferredTopics.split(',').map(s => s.trim()).filter(Boolean) : [],
                    avoided_topics: avoidedTopics ? avoidedTopics.split(',').map(s => s.trim()).filter(Boolean) : [],
                    short_term_goal: shortTermGoal || null,
                    long_term_goal: longTermGoal || null,
                })
                .eq('id', studentId);

            if (error) throw error;
            onSaved?.();
            onClose();
        } catch (e: any) {
            alert('Erro ao salvar: ' + e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[2rem] shadow-2xl border border-gray-100 dark:border-slate-800 flex flex-col max-h-[90vh] overflow-hidden">
                {/* Header */}
                <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between bg-gray-50/50 dark:bg-slate-800/50 shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <Brain size={20} className="text-violet-600 dark:text-violet-400" />
                        </div>
                        <div>
                            <h3 className="font-black text-gray-800 dark:text-white text-sm">Perfil Wolf Intelligence</h3>
                            <p className="text-xs text-gray-400">{studentName}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-xl transition-colors">
                        <X size={18} className="text-gray-400" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {loading ? (
                        <div className="text-center py-8 text-gray-400 text-sm">Carregando perfil...</div>
                    ) : (
                        <>
                            {/* Wolf Intelligence Context */}
                            {wolfIntelligence && (
                                <div className="bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800 rounded-2xl p-5">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-violet-600 mb-3 flex items-center gap-2">
                                        <Brain size={14} /> Wolf Intelligence — Contexto Acumulado
                                    </h4>
                                    {wolfIntelligence.accumulated_context && (
                                        <p className="text-sm text-gray-700 dark:text-slate-300 leading-relaxed mb-3">{wolfIntelligence.accumulated_context}</p>
                                    )}
                                    <div className="grid grid-cols-2 gap-3">
                                        {wolfIntelligence.strong_points?.length > 0 && (
                                            <div>
                                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-wider mb-1">Pontos Fortes</p>
                                                {wolfIntelligence.strong_points.map((p: string, i: number) => (
                                                    <p key={i} className="text-xs text-gray-600 dark:text-slate-400">• {p}</p>
                                                ))}
                                            </div>
                                        )}
                                        {wolfIntelligence.weak_points?.length > 0 && (
                                            <div>
                                                <p className="text-[10px] font-black text-red-500 uppercase tracking-wider mb-1">Pontos a Melhorar</p>
                                                {wolfIntelligence.weak_points.map((p: string, i: number) => (
                                                    <p key={i} className="text-xs text-gray-600 dark:text-slate-400">• {p}</p>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    {wolfIntelligence.recommended_approach && (
                                        <div className="mt-3 p-3 bg-white dark:bg-slate-800 rounded-xl">
                                            <p className="text-[10px] font-black text-violet-500 uppercase tracking-wider mb-1">Abordagem Recomendada</p>
                                            <p className="text-xs text-gray-600 dark:text-slate-400">{wolfIntelligence.recommended_approach}</p>
                                        </div>
                                    )}
                                    <p className="text-[9px] text-gray-400 mt-3">
                                        Última atualização: {new Date(wolfIntelligence.last_updated_at).toLocaleDateString('pt-BR')}
                                        &nbsp;· {wolfIntelligence.total_classes_analyzed} aulas analisadas
                                    </p>
                                </div>
                            )}

                            {/* Formulário de Perfil */}
                            <Section icon={<Target size={14} />} title="Objetivo do Inglês" color="blue">
                                <Select label="Para que serve o inglês deste aluno?" value={englishFor} onChange={setEnglishFor} options={ENGLISH_FOR_OPTIONS} />
                                <Select label="Categoria do Aluno" value={studentCategory} onChange={setStudentCategory} options={STUDENT_CATEGORIES} />
                            </Section>

                            <Section icon={<User size={14} />} title="Perfil de Aprendizado" color="emerald">
                                <Select label="Personalidade / Estilo de Aprendizado" value={personality} onChange={setPersonality} options={PERSONALITY_OPTIONS} />
                                <Textarea label="Objetivo de aprendizado detalhado" value={learningObjective} onChange={setLearningObjective} placeholder="Ex: Precisa de inglês para reuniões com clientes americanos no setor de tecnologia" />
                            </Section>

                            <Section icon={<Heart size={14} />} title="Tópicos e Interesses" color="pink">
                                <TextInput label="Tópicos preferidos (separados por vírgula)" value={preferredTopics} onChange={setPreferredTopics} placeholder="Ex: tecnologia, esportes, viagens, culinária" />
                                <TextInput label="Tópicos a evitar (separados por vírgula)" value={avoidedTopics} onChange={setAvoidedTopics} placeholder="Ex: política, religião" />
                            </Section>

                            <Section icon={<BookOpen size={14} />} title="Metas" color="amber">
                                <Textarea label="Meta de curto prazo (3 meses)" value={shortTermGoal} onChange={setShortTermGoal} placeholder="Ex: Conseguir conduzir uma reunião básica em inglês sem travar" />
                                <Textarea label="Meta de longo prazo (12 meses)" value={longTermGoal} onChange={setLongTermGoal} placeholder="Ex: Estar apto para uma entrevista de emprego internacional" />
                            </Section>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="p-5 border-t dark:border-slate-800 flex justify-end gap-3 bg-gray-50/50 dark:bg-slate-800/50 shrink-0">
                    <button onClick={onClose} className="px-5 py-2.5 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-xl transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-2.5 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 transition-all shadow-lg flex items-center gap-2 disabled:opacity-50"
                    >
                        <Save size={14} /> {saving ? 'Salvando...' : 'Salvar Perfil'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// Sub-componentes internos
const Section: React.FC<{ icon: React.ReactNode; title: string; color: string; children: React.ReactNode }> = ({ icon, title, color, children }) => {
    const colorMap: Record<string, string> = {
        blue: 'text-blue-600',
        emerald: 'text-emerald-600',
        pink: 'text-pink-600',
        amber: 'text-amber-600',
    };
    return (
        <div className="space-y-3">
            <h4 className={`text-xs font-black uppercase tracking-widest flex items-center gap-2 ${colorMap[color] || 'text-gray-600'}`}>
                {icon} {title}
            </h4>
            <div className="grid grid-cols-1 gap-3">
                {children}
            </div>
        </div>
    );
};

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: string[] }> = ({ label, value, onChange, options }) => (
    <div className="space-y-1">
        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</label>
        <select
            value={value}
            onChange={e => onChange(e.target.value)}
            className="w-full px-4 py-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all"
        >
            <option value="">Selecionar...</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
    </div>
);

const TextInput: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string }> = ({ label, value, onChange, placeholder }) => (
    <div className="space-y-1">
        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</label>
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full px-4 py-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all"
        />
    </div>
);

const Textarea: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string }> = ({ label, value, onChange, placeholder }) => (
    <div className="space-y-1">
        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</label>
        <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            rows={3}
            className="w-full px-4 py-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-all resize-none"
        />
    </div>
);

export default StudentProfileEditor;
