import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface WhatsappInstance {
    id: string;
    instance_name: string;
    status: string | null;
    updated_at: string | null;
    inbox_enabled: boolean;
}

export interface WhatsappConversation {
    id: string;
    tenant_id: string;
    instance_name: string;
    remote_jid: string;
    phone: string | null;
    display_name: string | null;
    contact_kind: string | null;
    last_message_at: string | null;
    last_message_preview: string | null;
    unread_count: number;
    assigned_to: string | null;
    human_handoff_until: string | null;
    archived: boolean;
    updated_at: string;
}

export interface WhatsappMessage {
    id: string;
    tenant_id: string;
    conversation_id: string;
    provider_message_id: string | null;
    client_request_id: string | null;
    direction: 'in' | 'out';
    sender_kind: string;
    message_type: string;
    body: string | null;
    status: string;
    occurred_at: string;
    sent_by_user_id: string | null;
    error_code: string | null;
    updated_at: string;
}

export interface InboxSubscriptionHandlers {
    onConversationChange: () => void;
    onMessageChange: () => void;
    onError?: () => void;
}

export type WhatsappOutboundStatus =
    | 'queued'
    | 'dispatching'
    | 'sent'
    | 'delivered'
    | 'read'
    | 'failed'
    | 'uncertain';

export interface WhatsappSendTextResult {
    status: WhatsappOutboundStatus;
}

export interface WhatsappInboxService {
    listInstances(tenantId: string): Promise<WhatsappInstance[]>;
    listConversations(tenantId: string, instanceName: string): Promise<WhatsappConversation[]>;
    listMessages(tenantId: string, conversationId: string): Promise<WhatsappMessage[]>;
    enableInbox(tenantId: string, instanceName: string): Promise<void>;
    syncInbox(tenantId: string, instanceName: string, conversationId?: string): Promise<void>;
    sendText(params: {
        tenantId: string;
        instanceName: string;
        conversationId: string;
        text: string;
        clientRequestId: string;
    }): Promise<WhatsappSendTextResult>;
    markRead(tenantId: string, instanceName: string, conversationId: string): Promise<void>;
    setHandoff(tenantId: string, instanceName: string, conversationId: string, active: boolean): Promise<void>;
    subscribe(tenantId: string, handlers: InboxSubscriptionHandlers): () => void;
}

type InboxClient = Pick<typeof supabase, 'from' | 'functions' | 'channel' | 'removeChannel'>;

const CONVERSATION_COLUMNS = [
    'id',
    'tenant_id',
    'instance_name',
    'remote_jid',
    'phone',
    'display_name',
    'contact_kind',
    'last_message_at',
    'last_message_preview',
    'unread_count',
    'assigned_to',
    'human_handoff_until',
    'archived',
    'updated_at',
].join(',');

const MESSAGE_COLUMNS = [
    'id',
    'tenant_id',
    'conversation_id',
    'provider_message_id',
    'client_request_id',
    'direction',
    'sender_kind',
    'message_type',
    'body',
    'status',
    'occurred_at',
    'sent_by_user_id',
    'error_code',
    'updated_at',
].join(',');

const INSTANCE_COLUMNS = 'id,instance_name,status,updated_at,inbox_enabled';
const OUTBOUND_STATUSES = new Set<WhatsappOutboundStatus>([
    'queued',
    'dispatching',
    'sent',
    'delivered',
    'read',
    'failed',
    'uncertain',
]);

