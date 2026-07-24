
import { supabase } from '../lib/supabase';

type EvolutionAction =
    | 'instance/create'
    | 'instance/connect'
    | 'instance/connectionState'
    | 'instance/logout'
    | 'instance/delete'
    | 'message/sendText'
    | 'group/fetchAllGroups';

type EvolutionProxyResult = {
    ok?: boolean;
    instanceName?: string;
    instanceId?: string;
    state?: string;
    qrcode?: string;
    messageId?: string;
    groups?: Array<{ id: string; subject: string }>;
    error?: string;
    code?: string;
};

class EvolutionProxyError extends Error {
    code?: string;
    status?: number;
}

async function resolveTenantId(tenantId?: string): Promise<string> {
    const suppliedTenantId = tenantId?.trim();
    if (suppliedTenantId) return suppliedTenantId;

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão expirada. Entre novamente.');

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('tenant_id')
        .eq('id', authData.user.id)
        .single();

    if (profileError || !profile?.tenant_id) throw new Error('Tenant do usuário não encontrado.');
    return String(profile.tenant_id);
}

async function invokeEvolution(
    action: EvolutionAction,
    tenantId: string | undefined,
    instanceName: string,
    payload?: Record<string, unknown>,
): Promise<EvolutionProxyResult> {
    const callerTenantId = await resolveTenantId(tenantId);
    const { data, error } = await supabase.functions.invoke('whatsapp-evolution-proxy', {
        body: { action, tenantId: callerTenantId, instanceName, payload },
    });

    if (error) {
        const proxyError = new EvolutionProxyError(error.message || 'Falha na integração com WhatsApp.');
        const context = (error as any)?.context;
        if (context && typeof context.clone === 'function') {
            proxyError.status = context.status;
            try {
                const details = await context.clone().json();
                if (details?.error) proxyError.message = String(details.error);
                if (details?.code) proxyError.code = String(details.code);
            } catch {
                // A resposta pode não ser JSON; mantemos a mensagem genérica do SDK.
            }
        }
        throw proxyError;
    }

    const result = (data || {}) as EvolutionProxyResult;
    if (result.error) {
        const proxyError = new EvolutionProxyError(result.error);
        proxyError.code = result.code;
        throw proxyError;
    }
    return result;
}

function buildUniqueInstanceName(instanceName: string): string {
    const clean = instanceName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 60) || 'usuario';
    const baseName = clean.startsWith('prof-') || clean.startsWith('escola-') ? clean : `prof-${clean}`;
    return `${baseName}-${Math.random().toString(36).slice(2, 6)}`;
}

// Template default global de lembrete de aula (usado quando professor nao customiza)
export const DEFAULT_REMINDER_TEMPLATE = `Oi {student_name}, tudo bem? 👋

Lembrando que nossa aula começa em 1 hora, às *{class_time}*.

{class_link}

Te espero! 🐺`;

export const REMINDER_TEMPLATE_VARIABLES = [
    { key: '{student_name}', label: 'Nome do aluno' },
    { key: '{class_time}', label: 'Horário da aula (HH:MM)' },
    { key: '{teacher_name}', label: 'Nome do professor' },
    { key: '{class_link}', label: 'Link da aula (Meet/Zoom)' },
    { key: '{tenant_name}', label: 'Nome da escola' },
];

