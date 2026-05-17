import React from 'react';
import { AlertCircle, Lock, externalLink } from 'lucide-react';
import { User } from '../types';

interface SuspensionPageProps {
    user: User;
    onLogout: () => void;
}

const SuspensionPage: React.FC<SuspensionPageProps> = ({ user, onLogout }) => {
    return (
        <div className="min-h-screen bg-brand-surface-2 dark:bg-brand-surface flex flex-col items-center justify-center p-4 font-sans">
            <div className="bg-brand-surface dark:bg-brand-surface-2 rounded-2xl shadow-xl max-w-md w-full p-8 text-center border border-brand-border">
                <div className="w-20 h-20 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
                    <Lock size={40} className="text-rose-600 dark:text-rose-500" />
                </div>

                <h1 className="text-2xl font-black text-brand-text mb-2">
                    Acesso Temporariamente Suspenso
                </h1>

                <p className="text-brand-muted dark:text-brand-muted mb-8 leading-relaxed">
                    Identificamos uma pendência financeira em sua conta superior ao prazo de tolerância de 7 dias. Para continuar acessando suas aulas e materiais, por favor regularize sua mensalidade.
                </p>

                <div className="bg-brand-surface-2 dark:bg-brand-surface p-4 rounded-xl border border-brand-border dark:border-brand-border mb-8 text-left">
                    <div className="flex items-center gap-3 mb-2">
                        <AlertCircle size={18} className="text-amber-500" />
                        <span className="font-bold text-brand-text dark:text-slate-300 text-sm">Status Atual:</span>
                    </div>
                    <p className="text-xs text-brand-muted dark:text-brand-muted pl-8">
                        Seu acesso será liberado automaticamente assim que o pagamento for confirmado pelo banco.
                    </p>
                </div>

                <div className="space-y-3">
                    <a
                        href="https://www.asaas.com/segunda-via"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-3 bg-tenant-primary hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/20 transition-all flex items-center justify-center gap-2"
                    >
                        Pagar Agora / 2ª Via
                    </a>

                    <button
                        onClick={onLogout}
                        className="w-full py-3 bg-transparent text-brand-muted hover:text-brand-text dark:text-brand-muted dark:hover:text-slate-200 font-bold text-sm transition-colors"
                    >
                        Sair da Conta
                    </button>
                </div>
            </div>

            <p className="mt-8 text-xs text-brand-muted">
                Dúvidas? Entre em contato com a secretaria da escola.
            </p>
        </div>
    );
};

export default SuspensionPage;
