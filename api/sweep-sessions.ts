import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

// --- Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const SWEEP_SECRET = process.env.SWEEP_SECRET!;
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);

// --- Constants ---
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ACTIVE_USERS_KEY = 'active_bot_users';

// --- Types ---

interface UserSession {
    user_id: number;
    first_name: string;
    username?: string;
    messages_history: string[];
    last_activity: number;
    lead_reported?: boolean;
    lead_reported_at?: number;
}

// --- Helpers ---

function sessionKey(userId: number): string {
    return `session:${userId}`;
}

async function getSession(userId: number): Promise<UserSession | null> {
    try {
        const session = await kv.get<UserSession>(sessionKey(userId));
        return session || null;
    } catch (error) {
        console.error('[KV] Get session error:', error);
        return null;
    }
}

async function deleteSession(userId: number): Promise<void> {
    try {
        await kv.del(sessionKey(userId));
        await kv.srem(ACTIVE_USERS_KEY, userId.toString());
    } catch (error) {
        console.error('[KV] Delete session error:', error);
    }
}

async function getActiveUserIds(): Promise<number[]> {
    try {
        const members = await kv.smembers(ACTIVE_USERS_KEY);
        return members.map(m => parseInt(m, 10));
    } catch (error) {
        console.error('[KV] Get active users error:', error);
        return [];
    }
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown',
            }),
        });
        if (!res.ok) {
            const errBody = await res.text();
            console.error(`[Telegram] sendMessage failed: ${res.status} ${res.statusText}`, errBody);
            if (res.status === 400 && errBody.includes("can't parse")) {
                console.log(`[Telegram] Retrying without Markdown for chatId ${chatId}`);
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: text }),
                });
            }
        }
    } catch (error) {
        console.error('[Telegram] sendMessage exception:', error);
    }
}

async function endUserSession(userId: number): Promise<void> {
    const session = await getSession(userId);
    if (!session) return;

    // 1. If already reported during chat, clean up quietly without duplicate alerts
    if (session.lead_reported) {
        console.log(`[Sweep] User ${userId} was already reported to admin. Ending session quietly.`);
        await deleteSession(userId);
        return;
    }

    // 2. Also check persistent KV cooldown key
    const alreadyReportedInKV = await kv.get(`lead_reported_tg:${userId}`);
    if (alreadyReportedInKV) {
        console.log(`[Sweep] User ${userId} has persistent lead_reported_tg key. Ending session quietly.`);
        await deleteSession(userId);
        return;
    }

    // 3. Only send report if there are at least 2 messages (meaningful conversation, not casual ping)
    if (session.messages_history.length >= 2) {
        const userLabel = session.username ? `@${session.username}` : session.first_name;

        let report = `🪚 *ליד חדש — נגריית איאן (סיום שיחה טלגרם)*\n\n`;
        report += `👤 *שם:* ${session.first_name}\n`;
        report += `📱 *יוזר:* ${userLabel}\n`;
        report += `🆔 *User ID:* \`${session.user_id}\`\n\n`;
        report += `💬 *תמליל שיחה:*\n`;

        session.messages_history.forEach((msg, index) => {
            const truncatedMsg = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
            report += `${index + 1}. ${truncatedMsg}\n`;
        });

        report += `\n🕐 *זמן:* ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        await sendTelegramMessage(ADMIN_GROUP_ID, report);
        await kv.set(`lead_reported_tg:${userId}`, Date.now(), { ex: 86400 });
        console.log(`[Sweep] Session ended for user ${userId}, report sent to admin`);
    }

    await deleteSession(userId);
}

// --- Main Handler ---

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    if (!TELEGRAM_BOT_TOKEN || !SWEEP_SECRET) {
        console.error('[Config] Missing TELEGRAM_BOT_TOKEN or SWEEP_SECRET');
        res.status(500).json({ error: 'Server misconfigured' });
        return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized - Missing Authorization header' });
        return;
    }

    const token = authHeader.substring(7);
    if (token !== SWEEP_SECRET) {
        res.status(401).json({ error: 'Unauthorized - Invalid secret' });
        return;
    }

    try {
        console.log('[Sweep] Starting session sweep...');
        const testMode = req.query.test === 'true';
        if (testMode) {
            console.log('[Sweep] 🧪 TEST MODE: Ending ALL sessions (bypassing 10-min check)');
        }

        const activeUserIds = await getActiveUserIds();
        console.log(`[Sweep] Found ${activeUserIds.length} active users:`, activeUserIds);

        const now = Date.now();
        let endedCount = 0;

        for (const userId of activeUserIds) {
            const session = await getSession(userId);
            if (!session) {
                await kv.srem(ACTIVE_USERS_KEY, userId.toString());
                continue;
            }

            const inactiveDuration = now - session.last_activity;
            console.log(`[Sweep] User ${userId} inactive for ${Math.round(inactiveDuration / 60000)} minutes`);

            if (testMode || inactiveDuration >= INACTIVITY_TIMEOUT_MS) {
                await endUserSession(userId);
                endedCount++;
            }
        }

        console.log(`[Sweep] Completed. Ended ${endedCount} sessions.`);
        res.status(200).json({
            ok: true,
            message: `Sweep completed. Ended ${endedCount} sessions.`,
            checkedUsers: activeUserIds.length,
            endedSessions: endedCount,
        });
    } catch (error) {
        console.error('[Sweep] Unhandled error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
}
