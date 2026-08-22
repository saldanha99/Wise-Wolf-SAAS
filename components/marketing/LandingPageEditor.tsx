import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Save, Globe, Loader2, Plus, Trash2, LayoutTemplate, GraduationCap, Wand2, Sparkles, Rocket, Video, MessageSquare, Users, Target, HelpCircle, List, CheckCircle, PlayCircle, Send } from 'lucide-react';
import PremiumLandingPreview from './PremiumLandingPreview';
import FreeLessonLandingPreview from './FreeLessonLandingPreview';
import HighConversionLandingPreview from './HighConversionLandingPreview';
import confetti from 'canvas-confetti';
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
    const [publishing, setPublishing] = useState(false);
    const [optimizingField, setOptimizingField] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'content' | 'authority' | 'social' | 'segments'>('content');
    const [previewDevice, setPreviewDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
    const [isFullScreen, setIsFullScreen] = useState(false);

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsFullScreen(false);
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, []);

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

    const handleSave = async (silent = false) => {
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

            const { error } = config.id
                ? await supabase
                    .from('landing_page_configs')
                    .update(payload)
                    .eq('id', config.id)
                : await supabase
                    .from('landing_page_configs')
                    .insert(payload);

            if (error) throw error;
            if (!silent) {
                alert("Página salva com sucesso!");
                fetchConfig();
            }
        } catch (error: any) {
            console.error(error);
            alert("Erro ao salvar: " + error.message);
        } finally {
            setSaving(false);
        }
    };

    const handlePublish = async () => {
        setPublishing(true);
        // 1. Save first
        await handleSave(true);

        // 2. Simulate Publish (In real world, maybe copy to a CDN or updates DNS/Status)
        // Here we just celebrate
        setTimeout(() => {
            setPublishing(false);
            confetti({
                particleCount: 200,
                spread: 100,
                origin: { y: 0.6 }
            });
            alert("🚀 Site Publicado com Sucesso!\n\nAgora seus alunos já podem acessar a nova versão.");
        }, 1000);
    };

    const handleLeadCapture = async (data: any) => {
        // Validation: Ensure Tenant ID
        if (!tenantId) {
            alert("Erro: Tenant ID não encontrado. Recarregue a página.");
            return;
        }

        // Validation: Ensure minimal contact info
        if (!data.email && !data.phone) {
            alert("Por favor, preencha pelo menos E-mail ou Telefone.");
            return;
        }

        // Preview Functionality: Insert Lead into CRM
        try {
            const { error } = await supabase.from('crm_leads').insert({
                name: data.name || 'Teste Preview',
                email: data.email || null,
                phone: data.phone || null,
                tenant_id: tenantId,
                status: 'NEW',
                source: `preview_${config.template_type}`,
                notes: `Capturado no Preview: ${data.level ? data.level : ''} ${data.goal ? data.goal : ''}`.trim()
            });

            if (error) throw error;

            // Success Celebration
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: ['#22c55e', '#3b82f6', '#f59e0b']
            });
            alert("✅ Lead Capturado com Sucesso!\n\nVerifique o card na coluna 'Novos Leads' do CRM.");

        } catch (err: any) {
            console.error("Erro ao capturar lead no preview:", err);
            // Enhanced error message for user
            alert(`Erro ao salvar lead: ${err.message || 'Erro desconhecido'}. (Status: ${err.status || 'N/A'})`);
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
            <div className="w-full lg:w-1/2 p-6 overflow-y-auto border-r border-gray-100 dark:border-brand-border scrollbar-hide">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="font-bold text-gray-800 dark:text-white">Editor de Conteúdo</h3>
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleSave(false)}
                            disabled={saving}
                            className="bg-brand-surface border border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-brand-surface-2 dark:border-brand-border dark:text-gray-300 px-4 py-2 rounded-xl font-bold text-xs uppercase tracking-widest transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Salvar
                        </button>
                        <button
                            onClick={handlePublish}
                            disabled={publishing || saving}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-emerald-700 transition-all disabled:opacity-50 shadow-lg shadow-emerald-200"
                        >
                            {publishing ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                            Publicar
                        </button>
                    </div>
                </div>

                {/* Template Selector */}
                <div className="mb-8">
                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 block">Escolha o Template</label>
                    <div className="grid grid-cols-3 gap-3">
                        <button
                            onClick={() => switchTemplate('high_conversion')}
                            className={`p-4 rounded-xl border-2 text-left transition-all ${config.template_type === 'high_conversion' ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-brand-border hover:border-gray-200'}`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center mb-2">
                                <Rocket size={18} />
                            </div>
                            <span className="font-bold text-sm block text-gray-800 dark:text-white">Alta Conversão</span>
                        </button>

                        <button
                            onClick={() => switchTemplate('free_lesson')}
                            className={`p-4 rounded-xl border-2 text-left transition-all ${config.template_type === 'free_lesson' ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-brand-border hover:border-gray-200'}`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center mb-2">
                                <GraduationCap size={18} />
                            </div>
                            <span className="font-bold text-sm block text-gray-800 dark:text-white">Aula Grátis</span>
                        </button>

                        <button
                            onClick={() => switchTemplate('sales')}
                            className={`p-4 rounded-xl border-2 text-left transition-all ${config.template_type === 'sales' ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-brand-border hover:border-gray-200'}`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-green-100 text-green-600 flex items-center justify-center mb-2">
                                <List size={18} />
                            </div>
                            <span className="font-bold text-sm block text-gray-800 dark:text-white">Múltiplos Planos</span>
                        </button>
                    </div>
                </div>

                {/* Main Content Form */}
                <div className="space-y-6">
                    <div className="space-y-2">
                        <div className="flex justify-between">
                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Headline Principal</label>
                            <button onClick={() => optimizeCopy('headline')} disabled={!!optimizingField} className="text-xs text-blue-600 font-bold flex items-center gap-1 hover:underline">
                                {optimizingField === 'headline' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                Otimizar com IA
                            </button>
                        </div>
                        <textarea
                            value={config.headline}
                            onChange={(e) => setConfig({ ...config, headline: e.target.value })}
                            className="w-full p-4 rounded-xl border border-gray-200 dark:border-brand-border bg-gray-50 dark:bg-brand-surface-2 text-gray-900 dark:text-white font-bold text-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            rows={2}
                            placeholder="Promessa principal do seu site..."
                        />
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between">
                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Subheadline</label>
                            <button onClick={() => optimizeCopy('subheadline')} disabled={!!optimizingField} className="text-xs text-blue-600 font-bold flex items-center gap-1 hover:underline">
                                {optimizingField === 'subheadline' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                Otimizar
                            </button>
                        </div>
                        <textarea
                            value={config.subheadline}
                            onChange={(e) => setConfig({ ...config, subheadline: e.target.value })}
                            className="w-full p-4 rounded-xl border border-gray-200 dark:border-brand-border bg-gray-50 dark:bg-brand-surface-2 text-gray-600 dark:text-gray-300 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            rows={3}
                            placeholder="Explicação detalhada da oferta..."
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Texto do Botão (CTA)</label>
                            <div className="relative">
                                <input
                                    type="text"
                                    value={config.ctaText}
                                    onChange={(e) => setConfig({ ...config, ctaText: e.target.value })}
                                    className="w-full p-3 pl-10 rounded-xl border border-gray-200 dark:border-brand-border bg-gray-50 dark:bg-brand-surface-2 text-gray-900 dark:text-white font-bold focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                />
                                <Sparkles size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-500" />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">URL Imagem Hero</label>
                            <input
                                type="text"
                                value={config.heroImage}
                                onChange={(e) => setConfig({ ...config, heroImage: e.target.value })}
                                className="w-full p-3 rounded-xl border border-gray-200 dark:border-brand-border bg-gray-50 dark:bg-brand-surface-2 text-gray-600 dark:text-gray-300 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                placeholder="https://..."
                            />
                        </div>
                    </div>

                    <hr className="border-gray-100 dark:border-brand-border" />

                    {/* Additional Modules Tab */}
                    <div>
                        <div className="flex gap-2 mb-4 overflow-x-auto pb-2 scrollbar-none">
                            {['content', 'authority', 'social', 'segments'].map((tab: any) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${activeTab === tab ? 'bg-blue-100 text-blue-700' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                                >
                                    {tab === 'content' ? 'Conteúdo' : tab === 'authority' ? 'Autoridade' : tab === 'social' ? 'Prova Social' : 'Segmentos'}
                                </button>
                            ))}
                        </div>

                        {activeTab === 'authority' && (
                            <div className="space-y-4 animate-in fade-in slide-in-from-left-4">
                                <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="font-bold text-gray-700 flex items-center gap-2"><Video size={16} /> Vídeo de Vendas (VSL)</h4>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" checked={config.show_video} onChange={e => setConfig({ ...config, show_video: e.target.checked })} className="sr-only peer" />
                                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-brand-surface after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                        </label>
                                    </div>
                                    {config.show_video && (
                                        <input
                                            type="text"
                                            value={config.video_url}
                                            onChange={(e) => setConfig({ ...config, video_url: e.target.value })}
                                            className="w-full p-3 rounded-xl border border-gray-200 text-sm"
                                            placeholder="URL do Youtube/Vimeo/Wistia..."
                                        />
                                    )}
                                </div>

                                <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                                    <h4 className="font-bold text-gray-700 mb-2">Estatísticas de Autoridade</h4>
                                    <div className="grid grid-cols-3 gap-2">
                                        {config.stats?.map((stat, i) => (
                                            <div key={i} className="bg-brand-surface p-2 rounded border border-gray-100">
                                                <input value={stat.value} onChange={e => {
                                                    const newStats = [...(config.stats || [])];
                                                    newStats[i].value = e.target.value;
                                                    setConfig({ ...config, stats: newStats });
                                                }} className="w-full font-black text-blue-600 mb-1 text-center bg-transparent outline-none" placeholder="10k+" />
                                                <input value={stat.label} onChange={e => {
                                                    const newStats = [...(config.stats || [])];
                                                    newStats[i].label = e.target.value;
                                                    setConfig({ ...config, stats: newStats });
                                                }} className="w-full text-[10px] text-gray-400 text-center bg-transparent outline-none uppercase" placeholder="Alunos" />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === 'social' && (
                            <div className="space-y-4 animate-in fade-in slide-in-from-left-4">
                                <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="font-bold text-gray-700 flex items-center gap-2"><Users size={16} /> Depoimentos</h4>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" checked={config.show_testimonials} onChange={e => setConfig({ ...config, show_testimonials: e.target.checked })} className="sr-only peer" />
                                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-brand-surface after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                        </label>
                                    </div>
                                    <p className="text-xs text-gray-400">Edição de depoimentos em breve. Exibindo placeholders.</p>
                                </div>
                            </div>
                        )}

                        {activeTab === 'segments' && (
                            <div className="space-y-4 animate-in fade-in slide-in-from-left-4">
                                <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="font-bold text-gray-700 flex items-center gap-2"><Target size={16} /> Público Alvo</h4>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" checked={config.show_target_audience} onChange={e => setConfig({ ...config, show_target_audience: e.target.checked })} className="sr-only peer" />
                                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-brand-surface after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                        </label>
                                    </div>
                                    <div className="space-y-2">
                                        {config.target_audience?.map((item, i) => (
                                            <div key={i} className="flex gap-2 bg-brand-surface p-2 rounded border border-gray-100">
                                                <input value={item.title} onChange={e => {
                                                    const newArr = [...(config.target_audience || [])];
                                                    newArr[i].title = e.target.value;
                                                    setConfig({ ...config, target_audience: newArr });
                                                }} className="font-bold text-xs text-brand-text w-1/3 outline-none" />
                                                <input value={item.description} onChange={e => {
                                                    const newArr = [...(config.target_audience || [])];
                                                    newArr[i].description = e.target.value;
                                                    setConfig({ ...config, target_audience: newArr });
                                                }} className="text-xs text-brand-muted w-full outline-none" />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    {/* End Additional Modules */}

                    {config.template_type === 'sales' && (
                        <div className="space-y-4">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Planos de Preço</label>
                                <button onClick={addPlan} className="text-xs font-bold text-blue-600 hover:bg-blue-50 px-2 py-1 rounded flex items-center gap-1 transition-colors">
                                    <Plus size={14} /> Adicionar Plano
                                </button>
                            </div>

                            {config.plans.map((plan, index) => (
                                <div key={index} className="p-4 rounded-xl border border-gray-200 dark:border-brand-border bg-brand-surface group relative">
                                    <button
                                        onClick={() => {
                                            const newPlans = config.plans.filter((_, i) => i !== index);
                                            setConfig({ ...config, plans: newPlans });
                                        }}
                                        className="absolute top-2 right-2 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all p-1"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                    <div className="grid grid-cols-2 gap-4 mb-2">
                                        <input
                                            type="text"
                                            value={plan.name}
                                            onChange={(e) => updatePlan(index, 'name', e.target.value)}
                                            className="font-bold text-gray-800 dark:text-white bg-transparent border-b border-gray-100 dark:border-brand-border outline-none pb-1"
                                            placeholder="Nome do Plano"
                                        />
                                        <input
                                            type="text"
                                            value={plan.price}
                                            onChange={(e) => updatePlan(index, 'price', e.target.value)}
                                            className="font-bold text-gray-800 dark:text-white bg-transparent border-b border-gray-100 dark:border-brand-border outline-none pb-1 text-right"
                                            placeholder="R$ 00,00"
                                        />
                                    </div>
                                    <textarea
                                        value={plan.features.join('\n')}
                                        onChange={(e) => updatePlan(index, 'features', e.target.value.split('\n'))}
                                        className="w-full text-xs text-gray-500 bg-gray-50 dark:bg-brand-surface-2 p-2 rounded outline-none resize-none"
                                        rows={3}
                                        placeholder="Lista de benefícios (um por linha)"
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Preview Panel with Advanced Features */}
            <div className={`
                transition-all duration-300 bg-gray-100 dark:bg-black relative overflow-hidden flex flex-col items-center
                ${isFullScreen ? 'fixed inset-0 z-[200]' : 'w-full lg:w-1/2 h-[50vh] lg:h-full'}
            `}>
                {/* Preview Toolbar */}
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-brand-surface/10 backdrop-blur-md p-1.5 rounded-full z-20 flex items-center gap-2 border border-white/20 shadow-xl">
                    <button
                        onClick={() => setPreviewDevice('mobile')}
                        className={`p-2 rounded-full transition-all ${previewDevice === 'mobile' ? 'bg-brand-surface text-black shadow-sm' : 'text-white hover:bg-brand-surface/10'}`}
                        title="Mobile Phone"
                    >
                        <div className="w-3 h-5 border-[1.5px] border-current rounded-sm" />
                    </button>
                    <button
                        onClick={() => setPreviewDevice('tablet')}
                        className={`p-2 rounded-full transition-all ${previewDevice === 'tablet' ? 'bg-brand-surface text-black shadow-sm' : 'text-white hover:bg-brand-surface/10'}`}
                        title="Tablet"
                    >
                        <div className="w-4 h-5 border-[1.5px] border-current rounded-sm" />
                    </button>
                    <button
                        onClick={() => setPreviewDevice('desktop')}
                        className={`p-2 rounded-full transition-all ${previewDevice === 'desktop' ? 'bg-brand-surface text-black shadow-sm' : 'text-white hover:bg-brand-surface/10'}`}
                        title="Desktop"
                    >
                        <div className="w-6 h-4 border-[1.5px] border-current rounded-sm" />
                    </button>

                    <div className="w-px h-4 bg-brand-surface/20 mx-1" />

                    <button
                        onClick={() => setIsFullScreen(!isFullScreen)}
                        className={`p-2 rounded-full transition-all ${isFullScreen ? 'bg-brand-surface text-black shadow-sm' : 'text-white hover:bg-brand-surface/10'}`}
                        title={isFullScreen ? "Exit Full Screen" : "Full Screen"}
                    >
                        {isFullScreen ? (
                            <div className="w-4 h-4 border-[1.5px] border-current rounded-sm flex items-center justify-center">
                                <div className="w-2 h-0.5 bg-current" />
                            </div>
                        ) : (
                            <div className="w-4 h-4 border-[1.5px] border-dashed border-current rounded-sm" />
                        )}
                    </button>
                </div>

                {/* Device Frame Wrapper */}
                <div className={`
                    h-full transition-all duration-500 ease-in-out shadow-2xl overflow-hidden bg-brand-surface
                    ${previewDevice === 'mobile' ? 'w-[375px] my-4 rounded-[40px] border-[8px] border-gray-900' : ''}
                    ${previewDevice === 'tablet' ? 'w-[768px] my-4 rounded-[24px] border-[8px] border-gray-900' : ''}
                    ${previewDevice === 'desktop' ? 'w-full h-full' : ''}
                `}>
                    {/* Component Rendering */}
                    <div className="w-full h-full overflow-y-auto scrollbar-hide">
                        {config.template_type === 'free_lesson' ? (
                            <FreeLessonLandingPreview
                                headline={config.headline}
                                subheadline={config.subheadline}
                                heroImage={config.heroImage}
                                ctaText={config.ctaText}
                                tenantId={tenantId}
                                onSubmit={handleLeadCapture}
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
                                onSubmit={handleLeadCapture}
                                previewDevice={previewDevice}
                            />
                        ) : (
                            <PremiumLandingPreview
                                headline={config.headline}
                                subheadline={config.subheadline}
                                heroImage={config.heroImage}
                                ctaText={config.ctaText}
                                plans={config.plans}
                                onSubmit={handleLeadCapture}
                            />
                        )}
                    </div>
                </div>

                {/* Exit Button Message for Full Screen */}
                {isFullScreen && (
                    <button
                        onClick={() => setIsFullScreen(false)}
                        className="absolute top-4 right-4 bg-black/50 hover:bg-black text-white px-4 py-2 rounded-full text-xs font-bold transition-all backdrop-blur-md"
                    >
                        Sair (Esc)
                    </button>
                )}
            </div>
        </div>
    );
};

export default LandingPageEditor;
