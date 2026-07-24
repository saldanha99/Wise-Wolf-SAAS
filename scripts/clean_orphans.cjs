
const { createClient } = require('@supabase/supabase-js');

// Config
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const SUPABASE_KEY = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function clean() {
    console.log("--- Deleting Orphan Payments ---");

    // Delete where tenant_id is NULL
    const { data, error, count } = await supabase
        .from('student_payments')
        .delete({ count: 'exact' })
        .is('tenant_id', null);

    if (error) {
        console.error("Error deleting:", error);
    } else {
        console.log(`Deleted ${count} orphan payments.`);
    }

    // Also check for 'undefined' string just in case
    const { count: count2 } = await supabase
        .from('student_payments')
        .delete({ count: 'exact' })
        .eq('tenant_id', 'undefined_tenant'); // based on my previous log script

    console.log(`Deleted ${count2} 'undefined_tenant' payments (if any).`);
}

clean();
