require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { server: WebSocketServer } = require("websocket");
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

// ElevenLabs Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "WQKwBV2Uzw1gSGr69N8I";
const ELEVENLABS_STABILITY = 0.35;
const ELEVENLABS_SIMILARITY = 0.85;

// Conversation Settings
const systemMessage = "Tu es un agent de call center empathique, patient et professionnel. Ta mission est d’aider les clients de manière concise et chaleureuse, en proposant des solutions adaptées à leurs besoins.";
const initialAssistantMessage = "Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire...";
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"];
const CONVERSATION_HISTORY_LIMIT = 6;

const PORT = process.env.PORT || 8080;

// ... [Le code du serveur HTTP reste identique jusqu'à la classe MediaStream]

//------------------------------------------
// Classe MediaStream modifiée
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.streamSid = "";
    this.active = true;
    this.conversation = [
      { role: "system", content: systemMessage },
      { role: "assistant", content: initialAssistantMessage }
    ];
    
    this.setupDeepgram();
    this.setupEventHandlers();
  }

  // ... [Les autres méthodes restent identiques jusqu'à generateResponse]

  //------------------------------------------
  // Nouvelle version de generateResponse
  //------------------------------------------
  async generateResponse() {
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
      let isInterrupted = false;

      // Délai naturel avant réponse
      await this.sleep(300 + Math.random() * 400);

      for await (const chunk of stream) {
        if (!this.active) break;
        
        const content = chunk.choices[0]?.delta?.content || "";
        fullResponse += content;
        partialBuffer += content;

        // Déclenchement TTS plus réactif
        if (/[.!?]/.test(partialBuffer) && partialBuffer.length > 60) {
          const toSpeak = partialBuffer.trim();
          partialBuffer = "";
          await this.speakWithDelay(toSpeak, 150);
          if (!this.active) break;
        }
      }

      // Gestion du reste du buffer
      if (this.active && partialBuffer.trim()) {
        if (partialBuffer.length < 40 && Math.random() > 0.5) {
          partialBuffer = this.randomBackchannel();
        }
        await this.speak(partialBuffer.trim());
        this.conversation.push({ role: "assistant", content: fullResponse });
      }
    } catch (err) {
      console.error("GPT error:", err);
      await this.speak("Je rencontre une difficulté technique, veuillez réessayer.");
    }
  }

  // ... [Les méthodes utilitaires restent identiques]
}

//------------------------------------------
// Fonctions utilitaires TTS ElevenLabs
//------------------------------------------
async function synthesizeElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing");
  }
  
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

// ... [Le reste du code reste inchangé]
