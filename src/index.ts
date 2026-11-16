#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, ConfigError, MailClient, loadConfig, type ParsedMail } from './client.js';
import { extractCode, joinSubjectAndBody } from './extract_code.js';
import { htmlToText } from './html.js';

function errorToResult(e: unknown) {
    const message = e instanceof ConfigError || e instanceof ApiError
        ? e.message
        : e instanceof Error ? e.message : String(e);
    return {
        content: [{ type: 'text' as const, text: `ERROR: ${message}` }],
        isError: true,
    };
}

function summarizeMail(m: ParsedMail) {
    const preview = (m.text || (m.html ? m.html.replace(/<[^>]+>/g, ' ') : '')).replace(/\s+/g, ' ').trim().slice(0, 140);
    return {
        id: m.id,
        from: m.sender || m.source || '',
        subject: m.subject || '',
        date: m.created_at || '',
        preview,
    };
}

async function main() {
    let client: MailClient;
    try {
        client = new MailClient(loadConfig());
    } catch (e) {
        // Config errors must reach the MCP client, so emit a failing tool result
        // shape over stderr as well, then let tools report it per-call.
        process.stderr.write(`[spare-email-mcp] ${(e as Error).message}\n`);
        client = new MailClient({ baseUrl: 'https://spare.email', jwt: 'unset', lang: 'en' });
    }

    const server = new McpServer({ name: 'spare-email-mcp', version: '0.1.0' });

    server.registerTool(
        'mailbox_info',
        {
            title: 'Mailbox info',
            description: 'Return the mailbox address this server is authenticated as. Use to verify the Address JWT works.',
            inputSchema: {},
        },
        async () => {
            try {
                const info = await client.address;
                return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
            } catch (e) {
                return errorToResult(e);
            }
        }
    );

    server.registerTool(
        'list_mails',
        {
            title: 'List mails',
            description: 'List recent mails in the mailbox, newest first. Returns id, from, subject, date, and a short preview for each.',
            inputSchema: {
                limit: z.number().int().min(1).max(100).default(20).describe('How many mails to list (1-100).'),
                offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
            },
        },
        async ({ limit, offset }) => {
            try {
                const { results, count } = await client.listMails(limit, offset);
                const out = { address: (await client.address).address, total: count, mails: results.map(summarizeMail) };
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
            } catch (e) {
                return errorToResult(e);
            }
        }
    );

    server.registerTool(
        'read_mail',
        {
            title: 'Read mail',
            description: 'Read one mail in full by id (ids come from list_mails). Returns from, to, subject, date, plain-text body, and attachment metadata.',
            inputSchema: {
                id: z.number().int().positive().describe('Mail id from list_mails.'),
            },
        },
        async ({ id }) => {
            try {
                const m = await client.getMail(id);
                if (!m) {
                    return { content: [{ type: 'text', text: `ERROR: Mail ${id} not found.` }], isError: true };
                }
                let text = m.text || '';
                if (!text && m.html) {
                    text = htmlToText(m.html).replace(/\s+/g, ' ').trim();
                }
                const out = {
                    id: m.id,
                    from: m.sender || m.source || '',
                    to: m.to || '',
                    subject: m.subject || '',
                    date: m.created_at || '',
                    text,
                    attachments: (m.attachments || []).map(a => ({
                        filename: a.filename,
                        mimeType: a.mimeType,
                        size: a.size,
                    })),
                };
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
            } catch (e) {
                return errorToResult(e);
            }
        }
    );

    server.registerTool(
        'wait_for_otp',
        {
            title: 'Wait for a verification code',
            description: 'Poll the mailbox until a NEW mail arrives after this call starts, then extract the most likely verification code. Use right after triggering a signup/verification mail. Requires the mail to actually arrive; if the timeout is reached with no new mail, ask the user to check the flow.',
            inputSchema: {
                timeout_seconds: z.number().int().min(10).max(600).default(120)
                    .describe('How long to wait for a new mail (10-600 seconds).'),
                poll_seconds: z.number().int().min(3).max(30).default(4)
                    .describe('Poll interval (3-30 seconds; do not go below 3).'),
                subject_contains: z.string().optional()
                    .describe('Only consider new mails whose subject contains this text.'),
            },
        },
        async ({ timeout_seconds, poll_seconds, subject_contains }) => {
            try {
                const started = Date.now();
                // Dedupe by id: only mails that appear after this call starts count.
                const before = new Set<number>();
                try {
                    for (const m of (await client.listMails(20, 0)).results) before.add(m.id);
                } catch { /* empty mailbox or transient error: treat all as new */ }

                while (Date.now() - started < timeout_seconds * 1000) {
                    await new Promise(r => setTimeout(r, poll_seconds * 1000));
                    let fresh: ParsedMail[] = [];
                    try {
                        fresh = (await client.listMails(20, 0)).results.filter(m => !before.has(m.id));
                    } catch (e) {
                        if (e instanceof ApiError && e.status === 429) continue; // back off one cycle
                        throw e;
                    }
                    if (subject_contains) {
                        const needle = subject_contains.toLowerCase();
                        fresh = fresh.filter(m => (m.subject || '').toLowerCase().includes(needle));
                    }
                    if (fresh.length === 0) continue;

                    // Newest first; read the full body of the best candidate.
                    fresh.sort((a, b) => (b.id || 0) - (a.id || 0));
                    for (const m of fresh) {
                        try {
                            const full = await client.getMail(m.id);
                            const bodyText = full.text || (full.html ? htmlToText(full.html) : '');
                            const otp = extractCode(joinSubjectAndBody(full.subject, bodyText));
                            if (otp) {
                                return {
                                    content: [{
                                        type: 'text',
                                        text: JSON.stringify({
                                            code: otp,
                                            from: full.sender || full.source || '',
                                            subject: full.subject || '',
                                            mail_id: full.id,
                                            received_at: full.created_at || '',
                                        }, null, 2),
                                    }],
                                };
                            }
                        } catch (e) {
                            if (e instanceof ApiError && e.status === 429) break; // back off one cycle
                            throw e;
                        }
                    }
                }
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            code: null,
                            note: `No new mail arrived within ${timeout_seconds}s. If a mail was expected, the sender may be delayed or blocked, or subject_contains may have filtered it out.`,
                        }, null, 2),
                    }],
                };
            } catch (e) {
                return errorToResult(e);
            }
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(e => {
    process.stderr.write(`[spare-email-mcp] fatal: ${(e as Error).message}\n`);
    process.exit(1);
});
