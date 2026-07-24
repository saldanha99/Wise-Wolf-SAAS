
const { createClient } = require('@supabase/supabase-js');

function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const supabaseUrl = requireEnv('SUPABASE_URL');
const supabaseKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

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
