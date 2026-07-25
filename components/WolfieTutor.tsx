import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Zap, CheckCircle2, Languages, BookOpen, BrainCircuit, Volume2, VolumeX, Mic, Send, Loader2, RotateCcw, Clock, MessageSquare, ChevronUp, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { VoicePoweredOrb } from './VoicePoweredOrb';

// ============================================================
// TYPES
// ============================================================
interface WolfieTutorProps {
    user: any;
    voiceMode?: boolean; // If true, starts directly in voice mode (used by WolfieLiveCall wrapper)
    topic?: string;
    onClose?: () => void;
}

interface CorrectionData {
    original: string;
    corrected: string;
    explanation_pt: string;
}

interface VocabTerm {
    term: string;
    definition: string;
    level: string;
    synonyms: string[];
    example: string;
}

interface VocabData {
    keyTerms: VocabTerm[];
    grammarNote: string;
}

interface QuizData {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    correction?: CorrectionData | null;
    translation?: string | null;
    vocabulary?: VocabData | null;
    quiz?: QuizData | null;
}

type CallState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

const IS_IOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// WAV mínimo válido (44 bytes, 0 samples, 8000Hz mono 8-bit).
// Usado para "pré-ativar" HTMLAudioElement no iOS — play() com src válido
// registra a gesture no elemento; play() com src vazio não funciona.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

declare global {
    interface Window {
        webkitSpeechRecognition: any;
    }
}

// ============================================================
// TTS SPEED CONFIG BY LEVEL (E-Bot style)
// ============================================================
function getTTSSpeed(level: string): number {
    switch (level) {
        case 'A1': return 0.92;
        case 'A2': return 0.95;
        case 'B1': return 0.98;
        case 'B2': return 1.0;
        default: return 1.0; // C1, C2
    }
}

type SpeechLanguage = 'pt' | 'en';

const PORTUGUESE_MARKERS = new Set([
    'a', 'agora', 'ainda', 'aqui', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos',
    'e', 'ela', 'ele', 'em', 'então', 'essa', 'esse', 'está', 'eu', 'inglês', 'isso',
    'mas', 'me', 'meu', 'minha', 'não', 'o', 'oi', 'os', 'ou', 'para', 'por', 'porque',
    'que', 'se', 'seu', 'sua', 'também', 'tem', 'uma', 'um', 'você', 'vocês',
]);

const ENGLISH_MARKERS = new Set([
    'a', 'about', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'but', 'can',
    'do', 'for', 'from', 'have', 'how', 'i', 'in', 'is', 'it', 'like', 'my', 'of', 'on',
    'or', 'so', 'that', 'the', 'this', 'to', 'want', 'we', 'what', 'when', 'with', 'you',
    'your',
]);

