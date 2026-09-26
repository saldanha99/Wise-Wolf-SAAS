import React, { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { AffiliatePanelData } from '../../lib/affiliateProgram';
import AffiliateProgramGuide from './AffiliateProgramGuide';

/** "Como funciona" no menu do afiliado — o guia com o cupom e a comissão dele. */
const AffiliateGuidePage: React.FC = () => {
    const [affiliate, setAffiliate] = useState<AffiliatePanelData['affiliate'] | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const { data } = await supabase.rpc('get_my_affiliate_panel');
            const record = data as (AffiliatePanelData & { ok?: boolean }) | null;
            if (!cancelled && record?.ok) setAffiliate(record.affiliate);
        })();
        return () => { cancelled = true; };
    }, []);

    return (
        <div className="mx-auto max-w-3xl space-y-6 py-2">
            <header>
                <h2 className="flex items-center gap-3 text-2xl font-black text-brand-text">
                    <BookOpen className="text-tenant-primary" size={26} /> Como funciona o programa
                </h2>
                <p className="mt-1 text-sm text-brand-muted">
                    Do cupom ao PIX: como a sua indicação vira comissão e quando você pode sacar.
                </p>
            </header>
            <AffiliateProgramGuide
                commissionCents={affiliate?.commission_cents}
                couponCode={affiliate?.affiliate_code}
                schoolName={affiliate?.school_name}
            />
        </div>
    );
};

export default AffiliateGuidePage;
