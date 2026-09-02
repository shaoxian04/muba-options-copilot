"use client";

/** The control that asks a browser wallet for an address, then proves it (ADR-0012). */
export function WalletConnect({
  address,
  connecting,
  verified,
  verifying,
  error,
  onConnect,
  onVerify,
}: {
  address: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  onConnect: () => void;
  onVerify: () => void;
}) {
  return (
    <div className="wallet" data-testid="wallet-connect">
      {!address ? (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : verified ? (
        <span className="addr" data-testid="wallet-address">
          {address.slice(0, 6)}…{address.slice(-4)}
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
