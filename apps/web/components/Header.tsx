"use client";

/**
 * Application shell header — present on every route.
 *
 * Renders the product name and a two-pill nav: Copilot (/) and Cover (/cover). The
 * active entry gets `aria-current="page"` so assistive technology announces the current
 * context without relying on colour alone. Both entries are real `<a>` elements via
 * Next's Link, so they are keyboard-operable and focusable by default.
 *
 * Copilot is treated as active for both `/` and `/insights`, because `/insights` is an
 * engine tab of the same Copilot surface, not a sibling destination. (CONTEXT-MAP.md)
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Header() {
  const pathname = usePathname();

  const isCopilot = pathname === "/" || pathname === "/insights";
  const isCover = pathname === "/cover";

  return (
    <header className="shell-header">
      <span className="brand">NutShell</span>
      <nav aria-label="Main">
        <Link href="/" aria-current={isCopilot ? "page" : undefined}>
          Copilot
        </Link>
        <Link href="/cover" aria-current={isCover ? "page" : undefined}>
          Cover
        </Link>
      </nav>
    </header>
  );
}
