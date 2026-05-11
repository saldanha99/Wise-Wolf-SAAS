import React, { useState } from 'react';
import { Copy, Check, Link, Target, Users, Loader2 } from 'lucide-react';
import { APP_BASE_URL } from '../constants';
import { createSignedOffer } from '../services/offerService';

interface CommercialInviteGeneratorProps {
    tenantId: string;
}

const CommercialInviteGenerator: React.FC<CommercialInviteGeneratorProps> = ({ tenantId }) => {
    const [department, setDepartment] = useState('Vendas');
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);

    const handleGenerate = async () => {
        setGenerating(true);
        try {
            const payload = {
                role: 'COMMERCIAL',
                department,
                tenantId,
                timestamp: Date.now()
            };

            const result = await createSignedOffer({
                kind: 'COMMERCIAL_INVITE',
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
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm animate-in zoom-in-95 duration-300">
            <h3 className="text-xl font-black text-gray-800 dark:text-white flex items-center gap-3 mb-4">
                <Target size={24} className="text-tenant-primary" />
                Convidar Vendedor
            </h3>

            <p className="text-sm text-gray-500 dark:text-slate-400 mb-8 leading-relaxed">
                Gere um link de admissão exclusivo para o time comercial. O candidato preencherá seus próprios dados para criação da conta.
            </p>

            <div className="space-y-6">
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Setor / Departamento</label>
                    <div className="relative">
                        <Users className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Ex: Vendas, Expansão, SDR..."
                            value={department}
                            onChange={e => setDepartment(e.target.value)}
                            className="w-full pl-12 pr-4 py-4 bg-gray-50 dark:bg-slate-800 border-none rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary transition-all"
                        />
                    </div>
                </div>

                <button
                    onClick={handleGenerate}
                    className="w-full py-4 bg-tenant-primary text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:brightness-110 transition-all shadow-xl shadow-tenant-primary/20 flex items-center justify-center gap-2"
                >
                    <Link size={16} /> Gerar Link de Registro
                </button>

                {generatedLink && (
                    <div className="mt-6 animate-in fade-in slide-in-from-top-4 duration-500">
                        <label className="text-[10px] font-black uppercase tracking-widest text-emerald-500 ml-1 mb-2 block">Link Gerado com Sucesso</label>
                        <div className="p-4 bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/20 rounded-2xl flex items-center gap-3">
                            <input
                                readOnly
                                value={generatedLink}
                                className="flex-1 bg-transparent text-xs font-mono text-slate-600 dark:text-slate-300 outline-none"
                            />
                            <button
                                onClick={handleCopy}
                                className={`p-2.5 rounded-xl transition-all ${copied ? 'bg-green-500 text-white shadow-lg' : 'bg-white dark:bg-slate-800 shadow-sm text-gray-500 hover:text-tenant-primary'}`}
                            >
                                {copied ? <Check size={18} /> : <Copy size={18} />}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-3 text-center font-medium">
                            Este link é seguro e contém as permissões de acesso comercial.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CommercialInviteGenerator;
