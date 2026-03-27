import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const agents = [
    { file: '1-proofreader.js', port: 3001 },
    { file: '2-chat.js', port: 3002 },
    { file: '3-translator.js', port: 3003 },
    { file: '4-vocabulary.js', port: 3004 },
    { file: '5-quiz.js', port: 3005 }
];

console.log('🚀 Iniciando os 5 Agentes de IA isoladamente...\n');

agents.forEach(agent => {
    const child = spawn('node', [path.join(__dirname, agent.file)], {
        stdio: 'inherit' // Mostra os logs diretamente no terminal atual
    });

    child.on('error', (err) => {
        console.error(`Erro ao iniciar ${agent.file}:`, err);
    });

    child.on('exit', (code) => {
        console.log(`❌ ${agent.file} (Port ${agent.port}) parou com código ${code}`);
    });
});

console.log('✅ Todos os servidores foram iniciados.');
console.log('Para testar, você usar o arquivo tester.html ou mandar requisições POST para as portas 3001 a 3005.');
console.log('Pressione Ctrl+C para derrubar todos de uma vez.\n');