export const whatsappService = {
    // 1. Create Instance
    async createInstance(
        tenantId: string | undefined,
        instanceName: string,
        options?: { preserveName?: boolean; ownerUserId?: string },
    ) {
        try {
            const requestedName = options?.preserveName ? instanceName.trim() : buildUniqueInstanceName(instanceName);
            const data = await invokeEvolution('instance/create', tenantId, requestedName, {
                ownerUserId: options?.ownerUserId,
            });
            const createdName = data.instanceName || requestedName;
            return {
                success: true,
                instanceName: createdName,
                data: { instance: { instanceName: createdName, instanceId: data.instanceId, status: data.state } },
            };
        } catch (error: any) {
            console.error('Create Instance Error:', error);
            return { success: false, error: error.message };
        }
    },

    async recreateInstance(tenantId: string | undefined, instanceName: string) {
        try {
            const data = await invokeEvolution('instance/create', tenantId, instanceName, { recreate: true });
            return { success: true, instanceName: data.instanceName || instanceName, data };
        } catch (error: any) {
            console.error('Recreate Instance Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 2. Connect / Get QR Code
    async connectInstance(tenantId: string | undefined, instanceName: string) {
        try {
            const data = await invokeEvolution('instance/connect', tenantId, instanceName);
            if (data.qrcode) {
                return { success: true, qrcode: data.qrcode };
            }
            if (data.state === 'open' || data.state === 'connected') {
                return { success: true, status: 'connected' };
            }
            return { success: false, data };
        } catch (error: any) {
            if (error?.code === 'INSTANCE_NOT_FOUND' || error?.status === 404) {
                return { success: false, error: 'INSTANCE_NOT_FOUND', notFound: true };
            }
            console.error('Connect Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 3. Get Status
    async fetchConnectionState(tenantId: string | undefined, instanceName: string) {
        try {
            const data = await invokeEvolution('instance/connectionState', tenantId, instanceName);
            return { success: true, state: data.state || 'disconnected' };
        } catch (error: any) {
            if (error?.code === 'INSTANCE_NOT_FOUND' || error?.status === 404) {
                return { success: false, state: 'not_found', notFound: true };
            }
            return { success: false, error: error.message, state: 'disconnected' };
        }
    },

    // 4. Send Message
    async sendText(tenantId: string | undefined, instanceName: string, number: string, text: string, userId?: string) {
        try {
            const cleanNumber = number.replace(/\D/g, '');
            const finalNumber = cleanNumber.startsWith('55') && cleanNumber.length > 10 ? cleanNumber : `55${cleanNumber}`;
            const result = await invokeEvolution('message/sendText', tenantId, instanceName, {
                number: finalNumber,
                text,
            });

            // Log to DB
            if (userId) {
                await supabase.from('whatsapp_logs').insert({
                    user_id: userId,
                    destination: finalNumber,
                    message: text,
                    status: 'sent',
                    response_data: result
                });
            }

            return { success: true, data: result };
        } catch (error: any) {
            console.error('Send Text Error:', error);
            if (userId) {
                await supabase.from('whatsapp_logs').insert({
                    user_id: userId,
                    destination: number.replace(/\D/g, ''),
                    message: text,
                    status: 'error',
                    response_data: { error: 'proxy_error' },
                });
            }
            return { success: false, error: error.message };
        }
    },

    // 5. Logout
    async logoutInstance(tenantId: string | undefined, instanceName: string) {
        try {
            await invokeEvolution('instance/logout', tenantId, instanceName);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // 6. Delete
    async deleteInstance(tenantId: string | undefined, instanceName: string) {
        try {
            await invokeEvolution('instance/delete', tenantId, instanceName);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    async fetchGroups(tenantId: string | undefined, instanceName: string) {
        try {
            const data = await invokeEvolution('group/fetchAllGroups', tenantId, instanceName);
            return { success: true, groups: data.groups || [] };
        } catch (error: any) {
            return { success: false, groups: [], error: error.message };
        }
    },

    // Helpers for automated messages
    async sendLessonReminder(tenantId: string | undefined, teacherId: string, instanceName: string, studentName: string, studentPhone: string, time: string, options?: { classLink?: string; teacherName?: string; tenantName?: string }) {
        const text = await this.renderLessonReminder(teacherId, {
            studentName,
            classTime: time,
            classLink: options?.classLink || '',
            teacherName: options?.teacherName || '',
            tenantName: options?.tenantName || '',
        });
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    },

    /**
     * Renderiza o template de lembrete do professor (com fallback para o default).
     * Variaveis suportadas: {student_name}, {class_time}, {class_link}, {teacher_name}, {tenant_name}
     */
    async renderLessonReminder(teacherId: string, vars: { studentName: string; classTime: string; classLink?: string; teacherName?: string; tenantName?: string }): Promise<string> {
        const { data: prof } = await supabase
            .from('profiles')
            .select('lesson_reminder_template')
            .eq('id', teacherId)
            .single();

        const template = prof?.lesson_reminder_template?.trim() || DEFAULT_REMINDER_TEMPLATE;
        return template
            .replace(/\{student_name\}/g, vars.studentName || '')
            .replace(/\{class_time\}/g, vars.classTime || '')
            .replace(/\{class_link\}/g, vars.classLink || '')
            .replace(/\{teacher_name\}/g, vars.teacherName || '')
            .replace(/\{tenant_name\}/g, vars.tenantName || '');
    },

    async sendRescheduleConfirmation(tenantId: string | undefined, teacherId: string, instanceName: string, studentName: string, studentPhone: string, date: string, time: string) {
        const text = `Olá ${studentName}! 🐺\n\nSua reposição na Wise Wolf foi confirmada para o dia *${date}* às *${time}*.\n\nAté lá! 🚀`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    }
};
