import type { Metadata, Viewport } from "next";
import { Topbar } from "@/components/topbar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Nightshift: the overnight payments operator for PayPal shops", template: "%s | Nightshift" },
  description:
    "Nightshift watches every PayPal order, authorization, capture, refund and invoice, fixes the safe problems itself and asks the owner before anything risky.",
};

export const viewport: Viewport = { themeColor: "#070d1a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-ag-theme-mode="dark">
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
