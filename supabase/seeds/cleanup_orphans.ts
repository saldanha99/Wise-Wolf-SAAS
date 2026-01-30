
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
    console.error('Error: SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function cleanupOrphans() {
    console.log('--- CLEANING ORPHANS ---');

    // 1. Get all Auth IDs
    const { data: { users }, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) {
        console.error('Error listing users:', userError);
        return;
    }
    const authIds = new Set(users.map(u => u.id));
    console.log(`Auth Users count: ${authIds.size}`);

    // 2. Get all Profiles
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('id, email');
    if (profileError) {
        console.error('Error listing profiles:', profileError);
        return;
    }

    // 3. Find and Delete Orphans
    for (const p of profiles) {
        if (!authIds.has(p.id)) {
            console.log(`Deleting orphan profile: ${p.email} (ID: ${p.id})`);
            const { error: delError } = await supabase.from('profiles').delete().eq('id', p.id);
            if (delError) console.error(`Failed to delete ${p.id}:`, delError);
            else console.log(`Deleted.`);
        }
    }
    console.log('Cleanup finished.');
}

cleanupOrphans();
