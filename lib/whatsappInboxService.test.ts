import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createClientRequestId,
    createWhatsappInboxService,
} from '../services/whatsappInboxService';

function serviceHarness() {
    const invoke = vi.fn().mockResolvedValue({ data: { ok: true, status: 'sent' }, error: null });
    const removeChannel = vi.fn().mockResolvedValue('ok');
    const channel = {
        on: vi.fn(),
        subscribe: vi.fn(),
    };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    const from = vi.fn();
    const client = {
        functions: { invoke },
        from,
        channel: vi.fn().mockReturnValue(channel),
        removeChannel,
    };

    return {
        service: createWhatsappInboxService(client as never),
        invoke,
        channel,
        removeChannel,
        from,
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('whatsappInboxService', () => {
    it('gera UUID v4 válido mesmo sem randomUUID', () => {
        vi.stubGlobal('crypto', {
            getRandomValues: (values: Uint8Array) => {
                values.forEach((_, index) => {
                    values[index] = index;
                });
                return values;
            },
        });

        expect(createClientRequestId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
        expect(createClientRequestId()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    });

    it('ativa somente por ação explícita e envia o consentimento esperado', async () => {
        const { service, invoke } = serviceHarness();

        await service.enableInbox('tenant-1', 'escola-central');

        expect(invoke).toHaveBeenCalledWith('whatsapp-evolution-proxy', {
            body: {
                action: 'inbox/enable',
                tenantId: 'tenant-1',
                instanceName: 'escola-central',
                payload: { enabled: true },
            },
        });
    });

    it('exibe a mensagem segura devolvida pela função em respostas não-2xx', async () => {
        const { service, invoke } = serviceHarness();
        invoke.mockResolvedValue({
            data: null,
            error: {
                message: 'Edge Function returned a non-2xx status code',
                context: new Response(JSON.stringify({
                    error: 'Não foi possível preparar a sincronização',
                    code: 'INBOX_WEBHOOK_CONFIG_FAILED',
                }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                }),
            },
        });

        await expect(service.enableInbox('tenant-1', 'escola-central'))
            .rejects.toThrow('Não foi possível preparar a sincronização');
    });

    it('preserva idempotência no envio e rejeita texto acima do limite', async () => {
        const { service, invoke } = serviceHarness();

        const result = await service.sendText({
            tenantId: 'tenant-1',
            instanceName: 'escola-central',
            conversationId: 'conversation-1',
            text: 'Olá!',
            clientRequestId: 'request-1',
        });
        expect(result).toEqual({ status: 'sent' });

        expect(invoke).toHaveBeenLastCalledWith('whatsapp-evolution-proxy', {
            body: {
                action: 'inbox/sendText',
                tenantId: 'tenant-1',
                instanceName: 'escola-central',
                payload: {
                    conversationId: 'conversation-1',
                    text: 'Olá!',
                    clientRequestId: 'request-1',
                },
            },
        });

        await expect(service.sendText({
            tenantId: 'tenant-1',
            instanceName: 'escola-central',
            conversationId: 'conversation-1',
            text: 'x'.repeat(4097),
            clientRequestId: 'request-2',
        })).rejects.toThrow(/4\.096/);
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('preserva resultado incerto do proxy e usa uncertain para status desconhecido', async () => {
        const { service, invoke } = serviceHarness();
        invoke
            .mockResolvedValueOnce({ data: { ok: true, status: 'uncertain' }, error: null })
            .mockResolvedValueOnce({ data: { ok: true, status: 'unexpected-status' }, error: null });

        const params = {
            tenantId: 'tenant-1',
            instanceName: 'escola-central',
            conversationId: 'conversation-1',
            text: 'Olá!',
            clientRequestId: 'request-1',
        };
        await expect(service.sendText(params)).resolves.toEqual({ status: 'uncertain' });
        await expect(service.sendText({ ...params, clientRequestId: 'request-2' }))
            .resolves.toEqual({ status: 'uncertain' });
    });

    it('filtra as instâncias explicitamente pela escola ativa', async () => {
        const { service, from } = serviceHarness();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(query);
        from.mockReturnValue(query);

        await service.listInstances('tenant-1');

        expect(from).toHaveBeenCalledWith('whatsapp_instances');
        expect(query.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
        expect(query.order).toHaveBeenNthCalledWith(1, 'updated_at', { ascending: false });
        expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
    });

    it('filtra a leitura de conversas pela escola e pela instância selecionada', async () => {
        const { service, from } = serviceHarness();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
            limit: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(query);
        query.limit.mockResolvedValue({ data: [], error: null });
        from.mockReturnValue(query);

        await service.listConversations('tenant-1', 'escola-central');

        expect(from).toHaveBeenCalledWith('whatsapp_conversations');
        expect(query.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
        expect(query.eq).toHaveBeenCalledWith('instance_name', 'escola-central');
        expect(query.eq).toHaveBeenCalledWith('archived', false);
        expect(query.order).toHaveBeenNthCalledWith(1, 'last_message_at', {
            ascending: false,
            nullsFirst: false,
        });
        expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
    });

    it('ordena mensagens de forma determinística antes de inverter para a linha do tempo', async () => {
        const { service, from } = serviceHarness();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
            limit: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(query);
        query.limit.mockResolvedValue({ data: [], error: null });
        from.mockReturnValue(query);

        await service.listMessages('tenant-1', 'conversation-1');

        expect(query.order).toHaveBeenNthCalledWith(1, 'occurred_at', { ascending: false });
        expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
    });

    it('escuta as duas tabelas pelo tenant e remove o canal no cleanup', () => {
        const { service, channel, removeChannel } = serviceHarness();
        const handlers = {
            onConversationChange: vi.fn(),
            onMessageChange: vi.fn(),
            onError: vi.fn(),
        };

        const unsubscribe = service.subscribe('tenant-1', handlers);

        expect(channel.on).toHaveBeenNthCalledWith(1, 'postgres_changes', expect.objectContaining({
            table: 'whatsapp_conversations',
            filter: 'tenant_id=eq.tenant-1',
        }), handlers.onConversationChange);
        expect(channel.on).toHaveBeenNthCalledWith(2, 'postgres_changes', expect.objectContaining({
            table: 'whatsapp_messages',
            filter: 'tenant_id=eq.tenant-1',
        }), handlers.onMessageChange);

        unsubscribe();
        expect(removeChannel).toHaveBeenCalledTimes(1);
    });
});
