import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type User } from '../types';
import type {
    WhatsappConversation,
    WhatsappInboxService,
    WhatsappInstance,
    WhatsappMessage,
    WhatsappOutboundStatus,
} from '../services/whatsappInboxService';
import WhatsappInbox from './WhatsappInbox';

const user: User = {
    id: 'admin-1',
    tenantId: 'tenant-1',
    name: 'Diretora Demo',
    email: 'diretora@example.invalid',
    role: UserRole.SCHOOL_ADMIN,
};

const instance = (inboxEnabled: boolean, instanceName = 'escola-central'): WhatsappInstance => ({
    id: `instance-${instanceName}`,
    instance_name: instanceName,
    status: 'open',
    updated_at: '2026-08-28T12:00:00.000Z',
    inbox_enabled: inboxEnabled,
});

const conversations: WhatsappConversation[] = [
    {
        id: 'conversation-1',
        tenant_id: 'tenant-1',
        instance_name: 'escola-central',
        remote_jid: '5511999999999@s.whatsapp.net',
        phone: '5511999999999',
        display_name: 'Ana Aluna',
        contact_kind: 'student',
        last_message_at: '2026-08-28T12:00:00.000Z',
        last_message_preview: 'Preciso de ajuda',
        unread_count: 2,
        assigned_to: null,
        human_handoff_until: null,
        archived: false,
        updated_at: '2026-08-28T12:00:00.000Z',
    },
    {
        id: 'conversation-2',
        tenant_id: 'tenant-1',
        instance_name: 'escola-central',
        remote_jid: '5511888888888@s.whatsapp.net',
        phone: '5511888888888',
        display_name: 'João Lead',
        contact_kind: 'lead',
        last_message_at: '2026-08-28T11:00:00.000Z',
        last_message_preview: 'Obrigado',
        unread_count: 0,
        assigned_to: null,
        human_handoff_until: null,
        archived: false,
        updated_at: '2026-08-28T11:00:00.000Z',
    },
];

const incomingMessage: WhatsappMessage = {
    id: 'message-1',
    tenant_id: 'tenant-1',
    conversation_id: 'conversation-1',
    provider_message_id: 'provider-1',
    client_request_id: null,
    direction: 'in',
    sender_kind: 'contact',
    message_type: 'text',
    body: 'Preciso de ajuda',
    status: 'received',
    occurred_at: '2026-08-28T12:00:00.000Z',
    sent_by_user_id: null,
    error_code: null,
    updated_at: '2026-08-28T12:00:00.000Z',
};

function serviceHarness(options: {
    enabled: boolean;
    withConversations?: boolean;
    messages?: WhatsappMessage[];
    sendStatus?: WhatsappOutboundStatus;
}) {
    const service: WhatsappInboxService = {
        listInstances: vi.fn().mockResolvedValue([instance(options.enabled)]),
        listConversations: vi.fn().mockResolvedValue(options.withConversations ? conversations : []),
        listMessages: vi.fn().mockResolvedValue(options.messages ?? (options.withConversations ? [incomingMessage] : [])),
        enableInbox: vi.fn().mockResolvedValue(undefined),
        syncInbox: vi.fn().mockResolvedValue(undefined),
        sendText: vi.fn().mockResolvedValue({ status: options.sendStatus ?? 'sent' }),
        markRead: vi.fn().mockResolvedValue(undefined),
        setHandoff: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => undefined),
    };
    return service;
}

afterEach(() => vi.restoreAllMocks());

