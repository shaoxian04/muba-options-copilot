"use client";

/**
 * The one persistent identity control, top-right, replacing what `WalletConnect.tsx`
 * used to render inside `ConfirmModal`. Walks three states in order: signed out ("Sign
 * in / Sign up", linking to `/login`) -> signed in, no wallet ("Connect wallet") ->
 * verified (the address). `ConfirmModal` no longer has its own wallet section at all --
 * it just reads whatever this control already established (ADR-0013).
 *
 * The avatar sits alongside those three states, not in place of them -- it is purely
 * an identity/logout affordance and has no bearing on wallet gating.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function AccountControl({
  account,
  onSignOut,
  walletAddress,
  connecting,
  verified,
  verifying,
  error,
  onOpenWalletPicker,
  onVerify,
}: {
  account: { userId: string; email: string; avatarUrl: string | null } | null;
  onSignOut: () => void;
  walletAddress: string | null;
  connecting: boolean;
  verified: boolean;
  verifying: boolean;
  error: string | null;
  onOpenWalletPicker: () => void;
  onVerify: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // A Google photo URL can 404, get CORS-blocked, or otherwise fail to load -- an
  // <img> left in that state renders the browser's own broken-image glyph inside the
  // circle rather than nothing, which reads as a rendering bug. Falling back to the
  // same letter avatar email/password accounts already use is the honest failure mode.
  useEffect(() => {
    setPhotoFailed(false);
  }, [account?.avatarUrl]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="account-control" data-testid="account-control">
      {!account ? (
        <Link href="/login" data-testid="signin-link">
          Sign in / Sign up
        </Link>
      ) : (
        <>
          {!walletAddress ? (
            <button type="button" onClick={onOpenWalletPicker} disabled={connecting} data-testid="connect-wallet">
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

          <div className="account-avatar-wrap" ref={menuRef}>
            <button
              type="button"
              className="account-avatar"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              data-testid="account-avatar"
            >
              <span className="account-avatar-circle">
                {account.avatarUrl && !photoFailed ? (
                  // The one deliberate <img> on this surface: a third-party OAuth photo,
                  // never a figure a Trader reads (ADR-0006 governs numbers, not avatars).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={account.avatarUrl}
                    alt=""
                    width={32}
                    height={32}
                    referrerPolicy="no-referrer"
                    onError={() => setPhotoFailed(true)}
                  />
                ) : (
                  <span aria-hidden="true">{account.email.slice(0, 1).toUpperCase() || "?"}</span>
                )}
              </span>
            </button>

            {menuOpen ? (
              <div className="account-menu" role="menu" data-testid="account-menu">
                <p className="account-menu-email">{account.email}</p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut();
                  }}
                  data-testid="account-logout"
                >
                  Log out
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
      {error ? (
        <p className="refusal" role="alert" data-testid="wallet-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
