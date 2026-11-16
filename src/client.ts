export interface ClientConfig {
    baseUrl: string;
    jwt: string;
    sitePassword?: string;
    lang: string;
}

export class ConfigError extends Error { }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
    const baseUrl = (env.SPARE_EMAIL_BASE_URL || 'https://spare.email').replace(/\/+$/, '');
    const jwt = env.SPARE_EMAIL_JWT || '';
    if (!jwt) {
        throw new ConfigError(
            'SPARE_EMAIL_JWT is not set. Open the web UI, create or open a mailbox, copy the Address JWT from the settings, and set SPARE_EMAIL_JWT (and optionally SPARE_EMAIL_BASE_URL / SPARE_EMAIL_SITE_PASSWORD) in the MCP server config.'
        );
    }
    return {
        baseUrl,
        jwt,
        sitePassword: env.SPARE_EMAIL_SITE_PASSWORD || undefined,
        lang: env.SPARE_EMAIL_LANG || 'en',
    };
}

export interface MailboxInfo {
    address: string;
    sendBalance?: number;
}

export interface ParsedAttachment {
    filename: string;
    mimeType: string;
    disposition?: string;
    size: number;
}

export interface ParsedMail {
    id: number;
    source?: string;
    to?: string;
    created_at?: string;
    sender?: string;
    subject?: string;
    text?: string;
    html?: string;
    attachments?: ParsedAttachment[];
}

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageVersion = (() => {
    try {
        const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
})();

const USER_AGENT = `spare-email-mcp/${packageVersion}`;

export class MailClient {
    constructor(private readonly config: ClientConfig) { }

    get address(): Promise<MailboxInfo> {
        return this.settings();
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = {
            'Authorization': `Bearer ${this.config.jwt}`,
            'User-Agent': USER_AGENT,
            'x-lang': this.config.lang,
        };
        if (this.config.sitePassword) h['x-custom-auth'] = this.config.sitePassword;
        return h;
    }

    private async request<T>(path: string): Promise<T> {
        const res = await fetch(`${this.config.baseUrl}${path}`, { headers: this.headers() });
        if (res.status === 429) {
            throw new ApiError('Rate limited by the server (429). Slow down and retry.', 429);
        }
        let body: unknown = null;
        try { body = await res.json(); } catch { /* non-JSON error body */ }
        if (!res.ok) {
            const msg = (body as { message?: string } | null)?.message || `HTTP ${res.status}`;
            throw new ApiError(this.humanizeError(res.status, msg), res.status);
        }
        return body as T;
    }

    private humanizeError(status: number, msg: string): string {
        if (status === 401) {
            return 'Address JWT invalid or expired (or missing x-custom-auth when the site requires a site password). Open the web UI, copy a fresh Address JWT, and update SPARE_EMAIL_JWT.';
        }
        if (status === 404) {
            return `Endpoint not found on ${this.config.baseUrl} — this deployment may predate the parsed-mail API.`;
        }
        return msg;
    }

    private async settings(): Promise<MailboxInfo> {
        const s = await this.request<{ address?: string; send_balance?: number }>('/api/settings');
        if (!s?.address) {
            throw new ApiError('Server did not return an address for this JWT.', 500);
        }
        return { address: s.address, sendBalance: s.send_balance };
    }

    async listMails(limit: number, offset: number): Promise<{ results: ParsedMail[]; count: number }> {
        const data = await this.request<{ results?: ParsedMail[]; count?: number; message?: string }>(
            `/api/parsed_mails?limit=${limit}&offset=${offset}`
        );
        return { results: data.results || [], count: data.count ?? 0 };
    }

    async getMail(id: number): Promise<ParsedMail> {
        return await this.request<ParsedMail>(`/api/parsed_mail/${id}`);
    }
}
