
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.23.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- DATA: PEDAGOGICAL EVALUATIONS (Server-Side Source of Truth) ---
// Copied from constants.tsx to ensure backend validation
const PEDAGOGICAL_EVALUATIONS: Record<string, { question: string; options: string[]; correct: number }[]> = {
    'A1-1': [
        { question: "How do you say 'Oi' in English?", options: ["Bye", "Hello", "Night", "Good"], correct: 1 },
        { question: "Complete: 'I ___ a student.'", options: ["is", "are", "am", "be"], correct: 2 },
        { question: "What is the number 7?", options: ["Six", "Seven", "Eight", "Five"], correct: 1 },
        { question: "What is the opposite of 'Big'?", options: ["Large", "Small", "Tall", "Short"], correct: 1 },
        { question: "How do you ask someone's name?", options: ["How are you?", "What is your name?", "Where are you?", "Who are you?"], correct: 1 },
        { question: "What color is the sky (usually)?", options: ["Green", "Red", "Blue", "Yellow"], correct: 2 },
        { question: "Complete: 'She ___ my sister.'", options: ["am", "are", "is", "be"], correct: 2 },
        { question: "Day of the week after Monday:", options: ["Sunday", "Wednesday", "Friday", "Tuesday"], correct: 3 },
        { question: "What time is it if it's 8:00 AM?", options: ["Eight o'clock in the morning", "Eight in the night", "Noon", "Midnight"], correct: 0 },
        { question: "How do you say 'Obrigado'?", options: ["Please", "Sorry", "Thank you", "Welcome"], correct: 2 }
    ],
    'A1-2': [
        { question: "Translate 'Família' to English:", options: ["Friends", "Family", "Parents", "Group"], correct: 1 },
        { question: "Which is a member of the family?", options: ["Car", "Uncle", "School", "Blue"], correct: 1 },
        { question: "How do you say 'Pai'?", options: ["Mother", "Sister", "Father", "Brother"], correct: 2 },
        { question: "Complete: 'This is ___ book' (Posse de 'Eu')", options: ["my", "your", "his", "her"], correct: 0 },
        { question: "Routine: 'I ___ up at 7 AM.'", options: ["sleep", "go", "wake", "eat"], correct: 2 },
        { question: "Which verb describes eating in the morning?", options: ["Dinner", "Lunch", "Breakfast", "Snack"], correct: 2 },
        { question: "Complete: 'He ___ to school every day.'", options: ["go", "goes", "going", "gone"], correct: 1 },
        { question: "Translate 'Cozinha':", options: ["Bedroom", "Kitchen", "Living room", "Garden"], correct: 1 },
        { question: "What is a 'Cousin'?", options: ["Irmão", "Primo", "Tio", "Avô"], correct: 1 },
        { question: "Opposite of 'Old'?", options: ["New", "Fast", "Rich", "Young"], correct: 3 }
    ],
    'A2-1': [
        { question: "Past of 'Go'?", options: ["Goes", "Went", "Gone", "Going"], correct: 1 },
        { question: "How do you say 'Viajou'?", options: ["Travel", "Traveled", "Traveling", "Travelled"], correct: 1 },
        { question: "Which describes a 'Trip'?", options: ["Viagem", "Trabalho", "Estudo", "Dormir"], correct: 0 },
        { question: "Complete: 'I ___ a movie yesterday.'", options: ["watch", "watching", "watched", "watches"], correct: 2 },
        { question: "Directions: 'Turn ___' (Vire à direita)", options: ["Left", "Right", "Straight", "Back"], correct: 1 },
        { question: "Where do you buy bread?", options: ["Pharmacy", "Bakery", "Gym", "Cinema"], correct: 1 },
        { question: "Complete: 'Did you ___ pizza?'", options: ["eat", "ate", "eats", "eating"], correct: 0 },
        { question: "Translate 'Aeroporto':", options: ["Station", "Beach", "Airport", "Hotel"], correct: 2 },
        { question: "Which is a transport?", options: ["Apple", "Book", "Train", "Pen"], correct: 2 },
        { question: "How do you say 'Semana passada'?", options: ["Next week", "Last week", "Every week", "Today"], correct: 1 }
    ],
    'A2-2': [
        { question: "Complete: 'I have ___ to London.'", options: ["go", "went", "been", "goes"], correct: 2 },
        { question: "What is the past of 'Eat'?", options: ["Eated", "Ate", "Eaten", "Eating"], correct: 1 },
        { question: "Which word is for a professional cook?", options: ["Chef", "Teacher", "Driver", "Doctor"], correct: 0 },
        { question: "Translate 'Coração':", options: ["Head", "Hand", "Heart", "Foot"], correct: 2 },
        { question: "Which modal shows obligation?", options: ["Can", "Might", "Must", "Should"], correct: 2 },
        { question: "Complete: 'You ___ smoke here' (Proibição)", options: ["can", "should", "mustn't", "need"], correct: 2 },
        { question: "How do you say 'Amanhã'?", options: ["Yesterday", "Today", "Tomorrow", "Morning"], correct: 2 },
        { question: "What is 'Weather'?", options: ["Tempo (clima)", "Tempo (relógio)", "Dinheiro", "Rua"], correct: 0 },
        { question: "Past of 'Write'?", options: ["Writed", "Writen", "Wrote", "Writing"], correct: 2 },
        { question: "Opposite of 'Expensive'?", options: ["Cheap", "Rich", "Fast", "Hard"], correct: 0 }
    ],
    'B1-1': [
        { question: "Which tense uses 'Have/Has + Past Participle'?", options: ["Present Simple", "Past Simple", "Present Perfect", "Future"], correct: 2 },
        { question: "Translate 'Desenvolvimento':", options: ["Design", "Development", "Department", "Delivery"], correct: 1 },
        { question: "Complete: 'If it rains, I ___ stay home.'", options: ["would", "will", "did", "am"], correct: 1 },
        { question: "What does 'Nevertheless' mean?", options: ["Portanto", "No entanto", "Além disso", "Porque"], correct: 1 },
        { question: "Which is a formal way to start an email?", options: ["Hey!", "Yo!", "Dear Mr. Smith,", "Sup?"], correct: 2 },
        { question: "Complete: 'This car ___ made in Japan.'", options: ["is", "are", "have", "were"], correct: 0 },
        { question: "What is 'Reliable'?", options: ["Rápido", "Carinhoso", "Confiável", "Engraçado"], correct: 2 },
        { question: "Passive Voice: 'The cake ___ eaten by Jim.'", options: ["was", "is", "were", "been"], correct: 0 },
        { question: "Translate 'Expectativa':", options: ["Experience", "Exception", "Expectation", "Expert"], correct: 2 },
        { question: "Which is a synonym for 'Huge'?", options: ["Tiny", "Gigantic", "Small", "Regular"], correct: 1 }
    ]
};

