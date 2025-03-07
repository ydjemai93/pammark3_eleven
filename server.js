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

// *** Améliorations TTS
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "WQKwBV2Uzw1gSGr69N8I";
const ELEVENLABS_STABILITY = 0.35; // + expressif
const ELEVENLABS_SIMILARITY = 0.85; // + naturel
const BACKCHANNELS = ["D'accord", "Je vois", "Très bien", "Hmm"]; // *** Réponses courtes

// Script system
const systemMessage = `Tu es Pam, un agent téléphonique IA conçu pour démontrer les capacités de notre solution SaaS...`;

// Message initial
const initialAssistantMessage = `Bonjour ! Je suis Pam, ton agent téléphonique IA. Merci d’avoir rempli le formulaire...`;

const PORT = process.env.PORT || 8080;
let streamSid = "";
let keepAlive;
let conversation = [];

// *** Gestion améliorée des interruptions
let speaking = false;
let ttsAbort = false;
let lastUtteranceId = 0;

//------------------------------------------
// Serveur HTTP (inchangé)
//------------------------------------------
// [Le code du serveur HTTP reste identique...]

//------------------------------------------
// WebSocket /streams (inchangé)
//------------------------------------------
// [Le code WebSocket reste identique...]

//------------------------------------------
// Classe MediaStream modifiée
//------------------------------------------
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.hasSeenMedia = false;
    conversation = [{ role: "assistant", content: initialAssistantMessage }]; // *** Reset propre
    
    this.deepgram = setupDeepgram(this);
    this.connection.on("message", this.processMessage.bind(this));
    this.connection.on("close", this.close.bind(this));
  }

  async processMessage(message) {
    if (message.type === "utf8") {
      const data = JSON.parse(message.utf8Data);
      switch (data.event) {
        case "start":
          // *** Délai aléatoire avant réponse initiale
          await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
          await this.speak(initialAssistantMessage);
          break;
        // [Le reste reste inchangé...]
      }
    }
  }

  // *** Nouvelle gestion des utterances
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
      console.error("Error in speak =>", err);
    } finally {
      if (utteranceId === lastUtteranceId) speaking = false;
    }
  }

  // [sendAudioInChunks et close restent inchangés...]
}

//------------------------------------------
// *** GPT amélioré avec gestion de l'interruption
//------------------------------------------
async function callGPT(mediaStream) {
  conversation = conversation.slice(-6); // *** Garde seulement 3 derniers échanges

  const stream = openai.beta.chat.completions.stream({
    model: "gpt-3.5-turbo",
    stream: true,
    messages: [
      { role: "system", content: systemMessage },
      ...conversation,
    ],
  });

  let sentenceBuffer = "";
  let isInterrupted = false;
  let assistantReply = "";

  // *** Détection de phrases naturelles
  for await (const chunk of stream) {
    if (ttsAbort) {
      isInterrupted = true;
      break;
    }
    
    const chunkMessage = chunk.choices[0].delta.content || "";
    sentenceBuffer += chunkMessage;
    assistantReply += chunkMessage;

    // Split sur ponctuation + longueur
    const sentences = sentenceBuffer.split(/(?<=[.!?])\s+/);
    
    if (sentences.length > 1) {
      const toSpeak = sentences.slice(0, -1).join(" ");
      sentenceBuffer = sentences[sentences.length - 1];
      
      if (ttsAbort) {
        isInterrupted = true;
        break;
      }
      
      await mediaStream.speak(toSpeak);
    }
  }

  // *** Gestion post-interruption
  if (!isInterrupted) {
    if (sentenceBuffer.trim()) {
      // *** Ajout de backchannels aléatoires
      if (sentenceBuffer.length < 40 && Math.random() > 0.6) {
        sentenceBuffer = BACKCHANNELS[Math.floor(Math.random() * BACKCHANNELS.length)];
      }
      await mediaStream.speak(sentenceBuffer.trim());
    }
    conversation.push({ role: "assistant", content: assistantReply });
  } else {
    console.log("Réponse GPT interrompue - nettoyage");
    conversation.pop(); // Supprime la dernière entrée utilisateur incomplète
  }
}

//------------------------------------------
// *** Deepgram avec meilleure détection de fin
//------------------------------------------
function setupDeepgram(mediaStream) {
  const dgLive = deepgramClient.listen.live({
    model: "nova-2-general",
    language: "fr-FR",
    endpointing: 500, // *** Détection de fin améliorée
    // [Le reste des paramètres inchangés...]
  });

  dgLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
    if (data.is_final && speaking) {
      // *** Interruption plus réactive
      console.log("Interruption utilisateur détectée");
      ttsAbort = true;
      speaking = false;
      lastUtteranceId = Date.now();
      conversation.pop(); // Nettoie le contexte
    }
  });

  // [Le reste du setup Deepgram inchangé...]
}

// [Les fonctions synthesizeElevenLabs et convertToMulaw8k restent inchangées...]

//------------------------------------------
// Lancement du serveur
//------------------------------------------
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
