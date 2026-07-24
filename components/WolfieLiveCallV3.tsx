import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Mic, StopCircle, RefreshCw, MessageSquare, AlertCircle, Sparkles, Zap, Volume2, BookOpen, WifiOff } from 'lucide-react';
import { SUPABASE_URL, supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';

// ============================================================
// WolfieLiveCallV3 — Gemini Live API via secure WebSocket proxy
// Real-time bidirectional audio. API key never leaves the server.
// ============================================================

const PROXY_WS_URL = SUPABASE_URL.replace('https://', 'wss://') + '/functions/v1/wolfie-live-proxy';

// AudioWorklet code runs in a separate thread — inlined as blob to avoid a .js file
const PCM_WORKLET_CODE = `
class WolfiePCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const ch = inputs[0]?.[0];
        if (ch && ch.length > 0) {
            const int16 = new Int16Array(ch.length);
            for (let i = 0; i < ch.length; i++) {
                const s = Math.max(-1, Math.min(1, ch[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(int16.buffer, [int16.buffer]);
        }
        return true;
    }
}
registerProcessor('wolfie-pcm', WolfiePCMProcessor);
`;

type CallState = 'CONNECTING' | 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR';

interface TranscriptLine {
    role: 'user' | 'wolfie';
    text: string;
}

interface WolfieLiveCallV3Props {
    user: any;
    wolfieConfig: any;
    avatarId: string;
    scenarioId: string;
    onClose: () => void;
}

export default function WolfieLiveCallV3({
    user,
    wolfieConfig,
    avatarId,
    scenarioId,
    onClose,
}: WolfieLiveCallV3Props) {
    const [callState, setCallState] = useState<CallState>('CONNECTING');
    const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
    const [activeTab, setActiveTab] = useState<'TRANSCRIPT' | 'CORRECTIONS'>('TRANSCRIPT');
    const [subtitle, setSubtitle] = useState('Conectando ao Wolfie...');
    const [error, setError] = useState<string | null>(null);
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null);

    // Refs that don't trigger re-renders
    const wsRef = useRef<WebSocket | null>(null);
    const captureCtxRef = useRef<AudioContext | null>(null);
    const workletNodeRef = useRef<AudioWorkletNode | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const playCtxRef = useRef<AudioContext | null>(null);
    const nextPlayTimeRef = useRef<number>(0);
    const isListeningRef = useRef(false);
    const sessionIdRef = useRef<string | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    // ── Connect on mount ──
    useEffect(() => {
        connectToProxy();
        return () => cleanup();
    }, []);

    const cleanup = () => {
        stopCapture();
        if (wsRef.current) {
            wsRef.current.onclose = null; // prevent onclose from re-running cleanup
            wsRef.current.close();
            wsRef.current = null;
        }
        captureCtxRef.current?.close().catch(() => null);
        playCtxRef.current?.close().catch(() => null);
        streamRef.current?.getTracks().forEach(t => t.stop());
    };

    const connectToProxy = async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session?.access_token) {
                showError('Sessão expirada. Faça login novamente.');
                return;
            }

            const level = wolfieConfig?.level ?? 'B1';
            const topic = encodeURIComponent(scenarioId ?? 'Free Conversation');
            const mode = wolfieConfig?.goal === 'Fluency' ? 'fluency' : 'grammar_focus';
            const wsUrl = `${PROXY_WS_URL}?token=${session.access_token}&level=${level}&topic=${topic}&mode=${mode}`;

            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => console.log('[WolfieLive] Proxy connected');

            ws.onmessage = (event) => handleProxyMessage(JSON.parse(event.data));

            ws.onerror = () => showError('Não foi possível conectar ao Wolfie. Tente novamente.');

            ws.onclose = (ev) => {
                if (ev.code !== 1000 && callState !== 'ERROR') {
                    showError('Conexão encerrada inesperadamente.');
                }
            };
        } catch (e: any) {
            showError('Erro ao iniciar sessão: ' + e.message);
        }
    };

    const handleProxyMessage = useCallback((msg: any) => {
        switch (msg.type) {
            case 'ready':
                sessionIdRef.current = msg.sessionId ?? null;
                setCallState('IDLE');
                setSubtitle('Pressione e segure para falar');
                break;

            case 'audio':
                setCallState('SPEAKING');
                setSubtitle('');
                playPCMChunk(msg.data, msg.sampleRate ?? 24000);
                break;

            case 'transcript':
                setTranscript(prev => [...prev, { role: msg.role, text: msg.text }]);
                if (msg.role === 'wolfie') setSubtitle(msg.text);
                break;

            case 'turn_complete':
                setCallState('IDLE');
                break;

            case 'interrupted':
                nextPlayTimeRef.current = 0;
                playCtxRef.current?.close().catch(() => null);
                playCtxRef.current = null;
                setCallState('IDLE');
                break;

            case 'error':
                showError(msg.message ?? 'Erro desconhecido.');
                break;
        }
    }, []);

    // ── PCM16 audio playback via AudioContext queue ──
    const playPCMChunk = (base64: string, sampleRate: number) => {
        try {
            if (!playCtxRef.current || playCtxRef.current.state === 'closed') {
                playCtxRef.current = new AudioContext({ sampleRate });
                nextPlayTimeRef.current = 0;
            }

            const ctx = playCtxRef.current;
            const raw = atob(base64);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

            const int16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

            const buffer = ctx.createBuffer(1, float32.length, sampleRate);
            buffer.getChannelData(0).set(float32);

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);

            const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
            source.start(startAt);
            nextPlayTimeRef.current = startAt + buffer.duration;
        } catch (e) {
            console.error('[WolfieLive] Playback error:', e);
        }
    };

    // ── Start microphone capture ──
    const startCapture = async () => {
        if (isListeningRef.current) return;
        isListeningRef.current = true;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
            });
            streamRef.current = stream;
            setAudioStream(stream);

            const ctx = new AudioContext({ sampleRate: 16000 });
            captureCtxRef.current = ctx;

            // Load worklet from blob URL
            const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            await ctx.audioWorklet.addModule(blobUrl);
            URL.revokeObjectURL(blobUrl);

            const source = ctx.createMediaStreamSource(stream);
            sourceNodeRef.current = source;

            const worklet = new AudioWorkletNode(ctx, 'wolfie-pcm');
            workletNodeRef.current = worklet;

            worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
                if (!isListeningRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
                const uint8 = new Uint8Array(e.data);
                // Convert to base64 in chunks to avoid stack overflow on large buffers
                let binary = '';
                for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
                wsRef.current.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
            };

            source.connect(worklet);
            // Don't connect worklet to destination — we don't want to hear ourselves
        } catch (err: any) {
            isListeningRef.current = false;
            if (err.name === 'NotAllowedError') {
                showError('Permissão de microfone negada. Habilite nas configurações do browser.');
            } else {
                showError('Erro ao acessar microfone: ' + err.message);
            }
        }
    };

    const stopCapture = () => {
        isListeningRef.current = false;
        workletNodeRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        workletNodeRef.current = null;
        sourceNodeRef.current = null;
        captureCtxRef.current?.close().catch(() => null);
        captureCtxRef.current = null;
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setAudioStream(null);
    };

    // ── Push-to-talk handlers ──
    const onPressStart = async () => {
        if (callState !== 'IDLE') return;

        // Stop any ongoing Wolfie speech
        nextPlayTimeRef.current = 0;
        if (playCtxRef.current) {
            await playCtxRef.current.close().catch(() => null);
            playCtxRef.current = null;
        }

        setCallState('LISTENING');
        setSubtitle('Ouvindo...');
        setError(null);
        await startCapture();
    };

    const onPressEnd = () => {
        if (callState !== 'LISTENING') return;
        stopCapture();
        setCallState('THINKING');
        setSubtitle('Wolfie está pensando...');
        wsRef.current?.send(JSON.stringify({ type: 'end_turn' }));
    };

    const showError = (msg: string) => {
        setError(msg);
        setCallState('ERROR');
        setSubtitle('');
    };

    const getOrbHue = () => {
        switch (callState) {
            case 'CONNECTING': return 220;
            case 'IDLE': return 220;
            case 'LISTENING': return 0;
            case 'THINKING': return 280;
            case 'SPEAKING': return 180;
            case 'ERROR': return 0;
            default: return 220;
        }
    };

    const missionTitle = scenarioId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col font-sans overflow-hidden">
            {/* Dynamic background glow */}
            <div className={`absolute inset-0 transition-colors duration-1000 ${callState === 'LISTENING'
                ? 'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-950 to-slate-950'
                : callState === 'SPEAKING'
                    ? 'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-cyan-900/20 via-slate-950 to-slate-950'
                    : 'bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950'
                }`} />

            <div className="relative z-10 flex flex-col h-full">
                {/* ── TOP BAR ── */}
                <header className="flex items-center justify-between p-6 border-b border-white/5 bg-slate-950/50 backdrop-blur-md">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-surface rounded-full border border-white/10">
                        {callState === 'CONNECTING' ? (
                            <RefreshCw size={10} className="animate-spin text-amber-400" />
                        ) : callState === 'ERROR' ? (
                            <WifiOff size={10} className="text-red-400" />
                        ) : (
                            <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                            </span>
                        )}
                        <span className="text-xs font-bold text-slate-300 tracking-wider">
                            {callState === 'CONNECTING' ? 'CONECTANDO' : callState === 'ERROR' ? 'ERRO' : 'LIVE'}
                        </span>
                    </div>

                    <div className="text-center absolute left-1/2 -translate-x-1/2 hidden md:block">
                        <h2 className="text-lg font-black text-white tracking-wide">{missionTitle}</h2>
                        <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mt-1">Gemini Live • Tempo Real</p>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-brand-surface rounded-full border border-white/10">
                            <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">{wolfieConfig?.level ?? 'B1'}</span>
                            <div className="w-px h-3 bg-slate-700" />
                            <span className="text-xs font-bold text-slate-200 capitalize">{avatarId}</span>
                        </div>
                        <button onClick={onClose} className="p-2 bg-brand-surface/5 hover:bg-brand-surface/10 rounded-full text-brand-muted hover:text-white transition-colors">
                            <X size={20} />
                        </button>
                    </div>
                </header>

                {/* ── MAIN SPLIT ── */}
                <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                    {/* LEFT: ORB + SUBTITLES */}
                    <div className="flex-1 relative flex flex-col items-center justify-center p-4 sm:p-8 lg:border-r border-white/5 min-h-[55vh] lg:min-h-0">
                        <div className="md:hidden absolute top-4 w-full px-4 text-center">
                            <h2 className="text-base font-black text-white">{missionTitle}</h2>
                        </div>

                        <div className="w-[220px] h-[220px] sm:w-[280px] sm:h-[280px] md:w-[400px] md:h-[400px] mt-10 lg:mt-0">
                            <VoicePoweredOrb
                                hue={getOrbHue()}
                                audioStream={audioStream}
                                className="w-full h-full scale-125"
                                maxHoverIntensity={callState === 'SPEAKING' ? 1.5 : 0.8}
                                maxRotationSpeed={callState === 'THINKING' ? 3.0 : 1.2}
                            />
                        </div>

                        {/* Subtitle / Error */}
                        <div className="absolute bottom-6 sm:bottom-12 w-full max-w-2xl px-4 sm:px-6 text-center">
                            {error && (
                                <div className="inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs font-bold mb-3">
                                    <AlertCircle size={14} />
                                    {error}
                                </div>
                            )}
                            <div className={`p-4 sm:p-6 rounded-3xl backdrop-blur-md transition-all duration-300 ${callState === 'SPEAKING' && subtitle
                                ? 'bg-brand-surface/80 border border-white/10 shadow-2xl scale-100'
                                : 'bg-transparent scale-95 opacity-50'
                                }`}>
                                {subtitle && (
                                    <p className="text-base sm:text-2xl md:text-3xl font-medium text-white leading-relaxed">
                                        {subtitle}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT: TRANSCRIPT */}
                    <div className="w-full lg:w-[450px] bg-slate-950/50 flex flex-col border-t lg:border-t-0 border-white/5">
                        <div className="flex px-4 pt-4 border-b border-white/5 gap-2">
                            <button
                                onClick={() => setActiveTab('TRANSCRIPT')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 ${activeTab === 'TRANSCRIPT' ? 'text-white border-indigo-500' : 'text-brand-muted border-transparent hover:text-slate-300'}`}
                            >
                                Transcript
                            </button>
                            <button
                                onClick={() => setActiveTab('CORRECTIONS')}
                                className={`flex-1 pb-3 text-sm font-bold tracking-wider uppercase transition-colors border-b-2 ${activeTab === 'CORRECTIONS' ? 'text-white border-indigo-500' : 'text-brand-muted border-transparent hover:text-slate-300'}`}
                            >
                                Info
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                            {activeTab === 'TRANSCRIPT' && (
                                <div className="space-y-4">
                                    {transcript.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center mt-12 text-brand-muted">
                                            <MessageSquare size={48} className="opacity-20 mb-4" />
                                            <p className="text-center text-sm font-medium">
                                                {callState === 'CONNECTING'
                                                    ? 'Conectando ao Wolfie...'
                                                    : 'A conversa aparecerá aqui em tempo real.'}
                                            </p>
                                        </div>
                                    ) : (
                                        transcript.map((line, i) => (
                                            <div key={i} className={`flex flex-col ${line.role === 'user' ? 'items-end' : 'items-start'}`}>
                                                <span className="text-[10px] font-bold text-brand-muted uppercase tracking-widest mb-1.5 mx-2">
                                                    {line.role === 'user' ? 'Você' : 'Wolfie'}
                                                </span>
                                                <div className={`p-4 rounded-2xl max-w-[85%] text-sm leading-relaxed ${line.role === 'user'
                                                    ? 'bg-indigo-600 text-white rounded-tr-sm'
                                                    : 'bg-brand-surface-2 text-slate-200 rounded-tl-sm'
                                                    }`}>
                                                    {line.text}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {activeTab === 'CORRECTIONS' && (
                                <div className="space-y-4 text-sm">
                                    <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-2xl p-5">
                                        <div className="flex items-center gap-2 mb-3">
                                            <Sparkles size={16} className="text-indigo-400" />
                                            <span className="text-indigo-400 font-bold text-xs uppercase tracking-widest">Modo Gemini Live</span>
                                        </div>
                                        <p className="text-slate-300 text-xs leading-relaxed">
                                            Neste modo, o Wolfie corrige seus erros <strong>naturalmente durante a conversa</strong> — como um professor nativo faria em aula.
                                            As correções aparecem no áudio, não em cards separados.
                                        </p>
                                    </div>
                                    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5 space-y-3">
                                        <p className="text-[10px] uppercase tracking-widest font-bold text-brand-muted">Dicas de Uso</p>
                                        {[
                                            { icon: '🎤', tip: 'Segure o botão enquanto fala, solte quando terminar' },
                                            { icon: '⚡', tip: 'Latência real de ~300ms — muito mais fluido que o modo texto' },
                                            { icon: '🔊', tip: 'Use fones de ouvido para melhor qualidade de áudio' },
                                            { icon: '🐺', tip: 'Wolfie detecta quando você interrompe e para de falar' },
                                        ].map(({ icon, tip }) => (
                                            <div key={tip} className="flex items-start gap-3">
                                                <span className="text-base shrink-0">{icon}</span>
                                                <p className="text-slate-400 text-xs leading-relaxed">{tip}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </main>

                {/* ── BOTTOM ACTION BAR ── */}
                <footer className="p-6 border-t border-white/5 bg-slate-950 flex flex-col items-center gap-3 pb-8 lg:pb-6">
                    <button
                        onMouseDown={onPressStart}
                        onMouseUp={onPressEnd}
                        onTouchStart={(e) => { e.preventDefault(); onPressStart(); }}
                        onTouchEnd={(e) => { e.preventDefault(); onPressEnd(); }}
                        disabled={callState === 'CONNECTING' || callState === 'THINKING' || callState === 'ERROR'}
                        className={`relative group overflow-hidden flex items-center justify-center gap-4 px-10 py-5 rounded-full font-black uppercase tracking-widest transition-all duration-300 select-none touch-none
                            ${callState === 'CONNECTING' || callState === 'THINKING'
                                ? 'bg-brand-surface-2 text-brand-muted cursor-not-allowed border border-white/5'
                                : callState === 'ERROR'
                                    ? 'bg-red-900/30 text-red-400 cursor-not-allowed border border-red-500/20'
                                    : callState === 'LISTENING'
                                        ? 'bg-indigo-500 scale-105 shadow-[0_0_40px_rgba(99,102,241,0.5)] text-white'
                                        : callState === 'SPEAKING'
                                            ? 'bg-cyan-700/60 text-cyan-200 border border-cyan-500/30 cursor-default'
                                            : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl hover:shadow-2xl hover:-translate-y-1'
                            }`}
                    >
                        {callState === 'LISTENING' && (
                            <span className="absolute inset-0 border-4 border-white/20 rounded-full animate-ping pointer-events-none" />
                        )}

                        {callState === 'CONNECTING' && <RefreshCw size={24} className="animate-spin" />}
                        {callState === 'IDLE' && <Mic size={24} />}
                        {callState === 'LISTENING' && <StopCircle size={24} className="animate-pulse" />}
                        {callState === 'THINKING' && <RefreshCw size={24} className="animate-spin" />}
                        {callState === 'SPEAKING' && <Volume2 size={24} className="animate-pulse" />}
                        {callState === 'ERROR' && <WifiOff size={24} />}

                        <span>
                            {callState === 'CONNECTING' && 'Conectando...'}
                            {callState === 'IDLE' && 'Segure para Falar'}
                            {callState === 'LISTENING' && 'Solte para Enviar'}
                            {callState === 'THINKING' && 'Processando...'}
                            {callState === 'SPEAKING' && 'Wolfie Falando'}
                            {callState === 'ERROR' && 'Reconectar'}
                        </span>
                    </button>

                    {callState === 'IDLE' && (
                        <p className="text-[10px] text-brand-muted font-medium uppercase tracking-widest">
                            Push and hold to speak • Powered by Gemini Live
                        </p>
                    )}

                    {callState === 'ERROR' && (
                        <button
                            onClick={() => { setError(null); setCallState('CONNECTING'); setSubtitle('Reconectando...'); connectToProxy(); }}
                            className="text-xs text-indigo-400 hover:text-indigo-300 font-bold underline"
                        >
                            Tentar reconectar
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}
