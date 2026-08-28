import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { GoogleGenAI } from '@google/genai';

// --- Environment Variables ---
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 20;
const HISTORY_TTL_SECONDS = 86400; // 24 hours
const WA_API_BASE = 'https://graph.facebook.com/v21.0';

// --- Types ---

interface ChatMessage {
    role: 'user' | 'model';
    text: string;
}

interface WhatsAppMessage {
    from: string;
    id: string;
    timestamp: string;
    type: string;
    text?: { body: string };
}

interface WhatsAppWebhookBody {
    object: string;
    entry?: Array<{
        id: string;
        changes: Array<{
            value: {
                messaging_product: string;
                metadata: { display_phone_number: string; phone_number_id: string };
                contacts?: Array<{ profile: { name: string }; wa_id: string }>;
                messages?: WhatsAppMessage[];
                statuses?: any[];
            };
            field: string;
        }>;
    }>;
}

// --- System Instructions (same persona as Telegram) ---

const SYSTEM_INSTRUCTION = `אתה איאן (או הנגר הראשי מנגריית הבוטיק "נגריית איאן").
אתה איש מקצוע אמיתי, חם, ענייני, ישיר ומדבר בגובה העיניים כבן אדם — לא כמו נציג שירות רובוטי.

חוקי זהב (קריטי):
1. שאלה אחת בלבד בכל הודעה: לעולם אל תשאל שתי שאלות או רשימת שאלות. שאל רק דבר אחד ממוקד בכל פעם (למשל: רק על המידות, או רק על סוג העץ).
2. בלי חפירות שיווקיות: לעולם אל תחזור על הביטוי "אצלנו בנגריית איאן", "אנחנו בנגריית איאן" או סיסמאות שיווקיות. דבר כנגר: "אני יכול לעשות את זה", "אנחנו עובדים עם...", "בכיף".
3. תגובות קצרות ואנושיות: 1 עד 2 משפטים קצרים בלבד! קצר, מדויק וקולע למובייל.
4. זיכרון והקשבה: קרא היטב את היסטוריית השיחה. אל תשאל שוב על דברים שהלקוח כבר ציין (כמו צבע, חומר, מידות או סוג הפרויקט).
5. מחירים: אל תמציא מחיר מראש. תגיד: "המחיר תלוי במידות ובפרזול. כדי לתת הצעה מדויקת וללא התחייבות, מה הטלפון שלך ובאיזה אזור אתה בארץ?"

זרימת שיחה טבעית:
- הלקוח פונה ⬅️ אתה מברר סוג עבודה וסגנון (בשאלה אחת קצרה).
- הלקוח עונה ⬅️ מברר מידות כלליות או חומר.
- ברגע שיש כיוון ⬅️ מציע פגישת ייעוץ ומדידה ללא עלות ומבקש טלפון ואזור.`;

// --- Global AI Client ---
const aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- Conversation History (Vercel KV) ---

function kvKey(phone: string): string {
    return `wa_history_${phone}`;
}

async function loadHistory(phone: string): Promise<ChatMessage[]> {
    try {
        const raw = await kv.get<any>(kvKey(phone));
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

async function saveHistory(phone: string, history: ChatMessage[]): Promise<void> {
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
    try {
        await kv.set(kvKey(phone), trimmed, { ex: HISTORY_TTL_SECONDS });
    } catch (error) {
        console.error('[KV] Save history error:', error);
    }
}

// --- Gemini AI ---

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
                temperature: 0.3,
                topP: 0.85,
                maxOutputTokens: 250,
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

// --- WhatsApp Cloud API Helpers ---

async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
    try {
        const url = `${WA_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'text',
                text: { preview_url: false, body: text },
            }),
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error(`[WhatsApp] sendMessage failed (${res.status}):`, errBody);
        }
    } catch (error) {
        console.error('[WhatsApp] sendMessage exception:', error);
    }
}

async function markMessageAsRead(messageId: string): Promise<void> {
    try {
        await fetch(`${WA_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
            }),
        });
    } catch {
        // Non-critical
    }
}

// --- Lead Report (sends to Telegram admin group) ---

