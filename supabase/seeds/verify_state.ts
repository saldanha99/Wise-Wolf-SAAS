
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
    console.error('Error: SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function verifyState() {
    console.log('--- VERIFYING STATE ---');

    // 1. List Auth Users
    const { data: { users }, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) console.error('Error listing users:', userError);
    else {
        console.log(`Found ${users.length} users in Auth:`);
        users.forEach(u => console.log(` - ${u.email} (ID: ${u.id})`));
    }

    // 2. List Profiles
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('*');
    if (profileError) console.error('Error listing profiles:', profileError);
    else {
        console.log(`Found ${profiles.length} profiles in Public:`);
        profiles.forEach(p => console.log(` - ${p.email} (ID: ${p.id})`));
    }
}

verifyState();
