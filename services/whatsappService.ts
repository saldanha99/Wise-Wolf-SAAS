
import { supabase } from '../lib/supabase';

// Helper to get global config (Simulated for now, replace with actual global config fetch)
// Helper to get global config (Simulated for now, replace with actual global config fetch)
const getEvolutionConfig = async (tenantId: string) => {
    const { data: tenant } = await supabase
        .from('tenants')
        .select('whatsapp_api_url, whatsapp_api_key')
        .eq('id', tenantId)
        .single();

    const baseUrl = tenant?.whatsapp_api_url;
    const globalApiKey = tenant?.whatsapp_api_key;

    if (!baseUrl || baseUrl === 'https://api.evolution.com') { // Check for empty or default placeholder
        throw new Error('Configuração da API Evolution ausente ou inválida. Configure em "Config. Escola" > "Automação WhatsApp".');
    }

    return {
        baseUrl,
        globalApiKey: globalApiKey || ''
    };
};

export const whatsappService = {
    // 1. Create Instance
    async createInstance(tenantId: string, instanceName: string) {
        try {
            const config = await getEvolutionConfig(tenantId);
            const uniqueName = `${instanceName.replace(/\s+/g, '_')}_${Date.now()}`; // Ensure uniqueness

            const response = await fetch(`${config.baseUrl}/instance/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': config.globalApiKey
                },
                body: JSON.stringify({
                    instanceName: uniqueName,
                    token: uniqueName, // Use name as token for simplicity
                    qrcode: true
                })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Failed to create instance');

            return { success: true, instanceName: uniqueName, data };
        } catch (error: any) {
            console.error('Create Instance Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 2. Connect / Get QR Code
    async connectInstance(tenantId: string, instanceName: string) {
        try {
            const config = await getEvolutionConfig(tenantId);
            const response = await fetch(`${config.baseUrl}/instance/connect/${instanceName}`, {
                method: 'GET',
                headers: {
                    'apikey': config.globalApiKey
                }
            });

            const data = await response.json();
            // Evolution API usually returns base64 in 'base64' or 'qrcode' field depending on version
            // Adapting to standard v1 response
            if (data.base64) {
                return { success: true, qrcode: data.base64 };
            }
            // If already connected, it might return status
            if (data.instance?.status === 'open') {
                return { success: true, status: 'connected' };
            }

            return { success: false, data };
        } catch (error: any) {
            console.error('Connect Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 3. Get Status
    async fetchConnectionState(tenantId: string, instanceName: string) {
        try {
            const config = await getEvolutionConfig(tenantId);
            const response = await fetch(`${config.baseUrl}/instance/connectionState/${instanceName}`, {
                method: 'GET',
                headers: {
                    'apikey': config.globalApiKey
                }
            });
            const data = await response.json();
            // Returns { instance: { state: 'open' | 'close' | 'connecting' } }
            return { success: true, state: data.instance?.state || 'disconnected' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // 4. Send Message
    async sendText(tenantId: string, instanceName: string, number: string, text: string, userId?: string) {
        try {
            const config = await getEvolutionConfig(tenantId);

            // Format number
            const cleanNumber = number.replace(/\D/g, '');
            const finalNumber = cleanNumber.startsWith('55') && cleanNumber.length > 10 ? cleanNumber : `55${cleanNumber}`;

            const response = await fetch(`${config.baseUrl}/message/sendText/${instanceName}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': config.globalApiKey
                },
                body: JSON.stringify({
                    number: finalNumber,
                    text: text,
                    linkPreview: true
                })
            });

            const result = await response.json();

            // Log to DB
            if (userId) {
                await supabase.from('whatsapp_logs').insert({
                    user_id: userId,
                    destination: finalNumber,
                    message: text,
                    status: response.ok ? 'sent' : 'error',
                    response_data: result
                });
            }

            return { success: response.ok, data: result };
        } catch (error: any) {
            console.error('Send Text Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 5. Logout
    async logoutInstance(tenantId: string, instanceName: string) {
        try {
            const config = await getEvolutionConfig(tenantId);
            await fetch(`${config.baseUrl}/instance/logout/${instanceName}`, {
                method: 'DELETE',
                headers: { 'apikey': config.globalApiKey }
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // 6. Delete
    async deleteInstance(tenantId: string, instanceName: string) {
        try {
            const config = await getEvolutionConfig(tenantId);
            await fetch(`${config.baseUrl}/instance/delete/${instanceName}`, {
                method: 'DELETE',
                headers: { 'apikey': config.globalApiKey }
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // Helpers for automated messages
    async sendLessonReminder(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, time: string) {
        const text = `Oi ${studentName}, tudo bem? 👋\n\nPassando para lembrar que nossa aula começa em 1 hora, às *${time}*.\n\nTe espero no link! 📽️`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    },

    async sendRescheduleConfirmation(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, date: string, time: string) {
        const text = `Olá ${studentName}! 🐺\n\nSua reposição na Wise Wolf foi confirmada para o dia *${date}* às *${time}*.\n\nAté lá! 🚀`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    }
};
