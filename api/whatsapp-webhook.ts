import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';

// --- Environment Variables ---
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const WHATSAPP_ACCESS_TOKEN = requireEnv('WHATSAPP_ACCESS_TOKEN');
const WHATSAPP_PHONE_NUMBER_ID = requireEnv('WHATSAPP_PHONE_NUMBER_ID');
const WHATSAPP_VERIFY_TOKEN = requireEnv('WHATSAPP_VERIFY_TOKEN');
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const GEMINI_API_KEY = requireEnv('GEMINI_API_KEY');
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || '0', 10);
const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_KEY = requireEnv('SUPABASE_KEY');

// --- Constants ---
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';
const MAX_HISTORY_MESSAGES = 25;
const WA_API_BASE = 'https://graph.facebook.com/v21.0';

// --- Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- Deduplication Cache ---
const processedMessages = new Set<string>();

// --- Types ---

interface ChatMessage {
    role: 'user' | 'model';
    text: string;
}

interface LeadProfile {
    customer_name?: string;
    project_type?: string;
    dimensions?: string;
    location?: string;
    notes?: string;
    conversation_summary?: string;
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

const BASE_SYSTEM_INSTRUCTION = `# SYSTEM PROMPT: בוט נגריית איאן

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
לאחר האפיון (וההדמיה), בקש בנימוס:
1. **עיר מגורים** (לצורך תיאום הגעה/מדידה).
2. **מספר טלפון ליצירת קשר**.
- חתום במסר חם ומזמין: *"תודה רבה! העברתי את כל הפרטים לצוות המקצועי של נגריית איאן, ואנחנו ניצור איתך קשר בהקדם להמשך תכנון והצעת מחיר מדויקת."*`;

function buildDynamicSystemInstruction(lead: LeadProfile | null, customerName: string): string {
    const facts: string[] = [];
    if (lead?.customer_name || customerName) facts.push(`שם הלקוח: ${lead?.customer_name || customerName}`);
    if (lead?.project_type) facts.push(`סוג הרהיט: ${lead.project_type}`);
    if (lead?.dimensions) facts.push(`מידות שכבר ידועות ונמסרו: ${lead.dimensions} ⚠️ (אל תשאל שוב על מידות!)`);
    if (lead?.location) facts.push(`אזור בארץ שכבר נמסר: ${lead.location} ⚠️ (אל תשאל שוב על אזור מגורים!)`);
    if (lead?.notes) facts.push(`פרטים שכבר סוכמו: ${lead.notes}`);
    if (lead?.conversation_summary) facts.push(`תקציר היסטוריה קודמת: ${lead.conversation_summary}`);

    let memoryContext = '';
    if (facts.length > 0) {
        memoryContext = `\n\n📌 כרטיס לקוח וזיכרון קבוע מה-Database (גם משיחות קודמות):\n${facts.map(f => `• ${f}`).join('\n')}\n\n⚠️ חוק ברזל: הלקוח כבר נתן את הפרטים הללו. אל תשאל עליהם שוב! השתמש בהם ישירות בתשובתך.`;
    }

    return `${BASE_SYSTEM_INSTRUCTION}${memoryContext}`;
}

// --- HMAC Signature Verification ---

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
            .order('created_at', { ascending: false }) // NEWEST FIRST
            .limit(MAX_HISTORY_MESSAGES);

        if (!error && data && data.length > 0) {
            // Reverse so oldest of the batch comes first (chronological order)
            return data.reverse().map(m => ({
                role: m.role as 'user' | 'model',
                text: m.content
            }));
        }
    } catch (err) {
        console.error('[Supabase] loadHistory error:', err);
    }
    return [];
}

async function loadLeadProfile(phone: string): Promise<LeadProfile | null> {
    try {
        const { data, error } = await supabase
            .from('carpentry_leads')
            .select('customer_name, project_type, dimensions, location, notes, conversation_summary')
            .eq('phone', phone)
            .maybeSingle();

        if (!error && data) {
            return data as LeadProfile;
        }
    } catch (err) {
        console.error('[Supabase] loadLeadProfile error:', err);
    }
    return null;
}

