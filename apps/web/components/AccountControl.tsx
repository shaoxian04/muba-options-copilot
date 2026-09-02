"use client";

/**
 * The one persistent identity control, top-right, replacing what `WalletConnect.tsx`
 * used to render inside `ConfirmModal`. Walks three states in order: signed out ("Sign
 * in / Sign up", linking to `/login`) -> signed in, no wallet ("Connect wallet") ->
 * verified (the address). `ConfirmModal` no longer has its own wallet section at all --
 * it just reads whatever this control already established (ADR-0013).
 */
import Link from "next/link";

export function AccountControl({
  account,
  walletAddress,
  connecting,
  verified,
  verifying,
  error,
  onConnect,
  onVerify,
}: {
  account: { userId: string; email: string } | null;
  walletAddress: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  onConnect: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="account-control" data-testid="account-control">
      {!account ? (
        <Link href="/login" data-testid="signin-link">
          Sign in / Sign up
        </Link>
      ) : !walletAddress ? (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : verified ? (
        <span className="addr" data-testid="wallet-address">
          {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
        </span>
      ) : (
        <button type="button" onClick={onVerify} disabled={verifying} data-testid="verify-wallet">
          {verifying ? "Verifying…" : "Verify wallet"}
        </button>
      )}
      {error ? (
        <p className="refusal" role="alert" data-testid="wallet-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
