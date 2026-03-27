const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
    const email = `test_${Date.now()}@example.com`;
    console.log("Signing up:", email);

    const { data: auth, error: signUpError } = await supabase.auth.signUp({
        email,
        password: 'password123'
    });

    if (signUpError) {
        console.error("Signup err:", signUpError);
        return;
    }

    console.log("Logged in:", auth.user.id);

    // Create profile
    const { error: profileError } = await supabase.from('profiles').insert({
        id: auth.user.id,
        full_name: 'Test Tester',
        email: email,
        role: 'student',
        status: 'active'
    });

    if (profileError) {
        console.log("Profile err:", profileError);
    }

    console.log("Invoking edge function wolfie-brain...");
    const { data, error } = await supabase.functions.invoke('wolfie-brain', {
        body: {
            message: "hello",
            studentLevel: "A1",
            topic: "Free Conversation"
        }
    });

    console.log("Data:", data);
    console.log("Error:", error);
}

test();
