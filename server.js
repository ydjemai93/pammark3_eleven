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
const ELEVENLABS_STABILITY = 0.35; // Plus naturel
const ELEVENLABS_SIMILARITY = 0.85; // Plus expressif
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"]; // Réponses courtes

// Configuration
const systemMessage = `Tu es Pam, un agent téléphonique IA conçu pour démontrer les capacités de notre solution SaaS...`;
const initialAssistantMessage = `Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire...`;
const PORT = process.env.PORT || 8080;

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
        console.log("calling =>", toNumber, "from=>", fromNumber, "url=>", twimlUrl);
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
  if (request.resourceURL.pathname === "/streams") {
    console.log("/streams => accepted");
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("/streams => rejected");
  }
});

//------------------------------------------
// Classe MediaStream améliorée
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.streamSid = "";
    this.activeUtteranceId = 0;
    this.conversation = [{ role: "assistant", content: initialAssistantMessage }];
    this.deepgram = this.setupDeepgram();
    
    this.connection.on("message", this.processMessage.bind(this));
    this.connection.on("close", this.close.bind(this));
  }

  processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "start":
          this.streamSid = data.streamSid;
          this.speakWithDelay(initialAssistantMessage);
          break;
        case "media":
          if (data.media.track === "inbound") {
            const rawAudio = Buffer.from(data.media.payload, "base64");
            this.deepgram.send(rawAudio);
          }
          break;
      }
    }
  }

  async speakWithDelay(text) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return this.speak(text);
  }

  async speak(text) {
    const utteranceId = Date.now();
    this.activeUtteranceId = utteranceId;
    
    try {
      const audioBuffer = await synthesizeElevenLabs(text);
      if (this.activeUtteranceId !== utteranceId) return;

      const mulawBuffer = await convertToMulaw8k(audioBuffer);
      if (this.activeUtteranceId !== utteranceId) return;

      this.sendAudioInChunks(mulawBuffer);
    } catch (err) {
      console.error("Speak error:", err);
    }
  }

  sendAudioInChunks(mulawBuf, chunkSize = 4000) {
    let offset = 0;
    while (offset < mulawBuf.length && this.activeUtteranceId === Date.now()) {
      const slice = mulawBuf.slice(offset, offset + chunkSize);
      offset += chunkSize;
      
      const msg = {
        event: "media",
        streamSid: this.streamSid,
        media: { payload: slice.toString("base64") },
      };
      this.connection.sendUTF(JSON.stringify(msg));
    }
  }

  setupDeepgram() {
    const dgLive = deepgramClient.listen.live({
      model: "nova-2-general",
      language: "fr-FR",
      endpointing: 250,
      utterance_end_ms: 600,
      interim_results: true,
      encoding: "mulaw",
      sample_rate: 8000
    });

    dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      if (data.is_final && data.speech_final) {
        const transcript = data.channel.alternatives[0].transcript;
        console.log("User said:", transcript);
        
        // Interruption de l'audio en cours
        this.activeUtteranceId = Date.now();
        this.conversation.push({ role: "user", content: transcript });
        this.processResponse();
      }
    });

    return dgLive;
  }

  async processResponse() {
    await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 400));
    await callGPT(this);
  }

  close() {
    console.log("Connection closed");
    this.deepgram.finish();
  }
}

//------------------------------------------
// GPT amélioré avec gestion conversationnelle
//------------------------------------------
async function callGPT(mediaStream) {
  const context = mediaStream.conversation.slice(-4);
  
  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    temperature: 0.7,
    messages: [
      { role: "system", content: systemMessage },
      ...context
    ],
    stream: true
  });

  let fullResponse = "";
  let sentenceBuffer = "";

  try {
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      fullResponse += content;
      sentenceBuffer += content;

      // Découpage naturel des phrases
      const sentences = sentenceBuffer.split(/(?<=[.!?])\s+/);
      if (sentences.length > 1) {
        const toSpeak = sentences.slice(0, -1).join(" ");
        sentenceBuffer = sentences[sentences.length - 1];
        await mediaStream.speak(toSpeak);
      }
    }

    // Gestion des réponses courtes
    if (sentenceBuffer.trim()) {
      if (sentenceBuffer.length < 50 && Math.random() > 0.5) {
        sentenceBuffer = BACKCHANNELS[Math.floor(Math.random() * BACKCHANNELS.length)];
      }
      await mediaStream.speak(sentenceBuffer.trim());
    }

    mediaStream.conversation.push({ role: "assistant", content: fullResponse });
  } catch (err) {
    console.error("GPT Error:", err);
    await mediaStream.speak("Je rencontre un petit problème, pourriez-vous répéter ?");
  }
}

//------------------------------------------
// TTS Functions optimisées
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
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(`FFmpeg error ${code}`);
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

//------------------------------------------
// Lancement du serveur
//------------------------------------------
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
