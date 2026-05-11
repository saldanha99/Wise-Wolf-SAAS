
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSignup() {
    console.log('Attempting to sign up temp user...');
    const email = 'temp_admin_' + Date.now() + '@test.com';
    const password = '123123';

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
    });

    if (error) {
        console.error('Signup Error:', error);
    } else {
        console.log('Signup Success:', data);
        console.log('User ID:', data.user?.id);
    }
}

testSignup();
