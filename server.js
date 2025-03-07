require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
const WebSocket = require("ws");
const axios = require("axios");
const { spawn } = require("child_process");

// Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (accountSid && authToken) {
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log("Twilio client OK:", accountSid);
} else {
  console.warn("Twilio credentials missing => no outbound calls");
}

// Deepgram
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// OpenAI
const OpenAI = require("openai");
const openai = new OpenAI();

// -----------------------------
// TTS ElevenLabs paramètres
// -----------------------------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "WQKwBV2Uzw1gSGr69N8I";

const ELEVENLABS_STABILITY = 0.4;
const ELEVENLABS_SIMILARITY = 0.9;

const systemMessage = `Tu es Pam, un agent téléphonique IA conçu pour démontrer les capacités de notre solution SaaS...`;
const initialAssistantMessage = `Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire ! Comment puis-je t’aider aujourd’hui ?`;

const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;
let conversation = [];

let speaking = false;
let ttsAbort = false;

//------------------------------------------
// Serveur HTTP
//------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Hello, your server is running.");
  }

  if (req.method === "POST" && pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "pong" }));
  }

  if (req.method === "POST" && pathname === "/twiml") {
    try {
      const filePath = path.join(__dirname, "templates", "streams.xml");
      let streamsXML = fs.readFileSync(filePath, "utf8");
      let serverUrl = process.env.SERVER || "localhost";
      serverUrl = serverUrl.replace(/^https?:\/\//, "");
      streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(streamsXML);
    } catch (err) {
      console.error("Error reading streams.xml:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error (twiml)");
    }
  }

  if (req.method === "POST" && pathname === "/outbound") {
    console.log("POST /outbound");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      const toNumber = parsed.to;
      if (!toNumber) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "'to' missing" }));
      }
      if (!twilioClient) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Twilio not configured" }));
      }
      let domain = process.env.SERVER || "";
      if (!domain.startsWith("http")) domain = "https://" + domain;
      domain = domain.replace(/\/$/, "");
      const twimlUrl = `${domain}/twiml`;

      try {
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661";
        const call = await twilioClient.calls.create({
          to: toNumber,
          from: fromNumber,
          url: twimlUrl,
          method: "POST",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, callSid: call.sid }));
      } catch (err) {
        console.error("Twilio error =>", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

//------------------------------------------
// WebSocket /streams
//------------------------------------------
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

wsServer.on("request", (request) => {
  if (request.resourceURL.pathname.startsWith("/streams")) {
    console.log("/streams => accepted");
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("/streams => rejected");
  }
});

//------------------------------------------
// Classe MediaStream avec gestion d'erreurs
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;

    // Gestionnaire d'erreur global
    this.connection.on('error', (err) => {
      console.error("WebSocket connection error:", err);
      this.close();
    });

    conversation = [];
    conversation.push({ role: "assistant", content: initialAssistantMessage });

    this.deepgram = setupDeepgram(this);

    this.connection.on("message", this.processMessage.bind(this));
    this.connection.on("close", this.close.bind(this));
  }

  processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          console.log("twilio: connected");
          break;
        case "start":
          this.speak(initialAssistantMessage).catch((err) => console.error(err));
          break;
        case "media":
          if (!this.hasSeenMedia) {
            this.hasSeenMedia = true;
          }
          if (!streamSid) {
            streamSid = data.streamSid;
          }
          if (data.media.track === "inbound") {
            const rawAudio = Buffer.from(data.media.payload, "base64");
            this.deepgram.send(rawAudio);
          }
          break;
        case "close":
          this.close();
          break;
      }
    }
  }

  async speak(text) {
    speaking = true;
    ttsAbort = false;

    try {
      const audioBuffer = await synthesizeElevenLabs(text);
      if (ttsAbort) return;
      const mulawBuffer = await convertToMulaw8k(audioBuffer);
      if (ttsAbort) return;
      this.sendAudioInChunks(mulawBuffer);
    } catch (err) {
      console.error("Error in speak =>", err);
    } finally {
      speaking = false;
    }
  }

  sendAudioInChunks(mulawBuf, chunkSize = 4000) {
    let offset = 0;
    while (offset < mulawBuf.length && !ttsAbort) {
      const end = Math.min(offset + chunkSize, mulawBuf.length);
      const slice = mulawBuf.slice(offset, end);
      offset = end;
      const msg = {
        event: "media",
        streamSid,
        media: { payload: slice.toString("base64") },
      };
      this.connection.sendUTF(JSON.stringify(msg));
    }
  }

  close() {
    console.log("twilio: MediaStream closed");
  }
}

