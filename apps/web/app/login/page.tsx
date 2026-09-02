"use client";

/**
 * Sign in or sign up. The only account entry point -- reachable from the persistent
 * header control (`AccountControl.tsx`) whenever nobody is signed in. Success redirects
 * back to `/`, where `AccountControl`'s own `onAuthStateChange` subscription picks up
 * the new session automatically.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const { data, error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    /*
     * A sign-up with email confirmation required (this project's default) succeeds
     * with no `authError` but also no active session -- Supabase is waiting on the
     * confirmation link it just emailed. Redirecting to `/` here would silently land
     * the Trader back on a signed-OUT surface with no explanation at all.
     */
    if (mode === "signup" && !data.session) {
      setMessage("Check your email for a confirmation link, then sign in.");
      setMode("signin");
      return;
    }
    router.push("/");
  };

  const withGoogle = async () => {
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (authError) setError(authError.message);
    // On success the browser navigates away to Google -- nothing else to do here.
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>{mode === "signin" ? "Sign in" : "Sign up"}</h1>

        <form onSubmit={submit} className="login-form">
          <label>
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </label>
          <button type="submit" className="login-submit" disabled={busy} data-testid="login-submit">
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="login-divider" role="separator">
          <span>or</span>
        </div>

        <button type="button" className="login-google" onClick={withGoogle} data-testid="login-google">
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.61Z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"
            />
            <path
              fill="#FBBC05"
              d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33Z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58Z"
            />
          </svg>
          Sign in with Google
        </button>

        <button
          type="button"
          className="login-toggle"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          data-testid="login-toggle"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>

        {message ? (
          <p className="login-message" role="status" data-testid="login-message">
            {message}
          </p>
        ) : null}

        {error ? (
          <p className="login-error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
