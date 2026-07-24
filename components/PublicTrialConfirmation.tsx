import React, { useEffect, useState } from 'react';
import { AlertCircle, CalendarDays, CheckCircle2, Clock, Loader2, UserRound } from 'lucide-react';
import { FUNCTIONS_URL } from '../lib/supabase';

type TrialDetails = {
    confirmed: boolean;
    conflict?: boolean;
    firstName: string;
    teacherName: string;
    schoolName: string;
    startsAt: string;
    dateLabel: string;
    timeLabel: string;
};

interface PublicTrialConfirmationProps {
    token: string | null;
    legacyOpportunityId: string | null;
}

const PublicTrialConfirmation: React.FC<PublicTrialConfirmationProps> = ({ token, legacyOpportunityId }) => {
    const [details, setDetails] = useState<TrialDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState('');

    const query = token
        ? `token=${encodeURIComponent(token)}`
        : `legacy=${encodeURIComponent(legacyOpportunityId || '')}`;

    useEffect(() => {
        if (!token && !legacyOpportunityId) {
            setError('Link de experimental inválido.');
            setLoading(false);
            return;
        }

        fetch(`${FUNCTIONS_URL}/confirm-vendor-trial?${query}`)
            .then(async (response) => {
                const body = await response.json();
                if (!response.ok || !body.ok) throw new Error(body.message || 'Link inválido ou expirado.');
                setDetails(body);
            })
            .catch((requestError: Error) => setError(requestError.message))
            .finally(() => setLoading(false));
    }, [legacyOpportunityId, query, token]);

    const confirm = async () => {
        setConfirming(true);
        setError('');
        try {
            const response = await fetch(`${FUNCTIONS_URL}/confirm-vendor-trial?${query}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            const body = await response.json();
            if (!response.ok || !body.ok) throw new Error(body.message || 'Não foi possível confirmar o horário.');
            setDetails(body);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : 'Não foi possível confirmar o horário.');
        } finally {
            setConfirming(false);
        }
    };

    return (
        <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-5 py-10">
            <section className="w-full max-w-md border border-slate-700 bg-slate-900 p-6 sm:p-8 shadow-2xl rounded-lg">
                <p className="text-xs font-bold uppercase text-emerald-400 mb-2">Wise Wolf Language School</p>
                <h1 className="text-2xl font-bold mb-6">Confirmação da aula experimental</h1>

                {loading && (
                    <div className="flex items-center gap-3 text-slate-300 py-8">
                        <Loader2 className="animate-spin" size={20} /> Carregando seu horário...
                    </div>
                )}

                {!loading && error && (
                    <div className="flex gap-3 border border-red-800 bg-red-950/40 p-4 rounded-md text-red-200">
                        <AlertCircle className="shrink-0" size={20} />
                        <p className="text-sm">{error}</p>
                    </div>
                )}

                {!loading && details && (
                    <div className="space-y-5">
                        <p className="text-slate-300">Olá, <strong className="text-white">{details.firstName}</strong>. Confira o horário reservado para você:</p>
                        <div className="border-y border-slate-700 divide-y divide-slate-700">
                            <div className="flex items-center gap-3 py-3"><CalendarDays size={18} className="text-emerald-400" /><span>{details.dateLabel}</span></div>
                            <div className="flex items-center gap-3 py-3"><Clock size={18} className="text-emerald-400" /><span>{details.timeLabel}</span></div>
                            <div className="flex items-center gap-3 py-3"><UserRound size={18} className="text-emerald-400" /><span>Professor(a) {details.teacherName}</span></div>
                        </div>

                        {details.confirmed ? (
                            <div className="flex gap-3 border border-emerald-700 bg-emerald-950/40 p-4 rounded-md text-emerald-200">
                                <CheckCircle2 className="shrink-0" size={21} />
                                <p className="text-sm font-semibold">Horário confirmado. A escola enviará os detalhes pelo WhatsApp.</p>
                            </div>
                        ) : details.conflict ? (
                            <div className="flex gap-3 border border-amber-700 bg-amber-950/40 p-4 rounded-md text-amber-100">
                                <AlertCircle className="shrink-0" size={20} />
                                <p className="text-sm">Esse horário acabou de ficar indisponível. Fale com a escola para escolher outro.</p>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={confirm}
                                disabled={confirming}
                                className="w-full h-12 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-bold rounded-md flex items-center justify-center gap-2 transition-colors"
                            >
                                {confirming ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle2 size={18} />}
                                Confirmar horário
                            </button>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
};

export default PublicTrialConfirmation;
