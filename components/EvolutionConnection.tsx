import React, { useState, useEffect } from 'react';
import { QrCode, Smartphone, RefreshCw, Trash2, MessageCircle, CheckCircle, Wifi, WifiOff, Loader } from 'lucide-react';
import { whatsappService } from '../services/whatsappService';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';

interface EvolutionConnectionProps {
    user: UserType;
    tenantId?: string;
}

const EvolutionConnection: React.FC<EvolutionConnectionProps> = ({ user, tenantId }) => {
    const [instance, setInstance] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
    const [newInstanceName, setNewInstanceName] = useState('');
    const [testNumber, setTestNumber] = useState('');
    const [sendingTest, setSendingTest] = useState(false);

    useEffect(() => {
        if (user && tenantId) {
            fetchInstance();
        }
    }, [user, tenantId]);

    // Poll status if connecting or displaying QR
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (instance && (connectionStatus === 'connecting' || qrCode)) {
            interval = setInterval(checkStatus, 5000);
        }
        return () => clearInterval(interval);
    }, [instance, connectionStatus, qrCode]);

    const fetchInstance = async () => {
        setLoading(true);
        try {
            // Get instance from DB
            const { data } = await supabase
                .from('whatsapp_instances')
                .select('*')
                .eq('user_id', user.id)
                .maybeSingle();

            setInstance(data);
            if (data) {
                await checkStatus(data.instance_name);
            }
        } catch (err) {
            console.error('Fetch Instance Error:', err);
        } finally {
            setLoading(false);
        }
    };

    const checkStatus = async (name?: string) => {
        const targetName = name || instance?.instance_name;
        if (!targetName || !tenantId) return;

        const res = await whatsappService.fetchConnectionState(tenantId, targetName);
        if (res.success) {
            const state = res.state === 'open' ? 'connected' : 'disconnected';
            setConnectionStatus(state);
            if (state === 'connected') setQrCode(null);

            // Update DB status
            if (instance) {
                await supabase.from('whatsapp_instances').update({ status: state }).eq('id', instance.id);
            }
        }
    };

    const handleCreateInstance = async () => {
        if (!newInstanceName.trim() || !tenantId) return;
        setLoading(true);
        try {
            const res = await whatsappService.createInstance(tenantId, newInstanceName);
            if (res.success) {
                // Save to DB
                const { data, error } = await supabase.from('whatsapp_instances').insert({
                    user_id: user.id,
                    instance_name: res.instanceName, // Unique name returned by service
                    instance_id: res.data.instance?.instanceId || res.instanceName,
                    status: 'disconnected'
                }).select().single();

                if (error) throw error;
                setInstance(data);
                handleConnect(data.instance_name);
            } else {
                alert('Erro ao criar instância: ' + res.error);
            }
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleConnect = async (name?: string) => {
        const targetName = name || instance?.instance_name;
        if (!targetName || !tenantId) return;

        setLoading(true);
        try {
            const res = await whatsappService.connectInstance(tenantId, targetName);
            if (res.success) {
                if (res.qrcode) {
                    setQrCode(res.qrcode);
                    setConnectionStatus('connecting');
                } else if (res.status === 'connected') {
                    setConnectionStatus('connected');
                    setQrCode(null);
                }
            } else {
                alert('Erro ao conectar: ' + res.error);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!instance || !tenantId || !confirm('Tem certeza? Isso desconectará seu WhatsApp.')) return;
        setLoading(true);
        try {
            await whatsappService.deleteInstance(tenantId, instance.instance_name);
            await supabase.from('whatsapp_instances').delete().eq('id', instance.id);
            setInstance(null);
            setQrCode(null);
            setConnectionStatus('disconnected');
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleTestMessage = async () => {
        if (!testNumber || !instance || !tenantId) return;
        setSendingTest(true);
        try {
            const res = await whatsappService.sendText(tenantId, instance.instance_name, testNumber, 'Olá! Teste de conexão Wise Wolf 🐺 foi um sucesso!', user.id);
            if (res.success) {
                alert('Mensagem enviada com sucesso!');
                setTestNumber('');
            } else {
                alert('Erro ao enviar: ' + (res.error || JSON.stringify(res.data)));
            }
        } catch (err) {
            alert('Erro técnico');
        } finally {
            setSendingTest(false);
        }
    };

    if (loading && !instance) {
        return (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                <Loader className="animate-spin mb-4" size={32} />
                <p className="text-sm font-bold uppercase tracking-widest">Carregando Conexão...</p>
            </div>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden p-8">
            <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 rounded-2xl flex items-center justify-center">
                    <Smartphone size={24} />
                </div>
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-tight">Sua Conexão WhatsApp</h3>
                    <p className="text-sm text-slate-500 font-medium">Gerencie a instância conectada ao sistema.</p>
                </div>
                <div className="ml-auto">
                    {connectionStatus === 'connected' ? (
                        <span className="flex items-center gap-1.5 px-4 py-2 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded-full text-xs font-black uppercase tracking-widest">
                            <Wifi size={14} /> Conectado
                        </span>
                    ) : (
                        <span className="flex items-center gap-1.5 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-full text-xs font-black uppercase tracking-widest">
                            <WifiOff size={14} /> Desconectado
                        </span>
                    )}
                </div>
            </div>

            {!instance ? (
                <div className="max-w-md mx-auto text-center py-8">
                    <div className="mb-6">
                        <QrCode size={48} className="mx-auto text-slate-300 mb-4" />
                        <h4 className="text-lg font-bold text-slate-700 dark:text-slate-300">Nenhuma conexão ativa</h4>
                        <p className="text-sm text-slate-400 mt-2">Crie uma nova instância para conectar seu WhatsApp pessoal ou comercial.</p>
                    </div>

                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="Nome da Instância (ex: Prof Daniel)"
                            value={newInstanceName}
                            onChange={(e) => setNewInstanceName(e.target.value)}
                            className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500/20"
                        />
                        <button
                            onClick={handleCreateInstance}
                            disabled={loading || !newInstanceName}
                            className="bg-emerald-500 text-white px-6 py-3 rounded-xl font-bold text-sm hover:bg-emerald-600 disabled:opacity-50 transition-all flex items-center gap-2"
                        >
                            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Criar
                        </button>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">

                    {/* Status / QR Side */}
                    <div className="flex flex-col items-center justify-center border-r border-slate-100 dark:border-slate-800 pr-12">
                        {connectionStatus === 'connected' ? (
                            <div className="text-center">
                                <div className="w-48 h-48 bg-emerald-50 dark:bg-emerald-900/10 rounded-3xl flex items-center justify-center mx-auto mb-6 text-emerald-500 animate-in zoom-in duration-500">
                                    <CheckCircle size={64} />
                                </div>
                                <h4 className="text-xl font-black text-emerald-600 dark:text-emerald-400">Tudo Pronto!</h4>
                                <p className="text-slate-400 text-sm mt-2 max-w-xs mx-auto">
                                    Seu WhatsApp <strong>{instance.instance_name}</strong> está sincronizado e enviando mensagens.
                                </p>

                                <button
                                    onClick={() => checkStatus()}
                                    className="mt-6 text-xs font-bold text-slate-400 hover:text-emerald-500 flex items-center justify-center gap-2 uppercase tracking-widest"
                                >
                                    <RefreshCw size={12} /> Atualizar Status
                                </button>
                            </div>
                        ) : qrCode ? (
                            <div className="text-center">
                                <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 inline-block mb-4">
                                    <img src={qrCode} alt="QR Code" className="w-64 h-64 mix-blend-multiply opacity-90" />
                                </div>
                                <p className="text-sm font-bold text-slate-600 dark:text-slate-300 animate-pulse">Aguardando leitura do QR Code...</p>
                                <button
                                    onClick={() => setQrCode(null)}
                                    className="mt-4 text-xs text-red-400 hover:text-red-500 font-bold"
                                >
                                    Cancelar
                                </button>
                            </div>
                        ) : (
                            <div className="text-center">
                                <div className="w-32 h-32 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6 text-slate-400">
                                    <Smartphone size={40} />
                                </div>
                                <button
                                    onClick={() => handleConnect()}
                                    className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-8 py-3 rounded-xl font-black text-sm uppercase tracking-widest hover:scale-105 transition-all shadow-lg"
                                >
                                    Gerar QR Code
                                </button>
                            </div>
                        )}

                        <button
                            onClick={handleDelete}
                            className="mt-12 flex items-center gap-2 text-xs font-bold text-red-400 hover:text-red-500 uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity"
                        >
                            <Trash2 size={14} /> Desconectar e Remover
                        </button>
                    </div>

                    {/* Testing Side */}
                    <div className="pl-4">
                        <h4 className="text-lg font-bold text-slate-800 dark:text-white mb-6 flex items-center gap-2">
                            <MessageCircle size={20} /> Teste de Envio
                        </h4>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">Número de Destino</label>
                                <input
                                    type="text"
                                    placeholder="5511999999999"
                                    value={testNumber}
                                    onChange={(e) => setTestNumber(e.target.value)}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500/20"
                                />
                                <p className="text-[10px] text-slate-400 mt-1">Inclua o código do país (55 para Brasil).</p>
                            </div>

                            <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl border border-dashed border-slate-200 dark:border-slate-700">
                                <p className="text-xs text-slate-500 italic">
                                    "Olá! Teste de conexão Wise Wolf 🐺 foi um sucesso!"
                                </p>
                            </div>

                            <button
                                onClick={handleTestMessage}
                                disabled={sendingTest || connectionStatus !== 'connected' || !testNumber}
                                className="w-full bg-indigo-500 text-white px-6 py-4 rounded-xl font-bold text-sm hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2"
                            >
                                {sendingTest ? <Loader size={18} className="animate-spin" /> : <MessageCircle size={18} />}
                                Enviar Mensagem de Teste
                            </button>
                        </div>
                    </div>

                </div>
            )}
        </div>
    );
};

export default EvolutionConnection;
