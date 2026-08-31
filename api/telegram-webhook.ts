import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { GoogleGenAI } from '@google/genai';

// --- Environment Variables ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 20;
const HISTORY_TTL_SECONDS = 86400; // 24 hours — so customers can resume conversations
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

// --- System Instructions (Authentic Hebrew Carpenter Persona) ---

const SYSTEM_INSTRUCTION = `# SYSTEM PROMPT: בוט נגריית איאן

## 1. זהות ותפקיד (Role & Personality)
אתה הנציג הדיגיטלי המקצועי והאדיב של **נגריית איאן** – מומחים בנגרות אישית פרימיום, מטבחים מעוצבים, ארונות ופתרונות אחסון מתקדמים.
- **טון דיבור:** חם, סבלני, מקצועי ומזמין. שפה עברית טבעית ונעימה.
- **סגנון אינטראקציה:** שיחה קולחת ודו-כיוונית. **שאל שאלה אחת (מקסימום שתיים) בכל פעם**. לעולם אל תציף את הלקוח בשאלון ארוך או ברשימת מכולת.
- **מומחיות:** שליטה מלאה בטרנדים, חומרי חיפוי (פורמייקה, אקריליק, פורניר), פירזול מתקדם ותכנון חלל.

---

## 2. חוקי ברזל והגבלות (Strict Guardrails)
1. **הנחות ומחירים סופיים:**
   - **חל איסור מוחלט** להבטיח הנחה, מבצע או מחיר סופי/סגור בצ'אט.
   - במידת הצורך, ספק אך ורק **טווח הערכה גס** (מינימום לחומרים בסיסיים מול מקסימום לחומרי פרימיום/פירזול יוקרתי).
   - הוסף תמיד את הדיסקליימר: *"מדובר בהערכה ראשונית בלבד; המחיר המדויק נקבע בפגישה אישית ומול תוכניות ביצוע סופיות."*
2. **מועדי אספקה:**
   - התחייבות רשמית: **6 עד 8 שבועות (חודש וחצי עד חודשיים)** מרגע אישור תוכניות להורדה לביצוע (ולא מתחילת השיחה).
   - ציין תמיד כי הנגרייה עושה מאמץ לזרז כל פרויקט, אך ללא התחייבות לזמן קצר מזה.
3. **בדיקת מידע חיצוני:**
   - עבור שאלות מקצועיות ספציפיות (מותגי פירזול, גוונים ייחודיים, קטלוגים של ספקים) – בצע בדיקה עדכנית ברשת לפני מתן התשובה.
   - אם פרט מסוים אינו ודאי, אמור זאת ביושר והצע שייבדק מול הצוות בפגישה.

---

## 3. תהליך השיחה ואיסוף נתונים (Conversation Flow)

### שלב א': פתיחה ומיקוד הצורך
- קבלת הלקוח בברכה, זיהוי סוג הרהיט המבוקש (מטבח, ארון קיר, מזנון וכו').

### שלב ב': אפיון הדרגתי (דליית הנתונים הבאים בטבעיות)
אסוף את כל המידע הבא בקצב של הלקוח:
1. **מידות משוערות:** רוחב, גובה, עומק (בס"מ).
2. **מבנה ותצורה:** קו ישר, צורת ר' (L), צורת ח', אי, פינתי, ארון הזזה/פתיחה.
3. **חומרים וחיפויים:** פורמייקה (סטנדרט/ננו), ציפוי אקריליק מבריק/מט, או פורניר עץ טבעי (לגוף ולחזיתות).
4. **גוונים וצבעים:** צבע חוץ (חזיתות) מול צבע פנים (גוף/מדפים).
5. **תאורת לד:** משולבת (מתחת לארונות, בתוך מגירות, ויטרינה) או ללא תאורה.
6. **סגנון ידיות:** הסבר בקצרה על האפשרויות ועזור ללקוח לבחור:
   - *ידית חרוטה (בצבע בתנור בלבד)*
   - *ידית אינטגרלית (בקו נקי)*
   - *פרופיל במה / גולה*
   - *ידית רוכבת (אלגנטית עליונה)*
   - *ידית חיצונית מודרנית/סטנדרטית*

### שלב ג': ניתוח תמונות והשראה (במידה ונשלחו)
- אם הלקוח שלח תמונה: פרק את האלמנטים הנראים בה (גוון, סוג חומר משוער, סגנון דלתות, תאורה, פירזול).
- שאל: *"זה הכיוון המדויק שחשבת עליו, או שיש אלמנטים שהיית רוצה להתאים אחרת?"*
- השלם נתונים שלא ניתן לראות בתמונה (בעיקר מידות מדויקות).

### שלב ד': הצעת הדמיה מותאמת אישית
- רק לאחר שנאספו מרבית פרטי האפיון (סוג רהיט, חומרים/גוונים וסגנון כללי), הצע יצירת הדמיה:
  > *"יש לנו תמונה מצוינת של מה שאתה מחפש! רוצה שאכין לך הדמיה ראשונית בעיצוב אישי על בסיס הנתונים שאספנו, כדי להמחיש את הכיוון?"*
- **הפקת ההדמיה בפועל:** כאשר הלקוח מאשר ("כן", "בטח", "תכין", "רוצה לראות") או מבקש הדמיה/דוגמה (ורק כשיש מספיק נתונים על הרהיט):
  1. ענה בטקסט חם ומקצועי (למשל: *"הכנתי עבורך הדמיה ראשונית בעיצוב אישי לפי כל הפרטים שסיכמנו. איך הכיוון נראה בעיניך?"*).
  2. הוסף בסוף הודעתך את התגית הטכנית להפקת התמונה (המערכת תמיר אותה לקובץ תמונה אמיתי):
     [GENERATE_MOCKUP: An ultra-photorealistic luxury modern bespoke carpentry design of <פרטי הרהיט שנאספו: סוג הרהיט, חומרים, גוונים, ידיות, תאורת לד>, high-end architectural interior photography, elegant finish, bespoke woodwork, architectural digest, 8k resolution, photorealistic studio lighting]

### שלב ה': סגירת פנייה וליד
לאחר האפיון (וההדמיה), כדי שנוכל להעביר את הפנייה לצוות המקצועי:
1. **שם מלא** (במידה וטרם נמסר).
2. **עיר מגורים / אזור בארץ** (לצורך תיאום הגעה ומדידה).
3. **מספר טלפון ליצירת קשר** (רק אם לא ידוע).
- חתום במסר חם ומזמין: *"תודה רבה! העברתי את כל הפרטים לצוות המקצועי של נגריית איאן, ואנחנו ניצור איתך קשר בהקדם להמשך תכנון והצעת מחיר מדויקת."*`;

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
 * End a user's session and send summary to admin group
 */