//------------------------------------------
// Deepgram avec gestion d'erreurs améliorée
//------------------------------------------
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-general",
    language: "fr-FR",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    no_delay: true,
    endpointing: 200,
    utterance_end_ms: 400,
    interim_results: true,
    url: "wss://api.deepgram.com/v1/listen",
  });

  // Gestionnaire d'erreur IMMÉDIAT
  dgLive.addListener(LiveTranscriptionEvents.Error, (err) => {
    console.error("deepgram STT => error", err);
    mediaStream.connection.close();
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => dgLive.keepAlive(), 10000);

  dgLive.addListener(LiveTranscriptionEvents.Open, () => {
    console.log("deepgram STT => connected");

    dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (!transcript) return;

      const wordCount = transcript.trim().split(/\s+/).length;
      const charCount = transcript.trim().length;

      if (!data.is_final) {
        if ((wordCount >= 3 || charCount > 15) && speaking) {
          speaking = false;
          ttsAbort = true;
        }
        return;
      }

      if (data.speech_final) {
        is_finals.push(transcript);
        const utterance = is_finals.join(" ");
        is_finals = [];
        conversation.push({ role: "user", content: utterance });
        callGPT(mediaStream);
      } else {
        is_finals.push(transcript);
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (is_finals.length) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        conversation.push({ role: "user", content: utterance });
        callGPT(mediaStream);
      }
    });

    dgLive.addListener(LiveTranscriptionEvents.Close, () => {
      console.log("deepgram STT => disconnected");
      clearInterval(keepAlive);
    });
  });
  return dgLive;
}

//------------------------------------------
// Reste du code inchangé
//------------------------------------------
async function callGPT(mediaStream) {
  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      { role: "system", content: systemMessage },
      ...conversation,
    ],
  });

  let assistantReply = "";
  let partialBuffer = "";

  for await (const chunk of stream) {
    if (!speaking || ttsAbort) break;
    const chunkMessage = chunk.choices[0].delta.content;
    if (chunkMessage) {
      assistantReply += chunkMessage;
      partialBuffer += chunkMessage;
      if (/[.!?]/.test(partialBuffer) && partialBuffer.length > 60) {
        const toSpeak = partialBuffer.trim();
        partialBuffer = "";
        await mediaStream.speak(toSpeak);
        if (ttsAbort) break;
      }
    }
  }
  if (partialBuffer.trim() && !ttsAbort) {
    await mediaStream.speak(partialBuffer.trim());
  }
  if (assistantReply.trim()) {
    conversation.push({ role: "assistant", content: assistantReply });
  }
  speaking = false;
}

async function synthesizeElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing");
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;
  const body = { text, model_id: "eleven_multilingual_v2", voice_settings: {
    stability: ELEVENLABS_STABILITY,
    similarity_boost: ELEVENLABS_SIMILARITY,
  }};
  const resp = await axios.post(url, body, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    responseType: "arraybuffer",
  });
  return Buffer.from(resp.data);
}

function convertToMulaw8k(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const inputFile = "temp_in.mp3";
    const outputFile = "temp_out.ulaw";
    fs.writeFileSync(inputFile, mp3Buffer);

    const ff = spawn("ffmpeg", [
      "-y", "-i", inputFile,
      "-ar", "8000", "-ac", "1", "-f", "mulaw", outputFile
    ]);

    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      const ulawData = fs.readFileSync(outputFile);
      fs.unlinkSync(inputFile);
      fs.unlinkSync(outputFile);
      resolve(ulawData);
    });

    ff.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
