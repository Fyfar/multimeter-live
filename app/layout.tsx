import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Next does not apply basePath to metadata manifest/icon URLs, so prefix them
// ourselves at build time (layout is a server component) to match the deploy subpath.
const basePath = process.env.PAGES_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Multimeter Visualizer",
  description: "Real-time multimeter data visualization over Web Serial",
  manifest: `${basePath}/manifest.webmanifest`,
  icons: {
    icon: `${basePath}/icon-192.png`,
    apple: `${basePath}/icon-192.png`,
  },
  appleWebApp: {
    capable: true,
    title: "Multimeter",
    statusBarStyle: "black-translucent",
  },
};

// Key shared with toggleTheme in page.tsx. Anything but 'light' (or a storage throw) = dark.
const THEME_SCRIPT = `try{if(localStorage.getItem('multimeter-live:theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

export const viewport: Viewport = {
  themeColor: "#0d1117",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The theme script below sets data-theme before hydration; the prerendered HTML has none.
      suppressHydrationWarning
    >
      <head>
        {/* Runs before first paint so a stored light theme never flashes dark. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
