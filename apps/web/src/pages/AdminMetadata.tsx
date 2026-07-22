import { type FormEvent, type JSX, useState } from "react";
import {
  describeMetadataError,
  useMetadataConfig,
  useSaveMetadataConfig,
  useTestMetadataKey,
} from "../metadata";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

export function AdminMetadata(): JSX.Element {
  const config = useMetadataConfig();
  const testKey = useTestMetadataKey();
  const saveConfig = useSaveMetadataConfig();

  const [apiKey, setApiKey] = useState("");
  const [language, setLanguage] = useState("en-US");

  function currentInput(): { apiKey: string; language: string; enabled: boolean } {
    return { apiKey: apiKey.trim(), language: language.trim(), enabled: true };
  }

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    testKey.reset();
    await saveConfig.mutateAsync(currentInput());
    // Clear the key the moment it has been accepted. Leaving it in state
    // keeps a live credential in the page for as long as the tab stays open,
    // where it is reachable from a React devtools inspection or a later
    // accidental re-submit.
    setApiKey("");
  }

  function onTest(): void {
    saveConfig.reset();
    testKey.mutate(currentInput());
  }

  const keyMissing = apiKey.trim() === "";

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-display text-2xl text-foreground">Metadata</h1>

        <Card className="mt-6 p-8">
          <h2 className="font-display text-lg">Provider status</h2>

          {config.isPending ? <p className="mt-4">Loading…</p> : null}

          {config.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{describeMetadataError(config.error)}</AlertDescription>
            </Alert>
          ) : null}

          {config.data && !config.data.configured ? (
            <p role="status" className="mt-4 text-sm opacity-80">
              No metadata provider is configured. Harbor cannot search for titles until you add a
              TMDB API key below.
            </p>
          ) : null}

          {config.data?.configured ? (
            <dl className="mt-4 text-sm">
              <div className="flex justify-between rounded-lg bg-background p-2">
                <dt>Provider</dt>
                <dd>TMDB {config.data.enabled ? "(enabled)" : "(disabled)"}</dd>
              </div>
              <div className="mt-2 flex justify-between rounded-lg bg-background p-2">
                <dt>Metadata language</dt>
                <dd>{config.data.language}</dd>
              </div>
              <div className="mt-2 flex justify-between rounded-lg bg-background p-2">
                <dt>Last verified</dt>
                <dd>
                  {config.data.lastVerifiedAt === null
                    ? "never"
                    : new Date(config.data.lastVerifiedAt).toLocaleString()}
                </dd>
              </div>
            </dl>
          ) : null}
        </Card>

        <Card className="mt-6 p-8">
          <h2 className="font-display text-lg">
            {config.data?.configured ? "Replace the API key" : "Add a TMDB API key"}
          </h2>

          <form className="mt-4" onSubmit={onSave}>
            <Label className="block" htmlFor="apiKey">
              TMDB API Read Access Token
            </Label>
            <Input
              id="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="mt-1"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />

            <Label className="mt-4 block" htmlFor="language">
              Metadata language
            </Label>
            <Input
              id="language"
              className="mt-1"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="en-US"
            />

            <div className="mt-6 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                isDisabled={keyMissing || testKey.isPending}
                onPress={onTest}
              >
                {testKey.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button
                type="submit"
                className="flex-1"
                isDisabled={keyMissing || saveConfig.isPending}
              >
                {saveConfig.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>

          {testKey.isSuccess ? (
            <p role="status" aria-live="polite" className="mt-4 text-sm text-success">
              TMDB accepted this key. It has not been saved yet.
            </p>
          ) : null}

          {testKey.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{describeMetadataError(testKey.error)}</AlertDescription>
            </Alert>
          ) : null}

          {saveConfig.isSuccess ? (
            <p role="status" aria-live="polite" className="mt-4 text-sm text-success">
              Saved. Harbor will use this key for metadata searches.
            </p>
          ) : null}

          {saveConfig.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{describeMetadataError(saveConfig.error)}</AlertDescription>
            </Alert>
          ) : null}

          <p className="mt-6 text-xs opacity-70">
            The key is encrypted before it is stored and is never sent back to the browser.
            Changing <code>HARBOR_SECRET</code> makes the stored key unreadable, and it must then
            be entered again.
          </p>
        </Card>

        <p className="mt-6 text-xs opacity-70">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
