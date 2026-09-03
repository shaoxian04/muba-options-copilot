/**
 * Cover route layout.
 *
 * The trading surface at `/` is a fixed-viewport terminal that manages its own
 * internal scrolling. Cover is an ordinary flowing document: a Borrower should be
 * able to scroll to the disclaimer at the bottom without needing to be told a scroll
 * trick.
 *
 * `.cover-scroll` is a flex child of `.viewport` (the shell's content area). It fills
 * that area via `flex: 1; min-height: 0` and then scrolls its own content with
 * `overflow-y: auto`. The `.cvr` class used by `page.tsx` is NOT the scroll container
 * here, deliberately — issue #44 replaces that class's markup entirely, and this layout
 * should survive that replacement unchanged.
 */
export default function CoverLayout({ children }: { children: React.ReactNode }) {
  return <div className="cover-scroll">{children}</div>;
}