async function endUserSession(userId: number, chatId?: number, firstName?: string, username?: string): Promise<void> {
    try {
        let session = await kv.get<UserSession>(sessionKey(userId));
        let messages = session?.messages_history || [];

        if (messages.length === 0 && chatId) {
            const hist = await loadHistory(chatId);
            messages = hist.map(h => `${h.role === 'user' ? 'לקוח' : 'נגר'}: ${h.text}`);
        }

        const userLabel = (session?.username || username)
            ? `@${session?.username || username}`
            : (session?.first_name || firstName || 'לקוח');

        const detectedPhone = extractPhoneFromMessages(messages);

        let report = `🪚 *ליד חדש — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${session?.first_name || firstName || 'לא צוין'}\n`;
        report += `📱 *יוזר:* ${userLabel}\n`;
        report += `🆔 *User ID:* \`${userId}\`\n`;
        if (detectedPhone) {
            report += `📞 *טלפון שנקלט:* \`${detectedPhone}\` 🎯\n`;
        }
        report += `\n💬 *תמליל השיחה:*\n`;

        if (messages.length === 0) {
            report += `_אין הודעות זמינות_\n`;
        } else {
            messages.forEach((msg, index) => {
                const truncatedMsg = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
                report += `${index + 1}. ${truncatedMsg}\n`;
            });
        }

        report += `\n🕐 *זמן:* ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        await sendTelegramMessage(ADMIN_GROUP_ID, report);
        console.log(`[Session] Lead report sent to admin group for user ${userId}`);

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

        // Auto-detect phone number: send lead report immediately but DON'T delete history
        const hasPhone = /(?:05\d[-\s]?\d{7}|0[23489][-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7})/.test(messageText);
        if (hasPhone) {
            console.log(`[Lead] Phone detected from user ${userId}, dispatching real-time lead report`);
            sendLeadReport(userId, chatId, firstName, username).catch(console.error);
        }
    } catch (error) {
        console.error('[KV] Error updating session:', error);
    }
}

/**
 * Send lead report WITHOUT deleting conversation history
 */
async function sendLeadReport(userId: number, chatId: number, firstName: string, username?: string): Promise<void> {
    try {
        const session = await kv.get<UserSession>(sessionKey(userId));
        const history = await loadHistory(chatId);
        const messages = session?.messages_history || history.map(h => `${h.role === 'user' ? 'לקוח' : 'נגר'}: ${h.text}`);
        const detectedPhone = extractPhoneFromMessages(messages);
        const userLabel = (session?.username || username) ? `@${session?.username || username}` : (firstName || 'לקוח');

        let report = `🪚 *ליד חדש — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${session?.first_name || firstName || 'לא צוין'}\n`;
        report += `📱 *יוזר:* ${userLabel}\n`;
        if (detectedPhone) report += `📞 *טלפון:* \`${detectedPhone}\` 🎯\n`;
        report += `\n💬 *תמליל:*\n`;
        messages.slice(-10).forEach((msg, i) => {
            const t = msg.length > 150 ? msg.substring(0, 150) + '...' : msg;
            report += `${i + 1}. ${t}\n`;
        });
        report += `\n🕐 ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

        await sendTelegramMessage(ADMIN_GROUP_ID, report);
        console.log(`[Lead] Report sent for user ${userId}`);
    } catch (error) {
        console.error('[Lead] Error sending report:', error);
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
                temperature: 0.3,
                topP: 0.85,
                maxOutputTokens: 500,
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
        const cleanResponseText = aiResponse.replace(/\[GENERATE_MOCKUP:\s*[^\]]+\]/gi, '').trim();

        if (mockupMatch) {
            const imagePrompt = mockupMatch[1].trim();
            console.log(`[Telegram AI Mockup Triggered] Prompt: "${imagePrompt}"`);
            const imageUrl = buildMockupImageUrl(imagePrompt);
            await sendTelegramPhoto(chatId, imageUrl, '🪵 הדמיה בעיצוב אישי - נגריית איאן');
        }

        const savedText = cleanResponseText || aiResponse;
        history.push({ role: 'user', text: userText });
        history.push({ role: 'model', text: savedText });
        await saveHistory(chatId, history);

        if (cleanResponseText) {
            await sendTelegramMessage(chatId, cleanResponseText);
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[Webhook] Unhandled error:', error);
        res.status(200).json({ ok: true, error: 'Internal error handled' });
    }
}
