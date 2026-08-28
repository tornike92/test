import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import http from "node:http";

const MODEL = process.env.MODEL || "gpt-5-nano";
const TRIGGER_PREFIX = process.env.TRIGGER_PREFIX ?? "!ai";
const AUTH_DIR = process.env.AUTH_DIR || "./whatsapp-auth";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_PAGE_TOKEN = process.env.QR_PAGE_TOKEN || "";
const PORT = Number(process.env.PORT || 8080);
const ALLOWED_NUMBERS = new Set(
  (process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((value) => value.replace(/\D/g, ""))
    .filter(Boolean)
);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const logger = pino({ level: "warn" });
let latestQrDataUrl = "";
let connectionStatus = "starting";

function renderPage(message, image = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>WhatsApp Link</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f8;color:#111}.card{background:white;padding:28px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;max-width:520px;width:calc(100% - 40px)}img{width:min(420px,90vw);height:auto}.status{font-size:18px;margin:8px 0 18px}.hint{color:#666;line-height:1.5}</style></head><body><div class="card"><h1>WhatsApp Bot</h1><div class="status">${message}</div>${image ? `<img src="${image}" alt="WhatsApp QR code">` : ""}<p class="hint">On your phone: WhatsApp → Settings → Linked Devices → Link a Device.</p></div></body></html>`;
}

http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (QR_PAGE_TOKEN && url.searchParams.get("token") !== QR_PAGE_TOKEN) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (connectionStatus === "connected") {
    res.end(renderPage("✅ WhatsApp connected. You can close this page."));
  } else if (latestQrDataUrl) {
    res.end(renderPage("Scan this QR code", latestQrDataUrl));
  } else {
    res.end(renderPage("Waiting for a fresh QR code…"));
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`QR web page listening on port ${PORT}`);
});

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  ).trim();
}

function numberFromJid(jid = "") {
  return (jid.split("@")[0] || "").replace(/\D/g, "");
}

function candidateNumbers(msg) {
  return [
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt,
  ]
    .map(numberFromJid)
    .filter(Boolean);
}

function isAllowedContact(msg) {
  return candidateNumbers(msg).some((number) => ALLOWED_NUMBERS.has(number));
}

function isSelfChat(msg, sock) {
  if (!msg?.key?.fromMe) return false;
  const ownNumber = numberFromJid(sock?.user?.id || "");
  if (!ownNumber) return false;
  return candidateNumbers(msg).includes(ownNumber);
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
            "You are a concise WhatsApp assistant. Reply naturally in the same language as the sender. Keep ordinary replies short and useful. Do not claim to be the account owner; if asked who you are, say you are their AI assistant.",
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
      connectionStatus = "waiting_for_scan";
      QRCode.toDataURL(qr, { width: 460, margin: 3 })
        .then((dataUrl) => {
          latestQrDataUrl = dataUrl;
          console.log("Fresh WhatsApp QR available on the web page");
        })
        .catch((err) => console.error("QR generation error:", err));
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQrDataUrl = "";
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

      connectionStatus = "reconnecting";
      console.log("Connection closed; reconnecting...");
      setTimeout(start, 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg?.message) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue;

        const selfChat = isSelfChat(msg, sock);
        const allowedIncoming = !msg.key.fromMe && isAllowedContact(msg);

        // Ignore everyone except whitelisted incoming contacts and your own self-chat.
        if (!allowedIncoming && !selfChat) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        let prompt = text;

        if (selfChat) {
          // Your own self-chat remains explicit/admin-only.
          if (
            TRIGGER_PREFIX &&
            !text.toLowerCase().startsWith(TRIGGER_PREFIX.toLowerCase())
          ) {
            continue;
          }
          prompt = TRIGGER_PREFIX
            ? text.slice(TRIGGER_PREFIX.length).trim()
            : text;
        } else if (
          TRIGGER_PREFIX &&
          text.toLowerCase().startsWith(TRIGGER_PREFIX.toLowerCase())
        ) {
          // Allowed contacts no longer need !ai, but strip it if they happen to use it.
          prompt = text.slice(TRIGGER_PREFIX.length).trim();
        }

        if (!prompt) continue;

        console.log(`${selfChat ? "Self-test" : "Allowed contact"} request received`);

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