// --- HELPER: NEXT PART LOGIC ---
const MODULE_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PARTS_PER_MODULE = 4; // Assuming 4 parts per module roughly, or just simple increment

function getNextPart(currentPart: string): string {
    if (!currentPart) return 'A1-1';

    const [mod, partStr] = currentPart.split('-');
    const part = parseInt(partStr);

    // If part < 4, just increment (e.g., A1-1 -> A1-2)
    // NOTE: In constants, A2 has only 1 part in mock, but ideally we follow standard structure.
    // If we want to be strict with Mock Data:
    // A1 goes up to 4. A2 has 1? 
    // Let's assume standard 4 parts for logic to be scalable.

    if (part < PARTS_PER_MODULE) {
        return `${mod}-${part + 1}`;
    }

    // If part >= 4, move to next module (e.g., A1-4 -> A2-1)
    const modIndex = MODULE_ORDER.indexOf(mod);
    if (modIndex >= 0 && modIndex < MODULE_ORDER.length - 1) {
        const nextMod = MODULE_ORDER[modIndex + 1];
        return `${nextMod}-1`;
    }

    // End of line
    return 'COMPLETED';
}


serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
        );

        // 1. Auth Check
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
        if (authError || !user) throw new Error('Unauthorized');

        // 2. Parse Body
        const { bookPart, answers } = await req.json();

        if (!bookPart || !answers || !Array.isArray(answers)) {
            throw new Error('Invalid input');
        }

        // 3. Validation Logic
        const quiz = PEDAGOGICAL_EVALUATIONS[bookPart];
        if (!quiz) {
            throw new Error('Quiz not found for this part');
        }

        let correctCount = 0;
        const totalQuestions = quiz.length;

        // Detailed check
        quiz.forEach((q, idx) => {
            if (answers[idx] === q.correct) {
                correctCount++;
            }
        });

        const score = correctCount;
        const percentage = (score / totalQuestions) * 100;
        const passed = percentage >= 70;

        // 4. Update Database
        const updates: any = {};
        let xpAwarded = 0;

        // Record Attempt
        await supabaseClient.from('student_evaluations').insert({
            student_id: user.id,
            book_part: bookPart,
            score: score,
            total_questions: totalQuestions,
            answers: answers,
            passed: passed,
            tenant_id: user.user_metadata?.tenant_id // Optional, helps with RLS/filtering
        });

        if (passed) {
            // Unlock Next Module
            const nextPart = getNextPart(bookPart);
            updates.current_book_part = nextPart;
            updates.evaluation_unlocked = false; // Relock until requirements met or manual open? 
            // Usually, completing a part unlocks the next book content. The exam for the NEXT part needs to be unlocked by teachers or by finishing content.
            // For now, let's just update the pointer.

            // Award XP (Server-side calculation)
            // Fetch current XP to know if level up needed? Or just atomic increment if possible.
            // RPC 'add_xp' would be best, but let's do simple read-update for now to keep it in one function.
            const { data: profile } = await supabaseClient.from('profiles').select('xp, level, module').eq('id', user.id).single();

            xpAwarded = score * 20; // 20 XP per question? Or flat bonus? Previous was 20 * score.
            const newXP = (profile?.xp || 0) + xpAwarded;

            // Simple Level Logic: XP / 1000 + 1
            const newLevel = Math.floor(newXP / 1000) + 1;

            updates.xp = newXP;
            updates.level = newLevel;

            // Also update module if we crossed a boundary?
            if (nextPart.split('-')[0] !== bookPart.split('-')[0]) {
                updates.module = nextPart.split('-')[0];
            }

            // Perform Update
            await supabaseClient.from('profiles').update(updates).eq('id', user.id);
        }

        return new Response(
            JSON.stringify({
                success: true,
                passed,
                score,
                totalQuestions,
                xpAwarded,
                nextPart: updates.current_book_part || null,
                newLevel: updates.level || null
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        });
    }
});
