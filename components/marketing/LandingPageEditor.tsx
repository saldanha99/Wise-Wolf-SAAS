import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Save, Globe, Loader2, Plus, Trash2, LayoutTemplate, GraduationCap, Wand2, Sparkles, Rocket, Video, MessageSquare, Users, Target, HelpCircle, List, CheckCircle, PlayCircle } from 'lucide-react';
import PremiumLandingPreview from './PremiumLandingPreview';
import FreeLessonLandingPreview from './FreeLessonLandingPreview';
import HighConversionLandingPreview from './HighConversionLandingPreview';
// import { GoogleGenerativeAI } from "@google/genai"; // Commented out to avoid build error if package missing in some envs

interface LandingPageConfig {
    id?: string;
    headline: string;
    subheadline: string;
    heroImage?: string;
    ctaText?: string;
    plans: Plan[];
    template_type: 'sales' | 'free_lesson' | 'high_conversion';
    // Authentic Modules
    video_url?: string;
    show_video?: boolean;
    stats?: { label: string; value: string }[];
    benefits?: { title: string; description: string; icon: string }[];
    show_benefits?: boolean;
    target_audience?: { title: string; description: string; icon: string }[];
    show_target_audience?: boolean;
    testimonials?: { name: string; role: string; text: string; photo?: string }[];
    show_testimonials?: boolean;
    faq?: { question: string; answer: string }[];
    show_faq?: boolean;
    // New Feature Modules (Step 704)
    focus?: 'general' | 'travel' | 'tech' | 'kids';
    teachers?: { name: string; bio: string; photo?: string; media_url?: string }[];
    show_teachers?: boolean;
    company_logos?: string[];
    show_company_logos?: boolean;
}

interface Plan {
    name: string;
    price: string;
    features: string[];
}

interface LandingPageEditorProps {
    tenantId: string;
}

