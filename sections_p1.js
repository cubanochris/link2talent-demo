// sections_p1.js — arch, stack, setup, claude, memory, chat
window.SECTIONS = window.SECTIONS || {};

Object.assign(window.SECTIONS, {

arch: `<div class="sec-eye">Overview</div>
<div class="sec-title">System Architecture</div>
<div class="sec-sub">How all pieces connect — chat widget, SMS, and the full voice/phone pipeline end-to-end.</div>

<div class="block"><div class="block-label">Full Stack Diagram</div>
<div class="arch-box">CUSTOMER CHANNELS
  [Website Chat]      [SMS / Twilio]      [Phone Call / Twilio]
        |                    |                      |
        |                    |          Twilio Media Streams WS
        |                    |                      |
  ──────────────────────────────────────────────────────────────
  API GATEWAY  (Node.js / Express / TypeScript)
  CORS  |  Rate Limit  |  pino logging  |  Twilio Sig Validation
  ──────────────────────────────────────────────────────────────
        |                    |                      |
   POST /api/chat       POST /sms            VOICE PIPELINE
        |            (TwiML response)    Deepgram STT (Nova-3)
        |                    |                      |
        +--------------------+         Claude Sonnet (streaming)
                             |                      |
               RECEPTIONIST CORE          Cartesia TTS (40ms)
               Claude Sonnet 4.5                    |
               Tool use enabled         Twilio mulaw back to caller
               RAG context (Pinecone)
                             |
              +--------------+--------------+
         book_appointment  capture_lead  escalate_to_human
           Cal.com/GCal      HubSpot       Resend email</div></div>

<div class="block"><div class="block-label">Key design decisions</div>
<div class="info-list">
<div class="info-row ok">&#10003; <strong>Streaming-first</strong> — Claude streams tokens; voice sends audio sentence-by-sentence (~800ms perceived latency)</div>
<div class="info-row ok">&#10003; <strong>Barge-in support</strong> — Caller interrupts mid-sentence; Twilio "clear" event cuts audio instantly</div>
<div class="info-row ok">&#10003; <strong>Two-tier memory</strong> — Redis (hot, 4hr TTL) for speed + PostgreSQL (permanent) for history</div>
<div class="info-row ok">&#10003; <strong>Multi-tenant by design</strong> — Each business gets a unique widgetKey and Pinecone namespace</div>
<div class="info-row ok">&#10003; <strong>Tool use (not rules)</strong> — Claude decides when to book, capture, or escalate — no keyword matching</div>
<div class="info-row warn">&#9888; <strong>Voice latency budget</strong> — STT 200ms + Claude first token 200ms + TTS 40ms + network 200ms = ~640ms</div>
<div class="info-row warn">&#9888; <strong>Twilio raw body</strong> — Signature validation requires raw urlencoded body; parse AFTER validation</div>
</div></div>`,

stack: `<div class="sec-eye">Overview</div>
<div class="sec-title">Tech Stack</div>
<div class="sec-sub">Every service, its purpose, and what it costs at 1,000 calls/month.</div>

<div class="block"><div class="block-label">package.json dependencies</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>{
  "dependencies": {
    "express": "^4.18.2",
    "@anthropic-ai/sdk": "^0.24.0",
    "@deepgram/sdk": "^3.3.0",
    "@pinecone-database/pinecone": "^2.2.2",
    "@prisma/client": "^5.13.0",
    "@upstash/redis": "^1.31.0",
    "twilio": "^5.1.0",
    "ws": "^8.17.0",
    "resend": "^3.2.0",
    "zod": "^3.23.0",
    "express-rate-limit": "^7.3.0",
    "pino": "^9.1.0",
    "pino-http": "^10.1.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.12.0",
    "tsx": "^4.10.5",
    "prisma": "^5.13.0"
  },
  "scripts": {
    "dev":       "tsx watch src/index.ts",
    "build":     "tsc",
    "start":     "node dist/index.js",
    "db:push":   "prisma db push",
    "db:studio": "prisma studio"
  }
}</pre></div>

<div class="block"><div class="block-label">Service map and monthly cost (1,000 calls x 5 min avg)</div>
<table>
<thead><tr><th>Service</th><th>Purpose</th><th>Pricing</th><th>Est. /mo</th></tr></thead>
<tbody>
<tr><td>Railway</td><td>Node.js host + PostgreSQL</td><td>Hobby $5 + DB $5</td><td>~$15</td></tr>
<tr><td>Upstash Redis</td><td>Hot session memory</td><td>Pay-per-request</td><td>~$1</td></tr>
<tr><td>Twilio</td><td>Numbers, SMS, Media Streams</td><td>$1/number + $0.014/min</td><td>~$20</td></tr>
<tr><td>Deepgram</td><td>Speech-to-text (Nova-3)</td><td>$0.0059/min</td><td>~$30</td></tr>
<tr><td>Cartesia</td><td>Text-to-speech (streaming)</td><td>$0.0024/1K chars</td><td>~$12</td></tr>
<tr><td>Anthropic</td><td>Claude Sonnet (all channels)</td><td>$3/$15 per MTok</td><td>~$25</td></tr>
<tr><td>Pinecone</td><td>Vector RAG per business</td><td>Free up to 1 index</td><td>$0–$70</td></tr>
<tr><td>Resend</td><td>Escalation emails</td><td>Free 3K/mo</td><td>$0</td></tr>
</tbody>
</table></div>`,

setup: `<div class="sec-eye">Step 1</div>
<div class="sec-title">Project Setup</div>
<div class="sec-sub">Scaffold the TypeScript project, wire up Express with proper middleware ordering, and define the complete Prisma schema.</div>

<div class="block"><div class="block-label">Folder structure</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>src/
├── index.ts              # Express + WebSocket server entry
├── routes/
│   ├── chat.ts           # POST /api/chat
│   ├── sms.ts            # POST /sms  (Twilio webhook)
│   └── voice.ts          # POST /voice/incoming, /voice/status
├── services/
│   ├── conversation.ts   # processMessage(), handleToolCall()
│   ├── session.ts        # Redis helpers + voice session
│   ├── voiceStream.ts    # Deepgram + Cartesia WebSocket handler
│   ├── calendar.ts       # Cal.com + Google Calendar
│   ├── leads.ts          # HubSpot sync + escalation emails
│   └── knowledge.ts      # Pinecone RAG upsert + search
├── lib/
│   ├── prisma.ts          # PrismaClient singleton
│   └── redis.ts           # Upstash Redis singleton
└── middleware/
    └── twilio.ts          # Signature validation middleware</pre></div>

<div class="block"><div class="block-label">src/index.ts — server entry point</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import "dotenv/config";

import chatRouter  from "./routes/chat";
import smsRouter   from "./routes/sms";
import voiceRouter from "./routes/voice";
import { handleVoiceStream } from "./services/voiceStream";

const app = express();

// ── Middleware (order matters) ──────────────────────────────────────────────
app.use(pinoHttp());

// Twilio routes need raw urlencoded body for signature validation
const rawUrlencoded = express.raw({ type: "application/x-www-form-urlencoded" });
const parseRaw = (req: any, _res: any, next: any) => {
  req.body = Object.fromEntries(new URLSearchParams(req.body.toString()));
  next();
};
app.use("/sms",   rawUrlencoded, parseRaw);
app.use("/voice", rawUrlencoded, parseRaw);

// Chat API uses JSON
app.use("/api", express.json());
app.use("/api/", rateLimit({ windowMs: 60_000, max: 60,
  message: { error: "Rate limit exceeded — slow down" } }));

// ── Routes ──────────────────────────────────────────────────────────────────
app.use("/api/chat", chatRouter);
app.use("/sms",      smsRouter);
app.use("/voice",    voiceRouter);
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() }));

// ── HTTP + WebSocket server ─────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/voice/stream")) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", handleVoiceStream);

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => console.log("Server on port " + PORT));</pre></div>

<div class="block"><div class="block-label">prisma/schema.prisma — complete schema</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Business {
  id                    String   @id @default(cuid())
  name                  String
  widgetKey             String   @unique @default(cuid())
  systemPrompt          String?
  timezone              String   @default("America/New_York")
  plan                  String   @default("starter")  // starter | pro | enterprise
  industry              String   @default("general")  // dental|law|realestate|medspa|general
  twilioNumber          String?  @unique              // E.164: +15550001234
  escalationEmail       String?
  customPromptAdditions String?
  googleAccessToken     String?
  googleRefreshToken    String?
  calApiKey             String?
  calEventTypeId        Int?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  conversations         Conversation[]
  leads                 Lead[]
  appointments          Appointment[]
  voiceCalls            VoiceCall[]
  knowledgeItems        KnowledgeItem[]
}

model Conversation {
  id            String    @id @default(cuid())
  businessId    String
  channel       String    // "chat" | "sms" | "voice"
  sessionId     String    @unique
  status        String    @default("active")
  customerPhone String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  business      Business  @relation(fields: [businessId], references: [id])
  messages      Message[]
  @@index([businessId, createdAt])
  @@index([sessionId])
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  role           String       // "user" | "assistant"
  content        String
  createdAt      DateTime     @default(now())
  conversation   Conversation @relation(fields: [conversationId], references: [id])
}

model Lead {
  id             String   @id @default(cuid())
  businessId     String
  conversationId String?  @unique
  name           String?
  email          String?
  phone          String?
  intent         String?
  source         String   // "chat" | "sms" | "voice"
  status         String   @default("new")  // new|contacted|converted|lost
  notes          String?
  hubspotId      String?
  createdAt      DateTime @default(now())
  business       Business @relation(fields: [businessId], references: [id])
  @@index([businessId, status])
}

model Appointment {
  id             String   @id @default(cuid())
  businessId     String
  customerName   String
  customerEmail  String
  customerPhone  String?
  service        String?
  scheduledAt    DateTime
  googleEventId  String?
  calBookingUid  String?
  status         String   @default("confirmed")  // confirmed|cancelled|completed
  source         String
  createdAt      DateTime @default(now())
  business       Business @relation(fields: [businessId], references: [id])
  @@index([businessId, scheduledAt])
}

model VoiceCall {
  id              String    @id @default(cuid())
  businessId      String
  callSid         String    @unique
  from            String
  to              String
  status          String    @default("in-progress")
  durationSeconds Int?
  transcript      String?   @db.Text
  summary         String?
  resolved        Boolean   @default(false)
  escalated       Boolean   @default(false)
  createdAt       DateTime  @default(now())
  endedAt         DateTime?
  business        Business  @relation(fields: [businessId], references: [id])
  @@index([businessId, createdAt])
}

model KnowledgeItem {
  id          String   @id @default(cuid())
  businessId  String
  category    String   // hours|services|pricing|policies|faq|location
  question    String
  answer      String   @db.Text
  pineconeId  String?
  createdAt   DateTime @default(now())
  business    Business @relation(fields: [businessId], references: [id])
}</pre></div>

<div class="block"><div class="block-label">lib/prisma.ts and lib/redis.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">// lib/prisma.ts — singleton to avoid connection exhaustion in dev
import { PrismaClient } from "@prisma/client";
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// lib/redis.ts
import { Redis } from "@upstash/redis";
export const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});</pre></div>`,

claude: `<div class="sec-eye">Step 2</div>
<div class="sec-title">Claude AI Core</div>
<div class="sec-sub">The brain — processes every message through Claude with tool use. Handles booking, lead capture, and escalation decisions automatically.</div>

<div class="block"><div class="block-label">services/conversation.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { prisma } from "../lib/prisma";
import { getKnowledgeContext } from "./knowledge";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ── Tool definitions ────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "book_appointment",
    description: "Book an appointment when customer expresses intent to schedule, book, or come in.",
    input_schema: {
      type: "object" as const,
      required: ["customerName", "customerEmail", "service", "preferredTime"],
      properties: {
        customerName:  { type: "string", description: "Full name" },
        customerEmail: { type: "string", description: "Email address" },
        customerPhone: { type: "string", description: "Phone number (optional)" },
        service:       { type: "string", description: "Service or appointment type requested" },
        preferredTime: { type: "string", description: "Preferred date/time in natural language" },
      },
    },
  },
  {
    name: "capture_lead",
    description: "Capture contact info when someone is interested but not ready to book.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        name:   { type: "string" },
        email:  { type: "string" },
        phone:  { type: "string" },
        intent: { type: "string", description: "What they were interested in" },
        notes:  { type: "string", description: "Additional context" },
      },
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate when customer is upset, requests a person, has emergency, or question is outside your knowledge.",
    input_schema: {
      type: "object" as const,
      required: ["reason"],
      properties: {
        reason:  { type: "string" },
        urgency: { type: "string", enum: ["low", "medium", "high", "emergency"] },
      },
    },
  },
];

// ── Prompt builders ─────────────────────────────────────────────────────────
export function buildPrompt(business: any, ragContext: string): string {
  const base = business.systemPrompt
    ?? ("You are a friendly, professional receptionist for " + business.name + ".");
  const additions = business.customPromptAdditions
    ? "\n\n" + business.customPromptAdditions : "";
  const rag = ragContext ? "\n\nKNOWLEDGE BASE:\n" + ragContext : "";
  const now = new Date().toLocaleString("en-US", { timeZone: business.timezone });
  return base + additions + rag + "\n\nRULES:\n" +
    "- Be warm, concise, and helpful. Max 3 sentences per response.\n" +
    "- Use tools proactively — collect info and act rather than just asking questions.\n" +
    "- Never make up information about the business. Escalate if unsure.\n" +
    "- Current date/time: " + now;
}

export function buildVoicePrompt(business: any, ragContext: string): string {
  return buildPrompt(business, ragContext) +
    "\n\nVOICE RULES (phone call):\n" +
    "- Keep responses under 2 sentences. Brevity is critical on phone.\n" +
    "- Speak numbers: say 'two thirty PM' not '2:30 PM'.\n" +
    "- Never use markdown, bullets, or symbols. Spoken word only.\n" +
    "- Ask only ONE question at a time.";
}

// ── Core message processor ──────────────────────────────────────────────────
export async function processMessage(
  business: any,
  history: Anthropic.MessageParam[],
  userMessage: string,
  channel: "chat" | "sms" | "voice"
): Promise<{ message: string; toolCall: any | null }> {
  const ragContext = await getKnowledgeContext(business.id, userMessage);
  const systemPrompt = channel === "voice"
    ? buildVoicePrompt(business, ragContext)
    : buildPrompt(business, ragContext);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: channel === "voice" ? 200 : 1024,
    system: systemPrompt,
    tools: TOOLS,
    messages: [...history, { role: "user", content: userMessage }],
  });

  const toolBlock = response.content.find(b => b.type === "tool_use") as
    Anthropic.ToolUseBlock | undefined;
  if (toolBlock) {
    return { message: "", toolCall: { name: toolBlock.name, input: toolBlock.input, id: toolBlock.id } };
  }
  const textBlock = response.content.find(b => b.type === "text") as
    Anthropic.TextBlock | undefined;
  return {
    message: textBlock?.text ?? "I'm sorry, I didn't catch that. Could you repeat?",
    toolCall: null,
  };
}

// ── Tool executor ───────────────────────────────────────────────────────────
export async function handleToolCall(
  toolCall: { name: string; input: any },
  business: any,
  customerPhone: string | null,
  source: "chat" | "sms" | "voice"
): Promise<string> {
  const { name, input } = toolCall;

  if (name === "book_appointment") {
    const { bookAppointment } = await import("./calendar");
    const result = await bookAppointment(business, input);
    return result.success
      ? "I've booked your " + input.service + " for " + result.confirmedTime +
        ". A confirmation will be sent to " + input.customerEmail + "."
      : "I wasn't able to complete the booking online. Someone from our team will reach out to confirm.";
  }

  if (name === "capture_lead") {
    const { saveLead } = await import("./leads");
    await saveLead(business.id, { ...input, source, phone: input.phone ?? customerPhone });
    return "Thank you " + (input.name ?? "so much") + "! I've noted your interest in " +
      (input.intent ?? "our services") + ". Our team will follow up with you soon.";
  }

  if (name === "escalate_to_human") {
    const { sendEscalationEmail } = await import("./leads");
    if (business.escalationEmail) {
      sendEscalationEmail(business, input.reason, input.urgency, customerPhone).catch(console.error);
    }
    const isUrgent = input.urgency === "high" || input.urgency === "emergency";
    return isUrgent
      ? "I'm flagging this as urgent and alerting our team right now. Someone will be with you shortly."
      : "I've notified our team and they'll follow up with you soon. Is there anything else I can help with?";
  }

  return "I encountered an issue. Let me get someone to help you directly.";
}

// ── Twilio signature validation ─────────────────────────────────────────────
export function validateTwilioRequest(req: any): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const signature = req.headers["x-twilio-signature"] as string ?? "";
  const url = process.env.BASE_URL + req.originalUrl;
  return twilio.validateRequest(authToken, signature, url, req.body);
}</pre></div>`,

memory: `<div class="sec-eye">Step 3</div>
<div class="sec-title">Memory &amp; Context</div>
<div class="sec-sub">Redis keeps the hot conversation context fast. PostgreSQL stores everything permanently. Voice calls get their own session scope keyed by CallSid.</div>

<div class="block"><div class="block-label">services/session.ts — all session helpers</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import { redis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

const CHAT_TTL  = 4 * 3600;   // 4 hours
const VOICE_TTL = 1 * 3600;   // 1 hour
const MAX_HOT   = 20;          // messages before auto-summarization

// ── Chat / SMS history ──────────────────────────────────────────────────────

export async function getHistory(key: string): Promise<Anthropic.MessageParam[]> {
  const raw = await redis.get<string>(key);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export async function appendToHistory(
  key: string,
  message: Anthropic.MessageParam,
  ttl = CHAT_TTL
): Promise<void> {
  let history = await getHistory(key);
  history.push(message);
  if (history.length > MAX_HOT) {
    history = await summarizeOldMessages(history);
  }
  await redis.set(key, JSON.stringify(history), { ex: ttl });
}

async function summarizeOldMessages(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const keep = messages.slice(-6);
  const toSummarize = messages.slice(0, -6);

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: "Summarize this conversation in 2-3 sentences, preserving key facts (names, bookings, contact info):\n\n" +
        toSummarize.map(m =>
          (m.role === "user" ? "Customer: " : "AI: ") +
          (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
        ).join("\n"),
    }],
  });

  const summary = (res.content[0] as Anthropic.TextBlock).text;
  return [{ role: "assistant", content: "[Earlier conversation: " + summary + "]" }, ...keep];
}

// ── Voice session (keyed by Twilio CallSid) ─────────────────────────────────

export async function getVoiceSession(callSid: string): Promise<Anthropic.MessageParam[]> {
  return getHistory("voice:" + callSid);
}

export async function appendToVoiceSession(
  callSid: string,
  message: Anthropic.MessageParam
): Promise<void> {
  return appendToHistory("voice:" + callSid, message, VOICE_TTL);
}

export async function clearVoiceSession(callSid: string): Promise<void> {
  await redis.del("voice:" + callSid);
}

// Cache business lookup by CallSid (set at call start in voice route)
export async function setBusinessByCallSid(callSid: string, business: any): Promise<void> {
  await redis.set("callsid:" + callSid, JSON.stringify(business), { ex: VOICE_TTL });
}

export async function getBusinessByCallSid(callSid: string): Promise<any | null> {
  const raw = await redis.get<string>("callsid:" + callSid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Finalize call — writes transcript + AI summary to Postgres ──────────────

export async function finalizeVoiceCall(callSid: string, durationSeconds: number): Promise<void> {
  const [history, business] = await Promise.all([
    getVoiceSession(callSid),
    getBusinessByCallSid(callSid),
  ]);
  if (!history.length || !business) return;

  const transcript = history
    .map(m => (m.role === "user" ? "CALLER: " : "AI: ") +
      (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  let summary = "";
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: "Summarize in 2 sentences. Note outcome (booked/lead captured/escalated/resolved):\n\n" + transcript,
      }],
    });
    summary = (res.content[0] as Anthropic.TextBlock).text;
  } catch { /* summary is optional */ }

  await prisma.voiceCall.updateMany({
    where: { callSid },
    data: { status: "completed", durationSeconds, transcript, summary, endedAt: new Date() },
  });

  await clearVoiceSession(callSid);
  await redis.del("callsid:" + callSid);
}</pre></div>`,

chat: `<div class="sec-eye">Step 4</div>
<div class="sec-title">Chat + SMS</div>
<div class="sec-sub">REST endpoint for the website chat widget and Twilio webhook for inbound SMS. Both share the same conversation core.</div>

<div class="block"><div class="block-label">routes/chat.ts — website chat REST API</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getHistory, appendToHistory } from "../services/session";
import { processMessage, handleToolCall } from "../services/conversation";

const router = Router();

router.post("/", async (req, res) => {
  const { message, sessionId, widgetKey } = req.body as {
    message: string; sessionId: string; widgetKey: string;
  };

  if (!message?.trim() || !sessionId || !widgetKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const business = await prisma.business.findUnique({ where: { widgetKey } });
  if (!business) return res.status(404).json({ error: "Business not found" });

  const sessionKey = "chat:" + widgetKey + ":" + sessionId;
  const history = await getHistory(sessionKey);

  const { message: aiMsg, toolCall } = await processMessage(
    business, history, message.trim(), "chat"
  );

  let finalMessage = aiMsg;
  if (toolCall) {
    finalMessage = await handleToolCall(toolCall, business, null, "chat");
  }

  // Persist history — non-blocking so response is fast
  Promise.all([
    appendToHistory(sessionKey, { role: "user",      content: message.trim() }),
    appendToHistory(sessionKey, { role: "assistant", content: finalMessage }),
  ]).catch(console.error);

  // Persist to Postgres — fully async, doesn't block response
  setImmediate(async () => {
    try {
      const conv = await prisma.conversation.upsert({
        where:  { sessionId },
        create: { sessionId, businessId: business.id, channel: "chat" },
        update: { updatedAt: new Date() },
      });
      await prisma.message.createMany({ data: [
        { conversationId: conv.id, role: "user",      content: message.trim() },
        { conversationId: conv.id, role: "assistant", content: finalMessage },
      ]});
    } catch (e) { console.error("DB persist:", e); }
  });

  res.json({ message: finalMessage });
});

export default router;</pre></div>

<div class="block"><div class="block-label">routes/sms.ts — Twilio SMS webhook</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import { Router } from "express";
import twilio from "twilio";
import { prisma } from "../lib/prisma";
import { getHistory, appendToHistory } from "../services/session";
import { processMessage, handleToolCall, validateTwilioRequest } from "../services/conversation";

const router = Router();

router.post("/", async (req, res) => {
  if (!validateTwilioRequest(req)) return res.status(403).send("Forbidden");

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const { From: from, To: to, Body: body } = req.body as {
      From: string; To: string; Body: string;
    };
    if (!body?.trim()) {
      twiml.message("I didn't receive your message. Please try again.");
      return res.type("text/xml").send(twiml.toString());
    }

    const business = await prisma.business.findUnique({ where: { twilioNumber: to } });
    if (!business) {
      twiml.message("Sorry, this number is not configured.");
      return res.type("text/xml").send(twiml.toString());
    }

    const sessionKey = "sms:" + to + ":" + from;
    const history = await getHistory(sessionKey);

    const { message: aiMsg, toolCall } = await processMessage(
      business, history, body.trim(), "sms"
    );

    let finalMessage = aiMsg;
    if (toolCall) {
      finalMessage = await handleToolCall(toolCall, business, from, "sms");
    }

    Promise.all([
      appendToHistory(sessionKey, { role: "user",      content: body.trim() }),
      appendToHistory(sessionKey, { role: "assistant", content: finalMessage }),
    ]).catch(console.error);

    // SMS hard limit is 1600 chars
    twiml.message(finalMessage.slice(0, 1600));
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("SMS error:", err);
    twiml.message("I'm having trouble right now. Please call us directly.");
    res.type("text/xml").send(twiml.toString());
  }
});

export default router;</pre></div>`,

}); // end window.SECTIONS p1
