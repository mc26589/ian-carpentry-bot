---
name: whatsapp-bot-builder
description: >-
  Builds WhatsApp bots, AI agents, and integrations using the official WhatsApp Business Cloud API (Meta Graph API).
  Use when the user wants to create a WhatsApp bot, configure webhooks, verify webhook signatures, handle incoming messages (text, media, location, interactive),
  send template messages, build interactive buttons and list menus, process media/voice notes, implement WhatsApp Flows, manage Meta permanent access tokens,
  or automate customer communication and AI workflows via WhatsApp.
  Trigger keywords: whatsapp bot, whatsapp business api, whatsapp integration, whatsapp cloud api, whatsapp template, whatsapp webhook, whatsapp automation, whatsapp chatbot, meta business, whatsapp flows, waba.
---

# WhatsApp Bot Builder Skill

Expert guide for designing, implementing, securing, and deploying WhatsApp bots and AI agents using the official **WhatsApp Business Cloud API** (Meta Graph API).

---

## 1. Core Architecture & Meta Prerequisites

### Key Identifiers & Credentials
- **`WHATSAPP_TOKEN`**: System User Permanent Access Token with permissions `whatsapp_business_messaging`, `whatsapp_business_management`.
- **`PHONE_NUMBER_ID`**: ID of the WhatsApp sender phone number (from Meta App Dashboard -> WhatsApp -> API Setup).
- **`WABA_ID`**: WhatsApp Business Account ID.
- **`WEBHOOK_VERIFY_TOKEN`**: Custom secret string configured by you to verify webhook registration (`GET /webhook`).
- **`APP_SECRET`**: Meta App Secret used to compute and verify HMAC-SHA256 signatures (`POST /webhook`).
- **Graph API Base URL**: `https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages`

### 24-Hour Messaging Window Rule
- **User-Initiated (Free-form)**: When a user sends a message, a 24-hour customer service window opens. You can send free-form text, interactive buttons, lists, and media.
- **Business-Initiated (Out-of-window)**: If 24 hours have passed since the user's last message, you **must** use pre-approved **Message Templates** (Utility, Marketing, or Authentication).

---

## 2. Webhook Implementation & Security

### A. Webhook Verification (`GET /webhook`)
Meta sends a GET request during webhook registration:
```typescript
// Query params: hub.mode, hub.verify_token, hub.challenge
if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN) {
  return res.status(200).send(req.query['hub.challenge']);
}
return res.status(403).json({ error: 'Verification token mismatch' });
```

### B. Signature Verification (`POST /webhook`)
Meta sends `X-Hub-Signature-256: sha256={hash}` calculated using `APP_SECRET` over raw request body:
```typescript
import crypto from 'node:crypto';

export function verifyMetaSignature(rawBody: string | Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const signature = signatureHeader.substring(7);
  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest, 'hex'));
}
```

### C. Fast Response Rule (Prevent Meta Retries)
- Meta requires a **`200 OK` response within 3 seconds**.
- Always respond with `200 OK` immediately, then process the payload asynchronously in background or via queue (BullMQ, Celery, Cloud Tasks, or `waitUntil`/detached promise).
- Check `entry[].changes[].value.statuses` vs `entry[].changes[].value.messages`. Ignore status updates unless tracking delivery receipts to prevent self-trigger loops.

---

## 3. Inbound Payload Parsing

### Payload Structure
```typescript
interface WhatsAppInboundPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{
      field: 'messages';
      value: {
        messaging_product: 'whatsapp';
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<WhatsAppMessage>;
        statuses?: Array<WhatsAppStatus>;
      };
    }>;
  }>;
}

type WhatsAppMessage = {
  from: string; // User's phone number e.g. "972501234567"
  id: string;   // Unique message ID e.g. "wamid.HBgL..."
  timestamp: string;
  type: 'text' | 'interactive' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'button' | 'reaction';
  text?: { body: string };
  interactive?: {
    type: 'button_reply' | 'list_reply' | 'nfm_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { response_json: string }; // WhatsApp Flows response
  };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string; voice?: boolean }; // voice notes
  document?: { id: string; filename: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
};
```

---

## 4. Sending Outbound Messages

### A. Send Plain Text Message
```typescript
async function sendTextMessage(to: string, body: string, previewUrl = false) {
  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: previewUrl, body },
    }),
  }).then(r => r.json());
}
```

### B. Send Interactive Quick Reply Buttons (Max 3 buttons)
```typescript
async function sendQuickReplyButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  headerText?: string,
  footerText?: string
) {
  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          buttons: buttons.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: { id: btn.id, title: btn.title.substring(0, 20) }, // max 20 chars
          })),
        },
      },
    }),
  }).then(r => r.json());
}
```

