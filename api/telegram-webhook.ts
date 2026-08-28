import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { GoogleGenAI } from '@google/genai';

// --- Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_HISTORY_MESSAGES = 20;
const HISTORY_TTL_SECONDS = 900; // 15 minutes
const TG_MAX_LENGTH = 4096;
const ACTIVE_USERS_KEY = 'active_bot_users';

// --- Types ---

interface UserSession {
    user_id: number;
    first_name: string;
    username?: string;
    messages_history: string[];
    last_activity: number;
}

interface ChatMessage {
    role: 'user' | 'model';
    text: string;
}

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        from: {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
        };
        chat: {
            id: number;
            type: string;
        };
        date: number;
        text?: string;
    };
}

// --- System Instructions (Hebrew AI Persona — נגריית איאן) ---

const SYSTEM_INSTRUCTION = `**תפקיד:** אתה היועץ הדיגיטלי של "נגריית איאן" — נגריית בוטיק ישראלית המתמחה בעבודות עץ בהתאמה אישית: מטבחים, ארונות קיר והזזה, חיפויי קיר, מזנונים, חדרי רחצה, וריהוט מותאם.
**פרסונה:** יועץ מכירות מקצועי, חם, ידידותי ומזמין. מדבר בגובה העיניים ("אתה"). לא דוחף מכירות — בונה אמון.

**חוקי תגובה:**
1. **ECONOMY תגובות:** תמיד 1-3 משפטים קצרים וממוקדים. אל תכתוב חיבורים. תהיה תמציתי, ברור וקריא במובייל.
2. **עברית טבעית:** שפה רהוטה, נעימה ומקצועית. ללא ז'רגון טכני מיותר.
3. **ללא ברכות חוזרות:** אם כבר בירכת את הלקוח בהיסטוריית השיחה, אל תברך שוב. קפוץ ישר לעניין.
4. **ללא המצאות:** אל תמציא מחירים, זמני אספקה מדויקים או פרטים שלא נמסרו לך. אמור "ניתן לבדוק את זה בפגישת ייעוץ" אם אתה לא יודע.

**מטרת השיחה — פאנל מכירות:**
שלב 1: בירור סוג הפרויקט (מטבח? ארון? חיפוי קיר? מזנון? חדר רחצה? אחר?)
שלב 2: הבנת הצרכים (מידות כלליות, סגנון רצוי, חומרים מועדפים)
שלב 3: טיפול בשאלות והתנגדויות
שלב 4: סגירה — איסוף מספר טלפון + אזור/עיר לצורך תיאום פגישת ייעוץ ומדידה ללא התחייבות

**תחומי מומחיות — נגריית איאן:**
• **מטבחים:** תכנון מלא, עיצוב מודרני/כפרי/מינימליסטי, עם אי מטבח או בלי
• **ארונות קיר והזזה:** פתרונות אחסון חכמים, מערכות הזזה שקטות, ניצול מקסימלי של חלל
• **חיפויי קיר מעץ:** פאנלים דקורטיביים, רפידות עץ, אפקט חם ומעוצב
• **מזנונים ושידות:** לסלון, לחדר שינה, עיצוב בהתאמה אישית
• **חדרי רחצה:** ארונות אמבטיה, מדפים, שילוב עץ ולחות
• **ריהוט בהתאמה אישית:** שולחנות, ספסלים, מדפי קיר, וכל דבר שאפשר לבנות מעץ

**חומרים ופרזול:**
• עץ מלא (אלון, אגוז, ברוש), MDF, פורניר טבעי, מלמין
• פרזול פרימיום Blum (ציריות, מגירות TandemBox, מנגנוני Tip-On) — עם אחריות יצרן
• משטחי אבן, קוריאן ושיש — בשיתוף עם ספקים מובילים

**שירותים ויתרונות:**
• הדמיות תלת-ממד מלאות לפני ייצור — הלקוח רואה את התוצאה מראש
• ליווי משלב התכנון ועד ההתקנה הסופית
• התקנה מקצועית ע"י צוות הנגרייה (לא קבלני משנה)
• אחריות מלאה על כל עבודה

**טיפול בהתנגדויות:**
• "יקר" → "המחיר נגזר מהחומרים והפרזול. אנחנו עובדים עם Blum שנותן אחריות ליצרן, ועם עצים איכותיים. בפגישת הייעוץ נתאים את הפרויקט לתקציב שלך."
• "לוקח הרבה זמן" → "זמני ייצור נעים בין 3-6 שבועות בהתאם למורכבות. בפגישה ניתן לוח זמנים מדויק."
• "יש לי נגר" → "מעולה! אם בכל זאת תרצה לקבל הצעה נוספת להשוואה, אשמח לתאם פגישה קצרה. ללא התחייבות."
• "אני רק מתעניין" → "בהחלט! פגישת ייעוץ ומדידה ראשונית ללא עלות. ככה אפשר לראות מה מתאים ולקבל הצעה."

**סגירה — איסוף ליד:**
כשהלקוח מביע עניין או שואל "כמה זה עולה?" / "מתי אפשר?" / "איך מתחילים?":
→ "מעולה! כדי לתאם פגישת ייעוץ ומדידה (ללא עלות), אשמח לקבל מספר טלפון ובאיזה אזור בארץ אתה נמצא 📍"

**הנחיה קריטית:** לעולם אל תמציא מחיר. אם שואלים "כמה עולה מטבח?" ענה: "המחיר תלוי בגודל, חומרים ועיצוב. בפגישת ייעוץ ומדידה (חינם!) נכין הצעה מדויקת. מה הטלפון שלך כדי לתאם?"`;

