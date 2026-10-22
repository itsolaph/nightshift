// Nightshift's detector clock. The demo clock offset moves only this clock forward, so a
// three-minute-old sandbox authorization can be judged as if it were 27 days old. It never
// changes what is sent to PayPal or what PayPal returns.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export type Clock = { now: () => Date; offsetDays: number };

export function makeClock(offsetDays: number, base: () => number = Date.now): Clock {
  return {
    offsetDays,
    now: () => new Date(base() + offsetDays * DAY_MS),
  };
}

export function daysBetween(from: Date | string, to: Date | string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / DAY_MS;
}

export function addDays(date: Date | string, days: number): Date {
  return new Date(new Date(date).getTime() + days * DAY_MS);
}
