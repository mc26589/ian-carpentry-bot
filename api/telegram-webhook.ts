import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

// --- Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 20;
const HISTORY_TTL_SECONDS = 86400; // 24 hours — so customers can resume conversations
const TG_MAX_LENGTH = 4096;
const ACTIVE_USERS_KEY = 'active_bot_users';

// --- Supabase Client (for cross-platform WhatsApp lead queries) ---
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

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

interface ChatMessage {
    role: 'user' | 'model';
    text: string;
}

interface TelegramReplyMessage {
    message_id: number;
    text?: string;
    caption?: string;
    from?: {
        id: number;
        first_name: string;
        is_bot?: boolean;
        username?: string;
    };
}

interface TelegramMessage {
    message_id: number;
    from: {
        id: number;
        first_name: string;
        last_name?: string;
        username?: string;
        is_bot?: boolean;
    };
    chat: {
        id: number;
        type: string;
        title?: string;
    };
    date: number;
    text?: string;
    reply_to_message?: TelegramReplyMessage;
}

interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
}

// --- System Instructions (Authentic Hebrew Carpenter Persona) ---

import { buildTelegramSystemInstruction, MAX_DAILY_MOCKUPS, MOCKUP_DAILY_LIMIT_MESSAGE } from './knowledge-base.js';

const SYSTEM_INSTRUCTION = buildTelegramSystemInstruction(null, '');

async function checkAndIncrementTelegramDailyMockups(userId: number): Promise<{ allowed: boolean; count: number }> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const key = `mockup_count:${userId}:${todayStr}`;
    try {
        const count = (await kv.get<number>(key)) || 0;
        if (count >= MAX_DAILY_MOCKUPS) {
            return { allowed: false, count };
        }
        await kv.set(key, count + 1, { ex: 86400 });
        return { allowed: true, count: count + 1 };
    } catch (err) {
        console.error('[Telegram Mockup Limit] Error:', err);
        return { allowed: true, count: 1 };
    }
}

// --- Session Management ---

function sessionKey(userId: number): string {
    return `session:${userId}`;
}

function extractPhoneFromMessages(messages: string[]): string | null {
    for (const msg of messages) {
        const match = msg.match(/(?:05\d[-\s]?\d{7}|0[23489][-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7}|\b\d{9,10}\b)/);
        if (match) return match[0];
    }
    return null;
}

/**
 * End a user's session and send summary to admin group ONLY IF NOT PREVIOUSLY REPORTED
 */
