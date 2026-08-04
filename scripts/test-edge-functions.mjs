import { createClient } from '@supabase/supabase-js';

const sb = createClient(
    (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br'),
    (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '')
);

async function test() {
    const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: 'aluno@wisewolf.com', password: '123456' });
    if (authErr) { console.log('AUTH FAIL:', authErr.message); return; }

    const token = auth.session.access_token;
    const baseUrl = `${process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br'}/functions/v1`;
    const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

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