function detectSpeechLanguage(text: string, fallback: SpeechLanguage = 'en'): SpeechLanguage {
    const normalized = text.toLocaleLowerCase('pt-BR');
    const words = normalized.match(/[\p{L}']+/gu) || [];
    let portugueseScore = /[áàâãéêíóôõúç]/i.test(text) ? 3 : 0;
    let englishScore = 0;

    for (const word of words) {
        if (PORTUGUESE_MARKERS.has(word)) portugueseScore += 1;
        if (ENGLISH_MARKERS.has(word)) englishScore += 1;
    }

    if (portugueseScore > englishScore) return 'pt';
    if (englishScore > portugueseScore) return 'en';
    return fallback;
}

// ============================================================
// INLINE QUIZ COMPONENT
// ============================================================
const InlineQuiz: React.FC<{ quiz: QuizData }> = ({ quiz }) => {
    const [answered, setAnswered] = useState<number | null>(null);

    return (
        <div className="bg-fuchsia-950/30 backdrop-blur-xl border border-fuchsia-500/20 p-4 rounded-2xl mt-3">
            <div className="flex items-center gap-2 mb-3 text-fuchsia-400">
                <BrainCircuit size={14} />
                <span className="text-[10px] uppercase font-bold tracking-wider">Mini Quiz</span>
            </div>
            <p className="text-sm font-bold text-white mb-3 leading-snug">{quiz.question}</p>
            <div className="space-y-2">
                {quiz.options.map((opt, idx) => {
                    const isCorrect = idx === quiz.correctIndex;
                    const isSelected = answered === idx;

                    let classes = 'w-full text-left text-xs p-3 rounded-xl border transition-all ';
                    if (answered === null) {
                        classes += 'bg-white/5 hover:bg-fuchsia-500/20 border-white/5 text-slate-200 cursor-pointer';
                    } else if (isSelected && isCorrect) {
                        classes += 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300';
                    } else if (isSelected && !isCorrect) {
                        classes += 'bg-red-500/20 border-red-500/30 text-red-300';
                    } else if (isCorrect) {
                        classes += 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
                    } else {
                        classes += 'bg-white/5 border-white/5 text-slate-400';
                    }

                    return (
                        <button
                            key={idx}
                            onClick={() => answered === null && setAnswered(idx)}
                            className={classes}
                            disabled={answered !== null}
                        >
                            {opt}
                        </button>
                    );
                })}
            </div>
            {answered !== null && (
                <p className="text-xs text-slate-300 mt-3 pt-3 border-t border-white/10 leading-relaxed">
                    {answered === quiz.correctIndex ? '✨ ' : '💡 '}
                    {quiz.explanation}
                </p>
            )}
        </div>
    );
};

// ============================================================
// MAIN COMPONENT — UNIFIED VOICE + TEXT
// ============================================================
const WolfieTutor: React.FC<WolfieTutorProps> = ({ user, voiceMode = false, topic: initialTopic, onClose }) => {
    // --- Core State ---
    const [state, setState] = useState<CallState>('IDLE');
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputText, setInputText] = useState('');
    const [subtitle, setSubtitle] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [turnCount, setTurnCount] = useState(0);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [isVoiceDetected, setIsVoiceDetected] = useState(false);

    // --- UI State ---
    const [topic, setTopic] = useState<string>(initialTopic || '');
    const [hasSelectedTopic, setHasSelectedTopic] = useState(!!initialTopic);
    const [context, setContext] = useState<string>('');
    const [translationEnabled, setTranslationEnabled] = useState(true);
    const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(true);
    const [showTextInput, setShowTextInput] = useState(!voiceMode);
    const [showTranscript, setShowTranscript] = useState(false);

    // --- Overlay Cards (from agents) ---
    const [correction, setCorrection] = useState<CorrectionData | null>(null);
    const [translation, setTranslation] = useState<string | null>(null);
    const [vocabulary, setVocabulary] = useState<VocabData | null>(null);
    const [quiz, setQuiz] = useState<QuizData | null>(null);

    // --- Session Timer ---
    const [sessionStart] = useState<Date>(new Date());
    const [elapsed, setElapsed] = useState(0);
    const MAX_SESSION_MINUTES = 120; // 2h — antes era 30, encerrava antes da hora

    // --- History from past sessions ---
    const [isLoadingHistory, setIsLoadingHistory] = useState(true);

    // --- Refs ---
    const recognitionRef = useRef<any>(null);          // Web Speech API recognition
    const isProcessingRef = useRef(false);             // Previne chamadas duplicadas ao wolfie-brain
    const recordingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Timeout do delay anti-eco
    const finalTranscriptRef = useRef<string>('');     // Acumula transcript enquanto segura o orb
    const englishVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
    const ptBrVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
    const lastSpokenTextRef = useRef<string>('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);      // fallback HTMLAudioElement (desktop)
    const audioCtxRef = useRef<AudioContext | null>(null);       // AudioContext — funciona em iOS após unlock
    const audioSourceRef = useRef<AudioBufferSourceNode | null>(null); // source node ativo (parar mid-play)
    // iOS: keepalive toca buffers silenciosos a cada 500ms para impedir que o
    // iOS auto-suspenda o AudioContext durante o fetch assíncrono (~2-4s)
    const iosKeepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // iOS: elemento HTMLAudio "pré-desbloqueado" durante o toque — pode ser
    // re-usado com outro src em callbacks async (Apple documenta este padrão)
    const preUnlockedAudioRef = useRef<HTMLAudioElement | null>(null);
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null); // só para visualização do orb

    const studentLevel = user.levelBadge || 'A1';

    // ============================================================
    // EFFECTS
    // ============================================================

    // Pre-load TTS voices (EN + PT-BR) on mount
    useEffect(() => {
        const findVoices = () => {
            const voices = window.speechSynthesis.getVoices();
            if (voices.length === 0) return;

            // ── Inglês — ordem de preferência por qualidade ──
            // Prioridade 1: vozes Online/Natural/Neural (Microsoft) — soam humanas no Chrome/Edge
            // Prioridade 2: vozes Enhanced/Premium (macOS Safari/Chrome)
            // Prioridade 3: Google US English (servidor Google, boa qualidade)
            // Prioridade 4: vozes offline decentes
            const pickBestEnglish = (list: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
                const allEnglish = list.filter(v => v.lang.startsWith('en'));
                const americanEnglish = allEnglish.filter(v => v.lang.toLowerCase().startsWith('en-us'));
                const en = americanEnglish.length > 0 ? americanEnglish : allEnglish;

                // Tier 1 — Microsoft Neural Online (Windows Chrome/Edge)
                const msNatural = en.find(v =>
                    v.name.includes('Online') || v.name.includes('Natural') ||
                    v.name.includes('Neural') || v.name.includes('Aria') ||
                    v.name.includes('Jenny') || v.name.includes('Ana') ||
                    v.name.includes('Guy')
                );
                if (msNatural) return msNatural;

                // Tier 2 — macOS Enhanced/Premium
                const macEnhanced = en.find(v =>
                    v.name.includes('Enhanced') || v.name.includes('Premium') ||
                    v.name.includes('Samantha') || v.name.includes('Serena') ||
                    v.name.includes('Karen') || v.name.includes('Daniel') ||
                    v.name.includes('Moira') || v.name.includes('Tessa')
                );
                if (macEnhanced) return macEnhanced;

                // Tier 3 — Google TTS online
                const google = en.find(v =>
                    v.name.startsWith('Google') && v.lang.startsWith('en')
                );
                if (google) return google;

                // Tier 4 — qualquer en-US
                return en.find(v => v.lang === 'en-US') || en[0] || null;
            };

            const enVoice = pickBestEnglish(voices);
            if (enVoice) {
                englishVoiceRef.current = enVoice;
                console.log('🎙️ EN voice selecionada:', enVoice.name, '|', enVoice.lang, '| remote:', enVoice.localService === false);
            }

            // ── Português BR ──
            const ptBrVoices = voices.filter(v => v.lang.toLowerCase().startsWith('pt-br'));
            const portugueseVoices = ptBrVoices.length > 0
                ? ptBrVoices
                : voices.filter(v => v.lang.toLowerCase().startsWith('pt'));
            const preferredPt = ['Luciana', 'Felipe', 'Google português do Brasil', 'Google português', 'pt-BR'];
            let ptVoice: SpeechSynthesisVoice | null = null;
            for (const name of preferredPt) {
                ptVoice = portugueseVoices.find(v => v.name.includes(name) || v.lang === name) || null;
                if (ptVoice) break;
            }
            if (!ptVoice) ptVoice = portugueseVoices[0] || null;
            if (ptVoice) {
                ptBrVoiceRef.current = ptVoice;
                console.log('🎙️ PT voice:', ptVoice.name, ptVoice.lang);
            }
        };

        findVoices();
        window.speechSynthesis.onvoiceschanged = findVoices;
        return () => { window.speechSynthesis.onvoiceschanged = null; };
    }, []);

    // Inicializa stream de áudio apenas para visualização do orb (não para transcrição)
    useEffect(() => {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => setAudioStream(stream))
            .catch(err => console.warn('Orb audio stream denied (orb ficará estático):', err));

        return () => {
            stopSpeaking();
            stopIOSKeepAlive();
            recognitionRef.current?.abort();
            setAudioStream(prev => { prev?.getTracks().forEach(t => t.stop()); return null; });
        };
    }, []);

    // Session timer
    useEffect(() => {
        const timer = setInterval(() => {
            const diff = Math.floor((Date.now() - sessionStart.getTime()) / 1000);
            setElapsed(diff);
            if (diff >= MAX_SESSION_MINUTES * 60) {
                setError(`Sessão encerrada (${MAX_SESSION_MINUTES} min)`);
                clearInterval(timer);
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [sessionStart]);

    // Carrega histórico da última sessão do aluno (persiste entre logins)
    useEffect(() => {
        const loadLastSession = async () => {
            if (!user?.id) {
                setIsLoadingHistory(false);
                return;
            }
            // Uma atividade escolhida deve sempre abrir uma sessão nova e fiel ao
            // tema atual. A memória pedagógica continua vindo do wolfie-brain,
            // mas o histórico de outro tema não pode ser reaproveitado aqui.
            if (initialTopic) {
                setIsLoadingHistory(false);
                return;
            }
            try {
                // 1. Pega a sessão mais recente do aluno
                const { data: lastSession } = await supabase
                    .from('wolfie_sessions')
                    .select('id, topic, started_at')
                    .eq('student_id', user.id)
                    .order('started_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (!lastSession) {
                    setIsLoadingHistory(false);
                    return;
                }

                // 2. Pega os últimos 20 turnos dessa sessão
                const { data: turns } = await supabase
                    .from('wolfie_turns')
                    .select('id, speaker, content, turn_index, created_at')
                    .eq('session_id', lastSession.id)
                    .order('turn_index', { ascending: true })
                    .limit(20);

                if (turns && turns.length > 0) {
                    const restored: Message[] = turns.map((t: any) => ({
                        id: t.id,
                        role: t.speaker === 'student' ? 'user' : 'assistant',
                        content: t.content || '',
                        timestamp: new Date(t.created_at),
                    }));
                    setMessages(restored);
                    setConversationId(lastSession.id);
                    setTurnCount(Math.floor(turns.length / 2));
                    if (lastSession.topic && !initialTopic) {
                        setTopic(lastSession.topic);
                        setHasSelectedTopic(true);
                    }
                    console.log(`[WolfieTutor] Histórico restaurado: ${turns.length} turnos da sessão ${lastSession.id}`);
                }
            } catch (err) {
                console.error('[WolfieTutor] Erro ao carregar histórico:', err);
            } finally {
                setIsLoadingHistory(false);
            }
        };
        loadLastSession();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]);

    // Auto-scroll messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // ============================================================
    // TTS FUNCTIONS
    // ============================================================

    /**
     * Desbloqueia áudio para iOS Safari — DEVE ser chamado dentro de um
     * handler de toque/clique síncrono (onTouchStart, onClick, etc).
     *
     * iOS exige que o desbloqueio seja feito em três camadas:
     * 1. AudioContext.resume() + tocar buffer silencioso (obrigatório para neural TTS)
     * 2. SpeechSynthesis unlock (obrigatório para o fallback Web Speech API)
     *
     * Sem isso, qualquer audio.play() ou speechSynthesis.speak() em callbacks
     * assíncronos (após fetch/invoke) é silenciosamente bloqueado pelo iOS.
     */
    const unlockAudio = useCallback(() => {
        try {
            // ── 1. AudioContext: cria + toca buffer silencioso ──
            const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
            if (AudioCtx) {
                if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
                    audioCtxRef.current = new AudioCtx();
                }
                const ctx = audioCtxRef.current;
                const playUnlockBuffer = () => {
                    try {
                        // 1 sample de silêncio — suficiente para iOS considerar o output "ativo"
                        const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
                        const src = ctx.createBufferSource();
                        src.buffer = buf;
                        src.connect(ctx.destination);
                        src.start(0);
                    } catch (_) {}
                };
                if (ctx.state === 'suspended') {
                    ctx.resume().then(playUnlockBuffer).catch(() => {});
                } else {
                    playUnlockBuffer();
                }
            }
        } catch (e) {
            console.warn('[WolfieTutor] AudioContext unlock error:', e);
        }
        try {
            // ── 2. Web Speech API unlock (fallback iOS) ──
            if ('speechSynthesis' in window) {
                const u = new SpeechSynthesisUtterance('');
                window.speechSynthesis.speak(u);
                window.speechSynthesis.cancel();
            }
        } catch (_) {}

        // ── 3. iOS: pré-ativa HTMLAudioElement com WAV válido ──
        // CRÍTICO: play() com src VAZIO não ativa o elemento no iOS.
        // É necessário um src válido para que o iOS registre a gesture.
        // Usamos um WAV de 0 samples (toca instantaneamente e silenciosamente).
        if (IS_IOS) {
            try {
                const audio = new Audio(SILENT_WAV);
                audio.volume = 0;
                preUnlockedAudioRef.current = audio;
                // play() aqui → iOS considera o elemento "ativado" para playback futuro
                audio.play().then(() => audio.pause()).catch(() => {});
            } catch (_) {}
        }
    }, []);

    /**
     * iOS AudioContext Keepalive
     * O iOS auto-suspende o AudioContext após ~1-2s de inatividade.
     * Jogamos 1 sample de silêncio a cada 500ms para mantê-lo "running"
     * durante o fetch assíncrono ao wolfie-brain + wolfie-tts (~2-4s).
     */
    const startIOSKeepAlive = useCallback(() => {
        if (!IS_IOS || iosKeepAliveRef.current) return;
        iosKeepAliveRef.current = setInterval(() => {
            const ctx = audioCtxRef.current;
            if (!ctx || ctx.state === 'closed') {
                clearInterval(iosKeepAliveRef.current!);
                iosKeepAliveRef.current = null;
                return;
            }
            if (ctx.state !== 'running') return; // já suspendeu — não tenta tocar
            try {
                const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.start(0); // 1 sample de silêncio — iOS não suspende contexto ativo
            } catch (_) {}
        }, 500);
        console.log('[iOS] AudioContext keepalive iniciado');
    }, []);

    const stopIOSKeepAlive = useCallback(() => {
        if (iosKeepAliveRef.current) {
            clearInterval(iosKeepAliveRef.current);
            iosKeepAliveRef.current = null;
            console.log('[iOS] AudioContext keepalive parado');
        }
    }, []);

    /** Para a voz (AudioContext + HTMLAudio + Web Speech) e limpa o estado */
    const stopSpeaking = useCallback(() => {
        // Para AudioContext source (iOS + desktop)
        if (audioSourceRef.current) {
            try { audioSourceRef.current.stop(); } catch (_) {}
            audioSourceRef.current = null;
        }
        // Para HTMLAudioElement (fallback desktop)
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
            audioRef.current = null;
        }
        // Para Web Speech API (fallback final)
        window.speechSynthesis.cancel();
        setState(prev => prev === 'SPEAKING' ? 'IDLE' : prev);
        setSubtitle('');
    }, []);

    /** Prepara texto para soar natural no TTS — remove markdown e adiciona pausas */
    const prepareForTTS = (raw: string): string => raw
        .replace(/\*\*(.*?)\*\*/g, '$1')        // bold → texto puro
        .replace(/\*(.*?)\*/g, '$1')            // itálico → texto puro
        .replace(/`(.*?)`/g, '$1')              // code → texto puro
        .replace(/#{1,6}\s+/g, '')              // headings
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')     // links → só o label
        .replace(/---+/g, '.')                  // separadores → ponto
        .replace(/\n{2,}/g, ', ')               // parágrafos → pausa curta
        .replace(/\n/g, ' ')                    // linha única → espaço
        .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → palavras separadas
        .replace(/\s{2,}/g, ' ')                // espaços duplos
        .trim();

    /**
     * Fallback: Web Speech API (local, sem qualidade neural)
     * Usado quando o edge function wolfie-tts falha.
     */
    const speakWebSpeech = useCallback((text: string, speed?: number, forceLang?: 'en' | 'pt') => {
        const lang = forceLang ?? 'en'; // sempre inglês por padrão
        const clean = prepareForTTS(text);
        const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];

        let idx = 0;
        const speakNext = () => {
            if (idx >= sentences.length) {
                setState('IDLE');
                setSubtitle('');
                return;
            }
            const sentence = sentences[idx++].trim();
            if (!sentence) { speakNext(); return; }

            const utterance = new SpeechSynthesisUtterance(sentence);

            if (lang === 'pt' && ptBrVoiceRef.current) {
                utterance.voice = ptBrVoiceRef.current;
                utterance.lang = 'pt-BR';
                utterance.rate = speed ?? 1.0;
                utterance.pitch = 1.05;
            } else {
                if (englishVoiceRef.current) {
                    utterance.voice = englishVoiceRef.current;
                    utterance.lang = englishVoiceRef.current.lang;
                } else {
                    utterance.lang = 'en-US';
                }
                utterance.rate = speed ?? getTTSSpeed(studentLevel);
                utterance.pitch = 1.0;
            }

            utterance.volume = 1.0;
            utterance.onend = speakNext;
            utterance.onerror = () => { setState('IDLE'); setSubtitle(''); };
            window.speechSynthesis.speak(utterance);
        };

        window.speechSynthesis.cancel();
        speakNext();
    }, [studentLevel]);

    /**
     * Fala usando Microsoft Neural TTS via edge function wolfie-tts.
     * Vozes: en-US-JennyNeural (inglês) | pt-BR-FranciscaNeural (português)
     * Qualidade humana, sem API key, sem custo.
     * Fallback automático para Web Speech API em caso de falha.
     */
    const speak = useCallback(async (text: string, speed?: number, forceLang?: 'en' | 'pt') => {
        setState('SPEAKING');
        setSubtitle(text);
        lastSpokenTextRef.current = text;

        const lang = forceLang ?? 'en';
        const voice = lang === 'pt' ? 'pt-BR-ThalitaNeural' : 'en-US-JennyNeural';
        const rate = speed ?? (lang === 'pt' ? 1.0 : getTTSSpeed(studentLevel));

        // Para qualquer áudio anterior
        if (audioSourceRef.current) {
            try { audioSourceRef.current.stop(); } catch (_) {}
            audioSourceRef.current = null;
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
            audioRef.current = null;
        }
        window.speechSynthesis.cancel();

        try {
            const { data, error: fnError } = await supabase.functions.invoke('wolfie-tts', {
                body: { text, voice, speed: rate }
            });

            if (fnError || !data?.audio) {
                throw new Error(fnError?.message || 'wolfie-tts sem áudio');
            }

            // Decodifica base64 → ArrayBuffer
            const rawBase64 = data.audio; // guardamos para data URI fallback
            const binary = atob(rawBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            // ── iOS: tenta TODAS as abordagens em sequência ──
            if (IS_IOS) {
                stopIOSKeepAlive();

                const showIOSDebug = (msg: string) => {
                    console.warn('[iOS audio]', msg);
                };

                // ── iOS 1: HTMLAudioElement pré-ativado ──
                // O iOS vincula permissão de play ao ELEMENTO que recebeu
                // play() com src VÁLIDO durante o toque (SILENT_WAV).
                if (preUnlockedAudioRef.current) {
                    const preAudio = preUnlockedAudioRef.current;
                    preUnlockedAudioRef.current = null;
                    try {
                        const blob = new Blob([bytes], { type: 'audio/mpeg' });
                        const blobUrl = URL.createObjectURL(blob);
                        preAudio.volume = 1.0;
                        preAudio.src = blobUrl;
                        preAudio.onended = () => { URL.revokeObjectURL(blobUrl); audioRef.current = null; setState('IDLE'); setSubtitle(''); };
                        preAudio.onerror = () => { URL.revokeObjectURL(blobUrl); };
                        await preAudio.play();
                        audioRef.current = preAudio;
                        console.log(`🎙️ iOS HTMLAudio (pré-ativado): ${voice}`);
                        return;
                    } catch (e1: any) {
                        showIOSDebug(`HTMLAudio blob: ${e1?.message ?? e1}`);
                    }

                    // ── iOS 1b: data URI (sem blob URL, direto no src) ──
                    try {
                        preAudio.src = `data:audio/mpeg;base64,${rawBase64}`;
                        preAudio.volume = 1.0;
                        preAudio.onended = () => { audioRef.current = null; setState('IDLE'); setSubtitle(''); };
                        await preAudio.play();
                        audioRef.current = preAudio;
                        console.log(`🎙️ iOS HTMLAudio (data URI): ${voice}`);
                        return;
                    } catch (e1b: any) {
                        showIOSDebug(`HTMLAudio dataURI: ${e1b?.message ?? e1b}`);
                    }
                } else {
                    showIOSDebug('preUnlocked=null (toque no orb primeiro?)');
                }

                // ── iOS 2: AudioContext com keepalive ──
                const ctx = audioCtxRef.current;
                if (ctx && ctx.state !== 'closed') {
                    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
                    try {
                        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
                        const source = ctx.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(ctx.destination);
                        source.onended = () => { audioSourceRef.current = null; setState('IDLE'); setSubtitle(''); };
                        audioSourceRef.current = source;
                        source.start(0);
                        console.log(`🎙️ iOS AudioContext: ${voice} | ctx: ${ctx.state}`);
                        return;
                    } catch (e2: any) {
                        showIOSDebug(`AudioContext: ${e2?.message ?? e2} (ctx=${ctx.state})`);
                    }
                } else {
                    showIOSDebug(`ctx=${ctx?.state ?? 'null'}`);
                }

                // ── iOS 3: Web Speech API (último recurso) ──
                showIOSDebug('fallback Web Speech');
                speakWebSpeech(text, rate, lang);
                return;
            }

            // ── Desktop: AudioContext primeiro ──
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state !== 'closed') {
                if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
                try {
                    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
                    stopIOSKeepAlive();
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(ctx.destination);
                    source.onended = () => { audioSourceRef.current = null; setState('IDLE'); setSubtitle(''); };
                    audioSourceRef.current = source;
                    source.start(0);
                    console.log(`🎙️ Neural TTS (AudioContext): ${voice} | speed: ${rate}`);
                    return;
                } catch (decodeErr) {
                    console.warn('[WolfieTutor] AudioContext decode falhou:', decodeErr);
                    stopIOSKeepAlive();
                }
            } else {
                stopIOSKeepAlive();
            }

            // ── Fallback desktop: HTMLAudioElement ──
            if (!IS_IOS) {
                const blob = new Blob([bytes], { type: 'audio/mpeg' });
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audioRef.current = audio;
                audio.onended = () => { URL.revokeObjectURL(url); audioRef.current = null; setState('IDLE'); setSubtitle(''); };
                audio.onerror = () => {
                    URL.revokeObjectURL(url); audioRef.current = null;
                    speakWebSpeech(text, rate, lang);
                };
                try {
                    await audio.play();
                    console.log(`🎙️ Neural TTS (HTMLAudio): ${voice} | speed: ${rate}`);
                    return;
                } catch (_) {
                    speakWebSpeech(text, rate, lang);
                    return;
                }
            }

        } catch (err: any) {
            const errMsg = err?.message ?? String(err);
            console.warn('[WolfieTutor] wolfie-tts erro:', errMsg);
            stopIOSKeepAlive();
            speakWebSpeech(text, speed, lang);
        }
    }, [studentLevel, speakWebSpeech, stopIOSKeepAlive]);

    const slowReplay = () => {
        if (lastSpokenTextRef.current) {
            stopSpeaking();
            const replayLanguage = detectSpeechLanguage(lastSpokenTextRef.current);
            void speak(lastSpokenTextRef.current, 0.88, replayLanguage);
        }
    };

    // ============================================================
    // VOICE INPUT — Web Speech API (hold to speak, bilingual PT+EN)
    // ============================================================
    const startRecording = () => {
        // Permite iniciar em IDLE ou SPEAKING (interrompe o Wolfie)
        if (state !== 'IDLE' && state !== 'SPEAKING') return;
        if (isProcessingRef.current) return;

        // ── Desbloqueia AudioContext no iOS (DEVE ser no handler de toque) ──
        unlockAudio();
        // iOS: inicia keepalive IMEDIATAMENTE após unlock para impedir auto-suspensão
        // O keepalive fica ativo durante gravação + fetch (~5-10s total)
        startIOSKeepAlive();

        // ── Para a voz do Wolfie (neural + Web Speech) ──
        if (audioSourceRef.current) {
            try { audioSourceRef.current.stop(); } catch (_) {}
            audioSourceRef.current = null;
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
            audioRef.current = null;
        }
        window.speechSynthesis.cancel();
        setState('IDLE');
        setSubtitle('');
        setCorrection(null); setTranslation(null); setVocabulary(null); setQuiz(null); setError(null);

        const SpeechRec = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
        if (!SpeechRec) {
            setError('Reconhecimento de voz não suportado. Use o campo de texto.');
            setTimeout(() => setError(null), 5000);
            setShowTextInput(true);
            return;
        }

        // Aguarda 400ms para o speaker parar fisicamente antes de ligar o mic
        recordingDelayRef.current = setTimeout(() => {
            if (recognitionRef.current) {
                recognitionRef.current.onresult = null;
                recognitionRef.current.onerror = null;
                recognitionRef.current.onend = null;
                try { recognitionRef.current.abort(); } catch (_) {}
                recognitionRef.current = null;
            }

            finalTranscriptRef.current = '';

            const recognition = new SpeechRec();
            // pt-BR: entende português E inglês falado por brasileiros
            recognition.lang = 'pt-BR';
            // continuous = true: NÃO corta enquanto o usuário segura o orb
            recognition.continuous = true;
            // interimResults = true: mostra legenda em tempo real enquanto fala
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;
            recognitionRef.current = recognition;

            recognition.onresult = (event: any) => {
                // Acumula todo texto final + exibe interim como legenda ao vivo
                let finalText = '';
                let interimText = '';
                for (let i = 0; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        finalText += event.results[i][0].transcript + ' ';
                    } else {
                        interimText += event.results[i][0].transcript;
                    }
                }
                finalTranscriptRef.current = finalText.trim();
                // Mostra o que já reconheceu como legenda (feedback visual ao vivo)
                setSubtitle(interimText || finalText.trim());
            };

            recognition.onerror = (event: any) => {
                // 'aborted' é silencioso (usuário soltou antes do delay)
                if (event.error !== 'aborted') {
                    const msgs: Record<string, string> = {
                        'no-speech':     'Não ouvi nada — segure e fale mais perto',
                        'audio-capture': 'Microfone não encontrado',
                        'not-allowed':   'Permissão do microfone negada',
                        'network':       'Erro de rede no reconhecimento de voz',
                    };
                    const msg = msgs[event.error] ?? `Erro: ${event.error}`;
                    if (msg) { setError(msg); setTimeout(() => setError(null), 4000); }
                }
                setState('IDLE');
                setSubtitle('');
            };

            recognition.onend = () => {
                // Chamado quando stop() é acionado pelo mouseup/touchend
                const transcript = finalTranscriptRef.current.trim();
                setSubtitle('');

                if (!transcript) {
                    setState('IDLE');
                    if (!isProcessingRef.current) {
                        setError('Não ouvi nada — segure o orb e fale');
                        setTimeout(() => setError(null), 3000);
                    }
                    return;
                }

                if (isProcessingRef.current) {
                    console.warn('🎤 Resultado ignorado — já processando outro');
                    setState('IDLE');
                    return;
                }

                console.log('🎤 Transcrito:', transcript);
                const newUserMsg: Message = { id: crypto.randomUUID(), role: 'user', content: transcript, timestamp: new Date() };
                setMessages(prev => [...prev, newUserMsg]);
                setState('THINKING');
                sendToWolfieBrain({ message: transcript });
            };

            recognition.start();
            setState('LISTENING');
        }, 400);
    };

    const stopRecordingAndSend = () => {
        if (recordingDelayRef.current) {
            clearTimeout(recordingDelayRef.current);
            recordingDelayRef.current = null;
        }
        if (state !== 'LISTENING') return;
        // iOS: re-bloqueia AudioContext no touchEnd — momento mais próximo do speak()
        // Isso garante que o AudioContext permanece "running" durante o fetch assíncrono
        if (IS_IOS) unlockAudio();
        // stop() termina a sessão → dispara onend com o transcript acumulado
        recognitionRef.current?.stop();
    };

    const sendMessage = async (text: string) => {
        if (!text.trim()) return;
        unlockAudio(); // desbloqueia AudioContext no iOS para o texto também
        setInputText('');
        setState('THINKING');
        stopSpeaking();
        setCorrection(null); setTranslation(null); setVocabulary(null); setQuiz(null);

        // Add user message to chat
        const newUserMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: new Date() };
        setMessages(prev => [...prev, newUserMsg]);

        await sendToWolfieBrain({ message: text });
    };

    const sendToWolfieBrain = async (input: { message?: string; audioBase64?: string }) => {
        if (isProcessingRef.current) {
            console.warn('[Wolfie] sendToWolfieBrain ignorado — já está processando');
            return;
        }
        isProcessingRef.current = true;

        // ── Detecta idioma do input para resposta bilíngue ──
        // Se o aluno falou PT → Wolfie responde em PT (FranciscaNeural)
        // Se falou EN → Wolfie responde em EN (JennyNeural)
        const studentLang: SpeechLanguage = detectSpeechLanguage(input.message || '', 'en');

        try {
            const history = messages.slice(-6).map(m => `${m.role === 'user' ? 'Student' : 'Wolfie'}: ${m.content}`).join('\n');
            const fullContext = context ? `MISSION CONTEXT: ${context}\n\nCONVERSATION HISTORY:\n${history}` : history;

            const modeMap: Record<string, string> = {
                'interview': 'job_interview', 'job': 'job_interview',
                'exam': 'exam_prep', 'ielts': 'exam_prep', 'toefl': 'exam_prep',
                'grammar': 'grammar_focus'
            };
            const topicLower = topic.toLowerCase();
            const mode = Object.entries(modeMap).find(([k]) => topicLower.includes(k))?.[1] || 'fluency';

            const { data, error: supabaseError } = await supabase.functions.invoke('wolfie-brain', {
                body: {
                    ...input,
                    studentLevel,
                    topic,
                    previousContext: fullContext,
                    // Quando aluno fala PT, desativa tradução (já está em PT)
                    translationEnabled: studentLang === 'pt' ? false : translationEnabled,
                    vocabularyEnabled: true,
                    mode,
                    correctionStrictness: mode === 'exam_prep' || mode === 'grammar_focus' ? 3 : 1,
                    allowPortuguese: true,
                    turnCount,
                    conversationId,
                    studentLanguage: studentLang, // PT ou EN — Wolfie responde no mesmo idioma
                }
            });

            if (supabaseError || data?.error) {
                throw new Error(data?.error || supabaseError?.message || 'Unknown error');
            }

            const chatText = data.chatResponse || data.aiText || '';

            const aiMessage: Message = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: chatText,
                timestamp: new Date(),
                correction: data.correction || null,
                translation: data.translation || null,
                vocabulary: data.vocabulary || null,
                quiz: data.quiz || null,
            };

            setMessages(prev => [...prev, aiMessage]);
            setTurnCount(prev => prev + 1);
            if (data.conversationId) setConversationId(data.conversationId);

            if (data.correction) setCorrection(data.correction);
            if (data.translation) setTranslation(data.translation);
            if (data.vocabulary?.keyTerms?.length > 0) setVocabulary(data.vocabulary);
            if (data.quiz) setQuiz(data.quiz);

            // Auto-speak: usa o idioma da RESPOSTA (não do input do aluno)
            // Isso evita pronuncia americanizada quando Wolfie responde em PT
            // mas o input do aluno estava em EN (ou vazio no primeiro turno)
            const responseLang: SpeechLanguage = detectSpeechLanguage(chatText, studentLang);
            if (autoSpeakEnabled && chatText) {
                void speak(chatText, undefined, responseLang);
            } else {
                setState('IDLE');
            }

        } catch (err: any) {
            console.error('Wolfie Brain Error:', err);
            setError(err.message || 'Erro de conexão');
            setState('IDLE');
            setTimeout(() => setError(null), 5000);
        } finally {
            // Libera o lock sempre — seja sucesso ou erro
            isProcessingRef.current = false;
        }
    };

    // Auto-start first turn when mode is selected
    useEffect(() => {
        if (hasSelectedTopic && messages.length === 0 && state === 'IDLE') {
            setState('THINKING');
            sendToWolfieBrain({});
        }
    }, [hasSelectedTopic, messages.length]);

    // ============================================================
    // VISUAL HELPERS
    // ============================================================
    const getOrbHue = () => {
        switch (state) {
            case 'IDLE': return 220;
            case 'LISTENING': return 0;
            case 'THINKING': return 280;
            case 'SPEAKING': return 180;
        }
    };

    const getStatusLabel = () => {
        switch (state) {
            case 'IDLE': return 'Pronto para Ouvir';
            case 'LISTENING': return 'Ouvindo...';
            case 'THINKING': return 'Wolfie Pensando...';
            case 'SPEAKING': return 'Wolfie Falando';
        }
    };

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    const handleModeSelection = (mode: 'voice' | 'text') => {
        // Desbloqueia AudioContext no iOS — esse clique é o primeiro gesto do usuário
        unlockAudio();

        setTopic('Conversa Livre');
        setContext('');
        setShowTextInput(mode === 'text');
        setHasSelectedTopic(true);

        // Se escolheu voz, podemos até já acionar o áudio, ou deixar ele apertar. 
        // Vamos deixar ele apertar o orb, já avisamos no prompt o que fazer.
    };

    // ============================================================
    // ENTRY SCREEN — CHOOSE MODE
    // ============================================================
    if (!hasSelectedTopic) {
        return (
            <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden font-sans">
                {/* Background Atmosphere */}
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_#1e1b4b_0%,_#020617_60%)] pointer-events-none" />
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                    <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[100px] animate-pulse" />
                    <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />
                </div>

                {onClose && (
                    <button onClick={onClose} aria-label="Fechar Wolfie Tutor" className="absolute top-4 right-4 sm:top-6 sm:right-6 p-3 rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group">
                        <X size={20} className="group-hover:rotate-90 transition-transform duration-300" />
                    </button>
                )}

                <div className="relative z-10 max-w-4xl w-full flex flex-col items-center text-center px-4">
                    <div className="mb-8 sm:mb-12">
                        <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 mb-4 sm:mb-6">
                            <BrainCircuit size={14} />
                            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest">Wolfie AI (Powered by Gemini)</span>
                        </div>
                        <h1 className="text-3xl sm:text-5xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-200 to-indigo-300 drop-shadow-2xl mb-4 sm:mb-6">
                            Olá, {user?.full_name?.split(' ')[0] || 'Aluno'}!
                        </h1>
                        <p className="text-slate-400 text-base sm:text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
                            Como você prefere praticar o seu inglês hoje?
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4 sm:gap-6 w-full max-w-2xl mx-auto">
                        {/* Voice Mode */}
                        <button
                            onClick={() => handleModeSelection('voice')}
                            className="group relative p-5 sm:p-8 rounded-2xl sm:rounded-3xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all duration-300 overflow-hidden flex flex-col items-center text-center"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-full bg-indigo-500/20 flex items-center justify-center mb-3 sm:mb-6 group-hover:scale-110 group-hover:bg-indigo-500 transition-all duration-300">
                                <Mic size={24} className="sm:w-8 sm:h-8 text-indigo-400 group-hover:text-white transition-colors" />
                            </div>
                            <h3 className="text-base sm:text-2xl font-bold text-white mb-1 sm:mb-3">Por Voz</h3>
                            <p className="text-slate-400 text-xs sm:text-sm hidden sm:block">Pratique com conversas em tempo real usando o microfone.</p>
                        </button>

                        {/* Text Mode */}
                        <button
                            onClick={() => handleModeSelection('text')}
                            className="group relative p-5 sm:p-8 rounded-2xl sm:rounded-3xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all duration-300 overflow-hidden flex flex-col items-center text-center"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 to-teal-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-3 sm:mb-6 group-hover:scale-110 group-hover:bg-emerald-500 transition-all duration-300">
                                <MessageSquare size={24} className="sm:w-8 sm:h-8 text-emerald-400 group-hover:text-white transition-colors" />
                            </div>
                            <h3 className="text-base sm:text-2xl font-bold text-white mb-1 sm:mb-3">Por Texto</h3>
                            <p className="text-slate-400 text-xs sm:text-sm hidden sm:block">Pratique a escrita através do chat interativo do Wolfie.</p>
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================
    // RENDER — UNIFIED VOICE + TEXT EXPERIENCE
    // ============================================================
    return (
        <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center overflow-hidden font-sans">

            {/* BACKGROUND EFFECTS */}
            <div className={`absolute inset-0 transition-colors duration-1000 ${state === 'LISTENING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-red-900/30 via-slate-950 to-slate-950' :
                state === 'THINKING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-900/30 via-slate-950 to-slate-950' :
                    state === 'SPEAKING' ? 'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-900/30 via-slate-950 to-slate-950' :
                        'bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950'
                }`}></div>
            {/* Noise texture inline — sem dependência externa */}
            <div className="absolute inset-0 opacity-[0.15] pointer-events-none mix-blend-overlay" style={{backgroundImage:"url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")", backgroundSize:'200px 200px'}}></div>

            {/* CLOSE BUTTON */}
            {onClose && (
                <button onClick={onClose} aria-label="Fechar Wolfie Tutor" className="absolute top-4 right-4 sm:top-6 sm:right-6 p-3 rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group">
                    <X size={20} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
            )}

            {/* HEADER HUD */}
            <div className="absolute top-4 sm:top-6 left-1/2 -translate-x-1/2 z-40 w-full px-16 sm:px-20 flex flex-col items-center gap-2">
                {/* Status Badge */}
                <div className="flex items-center gap-3 px-5 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-md shadow-2xl">
                    <div className={`w-2 h-2 rounded-full ${state === 'LISTENING' ? 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]' :
                        state === 'THINKING' ? 'bg-purple-500 animate-pulse' :
                            state === 'SPEAKING' ? 'bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.8)]' :
                                'bg-indigo-500'}`} />
                    <span className="text-[10px] font-bold text-white/90 tracking-[0.2em] uppercase">{getStatusLabel()}</span>
                    <span
                        className="hidden sm:block max-w-[220px] truncate border-l border-white/10 pl-3 text-[10px] font-semibold text-cyan-200/80"
                        title={`Tema mantido: ${topic}`}
                    >
                        Tema: {topic}
                    </span>
                </div>

                {/* Timer + Level + Controls */}
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 backdrop-blur-md">
                        <Clock size={10} className="text-slate-400" />
                        <span className="text-[10px] font-mono text-slate-400">{formatTime(elapsed)}</span>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-[10px] font-bold text-indigo-300 uppercase tracking-wider">
                        {studentLevel}
                    </div>
                    {/* Translation Toggle */}
                    <button
                        onClick={() => setTranslationEnabled(p => !p)}
                        className={`p-1.5 rounded-full border transition-all ${translationEnabled ? 'bg-sky-500/15 border-sky-500/30 text-sky-300' : 'bg-white/5 border-white/10 text-slate-400'}`}
                        title={translationEnabled ? 'Tradução ON' : 'Tradução OFF'}
                    >
                        <Languages size={12} />
                    </button>
                    {/* Auto-Speak Toggle */}
                    <button
                        onClick={() => { setAutoSpeakEnabled(p => !p); if (state === 'SPEAKING') stopSpeaking(); }}
                        className={`p-1.5 rounded-full border transition-all ${autoSpeakEnabled ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-white/5 border-white/10 text-slate-400'}`}
                        title={autoSpeakEnabled ? 'Auto-speak ON' : 'Auto-speak OFF'}
                    >
                        {autoSpeakEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
                    </button>
                    {/* Text Toggle */}
                    <button
                        onClick={() => setShowTextInput(p => !p)}
                        className={`p-1.5 rounded-full border transition-all ${showTextInput ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-400'}`}
                        title={showTextInput ? 'Teclado ON' : 'Teclado OFF'}
                    >
                        <MessageSquare size={12} />
                    </button>
                    {/* Slow Replay */}
                    <button
                        onClick={slowReplay}
                        disabled={!lastSpokenTextRef.current}
                        className="p-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                        title="Repetir devagar (0.88x)"
                    >
                        <RotateCcw size={12} />
                    </button>
                    {/* Nova Conversa — reseta sessão (cria nova session_id no banco no próximo turno) */}
                    <button
                        onClick={() => {
                            if (!confirm(`Reiniciar a conversa mantendo o tema atual: "${topic}"?`)) return;
                            stopSpeaking();
                            setMessages([]);
                            setConversationId(null);
                            setTurnCount(0);
                            setCorrection(null);
                            setTranslation(null);
                            setVocabulary(null);
                            setQuiz(null);
                            setError(null);
                            setSubtitle('');
                        }}
                        className="px-2.5 py-1.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-300 text-[10px] font-bold uppercase tracking-wider hover:bg-fuchsia-500/25 transition-all"
                        title="Reiniciar mantendo o mesmo tema"
                    >
                        Nova
                    </button>
                </div>

                {/* Idle Hint */}
                {state === 'IDLE' && (
                    <div className="text-white/30 text-[9px] font-bold tracking-[0.3em] uppercase animate-pulse">
                        Pressione a esfera para falar
                    </div>
                )}
            </div>

            {/* ERROR FEEDBACK */}
            {error && (
                <div className="absolute top-32 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
                    <div className="bg-red-950/80 backdrop-blur-2xl border border-red-500/50 text-red-200 px-6 py-3 rounded-2xl flex items-center gap-3 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-xs font-bold tracking-[0.1em] uppercase">{error}</span>
                    </div>
                </div>
            )}

            {/* ============================================================ */}
            {/* MAIN INTERACTION AREA — THE ORB */}
            {/* ============================================================ */}
            <div className="relative z-20 flex flex-col items-center justify-center w-full h-full max-w-5xl mx-auto">
                <div
                    className="relative w-[260px] h-[260px] sm:w-[320px] sm:h-[320px] md:w-[500px] md:h-[500px] cursor-pointer touch-none select-none flex items-center justify-center group"
                    style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties}
                    onMouseDown={startRecording}
                    onMouseUp={stopRecordingAndSend}
                    onMouseLeave={() => state === 'LISTENING' && stopRecordingAndSend()}
                    onTouchStart={(e) => { e.preventDefault(); startRecording(); }}
                    onTouchEnd={(e) => { e.preventDefault(); stopRecordingAndSend(); }}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <VoicePoweredOrb
                        hue={getOrbHue()}
                        audioStream={audioStream}
                        voiceSensitivity={2.0}
                        maxRotationSpeed={1.5}
                        maxHoverIntensity={1.0}
                        onVoiceDetected={setIsVoiceDetected}
                    />

                    {/* Hover Hint */}
                    {state === 'IDLE' && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500">
                            <div className="px-5 py-2.5 rounded-full bg-white/10 backdrop-blur-xl border border-white/20 tracking-[0.2em] text-white/90 text-[10px] font-bold uppercase shadow-2xl">
                                Segure para falar
                            </div>
                        </div>
                    )}
                </div>

                {/* Subtitles */}
                <div className="absolute bottom-24 sm:bottom-20 md:bottom-28 left-0 right-0 px-4 sm:px-8 text-center pointer-events-none z-30 min-h-[80px] flex flex-col items-center justify-end">
                    {subtitle ? (
                        <p className="text-base sm:text-xl md:text-2xl lg:text-3xl font-light text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-6 duration-700 max-w-4xl mx-auto leading-relaxed">
                            "{subtitle}"
                        </p>
                    ) : state !== 'IDLE' ? (
                        <p className={`text-xs tracking-[0.4em] font-bold uppercase ${state === 'THINKING' ? 'text-purple-400 animate-pulse' : state === 'LISTENING' ? 'text-red-400 animate-pulse' : 'text-slate-400'}`}>
                            {state === 'THINKING' ? 'Processando...' : state === 'LISTENING' ? 'Ouvindo...' : ''}
                        </p>
                    ) : null}
                </div>
            </div>

            {/* ============================================================ */}
            {/* TEXT INPUT (Collapsible) */}
            {/* ============================================================ */}
            {showTextInput && (
                <div className="absolute bottom-6 left-4 right-4 z-50 max-w-2xl mx-auto animate-in slide-in-from-bottom-6 fade-in duration-300">
                    <div className="flex items-center gap-2 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-full p-2 pl-5 shadow-2xl ring-1 ring-white/5 focus-within:ring-cyan-500/50 transition-all">
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && sendMessage(inputText)}
                            placeholder="Type in English..."
                            disabled={state === 'THINKING'}
                            className="flex-1 min-w-0 bg-transparent border-none text-slate-200 placeholder:text-slate-500 focus:ring-0 focus:outline-none text-sm font-medium"
                        />
                        <button
                            onClick={() => sendMessage(inputText)}
                            disabled={!inputText.trim() || state === 'THINKING'}
                            className="p-2.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all"
                        >
                            {state === 'THINKING' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            )}

            {/* ============================================================ */}
            {/* CORRECTION FEEDBACK CARD (Bottom Left) */}
            {/* ============================================================ */}
            {correction && (
                <div className="absolute bottom-6 left-4 right-4 md:right-auto md:left-8 md:w-[420px] z-40 animate-in slide-in-from-bottom-10 fade-in duration-500">
                    <div className="bg-slate-900/90 backdrop-blur-3xl border border-slate-700/80 p-5 rounded-[1.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.5)] relative overflow-hidden group hover:bg-slate-800/95 transition-colors">
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 opacity-80" />
                        <div className="flex flex-col gap-3 relative z-10">
                            <div className="flex items-center justify-between border-b border-white/5 pb-2">
                                <div className="flex items-center gap-2">
                                    <div className="p-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg">
                                        <Zap size={14} fill="currentColor" />
                                    </div>
                                    <h4 className="text-white font-black text-[10px] uppercase tracking-widest">Correção</h4>
                                </div>
                                <button onClick={() => setCorrection(null)} aria-label="Fechar correção" className="text-slate-400 hover:text-white transition-colors bg-white/5 p-1.5 rounded-full">
                                    <X size={12} />
                                </button>
                            </div>
                            <div className="space-y-2">
                                {correction.original && (
                                    <div className="bg-red-950/30 rounded-xl p-3 border border-red-500/10">
                                        <span className="text-[9px] text-red-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                                            <X size={10} strokeWidth={3} /> Como você disse
                                        </span>
                                        <p className="text-sm font-medium text-white/50 line-through decoration-red-500/50">{correction.original}</p>
                                    </div>
                                )}
                                <div className="bg-emerald-500/10 rounded-xl p-3 border border-emerald-500/20">
                                    <span className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                                        <CheckCircle2 size={10} strokeWidth={3} /> Forma Correta
                                    </span>
                                    <p className="text-base font-black text-emerald-300">"{correction.corrected}"</p>
                                </div>
                                <p className="text-xs text-slate-300 leading-relaxed font-medium">{correction.explanation_pt}</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TRANSLATION CARD (Top Left) */}
            {translation && (
                <div className="absolute top-[130px] left-4 md:left-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-left-8 duration-500">
                    <div className="bg-sky-950/40 backdrop-blur-xl border border-sky-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-sky-950/60 transition-colors">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 text-sky-400">
                                <Languages size={12} />
                                <span className="text-[9px] uppercase font-bold tracking-wider">
                                    {detectSpeechLanguage(translation, 'pt') === 'pt' ? 'Tradução 🇧🇷' : 'Versão em inglês 🇺🇸'}
                                </span>
                            </div>
                            <div className="flex items-center gap-1">
                                {/* Botão: ouvir tradução em voz PT-BR */}
                                <button
                                    onClick={() => {
                                        const translationLanguage = detectSpeechLanguage(translation, 'pt');
                                        void speak(translation, 1.0, translationLanguage);
                                    }}
                                    title={detectSpeechLanguage(translation, 'pt') === 'pt' ? 'Ouvir em português BR' : 'Ouvir em inglês americano'}
                                    className="p-1 rounded-lg text-sky-400/60 hover:text-sky-300 hover:bg-sky-400/10 transition-colors"
                                >
                                    <Volume2 size={12} />
                                </button>
                                <button onClick={() => setTranslation(null)} className="text-sky-400/50 hover:text-sky-300 p-1"><X size={12} /></button>
                            </div>
                        </div>
                        <p className="text-sm text-sky-100 font-medium leading-relaxed">{translation}</p>
                    </div>
                </div>
            )}

            {/* VOCABULARY CARD (Top Right) */}
            {vocabulary && vocabulary.keyTerms && vocabulary.keyTerms.length > 0 && (
                <div className="absolute top-[130px] right-4 md:right-8 z-40 max-w-[260px] md:max-w-sm animate-in fade-in slide-in-from-right-8 duration-500">
                    <div className="bg-indigo-950/40 backdrop-blur-xl border border-indigo-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-indigo-950/60 transition-colors">
                        <button onClick={() => setVocabulary(null)} className="absolute top-2 right-2 text-indigo-400/50 hover:text-indigo-300"><X size={12} /></button>
                        <div className="flex items-center gap-2 mb-2 text-indigo-400">
                            <BookOpen size={12} />
                            <span className="text-[9px] uppercase font-bold tracking-wider">Vocabulário</span>
                        </div>
                        <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                            {vocabulary.keyTerms.map((term, idx) => (
                                <div key={idx} className="bg-white/5 p-2.5 rounded-xl border border-white/10">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-bold text-indigo-300 text-sm">{term.term}</span>
                                        <span className="text-[9px] font-bold bg-indigo-500/20 px-1.5 py-0.5 rounded text-indigo-200">{term.level}</span>
                                    </div>
                                    <p className="text-[11px] text-slate-300 leading-relaxed">{term.definition}</p>
                                    <p className="text-[10px] text-slate-400 italic mt-1">"{term.example}"</p>
                                </div>
                            ))}
                        </div>
                        {vocabulary.grammarNote && (
                            <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-indigo-300 font-medium leading-relaxed">
                                💡 {vocabulary.grammarNote}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* QUIZ CARD (Bottom Right) */}
            {quiz && (
                <div className="absolute bottom-6 right-4 md:right-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-bottom-8 duration-500">
                    <InlineQuiz quiz={quiz} />
                </div>
            )}

            {/* TRANSCRIPT TOGGLE (Bottom center, above text input) */}
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40">
                <button
                    onClick={() => setShowTranscript(p => !p)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all text-[10px] font-bold uppercase tracking-wider"
                >
                    {showTranscript ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                    Histórico ({messages.length})
                </button>
            </div>

            {/* TRANSCRIPT PANEL (Slide up) */}
            {showTranscript && (
                <div className="absolute bottom-28 left-4 right-4 max-h-[40vh] z-40 animate-in slide-in-from-bottom-6 fade-in duration-300">
                    <div className="bg-slate-950/90 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 overflow-y-auto max-h-[40vh] space-y-3">
                        {messages.length === 0 ? (
                            <p className="text-xs text-slate-400 text-center py-4">Nenhuma mensagem ainda</p>
                        ) : (
                            messages.map((msg) => (
                                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] p-3 rounded-xl text-sm ${msg.role === 'user'
                                        ? 'bg-indigo-600/30 text-indigo-100 rounded-tr-sm'
                                        : 'bg-slate-800/70 text-slate-200 rounded-tl-sm border-l-2 border-cyan-500'}`}>
                                        <p className="leading-relaxed">{msg.content}</p>
                                        {msg.correction && (
                                            <div className="mt-2 pt-2 border-t border-white/10 text-xs">
                                                <span className="text-red-400 line-through">{msg.correction.original}</span>
                                                <span className="text-emerald-400 ml-2">{msg.correction.corrected}</span>
                                            </div>
                                        )}
                                        {msg.translation && (
                                            <p className="mt-1 text-xs text-sky-300/60 italic">{msg.translation}</p>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                </div>
            )}

        </div>
    );
};

export default WolfieTutor;
