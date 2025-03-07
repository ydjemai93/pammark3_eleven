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

// ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "WQKwBV2Uzw1gSGr69N8I";
const ELEVENLABS_STABILITY = 0.35;
const ELEVENLABS_SIMILARITY = 0.85;
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"];

// Configuration
const systemMessage = `Tu es Pam, un agent téléphonique IA...`;
const initialAssistantMessage = `Bonjour ! Je suis Pam, ton agent téléphonique IA...`;
const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;
let conversation = [];
let speaking = false;
let ttsAbort = false;
let lastUtteranceId = 0;

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
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      // ... (Garder le code Twilio original ici)
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

//------------------------------------------
// WebSocket Server
//------------------------------------------
const wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false,
});

wsServer.on("request", (request) => {
  if (request.resourceURL.pathname === "/streams") {
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
  }
});

//------------------------------------------
// MediaStream Class
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;
    conversation = [{ role: "assistant", content: initialAssistantMessage }];
    this.deepgram = setupDeepgram(this);
    this.connection.on("message", this.processMessage.bind(this));
    this.connection.on("close", this.close.bind(this));
  }

  async processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "connected":
          console.log("Connected:", data);
          break;
        case "start":
          await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
          await this.speak(initialAssistantMessage);
          break;
        case "media":
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
    const utteranceId = Date.now();
    lastUtteranceId = utteranceId;
    speaking = true;
    ttsAbort = false;

    try {
      const audioBuffer = await synthesizeElevenLabs(text);
      if (ttsAbort || utteranceId !== lastUtteranceId) return;

      const mulawBuffer = await convertToMulaw8k(audioBuffer);
      if (ttsAbort || utteranceId !== lastUtteranceId) return;

      this.sendAudioInChunks(mulawBuffer);
    } catch (err) {
      console.error("Speak error:", err);
    } finally {
      if (utteranceId === lastUtteranceId) speaking = false;
    }
  }

  sendAudioInChunks(mulawBuf, chunkSize = 4000) {
    let offset = 0;
    while (offset < mulawBuf.length && !ttsAbort) {
      const slice = mulawBuf.slice(offset, offset + chunkSize);
      offset += chunkSize;
      const msg = {
        event: "media",
        streamSid,
        media: { payload: slice.toString("base64") },
      };
      this.connection.sendUTF(JSON.stringify(msg));
    }
  }

  close() {
    console.log("Connection closed");
  }
}

//------------------------------------------
// GPT Functions
//------------------------------------------
async function callGPT(mediaStream) {
  conversation = conversation.slice(-6);
  
  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemMessage },
      ...conversation
    ],
    stream: true
  });

  let sentenceBuffer = "";
  let isInterrupted = false;
  let assistantReply = "";

  for await (const chunk of stream) {
    if (ttsAbort) {
      isInterrupted = true;
      break;
    }
    
    const chunkMessage = chunk.choices[0]?.delta?.content || "";
    sentenceBuffer += chunkMessage;
    assistantReply += chunkMessage;

    const sentences = sentenceBuffer.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) {
      const toSpeak = sentences.slice(0, -1).join(" ");
      sentenceBuffer = sentences[sentences.length - 1];
      await mediaStream.speak(toSpeak);
    }
  }

  if (!isInterrupted && sentenceBuffer.trim()) {
    if (sentenceBuffer.length < 40 && Math.random() > 0.6) {
      sentenceBuffer = BACKCHANNELS[Math.floor(Math.random() * BACKCHANNELS.length)];
    }
    await mediaStream.speak(sentenceBuffer.trim());
    conversation.push({ role: "assistant", content: assistantReply });
  }
}

//------------------------------------------
// TTS Functions
//------------------------------------------
async function synthesizeElevenLabs(text) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: ELEVENLABS_STABILITY,
        similarity_boost: ELEVENLABS_SIMILARITY
      }
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      responseType: "arraybuffer"
    }
  );
  return Buffer.from(response.data);
}

function convertToMulaw8k(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "8000",
      "-ac", "1",
      "-f", "mulaw",
      "pipe:1"
    ]);

    const chunks = [];
    ffmpeg.stdout.on("data", chunk => chunks.push(chunk));
    ffmpeg.on("close", code => {
      code === 0 
        ? resolve(Buffer.concat(chunks)) 
        : reject(new Error(`FFmpeg failed with code ${code}`));
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

//------------------------------------------
// Deepgram Setup
//------------------------------------------
function setupDeepgram(mediaStream) {
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-general",
    language: "fr-FR",
    endpointing: 500,
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1
  });

  dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
    if (data.is_final && speaking) {
      ttsAbort = true;
      speaking = false;
      lastUtteranceId = Date.now();
      conversation.pop();
    }
  });

  return dgLive;
}

//------------------------------------------
// Start Server
//------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
