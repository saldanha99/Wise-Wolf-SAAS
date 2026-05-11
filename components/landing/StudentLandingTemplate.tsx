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
    
    // PR7: OTP State
    const [otpMode, setOtpMode] = useState(false);
    const [prospectId, setProspectId] = useState<string | null>(null);
    const [otpCode, setOtpCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [otpError, setOtpError] = useState<string | null>(null);

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
        setOtpError(null);

        try {
            // Get referrer code from URL if exists
            const params = new URLSearchParams(window.location.search);
            const refCode = params.get('ref');

            // 1. Create Prospect and Generate OTP via RPC
            const { data: rpcResult, error: rpcError } = await supabase.rpc('request_prospect_otp', {
                p_full_name: formData.name || 'Lead Interest',
                p_email: formData.email,
                p_phone: formData.phone,
                p_tenant_id: config.tenant_id,
                p_referrer_code: refCode || null
            });

            if (rpcError) throw rpcError;
            if (rpcResult && !rpcResult.success) {
                throw new Error(rpcResult.error || 'Erro ao gerar código de verificação.');
            }

            // Also create CRM lead (legacy support for Kanban)
            supabase.from('crm_leads').insert({
                name: formData.name || 'Lead Interest',
                email: formData.email,
                phone: formData.phone,
                tenant_id: config.tenant_id,
                status: 'NEW',
                source: `landing_page_${config.template_type || 'sales'}`,
                notes: formData.notes || 'Cadastro via Página de Captura (Pendente Verificação)'
            }).then();

            // Transition to OTP screen
            setProspectId(rpcResult.prospect_id);
            setOtpMode(true);

        } catch (err: any) {
            console.error("Error submitting lead:", err);
            alert(err.message || "Erro ao enviar. Tente novamente.");
        }
    };

    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!prospectId || !otpCode) return;
        setVerifying(true);
        setOtpError(null);

        try {
            const { data: result, error } = await supabase.rpc('verify_prospect_otp', {
                p_prospect_id: prospectId,
                p_code: otpCode
            });

            if (error) throw error;
            if (result && !result.success) {
                if (result.error === 'INVALID_CODE') throw new Error('Código inválido. Tente novamente.');
                if (result.error === 'TOKEN_EXPIRED') throw new Error('Código expirado. Solicite um novo.');
                if (result.error === 'MAX_ATTEMPTS_REACHED') throw new Error('Muitas tentativas falhas. Solicite um novo código.');
                throw new Error(result.error || 'Erro na verificação.');
            }

            // Success
            setSubmitted(true);
            setOtpMode(false);
        } catch (err: any) {
            console.error("OTP Error:", err);
            setOtpError(err.message || "Erro ao verificar código.");
        } finally {
            setVerifying(false);
        }
    };

    if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-blue-600" /></div>;

    if (submitted) {
        return (
            <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-6 text-center animate-in fade-in zoom-in duration-500">
                <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(34,197,94,0.6)]">
                    <CheckCircle size={40} className="text-white" />
                </div>
                <h1 className="text-4xl font-black mb-4">Número Verificado! 🎉</h1>
                <p className="text-lg text-slate-300 max-w-md">
                    Sua solicitação foi confirmada com sucesso. Nossa equipe pedagógica entrará em contato pelo WhatsApp em instantes para agendar sua aula.
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

    if (otpMode) {
        return (
            <div className="h-screen flex flex-col items-center justify-center bg-slate-50 text-slate-900 p-6">
                <div className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full text-center">
                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
                        <span className="text-2xl">📱</span>
                    </div>
                    <h2 className="text-2xl font-black text-[#002366] mb-2">Verifique seu WhatsApp</h2>
                    <p className="text-slate-500 text-sm mb-8">
                        Enviamos um código de 6 dígitos para o número informado. Digite abaixo para confirmar seu interesse.
                    </p>

                    {otpError && (
                        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-xl text-sm font-medium border border-red-100">
                            {otpError}
                        </div>
                    )}

                    <form onSubmit={handleVerifyOtp} className="space-y-6">
                        <div>
                            <input
                                type="text"
                                maxLength={6}
                                value={otpCode}
                                onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                                className="w-full text-center text-4xl font-black tracking-[0.5em] py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none transition-all"
                                placeholder="000000"
                                required
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={verifying || otpCode.length !== 6}
                            className="w-full py-4 bg-[#D32F2F] hover:bg-[#b71c1c] disabled:opacity-50 text-white font-black rounded-xl shadow-lg transition-colors flex justify-center items-center"
                        >
                            {verifying ? <Loader2 className="animate-spin" /> : "Confirmar Código"}
                        </button>
                    </form>

                    <button 
                        onClick={() => { setOtpMode(false); setOtpCode(''); }}
                        className="mt-6 text-sm font-bold text-slate-400 hover:text-slate-600"
                    >
                        Voltar e corrigir número
                    </button>
                </div>
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
                tenantId={config.tenant_id}
                onSubmit={handleLeadSubmit}
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
            onSubmit={handleLeadSubmit}
        />
    );
}
