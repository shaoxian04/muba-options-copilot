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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (authError) {
      setError(authError.message);
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
      <h1>{mode === "signin" ? "Sign in" : "Sign up"}</h1>

      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        <button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button type="button" onClick={withGoogle} data-testid="login-google">
        Continue with Google
      </button>

      <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} data-testid="login-toggle">
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
      </button>

      {error ? (
        <p role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
