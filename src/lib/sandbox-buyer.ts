// The scenario lab's buyer, for sandbox apps that cannot take card payments directly.
//
// A sandbox app without "Advanced Credit and Debit Card Payments" refuses `payment_source.card`
// with 422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING (checked live, Oct 2026). Those apps can still
// take PayPal-wallet orders: the order comes back PAYER_ACTION_REQUIRED with a "payer-action"
// link, a buyer approves it on PayPal's sandbox checkout page, and the merchant then authorizes or
// captures it. In the sandbox that page offers guest checkout with a test card, so a lab buyer can
// approve without a sandbox personal account.
//
// Two ways to approve:
//   headless  drives PayPal's sandbox guest checkout in headless Chromium (playwright-core, plus a
//             Chromium binary: `npx playwright-core install chromium` or LAB_CHROMIUM_PATH)
//   manual    logs the approve link and waits until someone approves it in a browser
// PayPal's own GET order is the only proof of approval either way.

import { randomInt } from "node:crypto";
import type { PayPalClient } from "./paypal/client";

export type SandboxBuyer = { email: string; card: string; firstName: string; lastName: string };

export type ApprovalResult = { approved: boolean; detail: string };

export type BuyerApprover = {
  kind: "headless" | "manual" | "test";
  /** Where PayPal sends the buyer after approving or cancelling (experience_context return/cancel URLs). */
  returnUrl: string;
  cancelUrl: string;
  approve(order: { id: string; approveUrl: string }, buyer: SandboxBuyer): Promise<ApprovalResult>;
  close(): Promise<void>;
};

/** Visa test number with PayPal's sandbox card-generator prefix and a valid Luhn check digit. */
export function testCardNumber(prefix = "4032", length = 16): string {
  const digits = prefix.split("").map(Number);
  while (digits.length < length - 1) digits.push(randomInt(10));
  return digits.join("") + luhnCheckDigit(digits.join(""));
}

export function luhnCheckDigit(payload: string): number {
  let sum = 0;
  const digits = payload.split("").map(Number).reverse();
  digits.forEach((d, i) => {
    const v = i % 2 === 0 ? d * 2 : d;
    sum += v > 9 ? v - 9 : v;
  });
  return (10 - (sum % 10)) % 10;
}

/**
 * A fresh lab buyer. A well-known test number such as 4012888888881881 was refused by guest
 * checkout ("We weren't able to add this card"); a newly generated one went through.
 */
export function newSandboxBuyer(label = "Buyer"): SandboxBuyer {
  return {
    email: `night-owl-${Date.now().toString(36)}${randomInt(1000)}@example.com`,
    card: testCardNumber(),
    firstName: "Sandbox",
    lastName: label.replace(/[^A-Za-z ]/g, "").slice(0, 30) || "Buyer",
  };
}

export function approveLink(order: { links?: { rel: string; href: string }[] }): string | null {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
}

/** Polls GET order until PayPal reports APPROVED (or a terminal status). */
export async function waitForApproval(
  client: PayPalClient,
  orderId: string,
  opts: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<ApprovalResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await client.getOrder(orderId);
    const status = result.ok ? result.body.status : null;
    if (status === "APPROVED" || status === "COMPLETED") return { approved: true, detail: `order ${orderId} is ${status}` };
    if (status === "VOIDED") return { approved: false, detail: `order ${orderId} was voided` };
    if (Date.now() >= deadline) return { approved: false, detail: `order ${orderId} still ${status ?? `unreadable (HTTP ${result.status})`} after waiting` };
    await sleep(opts.pollMs ?? 3000);
  }
}

/** Waits for a person to approve the link. `announce` puts the link where they can see it. */
export function manualApprover(
  client: PayPalClient,
  announce: (orderId: string, url: string) => void,
  opts: { appUrl: string; timeoutMs?: number },
): BuyerApprover {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return {
    kind: "manual",
    returnUrl: `${opts.appUrl}/lab?approved=1`,
    cancelUrl: `${opts.appUrl}/lab?cancelled=1`,
    async approve(order) {
      announce(order.id, order.approveUrl);
      return waitForApproval(client, order.id, { timeoutMs });
    },
    async close() {},
  };
}

