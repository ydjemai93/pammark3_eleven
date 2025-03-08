require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
const axios = require("axios");
const { spawn } = require("child_process");

// Twilio Configuration
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

// Deepgram Configuration
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// OpenAI Configuration
const OpenAI = require("openai");
const openai = new OpenAI();

// ElevenLabs Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "WQKwBV2Uzw1gSGr69N8I";
const ELEVENLABS_STABILITY = 0.35;
const ELEVENLABS_SIMILARITY = 0.85;

// Conversation Settings
const systemMessage = "Tu es un agent de call center empathique, patient et professionnel. Ta mission est d’aider les clients de manière concise et chaleureuse, en proposant des solutions adaptées à leurs besoins.";
const initialAssistantMessage = "Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire...";

const CONVERSATION_HISTORY_LIMIT = 6;
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"];

const PORT = process.env.PORT || 8080;

// Flags globaux pour gérer le TTS
let speaking = false;
let ttsAbort = false;

//------------------------------------------
// Serveur HTTP
//------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

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
      console.log("streams.xml généré :", streamsXML);
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
      try {
        const parsed = JSON.parse(body);
        if (!parsed.to) throw new Error("'to' missing");
        if (!twilioClient) throw new Error("Twilio not configured");

        let domain = process.env.SERVER || "";
        if (!domain.match(/^https?:\/\//)) {
          domain = `https://${domain.replace(/^\/|\/$/g, "")}`;
        }
        const twimlUrl = `${domain}/twiml`;
        const fromNumber = process.env.TWILIO_PHONE_NUMBER || "+15017122661";
        console.log("Calling to:", parsed.to, "Twiml URL:", twimlUrl);
        const call = await twilioClient.calls.create({
          to: parsed.to,
          from: fromNumber,
          url: twimlUrl,
          method: "POST",
          timeout: 15
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, callSid: call.sid }));
      } catch (err) {
        console.error("Outbound error:", err);
        res.writeHead(err.status || 500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
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
  if (request.resourceURL.pathname.startsWith("/streams")) {
    const connection = request.accept(null, request.origin);
    new MediaStream(connection);
  } else {
    request.reject();
  }
});

//------------------------------------------
// Classe MediaStream
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.streamSid = "";
    this.active = true;
    // Conversation initiale avec le message système et le message initial
    this.conversation = [
      { role: "system", content: systemMessage },
      { role: "assistant", content: initialAssistantMessage }
    ];
    this.setupDeepgram();
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.connection.on("message", (message) => {
      if (message.type === "utf8") {
        const data = JSON.parse(message.utf8Data);
        this.handleProtocolMessage(data);
      }
    });

    this.connection.on("close", () => {
      this.active = false;
      this.deepgram.finish();
      console.log("Connection closed");
    });
  }

  handleProtocolMessage(data) {
    switch (data.event) {
      case "media":
        if (data.media.track === "inbound") {
          if (!this.streamSid) this.streamSid = data.streamSid;
          this.processAudio(data.media.payload);
        }
        break;
      case "start":
        this.startConversation();
        break;
      default:
        break;
    }
  }

  async startConversation() {
    await this.speakWithDelay(initialAssistantMessage, 1000);
  }

  async processAudio(payload) {
    try {
      const rawAudio = Buffer.from(payload, "base64");
      this.deepgram.send(rawAudio);
    } catch (err) {
      console.error("Audio processing error:", err);
    }
  }

  async speak(text) {
    if (!this.active) return;
    try {
      const audioBuffer = await this.synthesizeSpeech(text);
      if (ttsAbort) {
        console.log("speak => TTS abort triggered, skipping audio send");
        return;
      }
      const mulawBuffer = await this.convertAudio(audioBuffer);
      if (ttsAbort) return;
      this.sendAudioChunks(mulawBuffer);
    } catch (err) {
      console.error("TTS error:", err);
    }
  }

  async synthesizeSpeech(text) {
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
    return response.data;
  }

  async convertAudio(mp3Buffer) {
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
      ffmpeg.on("close", code => code === 0 
        ? resolve(Buffer.concat(chunks)) 
        : reject(new Error(`FFmpeg error ${code}`))
      );
      
      ffmpeg.stdin.write(mp3Buffer);
      ffmpeg.stdin.end();
    });
  }

  sendAudioChunks(buffer, chunkSize = 4000) {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const chunk = buffer.slice(offset, offset + chunkSize);
      this.connection.sendUTF(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunk.toString("base64") }
      }));
    }
  }

  setupDeepgram() {
    this.deepgram = deepgramClient.listen.live({
      model: "nova-2",
      language: "fr-FR",
      endpointing: 300,
      interim_results: false,
      encoding: "mulaw",
      sample_rate: 8000
    });

    this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      if (data.speech_final && data.is_final) {
        const transcript = data.channel.alternatives[0].transcript;
        this.handleUserInput(transcript);
      }
    });
  }

  async handleUserInput(transcript) {
    if (!this.active) return;
    // *** Interrompre toute réponse en cours avant de traiter le nouvel input ***
    ttsAbort = true;
    await this.sleep(200); // laisser le temps à l'ancienne réponse de s'arrêter
    this.conversation.push({ role: "user", content: transcript });
    this.conversation = this.conversation.slice(-CONVERSATION_HISTORY_LIMIT);
    ttsAbort = false; // réinitialiser pour la nouvelle réponse
    await this.generateResponse();
  }

  async generateResponse() {
    if (!this.active) return;
    speaking = true;
    ttsAbort = false;
    try {
      const stream = openai.beta.chat.completions.stream({
        model: "gpt-4o",
        temperature: 0.7,
        top_p: 0.85,
        frequency_penalty: 0.2,
        presence_penalty: 0.4,
        max_tokens: 200,
        messages: this.conversation,
        stream: true
      });

      let fullResponse = "";
      let partialBuffer = "";

      // Petite pause pour réduire la latence initiale
      await this.sleep(300 + Math.random() * 400);

      for await (const chunk of stream) {
        if (!this.active || ttsAbort) break;
        const content = chunk.choices[0]?.delta?.content || "";
        fullResponse += content;
        partialBuffer += content;
        // Dès qu'une phrase se termine et que le bloc est suffisamment long (~60 caractères)
        if (/[.!?]/.test(partialBuffer) && partialBuffer.length > 60) {
          const toSpeak = partialBuffer.trim();
          partialBuffer = "";
          await this.speakWithDelay(toSpeak, 150);
          if (ttsAbort) break;
        }
      }
      // Si un reste de texte subsiste, on le parle
      if (this.active && partialBuffer.trim() && !ttsAbort) {
        await this.speak(partialBuffer.trim());
      }
      if (fullResponse.trim() && !ttsAbort) {
        this.conversation.push({ role: "assistant", content: fullResponse });
      }
    } catch (err) {
      console.error("GPT error:", err);
      await this.speak("Je rencontre une difficulté technique, veuillez réessayer.");
    }
    speaking = false;
  }

  async speakWithDelay(text, delay = 300) {
    await this.sleep(delay);
    return this.speak(text);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

//------------------------------------------
// Démarrage du serveur
//------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!process.env.DEEPGRAM_API_KEY) console.error("DEEPGRAM_API_KEY manquant !");
  if (!ELEVENLABS_API_KEY) console.error("ELEVENLABS_API_KEY manquant !");
});
