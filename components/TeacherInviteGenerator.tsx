import React, { useState } from 'react';
import { Copy, Check, Link, DollarSign, BookOpen } from 'lucide-react';
import { APP_BASE_URL } from '../constants';
import { supabase } from '../lib/supabase';
import { getSchoolInfo } from '../lib/schoolInfo';
import { getSchoolContractIdentity } from './ContractDocument';

interface TeacherInviteGeneratorProps {
    tenantId: string;
}

const TeacherInviteGenerator: React.FC<TeacherInviteGeneratorProps> = ({ tenantId }) => {
    const [hourlyRate, setHourlyRate] = useState('35');
    const [subject, setSubject] = useState('');
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');

    const handleGenerate = async () => {
        setGenerationError('');
        setGeneratedLink('');
        setCopied(false);
        if (!subject) {
            alert("Por favor, informe a especialidade/matéria.");
            return;
        }

        const parsedHourlyRate = Number(hourlyRate);
        if (!Number.isFinite(parsedHourlyRate) || parsedHourlyRate <= 0) {
            setGenerationError('Informe um valor de hora/aula válido.');
            return;
        }

        setGenerating(true);
        try {
            const configuredSchool = await getSchoolInfo(tenantId);
            const schoolIdentity = getSchoolContractIdentity(configuredSchool);
            if (!schoolIdentity.isReady) {
                setGenerationError(`Complete as configurações jurídicas antes de gerar o convite: ${schoolIdentity.missingFields.join(', ')}.`);
                return;
            }

            const payload = {
                kind: 'TEACHER_INVITE',
                hourlyRate: parsedHourlyRate,
                subject: subject.trim(),
                tenantId,
            };

            // O link leva apenas o offer_id. A RPC lê a identidade jurídica direto
            // do tenant ativo e congela o snapshot; o navegador não a envia.
            const { data: offerId, error } = await supabase.rpc('create_invite_offer', { p_kind: 'TEACHER_INVITE', p_payload: payload });
            if (error || !offerId) throw error || new Error('offer vazio');
            setGeneratedLink(`${APP_BASE_URL}/teacher-onboarding?offer=${offerId}`);
        } catch (e) {
            console.error('Não foi possível criar o convite seguro:', e);
            setGeneratedLink('');
            setGenerationError('Não foi possível gerar um convite seguro. Tente novamente; nenhum link legado foi criado.');
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
        <div className="bg-brand-surface p-6 rounded-2xl border border-gray-100 dark:border-brand-border shadow-sm">
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
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
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
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        </div>
                    </div>
                </div>

                {/* Action Button */}
                {generationError && (
                    <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-900">
                        {generationError}
                    </div>
                )}
                <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold uppercase tracking-widest text-xs hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20 disabled:cursor-wait disabled:opacity-50"
                >
                    {generating ? 'Validando configurações...' : 'Gerar Link de Admissão'}
                </button>

                {/* Result */}
                {generatedLink && (
                    <div className="mt-4 animate-in fade-in slide-in-from-top-2">
                        <div className="p-3 bg-gray-50 dark:bg-brand-surface-2 border border-gray-200 dark:border-brand-border rounded-xl flex items-center gap-3">
                            <input
                                readOnly
                                value={generatedLink}
                                className="flex-1 bg-transparent text-xs font-mono text-gray-600 dark:text-slate-300 outline-none"
                            />
                            <button
                                onClick={handleCopy}
                                className={`p-2 rounded-lg transition-all ${copied ? 'bg-green-100 text-green-600' : 'bg-brand-surface shadow-sm text-gray-500 hover:text-tenant-primary'}`}
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
