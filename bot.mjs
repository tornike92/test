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
let latestPairingCode = "";
let pairingError = "";
let connectionStatus = "starting";
let activeSocket = null;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPage(message, image = "") {
  const connected = connectionStatus === "connected";
  const codeBlock = latestPairingCode
    ? `<div class="pairbox"><div class="label">PAIRING CODE</div><div class="code">${escapeHtml(latestPairingCode)}</div><p>On your phone: WhatsApp → Settings → Linked Devices → Link a Device → <b>Link with phone number instead</b> → enter this code.</p></div>`
    : "";
  const errorBlock = pairingError
    ? `<div class="error">${escapeHtml(pairingError)}</div>`
    : "";
  const pairForm = connected
    ? ""
    : `<form method="post" action=""><label>Your WhatsApp number</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. +33 6 12 34 56 78" required><button type="submit">Generate pairing code</button></form>`;
  const qrBlock = !connected && image
    ? `<details><summary>Use QR instead</summary><img src="${image}" alt="WhatsApp QR code"><p class="hint">WhatsApp → Settings → Linked Devices → Link a Device.</p></details>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>WhatsApp Link</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f8;color:#111}.card{background:white;padding:28px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:560px;width:calc(100% - 40px)}h1{text-align:center;margin-top:0}.status{text-align:center;font-size:18px;margin:8px 0 20px}.hint{color:#666;line-height:1.5}form{display:grid;gap:10px;margin:18px 0}label{font-weight:600}input{font:inherit;padding:13px 14px;border:1px solid #ccc;border-radius:10px}button{font:inherit;font-weight:700;padding:13px 14px;border:0;border-radius:10px;background:#111;color:#fff;cursor:pointer}.pairbox{background:#f3f4f6;border-radius:14px;padding:18px;margin:18px 0;text-align:center}.label{font-size:12px;font-weight:700;letter-spacing:.12em;color:#666}.code{font:700 32px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;margin:8px 0 12px}.error{background:#fff1f2;color:#9f1239;border-radius:10px;padding:12px;margin:12px 0}details{margin-top:20px}summary{cursor:pointer;font-weight:600}img{display:block;width:min(420px,90vw);height:auto;margin:14px auto 0}</style></head><body><div class="card"><h1>WhatsApp Bot</h1><div class="status">${message}</div>${errorBlock}${codeBlock}${pairForm}${qrBlock}</div></body></html>`;
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (QR_PAGE_TOKEN && url.searchParams.get("token") !== QR_PAGE_TOKEN) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (req.method === "POST") {
    try {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const phone = (params.get("phone") || "").replace(/\D/g, "");

      if (phone.length < 8 || phone.length > 15) {
        throw new Error("Enter your full WhatsApp number including country code.");
      }
      if (!activeSocket) {
        throw new Error("WhatsApp socket is still starting. Try again in a few seconds.");
      }

      pairingError = "";
      latestPairingCode = "";
      await activeSocket.waitForSocketOpen();
      latestPairingCode = await activeSocket.requestPairingCode(phone);
      connectionStatus = "pairing_code_ready";
      console.log("WhatsApp pairing code generated");
    } catch (err) {
      pairingError = err?.message || "Could not generate pairing code.";
      console.error("Pairing code error:", pairingError);
    }
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  if (connectionStatus === "connected") {
    res.end(renderPage("✅ WhatsApp connected. You can close this page."));
  } else if (latestPairingCode) {
    res.end(renderPage("Enter the pairing code in WhatsApp."));
  } else if (latestQrDataUrl) {
    res.end(renderPage("Link with your phone number below.", latestQrDataUrl));
  } else {
    res.end(renderPage("Waiting for WhatsApp connection…"));
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp link page listening on port ${PORT}`);
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

function candidateJids(msg) {
  return [
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt,
  ].filter(Boolean);
}

function candidateNumbers(msg) {
  return candidateJids(msg).map(numberFromJid).filter(Boolean);
}

async function isAllowedContact(msg, sock) {
  if (candidateNumbers(msg).some((number) => ALLOWED_NUMBERS.has(number))) {
    return true;
  }

  for (const jid of candidateJids(msg)) {
    if (!jid.includes("@lid")) continue;

    try {
      const phoneJid = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (phoneJid && ALLOWED_NUMBERS.has(numberFromJid(phoneJid))) {
        return true;
      }
    } catch {
      console.warn("Could not resolve WhatsApp LID for allowlist");
    }
  }

  return false;
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
  activeSocket = sock;

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
      console.log("WhatsApp credentials saved");
    } catch (err) {
      console.error("Credential save error:", err);
    }
  });

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr && !latestPairingCode) {
      connectionStatus = "waiting_for_link";
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
      latestPairingCode = "";
      pairingError = "";
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
      latestPairingCode = "";
      activeSocket = null;
      console.log(`Connection closed (${statusCode || "unknown"}); reconnecting...`);
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
        const allowedIncoming = !msg.key.fromMe && await isAllowedContact(msg, sock);

        if (!allowedIncoming && !selfChat) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        let prompt = text;

        if (selfChat) {
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
