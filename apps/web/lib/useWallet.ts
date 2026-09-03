"use client";

/**
 * Connecting a browser wallet and proving it (ADR-0011, ADR-0012), as one hook.
 *
 * Extracted from `surface.ts` when the Cover surface grew a money path of its own. Both
 * contexts need exactly this and nothing more: an address, proof the session owns it, and
 * the two states in between. Copying it would have meant two versions of a security
 * handshake, which is how one of them quietly stops matching the backend.
 *
 * It holds no protocol knowledge and derives no figure. It asks `lib/wallet.ts` for a
 * signature and asks the backend to check it -- nothing else.
 */
import { useCallback, useEffect, useState } from "react";
import { requestAuthChallenge, verifyAuthChallenge } from "./api";
import { connectWallet as connectInjectedWallet, connectedAddress, signMessage } from "./wallet";

export interface WalletState {
  address: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  /** Prompts the wallet to authorise an account, then immediately proves it. */
  connect: () => Promise<void>;
  /**
   * Proves the already-connected wallet. Separate from `connect` so someone whose wallet
   * was authorised before this page loaded -- picked up by `connectedAddress()`, which
   * never prompts -- has a one-press way to finish, rather than a dead end.
   */
  verify: () => Promise<void>;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First paint: pick up a wallet the browser already authorised, without prompting.
  useEffect(() => {
    void connectedAddress().then(setAddress);
  }, []);

  /** A text signature, never a transaction, and never without the user's own press. */
  const verifyFor = useCallback(async (target: string) => {
    setVerifying(true);
    setError(null);
    try {
      const { message } = await requestAuthChallenge(target);
      const signature = await signMessage(message);
      await verifyAuthChallenge(signature);
      setVerified(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify this wallet.");
    } finally {
      setVerifying(false);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setVerified(false);
    try {
      const next = await connectInjectedWallet();
      setAddress(next);
      await verifyFor(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect a wallet.");
    } finally {
      setConnecting(false);
    }
  }, [verifyFor]);

  const verify = useCallback(
    () => (address ? verifyFor(address) : Promise.resolve()),
    [address, verifyFor]
  );

  return { address, connecting, verified, verifying, error, connect, verify };
}
