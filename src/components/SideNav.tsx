"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Desktop-only (`lg:` and up) left sidebar — the `lg:` counterpart to the
 * mobile `TabBar`. Unlike `TabBar` it never hides itself on immersive
 * detail routes (`/read/[id]`, `/fix/[id]`, …): at `lg:` widths there's
 * always room for it, per the wave-1 spec. It also surfaces three
 * destinations `TabBar` has no room for and that are today only reachable
 * via in-page links on mobile (Perfil, Plan, Fuentes) — those mobile links
 * are untouched; this is an additive, desktop-only path to the same routes.
 *
 * Icons for the five primary destinations intentionally match `TabBar`'s
 * glyphs (same paths, duplicated here rather than shared — `TabBar` has no
 * exported icon components and this file's icons never need to vary
 * independently of it in a way that would make the duplication costly).
 */

function BookIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
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
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
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
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
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

function ChatIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChartIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path
        d="M5 19V10.5M12 19V5M19 19v-6.5"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinecap="round"
      />
      <path d="M3.5 19.5h17" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="8.25" r="3.25" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
      <path
        d="M5 20c0-3.6 3.13-6 7-6s7 2.4 7 6"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChecklistIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
      <path
        d="M8 12.2 10.2 14.5 16 9"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CompassIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
      <path
        d="M14.75 9.25 13 13l-3.75 1.75L11 11l3.75-1.75Z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

type NavEntry = {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => React.ReactNode;
  testId: string;
};

/** Mirrors `TabBar`'s five tab destinations, in the same order. */
const PRIMARY: readonly NavEntry[] = [
  { href: "/", label: "Leer", icon: BookIcon, testId: "nav-leer" },
  { href: "/fix", label: "Escribir", icon: PencilIcon, testId: "nav-escribir" },
  { href: "/listen", label: "Escuchar", icon: HeadphonesIcon, testId: "nav-escuchar" },
  { href: "/talk", label: "Hablar", icon: ChatIcon, testId: "nav-hablar" },
  { href: "/report", label: "Reporte", icon: ChartIcon, testId: "nav-reporte" },
];

/** Destinations only reachable via in-page links on mobile — first-class nav entries here. */
const SECONDARY: readonly NavEntry[] = [
  { href: "/profile", label: "Perfil", icon: PersonIcon, testId: "nav-perfil" },
  { href: "/plan", label: "Plan", icon: ChecklistIcon, testId: "nav-plan" },
  { href: "/fuentes", label: "Fuentes", icon: CompassIcon, testId: "nav-fuentes" },
];

/**
 * Same rule as `TabBar`'s `isActive`, extended for one case `TabBar` never
 * has to handle: `TabBar` hides itself entirely on `/read/[id]` (an
 * "immersive detail view"), so its exact-match-only "/" case never gets
 * exercised there. `SideNav` stays visible on every route, including
 * `/read/[id]`, so "/" must also match `/read/*` — otherwise opening an
 * article would leave no sidebar entry highlighted at all.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/read/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ entry, active }: { entry: NavEntry; active: boolean }) {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      data-testid={entry.testId}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors " +
        (active
          ? "bg-accent-soft font-semibold text-accent-strong"
          : "font-medium text-ink-muted hover:bg-line/30 hover:text-ink")
      }
    >
      <Icon active={active} />
      {entry.label}
    </Link>
  );
}

export function SideNav() {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Navegación principal"
      className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-[230px] lg:flex-col lg:border-r lg:border-line lg:bg-paper-elevated/70 lg:px-4 lg:py-6"
    >
      <div className="px-3">
        <span className="text-base font-bold tracking-tight text-ink">Español Coach</span>
      </div>

      <nav className="mt-8 flex flex-1 flex-col gap-1">
        {PRIMARY.map((entry) => (
          <NavLink key={entry.href} entry={entry} active={isActive(pathname, entry.href)} />
        ))}

        <div className="my-3 border-t border-line" />

        {SECONDARY.map((entry) => (
          <NavLink key={entry.href} entry={entry} active={isActive(pathname, entry.href)} />
        ))}
      </nav>
    </aside>
  );
}
