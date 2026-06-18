
import React, { useState, useEffect } from 'react';
import { Smartphone, RefreshCw, LogOut, QrCode as QrIcon, CheckCircle, AlertCircle } from 'lucide-react';

interface WhatsappConnectionProps {
    role: 'SCHOOL_ADMIN' | 'TEACHER';
    userName: string;
    userId: string;
}

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "8828462c98512411df3acfe3df4e48a1";

const WhatsappConnection: React.FC<WhatsappConnectionProps> = ({ role, userName, userId }) => {
    // Determine Instance Name
    const instanceName = role === 'SCHOOL_ADMIN'
        ? 'wise-wolf'
        : `prof-${userName.toLowerCase().split(' ')[0]}-${userId.substring(0, 4)}`;

    const [status, setStatus] = useState<'CONNECTED' | 'DISCONNECTED' | 'LOADING'>('LOADING');
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    // Headers for API calls
    const headers = {
        'apikey': GLOBAL_API_KEY,
        'Content-Type': 'application/json'
    };

    const checkConnection = async () => {
        try {
            setLoading(true);
            const res = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`, { headers });

            if (!res.ok) {
                // If instance not found or error, assume disconnected
                setStatus('DISCONNECTED');
                return;
            }

            const data = await res.json();
            // Evolution API usually returns { instance: { state: "open" } } for connected
            if (data?.instance?.state === 'open') {
                setStatus('CONNECTED');
                setQrCode(null);
            } else {
                setStatus('DISCONNECTED');
            }

        } catch (error) {
            console.error("Error checking WhatsApp status:", error);
            setStatus('DISCONNECTED');
        } finally {
            setLoading(false);
        }
    };

    const generateQrCode = async () => {
        try {
            setLoading(true);
            // Create/Connect instance
            const res = await fetch(`${EVOLUTION_API_URL}/instance/connect/${instanceName}`, {
                method: 'GET',
                headers
            });

            if (!res.ok) throw new Error("Falha ao gerar QR Code");

            const data = await res.json();

            // Evolution returns base64 in 'base64' or sometimes nested
            if (data?.base64) {
                setQrCode(data.base64);
                setStatus('DISCONNECTED'); // Waiting for scan
            } else if (data?.instance?.state === 'open') {
                setStatus('CONNECTED');
                setQrCode(null);
                alert("Instância já está conectada!");
            }

        } catch (error) {
            console.error("Error generating QR:", error);
            alert("Erro ao conectar com servidor de WhatsApp.");
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
            setStatus('DISCONNECTED');
            setQrCode(null);
        } catch (error) {
            console.error("Error logging out:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        checkConnection();
        // Poll status if QR code is shown to detect auto-login
        let interval: any;
        if (qrCode) {
            interval = setInterval(checkConnection, 5000);
        }
        return () => {
            if (interval) clearInterval(interval);
        }
    }, [qrCode]); // Re-run poll if QR changes

    return (
        <div className="bg-brand-surface p-6 rounded-[2rem] shadow-sm border border-brand-border flex flex-col items-center text-center">

            <div className={`p-4 rounded-full mb-4 ${status === 'CONNECTED' ? 'bg-emerald-50 text-emerald-500' : 'bg-brand-surface-2 text-brand-muted'}`}>
                <Smartphone size={32} />
            </div>

            <h3 className="text-lg font-bold text-brand-text mb-1">
                Conexão WhatsApp
            </h3>
            <p className="text-xs text-brand-muted mb-6 font-medium">
                Instância: <span className="font-mono text-brand-muted bg-brand-surface-2 dark:bg-brand-surface-2 px-1 rounded">{instanceName}</span>
            </p>

            {/* STATUS INDICATOR */}
            <div className={`px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 mb-6 ${status === 'CONNECTED' ? 'bg-emerald-100 text-emerald-700' :
                    status === 'LOADING' ? 'bg-blue-50 text-blue-600' :
                        'bg-rose-50 text-rose-600'
                }`}>
                {status === 'CONNECTED' && <><CheckCircle size={14} /> Conectado</>}
                {status === 'DISCONNECTED' && <><AlertCircle size={14} /> Desconectado</>}
                {status === 'LOADING' && <><RefreshCw size={14} className="animate-spin" /> Verificando</>}
            </div>

            {/* QR CODE DISPLAY */}
            {status === 'DISCONNECTED' && !qrCode && (
                <button
                    onClick={generateQrCode}
                    disabled={loading}
                    className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                >
                    {loading ? <RefreshCw className="animate-spin" size={16} /> : <QrIcon size={16} />}
                    Gerar QR Code
                </button>
            )}

            {qrCode && status !== 'CONNECTED' && (
                <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
                    <div className="p-2 bg-brand-surface rounded-xl border border-brand-border shadow-sm mb-4">
                        <img src={qrCode} alt="QR Code WhatsApp" className="w-48 h-48" />
                    </div>
                    <p className="text-xs text-brand-muted mb-4 animate-pulse">Aguardando leitura...</p>
                    <button
                        onClick={() => setQrCode(null)}
                        className="text-xs text-brand-muted underline hover:text-brand-muted"
                    >
                        Cancelar
                    </button>
                </div>
            )}

            {/* DISCONNECT ACTION */}
            {status === 'CONNECTED' && (
                <button
                    onClick={logout}
                    disabled={loading}
                    className="w-full py-3 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-xl font-black text-xs uppercase tracking-widest transition-all border border-rose-100 flex items-center justify-center gap-2"
                >
                    {loading ? <RefreshCw className="animate-spin" size={16} /> : <LogOut size={16} />}
                    Desconectar
                </button>
            )}

        </div>
    );
};

export default WhatsappConnection;
