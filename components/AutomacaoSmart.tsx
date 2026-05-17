
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Smartphone, Plus, QrCode as QrIcon, CheckCircle, AlertCircle, RefreshCw, Key, UserCheck, Zap, Bell } from 'lucide-react';

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "d037768b3d06382756a0d9edecf3e40e";

const AutomacaoSmart: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<'IDLE' | 'SEARCHING' | 'CREATING' | 'QR_CODE' | 'SUCCESS' | 'ERROR'>('IDLE');
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [instanceId, setInstanceId] = useState('');
    const [feedback, setFeedback] = useState('');
    const [automationEnabled, setAutomationEnabled] = useState(false);
    const [userId, setUserId] = useState<string | null>(null);

    const headers = {
        'apikey': GLOBAL_API_KEY,
        'Content-Type': 'application/json'
    };

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                setUserId(user.id);
                // Fetch profile with error handling
                const { data, error } = await supabase
                    .from('profiles')
                    .select('date_automation_enabled, whatsapp_instance')
                    .eq('id', user.id)
                    .single();

                if (error) {
                    console.error("Error fetching automation settings:", error);
                    return;
                }

                if (data) {
                    setAutomationEnabled(data.date_automation_enabled || false);

                    // CRITICAL: Check if instance exists and update status
                    if (data.whatsapp_instance && data.whatsapp_instance.trim() !== '') {
                        console.log("Automation: Found existing instance:", data.whatsapp_instance);
                        setInstanceId(data.whatsapp_instance);
                        setStatus('SUCCESS');
                    }
                }
            }
        } catch (err) {
            console.error("Unexpected error in fetchSettings:", err);
        }
    };

    const toggleAutomation = async () => {
        if (!userId) return;
        const newValue = !automationEnabled;
        setAutomationEnabled(newValue); // Optimistic

        const { error } = await supabase.from('profiles').update({ date_automation_enabled: newValue }).eq('id', userId);
        if (error) {
            console.error(error);
            setAutomationEnabled(!newValue); // Rollback
            alert("Erro ao salvar preferência.");
        }
    };

    const handleCreate = async () => {
        setLoading(true);
        setFeedback('');
        setStatus('SEARCHING');

        try {
            // 1. OBTER USUÁRIO ATUAL (Sessão)
            const { data: { user } } = await supabase.auth.getUser();

            if (!user) {
                setFeedback("❌ Erro: Usuário não autenticado. Faça login novamente.");
                setStatus('ERROR');
                return;
            }

            // 2. RECUPERAR NOME PARA ID
            // Melhor usar o nome do usuário para gerar o ID legível
            const { data: profile } = await supabase.from('profiles').select('name').eq('id', user.id).single();
            const userName = profile?.name || 'admin';

            // 3. UNICIDADE (ANTI-COLISÃO)
            // Gera ID único: prof-daniela-9x2a
            const cleanName = userName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '-');
            const uniqueSuffix = Math.random().toString(36).substring(2, 6); // 4 chars
            const uniqueId = `prof-${cleanName}-${uniqueSuffix}`;
            setInstanceId(uniqueId);

            // 4. CRIAÇÃO (POST /instance/create)
            setStatus('CREATING');
            console.log(`🚀 Criando instância para ${userName}: ${uniqueId}`);

            const createRes = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    instanceName: uniqueId,
                    qrcode: false,
                    integration: 'WHATSAPP-BAILEYS'
                })
            });

            const createData = await createRes.json();

            // Recupera token (Hash)
            const token = createData?.hash?.apikey || createData?.hash || createData?.token;

            // Tratativa de Erro da API (ex: Instância já existe)
            if (!token && createData?.instance?.status !== 'created') {
                console.warn("API Warning:", createData);
            }

            // 5. PERSISTÊNCIA (Supabase)
            if (token) {
                console.log("💾 Salvando ID no seu Perfil...");
                const { error: dbError } = await supabase
                    .from('profiles')
                    .update({
                        whatsapp_instance: uniqueId, // Salva o ID técnico ÚNICO
                        whatsapp_token: token        // Salva o Token de Acesso
                    })
                    .eq('id', user.id); // VINCULA AO USUÁRIO LOGADO

                if (dbError) throw new Error(`Erro ao salvar no banco: ${dbError.message}`);
            }

            // 6. CONEXÃO (GET /instance/connect/{uniqueId})
            setStatus('QR_CODE');
            console.log(`🔗 Conectando: ${uniqueId}`);

            const connectRes = await fetch(`${EVOLUTION_API_URL}/instance/connect/${uniqueId}`, {
                method: 'GET',
                headers
            });

            const connectData = await connectRes.json();

            if (connectData?.base64) {
                setQrCode(connectData.base64);
            } else if (connectData?.instance?.state === 'open') {
                setFeedback(`✅ Conectado com Sucesso!\nInstância: ${uniqueId}`);
                setStatus('SUCCESS');
                setQrCode(null);
            } else {
                setFeedback("Aguardando Leitura do QR Code...");
            }

        } catch (error: any) {
            console.error("Erro no processo:", error);
            setFeedback(`❌ Erro: ${error.message || 'Falha desconhecida'}`);
            setStatus('ERROR');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="w-full max-w-md mx-auto bg-brand-surface p-8 rounded-[32px] shadow-lg border border-brand-border space-y-8">

            {/* Header */}
            <div className="flex items-center gap-3">
                <div className={`p-3 rounded-2xl ${status === 'SUCCESS' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' : 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600'}`}>
                    {status === 'SUCCESS' ? <CheckCircle size={24} /> : <UserCheck size={24} />}
                </div>
                <div>
                    <h2 className="text-xl font-bold text-brand-text">Conexão Pessoal</h2>
                    <p className="text-sm text-brand-muted">{status === 'SUCCESS' ? 'Vinculado com sucesso' : 'Vincular meu WhatsApp'}</p>
                </div>
            </div>

            {/* Automation Toggle */}
            <div className={`p-4 rounded-2xl border flex justify-between items-center group cursor-pointer transition-all ${automationEnabled ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-brand-surface-2/50 border-brand-border dark:border-brand-border'}`} onClick={toggleAutomation}>
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-full ${automationEnabled ? 'bg-brand-surface/20 text-white' : 'bg-slate-200 text-brand-muted'} transition-colors`}>
                        <Zap size={18} fill={automationEnabled ? "currentColor" : "none"} />
                    </div>
                    <div>
                        <p className={`text-sm font-bold ${automationEnabled ? 'text-white' : 'text-brand-text'}`}>Automação Matinal (6h)</p>
                        <p className={`text-xs ${automationEnabled ? 'text-emerald-100' : 'text-brand-muted'}`}>Enviar link da aula automaticamente?</p>
                    </div>
                </div>
                <div className={`w-12 h-6 rounded-full p-1 transition-all ${automationEnabled ? 'bg-brand-surface/30' : 'bg-slate-300'}`}>
                    <div className={`w-4 h-4 rounded-full bg-brand-surface shadow-sm transition-all transform ${automationEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                </div>
            </div>


            <div className="space-y-6">

                {status === 'SUCCESS' ? (
                    <div className="p-6 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800/30 flex flex-col items-center text-center animate-in fade-in zoom-in duration-500">
                        <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-full flex items-center justify-center mb-3">
                            <Smartphone size={32} />
                        </div>
                        <h3 className="font-bold text-brand-text text-lg">WhatsApp Conectado</h3>
                        <p className="text-sm text-brand-muted mt-1 mb-4">
                            Instância ativa: <span className="font-mono bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 rounded text-emerald-700 dark:text-emerald-400">{instanceId}</span>
                        </p>
                        <button
                            disabled
                            className="bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest opacity-80 cursor-default"
                        >
                            Sistema Operante
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="p-4 bg-brand-surface-2/50 rounded-xl border border-brand-border">
                            <p className="text-xs text-brand-muted leading-relaxed">
                                <strong className="text-brand-text dark:text-slate-300">Como funciona:</strong> Ao clicar no botão abaixo, criaremos uma conexão exclusiva para o seu usuário. Isso permitirá que você lance vagas e envie lembretes usando seu próprio número de WhatsApp.
                            </p>
                        </div>

                        {feedback && (
                            <div className={`p-4 rounded-xl text-sm font-medium flex items-start gap-2 ${status === 'ERROR' ? 'bg-red-50 text-red-600' :
                                status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-600' :
                                    'bg-blue-50 text-blue-600'
                                }`}>
                                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                                <span className="whitespace-pre-line">{feedback}</span>
                            </div>
                        )}

                        {qrCode && (
                            <div className="flex flex-col items-center p-6 bg-brand-surface border-2 border-slate-900 rounded-2xl animate-in zoom-in duration-300 shadow-xl">
                                <div className="mb-4 p-2 bg-brand-surface rounded-lg">
                                    <img src={qrCode} alt="QR Code" className="w-48 h-48 mix-blend-multiply" />
                                </div>
                                <p className="text-xs font-bold text-brand-text uppercase animate-pulse flex items-center gap-2">
                                    <Smartphone size={14} />
                                    Escaneie com seu WhatsApp
                                </p>
                            </div>
                        )}

                        <button
                            onClick={handleCreate}
                            disabled={loading}
                            className={`w-full py-4 rounded-xl font-bold text-sm uppercase tracking-wider shadow-lg transform transition-all hover:-translate-y-1 active:translate-y-0 flex items-center justify-center gap-2 ${loading ? 'bg-brand-surface-2 text-brand-muted' : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200'
                                }`}
                        >
                            {loading ? (
                                <>
                                    <RefreshCw className="animate-spin" size={18} />
                                    Configurando...
                                </>
                            ) : (
                                <>
                                    <Plus size={18} />
                                    Gerar Nova Conexão
                                </>
                            )}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default AutomacaoSmart;