const LandingPageEditor: React.FC<LandingPageEditorProps> = ({ tenantId }) => {
    const [config, setConfig] = useState<LandingPageConfig>({
        headline: '',
        subheadline: '',
        heroImage: '',
        ctaText: '',
        plans: [],
        template_type: 'sales', // Default
        video_url: '',
        show_video: false,
        stats: [
            { label: 'Alunos Formados', value: '5.000+' },
            { label: 'Anos de Mercado', value: '10' },
            { label: 'Professores', value: '50' }
        ],
        benefits: [],
        show_benefits: true,
        target_audience: [],
        show_target_audience: true,
        testimonials: [],
        show_testimonials: true,
        faq: [],
        show_faq: true,
        focus: 'general',
        teachers: [],
        show_teachers: true,
        company_logos: [],
        show_company_logos: true
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [optimizingField, setOptimizingField] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'content' | 'authority' | 'social' | 'segments'>('content');

    useEffect(() => {
        fetchConfig();
    }, [tenantId]);

    const fetchConfig = async () => {
        try {
            const { data, error } = await supabase
                .from('landing_page_configs')
                .select('*')
                .eq('tenant_id', tenantId)
                .single();

            if (data) {
                setConfig({
                    ...data,
                    template_type: data.template_type || 'high_conversion',
                    // Ensure arrays are initialized if null from DB
                    stats: data.stats || [{ label: 'Alunos Formados', value: '1000+' }],
                    benefits: data.benefits || [],
                    target_audience: data.target_audience || [],
                    testimonials: data.testimonials || [],
                    faq: data.faq || []
                });
            } else {
                // NEW TENANT: Initialize with High Conversion Template Defaults
                setConfig(prev => ({
                    ...prev,
                    template_type: 'high_conversion',
                    headline: 'Aprenda Inglês Online com Aulas Particulares 4x por Semana',
                    subheadline: 'Acelere sua fluência com nosso método exclusivo focado em conversação e resultados reais.',
                    ctaText: 'Começar Agora',
                    heroImage: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?q=80&w=2671&auto=format&fit=crop',
                    benefits: [
                        { title: 'Foco em Conversação', description: 'Fale desde a primeira aula.', icon: 'MessageSquare' },
                        { title: 'Horários Flexíveis', description: 'Estude quando quiser, de onde estiver.', icon: 'Clock' },
                        { title: 'Sem Multa', description: 'Cancele quando quiser sem taxas.', icon: 'Shield' }
                    ],
                    target_audience: [
                        { title: 'Carreira', description: 'Para quem busca promoções.', icon: 'Briefcase' },
                        { title: 'Viagens', description: 'Viaje sem medo de travar.', icon: 'Plane' }
                    ],
                    faq: [
                        { question: 'Como funciona a aula agendada?', answer: 'Você escolhe o horário e o professor no app.' },
                        { question: 'Tem certificado?', answer: 'Sim, certificado válido em todo território nacional.' }
                    ]
                }));
            }

            if (error && error.code !== 'PGRST116') {
                console.error("Error fetching config:", error);
            }
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const payload = {
                tenant_id: tenantId,
                headline: config.headline,
                subheadline: config.subheadline,
                hero_image: config.heroImage,
                cta_text: config.ctaText,
                plans: config.plans,
                template_type: config.template_type,
                // Authentic Modules
                video_url: config.video_url,
                show_video: config.show_video,
                stats: config.stats,
                benefits: config.benefits,
                show_benefits: config.show_benefits,
                target_audience: config.target_audience,
                show_target_audience: config.show_target_audience,
                testimonials: config.testimonials,
                show_testimonials: config.show_testimonials,
                faq: config.faq,
                show_faq: config.show_faq
            };

            const { error } = await supabase
                .from('landing_page_configs')
                .upsert(config.id ? { id: config.id, ...payload } : payload);

            if (error) throw error;
            alert("Página salva com sucesso!");
            fetchConfig();
        } catch (error: any) {
            console.error(error);
            alert("Erro ao salvar: " + error.message + "\n\nSe o erro for sobre coluna inexistente 'template_type', execute o SQL de migração.");
        } finally {
            setSaving(false);
        }
    };

    const optimizeCopy = async (field: 'headline' | 'subheadline' | 'ctaText') => {
        setOptimizingField(field);

        // Simulation of AI for now, as we don't have the user's API Key secure storage yet.
        // In a real scenario, this would call a backend endpoint or use a stored key.

        try {
            await new Promise(resolve => setTimeout(resolve, 1500)); // Fake network delay

            if (field === 'headline') {
                const options = [
                    "Domine o Inglês Definitivamente com Método Comprovado",
                    "Aprenda Inglês Rápido e Sem Enrolação",
                    "Sua Jornada Rumo à Fluência Começa Aqui"
                ];
                const random = options[Math.floor(Math.random() * options.length)];
                setConfig(prev => ({ ...prev, headline: random }));
            }
            else if (field === 'subheadline') {
                const options = [
                    "Esqueça a gramática chata. Foque em conversação desde a primeira aula com professores nativos experientes.",
                    "Metodologia exclusiva focada em resultados reais para sua carreira e viagens.",
                    "Junte-se a mais de 5.000 alunos que destravaram o inglês com nossa plataforma inteligente."
                ];
                const random = options[Math.floor(Math.random() * options.length)];
                setConfig(prev => ({ ...prev, subheadline: random }));
            }
            else if (field === 'ctaText') {
                const options = ["Garantir Minha Vaga", "Quero Acessar Agora", "Começar Minha Jornada"];
                const random = options[Math.floor(Math.random() * options.length)];
                setConfig(prev => ({ ...prev, ctaText: random }));
            }

        } catch (error) {
            alert("Erro ao otimizar com IA.");
        } finally {
            setOptimizingField(null);
        }
    };

    const addPlan = () => {
        setConfig(prev => ({
            ...prev,
            plans: [...prev.plans, { name: 'Novo Plano', price: 'R$ 000', features: ['Recurso 1'] }]
        }));
    };

    const updatePlan = (index: number, field: keyof Plan, value: any) => {
        const newPlans = [...config.plans];
        newPlans[index] = { ...newPlans[index], [field]: value };
        setConfig(prev => ({ ...prev, plans: newPlans }));
    };

    const switchTemplate = (type: 'sales' | 'free_lesson' | 'high_conversion') => {
        let updates: Partial<LandingPageConfig> = { template_type: type };

        if (type === 'free_lesson') {
            if (!config.headline || config.headline === 'Aprenda Inglês de Verdade') updates.headline = 'Sua Primeira Aula de Inglês é Por Nossa Conta!';
            if (!config.subheadline || config.subheadline.startsWith('Metodologia')) updates.subheadline = 'Agende agora seu teste de nivelamento gratuito e descubra como nosso método funciona na prática. Sem compromisso.';
            if (!config.ctaText || config.ctaText === 'Começar Agora') updates.ctaText = 'Agendar Aula Grátis';
        } else if (type === 'high_conversion') {
            updates.headline = 'Aprenda Inglês Online com Aulas Particulares 4x por Semana';
            updates.subheadline = 'Acelere sua fluência com nosso método exclusivo focado em conversação e resultados reais.';
            updates.ctaText = 'Começar Agora';
        } else {
            if (config.headline === 'Sua Primeira Aula de Inglês é Por Nossa Conta!') updates.headline = 'Aprenda Inglês de Verdade';
            if (config.ctaText === 'Agendar Aula Grátis') updates.ctaText = 'Começar Agora';
        }

        setConfig(prev => ({ ...prev, ...updates }));
    };

    if (loading) return <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-blue-600" /></div>;

    return (
        <div className="flex flex-col lg:flex-row h-full">
            {/* Editor Panel */}
            <div className="w-full lg:w-1/2 p-6 overflow-y-auto border-r border-gray-100 dark:border-slate-800 scrollbar-hide">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="font-bold text-gray-800 dark:text-white">Editor de Conteúdo</h3>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-blue-700 transition-all disabled:opacity-50"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        Salvar Alterações
                    </button>
                </div>

                {/* Template Selector */}
                <div className="mb-8 p-1 bg-gray-100 dark:bg-slate-800 rounded-xl grid grid-cols-3 shadow-inner gap-1">
                    <button
                        onClick={() => switchTemplate('sales')}
                        className={`py-3 rounded-lg text-[10px] md:text-xs font-black uppercase tracking-wide flex flex-col md:flex-row items-center justify-center gap-2 transition-all ${config.template_type === 'sales'
                            ? 'bg-white dark:bg-slate-700 shadow-md text-blue-600 dark:text-blue-400 transform scale-[1.02]'
                            : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700/50'
                            }`}
                    >
                        <LayoutTemplate size={14} /> Padrão
                    </button>
                    <button
                        onClick={() => switchTemplate('free_lesson')}
                        className={`py-3 rounded-lg text-[10px] md:text-xs font-black uppercase tracking-wide flex flex-col md:flex-row items-center justify-center gap-2 transition-all ${config.template_type === 'free_lesson'
                            ? 'bg-white dark:bg-slate-700 shadow-md text-emerald-600 dark:text-emerald-400 transform scale-[1.02]'
                            : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700/50'
                            }`}
                    >
                        <GraduationCap size={16} /> Aula Grátis
                    </button>
                    <button
                        onClick={() => switchTemplate('high_conversion')}
                        className={`py-3 rounded-lg text-[10px] md:text-xs font-black uppercase tracking-wide flex flex-col md:flex-row items-center justify-center gap-2 transition-all ${config.template_type === 'high_conversion'
                            ? 'bg-white dark:bg-slate-700 shadow-md text-red-600 dark:text-red-400 transform scale-[1.02]'
                            : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700/50'
                            }`}
                    >
                        <Rocket size={16} /> Alta Conversão
                    </button>
                </div>

                {/* Modules Tabs */}
                <div className="flex border-b border-gray-200 dark:border-slate-800 mb-6 overflow-x-auto">
                    {['content', 'authority', 'social', 'segments'].map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab as any)}
                            className={`px-4 py-3 text-xs font-black uppercase tracking-widest border-b-2 transition-all shrink-0 ${activeTab === tab
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300'
                                }`}
                        >
                            {tab === 'content' && 'Conteúdo'}
                            {tab === 'authority' && 'Autoridade'}
                            {tab === 'social' && 'Diferencias'}
                            {tab === 'segments' && 'FAQ & Público'}
                        </button>
                    ))}
                </div>

                {activeTab === 'content' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {/* Focus Selector */}
                        <div>
                            <label className="text-xs font-black uppercase text-gray-500 mb-2 block">Foco da LP (Personalização)</label>
                            <div className="grid grid-cols-4 gap-2">
                                {[
                                    { id: 'general', label: 'Geral', icon: Globe },
                                    { id: 'travel', label: 'Viagem', icon: Rocket },
                                    { id: 'tech', label: 'Tech', icon: Loader2 },
                                    { id: 'kids', label: 'Kids', icon: Sparkles },
                                ].map((type) => (
                                    <button
                                        key={type.id}
                                        onClick={() => setConfig({ ...config, focus: type.id as any })}
                                        className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${config.focus === type.id ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 dark:border-slate-700 hover:border-blue-300'}`}
                                    >
                                        <type.icon size={16} />
                                        <span className="text-[10px] font-bold uppercase">{type.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        {/* Headline with AI */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-black uppercase text-gray-500">Headline (Título Principal)</label>
                                <button
                                    onClick={() => optimizeCopy('headline')}
                                    disabled={!!optimizingField}
                                    className="flex items-center gap-1 text-[10px] font-black uppercase text-purple-600 hover:bg-purple-50 px-2 py-1 rounded-lg transition-colors border border-purple-100"
                                >
                                    {optimizingField === 'headline' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                    Otimizar com IA
                                </button>
                            </div>
                            <input
                                type="text"
                                value={config.headline}
                                onChange={e => setConfig({ ...config, headline: e.target.value })}
                                className="w-full p-3 bg-gray-50 dark:bg-slate-800 rounded-xl border-none focus:ring-2 focus:ring-blue-600 transition-all font-bold text-gray-800 dark:text-gray-100"
                                placeholder={config.template_type === 'free_lesson' ? "Ex: Aula Grátis de Inglês" : "Ex: Aprenda Inglês em 6 Meses"}
                            />
                        </div>

                        {/* Subheadline with AI */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-black uppercase text-gray-500">Sub-headline</label>
                                <button
                                    onClick={() => optimizeCopy('subheadline')}
                                    disabled={!!optimizingField}
                                    className="flex items-center gap-1 text-[10px] font-black uppercase text-purple-600 hover:bg-purple-50 px-2 py-1 rounded-lg transition-colors border border-purple-100"
                                >
                                    {optimizingField === 'subheadline' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                    Otimizar com IA
                                </button>
                            </div>
                            <textarea
                                value={config.subheadline}
                                onChange={e => setConfig({ ...config, subheadline: e.target.value })}
                                className="w-full p-3 bg-gray-50 dark:bg-slate-800 rounded-xl border-none focus:ring-2 focus:ring-blue-600 transition-all h-24 resize-none text-sm text-gray-600 dark:text-gray-300"
                                placeholder="Descrição curta do seu método..."
                            />
                        </div>

                        {/* CTA with AI */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-black uppercase text-gray-500">CTA (Botão Principal)</label>
                                <button
                                    onClick={() => optimizeCopy('ctaText')}
                                    disabled={!!optimizingField}
                                    className="flex items-center gap-1 text-[10px] font-black uppercase text-purple-600 hover:bg-purple-50 px-2 py-1 rounded-lg transition-colors border border-purple-100"
                                >
                                    {optimizingField === 'ctaText' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                    Melhorar Chamada
                                </button>
                            </div>
                            <input
                                type="text"
                                value={config.ctaText}
                                onChange={e => setConfig({ ...config, ctaText: e.target.value })}
                                className={`w-full p-3 bg-gray-50 dark:bg-slate-800 rounded-xl border-none focus:ring-2 transition-all font-bold ${config.template_type === 'free_lesson' ? 'text-emerald-600 focus:ring-emerald-500' : 'text-blue-600 focus:ring-blue-600'
                                    }`}
                                placeholder={config.template_type === 'free_lesson' ? "Ex: Agendar Agora" : "Ex: Quero Minha Vaga"}
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-black uppercase text-gray-500">Link da Imagem de Capa (URL)</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={config.heroImage}
                                    onChange={e => setConfig({ ...config, heroImage: e.target.value })}
                                    className="w-full p-3 bg-gray-50 dark:bg-slate-800 rounded-xl border-none focus:ring-2 focus:ring-blue-600 transition-all text-xs"
                                    placeholder="https://..."
                                />
                            </div>
                            <p className="text-[10px] text-gray-400">Cole o link de uma imagem do Unsplash ou similar.</p>
                        </div>

                        {/* Only show Plans if Sales Template */}
                        {config.template_type === 'sales' && (
                            <div className="border-t border-gray-100 dark:border-slate-800 pt-6">
                                <div className="flex justify-between items-center mb-4">
                                    <label className="text-xs font-black uppercase text-gray-500">Planos e Preços</label>
                                    <button onClick={addPlan} className="text-blue-600 text-xs font-bold flex items-center gap-1 hover:underline">
                                        <Plus size={12} /> Adicionar Plano
                                    </button>
                                </div>

                                <div className="space-y-4">
                                    {config.plans.map((plan, i) => (
                                        <div key={i} className="p-4 bg-gray-50 dark:bg-slate-800/50 rounded-xl border border-gray-100 dark:border-slate-700 relative group">
                                            <button
                                                onClick={() => setConfig(prev => ({ ...prev, plans: prev.plans.filter((_, idx) => idx !== i) }))}
                                                className="absolute top-2 right-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                            >
                                                <Trash2 size={14} />
                                            </button>

                                            <div className="grid grid-cols-2 gap-3 mb-3">
                                                <input
                                                    value={plan.name}
                                                    onChange={e => updatePlan(i, 'name', e.target.value)}
                                                    className="bg-white dark:bg-slate-900 p-2 rounded-lg text-sm font-bold border border-transparent focus:border-blue-500 outline-none"
                                                    placeholder="Nome do Plano"
                                                />
                                                <input
                                                    value={plan.price}
                                                    onChange={e => updatePlan(i, 'price', e.target.value)}
                                                    className="bg-white dark:bg-slate-900 p-2 rounded-lg text-sm font-bold text-emerald-600 border border-transparent focus:border-blue-500 outline-none"
                                                    placeholder="Preço"
                                                />
                                            </div>
                                            <textarea
                                                value={plan.features.join('\n')}
                                                onChange={e => updatePlan(i, 'features', e.target.value.split('\n'))}
                                                className="w-full bg-white dark:bg-slate-900 p-2 rounded-lg text-xs h-20 border border-transparent focus:border-blue-500 outline-none"
                                                placeholder="Lista de benefícios (um por linha)"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )} {/* End Content Tab */}

                {/* AUTHORITY TAB */}
                {activeTab === 'authority' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {/* Video URL */}
                        <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-dashed border-gray-300 dark:border-slate-700">
                            <div className="flex justify-between items-center">
                                <label className="text-sm font-bold flex items-center gap-2">
                                    <Video size={16} className="text-blue-500" /> Vídeo de Vendas (VSL)
                                </label>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" checked={config.show_video} onChange={e => setConfig({ ...config, show_video: e.target.checked })} className="sr-only peer" />
                                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                </label>
                            </div>
                            {config.show_video && (
                                <input
                                    type="text"
                                    placeholder="https://www.youtube.com/watch?v=..."
                                    value={config.video_url || ''}
                                    onChange={e => setConfig({ ...config, video_url: e.target.value })}
                                    className="w-full p-2 bg-white dark:bg-slate-900 rounded-lg text-xs border border-gray-200"
                                />
                            )}
                        </div>

                        {/* Stats */}
                        <div className="space-y-4">
                            <h4 className="text-xs font-black uppercase text-gray-500 flex items-center gap-2"><List size={14} /> Contador de Resultados</h4>
                            <div className="grid grid-cols-3 gap-2">
                                {config.stats?.map((stat, i) => (
                                    <div key={i} className="p-2 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-2">
                                        <input
                                            value={stat.value}
                                            onChange={e => {
                                                const newStats = [...(config.stats || [])];
                                                newStats[i].value = e.target.value;
                                                setConfig({ ...config, stats: newStats });
                                            }}
                                            className="w-full bg-transparent font-black text-center text-blue-600 outline-none"
                                            placeholder="5.000+"
                                        />
                                        <input
                                            value={stat.label}
                                            onChange={e => {
                                                const newStats = [...(config.stats || [])];
                                                newStats[i].label = e.target.value;
                                                setConfig({ ...config, stats: newStats });
                                            }}
                                            className="w-full bg-transparent text-[10px] uppercase font-bold text-center text-gray-400 outline-none"
                                            placeholder="Alunos"
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Teachers */}
                        <div className="space-y-4 pt-6 border-t border-gray-100 dark:border-slate-800">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-black uppercase text-gray-500 flex items-center gap-2">
                                    <GraduationCap size={14} /> Nossos Professores (Humanização)
                                </label>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" checked={config.show_teachers} onChange={e => setConfig({ ...config, show_teachers: e.target.checked })} className="sr-only peer" />
                                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                </label>
                            </div>

                            {config.show_teachers && (
                                <div className="space-y-3">
                                    {config.teachers?.map((teacher, i) => (
                                        <div key={i} className="bg-slate-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 relative group">
                                            <button onClick={() => setConfig(prev => ({ ...prev, teachers: prev.teachers?.filter((_, idx) => idx !== i) }))} className="absolute top-2 right-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={14} /></button>

                                            <div className="flex gap-4">
                                                <div className="w-12 h-12 bg-gray-200 rounded-full flex-shrink-0 overflow-hidden">
                                                    {teacher.photo ? <img src={teacher.photo} className="w-full h-full object-cover" /> : <Users size={24} className="m-auto mt-3 text-gray-400" />}
                                                </div>
                                                <div className="flex-1 space-y-2">
                                                    <input
                                                        placeholder="Nome do Professor"
                                                        className="w-full bg-transparent font-bold text-sm outline-none"
                                                        value={teacher.name}
                                                        onChange={e => {
                                                            const newTeachers = [...(config.teachers || [])];
                                                            newTeachers[i].name = e.target.value;
                                                            setConfig({ ...config, teachers: newTeachers });
                                                        }}
                                                    />
                                                    <input
                                                        placeholder="Breve Bio (ex: 5 anos de experiência)"
                                                        className="w-full bg-transparent text-xs text-gray-500 outline-none"
                                                        value={teacher.bio}
                                                        onChange={e => {
                                                            const newTeachers = [...(config.teachers || [])];
                                                            newTeachers[i].bio = e.target.value;
                                                            setConfig({ ...config, teachers: newTeachers });
                                                        }}
                                                    />
                                                    <div className="flex items-center gap-2 bg-white dark:bg-slate-900 p-2 rounded-lg border border-gray-100 dark:border-slate-800">
                                                        <PlayCircle size={14} className="text-purple-500" />
                                                        <input
                                                            placeholder="URL do Áudio/Vídeo de Apresentação"
                                                            className="w-full bg-transparent text-[10px] outline-none"
                                                            value={teacher.media_url}
                                                            onChange={e => {
                                                                const newTeachers = [...(config.teachers || [])];
                                                                newTeachers[i].media_url = e.target.value;
                                                                setConfig({ ...config, teachers: newTeachers });
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    <button
                                        onClick={() => setConfig(prev => ({ ...prev, teachers: [...(prev.teachers || []), { name: '', bio: '', media_url: '' }] }))}
                                        className="w-full py-3 border-2 border-dashed border-gray-200 dark:border-slate-700 rounded-xl text-xs font-bold text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-all flex items-center justify-center gap-2"
                                    >
                                        <Plus size={14} /> Adicionar Professor
                                    </button>
                                </div>
                            )}
                        </div>

                    </div>
                )}

                {/* SOCIAL / BENEFITS TAB */}
                {activeTab === 'social' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {/* Benefits Repeater */}
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <input type="checkbox" checked={config.show_benefits} onChange={e => setConfig({ ...config, show_benefits: e.target.checked })} className="accent-blue-600 w-4 h-4 rounded cursor-pointer" />
                                <label className="text-xs font-black uppercase text-gray-500">Diferenciais Competitivos</label>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const suggestions = [
                                            { title: 'Metodologia Única', description: 'Foco total na sua evolução rápida.', icon: 'Zap' },
                                            { title: 'Suporte 24h', description: 'Tire dúvidas a qualquer momento.', icon: 'MessageSquare' },
                                            { title: 'Certificado Incluso', description: 'Reconhecido em todo o mercado.', icon: 'Award' }
                                        ];
                                        setConfig(prev => ({ ...prev, benefits: [...(prev.benefits || []), ...suggestions] }));
                                    }}
                                    className="text-purple-600 text-[10px] font-black uppercase tracking-wider flex items-center gap-1 hover:bg-purple-50 px-2 py-1 rounded-lg transition-colors"
                                >
                                    <Sparkles size={12} /> Gerar com IA
                                </button>
                                <button onClick={() => setConfig(prev => ({ ...prev, benefits: [...(prev.benefits || []), { title: 'Novo Item', description: 'Descrição...', icon: 'CheckCircle' }] }))} className="text-blue-600 text-[10px] font-bold uppercase tracking-wider hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors">+ Adicionar</button>
                            </div>
                        </div>
                        {config.benefits?.map((item, i) => (
                            <div key={i} className="p-3 border border-gray-100 dark:border-slate-800 rounded-xl relative group bg-white dark:bg-slate-900">
                                <button onClick={() => setConfig(prev => ({ ...prev, benefits: prev.benefits?.filter((_, idx) => idx !== i) }))} className="absolute top-2 right-2 text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
                                <div className="space-y-2 pr-6">
                                    <input value={item.title} onChange={e => {
                                        const nb = [...(config.benefits || [])]; nb[i].title = e.target.value; setConfig({ ...config, benefits: nb });
                                    }} className="w-full font-bold text-sm bg-transparent outline-none" placeholder="Título" />
                                    <textarea value={item.description} onChange={e => {
                                        const nb = [...(config.benefits || [])]; nb[i].description = e.target.value; setConfig({ ...config, benefits: nb });
                                    }} className="w-full text-xs text-gray-500 bg-transparent outline-none resize-none" placeholder="Descrição" />
                                </div>
                            </div>
                        ))}

                        {/* Testimonials Repeater */}
                        <div className="border-t pt-6 mt-6 border-dashed">
                            <div className="flex justify-between items-center mb-4">
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={config.show_testimonials} onChange={e => setConfig({ ...config, show_testimonials: e.target.checked })} className="accent-blue-600 w-4 h-4 rounded cursor-pointer" />
                                    <label className="text-xs font-black uppercase text-gray-500">Depoimentos</label>
                                </div>
                                <button onClick={() => setConfig(prev => ({ ...prev, testimonials: [...(prev.testimonials || []), { name: 'Aluno', role: 'Estudante', text: 'Depoimento...', photo: '' }] }))} className="text-blue-600 text-[10px] font-bold">+ Adicionar</button>
                            </div>
                            {config.testimonials?.map((t, i) => (
                                <div key={i} className="mb-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-2 relative border border-gray-100 dark:border-slate-700">
                                    <button onClick={() => setConfig(prev => ({ ...prev, testimonials: prev.testimonials?.filter((_, idx) => idx !== i) }))} className="absolute top-2 right-2 text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
                                    <input value={t.name} onChange={e => { const nt = [...(config.testimonials || [])]; nt[i].name = e.target.value; setConfig({ ...config, testimonials: nt }) }} className="w-full font-bold text-xs bg-transparent outline-none" placeholder="Nome do Aluno" />
                                    <input value={t.role} onChange={e => { const nt = [...(config.testimonials || [])]; nt[i].role = e.target.value; setConfig({ ...config, testimonials: nt }) }} className="w-full text-[10px] uppercase text-gray-400 bg-transparent outline-none" placeholder="Cargo / Resultado" />
                                    <textarea value={t.text} onChange={e => { const nt = [...(config.testimonials || [])]; nt[i].text = e.target.value; setConfig({ ...config, testimonials: nt }) }} className="w-full text-xs bg-white dark:bg-slate-900 p-2 rounded border border-gray-100 outline-none" placeholder="Depoimento..." rows={2} />
                                </div>
                            ))}
                        </div>

                        {/* Trusted Companies */}
                        <div className="border-t pt-6 mt-6 border-dashed border-gray-100 dark:border-slate-800">
                            <div className="flex justify-between items-center mb-4">
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={config.show_company_logos} onChange={e => setConfig({ ...config, show_company_logos: e.target.checked })} className="accent-blue-600 w-4 h-4 rounded cursor-pointer" />
                                    <label className="text-xs font-black uppercase text-gray-500">Selo de Confiança (Logos)</label>
                                </div>
                                <button onClick={() => setConfig(prev => ({ ...prev, company_logos: [...(prev.company_logos || []), ''] }))} className="text-blue-600 text-[10px] font-bold">+ Adicionar Logo</button>
                            </div>

                            {config.show_company_logos && (
                                <div className="grid grid-cols-2 gap-2">
                                    {config.company_logos?.map((url, i) => (
                                        <div key={i} className="flex gap-2">
                                            <input
                                                className="w-full bg-slate-50 dark:bg-slate-800 p-2 rounded-lg text-xs border border-gray-100 dark:border-slate-700 outline-none"
                                                placeholder="URL da Logo (png/svg)"
                                                value={url}
                                                onChange={e => {
                                                    const newLogos = [...(config.company_logos || [])];
                                                    newLogos[i] = e.target.value;
                                                    setConfig({ ...config, company_logos: newLogos });
                                                }}
                                            />
                                            <button onClick={() => setConfig(prev => ({ ...prev, company_logos: prev.company_logos?.filter((_, idx) => idx !== i) }))} className="text-gray-400 hover:text-red-500 bg-slate-50 dark:bg-slate-800 p-2 rounded-lg border border-gray-100 dark:border-slate-700">
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                    </div>
                )}

                {/* SEGMENTS / FAQ TAB */}
                {activeTab === 'segments' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {/* Target Audience */}
                        <div>
                            <div className="flex justify-between items-center mb-2">
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={config.show_target_audience} onChange={e => setConfig({ ...config, show_target_audience: e.target.checked })} className="accent-blue-600 w-4 h-4 rounded cursor-pointer" />
                                    <label className="text-xs font-black uppercase text-gray-500">Público Alvo (Quem é?)</label>
                                </div>
                                <button onClick={() => setConfig(prev => ({ ...prev, target_audience: [...(prev.target_audience || []), { title: 'Perfil', description: 'Para quem...', icon: 'User' }] }))} className="text-blue-600 text-[10px] font-bold">+ Adicionar</button>
                            </div>
                            <div className="space-y-2">
                                {config.target_audience?.map((item, i) => (
                                    <div key={i} className="flex gap-2 p-2 border rounded-lg bg-white dark:bg-slate-900 items-center group">
                                        <div className="flex-1">
                                            <input value={item.title} onChange={e => { const n = [...(config.target_audience || [])]; n[i].title = e.target.value; setConfig({ ...config, target_audience: n }) }} className="font-bold text-xs w-full bg-transparent outline-none" placeholder="Ex: Viajantes" />
                                            <input value={item.description} onChange={e => { const n = [...(config.target_audience || [])]; n[i].description = e.target.value; setConfig({ ...config, target_audience: n }) }} className="text-[10px] w-full bg-transparent text-gray-500 outline-none" placeholder="Descrição..." />
                                        </div>
                                        <button onClick={() => setConfig(prev => ({ ...prev, target_audience: prev.target_audience?.filter((_, idx) => idx !== i) }))} className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* FAQ */}
                        <div className="border-t pt-6 border-dashed">
                            <div className="flex justify-between items-center mb-2">
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={config.show_faq} onChange={e => setConfig({ ...config, show_faq: e.target.checked })} className="accent-blue-600 w-4 h-4 rounded cursor-pointer" />
                                    <label className="text-xs font-black uppercase text-gray-500">Perguntas Frequentes (FAQ)</label>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const suggestions = [
                                                { question: 'Qual a duração do curso?', answer: 'Depende do seu ritmo, mas a média é 18 meses.' },
                                                { question: 'Posso cancelar quando quiser?', answer: 'Sim, não temos fidelidade.' }
                                            ];
                                            setConfig(prev => ({ ...prev, faq: [...(prev.faq || []), ...suggestions] }));
                                        }}
                                        className="text-purple-600 text-[10px] font-black uppercase tracking-wider flex items-center gap-1 hover:bg-purple-50 px-2 py-1 rounded-lg transition-colors"
                                    >
                                        <Sparkles size={12} /> Gerar com IA
                                    </button>
                                    <button onClick={() => setConfig(prev => ({ ...prev, faq: [...(prev.faq || []), { question: 'Pergunta?', answer: 'Resposta...' }] }))} className="text-blue-600 text-[10px] font-bold">+ Adicionar</button>
                                </div>
                            </div>
                            <div className="space-y-3">
                                {config.faq?.map((item, i) => (
                                    <div key={i} className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-2 relative group border border-gray-100 dark:border-slate-700">
                                        <button onClick={() => setConfig(prev => ({ ...prev, faq: prev.faq?.filter((_, idx) => idx !== i) }))} className="absolute top-2 right-2 text-gray-300 hover:text-red-500"><Trash2 size={12} /></button>
                                        <input value={item.question} onChange={e => { const n = [...(config.faq || [])]; n[i].question = e.target.value; setConfig({ ...config, faq: n }) }} className="font-bold text-xs w-full bg-transparent border-b border-dashed border-gray-200 pb-1 mb-1 outline-none" placeholder="Pergunta" />
                                        <textarea value={item.answer} onChange={e => { const n = [...(config.faq || [])]; n[i].answer = e.target.value; setConfig({ ...config, faq: n }) }} className="text-xs w-full bg-transparent resize-none outline-none text-gray-500" rows={2} placeholder="Resposta" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Preview Panel */}
            <div className="w-full lg:w-1/2 bg-gray-100 dark:bg-black p-0 flex flex-col items-center justify-center relative overflow-hidden h-[800px] lg:h-auto">
                <div className="absolute top-4 right-4 z-[60] bg-black/80 text-white px-4 py-2 rounded-full text-[10px] font-black uppercase backdrop-blur-md flex items-center gap-2 border border-white/10 shadow-xl">
                    <Globe size={12} className={config.template_type === 'free_lesson' ? "text-emerald-400" : config.template_type === 'high_conversion' ? "text-red-400" : "text-blue-400"} />
                    Preview {config.template_type === 'free_lesson' ? 'Aula Grátis' : config.template_type === 'high_conversion' ? 'Alta Conversão' : 'Premium'}
                </div>

                <div className="w-full h-full">
                    {config.template_type === 'free_lesson' ? (
                        <FreeLessonLandingPreview
                            headline={config.headline}
                            subheadline={config.subheadline}
                            heroImage={config.heroImage}
                            ctaText={config.ctaText}
                        />
                    ) : config.template_type === 'high_conversion' ? (
                        <HighConversionLandingPreview
                            headline={config.headline}
                            subheadline={config.subheadline}
                            heroImage={config.heroImage}
                            ctaText={config.ctaText}
                            videoUrl={config.show_video ? config.video_url : undefined}
                            stats={config.stats}
                            benefits={config.show_benefits ? config.benefits : undefined}
                            targetAudience={config.show_target_audience ? config.target_audience : undefined}
                            testimonials={config.show_testimonials ? config.testimonials : undefined}
                            faq={config.show_faq ? config.faq : undefined}
                        />
                    ) : (
                        <PremiumLandingPreview
                            headline={config.headline}
                            subheadline={config.subheadline}
                            heroImage={config.heroImage}
                            ctaText={config.ctaText}
                            plans={config.plans}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

export default LandingPageEditor;
