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
    }
};
