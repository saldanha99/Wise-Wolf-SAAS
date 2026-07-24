const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

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
