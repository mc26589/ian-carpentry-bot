import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';

// --- Environment Variables ---
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || Buffer.from('RUFBUFBlVjdMUFVBQlNhSkd2S3ppVE9RVGROYnpyTlpBNktaQ0VRZ3VJSmd4YmlmY09VaG5BZ25QZlVaQ0RBVDI0N1JEWkE2ZGJPZk9TSjFwek1ycWU1WkJrUnZvYk9SRjgyMlNPWXh5M3FEcVpDWURoQU5PVmlFS3djaEVjWUY1WkFveTJVWUlTY0RidjRqeWdUODBxaG82dDVYZXhnR1RmVUhKa3pGamJ5bHh0aGNCcm5aQUxlZTNrSkVJUlpDUUc1VkNJckFaQTN1WXpIa1pBSjJCUDl2WFNaQ2hWcEVSa0JHa0tZSXZ1cktYMUJzeklaQnR4SVpDVVQyektrTGpKVGNVZGJ6MjJWZW1mVUdNc1pCc0M4M0N3SzVhQVpEWkQ=', 'base64').toString('utf8');
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '919465727924630';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'ian_carpentry_secret_2026';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42S183X3FJMVhXLVMtaDJ0N3JHRzVuLTZaU0ZfZS1YTmRGeTJrNV9vM2EwMnc=', 'base64').toString('utf8');
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '-5472650764', 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8668769747:AAFFKofq4oKS2pXjeHrcm2mfqANCXIJbDD0';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jmftbcfdcssmxozzaqav.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptZnRiY2ZkY3NzbXhvenphcWF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTkzMDUsImV4cCI6MjA4NzE3NTMwNX0.nXRcpaAX-L15LZ62_W3fyynAFj6QEsAlma8CHa3Ne4s';

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.7-flash';
const MAX_HISTORY_MESSAGES = 16;
const WA_API_BASE = 'https://graph.facebook.com/v21.0';

// --- Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- Deduplication Cache (In-Memory + Supabase) ---
const processedMessages = new Set<string>();

// --- Types (from SKILL.md) ---

interface ChatMessage {
    role: 'user' | 'model';
    text: string;
}

interface WhatsAppMessage {
    from: string;
    id: string;
    timestamp: string;
    type: 'text' | 'interactive' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'button' | 'reaction';
    text?: { body: string };
    interactive?: {
        type: 'button_reply' | 'list_reply' | 'nfm_reply';
        button_reply?: { id: string; title: string };
        list_reply?: { id: string; title: string; description?: string };
    };
    image?: { id: string; mime_type: string; sha256?: string; caption?: string };
    audio?: { id: string; mime_type: string; voice?: boolean };
    location?: { latitude: number; longitude: number; name?: string; address?: string };
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

// --- System Instruction for Ian the Carpenter ---

const SYSTEM_INSTRUCTION = `אתה איאן (הנגר הראשי מנגריית הבוטיק "נגריית איאן").
אתה נגר מקצועי, יסודי, אדיב, ענייני ומדבר ישירות כבן אדם — לא כמו צ'אטבוט או איש מכירות רובוטי.

חוקי זהב קריטיים:
1. שאלה אחת בלבד בכל הודעה: לעולם אל תשאל שתי שאלות או רשימת שאלות. התמקד רק בפרט אחד בכל פעם (למשל: סוג הדלתות, מידות, או אזור מגורים).
2. בלי סיסמאות שיווקיות: לעולם אל תגיד "אצלנו בנגריית איאן", "אנחנו שואפים ל..." או פראזות מוגזמות. דבר ישיר: "אני יכול לבצע את זה", "עובדים בעיקר עם סנדוויץ' בירץ' ופורמייקה", "בכיף".
3. תגובות קצרות ונוחות לוואטסאפ: 1 עד 2 משפטים קצרים וממוקדים בלבד!
4. זיכרון והקשבה: קרא את כל היסטוריית השיחה. אל תשאל שוב על דברים שהלקוח כבר אמר.
5. תמונות והודעות קוליות: אם הלקוח שלח תמונה של רהיט או השראה, התייחס לסגנון שבתמונה. אם שלח הודעה קולית, ענה ישירות למה שביקש בקולו.
6. מחירים והתקדמות: אל תמציא מחיר מדויק מראש. אמור: "העלות תלויה במידות ובפרזול. כדי שאתן הצעה מדויקת וללא התחייבות, מה המידות בערך ובאיזה אזור בארץ מדובר?"`;

// --- HMAC Signature Verification (SKILL.md 2.B) ---

function verifyMetaSignature(rawBody: string | Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const signature = signatureHeader.substring(7);
    const hmac = crypto.createHmac('sha256', appSecret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest, 'hex'));
    } catch {
        return false;
    }
}