function required(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} não informado.`);
    return normalized;
}

async function readProxyErrorPayload(error: unknown, data: unknown): Promise<unknown> {
    if (data !== null && data !== undefined) return data;
    if (!error || typeof error !== 'object' || !('context' in error)) return data;

    const context = (error as { context?: unknown }).context;
    if (!context || typeof context !== 'object') return data;

    try {
        const response = 'clone' in context && typeof context.clone === 'function'
            ? context.clone()
            : context;
        return response && typeof response === 'object' && 'json' in response && typeof response.json === 'function'
            ? await response.json()
            : data;
    } catch {
        return data;
    }
}

async function proxyError(error: unknown, data: unknown): Promise<Error> {
    const payload = await readProxyErrorPayload(error, data);
    const responseMessage = payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error || '')
        : '';
    const sdkMessage = error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message || '')
        : '';
    return new Error(responseMessage || sdkMessage || 'Não foi possível concluir a operação no WhatsApp.');
}

function outboundStatus(data: unknown): WhatsappOutboundStatus {
    if (!data || typeof data !== 'object' || !('status' in data)) return 'uncertain';
    const status = String((data as { status?: unknown }).status || '').trim().toLowerCase();
    return OUTBOUND_STATUSES.has(status as WhatsappOutboundStatus)
        ? status as WhatsappOutboundStatus
        : 'uncertain';
}

export function createClientRequestId(): string {
    const browserCrypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
    if (typeof browserCrypto?.randomUUID === 'function') {
        return browserCrypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (typeof browserCrypto?.getRandomValues === 'function') {
        browserCrypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
    ].join('-');
}

export function createWhatsappInboxService(client: InboxClient): WhatsappInboxService {
    const invoke = async (
        action: string,
        tenantId: string,
        instanceName: string,
        payload: Record<string, unknown> = {},
    ) => {
        const { data, error } = await client.functions.invoke('whatsapp-evolution-proxy', {
            body: {
                action,
                tenantId: required(tenantId, 'Escola'),
                instanceName: required(instanceName, 'Instância'),
                payload,
            },
        });
        if (error || (data && typeof data === 'object' && 'error' in data)) {
            throw await proxyError(error, data);
        }
        return data;
    };

    return {
        async listInstances(tenantId) {
            const { data, error } = await client
                .from('whatsapp_instances')
                .select(INSTANCE_COLUMNS)
                .eq('tenant_id', required(tenantId, 'Escola'))
                .order('updated_at', { ascending: false })
                .order('id', { ascending: false });
            if (error) throw new Error(error.message || 'Não foi possível carregar as conexões do WhatsApp.');
            return (data || []) as WhatsappInstance[];
        },

        async listConversations(tenantId, instanceName) {
            const { data, error } = await client
                .from('whatsapp_conversations')
                .select(CONVERSATION_COLUMNS)
                .eq('tenant_id', required(tenantId, 'Escola'))
                .eq('instance_name', required(instanceName, 'Instância'))
                .eq('archived', false)
                .order('last_message_at', { ascending: false, nullsFirst: false })
                .order('id', { ascending: false })
                .limit(250);
            if (error) throw new Error(error.message || 'Não foi possível carregar as conversas.');
            return (data || []) as unknown as WhatsappConversation[];
        },

        async listMessages(tenantId, conversationId) {
            const { data, error } = await client
                .from('whatsapp_messages')
                .select(MESSAGE_COLUMNS)
                .eq('tenant_id', required(tenantId, 'Escola'))
                .eq('conversation_id', required(conversationId, 'Conversa'))
                .order('occurred_at', { ascending: false })
                .order('id', { ascending: false })
                .limit(300);
            if (error) throw new Error(error.message || 'Não foi possível carregar as mensagens.');
            return ((data || []) as unknown as WhatsappMessage[]).reverse();
        },

        async enableInbox(tenantId, instanceName) {
            await invoke('inbox/enable', tenantId, instanceName, { enabled: true });
        },

        async syncInbox(tenantId, instanceName, conversationId) {
            await invoke('inbox/sync', tenantId, instanceName, conversationId ? { conversationId } : {});
        },

        async sendText({ tenantId, instanceName, conversationId, text, clientRequestId }) {
            const normalizedText = text.trim();
            if (!normalizedText || normalizedText.length > 4096) {
                throw new Error('A mensagem precisa ter entre 1 e 4.096 caracteres.');
            }
            const data = await invoke('inbox/sendText', tenantId, instanceName, {
                conversationId: required(conversationId, 'Conversa'),
                text: normalizedText,
                clientRequestId: required(clientRequestId, 'Identificador da mensagem'),
            });
            return { status: outboundStatus(data) };
        },

        async markRead(tenantId, instanceName, conversationId) {
            await invoke('inbox/markRead', tenantId, instanceName, {
                conversationId: required(conversationId, 'Conversa'),
            });
        },

        async setHandoff(tenantId, instanceName, conversationId, active) {
            await invoke('inbox/setHandoff', tenantId, instanceName, {
                conversationId: required(conversationId, 'Conversa'),
                active,
            });
        },

        subscribe(tenantId, handlers) {
            const normalizedTenantId = required(tenantId, 'Escola');
            if (!/^[a-zA-Z0-9_-]{1,160}$/.test(normalizedTenantId)) {
                handlers.onError?.();
                return () => undefined;
            }
            const safeTopicTenant = normalizedTenantId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
            const channel: RealtimeChannel = client
                .channel(`whatsapp-inbox-${safeTopicTenant}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'whatsapp_conversations',
                        filter: `tenant_id=eq.${normalizedTenantId}`,
                    },
                    handlers.onConversationChange,
                )
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'whatsapp_messages',
                        filter: `tenant_id=eq.${normalizedTenantId}`,
                    },
                    handlers.onMessageChange,
                )
                .subscribe((status) => {
                    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') handlers.onError?.();
                });

            return () => {
                void client.removeChannel(channel);
            };
        },
    };
}

export const whatsappInboxService = createWhatsappInboxService(supabase);
