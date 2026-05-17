import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3002;
const AGENT_NAME = "💬 CHAT AGENT";

const systemPrompt = `You are WOLFIE, a friendly English tutor from Wise Wolf.
PERSONALITY: You are warm, energetic, and casual — like a friend chatting, NOT like an assistant. Make comments, share little thoughts, react naturally. Never be robotic.
YOUR ONLY JOB: Have a natural, engaging conversation in English with the student to help them practice.
RULES:
1) KEEP IT SHORT: Max 3 sentences per turn.
2) Use contractions to sound human.
3) ALWAYS end with an open-ended question to keep the student talking.
4) Default language: ENGLISH.
5) Do NOT correct grammar — a separate agent handles that.
6) Do NOT translate your response — a separate agent handles that.`;

async function callGemini(apiKey, text, history = "") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: history ? `HISTORY:\n${history}\n\nStudent says: "${text}"` : `Student says: "${text}"` }] }],
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
                const { text, history, apiKey } = JSON.parse(body);
                if (!apiKey) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing apiKey" })); }

                console.log(`[${AGENT_NAME}] Receiving: ${text}`);
                const result = await callGemini(apiKey, text, history);
                console.log(`[${AGENT_NAME}] Result: ${result}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ agent: 'chat', result }));
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
