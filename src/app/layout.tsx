import type { Metadata, Viewport } from "next";
import { TabBar } from "@/components/TabBar";
import { SideNav } from "@/components/SideNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Español Coach",
  description: "Entrenador personal de español mexicano B2→C1",
  applicationName: "Español Coach",
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Español",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f2e7" },
    { media: "(prefers-color-scheme: dark)", color: "#1a130c" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      {/*
        Mobile: `body` itself used to carry `mx-auto max-w-md`, capping and
        centering the whole app as one phone-width column. That constraint
        now lives on this inner wrapper div instead, one level down — at
        every width below `lg:` the wrapper renders the exact same box
        (same classes, just moved down a level), so mobile output is
        unchanged. At `lg:` the wrapper drops the cap (`lg:max-w-none`) and
        offsets past the fixed sidebar (`lg:pl-[230px]`), letting each page
        own its own desktop-width content region instead of being frozen
        into one shared phone column.

        `SideNav`/`TabBar` are unaffected by this move: both already escape
        `body`'s own box via `position: fixed` (see their doc comments), so
        they never depended on which element carried the width cap.
      */}
      <body className="min-h-dvh antialiased">
        <SideNav />
        <div className="mx-auto min-h-dvh max-w-md lg:mx-0 lg:max-w-none lg:pl-[230px]">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