async function sendLeadReport(phone: string, customerName: string): Promise<void> {
    if (!ADMIN_GROUP_ID || !TELEGRAM_BOT_TOKEN) return;

    try {
        const history = await loadHistory(phone);
        let report = `🪚 *ליד חדש מוואטסאפ — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${customerName}\n`;
        report += `📞 *טלפון:* \`${phone}\` 🎯\n`;
        report += `\n💬 *תמליל:*\n`;
        history.slice(-10).forEach((msg, i) => {
            const label = msg.role === 'user' ? 'לקוח' : 'נגר';
            const t = msg.text.length > 150 ? msg.text.substring(0, 150) + '...' : msg.text;
            report += `${i + 1}. ${label}: ${t}\n`;
        });
        report += `\n🕐 ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_GROUP_ID,
                text: report,
                parse_mode: 'Markdown',
            }),
        });
        console.log(`[Lead] WhatsApp lead report sent for ${phone}`);
    } catch (error) {
        console.error('[Lead] Error sending report:', error);
    }
}

// --- Deduplication (prevent processing the same message twice) ---

const PROCESSED_KEY_PREFIX = 'wa_msg_';

async function isMessageProcessed(messageId: string): Promise<boolean> {
    try {
        const exists = await kv.get(`${PROCESSED_KEY_PREFIX}${messageId}`);
        return !!exists;
    } catch {
        return false;
    }
}

async function markMessageProcessed(messageId: string): Promise<void> {
    try {
        await kv.set(`${PROCESSED_KEY_PREFIX}${messageId}`, '1', { ex: 3600 }); // 1 hour TTL
    } catch {
        // Non-critical
    }
}

// --- Main Handler ---

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {

    // --- GET: Webhook Verification ---
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'] as string;
        const token = req.query['hub.verify_token'] as string;
        const challenge = req.query['hub.challenge'] as string;

        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            console.log('[WhatsApp] Webhook verified successfully');
            res.status(200).send(challenge);
        } else {
            console.error('[WhatsApp] Webhook verification failed');
            res.status(403).send('Forbidden');
        }
        return;
    }

    // --- POST: Incoming Messages ---
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    // Always respond 200 immediately to Meta (prevent retries)
    res.status(200).json({ status: 'ok' });

    try {
        const body: WhatsAppWebhookBody = req.body;

        if (body.object !== 'whatsapp_business_account') return;
        if (!body.entry || body.entry.length === 0) return;

        for (const entry of body.entry) {
            for (const change of entry.changes) {
                const value = change.value;

                // Skip status updates (delivered, read, etc.)
                if (!value.messages || value.messages.length === 0) continue;

                for (const message of value.messages) {
                    // Only handle text messages
                    if (message.type !== 'text' || !message.text?.body) continue;

                    // Deduplication check
                    if (await isMessageProcessed(message.id)) {
                        console.log(`[WhatsApp] Skipping duplicate message: ${message.id}`);
                        continue;
                    }
                    await markMessageProcessed(message.id);

                    const customerPhone = message.from;
                    const customerName = value.contacts?.[0]?.profile?.name || 'לקוח';
                    const userText = message.text.body.trim();

                    console.log(`[WhatsApp] Message from ${customerName} (${customerPhone}): ${userText}`);

                    // Mark as read (shows blue checkmarks)
                    markMessageAsRead(message.id).catch(console.error);

                    // Load conversation history
                    const history = await loadHistory(customerPhone);

                    // Call Gemini AI
                    const aiResponse = await callGemini(history, userText);

                    // Save updated history
                    history.push({ role: 'user', text: userText });
                    history.push({ role: 'model', text: aiResponse });
                    await saveHistory(customerPhone, history);

                    // Send AI response back via WhatsApp
                    await sendWhatsAppMessage(customerPhone, aiResponse);

                    // Auto-detect phone number in message → send lead report
                    // (In WhatsApp we already have the phone, so send report after ~3 messages)
                    if (history.length >= 6) { // 3 user + 3 model messages = meaningful conversation
                        sendLeadReport(customerPhone, customerName).catch(console.error);
                    }
                }
            }
        }
    } catch (error) {
        console.error('[WhatsApp Webhook] Unhandled error:', error);
    }
}
