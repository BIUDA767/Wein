"use client";

import { AuthGate } from "@/components/AuthGate";
import { TradingShell } from "@/components/TradingShell";

export default function Page() {
  return (
    <AuthGate>
      <TradingShell />
    </AuthGate>
  );
}
