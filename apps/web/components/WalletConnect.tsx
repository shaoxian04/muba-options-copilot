"use client";

/** The one control that asks a browser wallet for an address. */
export function WalletConnect({
  address,
  connecting,
  error,
  onConnect,
}: {
  address: string | null;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  return (
    <div className="wallet" data-testid="wallet-connect">
      {address ? (
        <span className="addr" data-testid="wallet-address">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      ) : (
        <button type="button" onClick={onConnect} disabled={connecting} data-testid="connect-wallet">
          {connecting ? "Connecting…" : "Connect wallet"}
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
