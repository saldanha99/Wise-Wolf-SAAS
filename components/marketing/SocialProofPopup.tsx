import React, { useEffect, useState } from 'react';
import { CheckCircle, X } from 'lucide-react';

const MOCK_SALES = [
    { name: 'Ricardo S.', location: 'São Paulo', time: 'há 2 min' },
    { name: 'Ana P.', location: 'Rio de Janeiro', time: 'há 15 min' },
    { name: 'Carlos M.', location: 'Belo Horizonte', time: 'há 45 min' },
    { name: 'Fernanda L.', location: 'Curitiba', time: 'há 1 hora' },
    { name: 'João V.', location: 'Brasília', time: 'há 2 horas' },
];

interface SocialProofPopupProps {
    sales?: { name: string; location: string; time: string }[];
}

export const SocialProofPopup: React.FC<SocialProofPopupProps> = ({ sales = MOCK_SALES }) => {
    const [visible, setVisible] = useState(false);
    const [currentSale, setCurrentSale] = useState(0);

    useEffect(() => {
        // Initial delay
        const initialTimer = setTimeout(() => setVisible(true), 3000);

        // Cyclic timer
        const interval = setInterval(() => {
            setVisible(false);
            setTimeout(() => {
                setCurrentSale(prev => (prev + 1) % sales.length);
                setVisible(true);
            }, 500); // Short wait while invisible to swap content
        }, 10000); // Show for X seconds then cycle (actually this cycles every 10s including visibility time)

        // Correction: We want it to stay for 5s, hide for 10s.
        // Let's use a simpler logic for now: Just toggle every 10s? 
        // No, let's keep it simple. It stays visible for 5s, then hides for 10s.

        return () => {
            clearTimeout(initialTimer);
            clearInterval(interval);
        };
    }, [sales]);

    // Better Timer Logic
    useEffect(() => {
        let hideTimer: NodeJS.Timeout;
        if (visible) {
            hideTimer = setTimeout(() => setVisible(false), 5000);
        } else {
            // When hidden, wait random time then show next
            hideTimer = setTimeout(() => {
                setCurrentSale(prev => (prev + 1) % sales.length);
                setVisible(true);
            }, Math.random() * 5000 + 5000); // 5-10s delay
        }
        return () => clearTimeout(hideTimer);
    }, [visible, sales.length]);

    return (
        <div className={`fixed bottom-4 left-4 z-50 transition-all duration-700 transform ${visible ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}`}>
            <div className="bg-white/95 backdrop-blur-md p-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-emerald-100 flex items-center gap-4 max-w-xs ring-1 ring-black/5">
                <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0 relative">
                    <CheckCircle size={24} strokeWidth={3} />
                    <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-20 animate-ping" />
                </div>
                <div>
                    <p className="text-xs font-bold text-slate-800 leading-tight mb-0.5">
                        <span className="text-emerald-600">{sales[currentSale].name}</span> de {sales[currentSale].location}
                    </p>
                    <p className="text-[10px] text-slate-500 font-medium leading-tight">
                        Agendou uma aula experimental <span className="text-slate-400">{sales[currentSale].time}</span>
                    </p>
                </div>
                <button
                    onClick={(e) => { e.stopPropagation(); setVisible(false); }}
                    className="absolute top-2 right-2 text-slate-300 hover:text-slate-500 transition-colors"
                >
                    <X size={12} />
                </button>
            </div>
        </div>
    );
};
