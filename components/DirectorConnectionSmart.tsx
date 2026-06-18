import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Smartphone, Plus, QrCode as QrIcon, AlertCircle, RefreshCw, Search, Building2 } from 'lucide-react';

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "8828462c98512411df3acfe3df4e48a1";

const DirectorConnectionSmart: React.FC = () => {
    const [nameInput, setNameInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState<'IDLE' | 'SEARCHING' | 'CREATING' | 'QR_CODE' | 'SUCCESS' | 'ERROR'>('IDLE');
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [feedback, setFeedback] = useState('');

    const headers = {
        'apikey': GLOBAL_API_KEY,
        'Content-Type': 'application/json'
    };

    const handleCreate = async () => {
        if (!nameInput.trim()) {
            setFeedback("Digite um nome para identificar a escola/instância.");
            return;
        }

        setLoading(true);
        setFeedback('');
        setStatus('SEARCHING');

        try {
            // 1. UNICIDADE (ANTI-COLISÃO)
            // Gera ID único: escola-wise-wolf-9x2a
            const cleanName = nameInput.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '-');
            const uniqueSuffix = Math.random().toString(36).substring(2, 6); // 4 chars
            const uniqueId = `escola-${cleanName}-${uniqueSuffix}`;

            // 2. BUSCA DO USUÁRIO ADMIN (Opcional: vincular o token ao admin que está operando ou buscado)
            // Neste fluxo, assumimos que o Diretor digita seu PRÓPRIO nome ou nome da escola
            // Para segurança, vamos buscar o usuário que corresponda ao nome digitado OU 
            // idealmente deveríamos pegar o usuário logado via Contexto, mas seguindo o padrão input:

            console.log(`🔍 Buscando Admin/Escola: ${nameInput}`);
            const { data: users, error: searchError } = await supabase
                .from('profiles')
                .select('id, name, email, role')
                .ilike('name', `%${nameInput}%`)
                // .eq('role', 'SCHOOL_ADMIN') // Opcional: restringir a admins
                .limit(5);

            if (searchError || !users || users.length === 0) {
                setFeedback("❌ Usuário/Admin não encontrado. Digite o nome exato do perfil no sistema.");
                setStatus('ERROR');
                return;
            }

            if (users.length > 1) {
                setFeedback(`⚠️ ${users.length} usuários encontrados. Seja mais específico.`);
                setStatus('ERROR');
                return;
            }

            const targetUser = users[0];
            console.log(`✅ Admin alvo: ${targetUser.name} (${targetUser.id})`);

            // 3. CRIAÇÃO (POST /instance/create)
            setStatus('CREATING');
            console.log(`🚀 Criando instância SaaS: ${uniqueId}`);

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

            // Tratamento API v1/v2
            const token = createData?.hash?.apikey || createData?.hash || createData?.token;

            // 4. PERSISTÊNCIA (Supabase)
            if (token) {
                console.log("💾 Salvando ID e Token no Perfil Admin...");
                const { error: dbError } = await supabase
                    .from('profiles')
                    .update({
                        whatsapp_instance: uniqueId,
                        whatsapp_token: token
                    })
                    .eq('id', targetUser.id);

                if (dbError) throw new Error(`Erro ao salvar no banco: ${dbError.message}`);
            } else {
                console.warn("⚠️ Sem token retornado. API pode ter falhado ou inst. já existe.");
                // Permitimos continuar para tentar conectar se já existir
            }

            // 5. CONEXÃO
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
                setFeedback(`✅ A Escola ${cleanName} já está conectada!`);
                setStatus('SUCCESS');
                setQrCode(null);
            } else {
                setFeedback("Aguardando QR Code...");
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
        <div className="bg-brand-surface p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-brand-border">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-3 bg-purple-50 dark:bg-purple-900/20 text-purple-600 rounded-2xl">
                    <Building2 size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-brand-text">Conexão da Escola</h2>
                    <p className="text-sm text-brand-muted">WhatsApp Institucional (Diretor/Secretaria)</p>
                </div>
            </div>

            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-bold text-brand-muted uppercase mb-2">
                        Nome do Admin/Escola
                    </label>
                    <div className="relative">
                        <input
                            type="text"
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            placeholder="Ex: Wise Wolf"
                            className="w-full px-4 py-3 rounded-xl bg-brand-surface-2 border-2 border-brand-border dark:border-brand-border focus:border-purple-500 outline-none transition-all pl-10"
                        />
                        <Search className="absolute left-3 top-3.5 text-brand-muted" size={18} />
                    </div>
                    <p className="text-[10px] text-brand-muted mt-2 ml-1">
                        * O ID será gerado como: <strong>escola-nome-xxxx</strong>
                    </p>
                </div>

                {feedback && (
                    <div className={`p-4 rounded-xl text-sm font-medium flex items-start gap-2 ${status === 'ERROR' ? 'bg-red-50 text-red-600' :
                            status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-600' :
                                'bg-blue-50 text-blue-600'
                        }`}>
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        {feedback}
                    </div>
                )}

                {qrCode && (
                    <div className="flex flex-col items-center p-4 bg-brand-surface border-2 border-slate-900 rounded-2xl animate-in zoom-in duration-300">
                        <img src={qrCode} alt="QR Code" className="w-48 h-48 mb-2" />
                        <p className="text-xs font-bold text-brand-text uppercase animate-pulse">
                            Escaneie com o WhatsApp da Escola
                        </p>
                    </div>
                )}

                <button
                    onClick={handleCreate}
                    disabled={loading || status === 'SUCCESS'}
                    className={`w-full py-4 rounded-xl font-bold text-sm uppercase tracking-wider shadow-lg transform transition-all hover:-translate-y-1 active:translate-y-0 flex items-center justify-center gap-2 ${loading ? 'bg-brand-surface-2 text-brand-muted' : 'bg-purple-600 hover:bg-purple-700 text-white shadow-purple-200'
                        }`}
                >
                    {loading ? (
                        <>
                            <RefreshCw className="animate-spin" size={18} />
                            Processando...
                        </>
                    ) : (
                        <>
                            <Plus size={18} />
                            Criar Conexão Oficial
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default DirectorConnectionSmart;
