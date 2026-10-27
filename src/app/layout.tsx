import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono, Newsreader } from "next/font/google";
import { Topbar } from "@/components/topbar";
import "./globals.css";

const display = Hanken_Grotesk({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-hanken", display: "swap" });
const body = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--font-newsreader", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Nightshift: the overnight payments operator for PayPal shops", template: "%s | Nightshift" },
  description:
    "Nightshift watches every PayPal order, authorization, capture, refund and invoice, fixes the safe problems itself and asks the owner before anything risky.",
};

export const viewport: Viewport = { themeColor: "#c4cbd2", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-ag-theme-mode="light" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Topbar />
          <main className="page">{children}</main>
          <footer className="footer">
            <div className="footer-inner">
              <span>PayPal sandbox only. Every PayPal id on screen is a real sandbox object.</span>
              <span>Open source under the MIT licence.</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
