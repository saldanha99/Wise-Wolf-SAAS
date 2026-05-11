import React, { useState } from 'react';
import { Copy, Check, Link, DollarSign, BookOpen, Loader2 } from 'lucide-react';
import { APP_BASE_URL } from '../constants';
import { createSignedOffer } from '../services/offerService';

interface TeacherInviteGeneratorProps {
    tenantId: string;
}

const TeacherInviteGenerator: React.FC<TeacherInviteGeneratorProps> = ({ tenantId }) => {
    const [hourlyRate, setHourlyRate] = useState('16');
    const [subject, setSubject] = useState('');
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);

    const handleGenerate = async () => {
        if (!subject) {
            alert("Por favor, informe a especialidade/matéria.");
            return;
        }

        setGenerating(true);
        try {
            const payload = {
                hourlyRate: parseFloat(hourlyRate) || 16,
                subject,
                tenantId
            };

            const result = await createSignedOffer({
                kind: 'TEACHER_INVITE',
                payload,
                tenantId,
                expiresIn: '7d',
            });

            setGeneratedLink(result.url);
            setCopied(false);
        } catch (err) {
            console.error('Failed to generate signed link:', err);
            alert('Erro ao gerar link. Tente novamente.');
        } finally {
            setGenerating(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm">
            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2 mb-4">
                <Link size={18} className="text-tenant-primary" />
                Convidar Novo Professor
            </h3>

            <p className="text-sm text-gray-500 mb-6">
                Gere um link exclusivo para que o professor faça seu próprio cadastro com as condições pré-definidas.
            </p>

            <div className="space-y-4">
                {/* Inputs */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Valor da Hora (60 min)</label>
                        <div className="relative">
                            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                type="number"
                                value={hourlyRate}
                                onChange={e => setHourlyRate(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-slate-800 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        </div>
                        <p className="text-[10px] text-tenant-primary font-bold mt-1 ml-1 animate-pulse">
                            Equivale a R$ {(parseFloat(hourlyRate || '0') / 2).toFixed(2)} por aula de 30 min.
                        </p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Especialidade / Tag</label>
                        <div className="relative">
                            <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                type="text"
                                placeholder="Ex: Inglês, Espanhol..."
                                value={subject}
                                onChange={e => setSubject(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-slate-800 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        </div>
                    </div>
                </div>

                {/* Action Button */}
                <button
                    onClick={handleGenerate}
                    className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold uppercase tracking-widest text-xs hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20"
                >
                    Gerar Link de Admissão
                </button>

                {/* Result */}
                {generatedLink && (
                    <div className="mt-4 animate-in fade-in slide-in-from-top-2">
                        <div className="p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl flex items-center gap-3">
                            <input
                                readOnly
                                value={generatedLink}
                                className="flex-1 bg-transparent text-xs font-mono text-gray-600 dark:text-slate-300 outline-none"
                            />
                            <button
                                onClick={handleCopy}
                                className={`p-2 rounded-lg transition-all ${copied ? 'bg-green-100 text-green-600' : 'bg-white shadow-sm text-gray-500 hover:text-tenant-primary'}`}
                            >
                                {copied ? <Check size={16} /> : <Copy size={16} />}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-2 text-center">
                            Este link contém a proposta de valor e expira em 48h.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TeacherInviteGenerator;
