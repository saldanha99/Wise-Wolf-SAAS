
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const SUPABASE_KEY = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkTenants() {
    console.log("--- Checking tenants Schema ---");
    const { data, error } = await supabase.from('tenants').select('*').limit(1);
    if (data && data[0]) {
        console.log("Tenant ID Type Sample:", typeof data[0].id, data[0].id);
    }
}
checkTenants();
