"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { TradingShell } from "@/components/TradingShell";
import { LaunchSequence, markLaunched, shouldLaunch } from "@/components/LaunchSequence";
import { sound } from "@/lib/sound";

export default function Page() {
  const [launching, setLaunching] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setLaunching(shouldLaunch());
    setChecked(true);
  }, []);

  // Browsers require a user gesture before audio can start, so the sound engine is
  // unlocked on the first interaction. The launch sequence is the first thing a user
  // touches, which is exactly the gesture we need.
  useEffect(() => {
    const unlock = () => {
      void sound.unlock();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  return (
    <AuthGate>
      {launching && checked ? (
        <LaunchSequence
          onDone={() => {
            markLaunched();
            setLaunching(false);
          }}
        />
      ) : null}
      <TradingShell />
    </AuthGate>
  );
}
