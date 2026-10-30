"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceSettings } from "./api";

/**
 * Speech synthesis and recognition using the browser's own engines.
 *
 * What is real: speech is produced by the platform's installed voices and recognised
 * by the platform's speech engine. What is not guaranteed: a specific "Japanese"
 * voice. We select the closest available match and report the truth about which voice
 * was actually used, rather than claiming a voice the device does not have.
 */

export interface VoiceAvailability {
  synthesis: boolean;
  recognition: boolean;
  voices: SpeechSynthesisVoice[];
  japaneseVoices: SpeechSynthesisVoice[];
  selectedVoiceName: string | null;
}

export function useVoice(settings: VoiceSettings) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const synthesisAvailable = typeof window !== "undefined" && "speechSynthesis" in window;
  const recognitionAvailable =
    typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  useEffect(() => {
    if (!synthesisAvailable) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [synthesisAvailable]);

  const japaneseVoices = useMemo(() => voices.filter((v) => v.lang.toLowerCase().startsWith("ja")), [voices]);

  /** Pick the voice that best matches the requested gender and accent. */
  const selectedVoice = useMemo(() => {
    if (!voices.length) return null;
    const wantsJapanese = settings.accent.toLowerCase().includes("ja");
    const femaleHints = /female|kyoko|nanami|samantha|victoria|karen|moira|tessa|zira|google 日本語|kyoko/i;
    const maleHints = /male|otoya|hattori|daniel|alex|fred|tom|david|google 日本語/i;
    const genderMatch = voices.filter((v) => (settings.voice === "female" ? femaleHints.test(v.name) : maleHints.test(v.name)));
    if (wantsJapanese && japaneseVoices.length) {
      const genderJapanese = genderMatch.filter((v) => v.lang.toLowerCase().startsWith("ja"));
      return genderJapanese[0] ?? japaneseVoices[0]!;
    }
    if (genderMatch.length) return genderMatch[0]!;
    return voices.find((v) => v.default) ?? voices[0]!;
  }, [voices, japaneseVoices, settings.voice, settings.accent]);

  const availability: VoiceAvailability = {
    synthesis: synthesisAvailable,
    recognition: recognitionAvailable,
    voices,
    japaneseVoices,
    selectedVoiceName: selectedVoice?.name ?? null,
  };

  const speak = useCallback(
    (text: string): boolean => {
      if (!settings.enabled || !synthesisAvailable || !text.trim()) return false;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = settings.rate;
      utterance.pitch = settings.pitch;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
      return true;
    },
    [settings.enabled, settings.rate, settings.pitch, selectedVoice, synthesisAvailable],
  );

  const stopSpeaking = useCallback(() => {
    if (synthesisAvailable) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [synthesisAvailable]);

  const startListening = useCallback(
    (onResult: (text: string) => void) => {
      if (!recognitionAvailable) {
        setRecognitionError("Speech recognition is not available in this browser.");
        return false;
      }
      const Ctor = (window.SpeechRecognition ?? window.webkitSpeechRecognition) as typeof SpeechRecognition;
      const recognition = new Ctor();
      recognition.continuous = !settings.pushToTalk;
      recognition.interimResults = true;
      recognition.lang = settings.accent.toLowerCase().includes("ja") ? "ja-JP" : "en-US";
      recognition.onresult = (event) => {
        let finalText = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          if (result.isFinal) finalText += result[0]!.transcript;
          else interim += result[0]!.transcript;
        }
        setTranscript(interim || finalText);
        if (finalText.trim()) {
          onResult(finalText.trim());
          setTranscript("");
        }
      };
      recognition.onerror = (event) => {
        setRecognitionError(`${event.error}${event.message ? `: ${event.message}` : ""}`);
        setListening(false);
      };
      recognition.onend = () => {
        setListening(false);
        recognitionRef.current = null;
      };
      recognitionRef.current = recognition;
      setRecognitionError(null);
      setListening(true);
      recognition.start();
      return true;
    },
    [recognitionAvailable, settings.pushToTalk, settings.accent],
  );

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (synthesisAvailable) window.speechSynthesis.cancel();
    };
  }, [synthesisAvailable]);

  return {
    availability,
    speak,
    stopSpeaking,
    speaking,
    listening,
    startListening,
    stopListening,
    transcript,
    recognitionError,
  };
}
