import type { JSX } from "react";

export function Setup(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="text-2xl font-display">Welcome to Harbor</h1>
        <p className="mt-3 text-sm opacity-80">
          This server has not been set up yet. The onboarding wizard arrives in Phase 2.
        </p>
      </div>
    </main>
  );
}
