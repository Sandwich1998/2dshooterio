import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://dustline.io"),
  title: {
    default: "Dustline",
    template: "%s | Dustline",
  },
  description:
    "Dustline is a fast top-down tactical battle royale. Loot crates, survive the fog, and outlast every operator in the arena.",
  applicationName: "Dustline",
  openGraph: {
    title: "Dustline",
    description:
      "Fast top-down tactical battle royale combat built for quick, replayable firefights.",
    url: "https://dustline.io",
    siteName: "Dustline",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Dustline",
    description:
      "Fast top-down tactical battle royale combat built for quick, replayable firefights.",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico" },
    ],
    apple: [{ url: "/icon.svg" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b1220",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
