import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

let ASAAS_URL = Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com';
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const ASAAS_API_KEY = (Deno.env.get('ASAAS_API_KEY') || "").trim() || (Deno.env.get('ASAAS_ACCESS_TOKEN') || "").trim();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
  // 1. CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabase = createClient(supabaseUrl!, supabaseKey!) // Service role required

    // 2. Validate Authorization
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Auth Header' }), { status: 401, headers: corsHeaders })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })
    }

    // 3. Verify Admin Role
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!adminProfile || (adminProfile.role !== 'SCHOOL_ADMIN' && adminProfile.role !== 'SUPER_ADMIN')) {
      return new Response(JSON.stringify({ error: 'Forbidden: Requires Admin Role' }), { status: 403, headers: corsHeaders })
    }

    // 4. Parse Request
    const { studentId, applyPenalty, penaltyValue } = await req.json()
    if (!studentId) {
      return new Response(JSON.stringify({ error: 'Missing studentId parameter' }), { status: 400, headers: corsHeaders })
    }

    // Prevent self-deletion via this endpoint
    const { data: targetUser } = await supabase.auth.admin.getUserById(studentId);
    if (studentId === user.id || (targetUser?.user?.email === user.email)) {
      console.warn(`[Supabase] Self-deletion attempt blocked for user ${user.email} (ID: ${user.id}) trying to delete target ID: ${studentId}`);
      return new Response(JSON.stringify({ error: 'Você não pode excluir sua própria conta enquanto estiver logado.' }), { status: 400, headers: corsHeaders })
    }

    // 5. Get Student Profile to find Asaas IDs
    const { data: studentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('full_name, asaas_customer_id, subscription_id')
      .eq('id', studentId)
      .single()

    if (profileError) {
      console.error(`[Supabase] Profile not found for target user ID: ${studentId}`, profileError);
      // We proceed because we still want to try deleting the Auth User if it exists (orphaned checks)
    }

    const studentName = studentProfile?.full_name || 'Usuário';

    // 6. Delete Asaas Subscription and Customer (if they exist)
    let asaasDeletionResult = { subscriptionDeleted: false, customerDeleted: false, error: null };
    if (ASAAS_API_KEY) {
      const asaas_customer_id = studentProfile?.asaas_customer_id;
      const subscription_id = studentProfile?.subscription_id;

      let pathPrefix = '/api/v3';
      if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
        pathPrefix = '/v3';
      }

      try {
        // Cancel/Delete Subscription first
        if (subscription_id) {
          const subUrl = `${ASAAS_URL}${pathPrefix}/subscriptions/${subscription_id}`;
          console.log(`[Asaas] Attempting to delete subscription ${subscription_id} for ${studentName}`);
          const subRes = await fetch(subUrl, {
            method: 'DELETE',
            headers: { 'access_token': ASAAS_API_KEY! }
          });
          if (subRes.ok) {
            asaasDeletionResult.subscriptionDeleted = true;
            console.log(`[Asaas] Subscription ${subscription_id} deleted successfully.`);
          } else {
            const subErr = await subRes.text();
            console.warn(`[Asaas] Failed to delete subscription ${subscription_id} (Status ${subRes.status}): ${subErr}`);
          }
        }

        let penaltyCreated = false;
        if (applyPenalty && penaltyValue && asaas_customer_id) {
          // Create a fine charge (Multa Rescisória)
          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + 5); // Due in 5 days
          const formattedDueDate = dueDate.toISOString().split('T')[0];

          const fineUrl = `${ASAAS_URL}${pathPrefix}/payments`;
          console.log(`[Asaas] Creating penalty charge of R$ ${penaltyValue} for customer ${asaas_customer_id}`);
          const fineRes = await fetch(fineUrl, {
            method: 'POST',
            headers: {
              'access_token': ASAAS_API_KEY!,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              customer: asaas_customer_id,
              billingType: 'UNDEFINED',
              value: penaltyValue,
              dueDate: formattedDueDate,
              description: `Multa Contratual Rescisória - Aluno: ${studentName}`,
              postalService: false
            })
          });

          if (fineRes.ok) {
            penaltyCreated = true;
            const fineData = await fineRes.json();
            console.log(`[Asaas] Penalty created successfully. Payment ID: ${fineData.id}`);
          } else {
            const fineErr = await fineRes.text();
            console.error(`[Asaas] FAILED to create penalty charge: ${fineErr}`);
            // We DON'T throw here, because we want the local deletion to proceed if possible,
            // but we should probably warn the user.
            asaasDeletionResult.error = `Erro ao criar multa no Asaas: ${fineErr}`;
          }
        }

        // Delete Customer (ONLY if we didn't just create a penalty, because Asaas blocks deletion of customers with pending payments)
        if (asaas_customer_id && !penaltyCreated) {
          const custUrl = `${ASAAS_URL}${pathPrefix}/customers/${asaas_customer_id}`;
          console.log(`[Asaas] Deleting customer ${asaas_customer_id} (${studentName})`);
          const custRes = await fetch(custUrl, {
            method: 'DELETE',
            headers: { 'access_token': ASAAS_API_KEY! }
          });
          if (custRes.ok) {
            asaasDeletionResult.customerDeleted = true;
            console.log(`[Asaas] Customer ${asaas_customer_id} deleted successfully.`);
          } else {
            const custErr = await custRes.text();
            console.warn(`[Asaas] Failed to delete customer ${asaas_customer_id} (Status ${custRes.status}): ${custErr}`);
          }
        } else if (penaltyCreated) {
          console.log(`[Asaas] Skipping customer deletion because a penalty invoice was generated.`);
          (asaasDeletionResult as any).penaltyCreated = true;
        }
      } catch (asaasErr: any) {
        console.error('[Asaas] Critical error during Asaas cleanup:', asaasErr.message);
        asaasDeletionResult.error = asaasErr.message;
      }
    }

    // 7. Delete Auth User from Supabase
    console.log(`[Supabase] Deleting auth user: ${studentId} (${studentName})`);
    const { error: deleteError } = await supabase.auth.admin.deleteUser(studentId)

    if (deleteError) {
      console.error(`[Supabase] MAJOR ERROR deleting auth user ${studentId}:`, deleteError);
      // Return a 400 but with the descriptive error (likely FK violation)
      return new Response(JSON.stringify({
        error: `Erro ao remover usuário do sistema: ${deleteError.message}`,
        details: deleteError
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'User deleted successfully from Auth and Profiles',
      asaas: asaasDeletionResult
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: any) {
    console.error("Unexpected Error in delete-student-account:", error);
    return new Response(JSON.stringify({ error: `Erro inesperado: ${error.message}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
