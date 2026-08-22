import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Wordmark } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { LegalDisclaimer } from "@/components/legal";

export const Route = createFileRoute("/login")({ component: Login });

const AFTER = "/w";

function goHome() {
  window.location.assign("/w");
}

function Login() {
  const { user, isPending } = useCurrentUserState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (!isPending && user) return <Navigate to={AFTER} />;

  const runEmail = async (mode: "in" | "up") => {
    setError(null);
    setBusy(mode);
    try {
      if (mode === "up") {
        const { error: err } = await authClient.signUp.email({
          email: email.trim(),
          password,
          name: email.trim().split("@")[0] || "Desk",
        });
        if (err) {
          const msg = err.message ?? "Could not create the account";
          if (/already|exist/i.test(msg)) {
            throw new Error("That email is already the live bot. Tap Sign in with the same password.");
          }
          throw new Error(msg);
        }
      } else {
        const { error: err } = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (err) {
          const { error: upErr } = await authClient.signUp.email({
            email: email.trim(),
            password,
            name: email.trim().split("@")[0] || "Desk",
          });
          if (upErr) {
            throw new Error(
              "Wrong password, or that email is already this desk. Use the same password as last time. If Grok reset the preview, tap Create account, then paste keys again.",
            );
          }
        }
      }
      goHome();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-dvh bg-bg px-5 py-12">
      <div className="mx-auto w-full max-w-lg">
        <Wordmark />
        <h1 className="mt-8 font-display text-4xl font-medium tracking-tight">Open the bot</h1>
        <p className="mt-3 text-sm text-muted">
          Same email and password as last time. If Grok reset the preview, Sign in will recreate
          this desk — then paste WEEX keys again. To check trades without this chat, open the{" "}
          <span className="text-fg">WEEX</span> app (positions, SL, TPs).
        </p>

        <form
          className="mt-8 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void runEmail("in");
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pw">Password</Label>
            <Input
              id="pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null}>
              {busy === "in" ? "Signing in…" : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void runEmail("up")}
            >
              {busy === "up" ? "Creating…" : "Create account"}
            </Button>
          </div>
        </form>

        {authEnabled && (
          <div className="mt-8 grid gap-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-subtle">Or continue with</p>
            {GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setError(null);
                  setBusy(p.providerId);
                  void signIn(p.providerId, { callbackURL: AFTER, errorCallbackURL: "/login" })
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : "Sign-in failed"),
                    )
                    .finally(() => setBusy(null));
                }}
              >
                {busy === p.providerId ? "Opening…" : p.label}
              </Button>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-down">{error}</p>}

        <HowItWorks />
        <div className="mt-4">
          <LegalDisclaimer />
        </div>

        <p className="mt-8 text-xs text-subtle">
          <Link to="/" className="underline-offset-4 hover:text-fg hover:underline">
            Back to the tape
          </Link>
        </p>
      </div>
    </main>
  );
}

function HowItWorks() {
  return (
    <section className="mt-10 rounded-xl bg-surface p-5 text-sm shadow-border">
      <h2 className="text-sm font-medium">How money and trades work</h2>
      <ul className="mt-3 grid gap-2 text-muted">
        <li>
          <span className="text-fg">Deposit on WEEX only.</span> This app never holds your funds.
          There is nothing to fund here.
        </li>
        <li>
          <span className="text-fg">Trades hit your WEEX account.</span> Auto sends live cross
          futures orders through your API key. It is not a paper book and not an in-app balance.
        </li>
        <li>
          <span className="text-fg">What you give this page:</span> API key, secret, passphrase.
          Futures trade on. Withdrawals off. Equity is read from WEEX.
        </li>
        <li>
          <span className="text-fg">Arm live</span> starts the loop.{" "}
          <span className="text-fg">Kill switch</span> stops new orders. Flatten closes a ticket on
          WEEX.
        </li>
      </ul>
    </section>
  );
}