### C. Send Interactive List Menu (Up to 10 items)
```typescript
async function sendListMenu(
  to: string,
  bodyText: string,
  buttonLabel: string, // Button to open list e.g. "Choose Option" (max 20 chars)
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
  headerText?: string,
  footerText?: string
) {
  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          button: buttonLabel.substring(0, 20),
          sections: sections.map(s => ({
            title: s.title.substring(0, 24),
            rows: s.rows.map(r => ({
              id: r.id.substring(0, 200),
              title: r.title.substring(0, 24),
              ...(r.description ? { description: r.description.substring(0, 72) } : {}),
            })),
          })),
        },
      },
    }),
  }).then(r => r.json());
}
```

### D. Send Media (Image / Document / Audio)
```typescript
async function sendMediaMessage(
  to: string,
  type: 'image' | 'document' | 'audio' | 'video',
  mediaUrl: string,
  caption?: string,
  filename?: string
) {
  const mediaPayload: Record<string, any> = { link: mediaUrl };
  if (caption && (type === 'image' || type === 'video' || type === 'document')) mediaPayload.caption = caption;
  if (filename && type === 'document') mediaPayload.filename = filename;

  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: mediaPayload,
    }),
  }).then(r => r.json());
}
```

### E. Mark Incoming Message as Read
```typescript
async function markMessageAsRead(messageId: string) {
  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  }).then(r => r.json());
}
```

### F. Send Pre-Approved Template Message
```typescript
async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string = 'he', // or 'en_US'
  bodyParameters: string[] = []
) {
  return await fetch(`https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: bodyParameters.length > 0 ? [
          {
            type: 'body',
            parameters: bodyParameters.map(text => ({ type: 'text', text })),
          }
        ] : [],
      },
    }),
  }).then(r => r.json());
}
```

---

## 5. Media Retrieval & Voice Note Processing

When a user sends an image, document, or audio (voice message):
1. Payload contains `media_id` (e.g. `messages[0].audio.id`).
2. Query Graph API to get download URL:
   `GET https://graph.facebook.com/v21.0/{media_id}` -> Returns `{ url, mime_type, sha256, file_size }`.
3. Download binary using Bearer Auth header:
```typescript
async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // Step 1: Retrieve temporary media URL
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  const metaData = await metaRes.json();
  if (!metaData.url) throw new Error(`Failed to resolve media URL: ${JSON.stringify(metaData)}`);

  // Step 2: Download raw binary
  const binaryRes = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  const arrayBuffer = await binaryRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: metaData.mime_type,
  };
}
```

---

## 6. AI Agent Integration Pattern (State & LLM)

For building intelligent Conversational AI agents on WhatsApp:

1. **Session & State Management**: Key conversations by `from` phone number in Redis or Supabase/PostgreSQL. Store conversation history and user session metadata.
2. **Deduplication**: Store processed `wamid` for 1 hour to prevent duplicate AI responses if Meta retries.
3. **Multi-turn Context & Function Calling**:
   - Provide tools (e.g. `check_inventory`, `book_appointment`, `generate_quote`).
   - Format LLM output: If choices are few (≤ 3), send **Quick Reply Buttons**. If choices are 4-10, send **Interactive List Menu**. Otherwise send clear, formatted markdown.
4. **Voice Note Handling**:
   - Download audio (`.ogg` Opus).
   - Transcribe using Whisper / Gemini Audio API.
   - Process user query and respond in text or synthesize audio.

---

## 7. WhatsApp Flows (Form-based UI)

Use WhatsApp Flows for structured multi-step forms (e.g., lead generation, appointment booking, custom item configurator):
- **Trigger**: Sent as `interactive.type: "flow"`.
- **Payload**: Contains `flow_id`, `flow_token`, `flow_cta` (button text), and `flow_action: "navigate"`.
- **Data Exchange**: Meta sends encrypted requests to your Flow endpoint, decrypt with private key, return dynamic screen JSON, and encrypt response with AES-GCM.
- **Completion**: User submits form -> Webhook receives `interactive.type: "nfm_reply"` with `response_json`.

---

## 8. Troubleshooting & Meta Error Codes

| Error Code | Meaning | Resolution |
| :--- | :--- | :--- |
| **131030** | Recipient phone number not in allowed list | In Development Mode, phone number must be added in Meta App Dashboard under "To" numbers. |
| **131047** | Re-engagement message (24h window closed) | Must use an approved Template message (`type: 'template'`). |
| **130429** | Rate limit exceeded | Implement exponential backoff retry. Upgrade WABA tier. |
| **190** | Access token invalid or expired | Generate a permanent System User Token in Meta Business Suite. |
| **100** | Invalid parameter / Malformed JSON | Validate payload limits (buttons ≤ 20 chars, rows ≤ 10, etc.). |
