import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Español Coach",
  description: "Entrenador personal de español mexicano B2→C1",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="mx-auto min-h-screen max-w-prose px-4 py-8 antialiased">
        {children}
      </body>
    </html>
  );
}
