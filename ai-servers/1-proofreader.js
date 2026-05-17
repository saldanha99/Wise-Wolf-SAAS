import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3001;
const AGENT_NAME = "✏️ PROOFREADER AGENT";

const systemPrompt = `You are a highly skilled English language proofreader specialized in helping students.
YOUR ONLY JOB: Correct spelling, punctuation, and grammar errors in the student's English text.
RULES:
- If the text is in Portuguese, DO NOT translate it. Return "---".
- If the text has NO errors, return "---".
- If the text has errors, return ONLY a JSON object:
  {"original": "what student wrote", "corrected": "corrected version", "explanation_pt": "Explicação curta em português do erro principal"}
- Return ONLY the JSON or "---". Nothing else.`;

async function callGemini(apiKey, text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: `Proofread this: "${text}"` }] }],
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
                const { text, apiKey } = JSON.parse(body);
                if (!apiKey) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing apiKey" })); }

                console.log(`[${AGENT_NAME}] Receiving: ${text}`);
                const result = await callGemini(apiKey, text);
                console.log(`[${AGENT_NAME}] Result: ${result}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ agent: 'proofreader', result }));
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
