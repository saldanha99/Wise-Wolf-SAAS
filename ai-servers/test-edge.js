import { createClient } from '@supabase/supabase-js';

const sb = createClient(
    'https://dvalxbtngopxopzcbfdm.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE'
);

async function test() {
    const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: 'aluno@wisewolf.com', password: '123456' });
    if (authErr) { console.log('AUTH FAIL:', authErr.message); return; }

    const token = auth.session.access_token;
    const baseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1';
    const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

    // Test 1: First greeting
    console.log('=== TEST 1: First greeting ===');
    const r1 = await fetch(baseUrl + '/wolfie-brain', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'apikey': anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello', studentLevel: 'A1', topic: 'Free Conversation', turnCount: 0 })
    });
    const d1 = await r1.json();
    console.log('Chat:', d1.chatResponse);
    console.log('Translation:', d1.translation);
    console.log('Correction:', d1.correction);
    console.log('Vocabulary:', JSON.stringify(d1.vocabulary));
    console.log('');

    // Test 2: Simulating a student with broken speech (speech recognition errors)
    console.log('=== TEST 2: Broken speech (like speech recognition) ===');
    const r2 = await fetch(baseUrl + '/wolfie-brain', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'apikey': anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: 'I go to the school yesterday and my teacher she say me that I need more practice my english because I dont speak very well',
            studentLevel: 'A2',
            topic: 'Daily Routine',
            turnCount: 3,
            previousContext: 'Wolfie: Hey! What did you do today?\nStudent: I go to school'
        })
    });
    const d2 = await r2.json();
    console.log('Chat:', d2.chatResponse);
    console.log('Translation:', d2.translation);
    console.log('Correction:', JSON.stringify(d2.correction));
    console.log('Vocabulary:', JSON.stringify(d2.vocabulary));
}

test().catch(e => console.log('FATAL:', e));
