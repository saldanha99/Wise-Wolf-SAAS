
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkTenants() {
    console.log("--- Checking tenants Schema ---");
    const { data, error } = await supabase.from('tenants').select('*').limit(1);
    if (data && data[0]) {
        console.log("Tenant ID Type Sample:", typeof data[0].id, data[0].id);
    }
}
checkTenants();