// --- Supabase DB Handlers (Permanent Memory & Leads) ---

async function loadHistory(phone: string): Promise<ChatMessage[]> {
    try {
        const { data, error } = await supabase
            .from('carpentry_messages')
            .select('role, content')
            .eq('phone', phone)
            .order('created_at', { ascending: true })
            .limit(MAX_HISTORY_MESSAGES);

        if (!error && data && data.length > 0) {
            return data.map(m => ({
                role: m.role as 'user' | 'model',
                text: m.content
            }));
        }
    } catch (err) {
        console.error('[Supabase] loadHistory error:', err);
    }
    return [];
}

async function saveMessage(phone: string, role: 'user' | 'model', text: string): Promise<void> {
    try {
        await supabase
            .from('carpentry_messages')
            .insert({ phone, role, content: text });
    } catch (err) {
        console.error('[Supabase] saveMessage error:', err);
    }
}

async function upsertLead(phone: string, customerName: string, notes?: string): Promise<void> {
    try {
        await supabase
            .from('carpentry_leads')
            .upsert({
                phone,
                customer_name: customerName,
                platform: 'whatsapp',
                notes,
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone' });
    } catch (err) {
        console.error('[Supabase] upsertLead error:', err);
    }
}

// --- WhatsApp Media Downloader (SKILL.md Section 5) ---

async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
        const metaRes = await fetch(`${WA_API_BASE}/${mediaId}`, {
            headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
        });
        const metaData = await metaRes.json();
        if (!metaData.url) return null;

        const binaryRes = await fetch(metaData.url, {
            headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
        });
        const arrayBuffer = await binaryRes.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            mimeType: metaData.mime_type || 'image/jpeg',
        };
    } catch (err) {
        console.error('[WhatsApp Media] Download error:', err);
        return null;
    }
}

// --- Outbound WhatsApp Message Senders (SKILL.md Section 4) ---

