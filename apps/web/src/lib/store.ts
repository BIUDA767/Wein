"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiFailure,
  type EngineStatus,
  type Instrument,
  type RiskConfig,
  type StrategyRecord,
  type VoiceSettings,
  type BrokerRecord,
  type NotificationRecord,
  type UiPreferences,
} from "./api";

export interface ToastMessage {
  id: number;
  text: string;
  tone: "neutral" | "good" | "bad" | "warn";
}

let toastSeq = 0;

/**
 * Single source of truth for the trading shell. Every value here is fetched from the
 * API; nothing is fabricated. Polling stops when the tab is hidden to avoid waste.
 */
export function useAppState(enabled: boolean) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [brokers, setBrokers] = useState<BrokerRecord[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [voice, setVoice] = useState<VoiceSettings | null>(null);
  const [prefs, setPrefs] = useState<UiPreferences | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const notify = useCallback((text: string, tone: ToastMessage["tone"] = "neutral") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, text, tone }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [engineRes, riskRes, stratRes, brokerRes, notifRes, voiceRes, prefRes] = await Promise.all([
        api.get<EngineStatus>("/api/engine/status"),
        api.get<{ config: RiskConfig }>("/api/risk"),
        api.get<{ strategies: StrategyRecord[] }>("/api/strategies"),
        api.get<{ brokers: BrokerRecord[] }>("/api/brokers"),
        api.get<{ notifications: NotificationRecord[] }>("/api/notifications?unread=true"),
        api.get<{ voice: VoiceSettings }>("/api/phirst/voice"),
        api.get<{ preferences: UiPreferences }>("/api/preferences"),
      ]);
      setEngine(engineRes);
      setRisk(riskRes.config);
      setStrategies(stratRes.strategies);
      setBrokers(brokerRes.brokers);
      setNotifications(notifRes.notifications);
      setVoice(voiceRes.voice);
      setPrefs(prefRes.preferences);
      setConnected(true);
      setLastError(null);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        setConnected(false);
      } else {
        setLastError((err as Error).message);
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, 4000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? (void refresh(), start()) : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  const loadInstruments = useCallback(async () => {
    try {
      const res = await api.get<{ instruments: Instrument[] }>("/api/market/instruments");
      setInstruments(res.instruments);
      return res.instruments;
    } catch (err) {
      notify(`Could not load instruments: ${(err as Error).message}`, "bad");
      return [];
    }
  }, [notify]);

  return {
    engine,
    risk,
    setRisk,
    strategies,
    brokers,
    instruments,
    notifications,
    voice,
    setVoice,
    prefs,
    setPrefs,
    connected,
    setConnected,
    lastError,
    loading,
    refresh,
    notify,
    toasts,
    dismissToast,
    loadInstruments,
  };
}

export type AppState = ReturnType<typeof useAppState>;
