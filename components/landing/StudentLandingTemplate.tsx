import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Loader2, CheckCircle } from 'lucide-react';
import PremiumLandingPreview from '../marketing/PremiumLandingPreview';
import FreeLessonLandingPreview from '../marketing/FreeLessonLandingPreview';
import HighConversionLandingPreview from '../marketing/HighConversionLandingPreview';

export default function StudentLandingTemplate() {
    const [config, setConfig] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [submitted, setSubmitted] = useState(false);

    useEffect(() => {
        // For demo purposes, we fetch the most recent landing page config
        // In production, this would use the subdomain: const subdomain = window.location.hostname.split('.')[0];
        const fetchConfig = async () => {
            try {
                const { data, error } = await supabase
                    .from('landing_page_configs')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (data) {
                    setConfig(data);
                }
            } catch (err) {
                console.error("Error loading LP:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchConfig();
    }, []);

    const handleLeadSubmit = async (formData: any) => {
        if (!config) return;

        try {
            // 1. Create Lead in CRM
            const { error } = await supabase.from('crm_leads').insert({
                name: formData.name || 'Lead Interest',
                email: formData.email,
                phone: formData.phone,
                tenant_id: config.tenant_id,
                status: 'NEW', // Enters the Kanban
                source: 'landing_page_high_conversion',
                notes: 'Cadastro via Página de Captura (Aula Experimental)'
            });

            if (error) throw error;

            // 2. Show Success
            setSubmitted(true);

            // Optional: Here we could trigger an automation webhook

        } catch (err) {
            console.error("Error submitting lead:", err);
            alert("Erro ao enviar. Tente novamente.");
        }
    };

    if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-blue-600" /></div>;

    if (submitted) {
        return (
            <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-6 text-center animate-in fade-in zoom-in duration-500">
                <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(34,197,94,0.6)]">
                    <CheckCircle size={40} className="text-white" />
                </div>
                <h1 className="text-4xl font-black mb-4">Parabéns! 🎉</h1>
                <p className="text-lg text-slate-300 max-w-md">
                    Sua aula experimental foi pré-agendada. Nossa equipe entrará em contato pelo WhatsApp em instantes para confirmar o horário.
                </p>
                <button
                    onClick={() => window.location.reload()}
                    className="mt-8 text-sm font-bold text-slate-500 hover:text-white transition-colors"
                >
                    Voltar para o início
                </button>
            </div>
        );
    }

    if (!config) return <div className="p-10 text-center">Nenhuma configuração encontrada.</div>;

    // Render the chosen template
    // If no type is set, default to 'sales'
    const type = config.template_type || 'sales';

    if (type === 'high_conversion') {
        return (
            <HighConversionLandingPreview
                headline={config.headline}
                subheadline={config.subheadline}
                heroImage={config.hero_image} // Note snake_case from DB
                ctaText={config.cta_text} // Note snake_case from DB
                onSubmit={handleLeadSubmit}
            />
        );
    }

    if (type === 'free_lesson') {
        return (
            <FreeLessonLandingPreview
                headline={config.headline}
                subheadline={config.subheadline}
                heroImage={config.hero_image}
                ctaText={config.cta_text}
            // FreeLessonLandingPreview might not have onSubmit yet, but assuming purely presentation for now or I'd update it too.
            />
        );
    }

    // Default 'sales'
    return (
        <PremiumLandingPreview
            headline={config.headline}
            subheadline={config.subheadline}
            heroImage={config.hero_image}
            ctaText={config.cta_text}
            plans={config.plans || []}
        />
    );
}
