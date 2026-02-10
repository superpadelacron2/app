
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from '@google/genai';
import { Mic, MicOff, AlertCircle, Calendar, MessageSquare, Send, Loader2 } from 'lucide-react';
import { TranscriptionEntry, SessionStatus } from './types';
import { decode, encode, decodeAudioData, createBlob } from './utils/audio-utils';

// CONFIGURAZIONE SUPERSAAS - INSERISCI I TUOI DATI QUI
const SUPERSAAS_SCHEDULE_ID = 'INSERISCI_ID_SCHEDULE'; // Es: '787743'
const SUPERSAAS_API_KEY = 'INSERISCI_API_KEY_SUPERSAAS'; // Es: 'abc123xyz'

const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_TEXT_MODEL = 'gemini-3-flash-preview';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const audioContextIn = useRef<AudioContext | null>(null);
  const audioContextOut = useRef<AudioContext | null>(null);
  const nextStartTime = useRef<number>(0);
  const audioSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const currentInputText = useRef('');
  const currentOutputText = useRef('');

  const initAudioOut = useCallback(() => {
    if (!audioContextOut.current) {
      audioContextOut.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextOut.current.state === 'suspended') {
      audioContextOut.current.resume();
    }
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [transcriptions, isTyping]);

  const addTranscription = useCallback((entry: Omit<TranscriptionEntry, 'timestamp'>) => {
    setTranscriptions(prev => [...prev, { ...entry, timestamp: Date.now() }]);
  }, []);

  const playTTS = async (text: string) => {
    if (!text) return;
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setErrorMessage("API_KEY di Gemini mancante nelle variabili d'ambiente.");
      return;
    }

    try {
      initAudioOut();
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await ai.models.generateContent({
        model: GEMINI_TTS_MODEL,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Puck' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio && audioContextOut.current) {
        const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextOut.current, 24000, 1);
        const source = audioContextOut.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextOut.current.destination);
        
        const now = audioContextOut.current.currentTime;
        if (nextStartTime.current < now) {
          nextStartTime.current = now + 0.02;
        }
        
        source.start(nextStartTime.current);
        nextStartTime.current += audioBuffer.duration;
        
        audioSources.current.add(source);
        source.onended = () => audioSources.current.delete(source);
      }
    } catch (err) {
      console.error("TTS Error:", err);
    }
  };

  const checkSuperSaaSAvailability = async (fromTime: string) => {
    if (SUPERSAAS_API_KEY.includes('INSERISCI') || SUPERSAAS_SCHEDULE_ID.includes('INSERISCI')) {
      return "Le credenziali SuperSaaS non sono state configurate nel codice.";
    }

    try {
      const urlTime = fromTime.replace(' ', '+').substring(0, 16);
      const url = `https://www.supersaas.com/api/free/${SUPERSAAS_SCHEDULE_ID}.json?from=${urlTime}&maxresults=10&api_key=${SUPERSAAS_API_KEY}`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const data = await response.json();
      
      const slots = data.slots || [];
      if (slots.length === 0) return `Nessun campo libero trovato per le ${fromTime.substring(11, 16)}.`;

      const targetTime = new Date(fromTime.replace(' ', 'T')).getTime();
      const exactMatches = slots.filter((s: any) => new Date(s.start).getTime() === targetTime);
      
      if (exactMatches.length > 0) {
        const names = exactMatches.map((s: any) => s.name).join(', ');
        return `Sì! Ci sono ${exactMatches.length} disponibilità per le ${fromTime.substring(11, 16)}. Campi: ${names}.`;
      } else {
        const first = slots[0];
        const firstTime = first.start.replace('T', ' ').substring(11, 16);
        return `Per le ${fromTime.substring(11, 16)} non c'è posto. Il primo libero è alle ${firstTime} (${first.name}).`;
      }
    } catch (error) {
      return "Errore tecnico nella connessione a SuperSaaS.";
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isTyping) return;

    initAudioOut();
    const userMessage = inputText.trim();
    setInputText('');
    addTranscription({ type: 'user', text: userMessage });
    setIsTyping(true);
    setErrorMessage(null);

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setErrorMessage("Errore: API_KEY di Gemini non configurata.");
      setIsTyping(false);
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const chat = ai.chats.create({
        model: GEMINI_TEXT_MODEL,
        config: {
          systemInstruction: `Sei un assistente per la prenotazione campi. Oggi è il ${new Date().toLocaleDateString('it-IT')}. Usa 'check_availability' con formato 'YYYY-MM-DD HH:MM:SS'. Rispondi sempre in italiano in modo breve e naturale.`,
          tools: [{ functionDeclarations: [{
            name: 'check_availability',
            parameters: {
              type: Type.OBJECT,
              properties: { from_time: { type: Type.STRING, description: 'YYYY-MM-DD HH:MM:SS' } },
              required: ['from_time']
            }
          }]}]
        }
      });

      let response = await chat.sendMessage({ message: userMessage });
      let textToSpeak = "";

      if (response.functionCalls?.length) {
        const fc = response.functionCalls[0];
        const result = await checkSuperSaaSAvailability(fc.args.from_time as string);
        const finalResponse = await chat.sendMessage({
          message: [{ functionResponse: { name: fc.name, response: { result }, id: fc.id } }]
        });
        textToSpeak = finalResponse.text || "";
      } else {
        textToSpeak = response.text || "";
      }

      if (textToSpeak) {
        addTranscription({ type: 'model', text: textToSpeak });
        playTTS(textToSpeak);
      }
    } catch (err) {
      setErrorMessage("Errore di comunicazione con Gemini.");
    } finally {
      setIsTyping(false);
    }
  };

  const startSession = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setErrorMessage("API_KEY di Gemini mancante.");
      return;
    }

    try {
      setStatus(SessionStatus.CONNECTING);
      initAudioOut();
      audioContextIn.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey });

      const sessionPromise = ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = audioContextIn.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextIn.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(inputData) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextIn.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const inputT = message.serverContent?.inputTranscription?.text;
            const outputT = message.serverContent?.outputTranscription?.text;
            if (inputT) currentInputText.current += inputT;
            if (outputT) currentOutputText.current += outputT;
            
            if (message.serverContent?.turnComplete) {
              if (currentInputText.current) addTranscription({ type: 'user', text: currentInputText.current });
              if (currentOutputText.current) addTranscription({ type: 'model', text: currentOutputText.current });
              currentInputText.current = ''; currentOutputText.current = '';
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextOut.current) {
              const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextOut.current, 24000, 1);
              const source = audioContextOut.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioContextOut.current.destination);
              nextStartTime.current = Math.max(nextStartTime.current, audioContextOut.current.currentTime);
              source.start(nextStartTime.current);
              nextStartTime.current += audioBuffer.duration;
              audioSources.current.add(source);
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                const result = await checkSuperSaaSAvailability(fc.args.from_time as string);
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result } }
                }));
              }
            }
          },
          onclose: () => stopSession(),
          onerror: () => setStatus(SessionStatus.ERROR)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `Sei un assistente vocale rapido. Oggi è il ${new Date().toLocaleDateString('it-IT')}. Usa 'check_availability' (YYYY-MM-DD HH:MM:SS) e rispondi in italiano in modo amichevole.`,
          tools: [{ functionDeclarations: [{
            name: 'check_availability',
            parameters: {
              type: Type.OBJECT,
              properties: { from_time: { type: Type.STRING } },
              required: ['from_time']
            }
          }]}],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { setStatus(SessionStatus.ERROR); }
  };

  const stopSession = useCallback(() => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (audioContextIn.current) { audioContextIn.current.close(); audioContextIn.current = null; }
    audioSources.current.forEach(s => s.stop());
    audioSources.current.clear();
    setStatus(SessionStatus.DISCONNECTED);
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center p-4">
      <div className="w-full max-w-4xl flex justify-between items-center py-6">
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-500 p-2 rounded-lg shadow-lg">
            <Calendar className="text-white w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100">SuperSaaS Voice</h1>
        </div>
      </div>

      <main className="w-full max-w-4xl flex flex-col space-y-6 flex-1 overflow-hidden">
        <div className="bg-slate-800/40 rounded-3xl p-8 border border-slate-700/50 flex flex-col items-center shadow-2xl backdrop-blur-sm">
          <div className="relative">
            <div className={`absolute -inset-4 rounded-full blur-xl transition-all duration-700 opacity-20 ${status === SessionStatus.CONNECTED ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'}`} />
            <button
              onClick={status === SessionStatus.CONNECTED ? stopSession : startSession}
              disabled={status === SessionStatus.CONNECTING}
              className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all ${status === SessionStatus.CONNECTED ? 'bg-red-500 shadow-red-500/20 shadow-xl' : 'bg-emerald-500 hover:scale-105 shadow-emerald-500/20 shadow-2xl'}`}
            >
              {status === SessionStatus.CONNECTED ? <MicOff className="w-10 h-10 text-white" /> : <Mic className="w-10 h-10 text-white" />}
            </button>
          </div>
          <p className="mt-4 text-slate-400 font-medium tracking-tight">
            {status === SessionStatus.CONNECTED ? 'In ascolto...' : 'Parla o scrivi la tua richiesta'}
          </p>
        </div>

        <div className="flex-1 flex flex-col bg-slate-800/30 rounded-3xl border border-slate-700/50 overflow-hidden shadow-xl backdrop-blur-md">
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-6 space-y-4">
            {transcriptions.length === 0 && !isTyping ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 opacity-30 text-center">
                <MessageSquare className="w-12 h-12 mb-2" />
                <p className="text-sm">"Controlla se c'è posto domani alle 18:00"</p>
              </div>
            ) : (
              <>
                {transcriptions.map((t, idx) => (
                  <div key={idx} className={`flex flex-col ${t.type === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${t.type === 'user' ? 'bg-emerald-600 text-white rounded-tr-none' : 'bg-slate-700 text-slate-100 rounded-tl-none'}`}>
                      {t.text}
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div className="text-emerald-400 text-[10px] animate-pulse ml-2 flex items-center bg-emerald-400/10 px-3 py-1 rounded-full w-fit">
                    <Loader2 className="w-3 h-3 mr-2 animate-spin"/> Elaborazione istantanea...
                  </div>
                )}
              </>
            )}
          </div>

          <form onSubmit={handleTextSubmit} className="p-4 bg-slate-800/50 border-t border-slate-700/50 flex space-x-3">
            <input 
              type="text" value={inputText} onChange={(e) => setInputText(e.target.value)}
              placeholder="Chiedi qualcosa..."
              className="flex-1 bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 focus:ring-2 focus:ring-emerald-500 outline-none transition-all placeholder:text-slate-600"
              disabled={isTyping}
            />
            <button type="submit" disabled={!inputText.trim() || isTyping} className="bg-emerald-500 p-3 rounded-xl hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 active:scale-95 disabled:opacity-30">
              <Send className="w-5 h-5 text-white" />
            </button>
          </form>
        </div>

        {errorMessage && <div className="p-4 bg-red-900/20 text-red-400 border border-red-500/30 rounded-xl flex items-center text-xs shadow-lg animate-bounce"><AlertCircle className="w-4 h-4 mr-2"/>{errorMessage}</div>}
      </main>
    </div>
  );
};

export default App;