describe('<WhatsappInbox />', () => {
    it('ignora conexões antigas quando a escola muda durante o carregamento', async () => {
        const service = serviceHarness({ enabled: true });
        let resolveFirst!: (value: WhatsappInstance[]) => void;
        let resolveSecond!: (value: WhatsappInstance[]) => void;
        const firstRequest = new Promise<WhatsappInstance[]>((resolve) => {
            resolveFirst = resolve;
        });
        const secondRequest = new Promise<WhatsappInstance[]>((resolve) => {
            resolveSecond = resolve;
        });
        vi.mocked(service.listInstances)
            .mockReset()
            .mockReturnValueOnce(firstRequest)
            .mockReturnValueOnce(secondRequest);

        const { rerender } = render(
            <WhatsappInbox user={user} tenantId="tenant-1" service={service} />,
        );
        await waitFor(() => expect(service.listInstances).toHaveBeenCalledTimes(1));

        rerender(
            <WhatsappInbox
                user={{ ...user, tenantId: 'tenant-2' }}
                tenantId="tenant-2"
                service={service}
            />,
        );
        await waitFor(() => expect(service.listInstances).toHaveBeenCalledTimes(2));
        expect(service.listInstances).toHaveBeenNthCalledWith(1, 'tenant-1');
        expect(service.listInstances).toHaveBeenNthCalledWith(2, 'tenant-2');

        await act(async () => {
            resolveSecond([instance(true, 'escola-nova')]);
            await secondRequest;
        });
        expect(await screen.findByRole('option', { name: 'escola-nova' })).toBeInTheDocument();

        await act(async () => {
            resolveFirst([instance(true, 'escola-antiga')]);
            await firstRequest;
        });
        expect(screen.queryByRole('option', { name: 'escola-antiga' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Número conectado')).toHaveValue('escola-nova');
    });

    it('não sincroniza antes do consentimento institucional explícito', async () => {
        const service = serviceHarness({ enabled: false });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<WhatsappInbox user={user} tenantId="tenant-1" service={service} />);

        expect(await screen.findByText('Ativação institucional necessária')).toBeInTheDocument();
        const activate = screen.getByRole('button', { name: 'Ativar caixa de entrada' });
        expect(activate).toBeDisabled();

        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(activate);

        await waitFor(() => expect(service.enableInbox).toHaveBeenCalledWith('tenant-1', 'escola-central'));
        expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/número é institucional/i));
        expect(service.syncInbox).not.toHaveBeenCalled();
        expect(await screen.findByRole('button', { name: 'Sincronizar' })).toBeInTheDocument();
    });

    it('filtra não lidas, marca leitura e exige handoff antes de enviar', async () => {
        const service = serviceHarness({
            enabled: true,
            withConversations: true,
            sendStatus: 'uncertain',
        });

        render(<WhatsappInbox user={user} tenantId="tenant-1" service={service} />);

        expect(await screen.findByText('Ana Aluna')).toBeInTheDocument();
        expect(screen.getByText('João Lead')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Não lidas' }));
        expect(screen.queryByText('João Lead')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Ana Aluna/i }));
        await waitFor(() => expect(service.markRead).toHaveBeenCalledWith('tenant-1', 'escola-central', 'conversation-1'));
        expect(await screen.findByText('Preciso de ajuda')).toBeInTheDocument();
        expect(screen.getByLabelText('Digite uma mensagem')).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: /Assumir atendimento/i }));
        await waitFor(() => expect(service.setHandoff).toHaveBeenCalledWith('tenant-1', 'escola-central', 'conversation-1', true));

        const composer = screen.getByLabelText('Digite uma mensagem');
        expect(composer).toBeEnabled();
        fireEvent.change(composer, { target: { value: 'Olá, Ana! Como posso ajudar?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));

        await waitFor(() => expect(service.sendText).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            instanceName: 'escola-central',
            conversationId: 'conversation-1',
            text: 'Olá, Ana! Como posso ajudar?',
        })));
        expect(screen.getByText('Olá, Ana! Como posso ajudar?')).toBeInTheDocument();
        expect(await screen.findByLabelText('Entrega não confirmada')).toBeInTheDocument();
    });

    it('sincroniza o histórico uma vez ao selecionar e faz sincronização global mais a conversa no botão', async () => {
        const service = serviceHarness({ enabled: true, withConversations: true });

        render(<WhatsappInbox user={user} tenantId="tenant-1" service={service} />);

        fireEvent.click(await screen.findByRole('button', { name: /Ana Aluna/i }));
        await waitFor(() => expect(service.syncInbox).toHaveBeenCalledWith(
            'tenant-1',
            'escola-central',
            'conversation-1',
        ));
        expect(await screen.findAllByText('Preciso de ajuda')).toHaveLength(2);

        fireEvent.click(screen.getByRole('button', { name: 'Voltar para conversas' }));
        fireEvent.click(screen.getByRole('button', { name: /Ana Aluna/i }));
        await waitFor(() => expect(service.listMessages).toHaveBeenCalledTimes(2));
        expect(service.syncInbox).toHaveBeenCalledTimes(1);

        vi.mocked(service.syncInbox).mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }));
        await waitFor(() => expect(service.syncInbox).toHaveBeenCalledTimes(2));
        expect(service.syncInbox).toHaveBeenNthCalledWith(1, 'tenant-1', 'escola-central');
        expect(service.syncInbox).toHaveBeenNthCalledWith(2, 'tenant-1', 'escola-central', 'conversation-1');
    });

    it('distingue mensagens na fila, em despacho e com entrega incerta', async () => {
        const outgoing = (id: string, status: string, body: string): WhatsappMessage => ({
            ...incomingMessage,
            id,
            provider_message_id: `provider-${id}`,
            direction: 'out',
            sender_kind: 'human',
            body,
            status,
        });
        const service = serviceHarness({
            enabled: true,
            withConversations: true,
            messages: [
                outgoing('queued', 'queued', 'Mensagem na fila'),
                outgoing('dispatching', 'dispatching', 'Mensagem em despacho'),
                outgoing('uncertain', 'uncertain', 'Mensagem incerta'),
            ],
        });

        render(<WhatsappInbox user={user} tenantId="tenant-1" service={service} />);
        fireEvent.click(await screen.findByRole('button', { name: /Ana Aluna/i }));

        expect(await screen.findByText('Mensagem incerta')).toBeInTheDocument();
        expect(screen.getAllByLabelText('Enviando')).toHaveLength(2);
        expect(screen.getByLabelText('Entrega não confirmada')).toHaveClass('text-amber-200');
        expect(screen.queryByLabelText('Enviada')).not.toBeInTheDocument();
    });

    it('retenta uma falha de transporte com o mesmo identificador idempotente', async () => {
        const service = serviceHarness({ enabled: true, withConversations: true });
        vi.mocked(service.sendText)
            .mockRejectedValueOnce(new Error('A resposta da conexão se perdeu.'))
            .mockResolvedValueOnce({ status: 'sent' });

        render(<WhatsappInbox user={user} tenantId="tenant-1" service={service} />);
        fireEvent.click(await screen.findByRole('button', { name: /Ana Aluna/i }));
        fireEvent.click(screen.getByRole('button', { name: /Assumir atendimento/i }));
        await waitFor(() => expect(service.setHandoff).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText('Digite uma mensagem'), {
            target: { value: 'Mensagem idempotente' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));
        expect(await screen.findByLabelText('Entrega não confirmada')).toBeInTheDocument();

        const firstCall = vi.mocked(service.sendText).mock.calls[0]?.[0];
        fireEvent.click(screen.getByRole('button', {
            name: /Tentar novamente com segurança/i,
        }));

        await waitFor(() => expect(service.sendText).toHaveBeenCalledTimes(2));
        const secondCall = vi.mocked(service.sendText).mock.calls[1]?.[0];
        expect(secondCall?.clientRequestId).toBe(firstCall?.clientRequestId);
        expect(secondCall?.text).toBe('Mensagem idempotente');
        expect(await screen.findByLabelText('Enviada')).toBeInTheDocument();
    });
});
