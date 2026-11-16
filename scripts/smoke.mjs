import { spawn } from 'node:child_process';

const BASE = process.env.SPARE_EMAIL_BASE_URL || 'http://localhost:8787';
const JWT = process.env.SPARE_EMAIL_JWT || '';
const SITE_PASSWORD = process.env.SPARE_EMAIL_SITE_PASSWORD || '';

function rpc(child, id, method, params) {
    return new Promise((resolve, reject) => {
        const onLine = (buf) => {
            for (const line of buf.toString().split('\n')) {
                if (!line.trim()) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id === id) {
                    child.stdout.off('data', onLine);
                    resolve(msg);
                }
            }
        };
        child.stdout.on('data', onLine);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { child.stdout.off('data', onLine); reject(new Error(`timeout waiting for ${method} id=${id}`)); }, 30000);
    });
}

const child = spawn('node', ['dist/index.js'], {
    cwd: '/workspaces/cloudflare_temp_email/mcp-server',
    env: { ...process.env, SPARE_EMAIL_BASE_URL: BASE, SPARE_EMAIL_JWT: JWT, SPARE_EMAIL_SITE_PASSWORD: SITE_PASSWORD },
    stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

const init = await rpc(child, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' },
});
console.log('INITIALIZE:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc(child, 2, 'tools/list', {});
const names = (list.result?.tools || []).map(t => t.name);
console.log('TOOLS:', names.join(', '));

const call = async (id, name, args) => {
    const res = await rpc(child, id, 'tools/call', { name, arguments: args });
    if (res.error) return { error: res.error };
    const text = res.result?.content?.[0]?.text;
    if (res.result?.isError) return { toolError: text };
    try { return JSON.parse(text); } catch { return { text }; }
};

console.log('MAILBOX_INFO:', JSON.stringify(await call(3, 'mailbox_info', {})));
console.log('LIST_MAILS:', JSON.stringify(await call(4, 'list_mails', { limit: 5 })).slice(0, 300));
console.log('BAD_ID_READ:', JSON.stringify(await call(5, 'read_mail', { id: 999999999 })).slice(0, 300));

child.kill();
if (stderr.trim()) console.log('STDERR:', stderr.trim());
process.exit(0);
