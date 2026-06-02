import { supabase } from '../lib/supabase';

export const asaasService = {
    syncStudent: async (studentData: {
        user_id: string;
        name: string;
        email: string;
        cpf: string;
        phone: string;
        postalCode: string;
        address: string;
        addressNumber: string;
        // Extended profile fields (optional, for enrollment flow)
        tenant_id?: string;
        monthly_fee?: number;
        due_day?: number;
        class_frequency?: string;
        professor_id?: string | null;
        professor_id_2?: string | null;
        classSchedule?: any[];
        contract_accepted?: boolean;
        documentation_status?: string;
        signature_ip?: string;
        student_signature_url?: string | null;
        signed_document_url?: string | null;
        startDate?: string;
        // Matrícula de dependente: cobrança no CPF do responsável financeiro.
        // Quando is_dependent=true, a edge cria SEMPRE um novo customer ASAAS
        // (cpfCnpj = guardian_cpf) e grava guardian_* sem escrever profiles.cpf.
        is_dependent?: boolean;
        guardian_name?: string;
        guardian_cpf?: string;
        guardian_email?: string;
        guardian_phone?: string;
        guardian_id?: string | null;
    }) => {
        try {
            console.log('Syncing student to Asaas:', studentData);
            const { data, error } = await supabase.functions.invoke('sync-student-asaas', {
                body: studentData
            });

            if (error) {
                throw error;
            }

            // Handle "Soft Errors" (200 OK but success: false)
            if (data && data.success === false) {
                console.warn('Asaas Sync Soft Error:', data);
                throw data; // This object has { error: "...", asaasErrors: [] }
            }

            console.log('Asaas Sync Result:', data);
            return data;
        } catch (error) {
            console.error('Error syncing with Asaas:', error);
            throw error;
        }
    },

    createSubscription: async (data: {
        user_id: string;
        customer?: string;
        value: number;
        dueDay: number;
        billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
        planDuration?: 'RECURRENT' | 'SEMESTER' | 'ANNUAL';
        // startDate: YYYY-MM — mês de início da cobrança (billingStartMonth)
        // Se fornecido, o nextDueDate da assinatura será calculado a partir deste mês
        startDate?: string;
        proRata?: boolean;
        proRataValue?: number;
        creditCard?: {
            holderName: string;
            number: string;
            expiryMonth: string;
            expiryYear: string;
            ccv: string;
        };
        creditCardHolderInfo?: {
            name: string;
            email: string;
            cpfCnpj: string;
            postalCode: string;
            addressNumber: string;
            phone: string;
        };
    }) => {
        try {
            console.log('Creating Asaas Subscription:', { ...data, creditCard: data.creditCard ? '***' : undefined });

            const { data: responseData, error } = await supabase.functions.invoke('create-asaas-subscription', {
                body: data
            });

            if (error) {
                console.error("❌ Erro no Service (invoke):", error);
                throw new Error(error.message || 'Erro ao processar pagamento.');
            }

            // Handle errors returned as JSON in data
            if (responseData && responseData.error) {
                const errorMessage = responseData.error || 'Erro ao processar pagamento.';
                console.error("❌ Erro no Service:", errorMessage, "\nDEBUG INFO:", JSON.stringify(responseData.debug || responseData, null, 2));
                throw new Error(errorMessage);
            }

            console.log('Subscription Result:', responseData);

            // Defense in Depth: Catch "Soft Errors" that might be returned as 200
            if (responseData && responseData.success === false) {
                console.error("❌ Soft Error no Service:", responseData);
                const msg = responseData.error || "Erro ao processar assinatura.";
                throw new Error(msg);
            }

            return responseData;

        } catch (error: any) {
            console.error('Error creating subscription:', error);
            // Re-throw the error ensuring it's an Error object
            throw error instanceof Error ? error : new Error(error.message || String(error));
        }
    },

    createEnrollmentPix: async (amount: number, customerData: { name: string; email: string; cpfCnpj: string; phone: string }) => {
        try {
            console.log('Generating enrollment Pix for R$', amount);
            const { data, error } = await supabase.functions.invoke('create-enrollment-pix', {
                body: { amount, customerData }
            });

            if (error) throw error;
            if (data && data.success === false) throw data;

            return data;
        } catch (error) {
            console.error('Error creating enrollment Pix:', error);
            throw error;
        }
    },

    checkPaymentStatus: async (paymentId: string) => {
        // FIX: Antes havia duas invocações (asaas-webhook + create-enrollment-pix) e apenas
        // a segunda era retornada — e ela sempre falhava porque create-enrollment-pix não
        // tratava action='check'. Agora usa apenas create-enrollment-pix com o handler correto.
        try {
            const { data, error } = await supabase.functions.invoke('create-enrollment-pix', {
                body: { action: 'check', paymentId }
            });
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error checking payment status:', error);
            return { success: false };
        }
    }
};
