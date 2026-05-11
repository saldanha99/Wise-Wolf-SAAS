import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface AffiliateRedirectProps {
    code: string;
}

const AffiliateRedirect: React.FC<AffiliateRedirectProps> = ({ code }) => {
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const processClick = async () => {
            try {
                // 1. Verify if code exists
                const { data: codeData, error: fetchError } = await supabase
                    .from('affiliate_codes')
                    .select('id, tenant_id')
                    .eq('code', code)
                    .eq('active', true)
                    .single();

                if (fetchError || !codeData) {
                    throw new Error('Código de indicação inválido ou expirado.');
                }

                // 2. Log click (fire and forget)
                supabase.from('affiliate_clicks').insert({
                    affiliate_code: code,
                    referer_url: document.referrer || null,
                    // Note: In a real app we'd get IP from an Edge Function,
                    // but doing it from client side we just log the click basics.
                }).then();

                // 3. Redirect to the student landing page for that tenant
                // If you have a specific landing page per tenant, pass tenantId too
                window.location.replace(`/new-student?ref=${code}&tenant=${codeData.tenant_id}`);
            } catch (err: any) {
                console.error('Affiliate redirect error:', err);
                setError(err.message);
            }
        };

        processClick();
    }, [code]);

    if (error) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6">
                <div className="bg-white p-8 rounded-2xl shadow-xl text-center max-w-md">
                    <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">
                        ❌
                    </div>
                    <h2 className="text-xl font-bold text-slate-900 mb-2">Link Inválido</h2>
                    <p className="text-slate-500 mb-6">{error}</p>
                    <a href="/" className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors">
                        Ir para Início
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
            <Loader2 className="animate-spin text-indigo-500 mb-4" size={48} />
            <p className="text-slate-500 font-medium animate-pulse">Redirecionando você para a melhor escola...</p>
        </div>
    );
};

export default AffiliateRedirect;