// Minimal structural types for the parts of playwright-core used here, so it stays optional.
type PwLocator = {
  first(): PwLocator;
  click(opts?: { timeout?: number; force?: boolean }): Promise<void>;
  isVisible(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  count(): Promise<number>;
  fill(value: string): Promise<void>;
  pressSequentially(value: string, opts?: { delay?: number }): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  filter(opts: { hasText: RegExp }): PwLocator;
  evaluate(fn: (el: HTMLElement) => void): Promise<void>;
  waitFor(opts: { state: "visible" | "attached"; timeout?: number }): Promise<void>;
  inputValue(): Promise<string>;
};
type PwPage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByText(text: string | RegExp): PwLocator;
  route(url: string | RegExp, handler: (route: { fulfill(r: { status: number; body: string }): Promise<void> }) => Promise<void>): Promise<void>;
  waitForRequest(predicate: (req: { url(): string }) => boolean, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", opts?: { timeout?: number }): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  close(): Promise<void>;
};
type PwBrowser = {
  newContext(opts: Record<string, unknown>): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>;
  close(): Promise<void>;
};

// A reserved documentation domain; the headless browser answers it locally, so it is never fetched.
const RETURN_URL = "https://example.com/nightshift-lab/approved";
const CANCEL_URL = "https://example.com/nightshift-lab/cancelled";

/**
 * Headless guest checkout on PayPal's sandbox page, or null when playwright-core or Chromium is
 * missing. The page has had at least two layouts (A/B tested), so selectors stay loose.
 */
export async function headlessApprover(client: PayPalClient, opts: { chromiumPath?: string } = {}): Promise<BuyerApprover | null> {
  let browser: PwBrowser;
  try {
    // A runtime-computed specifier keeps bundlers from resolving the optional dependency.
    const moduleName = ["playwright", "core"].join("-");
    const pw = (await import(/* webpackIgnore: true */ moduleName)) as {
      chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
    };
    browser = await pw.chromium.launch({ headless: true, ...(opts.chromiumPath ? { executablePath: opts.chromiumPath } : {}) });
  } catch {
    return null;
  }

  return {
    kind: "headless",
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
    async approve(order, buyer) {
      const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Los_Angeles", viewport: { width: 1200, height: 1400 } });
      const page = await context.newPage();
      try {
        // PayPal redirects to the return URL after approval; answer it locally so nothing leaves the machine.
        await page.route(/^https:\/\/example\.com\/nightshift-lab\//, (route) => route.fulfill({ status: 200, body: "approved" }));
        const url = new URL(order.approveUrl);
        url.searchParams.set("country.x", "US");
        url.searchParams.set("locale.x", "en_US");
        const settle = () => page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        // Not "networkidle": PayPal's checkout page sometimes keeps the network busy for over a minute.
        await page.goto(url.toString(), { waitUntil: "load", timeout: 60_000 });
        await settle();
        await page.locator("#guestCheckout, #createAccount").first().click({ timeout: 30_000 });
        await settle();
        const card = page.locator("#cardNumber").first();
        await card.waitFor({ state: "visible", timeout: 45_000 });
        const country = page.locator("#country").first();
        if ((await country.isVisible().catch(() => false)) && (await country.inputValue().catch(() => "")) !== "US") {
          // Changing the country re-renders the form, wiping anything typed before.
          await country.selectOption("US").catch(() => undefined);
          await settle();
          await page.waitForTimeout(2500);
          await card.waitFor({ state: "visible", timeout: 30_000 });
        }

        const type = async (selector: string, value: string) => {
          const field = page.locator(selector).first();
          if (!(await field.isVisible().catch(() => false))) return;
          await field.click();
          await field.fill("");
          await field.pressSequentially(value, { delay: 15 });
        };
        const fillForm = async () => {
          await type("#email", buyer.email);
          await type("#phone", "4085550123");
          await type("#cardNumber", buyer.card);
          await type("#cardExpiry", "1230");
          await type("#cardCvv", "123");
          await type("#firstName", buyer.firstName);
          await type("#lastName", buyer.lastName);
          await type("#billingLine1", "100 Market St");
          await type("#billingCity", "San Jose");
          const state = page.locator("#billingState").first();
          if (await state.isVisible().catch(() => false)) await state.selectOption("CA").catch(() => undefined);
          await type("#billingPostalCode", "95131");
        };
        // A late re-render can still wipe the form; check and fill again once.
        for (let attempt = 0; attempt < 2; attempt++) {
          await fillForm();
          await page.waitForTimeout(1000);
          if ((await card.inputValue().catch(() => "")).replace(/\D/g, "") === buyer.card) break;
        }

        // Some layouts default to "Save info & create your PayPal account"; turn it off.
        const save = page.locator("input[type=checkbox][id^=Switch]").first();
        if ((await save.count()) && (await save.isChecked().catch(() => false))) {
          await save.evaluate((el) => el.click());
          await page.waitForTimeout(800);
        }
        const submit = page.locator("button").filter({ hasText: /^(Continue as Guest|Agree & Continue|Agree and Continue|Pay Now|Continue)$/ }).first();
        const redirected = page.waitForRequest((req) => req.url().startsWith(RETURN_URL), { timeout: 90_000 }).then(
          () => true,
          () => false,
        );
        await submit.click({ timeout: 15_000 });
        if (!(await redirected)) {
          const text = ((await page.textContent("body").catch(() => "")) ?? "").replace(/\s+/g, " ");
          const problem = text.match(/We weren.t able to [^.]+\.|Something went wrong[^.]*\.|Please (check|enter)[^.]+\./)?.[0];
          return { approved: false, detail: `guest checkout did not return to the shop${problem ? `: "${problem}"` : ""}` };
        }
      } catch (error) {
        return { approved: false, detail: `guest checkout failed: ${String(error).split("\n")[0].slice(0, 200)}` };
      } finally {
        await context.close().catch(() => undefined);
      }
      return waitForApproval(client, order.id, { timeoutMs: 20_000, pollMs: 2000 });
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}
