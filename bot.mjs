import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";

const MODEL = process.env.MODEL || "gpt-5-nano";
const TRIGGER_PREFIX = process.env.TRIGGER_PREFIX ?? "!ai";
const AUTH_DIR = process.env.AUTH_DIR || "./whatsapp-auth";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const logger = pino({ level: "warn" });

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  ).trim();
}

async function askModel(text) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a concise WhatsApp assistant. Reply naturally in the same language as the sender. Keep ordinary replies short and useful.",
        },
        { role: "user", content: text },
      ],
      max_completion_tokens: 700,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || "I couldn't generate a reply.";
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log("\nScan this QR in WhatsApp → Settings → Linked Devices → Link a Device:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.data?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("❌ WhatsApp logged out. Link again.");
        process.exit(1);
      }

      console.log("Connection closed; reconnecting...");
      setTimeout(start, 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg?.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        if (
          TRIGGER_PREFIX &&
          !text.toLowerCase().startsWith(TRIGGER_PREFIX.toLowerCase())
        ) {
          continue;
        }

        const prompt = TRIGGER_PREFIX
          ? text.slice(TRIGGER_PREFIX.length).trim()
          : text;

        if (!prompt) {
          await sock.sendMessage(jid, {
            text: `Usage: ${TRIGGER_PREFIX} your question`,
          });
          continue;
        }

        await sock.sendPresenceUpdate("composing", jid);
        const answer = await askModel(prompt);
        await sock.sendMessage(
          jid,
          { text: answer.slice(0, 3900) },
          { quoted: msg }
        );
        await sock.sendPresenceUpdate("paused", jid);
      } catch (err) {
        console.error("Message handler error:", err);
      }
    }
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
