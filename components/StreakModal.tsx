import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Flame, X } from 'lucide-react';

/**
 * Modal de ofensiva diária (estilo Duolingo).
 * Aparece 1x por dia ao abrir, mostrando o streak atual com chama animada.
 * Guard por localStorage (chave por usuário + dia).
 */
const StreakModal: React.FC<{ userId: string; streak: number }> = ({ userId, streak }) => {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!userId || streak <= 0) return;
        const hoje = new Date().toISOString().slice(0, 10);
        const key = `streak_modal_${userId}_${hoje}`;
        if (typeof window !== 'undefined' && !localStorage.getItem(key)) {
            const t = setTimeout(() => setOpen(true), 600); // pequeno delay ao entrar
            try { localStorage.setItem(key, '1'); } catch {}
            return () => clearTimeout(t);
        }
    }, [userId, streak]);

    // Dias da semana (marca os últimos consecutivos)
    const dias = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];
    const hojeIdx = (new Date().getDay() + 6) % 7; // segunda=0

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[300] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4"
                    onClick={() => setOpen(false)}
                >
                    <motion.div
                        initial={{ scale: 0.85, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.85, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 240, damping: 18 }}
                        className="relative bg-white dark:bg-slate-900 rounded-3xl max-w-sm w-full p-6 sm:p-8 text-center shadow-2xl max-h-[90dvh] overflow-y-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button onClick={() => setOpen(false)} className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800">
                            <X size={18} className="text-slate-400" />
                        </button>

                        {/* Chama gigante com número */}
                        <motion.div
                            className="relative mx-auto w-32 h-32 flex items-center justify-center mb-2"
                            animate={{ scale: [1, 1.08, 1] }}
                            transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                        >
                            <Flame size={120} className="text-orange-500" fill="#f97316" strokeWidth={1} />
                            <span className="absolute text-4xl font-black text-white drop-shadow-lg" style={{ marginTop: 8 }}>{streak}</span>
                        </motion.div>

                        <h2 className="text-3xl font-black text-orange-500">{streak} dia{streak > 1 ? 's' : ''} de ofensiva!</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
                            Continue praticando todos os dias para manter sua chama acesa. 🔥
                        </p>

                        {/* Semana */}
                        <div className="flex justify-center gap-2 mt-6">
                            {dias.map((d, i) => {
                                const ativo = i <= hojeIdx && i > hojeIdx - streak;
                                return (
                                    <div key={i} className="flex flex-col items-center gap-1">
                                        <span className="text-[10px] font-bold text-slate-400">{d}</span>
                                        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${ativo ? 'bg-orange-500' : 'bg-slate-100 dark:bg-slate-800'}`}>
                                            {ativo && <Flame size={13} className="text-white" fill="white" strokeWidth={0} />}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <button
                            onClick={() => setOpen(false)}
                            className="mt-7 w-full py-3.5 rounded-2xl bg-orange-500 text-white font-black text-sm uppercase tracking-wider hover:bg-orange-600 transition-colors"
                            style={{ boxShadow: '0 5px 0 #c2410c' }}
                        >
                            Continuar
                        </button>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default StreakModal;
