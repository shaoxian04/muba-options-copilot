"use client";

/**
 * The custom wallet-selection screen (design spec: not RainbowKit's or Web3Modal's own
 * themed modal). Lists whatever `listAvailableWallets()` in `lib/wallet.ts` actually
 * detected -- extensions by their own name/icon, WalletConnect always last -- and hands
 * back whichever `id` a Trader clicks. What happens with that id (connecting, and for
 * WalletConnect specifically, WalletConnect's own QR modal taking over from here) is
 * `surface.ts`'s job, not this component's.
 *
 * Shares its dialog shape with `ConfirmModal`/`RfqModal`: scrim, focus trap, Escape and
 * a backdrop click both close it.
 */
import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WalletPicker({
  open,
  wallets,
  onPick,
  onClose,
}: {
  open: boolean;
  wallets: Array<{ id: string; name: string; icon: string | null }>;
  onPick: (walletId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="scrim" data-testid="wallet-picker-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal wallet-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        data-testid="wallet-picker"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <b>Connect a wallet</b>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {wallets.length === 0 ? (
          <p className="sub2" data-testid="wallet-picker-empty">
            No wallet extension detected yet.
          </p>
        ) : (
          <ul className="wallet-list" aria-label="Wallets">
            {wallets.map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => onPick(w.id)} data-testid={`wallet-option-${w.id}`}>
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" width={24} height={24} />
                  ) : (
                    <span className="wallet-generic-mark" aria-hidden="true" />
                  )}
                  {w.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