async function endUserSession(userId: number, chatId?: number, firstName?: string, username?: string): Promise<void> {
    try {
        let session = await kv.get<UserSession>(sessionKey(userId));
        
        // If this lead was already reported during the conversation, delete quietly without spamming
        if (session?.lead_reported) {
            console.log(`[Session] User ${userId} was already reported to admin. Ending session quietly.`);
            await kv.del(sessionKey(userId));
            await kv.srem(ACTIVE_USERS_KEY, userId.toString());
            return;
        }

        let messages = session?.messages_history || [];
        if (messages.length === 0 && chatId) {
            const hist = await loadHistory(chatId);
            messages = hist.map(h => `${h.role === 'user' ? 'לקוח' : 'נגר'}: ${h.text}`);
        }

        // Only send if there was meaningful interaction (more than 1 message)
        if (messages.length >= 2) {
            const userLabel = (session?.username || username)
                ? `@${session?.username || username}`
                : (session?.first_name || firstName || 'לקוח');

            const detectedPhone = extractPhoneFromMessages(messages);

            let report = `🪚 *ליד חדש — נגריית איאן (טלגרם)*\n\n`;
            report += `👤 *שם:* ${session?.first_name || firstName || 'לא צוין'}\n`;
            report += `📱 *יוזר:* ${userLabel}\n`;
            report += `🆔 *User ID:* \`${userId}\`\n`;
            if (detectedPhone) {
                report += `📞 *טלפון שנקלט:* \`${detectedPhone}\` 🎯\n`;
            }
            report += `\n💬 *תמליל השיחה:*\n`;

            messages.forEach((msg, index) => {
                const truncatedMsg = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
                report += `${index + 1}. ${truncatedMsg}\n`;
            });

            report += `\n🕐 *זמן:* ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

            await sendTelegramMessage(ADMIN_GROUP_ID, report);
            console.log(`[Session] Lead report sent to admin group for user ${userId}`);
        }

        await kv.del(sessionKey(userId));
        await kv.srem(ACTIVE_USERS_KEY, userId.toString());
    } catch (error) {
        console.error('[KV] Error ending session:', error);
    }
}

/**
 * Handle incoming message — update session tracking
 */
async function handleUserMessage(userId: number, firstName: string, username: string | undefined, messageText: string, chatId: number): Promise<void> {
    try {
        let session = await kv.get<UserSession>(sessionKey(userId));

        if (!session) {
            session = {
                user_id: userId,
                first_name: firstName,
                username: username,
                messages_history: [],
                last_activity: Date.now(),
            };
            await kv.sadd(ACTIVE_USERS_KEY, userId.toString());
        }

        session.messages_history.push(messageText);
        session.first_name = firstName;
        session.username = username;
        session.last_activity = Date.now();

        await kv.set(sessionKey(userId), session);

        // Auto-detect phone number: only send if lead has not been reported yet!
        const hasPhone = /(?:05\d[-\s]?\d{7}|0[23489][-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7})/.test(messageText);
        if (hasPhone && !session.lead_reported) {
            console.log(`[Lead] Phone detected from user ${userId}, dispatching real-time lead report`);
            sendLeadReport(userId, chatId, firstName, username, false).catch(console.error);
        }
    } catch (error) {
        console.error('[KV] Error updating session:', error);
    }
}

async function shouldSendTelegramLeadReport(userId: number, isUrgent?: boolean): Promise<boolean> {
    try {
        const leadReportedKey = `lead_reported_tg:${userId}`;
        const urgentReportedKey = `lead_urgent_tg:${userId}`;

        if (isUrgent) {
            const urgentRecentlySent = await kv.get<number>(urgentReportedKey);
            if (urgentRecentlySent) {
                console.log(`[Telegram Lead Filter] Suppressing duplicate urgent report for ${userId} (2h cooldown)`);
                return false;
            }
        } else {
            const alreadyReported = await kv.get<number>(leadReportedKey);
            if (alreadyReported) {
                console.log(`[Telegram Lead Filter] Suppressing duplicate lead report for ${userId} (24h cooldown)`);
                return false;
            }
        }
    } catch (err) {
        console.error('[Telegram Lead Filter] Error checking KV:', err);
    }
    return true;
}

/**
 * Send concise lead report with deduplication & cooldown
 */
async function sendLeadReport(userId: number, chatId: number, firstName: string, username?: string, isUrgent?: boolean, userSnippet?: string): Promise<boolean> {
    if (!ADMIN_GROUP_ID || !TELEGRAM_BOT_TOKEN) return false;

    const shouldSend = await shouldSendTelegramLeadReport(userId, isUrgent);
    if (!shouldSend) return false;

    try {
        const history = await loadHistory(chatId);
        const messages = history.map(h => `${h.role === 'user' ? 'לקוח' : 'נגר'}: ${h.text}`);
        const detectedPhone = extractPhoneFromMessages(messages);
        const userLabel = username ? `@${username}` : (firstName || 'לקוח');

        let report = isUrgent
            ? `🚨 *דחוף: לקוח מבקש שיצרו איתו קשר בהקדם! (טלגרם)* 🚨\n\n`
            : `🪚 *ליד חדש וסגור — נגריית איאן (טלגרם)* ✅\n\n`;

        report += `👤 *שם:* ${firstName || 'לא צוין'}\n`;
        report += `📱 *יוזר:* ${userLabel}\n`;
        if (detectedPhone) report += `📞 *טלפון:* \`${detectedPhone}\` 🎯\n`;
        if (isUrgent && userSnippet) {
            report += `\n💬 *הודעה:* "${userSnippet.replace(/[*_`]/g, '')}"\n`;
        }
        report += `\n🕐 ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        await sendTelegramMessage(ADMIN_GROUP_ID, report);

        // Mark reported in KV with TTL
        if (isUrgent) {
            await kv.set(`lead_urgent_tg:${userId}`, Date.now(), { ex: 7200 }); // 2 hours
        } else {
            await kv.set(`lead_reported_tg:${userId}`, Date.now(), { ex: 86400 }); // 24 hours
        }

        // Mark reported in session
        let session = await kv.get<UserSession>(sessionKey(userId));
        if (session) {
            session.lead_reported = true;
            session.lead_reported_at = Date.now();
            await kv.set(sessionKey(userId), session);
        }

        console.log(`[Telegram Lead] Report successfully sent for user ${userId} (${isUrgent ? 'urgent' : 'completed'})`);
        return true;
    } catch (error) {
        console.error('[Telegram Lead] Error sending report:', error);
        return false;
    }
}

// --- Conversation History (Vercel KV Only — stateless-safe) ---

function kvKey(chatId: number): string {
    return `ian_history_${chatId}`;
}

async function loadHistory(chatId: number): Promise<ChatMessage[]> {
    try {
        const raw = await kv.get<any>(kvKey(chatId));
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch { return []; }
        }
        return [];
    } catch (error) {
        console.error('[KV] Load history error:', error);
        return [];
    }
}

async function saveHistory(chatId: number, history: ChatMessage[]): Promise<void> {
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
    try {
        await kv.set(kvKey(chatId), trimmed, { ex: HISTORY_TTL_SECONDS });
    } catch (error) {
        console.error('[KV] Save history error:', error);
    }
}

// --- Global AI Client (instantiated once for zero latency overhead) ---
const aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function buildValidContents(history: ChatMessage[], newUserMessage: string) {
    const raw = [...history, { role: 'user' as const, text: newUserMessage }].filter(
        (m) => m && m.text && m.text.trim()
    );
    const normalized: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> = [];

    for (const msg of raw) {
        const text = msg.text.trim();
        if (!text) continue;

        if (normalized.length === 0) {
            if (msg.role === 'user') {
                normalized.push({ role: 'user', parts: [{ text }] });
            }
        } else {
            const last = normalized[normalized.length - 1];
            if (last.role === msg.role) {
                last.parts[0].text += '\n' + text;
            } else {
                normalized.push({ role: msg.role, parts: [{ text }] });
            }
        }
    }

    if (normalized.length === 0) {
        normalized.push({ role: 'user', parts: [{ text: newUserMessage.trim() || 'שלום' }] });
    }

    return normalized;
}

async function callGemini(history: ChatMessage[], userMessage: string): Promise<string> {
    const contents = buildValidContents(history, userMessage);

    try {
        const response = await aiClient.models.generateContent({
            model: GEMINI_MODEL,
            contents,
            config: {
                temperature: 0.35,
                topP: 0.85,
                maxOutputTokens: 300,
                systemInstruction: SYSTEM_INSTRUCTION,
            },
        });

        const text = response.text;
        if (!text || text.trim().length === 0) {
            return 'סליחה, לא הצלחתי לעבד את הבקשה. אפשר לנסות שוב?';
        }
        return text.trim();
    } catch (error: any) {
        console.error('[Gemini] Error:', error?.message || error);
        return 'אירעה שגיאה זמנית. אפשר לנסות שוב בבקשה?';
    }
}

// --- Telegram API Helpers ---

async function sendTelegramMessage(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= TG_MAX_LENGTH) {
            chunks.push(remaining);
            break;
        }
        let breakPoint = remaining.lastIndexOf('\n', TG_MAX_LENGTH);
        if (breakPoint < TG_MAX_LENGTH * 0.5) {
            breakPoint = TG_MAX_LENGTH;
        }
        chunks.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
    }

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Only attach reply_to_message_id to the first chunk
        const replyParam = (i === 0 && replyToMessageId) ? replyToMessageId : undefined;
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: 'Markdown',
                    reply_to_message_id: replyParam,
                }),
            });

            if (!res.ok) {
                const errBody = await res.text();
                console.error(`[Telegram] sendMessage failed (${res.status}):`, errBody);

                if (res.status === 400 && errBody.includes("can't parse")) {
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: chunk,
                            reply_to_message_id: replyParam,
                        }),
                    });
                }
            }
        } catch (error) {
            console.error('[Telegram] sendMessage exception:', error);
        }
    }
}

// --- Admin Group Copilot & Lead Intelligence Assistant ---

async function handleAdminGroupQuestion(
    chatId: number,
    messageId: number,
    adminText: string,
    replyToMessage?: TelegramReplyMessage,
    senderName?: string
): Promise<void> {
    await sendTelegramTypingAction(chatId);

    // 1. Extract context from reply_to_message or admin query
    const replyText = replyToMessage?.text || replyToMessage?.caption || '';
    const combinedSearchText = `${adminText}\n${replyText}`;

    // Extract phone if present
    const phoneMatch = combinedSearchText.match(/(?:05\d[-\s]?\d{7}|0[23489][-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7}|\b\d{9,10}\b)/);
    const targetPhone = phoneMatch ? phoneMatch[0].replace(/[-\s]/g, '') : null;

    // Extract Telegram User ID if present (e.g. `🆔 User ID: 12345678`)
    const userIdMatch = replyText.match(/User ID:\s*`?(\d+)`?/i);
    const targetUserId = userIdMatch ? parseInt(userIdMatch[1], 10) : null;

    let leadData: any = null;
    let messagesHistory: { role: string; text: string }[] = [];

    // 2. Query Supabase for WhatsApp leads
    if (supabase) {
        try {
            if (targetPhone) {
                // Fetch lead by phone
                const { data: lead } = await supabase
                    .from('carpentry_leads')
                    .select('*')
                    .or(`phone.eq.${targetPhone},phone.eq.972${targetPhone.replace(/^0/, '')},phone.eq.0${targetPhone.replace(/^972/, '')}`)
                    .maybeSingle();
                leadData = lead;

                // Fetch recent messages
                const { data: msgs } = await supabase
                    .from('carpentry_messages')
                    .select('role, content, created_at')
                    .or(`phone.eq.${targetPhone},phone.eq.972${targetPhone.replace(/^0/, '')},phone.eq.0${targetPhone.replace(/^972/, '')}`)
                    .order('created_at', { ascending: false })
                    .limit(25);

                if (msgs && msgs.length > 0) {
                    messagesHistory = msgs.reverse().map(m => ({
                        role: m.role === 'user' ? 'לקוח' : 'נגר (בוט)',
                        text: m.content
                    }));
                }
            } else {
                // If no specific phone, fetch the most recently updated lead from Supabase
                const { data: recentLeads } = await supabase
                    .from('carpentry_leads')
                    .select('*')
                    .order('updated_at', { ascending: false })
                    .limit(1);

                if (recentLeads && recentLeads.length > 0) {
                    leadData = recentLeads[0];
                    const { data: msgs } = await supabase
                        .from('carpentry_messages')
                        .select('role, content, created_at')
                        .eq('phone', leadData.phone)
                        .order('created_at', { ascending: false })
                        .limit(25);

                    if (msgs && msgs.length > 0) {
                        messagesHistory = msgs.reverse().map(m => ({
                            role: m.role === 'user' ? 'לקוח' : 'נגר (בוט)',
                            text: m.content
                        }));
                    }
                }
            }
        } catch (dbErr) {
            console.error('[Admin Query] Supabase error:', dbErr);
        }
    }

    // 3. If Telegram lead history exists in KV
    if (targetUserId && messagesHistory.length === 0) {
        const hist = await loadHistory(targetUserId);
        if (hist.length > 0) {
            messagesHistory = hist.map(h => ({
                role: h.role === 'user' ? 'לקוח' : 'נגר (בוט)',
                text: h.text
            }));
        }
    }

    // 4. Build Context for Gemini
    let leadContext = '';
    if (leadData) {
        leadContext += `\n📋 נתוני הליד מתוך ה-Database:\n`;
        leadContext += `• שם הלקוח: ${leadData.customer_name || 'לא צוין'}\n`;
        leadContext += `• טלפון: ${leadData.phone}\n`;
        leadContext += `• פלטפורמה: ${leadData.platform || 'whatsapp'}\n`;
        if (leadData.project_type) leadContext += `• סוג פרויקט: ${leadData.project_type}\n`;
        if (leadData.dimensions) leadContext += `• מידות: ${leadData.dimensions}\n`;
        if (leadData.location) leadContext += `• אזור בארץ: ${leadData.location}\n`;
        if (leadData.notes) leadContext += `• הערות ודרישות: ${leadData.notes}\n`;
        if (leadData.conversation_summary) leadContext += `• תקציר שיחה: ${leadData.conversation_summary}\n`;
        if (leadData.updated_at) leadContext += `• עדכון אחרון: ${new Date(leadData.updated_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}\n`;
    }

    if (replyText) {
        leadContext += `\n💬 הודעת הליד / ההתראה שהמנהל הגיב אליה:\n"""\n${replyText}\n"""\n`;
    }

    if (messagesHistory.length > 0) {
        leadContext += `\n📜 תמליל השיחה המלאה עם הלקוח:\n`;
        messagesHistory.forEach((m, idx) => {
            leadContext += `${idx + 1}. [${m.role}]: ${m.text}\n`;
        });
    }

    const adminSystemPrompt = `אתה העוזר הניהולי המקצועי והחכם של "נגריית איאן" בקבוצת המנהלים בטלגרם.
המנהלים/הנגרים שואלים אותך שאלות על לידים, לקוחות, שיחות שנוהלו, הצעות מחיר, חומרים ומפרטים.

תפקידך:
1. ענה ישירות, במקצועיות, בבהירות ובדיוק על שאלת המנהל (${senderName || 'המנהל'}).
2. הסתמך במדויק על נתוני הליד ותמליל השיחה המצורפים.
3. אם המנהל שואל שאלות מקצועיות/טכניות (כגון מחירי מטר רץ, קטלוגים של פורמקס/בלורן/חג סחר, גווני טמבור/נירלט, מגירות בלום או דומיסיל), ספק מידע מקצועי מדויק ממאגר הידע של הנגרייה.
4. אם חסר פרט מסוים בשיחה (למשל הלקוח עוד לא החליט על גוון או לא מסר מידה סופית), ציין זאת ביושר.

נתוני הרקע והשיחה:
${leadContext || 'לא נמצאו נתוני לקוח ספציפיים.'}
`;

    try {
        const response = await aiClient.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ role: 'user', parts: [{ text: adminText }] }],
            config: {
                temperature: 0.3,
                maxOutputTokens: 500,
                systemInstruction: adminSystemPrompt,
            }
        });

        const reply = response.text?.trim() || 'לא הצלחתי לנתח את הנתונים כרגע.';
        await sendTelegramMessage(chatId, reply, messageId);
    } catch (err) {
        console.error('[Admin Query] Gemini generation error:', err);
        await sendTelegramMessage(chatId, 'אירעה שגיאה בעיבוד השאלה על הליד.', messageId);
    }
}

async function sendTelegramTypingAction(chatId: number): Promise<void> {
    try {
        await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    action: 'typing',
                }),
            }
        );
    } catch {
        // Non-critical — ignore errors
    }
}

function buildMockupImageUrl(prompt: string): string {
    const cleanPrompt = prompt.replace(/[\r\n]+/g, ' ').replace(/[#*`_]/g, '').trim();
    const encoded = encodeURIComponent(cleanPrompt);
    const seed = Math.floor(Math.random() * 899999) + 100000;
    return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
}

