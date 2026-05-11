
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Njk4OTAxOSwiZXhwIjoyMDgyNTY1MDE5fQ.nnDE2JPlrWgAwGXbkDXHc315pKUiMGNv2-dad2IY3TY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function debugAuth() {
    console.log('--- DEBUG AUTH CREATION ---');

    // Test 1: Target Email
    const targetEmail = 'wisewolflanguague@gmail.com';
    console.log(`\nAttempting ${targetEmail}...`);
    const { data: d1, error: e1 } = await supabase.auth.admin.createUser({
        email: targetEmail,
        password: '123123',
        email_confirm: true
    });
    if (e1) console.error('FAILED:', e1.message);
    else console.log('SUCCESS:', d1.user.id);

    // Test 2: Variation Email
    const varEmail = 'wisewolflanguague_TEST_' + Date.now() + '@gmail.com';
    console.log(`\nAttempting ${varEmail}...`);
    const { data: d2, error: e2 } = await supabase.auth.admin.createUser({
        email: varEmail,
        password: '123123',
        email_confirm: true
    });
    if (e2) console.error('FAILED:', e2.message);
    else console.log('SUCCESS:', d2.user.id);
}

debugAuth();
