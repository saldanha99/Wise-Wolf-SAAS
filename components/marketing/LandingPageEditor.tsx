import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Save, Globe, Loader2, Plus, Trash2, LayoutTemplate, GraduationCap, Wand2, Sparkles, Rocket } from 'lucide-react';
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
        template_type: 'sales' // Default
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [optimizingField, setOptimizingField] = useState<string | null>(null);

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
                    template_type: data.template_type || 'sales' // Handle legacy data
                });
            } else if (error && error.code !== 'PGRST116') {
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
                template_type: config.template_type
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

                <div className="space-y-6">
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
