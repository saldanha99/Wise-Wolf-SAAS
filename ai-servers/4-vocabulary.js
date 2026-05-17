import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3004;
const AGENT_NAME = "📚 VOCABULARY AGENT";

const systemPrompt = `You are an English vocabulary and grammar analyst for B1 level students learning English (native Portuguese speakers).
YOUR ONLY JOB: Analyze the conversation exchange and extract useful vocabulary insights.
Given the STUDENT MESSAGE and the TUTOR RESPONSE, do the following:
1. Identify 1-3 KEY TERMS from the tutor's response that the student should learn.
2. For each term, provide: definition in English, difficulty level (A1-C2), 1-2 synonyms, and a short example sentence.
3. If there's a notable grammar structure in the exchange, write a 1-line note about it in Portuguese.

Return ONLY a JSON object:
{
  "keyTerms": [
    {"term": "word", "definition": "meaning", "level": "B1", "synonyms": ["syn1", "syn2"], "example": "Example sentence."}
  ],
  "grammarNote": "Nota gramatical curta em português (ou empty string se não houver)"
}`;

async function callGemini(apiKey, studentText, tutorText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: `STUDENT MESSAGE: "${studentText}"\nTUTOR RESPONSE: "${tutorText}"` }] }],
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

                console.log(`[${AGENT_NAME}] Analyzing texts...`);
                const result = await callGemini(apiKey, studentText, tutorText);
                console.log(`[${AGENT_NAME}] Result: ${result}\n`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ agent: 'vocabulary', result: JSON.parse(result) }));
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
