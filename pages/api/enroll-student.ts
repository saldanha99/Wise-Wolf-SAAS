import { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// Setup Admin Client to bypass RLS for creating subscriptions/checking tenants
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * API Route: /api/enroll-student
 * Description: Handles the conversion of a Lead to a Student, calling Asaas for payment and updating DB.
 * Body: { leadId, planId, tenantId }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { leadId, planId, tenantId } = req.body;

    if (!leadId || !planId || !tenantId) {
        return res.status(400).json({ error: 'Missing required parameters: leadId, planId, tenantId' });
    }

    try {
        // 1. Fetch Lead and Plan Details
        const { data: lead, error: leadError } = await supabaseAdmin
            .from('crm_leads')
            .select('*')
            .eq('id', leadId)
            .single();

        if (leadError || !lead) throw new Error('Lead not found');

        const { data: plan, error: planError } = await supabaseAdmin
            .from('student_pricing_plans')
            .select('*')
            .eq('id', planId)
            .single();

        if (planError || !plan) throw new Error('Plan not found');

        const { data: tenant, error: tenantError } = await supabaseAdmin
            .from('tenants')
            .select('asaas_api_key')
            .eq('id', tenantId)
            .single();

        if (tenantError) throw new Error('Tenant not found');

        // 2. Integration with Asaas
        let subscriptionId = `mock_sub_${Date.now()}`;
        let customerId = `mock_cust_${leadId}`;

        // In production, uncomment and implement real Asaas call:
        /*
        if (tenant.asaas_api_key) {
            const customer = await createAsaasCustomer(tenant.asaas_api_key, lead);
            customerId = customer.id;
            const sub = await createAsaasSubscription(tenant.asaas_api_key, customerId, plan);
            subscriptionId = sub.id;
        } else {
             console.warn("No Asaas Key for Tenant, using Mock Mode");
        }
        */
        console.log(`[Enroll API] Simulating Asaas for Tenant ${tenantId}: Customer ${customerId}, Plan ${plan.name}`);

        // 3. Database Updates (Transaction-like)

        // A. Update Profile Role and Status
        // First find profile by email from lead
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('email', lead.email)
            .single();

        let studentId = profile?.id;

        if (!studentId) {
            // Create profile if doesn't exist (it should if scheduled, but maybe not)
            const { data: newProfile, error: createError } = await supabaseAdmin.from('profiles').insert({
                email: lead.email,
                full_name: lead.name,
                role: 'STUDENT',
                status: 'ACTIVE',
                tenant_id: tenantId,
                phone: lead.phone
            }).select().single();
            if (createError) throw createError;
            studentId = newProfile.id;
        } else {
            await supabaseAdmin.from('profiles').update({
                role: 'STUDENT',
                status: 'ACTIVE'
            }).eq('id', studentId);
        }

        // B. Create Subscription Record
        const { error: subError } = await supabaseAdmin.from('student_subscriptions').insert({
            tenant_id: tenantId,
            student_id: studentId,
            plan_id: plan.id,
            asaas_id: subscriptionId,
            status: 'ACTIVE'
        });

        if (subError) throw subError;

        // C. Update Lead Status
        const { error: leadUpdateError } = await supabaseAdmin.from('crm_leads')
            .update({ status: 'CONVERTED' })
            .eq('id', leadId);

        if (leadUpdateError) throw leadUpdateError;

        return res.status(200).json({
            success: true,
            message: 'Enrollment successful',
            subscriptionId
        });

    } catch (error: any) {
        console.error('[Enroll API Error]', error);
        return res.status(500).json({ error: error.message });
    }
}

// Helpers for Asaas (Placeholders)
async function createAsaasCustomer(apiKey: string, lead: any) {
    // Implement fetch to Asaas API
    return { id: 'cust_123' };
}

async function createAsaasSubscription(apiKey: string, customerId: string, plan: any) {
    // Implement fetch to Asaas API
    return { id: 'sub_123' };
}
