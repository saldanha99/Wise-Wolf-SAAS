
import { supabase } from '../lib/supabase';

export const whatsappService = {
    // Helper to call the secure proxy (Edge Function)
    // This avoids hardcoding API keys in the frontend.
    async callProxy(action: string, instanceName: string, payload?: any) {
        try {
            const { data, error } = await supabase.functions.invoke('whatsapp-evolution-proxy', {
                body: { action, instanceName, payload }
            });

            if (error) throw error;
            return data;
        } catch (error: any) {
            console.error(`[whatsappService] Error calling proxy (${action}):`, error);
            return { success: false, error: error.message };
        }
    },

    // 1. Create Instance
    async createInstance(tenantId: string, instanceName: string) {
        // AJUSTE DE NOME (FIX DUPLICIDADE E UNICIDADE)
        const baseName = instanceName.toLowerCase().startsWith('prof')
            ? instanceName.toLowerCase()
            : `prof-${instanceName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            
        const uniqueName = `${baseName}-${Math.random().toString(36).substring(2, 6)}`;

        const data = await this.callProxy('instance/create', uniqueName);
        if (data.error) return { success: false, error: data.error };
        return { success: true, instanceName: uniqueName, data };
    },

    // 2. Connect / Get QR Code
    async connectInstance(tenantId: string, instanceName: string) {
        const data = await this.callProxy('instance/connect', instanceName);
        if (data.error) return { success: false, error: data.error };
        
        if (data.base64) {
            return { success: true, qrcode: data.base64 };
        }
        if (data.instance?.state === 'open' || data.instance?.state === 'connected') {
            return { success: true, status: 'connected' };
        }
        return { success: false, data };
    },

    // 3. Get Status
    async fetchConnectionState(tenantId: string, instanceName: string) {
        const data = await this.callProxy('instance/connectionState', instanceName);
        if (data.error) return { success: false, error: data.error };
        return { success: true, state: data.instance?.state || 'disconnected' };
    },

    // 4. Send Message
    async sendText(tenantId: string, instanceName: string, number: string, text: string, userId?: string) {
        const cleanNumber = number.replace(/\D/g, '');
        const finalNumber = cleanNumber.startsWith('55') && cleanNumber.length > 10 ? cleanNumber : `55${cleanNumber}`;

        const result = await this.callProxy('message/sendText', instanceName, {
            number: finalNumber,
            text: text
        });

        // Log to DB if needed
        if (userId && !result.error) {
            await supabase.from('whatsapp_logs').insert({
                user_id: userId,
                destination: finalNumber,
                message: text,
                status: 'sent',
                response_data: result
            });
        }

        return { success: !result.error, data: result, error: result.error };
    },

    // 5. Logout
    async logoutInstance(tenantId: string, instanceName: string) {
        const data = await this.callProxy('instance/logout', instanceName);
        return { success: !data.error, error: data.error };
    },

    // 6. Delete
    async deleteInstance(tenantId: string, instanceName: string) {
        const data = await this.callProxy('instance/delete', instanceName);
        return { success: !data.error, error: data.error };
    },

    // Helpers for automated messages (Dashboard only)
    async sendLessonReminder(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, time: string) {
        const text = `Oi ${studentName}, tudo bem? 👋\n\nPassando para lembrar que nossa aula começa em 1 hora, às *${time}*.\n\nTe espero no link! 📽️`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    },

    async sendRescheduleConfirmation(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, date: string, time: string) {
        const text = `Olá ${studentName}! 🐺\n\nSua reposição na Wise Wolf foi confirmada para o dia *${date}* às *${time}*.\n\nAté lá! 🚀`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    }
};
