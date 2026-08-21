"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Immersive detail views (reading, results, dictation) hide the tab bar entirely. */
function isHidden(pathname: string): boolean {
  if (pathname.startsWith("/read/")) return true;
  if (pathname.startsWith("/fix/") && pathname !== "/fix/write") return true;
  if (pathname.startsWith("/listen/") && pathname !== "/listen/add") return true;
  return false;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function BookIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path
        d="M4 5.5C4 4.67 4.67 4 5.5 4H11a2 2 0 0 1 2 2v13.5a1.5 1.5 0 0 0-1.5-1.5H4V5.5Z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
      />
      <path
        d="M20 5.5c0-.83-.67-1.5-1.5-1.5H13a2 2 0 0 0-2 2v13.5a1.5 1.5 0 0 1 1.5-1.5H20V5.5Z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PencilIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path
        d="M14.5 5.5 18.5 9.5 8 20H4v-4L14.5 5.5Z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
      />
      <path d="M12.5 7.5 16.5 11.5" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" />
    </svg>
  );
}

function HeadphonesIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path
        d="M4.5 14V12a7.5 7.5 0 0 1 15 0v2"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinecap="round"
      />
      <rect
        x="3.25"
        y="13.25"
        width="4"
        height="6.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
      />
      <rect
        x="16.75"
        y="13.25"
        width="4"
        height="6.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
      />
    </svg>
  );
}

const TABS = [
  { href: "/", label: "Leer", icon: BookIcon, testId: "tab-leer" },
  { href: "/fix", label: "Escribir", icon: PencilIcon, testId: "tab-escribir" },
  { href: "/listen", label: "Escuchar", icon: HeadphonesIcon, testId: "tab-escuchar" },
] as const;

/**
 * Fixed bottom tab bar (Leer / Escribir / Escuchar). Rendered inside a
 * full-viewport-width fixed wrapper, then re-centered to a max-w-md inner
 * column — same escape-the-ancestor-column technique as `FabWrapper` on the
 * home page, for the same reason (position:fixed ignores body's own
 * `max-w-md`). Hidden on immersive detail views (`/read/[id]`, `/fix/[id]`,
 * `/listen/[id]`).
 */
export function TabBar() {
  const pathname = usePathname();
  if (isHidden(pathname)) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <nav
        aria-label="Navegación principal"
        className="pointer-events-auto flex h-16 w-full max-w-md items-stretch border-t border-line bg-paper-elevated/95 backdrop-blur"
      >
        {TABS.map(({ href, label, icon: Icon, testId }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={testId}
              aria-current={active ? "page" : undefined}
              className="flex flex-1 flex-col items-center justify-center gap-1"
            >
              <span className={active ? "text-accent" : "text-ink-muted"}>
                <Icon active={active} />
              </span>
              <span className={active ? "text-xs font-semibold text-accent" : "text-xs font-medium text-ink-muted"}>
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
