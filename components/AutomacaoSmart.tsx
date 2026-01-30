
import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Smartphone, Plus, QrCode as QrIcon, CheckCircle, AlertCircle, RefreshCw, Key, UserCheck } from 'lucide-react';

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "d037768b3d06382756a0d9edecf3e40e";

const AutomacaoSmart: React.FC = () => {
    // Removed nameInput state as we use auth user
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<'IDLE' | 'SEARCHING' | 'CREATING' | 'QR_CODE' | 'SUCCESS' | 'ERROR'>('IDLE');
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [instanceId, setInstanceId] = useState('');
    const [feedback, setFeedback] = useState('');

    const headers = {
        'apikey': GLOBAL_API_KEY,
        'Content-Type': 'application/json'
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
        <div className="w-full max-w-md mx-auto bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-lg border border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 rounded-2xl">
                    <UserCheck size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">Conexão Pessoal</h2>
                    <p className="text-sm text-slate-500">Vincular meu WhatsApp</p>
                </div>
            </div>

            <div className="space-y-6">

                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500 leading-relaxed">
                        <strong className="text-slate-700 dark:text-slate-300">Como funciona:</strong> Ao clicar no botão abaixo, criaremos uma conexão exclusiva para o seu usuário. Isso permitirá que você lance vagas usando seu próprio número de WhatsApp.
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
                    <div className="flex flex-col items-center p-6 bg-white border-2 border-slate-900 rounded-2xl animate-in zoom-in duration-300 shadow-xl">
                        <div className="mb-4 p-2 bg-white rounded-lg">
                            <img src={qrCode} alt="QR Code" className="w-48 h-48 mix-blend-multiply" />
                        </div>
                        <p className="text-xs font-bold text-slate-900 uppercase animate-pulse flex items-center gap-2">
                            <Smartphone size={14} />
                            Escaneie com seu WhatsApp
                        </p>
                    </div>
                )}

                <button
                    onClick={handleCreate}
                    disabled={loading || status === 'SUCCESS'}
                    className={`w-full py-4 rounded-xl font-bold text-sm uppercase tracking-wider shadow-lg transform transition-all hover:-translate-y-1 active:translate-y-0 flex items-center justify-center gap-2 ${loading ? 'bg-slate-100 text-slate-400' : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200'
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
                            {status === 'SUCCESS' ? 'Conexão Realizada' : 'Gerar Nova Conexão'}
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default AutomacaoSmart;
