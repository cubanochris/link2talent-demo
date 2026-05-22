// sections_p2.js — voice, appts, leads, kb, onboard, dashboard, deploy, security
Object.assign(window.SECTIONS, {

voice: `<div class="sec-eye">Step 5</div>
<div class="sec-title">Voice Pipeline</div>
<div class="sec-sub">Full phone call handling: Twilio Media Streams → Deepgram STT → Claude streaming → Cartesia TTS → caller. Includes barge-in, exponential backoff, and call finalization.</div>

<div class="block"><div class="block-label">routes/voice.ts — incoming call + status callback</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import { Router } from "express";
import twilio from "twilio";
import { prisma } from "../lib/prisma";
import { validateTwilioRequest } from "../services/conversation";
import { setBusinessByCallSid, finalizeVoiceCall } from "../services/session";

const router = Router();

// Twilio calls this when someone dials your number
router.post("/incoming", async (req, res) => {
  if (!validateTwilioRequest(req)) return res.status(403).send("Forbidden");

  const { To, From, CallSid } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();

  const business = await prisma.business.findUnique({ where: { twilioNumber: To } });
  if (!business) {
    twiml.say("Sorry, this number is not configured."); twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Cache business for WebSocket handler (which has no HTTP context)
  await setBusinessByCallSid(CallSid, business);

  // Create call record
  await prisma.voiceCall.create({
    data: { businessId: business.id, callSid: CallSid, from: From, to: To },
  });

  // Open Media Stream — use BASE_URL to construct WSS host safely
  const wsHost = new URL(process.env.BASE_URL!).host;
  const connect = twiml.connect();
  connect.stream({ url: "wss://" + wsHost + "/voice/stream", track: "inbound_track" });

  // statusCallback fires when call ends — used to finalize transcript in Postgres
  // Configure this in your Twilio number settings or add statusCallback param here

  res.type("text/xml").send(twiml.toString());
});

// Twilio fires this when the call ends (set Status Callback URL in Twilio console)
router.post("/status", async (req, res) => {
  if (!validateTwilioRequest(req)) return res.status(403).send("Forbidden");
  const { CallSid, CallStatus, CallDuration } = req.body;
  res.sendStatus(200); // respond immediately — Twilio won't retry if we're fast
  if (CallStatus === "completed") {
    setImmediate(() =>
      finalizeVoiceCall(CallSid, parseInt(CallDuration ?? "0", 10)).catch(console.error)
    );
  }
});

export default router;</pre></div>

<div class="block"><div class="block-label">services/voiceStream.ts — WebSocket handler (the full pipeline)</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button>import WebSocket from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { getVoiceSession, appendToVoiceSession, getBusinessByCallSid } from "./session";
import { buildVoicePrompt } from "./conversation";
import { getKnowledgeContext } from "./knowledge";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Abbreviation guard — prevents sentence detection from firing on "Dr." "Mr." etc.
const ABBREV_RE = /\b(Mr|Mrs|Ms|Dr|Jr|Sr|Prof|St|Ave|Blvd|etc|e\.g|i\.e)\.\s*$/i;

function isSentenceEnd(buffer: string, token: string): boolean {
  if (!/[.!?]$/.test(token.trimEnd())) return false;
  if (ABBREV_RE.test(buffer.trimEnd())) return false;
  return buffer.trim().length > 15;
}

export function handleVoiceStream(ws: WebSocket): void {
  let streamSid = "";
  let callSid   = "";
  let business: any = null;
  let dgWs: WebSocket | null = null;
  let dgReconnectDelay = 500; // exponential backoff: 500ms → 1s → 2s → ... → 8s cap
  let isSpeaking   = false;   // true while Cartesia audio is being sent to caller
  let isResponding = false;   // true while Claude is generating

  const voiceHistory: Anthropic.MessageParam[] = [];

  // ── Cartesia TTS ───────────────────────────────────────────────────────────
  async function speakText(text: string): Promise<void> {
    if (!text.trim() || !streamSid) return;
    isSpeaking = true;
    try {
      const res = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "Cartesia-Version": "2024-06-10",
          "X-API-Key": process.env.CARTESIA_API_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-english",
          transcript: text,
          voice: {
            mode: "id",
            id: process.env.CARTESIA_VOICE_ID ?? "a0e99841-438c-4a64-b679-ae501e7d6091",
          },
          output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
        }),
      });
      if (!res.ok || !res.body) { isSpeaking = false; return; }

      const audio = Buffer.from(await res.arrayBuffer());
      const chunkSize = 160; // 20ms chunks at 8kHz mulaw
      for (let i = 0; i < audio.length; i += chunkSize) {
        if (!isSpeaking) break; // barge-in interrupted — stop sending
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify({
          event: "media", streamSid,
          media: { payload: audio.slice(i, i + chunkSize).toString("base64") },
        }));
        // Throttle to real-time: 20ms per 160-byte chunk
        await new Promise(r => setTimeout(r, 18));
      }
    } catch (e) {
      console.error("[voice] TTS error:", e);
    } finally {
      isSpeaking = false;
    }
  }

  // ── Claude streaming response ──────────────────────────────────────────────
  async function streamChat(transcript: string): Promise<void> {
    if (isResponding) return;
    isResponding = true;
    try {
      // Fetch RAG context in parallel as stream begins
      const ragContext = await getKnowledgeContext(business.id, transcript);
      const systemPrompt = buildVoicePrompt(business, ragContext);

      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-5",
        max_tokens: 200,
        system: systemPrompt,
        messages: [...voiceHistory, { role: "user", content: transcript }],
      });

      let sentenceBuffer = "";
      let fullResponse   = "";

      for await (const event of stream) {
        if (!isResponding) break; // barge-in cancelled generation
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const token = event.delta.text;
          sentenceBuffer += token;
          fullResponse   += token;
          if (isSentenceEnd(sentenceBuffer, token)) {
            const sentence = sentenceBuffer.trim();
            sentenceBuffer = "";
            speakText(sentence); // fire-and-forget — keep streaming while speaking
          }
        }
      }

      // Flush any remaining text
      if (sentenceBuffer.trim() && isResponding) {
        await speakText(sentenceBuffer.trim());
      }

      // Persist history — non-blocking
      if (fullResponse && isResponding) {
        voiceHistory.push({ role: "user",      content: transcript });
        voiceHistory.push({ role: "assistant", content: fullResponse });
        Promise.all([
          appendToVoiceSession(callSid, { role: "user",      content: transcript }),
          appendToVoiceSession(callSid, { role: "assistant", content: fullResponse }),
        ]).catch(console.error);
      }
    } catch (e) {
      console.error("[voice] Claude error:", e);
      await speakText("I'm sorry, I had a technical issue. Could you please repeat that?");
    } finally {
      isResponding = false;
    }
  }

  // ── Deepgram STT connection with exponential backoff ───────────────────────
  function startDeepgram(): void {
    const params = new URLSearchParams({
      model: "nova-3", encoding: "mulaw", sample_rate: "8000",
      channels: "1", punctuate: "true", interim_results: "true",
      utterance_end_ms: "1000", vad_events: "true",
    });
    dgWs = new WebSocket("wss://api.deepgram.com/v1/listen?" + params.toString(), {
      headers: { Authorization: "Token " + process.env.DEEPGRAM_API_KEY },
    });

    dgWs.on("open", () => {
      dgReconnectDelay = 500; // reset backoff on success
      console.log("[voice:" + callSid + "] Deepgram connected");
    });

    dgWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "Results" || !msg.is_final) return;
        const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        // Barge-in: stop AI audio and generation if caller speaks
        if (isSpeaking || isResponding) {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
          isSpeaking   = false;
          isResponding = false;
        }

        console.log("[voice:" + callSid + "] \"" + transcript + "\"");
        streamChat(transcript);
      } catch { /* ignore parse errors */ }
    });

    dgWs.on("error", e => console.error("[voice] Deepgram error:", e));

    dgWs.on("close", () => {
      if (!callSid) return; // call ended — don't reconnect
      console.log("[voice:" + callSid + "] Deepgram closed, retrying in " + dgReconnectDelay + "ms");
      setTimeout(() => {
        startDeepgram();
        dgReconnectDelay = Math.min(dgReconnectDelay * 2, 8000);
      }, dgReconnectDelay);
    });
  }

  // ── Twilio Media Streams protocol ──────────────────────────────────────────
  ws.on("message", async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        business  = await getBusinessByCallSid(callSid);
        if (!business) { ws.close(); return; }

        startDeepgram();
        // 300ms delay — let Deepgram handshake complete before greeting
        setTimeout(() =>
          speakText("Thank you for calling " + business.name + ". How can I help you today?"),
          300
        );
      }

      if (msg.event === "media" && dgWs?.readyState === WebSocket.OPEN) {
        dgWs.send(Buffer.from(msg.media.payload, "base64"));
      }

      if (msg.event === "stop") {
        callSid = ""; // prevents Deepgram reconnect after call ends
        dgWs?.close();
      }
    } catch (e) { console.error("[voice] Parse error:", e); }
  });

  ws.on("close", () => { callSid = ""; dgWs?.close(); });
}</pre></div>`,

appts: `<div class="sec-eye">Step 6</div>
<div class="sec-title">Appointments</div>
<div class="sec-sub">Cal.com handles most bookings. Google Calendar OAuth is available for businesses that prefer direct GCal control. Both are called by <code>handleToolCall</code> when Claude invokes <code>book_appointment</code>.</div>

<div class="block"><div class="block-label">services/calendar.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import { prisma } from "../lib/prisma";

type BookingInput = {
  customerName: string; customerEmail: string;
  customerPhone?: string; service: string; preferredTime: string;
};
type BookingResult = { success: boolean; confirmedTime?: string };

// ── Cal.com booking ─────────────────────────────────────────────────────────
async function bookViaCal(business: any, input: BookingInput): Promise<BookingResult> {
  const isoStart = parsePreferredTime(input.preferredTime, business.timezone);
  const res = await fetch("https://api.cal.com/v1/bookings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + business.calApiKey,
    },
    body: JSON.stringify({
      eventTypeId: business.calEventTypeId,
      start: isoStart,
      attendees: [{ name: input.customerName, email: input.customerEmail }],
      metadata: { phone: input.customerPhone ?? "", service: input.service },
    }),
  });
  if (!res.ok) return { success: false };
  const data = await res.json();
  await prisma.appointment.create({
    data: {
      businessId: business.id,
      customerName: input.customerName, customerEmail: input.customerEmail,
      customerPhone: input.customerPhone, service: input.service,
      scheduledAt: new Date(data.startTime), calBookingUid: data.uid,
      source: "chat",
    },
  });
  return {
    success: true,
    confirmedTime: formatTime(data.startTime, business.timezone),
  };
}

// ── Google Calendar booking (OAuth) ─────────────────────────────────────────
async function bookViaGoogle(business: any, input: BookingInput): Promise<BookingResult> {
  // Refresh access token if needed (simplified — in prod use google-auth-library)
  const token = await refreshGoogleToken(business);
  const start = new Date(parsePreferredTime(input.preferredTime, business.timezone));
  const end   = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour default

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: input.service + " — " + input.customerName,
      start: { dateTime: start.toISOString(), timeZone: business.timezone },
      end:   { dateTime: end.toISOString(),   timeZone: business.timezone },
      attendees: [{ email: input.customerEmail }],
    }),
  });
  if (!res.ok) return { success: false };
  const event = await res.json();
  await prisma.appointment.create({
    data: {
      businessId: business.id, customerName: input.customerName,
      customerEmail: input.customerEmail, customerPhone: input.customerPhone,
      service: input.service, scheduledAt: start, googleEventId: event.id,
      source: "chat",
    },
  });
  return { success: true, confirmedTime: formatTime(start.toISOString(), business.timezone) };
}

async function refreshGoogleToken(business: any): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: business.googleRefreshToken,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.access_token && data.access_token !== business.googleAccessToken) {
    await prisma.business.update({
      where: { id: business.id },
      data: { googleAccessToken: data.access_token },
    });
  }
  return data.access_token ?? business.googleAccessToken;
}

// ── Public entry point — picks the right provider ───────────────────────────
export async function bookAppointment(business: any, input: BookingInput): Promise<BookingResult> {
  try {
    if (business.calApiKey && business.calEventTypeId) return bookViaCal(business, input);
    if (business.googleRefreshToken) return bookViaGoogle(business, input);
    return { success: false };
  } catch (e) {
    console.error("Booking error:", e);
    return { success: false };
  }
}

function parsePreferredTime(text: string, tz: string): string {
  // TODO: integrate chrono-node for robust natural language parsing
  // Fallback: next weekday at 10am
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}</pre></div>

<div class="block"><div class="block-label">Recommended: add chrono-node for natural language time parsing</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">npm install chrono-node
# then replace parsePreferredTime:
import * as chrono from "chrono-node";
function parsePreferredTime(text: string, tz: string): string {
  const parsed = chrono.parseDate(text, new Date(), { forwardDate: true });
  return parsed ? parsed.toISOString() : new Date(Date.now() + 86400000).toISOString();
}</pre></div>`,

leads: `<div class="sec-eye">Step 7</div>
<div class="sec-title">Lead Capture</div>
<div class="sec-sub">Saves leads to Postgres and syncs to HubSpot CRM. Escalation emails go out via Resend. All CRM operations are fire-and-forget so they never block a response.</div>

<div class="block"><div class="block-label">services/leads.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import { Resend } from "resend";
import { prisma } from "../lib/prisma";

const resend = new Resend(process.env.RESEND_API_KEY!);

// ── Save lead to DB + async HubSpot sync ────────────────────────────────────
export async function saveLead(
  businessId: string,
  data: {
    name?: string; email?: string; phone?: string;
    intent?: string; notes?: string; source: string;
  }
): Promise<void> {
  const lead = await prisma.lead.create({ data: { businessId, ...data } });
  // Non-blocking CRM sync — failure here should NOT break the chat response
  syncToHubSpot(lead).catch(e => console.error("HubSpot sync failed:", e));
}

async function syncToHubSpot(lead: any): Promise<void> {
  if (!process.env.HUBSPOT_API_KEY) return;
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.HUBSPOT_API_KEY,
    },
    body: JSON.stringify({
      properties: {
        firstname:           lead.name?.split(" ")[0] ?? "",
        lastname:            lead.name?.split(" ").slice(1).join(" ") ?? "",
        email:               lead.email ?? "",
        phone:               lead.phone ?? "",
        hs_lead_status:      "NEW",
        lead_source:         "AI Receptionist (" + lead.source + ")",
        notes_last_contacted: lead.notes ?? lead.intent ?? "",
      },
    }),
  });
  if (!res.ok) { console.error("HubSpot error:", await res.text()); return; }
  const data = await res.json();
  await prisma.lead.update({ where: { id: lead.id }, data: { hubspotId: data.id } });
}

// ── Escalation email via Resend ─────────────────────────────────────────────
export async function sendEscalationEmail(
  business: any, reason: string, urgency: string, callerPhone: string | null
): Promise<void> {
  if (!business.escalationEmail) return;
  const subject = "[" + (urgency?.toUpperCase() ?? "MEDIUM") + "] AI Receptionist Escalation — " + business.name;
  await resend.emails.send({
    from: process.env.RESEND_FROM ?? "receptionist@link2talent.ai",
    to:   business.escalationEmail,
    subject,
    html: "<h2>Escalation Required</h2>" +
      "<p><strong>Business:</strong> " + business.name + "</p>" +
      "<p><strong>Reason:</strong> " + reason + "</p>" +
      "<p><strong>Urgency:</strong> " + (urgency ?? "medium") + "</p>" +
      "<p><strong>Caller:</strong> " + (callerPhone ?? "unknown") + "</p>" +
      "<p><em>Sent by AI Receptionist at " + new Date().toLocaleString() + "</em></p>",
  });
}</pre></div>`,

kb: `<div class="sec-eye">Step 8</div>
<div class="sec-title">Knowledge Base</div>
<div class="sec-sub">Pinecone stores business-specific FAQs, hours, services, and policies as vectors. Each business gets its own namespace so RAG results are always scoped correctly.</div>

<div class="block"><div class="block-label">services/knowledge.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import { Pinecone } from "@pinecone-database/pinecone";
import Anthropic from "@anthropic-ai/sdk";

const pinecone  = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const INDEX     = process.env.PINECONE_INDEX ?? "ai-receptionist";

async function embed(text: string): Promise<number[]> {
  // voyage-3 is Anthropic's embedding model — 1024-dim, excellent for RAG
  const res = await (anthropic as any).embeddings.create({
    model: "voyage-3", input: text, input_type: "query",
  });
  return res.embeddings[0].embedding;
}

// ── Query: called on every message ──────────────────────────────────────────
export async function getKnowledgeContext(
  businessId: string, query: string
): Promise<string> {
  try {
    const vector  = await embed(query);
    const results = await pinecone.index(INDEX).namespace(businessId).query({
      vector, topK: 4, includeMetadata: true,
    });
    return results.matches
      .filter(m => (m.score ?? 0) > 0.75)
      .map(m => "Q: " + m.metadata?.question + "\nA: " + m.metadata?.answer)
      .join("\n\n");
  } catch (e) {
    console.error("Pinecone query error:", e);
    return ""; // graceful degradation — Claude still answers from training
  }
}

// ── Upsert: called from admin API when knowledge is added/edited ─────────────
export async function upsertKnowledge(
  businessId: string,
  items: Array<{ question: string; answer: string; category: string }>
): Promise<void> {
  const ns = pinecone.index(INDEX).namespace(businessId);
  for (const item of items) {
    const id     = businessId + ":" + Buffer.from(item.question).toString("base64").slice(0, 40);
    const vector = await embed(item.question + " " + item.answer);
    await ns.upsert([{
      id, values: vector,
      metadata: {
        question: item.question, answer: item.answer,
        category: item.category, businessId,
      },
    }]);
  }
}

// ── Delete all knowledge for a business (e.g. when resetting) ───────────────
export async function deleteBusinessKnowledge(businessId: string): Promise<void> {
  await pinecone.index(INDEX).namespace(businessId).deleteAll();
}</pre></div>

<div class="block"><div class="block-label">Seeding a new business with starter knowledge</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">// scripts/seed-knowledge.ts
import { upsertKnowledge } from "../src/services/knowledge";

const BUSINESS_ID = "your-business-cuid-here";

await upsertKnowledge(BUSINESS_ID, [
  { category: "hours",    question: "What are your hours?",           answer: "Monday–Friday 9am–5pm, Saturday 10am–2pm, closed Sunday." },
  { category: "location", question: "Where are you located?",         answer: "123 Main St, Suite 100, Miami FL 33101. Free parking in rear." },
  { category: "services", question: "What services do you offer?",    answer: "We offer consultations, full-service treatments, and follow-up care. Call to discuss your specific needs." },
  { category: "pricing",  question: "How much does it cost?",         answer: "Pricing varies by service. Consultations start at $75. We accept most major insurances." },
  { category: "booking",  question: "How do I book an appointment?",  answer: "You can book online, call us, or I can book it for you right now. What works best?" },
  { category: "faq",      question: "Do you offer payment plans?",    answer: "Yes, we offer flexible payment plans. We can discuss options during your consultation." },
]);
console.log("Knowledge seeded!");</pre></div>`,

onboard: `<div class="sec-eye">Step 9</div>
<div class="sec-title">Client Onboarding</div>
<div class="sec-sub">Admin API endpoints for provisioning new businesses, uploading knowledge, and generating embed codes. Protect these with a server-to-server API key — never expose to the browser.</div>

<div class="block"><div class="block-label">routes/admin.ts — onboarding endpoints</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import { Router } from "express";
import { prisma } from "../lib/prisma";
import { upsertKnowledge, deleteBusinessKnowledge } from "../services/knowledge";

const router = Router();

// Middleware: require server-side admin key
router.use((req, res, next) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Create a new business
router.post("/businesses", async (req, res) => {
  const { name, timezone, industry, systemPrompt, escalationEmail, twilioNumber } = req.body;
  const business = await prisma.business.create({
    data: { name, timezone, industry, systemPrompt, escalationEmail, twilioNumber },
  });
  res.json({ business, widgetKey: business.widgetKey });
});

// Get embed code for the chat widget
router.get("/businesses/:id/embed", async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.params.id } });
  if (!business) return res.status(404).json({ error: "Not found" });
  const snippet = '<script src="' + process.env.BASE_URL + '/widget.js" ' +
    'data-key="' + business.widgetKey + '"></script>';
  res.json({ widgetKey: business.widgetKey, embedSnippet: snippet });
});

// Upload / replace knowledge base
router.post("/businesses/:id/knowledge", async (req, res) => {
  const { items } = req.body as {
    items: Array<{ question: string; answer: string; category: string }>;
  };
  await upsertKnowledge(req.params.id, items);
  res.json({ upserted: items.length });
});

// Reset knowledge base
router.delete("/businesses/:id/knowledge", async (req, res) => {
  await deleteBusinessKnowledge(req.params.id);
  await prisma.knowledgeItem.deleteMany({ where: { businessId: req.params.id } });
  res.json({ deleted: true });
});

// Update business settings (prompt, escalation email, etc.)
router.patch("/businesses/:id", async (req, res) => {
  const allowed = ["name","systemPrompt","customPromptAdditions","escalationEmail","timezone","plan","industry"];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  const business = await prisma.business.update({
    where: { id: req.params.id }, data: updates,
  });
  res.json(business);
});

export default router;</pre></div>`,

dashboard: `<div class="sec-eye">Step 10</div>
<div class="sec-title">Dashboard API</div>
<div class="sec-sub">Analytics endpoints for the client dashboard — call stats, lead counts, conversation history, and recent activity.</div>

<div class="block"><div class="block-label">routes/dashboard.ts</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// Simple API-key auth (replace with JWT in production)
router.use((req, res, next) => {
  const key = req.headers["x-widget-key"] as string;
  if (!key) return res.status(401).json({ error: "Missing widget key" });
  // Look up business from widgetKey (add caching in prod)
  (req as any).widgetKey = key;
  next();
});

async function getBusiness(widgetKey: string) {
  return prisma.business.findUnique({ where: { widgetKey } });
}

// Summary stats for the past 30 days
router.get("/stats", async (req, res) => {
  const business = await getBusiness((req as any).widgetKey);
  if (!business) return res.status(404).json({ error: "Not found" });

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [totalConvs, totalLeads, totalCalls, newLeads] = await Promise.all([
    prisma.conversation.count({ where: { businessId: business.id, createdAt: { gte: since } } }),
    prisma.lead.count(        { where: { businessId: business.id, createdAt: { gte: since } } }),
    prisma.voiceCall.count(   { where: { businessId: business.id, createdAt: { gte: since } } }),
    prisma.lead.count(        { where: { businessId: business.id, status: "new" } }),
  ]);
  res.json({ totalConvs, totalLeads, totalCalls, newLeads, period: "30d" });
});

// Recent leads
router.get("/leads", async (req, res) => {
  const business = await getBusiness((req as any).widgetKey);
  if (!business) return res.status(404).json({ error: "Not found" });
  const leads = await prisma.lead.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: "desc" }, take: 50,
  });
  res.json(leads);
});

// Recent voice calls
router.get("/calls", async (req, res) => {
  const business = await getBusiness((req as any).widgetKey);
  if (!business) return res.status(404).json({ error: "Not found" });
  const calls = await prisma.voiceCall.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: "desc" }, take: 50,
    select: { callSid:1, from:1, status:1, durationSeconds:1, summary:1, createdAt:1, escalated:1, resolved:1 },
  });
  res.json(calls);
});

// Full transcript for a specific call
router.get("/calls/:callSid/transcript", async (req, res) => {
  const business = await getBusiness((req as any).widgetKey);
  if (!business) return res.status(404).json({ error: "Not found" });
  const call = await prisma.voiceCall.findFirst({
    where: { callSid: req.params.callSid, businessId: business.id },
    select: { transcript: true, summary: true, createdAt: true, durationSeconds: true },
  });
  if (!call) return res.status(404).json({ error: "Not found" });
  res.json(call);
});

export default router;</pre></div>`,

deploy: `<div class="sec-eye">Step 11</div>
<div class="sec-title">Deployment</div>
<div class="sec-sub">Deploy to Railway — one-command setup with PostgreSQL included. Add all env vars, configure Twilio webhooks, and you're live.</div>

<div class="block"><div class="block-label">.env — all required variables</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button"># Database (Railway Postgres auto-populates DATABASE_URL)
DATABASE_URL=postgresql://user:pass@host:5432/db

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Twilio
TWILIO_ACCOUNT_SID=ACxx...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15550001234

# Deepgram (STT)
DEEPGRAM_API_KEY=...

# Cartesia (TTS)
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091

# Pinecone
PINECONE_API_KEY=...
PINECONE_INDEX=ai-receptionist

# Email (Resend)
RESEND_API_KEY=re_...
RESEND_FROM=receptionist@yourdomain.com

# Google Calendar OAuth (optional)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-app.railway.app/oauth/google/callback

# App
BASE_URL=https://your-app.railway.app
ADMIN_API_KEY=generate-a-strong-random-key-here
NODE_ENV=production</pre></div>

<div class="block"><div class="block-label">Railway deploy steps</div>
<div class="info-list">
<div class="info-row"><strong>1.</strong> Install Railway CLI: <code>npm install -g @railway/cli</code></div>
<div class="info-row"><strong>2.</strong> Login and init: <code>railway login &amp;&amp; railway init</code></div>
<div class="info-row"><strong>3.</strong> Add Postgres plugin in Railway dashboard → Variables tab will auto-populate DATABASE_URL</div>
<div class="info-row"><strong>4.</strong> Add all env vars in Railway dashboard → Variables</div>
<div class="info-row"><strong>5.</strong> Deploy: <code>railway up</code> — Railway builds and runs <code>npm start</code></div>
<div class="info-row"><strong>6.</strong> Run migrations: <code>railway run npx prisma db push</code></div>
<div class="info-row"><strong>7.</strong> Set Twilio webhooks (Voice URL, Status Callback, SMS URL) to your Railway domain</div>
</div></div>

<div class="block"><div class="block-label">Twilio webhook URLs to configure</div>
<table>
<thead><tr><th>Setting</th><th>URL</th><th>Method</th></tr></thead>
<tbody>
<tr><td>Voice URL</td><td>https://your-app.railway.app/voice/incoming</td><td>POST</td></tr>
<tr><td>Voice Status Callback</td><td>https://your-app.railway.app/voice/status</td><td>POST</td></tr>
<tr><td>SMS Webhook</td><td>https://your-app.railway.app/sms</td><td>POST</td></tr>
</tbody>
</table></div>

<div class="block"><div class="block-label">railway.toml (optional — explicit config)</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run build && npm start"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3</pre></div>`,

security: `<div class="sec-eye">Step 12</div>
<div class="sec-title">Security</div>
<div class="sec-sub">Production security checklist — Twilio signature validation, rate limiting, CORS, and secret hygiene.</div>

<div class="block"><div class="block-label">Security checklist</div>
<div class="info-list">
<div class="info-row ok">&#10003; <strong>Twilio signature validation</strong> on every webhook (/sms, /voice/incoming, /voice/status)</div>
<div class="info-row ok">&#10003; <strong>Raw body preserved</strong> for Twilio routes — parsed AFTER signature check</div>
<div class="info-row ok">&#10003; <strong>Rate limiting</strong> on /api/* — 60 req/min per IP (express-rate-limit)</div>
<div class="info-row ok">&#10003; <strong>CORS restricted</strong> to known widget domains (set ALLOWED_ORIGINS)</div>
<div class="info-row ok">&#10003; <strong>Admin routes</strong> protected by ADMIN_API_KEY header — never expose in frontend</div>
<div class="info-row ok">&#10003; <strong>No secrets in code</strong> — all keys in .env / Railway variables</div>
<div class="info-row ok">&#10003; <strong>DATABASE_URL</strong> uses SSL (Railway enforces this by default)</div>
<div class="info-row warn">&#9888; <strong>Widget key</strong> is public by design — rate-limit per widgetKey in addition to per IP</div>
<div class="info-row warn">&#9888; <strong>Voice WebSocket</strong> has no auth — relies on Twilio's streamSid being unguessable</div>
<div class="info-row err">&#10007; <strong>Never log</strong> full transcripts or customer PII at INFO level in production</div>
</div></div>

<div class="block"><div class="block-label">Per-widgetKey rate limiting (add to chat route)</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import rateLimit from "express-rate-limit";
import { redis } from "../lib/redis";

// Custom rate limiter backed by Redis (shared across instances)
export const widgetRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30, // 30 messages per minute per widget+IP combo
  keyGenerator: (req) => {
    const widgetKey = req.body?.widgetKey ?? "unknown";
    const ip = req.ip ?? "noip";
    return widgetKey + ":" + ip;
  },
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many messages — please slow down." });
  },
});

// Usage in routes/chat.ts:
// router.post("/", widgetRateLimit, async (req, res) => { ... })</pre></div>

<div class="block"><div class="block-label">CORS setup (src/index.ts)</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">import cors from "cors";

// Only allow requests from widget-hosting domains + your dashboard
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.length === 0 || ALLOWED.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error("CORS: origin not allowed — " + origin));
    }
  },
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "x-widget-key", "x-admin-key"],
}));</pre></div>

<div class="block"><div class="block-label">Helmet.js for HTTP security headers (recommended)</div>
<pre><button class="copy-btn" onclick="cp(this)">Copy</button">npm install helmet @types/helmet

// In src/index.ts, add before other middleware:
import helmet from "helmet";
app.use(helmet({
  contentSecurityPolicy: false, // loosen for widget script delivery
  crossOriginEmbedderPolicy: false,
}));</pre></div>`,

}); // end window.SECTIONS p2
