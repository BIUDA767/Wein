"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceSettings } from "./api";
import { buildVisemeTimeline, indexForChar, type VisemeStep } from "./visemes";

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

  /**
   * Live speech timeline, sampled per animation frame by the avatar.
   *
   * Kept in a ref rather than state so lip-sync runs at display refresh rate without
   * re-rendering React on every frame. `anchorIndex`/`anchorTime` are re-set each time
   * the engine reports a real word boundary, so the mouth follows the actual speech and
   * corrects itself instead of drifting.
   */
  const speechRef = useRef({
    steps: [] as VisemeStep[],
    anchorIndex: 0,
    anchorTime: 0,
    rate: 0.012, // viseme steps per millisecond
    active: false,
  });

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

      // Build the viseme timeline and a nominal pace. The pace is only a starting
      // estimate; boundary events below re-anchor it against the real speech.
      const steps = buildVisemeTimeline(text);
      const nominalMs = Math.max(600, (text.length / 13.5) * 1000 / Math.max(0.5, settings.rate));
      speechRef.current = {
        steps,
        anchorIndex: 0,
        anchorTime: performance.now(),
        rate: steps.length / nominalMs,
        active: true,
      };

      utterance.onstart = () => {
        speechRef.current.anchorTime = performance.now();
        speechRef.current.anchorIndex = 0;
        setSpeaking(true);
      };
      // The engine tells us which character it has reached; snap the timeline to it.
      utterance.onboundary = (event) => {
        if (typeof event.charIndex !== "number") return;
        speechRef.current.anchorIndex = indexForChar(speechRef.current.steps, event.charIndex);
        speechRef.current.anchorTime = performance.now();
      };
      utterance.onend = () => {
        speechRef.current.active = false;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        speechRef.current.active = false;
        setSpeaking(false);
      };
      window.speechSynthesis.speak(utterance);
      return true;
    },
    [settings.enabled, settings.rate, settings.pitch, selectedVoice, synthesisAvailable],
  );

  const stopSpeaking = useCallback(() => {
    if (synthesisAvailable) window.speechSynthesis.cancel();
    speechRef.current.active = false;
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
    /** Sampled per animation frame by the avatar for lip synchronisation. */
    speechRef,
  };
}