async function sendTelegramPhoto(chatId: number, photoUrl: string, caption?: string): Promise<boolean> {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                photo: photoUrl,
                caption: caption || undefined,
            }),
        });
        if (!res.ok) {
            console.error(`[Telegram] sendPhoto failed (${res.status}):`, await res.text());
            return false;
        }
        return true;
    } catch (error) {
        console.error('[Telegram] sendPhoto exception:', error);
        return false;
    }
}

// --- Main Handler ---

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
        console.error('[Config] Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY');
        res.status(500).json({ error: 'Server misconfigured' });
        return;
    }

    try {
        const update: TelegramUpdate = req.body;

        const message = update.message;
        if (!message || !message.text) {
            res.status(200).json({ ok: true });
            return;
        }

        const chatId = message.chat.id;
        const chatType = message.chat.type;
        const userText = message.text.trim();
        const firstName = message.from.first_name || '';
        const username = message.from.username;
        const userId = message.from.id;

        console.log(`[Telegram] Message from ${firstName} (${chatId}): ${userText}`);

        const isPrivateChat = chatType === 'private';
        const isGroupChat = chatType === 'group' || chatType === 'supergroup' || chatId === ADMIN_GROUP_ID;

        // --- Admin Group Assistant Flow ---
        if (isGroupChat) {
            const isReplyToBot = message.reply_to_message?.from?.is_bot === true || !!message.reply_to_message;
            const isMentionOrQuestion = /@\w*bot\b/i.test(userText) || /(?:בוט|ליד|שאלה|תסכם|סכם|פרטים|כמה מטר|איזה צבע|מה הטלפון|מה הלקוח|מי הלקוח|מה הסטטוס|מה הוא רוצה|מה הוא ביקש|מה המידות|איזה חומר|כמה עולה|איזה עץ|הצעת מחיר)/i.test(userText);

            if (isReplyToBot || isMentionOrQuestion || chatId === ADMIN_GROUP_ID) {
                console.log(`[Admin Group Assistant] Query from ${firstName} in chat ${chatId}: "${userText}"`);
                await handleAdminGroupQuestion(chatId, message.message_id, userText, message.reply_to_message, firstName);
                res.status(200).json({ ok: true });
                return;
            }

            // Casual group chatter not directed to the bot
            res.status(200).json({ ok: true });
            return;
        }

        if (isPrivateChat && (userText === '/end' || userText === '/סיום')) {
            await endUserSession(userId, chatId, firstName, username);
            await sendTelegramMessage(chatId, '🙏 תודה על הפנייה! צוות נגריית איאן יחזור אליך בהקדם.');
            res.status(200).json({ ok: true });
            return;
        }

        if (isPrivateChat) {
            await handleUserMessage(userId, firstName, username, userText, chatId);
        }

        if (userText === '/start') {
            const welcomeMsg = `🪚 שלום ${firstName}! 👋\nברוכים הבאים לנגריית איאן — נגריית בוטיק לעבודות עץ בהתאמה אישית.\n\nמטבחים, ארונות, חיפויי קיר, מזנונים ועוד — הכל בעיצוב אישי ובחומרים מעולים.\n\nספרו לי, מה אתם מחפשים? 🪵`;
            await sendTelegramMessage(chatId, welcomeMsg);
            res.status(200).json({ ok: true });
            return;
        }

        if (userText === '/help' || userText === '/עזרה') {
            const helpMsg = `🪚 *נגריית איאן — פקודות*\n\n/start — התחלה מחדש\n/help — תפריט עזרה\n/clear — ניקוי היסטוריית שיחה\n/end — סיום שיחה ושליחה לצוות\n\nאפשר גם פשוט לכתוב מה אתם צריכים! 🪵`;
            await sendTelegramMessage(chatId, helpMsg);
            res.status(200).json({ ok: true });
            return;
        }

        if (userText === '/clear' || userText === '/ניקוי') {
            await saveHistory(chatId, []);
            await sendTelegramMessage(chatId, '🧹 ההיסטוריה נמחקה. אפשר להתחיל מחדש!');
            res.status(200).json({ ok: true });
            return;
        }

        // --- Main AI flow ---
        await sendTelegramTypingAction(chatId);

        const history = await loadHistory(chatId);
        const aiResponse = await callGemini(history, userText);

        const mockupMatch = aiResponse.match(/\[GENERATE_MOCKUP:\s*([^\]]+)\]/i);
        const isLeadCompleted = /\[LEAD_COMPLETED\]/i.test(aiResponse);
        const isUrgent = /(?:דחוף|בדחיפות|בהקדם האפשרי|תתקשרו אלי|תחזרו אלי דחוף|שיחזרו אלי דחוף|רוצה לדבר עם נגר)/i.test(userText);

        const cleanResponseText = aiResponse
            .replace(/\[GENERATE_MOCKUP:\s*[^\]]+\]/gi, '')
            .replace(/\[LEAD_COMPLETED\]/gi, '')
            .trim();

        if (mockupMatch) {
            const limitCheck = await checkAndIncrementTelegramDailyMockups(userId);
            if (!limitCheck.allowed) {
                console.log(`[Telegram Mockup Limit] User ${userId} reached daily limit (${limitCheck.count}/${MAX_DAILY_MOCKUPS})`);
                await sendTelegramMessage(chatId, `⚠️ ${MOCKUP_DAILY_LIMIT_MESSAGE}`);
            } else {
                const imagePrompt = mockupMatch[1].trim();
                console.log(`[Telegram AI Mockup Triggered] (${limitCheck.count}/${MAX_DAILY_MOCKUPS}) Prompt: "${imagePrompt}"`);
                const imageUrl = buildMockupImageUrl(imagePrompt);
                await sendTelegramPhoto(chatId, imageUrl, `🪵 הדמיה בעיצוב אישי (${limitCheck.count}/${MAX_DAILY_MOCKUPS}) - נגריית איאן`);
            }
        }

        const savedText = cleanResponseText || aiResponse;
        history.push({ role: 'user', text: userText });
        history.push({ role: 'model', text: savedText });
        await saveHistory(chatId, history);

        if (cleanResponseText) {
            await sendTelegramMessage(chatId, cleanResponseText);
        }

        if (isUrgent) {
            sendLeadReport(userId, chatId, firstName, username, true, userText).catch(console.error);
        } else if (isLeadCompleted) {
            sendLeadReport(userId, chatId, firstName, username, false).catch(console.error);
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[Webhook] Unhandled error:', error);
        res.status(200).json({ ok: true, error: 'Internal error handled' });
    }
}
