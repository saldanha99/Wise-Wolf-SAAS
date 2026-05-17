import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3005;
const AGENT_NAME = "🧩 QUIZ AGENT";

const systemPrompt = `You are a quiz generator for English students.
YOUR ONLY JOB: Create ONE short, engaging quiz question based on the recent conversation.
Types of questions you can create:
- Fill in the blank (e.g., "She is good ___ playing chess." → at)
- Choose the correct form (e.g., "He ___ to the store." → went/goes/go)
- Identify the error
- Vocabulary meaning
- Correct preposition usage

Return ONLY a JSON object:
{
  "question": "The question text",
  "options": ["option A", "option B", "option C", "option D"],
  "correctIndex": 0,
  "explanation": "Explicação curta em português de por que essa é a resposta correta"
}
RULES:
- Always provide exactly 4 options.
- correctIndex is 0-based.`;

async function callGemini(apiKey, studentText, tutorText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: `Based on this conversation, generate a quiz:\nSTUDENT: "${studentText}"\nTUTOR: "${tutorText}"` }] }],
        generationConfig: { response_mime_type: "application/json" }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "Error";
    } finally {
        clearTimeout(timeoutId);
    }
}

const server = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    if (req.method === 'GET' && req.url === '/') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'tester.html'), 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500); return res.end('tester.html not found');
        }
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { studentText, tutorText, apiKey } = JSON.parse(body);
                if (!apiKey) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing apiKey" })); }

                console.log(`[${AGENT_NAME}] Generating quiz...`);
                const result = await callGemini(apiKey, studentText, tutorText);
                console.log(`[${AGENT_NAME}] Result: ${result}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ agent: 'quiz', result: JSON.parse(result) }));
            } catch (err) {
                res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`${AGENT_NAME} is running on http://localhost:${PORT}`);
});
