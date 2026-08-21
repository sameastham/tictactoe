import type { Metadata, Viewport } from "next";
import { TabBar } from "@/components/TabBar";
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
      <body className="mx-auto min-h-dvh max-w-md antialiased">
        {children}
        <TabBar />
      </body>
    </html>
  );
}