async function sendTextMessage(phoneId: string, to: string, text: string): Promise<void> {
    try {
        const res = await fetch(`${WA_API_BASE}/${phoneId}/messages`, {
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

        const resData = await res.text();
        if (!res.ok) {
            console.error(`[WhatsApp] sendMessage failed (${res.status}):`, resData);
        }
    } catch (err) {
        console.error('[WhatsApp] sendMessage exception:', err);
    }
}

async function markMessageAsRead(phoneId: string, messageId: string): Promise<void> {
    try {
        await fetch(`${WA_API_BASE}/${phoneId}/messages`, {
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

// --- Gemini AI Multi-turn & Multimodal Engine ---

function buildValidContents(history: ChatMessage[], newUserText: string, mediaAttachment?: { buffer: Buffer; mimeType: string }) {
    const normalized: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

    for (const msg of history) {
        const text = msg.text?.trim();
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

    const userParts: any[] = [];
    if (mediaAttachment) {
        userParts.push({
            inlineData: {
                data: mediaAttachment.buffer.toString('base64'),
                mimeType: mediaAttachment.mimeType
            }
        });
    }
    userParts.push({ text: newUserText || 'שלום' });

    normalized.push({ role: 'user', parts: userParts });
    return normalized;
}

async function generateIanResponse(
    history: ChatMessage[],
    userText: string,
    mediaAttachment?: { buffer: Buffer; mimeType: string }
): Promise<string> {
    try {
        const contents = buildValidContents(history, userText, mediaAttachment);
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
        return response.text?.trim() || 'שלום! איזה רהיט תרצה שנתכנן עבורך?';
    } catch (err: any) {
        console.error('[Gemini] Generation error:', err?.message || err);
        return 'בכיף, אשמח לעזור לך. ספר לי איזה רהיט אתה מעוניין לבנות ומה המידות בערך?';
    }
}

// --- Lead Reporting (Instant Telegram Alert) ---

async function sendLeadReport(phone: string, customerName: string): Promise<void> {
    if (!ADMIN_GROUP_ID || !TELEGRAM_BOT_TOKEN) return;

    try {
        const history = await loadHistory(phone);
        let report = `🪵 *ליד חדש מוואטסאפ — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${customerName}\n`;
        report += `📞 *טלפון:* [${phone}](https://wa.me/${phone}) 🎯\n`;
        report += `\n💬 *תמליל השיחה האחרונה:*\n`;

        history.slice(-8).forEach((msg, i) => {
            const label = msg.role === 'user' ? '👤 לקוח' : '🪚 איאן';
            const clean = msg.text.replace(/[*_`]/g, '');
            const t = clean.length > 120 ? clean.substring(0, 120) + '...' : clean;
            report += `${i + 1}. ${label}: ${t}\n`;
        });

        report += `\n🕐 ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_GROUP_ID,
                text: report,
                parse_mode: 'Markdown',
            }),
        });
    } catch (err) {
        console.error('[Telegram Lead Alert] Error:', err);
    }
}

// --- Webhook Controller ---

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {

    // 1. Webhook Verification (GET /webhook - SKILL.md Section 2.A)
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'] as string;
        const token = req.query['hub.verify_token'] as string;
        const challenge = req.query['hub.challenge'] as string;

        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            console.log('[WhatsApp] Webhook verified successfully');
            res.status(200).send(challenge);
        } else {
            console.error('[WhatsApp] Verification token mismatch');
            res.status(403).json({ error: 'Verification token mismatch' });
        }
        return;
    }

    // 2. Only allow POST for inbound events
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        const body: WhatsAppWebhookBody = req.body;

        if (body.object !== 'whatsapp_business_account') {
            res.status(200).json({ status: 'ignored' });
            return;
        }

        if (!body.entry || body.entry.length === 0) {
            res.status(200).json({ status: 'no_entry' });
            return;
        }

        for (const entry of body.entry) {
            for (const change of entry.changes) {
                const value = change.value;
                const incomingPhoneId = value.metadata?.phone_number_id;
                const effectivePhoneId = WHATSAPP_PHONE_NUMBER_ID || incomingPhoneId || '';

                // Ignore status callbacks (sent, delivered, read) to prevent self loops (SKILL.md 2.C)
                if (!value.messages || value.messages.length === 0) continue;

                for (const message of value.messages) {
                    const messageId = message.id;

                    // Deduplication check
                    if (processedMessages.has(messageId)) {
                        console.log(`[WhatsApp] Skipping duplicate wamid: ${messageId}`);
                        continue;
                    }
                    processedMessages.add(messageId);
                    if (processedMessages.size > 1000) {
                        const firstKey = processedMessages.values().next().value;
                        if (firstKey) processedMessages.delete(firstKey);
                    }

                    const customerPhone = message.from;
                    const customerName = value.contacts?.[0]?.profile?.name || 'לקוח';

                    // Parse inbound message types (Text, Interactive buttons, Voice notes, Images, Location)
                    let userText = '';
                    let mediaAttachment: { buffer: Buffer; mimeType: string } | undefined;

                    if (message.type === 'text' && message.text?.body) {
                        userText = message.text.body.trim();
                    } else if (message.type === 'interactive') {
                        userText = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
                    } else if (message.type === 'audio' && message.audio?.id) {
                        // Voice Note Processing (SKILL.md Section 5 & 6.4)
                        const audioData = await downloadWhatsAppMedia(message.audio.id);
                        if (audioData) {
                            mediaAttachment = audioData;
                            userText = '[הודעה קולית מהלקוח]';
                        }
                    } else if (message.type === 'image' && message.image?.id) {
                        // Image Inspiration Processing (SKILL.md Section 5)
                        const imgData = await downloadWhatsAppMedia(message.image.id);
                        if (imgData) {
                            mediaAttachment = imgData;
                            userText = message.image.caption ? `[תמונה מצורפת]: ${message.image.caption}` : '[הלקוח צירף תמונה / השראה של רהיט]';
                        }
                    } else if (message.type === 'location' && message.location) {
                        const loc = message.location;
                        userText = `[מיקום הלקוח למדידה/הובלה]: ${loc.name || loc.address || `Lat: ${loc.latitude}, Long: ${loc.longitude}`}`;
                    }

                    if (!userText && !mediaAttachment) continue;

                    console.log(`[WhatsApp Inbound] From ${customerName} (${customerPhone}): "${userText}"`);

                    // Mark as read immediately (shows blue checkmarks - SKILL.md 4.E)
                    markMessageAsRead(effectivePhoneId, messageId).catch(() => {});

                    // Load past conversation history from Supabase
                    const history = await loadHistory(customerPhone);

                    // Call Gemini AI agent
                    const aiResponse = await generateIanResponse(history, userText, mediaAttachment);
                    console.log(`[WhatsApp Reply] To ${customerPhone}: "${aiResponse}"`);

                    // Save messages to Supabase and upsert lead record
                    await Promise.all([
                        saveMessage(customerPhone, 'user', userText),
                        saveMessage(customerPhone, 'model', aiResponse),
                        upsertLead(customerPhone, customerName, userText)
                    ]);

                    // Send outbound WhatsApp reply
                    if (effectivePhoneId) {
                        await sendTextMessage(effectivePhoneId, customerPhone, aiResponse);
                    } else {
                        console.error('[WhatsApp] Missing phone number ID for outbound reply');
                    }

                    // Send lead notification to Telegram admin group
                    if (history.length >= 2 || userText.length > 20) {
                        sendLeadReport(customerPhone, customerName).catch(console.error);
                    }
                }
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('[WhatsApp Webhook Error]:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
