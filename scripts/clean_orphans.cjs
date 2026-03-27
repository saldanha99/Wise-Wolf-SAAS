
const { createClient } = require('@supabase/supabase-js');

// Config
const SUPABASE_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

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