async function saveMessage(phone: string, role: 'user' | 'model', text: string): Promise<void> {
    try {
        const { error } = await supabase
            .from('carpentry_messages')
            .insert({ phone, role, content: text });
        if (error) {
            console.error('[Supabase] saveMessage INSERT error:', JSON.stringify(error));
        } else {
            console.log('[Supabase] saveMessage OK:', role, phone);
        }
    } catch (err) {
        console.error('[Supabase] saveMessage exception:', err);
    }
}

// --- Entity Extraction & Lead Memory Updating ---

function extractLeadEntities(text: string, existingLead: LeadProfile | null): Partial<LeadProfile> {
    const updates: Partial<LeadProfile> = {};

    // 1. Dimensions extraction (e.g., 240 על 240, 240x240, 2.40 על 2 מטר, 200/240, 10 מדפים ו-8 מגירות)
    const dimMatch = text.match(/(?:\b\d{2,3}(?:\.\d+)?\s*(?:על|X|x|\*|ס"מ|מטר|מ')\s*\d{2,3}(?:\.\d+)?(?:\s*(?:על|X|x|\*)\s*\d{2,3})?|\b(?:\d(?:\.\d+)?)\s*מטר\s*על\s*(?:\d(?:\.\d+)?)\s*מטר|\b\d+\s*מדפים\s*(?:ו-?|\+)?\s*\d+\s*מגירות)/i);
    if (dimMatch) {
        updates.dimensions = dimMatch[0].trim();
    } else if (!existingLead?.dimensions && text.match(/\b\d{2,3}\s*(?:על|X|x)\s*\d{2,3}\b/i)) {
        updates.dimensions = text.match(/\b\d{2,3}\s*(?:על|X|x)\s*\d{2,3}\b/i)![0];
    }

    // 2. Location extraction (cities, regions in Israel)
    const locationKeywords = [
        'קרית מוצקין', 'קריית מוצקין', 'מוצקין', 'קרית ביאליק', 'קריית ביאליק', 'ביאליק',
        'קרית אתא', 'קריית אתא', 'קרית ים', 'קריית ים', 'קריות', 'חיפה', 'נשר', 'טירת כרמל',
        'עכו', 'נהריה', 'כרמיאל', 'עפולה', 'נצרת', 'טבריה', 'חדרה', 'נתניה', 'כפר סבא',
        'רעננה', 'הרצליה', 'רמת השרון', 'תל אביב', 'רמת גן', 'גבעתיים', 'פתח תקווה', 'בני ברק',
        'חולון', 'בת ים', 'ראשון לציון', 'ראשל"צ', 'רחובות', 'נס ציונה', 'אשדוד', 'אשקלון',
        'באר שבע', 'מודיעין', 'ירושלים', 'צפון', 'מרכז', 'דרום', 'שרון'
    ];
    for (const loc of locationKeywords) {
        if (text.includes(loc)) {
            updates.location = loc.startsWith('מוצקין') ? 'קרית מוצקין' : (loc.startsWith('ביאליק') ? 'קרית ביאליק' : loc);
            break;
        }
    }

    // 3. Project type extraction
    const projectKeywords = [
        'ארון בגדים', 'ארון הזזה', 'ארון פתיחה', 'ארון קיר', 'ארון שירות', 'ארון',
        'מטבח', 'אי למטבח', 'מזנון', 'מזנון טלוויזיה', 'שולחן עץ', 'שולחן אוכל', 'שולחן סלון', 'שולחן',
        'חדר ארונות', 'ספריה', 'כוורת', 'שידה', 'דלתות פנים', 'דלתות הזזה', 'פרגולה', 'דק'
    ];
    for (const proj of projectKeywords) {
        if (text.includes(proj)) {
            updates.project_type = proj;
            break;
        }
    }

    return updates;
}

async function updateLeadMemory(phone: string, customerName: string, userText: string, aiResponse: string, existingLead: LeadProfile | null): Promise<void> {
    try {
        const extracted = extractLeadEntities(userText, existingLead);
        
        const finalProjectType = extracted.project_type || existingLead?.project_type || 'ריהוט בהתאמה אישית';
        const finalDimensions = extracted.dimensions || existingLead?.dimensions || null;
        const finalLocation = extracted.location || existingLead?.location || null;
        
        let summaryParts: string[] = [];
        if (finalProjectType) summaryParts.push(`פרויקט: ${finalProjectType}`);
        if (finalDimensions) summaryParts.push(`מידות: ${finalDimensions}`);
        if (finalLocation) summaryParts.push(`אזור: ${finalLocation}`);
        
        const currentSummary = summaryParts.join(' | ');

        await supabase
            .from('carpentry_leads')
            .upsert({
                phone,
                customer_name: customerName || existingLead?.customer_name || 'לקוח',
                platform: 'whatsapp',
                project_type: finalProjectType,
                dimensions: finalDimensions,
                location: finalLocation,
                notes: userText.length > 5 ? userText : existingLead?.notes,
                conversation_summary: currentSummary,
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone' });

        console.log(`[Supabase] Lead memory updated for ${phone}: ${currentSummary}`);
    } catch (err) {
        console.error('[Supabase] updateLeadMemory error:', err);
    }
}

// --- WhatsApp Media Downloader ---

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

// --- Outbound WhatsApp Message Senders ---

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

function buildMockupImageUrl(prompt: string): string {
    const cleanPrompt = prompt.replace(/[\r\n]+/g, ' ').replace(/[#*`_]/g, '').trim();
    const encoded = encodeURIComponent(cleanPrompt);
    const seed = Math.floor(Math.random() * 899999) + 100000;
    return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
}

async function sendImageMessage(phoneId: string, to: string, imageUrl: string, caption?: string): Promise<boolean> {
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
                type: 'image',
                image: {
                    link: imageUrl,
                    caption: caption || undefined,
                },
            }),
        });

        const resData = await res.text();
        if (!res.ok) {
            console.error(`[WhatsApp] sendImageMessage failed (${res.status}):`, resData);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[WhatsApp] sendImageMessage exception:', err);
        return false;
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
    lead: LeadProfile | null,
    customerName: string,
    mediaAttachment?: { buffer: Buffer; mimeType: string }
): Promise<string> {
    const contents = buildValidContents(history, userText, mediaAttachment);
    const systemInstruction = buildDynamicSystemInstruction(lead, customerName);

    try {
        const response = await aiClient.models.generateContent({
            model: GEMINI_MODEL,
            contents,
            config: {
                temperature: 0.3,
                topP: 0.85,
                maxOutputTokens: 500,
                systemInstruction,
            },
        });
        const text = response.text?.trim();
        if (text) return text;
    } catch (err: any) {
        console.error('[Gemini 3.5] Generation error:', err?.message || err);
    }

    // Fast fallback to Gemini 3.6 Flash
    try {
        const fallbackRes = await aiClient.models.generateContent({
            model: GEMINI_FALLBACK_MODEL,
            contents,
            config: {
                temperature: 0.3,
                maxOutputTokens: 500,
                systemInstruction,
            },
        });
        const text = fallbackRes.text?.trim();
        if (text) return text;
    } catch (err: any) {
        console.error('[Gemini 3.6 Fallback] error:', err?.message || err);
    }

    return 'בכיף, אשמח לעזור לך. ספר לי איזה רהיט אתה מעוניין לבנות ומה המידות בערך?';
}

// --- Lead Reporting (Instant Telegram Alert) ---

async function sendLeadReport(phone: string, customerName: string, lead: LeadProfile | null): Promise<void> {
    if (!ADMIN_GROUP_ID || !TELEGRAM_BOT_TOKEN) return;

    try {
        const history = await loadHistory(phone);
        let report = `🪵 *ליד מעודכן מוואטסאפ — נגריית איאן*\n\n`;
        report += `👤 *שם:* ${customerName}\n`;
        report += `📞 *טלפון:* [${phone}](https://wa.me/${phone}) 🎯\n`;
        if (lead?.project_type) report += `🪚 *פרויקט:* ${lead.project_type}\n`;
        if (lead?.dimensions) report += `📐 *מידות:* ${lead.dimensions}\n`;
        if (lead?.location) report += `📍 *אזור:* ${lead.location}\n`;
        
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

    // 0. Debug endpoint - tests Supabase and env vars
    if (req.method === 'GET' && req.query['debug'] === '1') {
        const dbTest = await supabase
            .from('carpentry_messages')
            .insert({ phone: 'debug_test', role: 'user', content: 'health_check_' + Date.now() })
            .select();

        res.status(200).json({
            ok: true,
            env: {
                wa_token: WHATSAPP_ACCESS_TOKEN ? WHATSAPP_ACCESS_TOKEN.substring(0, 12) + '...' : 'MISSING',
                phone_id: WHATSAPP_PHONE_NUMBER_ID,
                supabase_url: SUPABASE_URL ? SUPABASE_URL.substring(0, 35) + '...' : 'MISSING',
                supabase_key: SUPABASE_KEY ? SUPABASE_KEY.substring(0, 20) + '...' : 'MISSING',
                gemini_key: GEMINI_API_KEY ? GEMINI_API_KEY.substring(0, 10) + '...' : 'MISSING',
                tg_token: TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.substring(0, 10) + '...' : 'MISSING',
                admin_group: ADMIN_GROUP_ID,
            },
            supabase_insert: dbTest.error ? { error: dbTest.error.message, code: dbTest.error.code } : { ok: true, id: dbTest.data?.[0]?.id },
        });
        return;
    }

    // 1. Webhook Verification (GET /webhook)
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

                // Ignore status callbacks (sent, delivered, read) to prevent self loops
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
                        const audioData = await downloadWhatsAppMedia(message.audio.id);
                        if (audioData) {
                            mediaAttachment = audioData;
                            userText = '[הודעה קולית מהלקוח]';
                        }
                    } else if (message.type === 'image' && message.image?.id) {
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

                    // Mark as read immediately in parallel
                    markMessageAsRead(effectivePhoneId, messageId).catch(() => {});

                    // Load past conversation history AND permanent lead profile from Supabase in parallel
                    const [history, leadProfile] = await Promise.all([
                        loadHistory(customerPhone),
                        loadLeadProfile(customerPhone)
                    ]);

                    // Call Gemini AI agent with full persistent memory
                    const aiResponse = await generateIanResponse(history, userText, leadProfile, customerName, mediaAttachment);
                    console.log(`[WhatsApp Reply] To ${customerPhone}: "${aiResponse}"`);

                    // Check if AI generated a mockup prompt tag [GENERATE_MOCKUP: ...]
                    const mockupMatch = aiResponse.match(/\[GENERATE_MOCKUP:\s*([^\]]+)\]/i);
                    const cleanResponseText = aiResponse.replace(/\[GENERATE_MOCKUP:\s*[^\]]+\]/gi, '').trim();

                    // 1. Send outbound WhatsApp reply (Mockup Image + Text) IMMEDIATELY
                    if (effectivePhoneId) {
                        if (mockupMatch) {
                            const imagePrompt = mockupMatch[1].trim();
                            console.log(`[AI Mockup Triggered] Prompt: "${imagePrompt}"`);
                            const imageUrl = buildMockupImageUrl(imagePrompt);
                            
                            // Send mockup image first
                            await sendImageMessage(
                                effectivePhoneId,
                                customerPhone,
                                imageUrl,
                                '🪵 הדמיה בעיצוב אישי - נגריית איאן'
                            );
                            
                            // Send accompanying conversational text
                            if (cleanResponseText) {
                                await sendTextMessage(effectivePhoneId, customerPhone, cleanResponseText);
                            }
                        } else if (cleanResponseText) {
                            await sendTextMessage(effectivePhoneId, customerPhone, cleanResponseText);
                        }
                    } else {
                        console.error('[WhatsApp] Missing phone number ID for outbound reply');
                    }

                    // 2. Persist messages, update structured memory in DB, and send telegram report in parallel
                    const savedText = cleanResponseText || aiResponse;
                    const postTasks: Promise<any>[] = [
                        saveMessage(customerPhone, 'user', userText),
                        saveMessage(customerPhone, 'model', savedText),
                        updateLeadMemory(customerPhone, customerName, userText, savedText, leadProfile)
                    ];
                    if (history.length >= 2 || userText.length > 20) {
                        postTasks.push(sendLeadReport(customerPhone, customerName, leadProfile));
                    }
                    await Promise.allSettled(postTasks);
                }
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('[WhatsApp Webhook Error]:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
