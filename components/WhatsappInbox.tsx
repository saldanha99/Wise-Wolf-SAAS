import React, {
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    AlertCircle,
    ArrowLeft,
    Bot,
    Check,
    CheckCheck,
    Clock3,
    Loader2,
    MessageCircle,
    RefreshCw,
    Search,
    Send,
    ShieldCheck,
    Smartphone,
    UserRound,
    Users,
    Wifi,
    WifiOff,
} from 'lucide-react';
import type { User } from '../types';
import {
    createClientRequestId,
    whatsappInboxService,
    type WhatsappConversation,
    type WhatsappInboxService,
    type WhatsappInstance,
    type WhatsappMessage,
} from '../services/whatsappInboxService';

interface WhatsappInboxProps {
    user: User;
    tenantId?: string;
    onUnreadChange?: (count: number) => void;
    onOpenConnection?: () => void;
    service?: WhatsappInboxService;
}

type ConversationFilter = 'all' | 'unread';

const HANDOFF_DURATION_MS = 72 * 60 * 60 * 1000;

function normalizeSearch(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR');
}

function dateValue(value: string | null | undefined): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatConversationTime(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function formatMessageTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function conversationName(conversation: WhatsappConversation): string {
    return conversation.display_name?.trim() || conversation.phone?.trim() || 'Contato sem nome';
}

function contactKindLabel(kind: string | null): string {
    const labels: Record<string, string> = {
        student: 'Aluno',
        lead: 'Lead',
        candidate: 'Candidato',
        teacher: 'Professor',
        group: 'Grupo',
        unknown: 'Contato',
    };
    return labels[String(kind || '').toLowerCase()] || 'Contato';
}

function messageText(message: WhatsappMessage): string {
    if (message.body?.trim()) return message.body;
    const labels: Record<string, string> = {
        audio: '🎤 Mensagem de áudio',
        image: '🖼️ Imagem',
        video: '🎬 Vídeo',
        document: '📎 Documento',
        sticker: '🏷️ Figurinha',
    };
    return labels[message.message_type] || 'Mensagem sem texto';
}

function handoffIsActive(conversation: WhatsappConversation | null): boolean {
    return Boolean(conversation?.human_handoff_until)
        && dateValue(conversation?.human_handoff_until) > Date.now();
}

function mergeMessages(remote: WhatsappMessage[], current: WhatsappMessage[]): WhatsappMessage[] {
    const remoteRequestIds = new Set(
        remote.map((message) => message.client_request_id).filter(Boolean),
    );
    const localOnly = current.filter((message) =>
        message.id.startsWith('local:')
        && (!message.client_request_id || !remoteRequestIds.has(message.client_request_id))
    );
    return [...remote, ...localOnly].sort(
        (left, right) => dateValue(left.occurred_at) - dateValue(right.occurred_at),
    );
}

function readableError(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : 'Não foi possível concluir esta operação. Tente novamente.';
}

function MessageStatus({ message }: { message: WhatsappMessage }) {
    if (message.direction !== 'out') return null;
    const status = message.status.toLowerCase();
    if (status === 'failed' || status === 'error') {
        return <AlertCircle size={12} aria-label="Falha no envio" className="text-red-300" />;
    }
    if (status === 'sending' || status === 'pending' || status === 'queued' || status === 'dispatching') {
        return <Clock3 size={12} aria-label="Enviando" className="text-white/70" />;
    }
    if (status === 'uncertain') {
        return <AlertCircle size={12} aria-label="Entrega não confirmada" className="text-amber-200" />;
    }
    if (status === 'read') {
        return <CheckCheck size={13} aria-label="Lida" className="text-sky-200" />;
    }
    if (status === 'delivered') {
        return <CheckCheck size={13} aria-label="Entregue" className="text-white/80" />;
    }
    return <Check size={13} aria-label="Enviada" className="text-white/80" />;
}

function MessageBubble({
    message,
    onRetry,
}: {
    message: WhatsappMessage;
    onRetry?: (message: WhatsappMessage) => void;
}) {
    const outgoing = message.direction === 'out';
    const senderLabel = outgoing
        ? message.sender_kind === 'ai' ? 'IA' : 'Equipe'
        : 'Contato';

    return (
        <div className={`flex w-full ${outgoing ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[86%] sm:max-w-[75%] ${outgoing ? 'items-end' : 'items-start'} flex flex-col`}>
                <div
                    className={`rounded-2xl px-3.5 py-2.5 shadow-sm ${outgoing
                        ? 'rounded-br-md bg-emerald-600 text-white'
                        : 'rounded-bl-md border border-brand-border bg-brand-surface text-brand-text'
                    } ${message.status === 'failed' || message.status === 'error' ? 'ring-2 ring-red-400/50' : ''}`}
                >
                    <p className={`mb-1 text-[9px] font-black uppercase tracking-wider ${outgoing ? 'text-white/70' : 'text-brand-muted'}`}>
                        {senderLabel}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{messageText(message)}</p>
                    <span className={`mt-1.5 flex items-center justify-end gap-1 text-[9px] ${outgoing ? 'text-white/70' : 'text-brand-muted'}`}>
                        {formatMessageTime(message.occurred_at)}
                        <MessageStatus message={message} />
                    </span>
                </div>
                {(message.status === 'failed' || message.status === 'error') && (
                    <span className="mt-1 px-1 text-[10px] font-bold text-red-500">Não foi possível enviar.</span>
                )}
                {message.status === 'uncertain' && message.client_request_id && onRetry && (
                    <button
                        type="button"
                        onClick={() => onRetry(message)}
                        className="mt-1 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-[10px] font-black text-amber-600 hover:bg-amber-500/10"
                    >
                        <RefreshCw size={11} aria-hidden="true" /> Tentar novamente com segurança
                    </button>
                )}
            </div>
        </div>
    );
}

interface ConversationRowProps {
    conversation: WhatsappConversation;
    selected: boolean;
    onSelect: (conversationId: string) => void;
}

function ConversationRow({ conversation, selected, onSelect }: ConversationRowProps) {
    const isGroup = conversation.contact_kind === 'group' || conversation.remote_jid.endsWith('@g.us');
    return (
        <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-current={selected ? 'true' : undefined}
            className={`flex w-full items-start gap-3 border-b border-brand-border px-3 py-3 text-left transition-colors ${selected
                ? 'bg-tenant-primary/10'
                : 'hover:bg-brand-surface-2'
            }`}
        >
            <div className={`grid size-11 shrink-0 place-content-center rounded-full ${isGroup
                ? 'bg-violet-500/15 text-violet-500'
                : 'bg-emerald-500/15 text-emerald-600'
            }`}>
                {isGroup ? <Users size={19} aria-hidden="true" /> : <UserRound size={19} aria-hidden="true" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-black text-brand-text">{conversationName(conversation)}</p>
                    <time className="shrink-0 text-[10px] font-bold text-brand-muted">
                        {formatConversationTime(conversation.last_message_at)}
                    </time>
                </div>
                <div className="mt-1 flex items-center gap-2">
                    <p className={`min-w-0 flex-1 truncate text-xs ${conversation.unread_count > 0 ? 'font-bold text-brand-text' : 'text-brand-muted'}`}>
                        {conversation.last_message_preview || 'Conversa sincronizada'}
                    </p>
                    {conversation.unread_count > 0 && (
                        <span
                            aria-label={`${conversation.unread_count} mensagens não lidas`}
                            className="grid min-w-5 shrink-0 place-content-center rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-black text-white"
                        >
                            {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
                        </span>
                    )}
                </div>
                <p className="mt-1 text-[9px] font-black uppercase tracking-wider text-brand-muted">
                    {contactKindLabel(conversation.contact_kind)}
                </p>
            </div>
        </button>
    );
}

const WhatsappInbox: React.FC<WhatsappInboxProps> = ({
    user,
    tenantId,
    onUnreadChange,
    onOpenConnection,
    service = whatsappInboxService,
}) => {
    const [instances, setInstances] = useState<WhatsappInstance[]>([]);
    const [selectedInstanceName, setSelectedInstanceName] = useState('');
    const [instancesLoading, setInstancesLoading] = useState(true);
    const [conversations, setConversations] = useState<WhatsappConversation[]>([]);
    const [conversationsLoading, setConversationsLoading] = useState(false);
    const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<WhatsappMessage[]>([]);
    const [messagesLoading, setMessagesLoading] = useState(false);
    const [filter, setFilter] = useState<ConversationFilter>('all');
    const [search, setSearch] = useState('');
    const deferredSearch = useDeferredValue(search);
    const [composerText, setComposerText] = useState('');
    const [sending, setSending] = useState(false);
    const [retryingRequestId, setRetryingRequestId] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [changingHandoff, setChangingHandoff] = useState(false);
    const [enabling, setEnabling] = useState(false);
    const [institutionConfirmed, setInstitutionConfirmed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [messagesError, setMessagesError] = useState<string | null>(null);
    const [realtimeUnavailable, setRealtimeUnavailable] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const instanceRequestRef = useRef(0);
    const conversationRequestRef = useRef(0);
    const messageRequestRef = useRef(0);
    const selectedConversationRef = useRef<string | null>(null);
    const syncedConversationKeysRef = useRef(new Set<string>());

    const selectedInstance = useMemo(
        () => instances.find((instance) => instance.instance_name === selectedInstanceName) || null,
        [instances, selectedInstanceName],
    );
    const selectedConversation = useMemo(
        () => conversations.find((conversation) => conversation.id === selectedConversationId) || null,
        [conversations, selectedConversationId],
    );
    const humanHandoffActive = handoffIsActive(selectedConversation);

    useEffect(() => {
        selectedConversationRef.current = selectedConversationId;
    }, [selectedConversationId]);

    const publishUnreadCount = useCallback((rows: WhatsappConversation[]) => {
        onUnreadChange?.(rows.reduce((total, conversation) => total + Math.max(0, conversation.unread_count || 0), 0));
    }, [onUnreadChange]);

    const loadInstances = useCallback(async (targetTenantId: string) => {
        const request = ++instanceRequestRef.current;
        setInstancesLoading(true);
        setError(null);
        try {
            const rows = await service.listInstances(targetTenantId);
            if (request !== instanceRequestRef.current) return;
            setInstances(rows);
            setSelectedInstanceName((current) => {
                if (rows.some((instance) => instance.instance_name === current)) return current;
                return rows.find((instance) => instance.inbox_enabled)?.instance_name
                    || rows[0]?.instance_name
                    || '';
            });
        } catch (loadError) {
            if (request === instanceRequestRef.current) {
                setError(readableError(loadError));
                setInstances([]);
                setSelectedInstanceName('');
            }
        } finally {
            if (request === instanceRequestRef.current) setInstancesLoading(false);
        }
    }, [service]);

    useEffect(() => {
        instanceRequestRef.current += 1;
        setInstances([]);
        setSelectedInstanceName('');
        setConversations([]);
        setSelectedConversationId(null);
        setMessages([]);
        setInstitutionConfirmed(false);
        setRealtimeUnavailable(false);
        onUnreadChange?.(0);
        if (!tenantId) {
            setInstancesLoading(false);
            return;
        }
        void loadInstances(tenantId);
        return () => {
            instanceRequestRef.current += 1;
        };
    }, [loadInstances, onUnreadChange, tenantId]);

    const loadConversations = useCallback(async (showLoader = false) => {
        if (!tenantId || !selectedInstanceName || !selectedInstance?.inbox_enabled) return;
        const request = ++conversationRequestRef.current;
        if (showLoader) setConversationsLoading(true);
        try {
            const rows = await service.listConversations(tenantId, selectedInstanceName);
            if (request !== conversationRequestRef.current) return;
            setConversations(rows);
            publishUnreadCount(rows);
            setSelectedConversationId((current) =>
                current && rows.some((conversation) => conversation.id === current) ? current : null
            );
            setError(null);
        } catch (loadError) {
            if (request === conversationRequestRef.current) setError(readableError(loadError));
        } finally {
            if (request === conversationRequestRef.current) setConversationsLoading(false);
        }
    }, [publishUnreadCount, selectedInstance?.inbox_enabled, selectedInstanceName, service, tenantId]);

    const loadMessages = useCallback(async (conversationId: string, showLoader = false) => {
        if (!tenantId || !conversationId) return;
        const request = ++messageRequestRef.current;
        if (showLoader) setMessagesLoading(true);
        try {
            const rows = await service.listMessages(tenantId, conversationId);
            if (request !== messageRequestRef.current || selectedConversationRef.current !== conversationId) return;
            setMessages((current) => mergeMessages(rows, current));
            setMessagesError(null);
        } catch (loadError) {
            if (request === messageRequestRef.current) setMessagesError(readableError(loadError));
        } finally {
            if (request === messageRequestRef.current) setMessagesLoading(false);
        }
    }, [service, tenantId]);

    useEffect(() => {
        conversationRequestRef.current += 1;
        messageRequestRef.current += 1;
        setConversations([]);
        setSelectedConversationId(null);
        setMessages([]);
        setInstitutionConfirmed(false);
        setError(null);
        setRealtimeUnavailable(false);
        publishUnreadCount([]);
        if (selectedInstance?.inbox_enabled) void loadConversations(true);
    }, [loadConversations, publishUnreadCount, selectedInstance?.inbox_enabled, selectedInstanceName]);

    useEffect(() => {
        messageRequestRef.current += 1;
        setMessages([]);
        setMessagesError(null);
        setMessagesLoading(false);
        if (!tenantId || !selectedInstanceName || !selectedConversationId || !selectedInstance?.inbox_enabled) return;

        let active = true;
        const conversationId = selectedConversationId;
        const syncKey = `${tenantId}:${selectedInstanceName}:${conversationId}`;
        setMessagesLoading(true);

        const loadConversationHistory = async () => {
            let syncError: string | null = null;
            if (!syncedConversationKeysRef.current.has(syncKey)) {
                syncedConversationKeysRef.current.add(syncKey);
                try {
                    await service.syncInbox(tenantId, selectedInstanceName, conversationId);
                } catch (loadError) {
                    syncedConversationKeysRef.current.delete(syncKey);
                    syncError = readableError(loadError);
                }
            }
            if (!active || selectedConversationRef.current !== conversationId) return;
            await loadMessages(conversationId, false);
            if (active && selectedConversationRef.current === conversationId && syncError) {
                setMessagesError(syncError);
            }
        };

        void loadConversationHistory();
        return () => {
            active = false;
        };
    }, [
        loadMessages,
        selectedConversationId,
        selectedInstance?.inbox_enabled,
        selectedInstanceName,
        service,
        tenantId,
    ]);

    useEffect(() => {
        setRealtimeUnavailable(false);
        if (!tenantId || !selectedInstanceName || !selectedInstance?.inbox_enabled) return;
        let active = true;
        let refreshTimer: number | undefined;
        const scheduleRefresh = (includeMessages: boolean) => {
            window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                void loadConversations(false);
                const conversationId = selectedConversationRef.current;
                if (includeMessages && conversationId) void loadMessages(conversationId, false);
            }, 250);
        };
        const unsubscribe = service.subscribe(tenantId, {
            onConversationChange: () => scheduleRefresh(false),
            onMessageChange: () => scheduleRefresh(true),
            onError: () => {
                if (active) setRealtimeUnavailable(true);
            },
        });
        return () => {
            active = false;
            window.clearTimeout(refreshTimer);
            unsubscribe();
        };
    }, [loadConversations, loadMessages, selectedInstance?.inbox_enabled, selectedInstanceName, service, tenantId]);

    useEffect(() => {
        if (!selectedInstance?.inbox_enabled) return;
        const refreshVisibleInbox = () => {
            if (document.visibilityState === 'hidden') return;
            void loadConversations(false);
            const conversationId = selectedConversationRef.current;
            if (conversationId) void loadMessages(conversationId, false);
        };
        const interval = window.setInterval(refreshVisibleInbox, 20_000);
        window.addEventListener('focus', refreshVisibleInbox);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('focus', refreshVisibleInbox);
        };
    }, [loadConversations, loadMessages, selectedInstance?.inbox_enabled]);

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView?.({ block: 'end' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [messages]);

    const filteredConversations = useMemo(() => {
        const query = normalizeSearch(deferredSearch.trim());
        return conversations.filter((conversation) => {
            if (filter === 'unread' && conversation.unread_count <= 0) return false;
            if (!query) return true;
            return normalizeSearch([
                conversation.display_name,
                conversation.phone,
                conversation.last_message_preview,
                contactKindLabel(conversation.contact_kind),
            ].filter(Boolean).join(' ')).includes(query);
        });
    }, [conversations, deferredSearch, filter]);

    const handleSelectConversation = useCallback((conversationId: string) => {
        setSelectedConversationId(conversationId);
        const conversation = conversations.find((row) => row.id === conversationId);
        if (!tenantId || !selectedInstanceName || (conversation?.unread_count || 0) <= 0) return;

        setConversations((current) => {
            const next = current.map((row) => row.id === conversationId
                ? { ...row, unread_count: 0 }
                : row
            );
            publishUnreadCount(next);
            return next;
        });
        void service.markRead(tenantId, selectedInstanceName, conversationId).catch(() => {
            void loadConversations(false);
        });
    }, [conversations, loadConversations, publishUnreadCount, selectedInstanceName, service, tenantId]);

    const handleEnableInbox = async () => {
        if (!tenantId || !selectedInstance || !institutionConfirmed) return;
        const confirmed = window.confirm(
            'Confirmo que este número é institucional. As conversas sincronizadas ficarão visíveis aos gestores autorizados desta escola.',
        );
        if (!confirmed) return;
        setEnabling(true);
        setError(null);
        try {
            await service.enableInbox(tenantId, selectedInstance.instance_name);
            setInstances((current) => current.map((instance) =>
                instance.id === selectedInstance.id ? { ...instance, inbox_enabled: true } : instance
            ));
            setInstitutionConfirmed(false);
        } catch (enableError) {
            setError(readableError(enableError));
        } finally {
            setEnabling(false);
        }
    };

    const handleSync = async () => {
        if (!tenantId || !selectedInstanceName || !selectedInstance?.inbox_enabled) return;
        const conversationId = selectedConversationId;
        setSyncing(true);
        setError(null);
        try {
            await service.syncInbox(tenantId, selectedInstanceName);
            if (conversationId) {
                await service.syncInbox(tenantId, selectedInstanceName, conversationId);
                syncedConversationKeysRef.current.add(`${tenantId}:${selectedInstanceName}:${conversationId}`);
            }
            await Promise.all([
                loadConversations(false),
                conversationId ? loadMessages(conversationId, false) : Promise.resolve(),
            ]);
        } catch (syncError) {
            setError(readableError(syncError));
        } finally {
            setSyncing(false);
        }
    };

    const handleHandoff = async (active: boolean) => {
        if (!tenantId || !selectedInstanceName || !selectedConversation) return;
        if (!active && !window.confirm('Devolver esta conversa para a IA responder novamente?')) return;
        setChangingHandoff(true);
        setMessagesError(null);
        try {
            await service.setHandoff(tenantId, selectedInstanceName, selectedConversation.id, active);
            const handoffUntil = active
                ? new Date(Date.now() + HANDOFF_DURATION_MS).toISOString()
                : null;
            setConversations((current) => current.map((conversation) =>
                conversation.id === selectedConversation.id
                    ? { ...conversation, human_handoff_until: handoffUntil, assigned_to: active ? user.id : null }
                    : conversation
            ));
        } catch (handoffError) {
            setMessagesError(readableError(handoffError));
        } finally {
            setChangingHandoff(false);
        }
    };

    const handleSend = async (event: React.FormEvent) => {
        event.preventDefault();
        const text = composerText.trim();
        if (!tenantId || !selectedInstanceName || !selectedConversation || !text || sending || !humanHandoffActive) return;

        const requestId = createClientRequestId();
        const now = new Date().toISOString();
        const optimisticMessage: WhatsappMessage = {
            id: `local:${requestId}`,
            tenant_id: tenantId,
            conversation_id: selectedConversation.id,
            provider_message_id: null,
            client_request_id: requestId,
            direction: 'out',
            sender_kind: 'human',
            message_type: 'text',
            body: text,
            status: 'sending',
            occurred_at: now,
            sent_by_user_id: user.id,
            error_code: null,
            updated_at: now,
        };
        setMessages((current) => [...current, optimisticMessage]);
        setComposerText('');
        setSending(true);
        setMessagesError(null);
        try {
            const result = await service.sendText({
                tenantId,
                instanceName: selectedInstanceName,
                conversationId: selectedConversation.id,
                text,
                clientRequestId: requestId,
            });
            setMessages((current) => current.map((message) =>
                message.id === optimisticMessage.id ? { ...message, status: result.status } : message
            ));
            setConversations((current) => current.map((conversation) =>
                conversation.id === selectedConversation.id
                    ? { ...conversation, last_message_preview: text, last_message_at: now, updated_at: now }
                    : conversation
            ));
        } catch (sendError) {
            setMessages((current) => current.map((message) =>
                message.id === optimisticMessage.id
                    ? { ...message, status: 'uncertain', error_code: 'transport_uncertain' }
                    : message
            ));
            setMessagesError(readableError(sendError));
        } finally {
            setSending(false);
        }
    };

    const handleSafeRetry = async (message: WhatsappMessage) => {
        const requestId = message.client_request_id;
        const text = message.body?.trim() || '';
        if (
            !tenantId || !selectedInstanceName || !selectedConversation ||
            message.conversation_id !== selectedConversation.id || !requestId || !text ||
            retryingRequestId || !humanHandoffActive
        ) return;

        setRetryingRequestId(requestId);
        setMessagesError(null);
        setMessages((current) => current.map((currentMessage) =>
            currentMessage.id === message.id
                ? { ...currentMessage, status: 'sending', error_code: null }
                : currentMessage
        ));
        try {
            const result = await service.sendText({
                tenantId,
                instanceName: selectedInstanceName,
                conversationId: selectedConversation.id,
                text,
                // Reutilizar o mesmo UUID é a trava que permite retentar uma
                // falha browser→Edge sem despachar duas mensagens no provedor.
                clientRequestId: requestId,
            });
            setMessages((current) => current.map((currentMessage) =>
                currentMessage.id === message.id
                    ? { ...currentMessage, status: result.status }
                    : currentMessage
            ));
            await loadMessages(selectedConversation.id, false);
        } catch (retryError) {
            setMessages((current) => current.map((currentMessage) =>
                currentMessage.id === message.id
                    ? { ...currentMessage, status: 'uncertain', error_code: 'transport_uncertain' }
                    : currentMessage
            ));
            setMessagesError(readableError(retryError));
        } finally {
            setRetryingRequestId(null);
        }
    };

    if (!tenantId) {
        return (
            <div className="grid min-h-[28rem] place-content-center rounded-[2rem] border border-brand-border bg-brand-surface p-8 text-center">
                <AlertCircle className="mx-auto mb-3 text-amber-500" size={34} />
                <h2 className="text-lg font-black text-brand-text">Escola não identificada</h2>
                <p className="mt-2 max-w-md text-sm text-brand-muted">Atualize a página ou selecione novamente a instituição.</p>
            </div>
        );
    }

    if (instancesLoading) {
        return (
            <div className="grid min-h-[28rem] place-content-center gap-3 rounded-[2rem] border border-brand-border bg-brand-surface text-center text-brand-muted">
                <Loader2 className="mx-auto animate-spin" size={34} />
                <p className="text-sm font-bold">Carregando caixa de entrada...</p>
            </div>
        );
    }

    if (instances.length === 0) {
        return (
            <div className="grid min-h-[28rem] place-content-center rounded-[2rem] border border-brand-border bg-brand-surface p-8 text-center">
                <Smartphone className="mx-auto mb-4 text-brand-muted" size={42} />
                <h2 className="text-xl font-black text-brand-text">Conecte o WhatsApp da escola</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-brand-muted">
                    A caixa de entrada só pode ser ativada depois que uma conexão institucional estiver configurada.
                </p>
                {error && <p role="alert" className="mt-3 text-sm font-bold text-red-500">{error}</p>}
                {error && (
                    <button
                        type="button"
                        onClick={() => void loadInstances(tenantId)}
                        className="mx-auto mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border border-brand-border px-4 text-xs font-black text-brand-text"
                    >
                        <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                    </button>
                )}
                {onOpenConnection && (
                    <button
                        type="button"
                        onClick={onOpenConnection}
                        className="mx-auto mt-5 rounded-xl bg-tenant-primary px-5 py-3 text-sm font-black text-white"
                    >
                        Abrir conexão
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <header className="flex flex-col gap-3 rounded-[1.75rem] border border-brand-border bg-brand-surface p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="grid size-11 shrink-0 place-content-center rounded-2xl bg-emerald-500/15 text-emerald-600">
                        <MessageCircle size={22} aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="truncate text-xl font-black text-brand-text">WhatsApp da escola</h2>
                        <p className="text-xs text-brand-muted">Converse com alunos, leads e equipe sem sair do sistema.</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="whatsapp-instance">Número conectado</label>
                    <select
                        id="whatsapp-instance"
                        value={selectedInstanceName}
                        onChange={(event) => setSelectedInstanceName(event.target.value)}
                        className="min-h-10 max-w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 text-xs font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/40"
                    >
                        {instances.map((instance) => (
                            <option key={instance.id} value={instance.instance_name}>{instance.instance_name}</option>
                        ))}
                    </select>
                    <span className={`inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[10px] font-black uppercase tracking-wider ${selectedInstance?.status === 'open' || selectedInstance?.status === 'connected'
                        ? 'bg-emerald-500/15 text-emerald-600'
                        : 'bg-amber-500/15 text-amber-600'
                    }`}>
                        {selectedInstance?.status === 'open' || selectedInstance?.status === 'connected'
                            ? <Wifi size={14} aria-hidden="true" />
                            : <WifiOff size={14} aria-hidden="true" />}
                        {selectedInstance?.status === 'open' || selectedInstance?.status === 'connected' ? 'Conectado' : 'Desconectado'}
                    </span>
                    {selectedInstance?.inbox_enabled && (
                        <button
                            type="button"
                            onClick={handleSync}
                            disabled={syncing}
                            className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-tenant-primary px-4 text-xs font-black text-white disabled:opacity-50"
                        >
                            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
                            {syncing ? 'Sincronizando' : 'Sincronizar'}
                        </button>
                    )}
                </div>
            </header>

            {selectedInstance?.inbox_enabled && error && (
                <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-600">
                    <span className="min-w-0">{error}</span>
                    <button type="button" onClick={() => setError(null)} className="shrink-0 rounded-lg px-2 py-1 text-xs font-black hover:bg-red-500/10">
                        Fechar
                    </button>
                </div>
            )}

            {!selectedInstance?.inbox_enabled ? (
                <section className="grid min-h-[30rem] place-content-center rounded-[2rem] border border-brand-border bg-brand-surface p-6 text-center shadow-sm">
                    <div className="mx-auto grid size-16 place-content-center rounded-3xl bg-amber-500/15 text-amber-600">
                        <ShieldCheck size={32} aria-hidden="true" />
                    </div>
                    <h2 className="mt-5 text-2xl font-black text-brand-text">Ativação institucional necessária</h2>
                    <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-brand-muted">
                        Esta caixa ainda está desativada. Ative somente se o número <strong className="text-brand-text">{selectedInstance?.instance_name}</strong> for institucional. Depois da sincronização, as conversas ficarão visíveis aos gestores autorizados desta escola.
                    </p>
                    <label className="mx-auto mt-6 flex max-w-xl cursor-pointer items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-left">
                        <input
                            type="checkbox"
                            checked={institutionConfirmed}
                            onChange={(event) => setInstitutionConfirmed(event.target.checked)}
                            className="mt-0.5 size-5 accent-amber-600"
                        />
                        <span className="text-sm font-bold leading-6 text-brand-text">
                            Confirmo que este número pertence à escola e autorizo que suas conversas sejam exibidas aos gestores autorizados.
                        </span>
                    </label>
                    {error && <p role="alert" className="mt-4 text-sm font-bold text-red-500">{error}</p>}
                    <button
                        type="button"
                        onClick={handleEnableInbox}
                        disabled={!institutionConfirmed || enabling}
                        className="mx-auto mt-5 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-amber-600 px-6 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {enabling ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
                        {enabling ? 'Ativando...' : 'Ativar caixa de entrada'}
                    </button>
                    <p className="mt-3 text-xs text-brand-muted">A ativação não inicia a sincronização automaticamente.</p>
                </section>
            ) : (
                <section className="grid h-[calc(100dvh-15.5rem)] min-h-[34rem] grid-cols-1 overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-sm md:grid-cols-[22rem_minmax(0,1fr)]">
                    <aside className={`${selectedConversation ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-brand-border`} aria-label="Conversas do WhatsApp">
                        <div className="shrink-0 space-y-3 border-b border-brand-border p-3">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={16} aria-hidden="true" />
                                <label htmlFor="whatsapp-search" className="sr-only">Buscar conversas</label>
                                <input
                                    id="whatsapp-search"
                                    type="search"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Buscar nome, número ou mensagem"
                                    className="min-h-11 w-full rounded-xl border border-brand-border bg-brand-surface-2 pl-10 pr-3 text-sm text-brand-text outline-none placeholder:text-brand-muted focus:ring-2 focus:ring-tenant-primary/30"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-1 rounded-xl bg-brand-surface-2 p-1" role="group" aria-label="Filtrar conversas">
                                <button
                                    type="button"
                                    onClick={() => setFilter('all')}
                                    aria-pressed={filter === 'all'}
                                    className={`rounded-lg px-3 py-2 text-xs font-black ${filter === 'all' ? 'bg-brand-surface text-brand-text shadow-sm' : 'text-brand-muted'}`}
                                >
                                    Todas
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setFilter('unread')}
                                    aria-pressed={filter === 'unread'}
                                    className={`rounded-lg px-3 py-2 text-xs font-black ${filter === 'unread' ? 'bg-brand-surface text-brand-text shadow-sm' : 'text-brand-muted'}`}
                                >
                                    Não lidas
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                            {conversationsLoading ? (
                                <div className="grid h-full place-content-center gap-2 text-center text-brand-muted">
                                    <Loader2 className="mx-auto animate-spin" size={26} />
                                    <span className="text-xs font-bold">Carregando conversas...</span>
                                </div>
                            ) : error && conversations.length === 0 ? (
                                <div className="p-6 text-center">
                                    <AlertCircle className="mx-auto text-red-500" size={28} />
                                    <p role="alert" className="mt-3 text-sm font-bold text-red-500">{error}</p>
                                    <button type="button" onClick={() => void loadConversations(true)} className="mt-4 text-xs font-black text-tenant-primary">Tentar novamente</button>
                                </div>
                            ) : filteredConversations.length === 0 ? (
                                <div className="grid h-full min-h-64 place-content-center p-6 text-center">
                                    <MessageCircle className="mx-auto text-brand-muted" size={30} />
                                    <p className="mt-3 text-sm font-black text-brand-text">
                                        {conversations.length === 0 ? 'Nenhuma conversa sincronizada' : 'Nenhuma conversa encontrada'}
                                    </p>
                                    <p className="mt-1 text-xs text-brand-muted">
                                        {conversations.length === 0 ? 'Use “Sincronizar” para buscar o histórico institucional.' : 'Ajuste a busca ou o filtro.'}
                                    </p>
                                </div>
                            ) : (
                                filteredConversations.map((conversation) => (
                                    <React.Fragment key={conversation.id}>
                                        <ConversationRow
                                            conversation={conversation}
                                            selected={conversation.id === selectedConversationId}
                                            onSelect={handleSelectConversation}
                                        />
                                    </React.Fragment>
                                ))
                            )}
                        </div>
                    </aside>

                    <main className={`${selectedConversation ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col`}>
                        {!selectedConversation ? (
                            <div className="grid h-full place-content-center p-8 text-center">
                                <div className="mx-auto grid size-16 place-content-center rounded-3xl bg-emerald-500/15 text-emerald-600">
                                    <MessageCircle size={31} aria-hidden="true" />
                                </div>
                                <h3 className="mt-4 text-lg font-black text-brand-text">Selecione uma conversa</h3>
                                <p className="mt-2 max-w-sm text-sm text-brand-muted">O histórico aparecerá aqui e permanecerá isolado na escola ativa.</p>
                            </div>
                        ) : (
                            <>
                                <header className="flex min-h-[4.5rem] shrink-0 items-center gap-3 border-b border-brand-border px-3 py-2 sm:px-4">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedConversationId(null)}
                                        className="grid size-10 shrink-0 place-content-center rounded-xl text-brand-muted hover:bg-brand-surface-2 md:hidden"
                                        aria-label="Voltar para conversas"
                                    >
                                        <ArrowLeft size={20} aria-hidden="true" />
                                    </button>
                                    <div className="grid size-10 shrink-0 place-content-center rounded-full bg-emerald-500/15 text-emerald-600">
                                        {selectedConversation.contact_kind === 'group'
                                            ? <Users size={18} aria-hidden="true" />
                                            : <UserRound size={18} aria-hidden="true" />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="truncate text-sm font-black text-brand-text">{conversationName(selectedConversation)}</h3>
                                        <p className="truncate text-[10px] font-bold text-brand-muted">
                                            {[contactKindLabel(selectedConversation.contact_kind), selectedConversation.phone].filter(Boolean).join(' · ')}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void handleHandoff(!humanHandoffActive)}
                                        disabled={changingHandoff}
                                        className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-[10px] font-black uppercase tracking-wider disabled:opacity-50 ${humanHandoffActive
                                            ? 'bg-violet-500/15 text-violet-600'
                                            : 'bg-tenant-primary text-white'
                                        }`}
                                    >
                                        {changingHandoff
                                            ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                                            : humanHandoffActive ? <Bot size={14} aria-hidden="true" /> : <UserRound size={14} aria-hidden="true" />}
                                        <span className="hidden sm:inline">{humanHandoffActive ? 'Devolver para IA' : 'Assumir atendimento'}</span>
                                        <span className="sm:hidden">{humanHandoffActive ? 'IA' : 'Assumir'}</span>
                                    </button>
                                </header>

                                {realtimeUnavailable && (
                                    <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-[10px] font-bold text-amber-700">
                                        Atualização instantânea indisponível; a tela continuará atualizando periodicamente.
                                    </div>
                                )}

                                <div
                                    className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain bg-brand-surface-2/60 p-3 sm:p-5"
                                    role="log"
                                    aria-live="polite"
                                    aria-label={`Mensagens com ${conversationName(selectedConversation)}`}
                                >
                                    {messagesLoading ? (
                                        <div className="grid h-full place-content-center gap-2 text-center text-brand-muted">
                                            <Loader2 className="mx-auto animate-spin" size={26} />
                                            <span className="text-xs font-bold">Carregando mensagens...</span>
                                        </div>
                                    ) : messages.length === 0 ? (
                                        <div className="grid h-full place-content-center text-center">
                                            <p className="text-sm font-black text-brand-text">Ainda não há mensagens nesta conversa.</p>
                                            <p className="mt-1 text-xs text-brand-muted">Sincronize novamente se o histórico estiver incompleto.</p>
                                        </div>
                                    ) : (
                                        messages.map((message) => (
                                            <React.Fragment key={message.id}>
                                                <MessageBubble
                                                    message={message}
                                                    onRetry={message.status === 'uncertain' && !retryingRequestId
                                                        ? (retryMessage) => void handleSafeRetry(retryMessage)
                                                        : undefined}
                                                />
                                            </React.Fragment>
                                        ))
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>

                                <div className="shrink-0 border-t border-brand-border bg-brand-surface p-3 sm:p-4">
                                    {messagesError && <p role="alert" className="mb-2 text-xs font-bold text-red-500">{messagesError}</p>}
                                    {!humanHandoffActive && (
                                        <div className="mb-2 flex items-center gap-2 rounded-xl bg-violet-500/10 px-3 py-2 text-xs font-bold text-violet-700 dark:text-violet-300">
                                            <Bot size={15} className="shrink-0" aria-hidden="true" />
                                            A IA está atendendo. Clique em “Assumir atendimento” para responder pessoalmente.
                                        </div>
                                    )}
                                    <form onSubmit={handleSend} className="flex items-end gap-2">
                                        <label htmlFor="whatsapp-composer" className="sr-only">Digite uma mensagem</label>
                                        <textarea
                                            id="whatsapp-composer"
                                            value={composerText}
                                            onChange={(event) => setComposerText(event.target.value.slice(0, 4096))}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                                    event.preventDefault();
                                                    event.currentTarget.form?.requestSubmit();
                                                }
                                            }}
                                            disabled={!humanHandoffActive || sending}
                                            rows={1}
                                            placeholder={humanHandoffActive ? 'Digite uma mensagem...' : 'Assuma o atendimento para responder'}
                                            className="max-h-32 min-h-11 flex-1 resize-y rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-none placeholder:text-brand-muted focus:ring-2 focus:ring-tenant-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
                                        />
                                        <button
                                            type="submit"
                                            disabled={!humanHandoffActive || sending || !composerText.trim()}
                                            className="grid size-11 shrink-0 place-content-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                                            aria-label="Enviar mensagem"
                                        >
                                            {sending ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
                                        </button>
                                    </form>
                                    <p className="mt-1.5 text-right text-[9px] text-brand-muted">Enter envia · Shift + Enter quebra a linha</p>
                                </div>
                            </>
                        )}
                    </main>
                </section>
            )}
        </div>
    );
};

export default WhatsappInbox;