// --- Session Management ---

function sessionKey(userId: number): string {
    return `session:${userId}`;
}

/**
 * End a user's session and send summary to admin group
 */
async function endUserSession(userId: number): Promise<void> {
    try {
        const session = await kv.get<UserSession>(sessionKey(userId));
        if (!session) return;

        // Format the conversation report
        const userLabel = session.username
            ? `@${session.username}`
            : session.first_name;

        let report = `🪚 *ליד חדש — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${session.first_name}\n`;
        report += `📱 *יוזר:* ${userLabel}\n`;
        report += `🆔 *User ID:* \`${session.user_id}\`\n\n`;
        report += `💬 *תמליל שיחה:*\n`;

        if (session.messages_history.length === 0) {
            report += `_אין הודעות_`;
        } else {
            session.messages_history.forEach((msg, index) => {
                const truncatedMsg = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
                report += `${index + 1}. ${truncatedMsg}\n`;
            });
        }

        report += `\n🕐 *זמן:* ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        // Send report to admin group
        await sendTelegramMessage(ADMIN_GROUP_ID, report);

        console.log(`[Session] Session ended for user ${userId}, report sent to admin`);

        // Clear session
        await kv.del(sessionKey(userId));
        await kv.srem(ACTIVE_USERS_KEY, userId.toString());
    } catch (error) {
        console.error('[KV] Error ending session:', error);
    }
}

/**
 * Handle incoming message — update session tracking
 */
async function handleUserMessage(userId: number, firstName: string, username: string | undefined, messageText: string): Promise<void> {
    try {
        let session = await kv.get<UserSession>(sessionKey(userId));

        if (!session) {
            // Create new session
            session = {
                user_id: userId,
                first_name: firstName,
                username: username,
                messages_history: [],
                last_activity: Date.now(),
            };
            await kv.sadd(ACTIVE_USERS_KEY, userId.toString());
        }

        // Append message to history
        session.messages_history.push(messageText);

        // Update user info and activity timestamp
        session.first_name = firstName;
        session.username = username;
        session.last_activity = Date.now();

        await kv.set(sessionKey(userId), session);
        console.log(`[Session] Session updated for user ${userId}`);
    } catch (error) {
        console.error('[KV] Error updating session:', error);
    }
}

// --- Vercel KV — Conversation History ---

function kvKey(chatId: number): string {
    return `ian_history_${chatId}`;
}

async function loadHistory(chatId: number): Promise<ChatMessage[]> {
    try {
        const history = await kv.get<ChatMessage[]>(kvKey(chatId));
        return history || [];
    } catch (error) {
        console.error('[KV] Load history error:', error);
        return [];
    }
}

async function saveHistory(chatId: number, history: ChatMessage[]): Promise<void> {
    try {
        // Keep only the last N messages to avoid bloat
        const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
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

// --- Telegram API Helpers ---

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
    // Split long messages if needed
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= TG_MAX_LENGTH) {
            chunks.push(remaining);
            break;
        }
        // Try to break at newline
        let breakPoint = remaining.lastIndexOf('\n', TG_MAX_LENGTH);
        if (breakPoint < TG_MAX_LENGTH * 0.5) {
            breakPoint = TG_MAX_LENGTH;
        }
        chunks.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
    }

    for (const chunk of chunks) {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: 'Markdown',
                }),
            });

            if (!res.ok) {
                const errBody = await res.text();
                console.error(`[Telegram] sendMessage failed (${res.status}):`, errBody);

                // Retry without Markdown if parse_mode caused an error
                if (res.status === 400 && errBody.includes("can't parse")) {
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: chunk,
                        }),
                    });
                }
            }
        } catch (error) {
            console.error('[Telegram] sendMessage exception:', error);
        }
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

// --- Main Handler ---

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    // Only accept POST requests
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    // Validate required env vars
    if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
        console.error('[Config] Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY');
        res.status(500).json({ error: 'Server misconfigured' });
        return;
    }

    try {
        const update: TelegramUpdate = req.body;

        // Extract message data
        const message = update.message;
        if (!message || !message.text) {
            // Not a text message (sticker, photo, etc.) — acknowledge
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

        // --- Inactivity Session Management (Private Chats Only) ---
        const isPrivateChat = chatType === 'private';

        // Handle /end command to manually trigger handover
        if (isPrivateChat && (userText === '/end' || userText === '/סיום')) {
            await endUserSession(userId);
            await sendTelegramMessage(chatId, '🙏 תודה על הפנייה! צוות נגריית איאן יחזור אליך בהקדם.');
            res.status(200).json({ ok: true });
            return;
        }

        // Update user session for private chats
        if (isPrivateChat) {
            await handleUserMessage(userId, firstName, username, userText);
        }

        // --- Handle /start command ---
        if (userText === '/start') {
            const welcomeMsg = `🪚 שלום ${firstName}! 👋\nברוכים הבאים לנגריית איאן — נגריית בוטיק לעבודות עץ בהתאמה אישית.\n\nמטבחים, ארונות, חיפויי קיר, מזנונים ועוד — הכל בעיצוב אישי ובחומרים מעולים.\n\nספרו לי, מה אתם מחפשים? 🪵`;
            await sendTelegramMessage(chatId, welcomeMsg);
            res.status(200).json({ ok: true });
            return;
        }

        // --- Handle /help command ---
        if (userText === '/help' || userText === '/עזרה') {
            const helpMsg = `🪚 *נגריית איאן — פקודות*\n\n/start — התחלה מחדש\n/help — תפריט עזרה\n/clear — ניקוי היסטוריית שיחה\n/end — סיום שיחה ושליחה לצוות\n\nאפשר גם פשוט לכתוב מה אתם צריכים! 🪵`;
            await sendTelegramMessage(chatId, helpMsg);
            res.status(200).json({ ok: true });
            return;
        }

        // --- Handle /clear command ---
        if (userText === '/clear' || userText === '/ניקוי') {
            await saveHistory(chatId, []);
            await sendTelegramMessage(chatId, '🧹 ההיסטוריה נמחקה. אפשר להתחיל מחדש!');
            res.status(200).json({ ok: true });
            return;
        }

        // --- Main AI flow ---

        // Show typing indicator
        await sendTelegramTypingAction(chatId);

        // Load conversation history from KV
        const history = await loadHistory(chatId);

        // Call Gemini with history + new message
        const aiResponse = await callGemini(history, userText);

        // Update history with both messages
        history.push({ role: 'user', text: userText });
        history.push({ role: 'model', text: aiResponse });

        // Save updated history to KV (resets TTL)
        await saveHistory(chatId, history);

        // Send AI response back to Telegram
        await sendTelegramMessage(chatId, aiResponse);

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[Webhook] Unhandled error:', error);
        // Always return 200 to prevent Telegram from retrying
        res.status(200).json({ ok: true, error: 'Internal error handled' });
    }
}
