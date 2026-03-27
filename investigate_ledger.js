import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const envFile = readFileSync('.env.local', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
});

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    console.log("Fetching transactions to look for duplicates...");

    const { data, error } = await supabase.from('financial_transactions')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Error fetching transactions:", error);
        return;
    }

    const seen = new Set();
    const duplicates = [];

    for (let t of data) {
        if (t.category !== 'MENSALIDADE' && t.category !== 'student_tuition') continue;

        // Create a key using reference (student), amount, and month
        const month = new Date(t.created_at || t.occurred_at).toISOString().substring(0, 7);
        const key = `${t.reference_id}-${t.amount}-${month}`;

        if (seen.has(key)) {
            duplicates.push(t);
        } else {
            seen.add(key);
        }
    }

    console.log(`Found ${duplicates.length} duplicate transactions.`);
    if (duplicates.length > 0) {
        console.log("Samples:", duplicates.slice(0, 5));

        const duplicateIds = duplicates.map(d => d.id);
        console.log("Duplicate IDs to delete:", duplicateIds.length);

        const { error: delError } = await supabase
            .from('financial_transactions')
            .delete()
            .in('id', duplicateIds);

        if (delError) {
            console.error("Error deleting duplicates:", delError);
        } else {
            console.log("Successfully deleted duplicates via API.");
        }
    }

    // Reload schema cache via REST to Supabase API
    // Using an RPC call even if it doesn't exist, just to see what we can do. 
    // Standard way is NOTIFY pgrst, "reload schema";
}

run();
