
import React, { useState, useEffect } from 'react';
import { Smartphone, RefreshCw, LogOut, QrCode as QrIcon, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

interface WhatsappManagerProps {
    role: 'SCHOOL_ADMIN' | 'TEACHER';
    userId: string;
}

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "2AFB8724075F-40FB-92CF-414EE13EDA54";

const WhatsappManager: React.FC<WhatsappManagerProps> = ({ role, userId }) => {
    // Logic for Instance Name
    const instanceName = role === 'SCHOOL_ADMIN'
        ? 'wise-wolf'
        : `prof-${userId}`;

    // UI States: 'Iniciando', 'Aguardando QR Code', 'Conectado', 'Desconectado'
    const [statusText, setStatusText] = useState<'Iniciando' | 'Aguardando QR Code' | 'Conectado' | 'Desconectado'>('Iniciando');
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    // Headers for API calls
    const headers = {
        'apikey': GLOBAL_API_KEY,
        'Content-Type': 'application/json'
    };

    const checkConnection = async () => {
        try {
            const res = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`, { headers });

            if (!res.ok) {
                setStatusText('Desconectado');
                return;
            }

            const data = await res.json();
            if (data?.instance?.state === 'open') {
                setStatusText('Conectado');
                setQrCode(null);
            } else {
                // If we have a QR code, we are waiting for scan, otherwise disconnected
                if (!qrCode) setStatusText('Desconectado');
            }

        } catch (error) {
            console.error("Error checking WhatsApp status:", error);
            setStatusText('Desconectado');
        }
    };

    const generateNewConnection = async () => {
        try {
            setLoading(true);
            setStatusText('Iniciando');

            // Call connect endpoint
            const res = await fetch(`${EVOLUTION_API_URL}/instance/connect/${instanceName}`, {
                method: 'GET',
                headers
            });

            if (!res.ok) throw new Error("Falha ao gerar QR Code");

            const data = await res.json();

            if (data?.base64) {
                setQrCode(data.base64);
                setStatusText('Aguardando QR Code');
            } else if (data?.instance?.state === 'open') {
                setStatusText('Conectado');
                setQrCode(null);
                alert("Instância já está conectada!");
            }

        } catch (error) {
            console.error("Error generating QR:", error);
            alert("Erro ao conectar com servidor de WhatsApp.");
            setStatusText('Desconectado');
        } finally {
            setLoading(false);
        }
    };

    const logout = async () => {
        if (!confirm("Tem certeza que deseja desconectar o WhatsApp?")) return;

        try {
            setLoading(true);
            await fetch(`${EVOLUTION_API_URL}/instance/logout/${instanceName}`, {
                method: 'DELETE',
                headers
            });
            setStatusText('Desconectado');
            setQrCode(null);
        } catch (error) {
            console.error("Error logging out:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // Initial check
        checkConnection().then(() => {
            if (statusText === 'Iniciando') {
                // If initial check fails to set connected, default to disconnected if no QR
                // Actually checkConnection handles setting Disconnected if fetch fails or state not open
            }
        });

        // Poll status
        const interval = setInterval(checkConnection, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="bg-brand-surface p-8 rounded-[2.5rem] shadow-lg border border-brand-border flex flex-col items-center text-center max-w-sm mx-auto animate-in fade-in zoom-in duration-500">

            {/* HEADER Icon */}
            <div className={`p-5 rounded-3xl mb-6 shadow-xl shadow-slate-200 dark:shadow-none transition-all duration-500 ${statusText === 'Conectado' ? 'bg-emerald-500 text-white' :
                    statusText === 'Aguardando QR Code' ? 'bg-blue-500 text-white' :
                        'bg-brand-surface-2 text-brand-muted dark:bg-brand-surface-2'
                }`}>
                <Smartphone size={40} strokeWidth={1.5} />
            </div>

            <h3 className="text-xl font-black text-brand-text mb-2 tracking-tight">
                WhatsApp Manager
            </h3>
            <div className="flex items-center gap-2 mb-8 bg-brand-surface-2/50 px-3 py-1.5 rounded-lg border border-brand-border">
                <div className={`w-2 h-2 rounded-full ${statusText === 'Conectado' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                <span className="font-mono text-[10px] uppercase tracking-widest text-brand-muted">{instanceName}</span>
            </div>

            {/* STATUS TEXT DISPLAY */}
            <div className="mb-8 w-full">
                <div className="flex items-center justify-between text-xs font-bold text-brand-muted uppercase tracking-widest mb-2 px-1">
                    <span>Status</span>
                    <span>{loading ? <Loader2 size={12} className="animate-spin" /> : ''}</span>
                </div>
                <div className={`w-full p-4 rounded-2xl border flex items-center justify-center gap-3 transition-colors ${statusText === 'Conectado' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' :
                        statusText === 'Aguardando QR Code' ? 'bg-blue-50 border-blue-100 text-blue-600' :
                            'bg-brand-surface-2 border-brand-border text-brand-muted'
                    }`}>
                    {statusText === 'Conectado' && <CheckCircle size={18} />}
                    {statusText === 'Aguardando QR Code' && <QrIcon size={18} />}
                    {statusText === 'Desconectado' && <AlertCircle size={18} />}
                    {(statusText === 'Iniciando' || loading) && statusText !== 'Aguardando QR Code' && <RefreshCw size={18} className="animate-spin" />}

                    <span className="font-black text-sm">{statusText}</span>
                </div>
            </div>

            {/* ACTION AREA */}
            <div className="w-full space-y-4">

                {/* QR Code Area */}
                {statusText === 'Aguardando QR Code' && qrCode && (
                    <div className="p-4 bg-brand-surface rounded-[2rem] border-2 border-blue-100 shadow-inner mb-4 animate-in zoom-in">
                        <img src={qrCode} alt="QR Code WhatsApp" className="w-full h-auto rounded-xl mix-blend-multiply" />
                        <p className="text-[10px] text-brand-muted mt-3 font-bold uppercase tracking-widest animate-pulse">Aponte a câmera do seu celular</p>
                    </div>
                )}

                {/* Buttons */}
                {statusText === 'Desconectado' && (
                    <button
                        onClick={generateNewConnection}
                        disabled={loading}
                        className="w-full py-4 bg-tenant-primary hover:opacity-90 text-white rounded-2xl font-black text-xs uppercase tracking-[0.2em] transition-all shadow-xl shadow-slate-900/20 active:scale-95 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 className="animate-spin" size={16} /> : <QrIcon size={16} />}
                        Gerar Nova Conexão
                    </button>
                )}

                {statusText === 'Conectado' && (
                    <button
                        onClick={logout}
                        disabled={loading}
                        className="w-full py-4 bg-brand-surface border-2 border-rose-100 hover:bg-rose-50 text-rose-500 rounded-2xl font-black text-xs uppercase tracking-[0.2em] transition-all shadow-lg shadow-rose-500/5 active:scale-95 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 className="animate-spin" size={16} /> : <LogOut size={16} />}
                        Desconectar
                    </button>
                )}

                {statusText === 'Aguardando QR Code' && (
                    <button
                        onClick={() => { setQrCode(null); setStatusText('Desconectado'); }}
                        className="text-xs font-bold text-brand-muted hover:text-brand-muted underline"
                    >
                        Cancelar Operação
                    </button>
                )}

            </div>

        </div>
    );
};

export default WhatsappManager;
