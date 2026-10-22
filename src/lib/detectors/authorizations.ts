// Authorization aging: the money a buyer promised but the shop has not collected yet.
//
//   uncaptured_shipment  the order shipped but its authorization is still open
//   auth_honor_expired   unshipped, and the 3-day honor period is over or about to be
//   auth_expiring        within N days of the 29-day hard expiry, shipped or not
//
// The incidents are mutually exclusive per authorization: expiry beats everything, then a failed
// capture attempt (handled by the capture detector), then shipment, then honor period.

import { HOUR_MS, daysBetween } from "../clock";
import type { IncidentDraft, Ledger, Settings } from "../domain";
import { formatMoney } from "../money";
import {
  expiresAt,
  honorEndsAt,
  isSuperseded,
  iso,
  OPEN_AUTH_STATUSES,
  orderOf,
  uncapturedCents,
} from "./helpers";

export function detectAuthorizationAging(ledger: Ledger, now: Date, settings: Settings): IncidentDraft[] {
  const drafts: IncidentDraft[] = [];

  for (const auth of ledger.authorizations) {
    if (!OPEN_AUTH_STATUSES.has(auth.status) || isSuperseded(ledger, auth)) continue;
    const remaining = uncapturedCents(ledger, auth);
    if (remaining <= 0) continue;

    const order = orderOf(ledger, auth.orderId);
    if (order?.fulfillment === "cancelled") continue;
    const ageDays = daysBetween(auth.createdAt, now);
    const honorEnd = honorEndsAt(auth);
    const expiry = expiresAt(auth);
    const hasFailedAttempt = ledger.captureAttempts.some((a) => a.authorizationId === auth.id && !a.ok);
    const money = formatMoney(remaining, auth.currency);
    const facts = {
      authorization_id: auth.id,
      authorization_status: auth.status,
      order_id: auth.orderId,
      fulfillment: order?.fulfillment ?? "unknown",
      shipped_at: order?.shippedAt ?? null,
      authorized: formatMoney(auth.amountCents, auth.currency),
      uncaptured: money,
      age_days: Math.round(ageDays * 10) / 10,
      honor_period_ends: iso(honorEnd),
      expires_at: iso(expiry),
    };
    const refs = [
      { kind: "order" as const, id: auth.orderId },
      { kind: "authorization" as const, id: auth.id },
    ];
    const base = {
      orderId: auth.orderId,
      subject: { kind: "authorization" as const, id: auth.id },
      atRiskCents: remaining,
      currency: auth.currency,
    };

    const msToExpiry = expiry.getTime() - now.getTime();
    if (msToExpiry <= settings.expiryWarningDays * 24 * HOUR_MS) {
      const expired = msToExpiry <= 0;
      drafts.push({
        ...base,
        type: "auth_expiring",
        dedupeKey: `auth_expiring:${auth.id}`,
        title: expired
          ? `${money} authorization has passed its 29-day expiry`
          : `${money} authorization expires in ${Math.max(1, Math.ceil(msToExpiry / (24 * HOUR_MS)))} day(s)`,
        deadline: iso(expiry),
        evidence: {
          summary: `Authorization ${auth.id} for order ${auth.orderId} is ${facts.age_days} days old with ${money} uncaptured. PayPal authorizations expire after 29 days and cannot be reauthorized after that.`,
          facts: { ...facts, expired_by_detector_clock: expired },
          refs,
        },
      });
      continue;
    }

    if (hasFailedAttempt) continue;

    if (order?.fulfillment === "shipped") {
      const shippedFor = order.shippedAt ? (now.getTime() - new Date(order.shippedAt).getTime()) / HOUR_MS : 0;
      const honorSoon = honorEnd.getTime() - now.getTime() <= settings.honorWarningHours * HOUR_MS;
      if (shippedFor >= settings.uncapturedAfterHours || honorSoon) {
        drafts.push({
          ...base,
          type: "uncaptured_shipment",
          dedupeKey: `uncaptured_shipment:${auth.id}`,
          title: `Order shipped ${Math.max(1, Math.round(shippedFor))}h ago, ${money} never captured`,
          deadline: iso(honorEnd > now ? honorEnd : expiry),
          evidence: {
            summary: `Order ${auth.orderId} is marked shipped but authorization ${auth.id} still holds ${money} uncaptured. ${
              honorEnd > now ? "The honor period ends soon" : "The 3-day honor period is already over, so the capture may be declined"
            }.`,
            facts: { ...facts, shipped_hours_ago: Math.round(shippedFor) },
            refs,
          },
        });
      }
      continue;
    }

    if (honorEnd.getTime() - now.getTime() <= settings.honorWarningHours * HOUR_MS) {
      const lapsed = honorEnd <= now;
      drafts.push({
        ...base,
        type: "auth_honor_expired",
        dedupeKey: `auth_honor_expired:${auth.id}`,
        title: lapsed
          ? `Honor period lapsed on ${money}, order not shipped`
          : `Honor period on ${money} ends within ${settings.honorWarningHours}h`,
        deadline: iso(lapsed ? expiry : honorEnd),
        evidence: {
          summary: `Order ${auth.orderId} has not shipped and authorization ${auth.id} is ${facts.age_days} days old. After the 3-day honor period PayPal no longer guarantees the funds; a reauthorization (allowed from day 4 to day 29) starts a new honor period.`,
          facts: { ...facts, honor_period_lapsed: lapsed },
          refs,
        },
      });
    }
  }
  return drafts;
}
