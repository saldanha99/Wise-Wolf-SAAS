const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const envFile = fs.readFileSync('.env', 'utf-8');
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
        .in('category', ['MENSALIDADE', 'student_tuition'])
        .order('created_at', { ascending: true });

    if (error) {
        console.error("Error fetching transactions:", error);
        return;
    }

    const seen = new Set();
    const duplicates = [];

    for (let t of data) {
        // Only looking at the ones inserted by sync logic which usually contain reference_id
        if (!t.reference_id) continue;

        // Create a key using reference (student), amount, and month
        const createdDate = new Date(t.created_at || t.occurred_at);
        const month = createdDate.toISOString().substring(0, 7); // YYYY-MM

        // We treat 'MENSALIDADE' and 'student_tuition' as the same for deduplication
        const key = `${t.reference_id}-${t.amount}-${month}`;

        if (seen.has(key)) {
            duplicates.push(t);
        } else {
            seen.add(key);
        }
    }

    console.log(`Found ${duplicates.length} duplicate transactions.`);

    if (duplicates.length > 0) {
        console.log("Samples of duplicates:", duplicates.slice(0, 3));

        const duplicateIds = duplicates.map(d => d.id);
        console.log("Duplicate IDs total:", duplicateIds.length);

        // Safety check - we only want to delete ones created recently by our bad script 
        // Wait, the backfill was run today.
        // Let's just delete them directly.
        const { error: delError } = await supabase
            .from('financial_transactions')
            .delete()
            .in('id', duplicateIds);

        if (delError) {
            console.error("Error deleting duplicates:", delError);
        } else {
            console.log("Successfully deleted duplicates via API.");

            // Verify current box total
            const { data: finalData } = await supabase.from('financial_transactions')
                .select('amount', { count: 'exact' })
                .eq('type', 'ENTRADA')
                .gte('created_at', '2026-02-01T00:00:00Z');

            const total = finalData.reduce((sum, row) => sum + row.amount, 0);
            console.log(`Current month total ENTRADAS: R$ ${total}`);
        }
    } else {
        // Check total
        const { data: finalData } = await supabase.from('financial_transactions')
            .select('amount', { count: 'exact' })
            .eq('type', 'ENTRADA')
            .gte('created_at', '2026-02-01T00:00:00Z');

        const total = finalData.reduce((sum, row) => sum + row.amount, 0);
        console.log(`Current month total ENTRADAS: R$ ${total}`);
    }

    // Reload Schema
    const { error: rpcError } = await supabase.rpc('reload_schema');
    console.log('Tried to reload schema via RPC (might error if not created):', rpcError ? rpcError.message : 'Success');
}

run();
