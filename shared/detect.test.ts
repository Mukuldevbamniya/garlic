import { describe, expect, it } from "vitest";
import { detectSubscriptions, monthlyEquivalentCents, annualizedCents } from "./detect.ts";
import { normalizeMerchantKey } from "./catalog.ts";
import { addDays, addMonthsClamped } from "./dates.ts";
import type { Transaction } from "./types.ts";

let counter = 0;

function tx(
  postedAt: string,
  amountCents: number,
  descriptor: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  counter += 1;
  return {
    id: `t${counter}`,
    accountId: "acct-1",
    postedAt,
    amountCents,
    currency: "USD",
    rawDescriptor: descriptor,
    merchantKey: normalizeMerchantKey(descriptor),
    merchantName: descriptor,
    category: "Uncategorized",
    isPending: false,
    source: "demo",
    externalId: null,
    ...overrides,
  };
}

/** Monthly charges anchored on a fixed day, newest first is not required. */
function monthly(descriptor: string, amountCents: number, anchor: string, count: number): Transaction[] {
  const rows: Transaction[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    rows.push(tx(addMonthsClamped(anchor, -i), amountCents, descriptor));
  }
  return rows;
}

describe("recurring detection", () => {
  it("detects a clean monthly subscription", () => {
    const rows = monthly("NETFLIX.COM 866-579-7172", 2299, "2026-10-14", 12);
    const [result] = detectSubscriptions(rows, { today: "2026-10-30" });
    expect(result).toBeDefined();
    expect(result?.displayName).toBe("Netflix");
    expect(result?.cadence).toBe("monthly");
    expect(result?.confidence).toBeGreaterThan(0.9);
    expect(result?.nextChargeAt).toBe("2026-11-14");
    expect(result?.occurrences).toBe(12);
    expect(result?.evidenceIds).toHaveLength(12);
    expect(result?.status).toBe("active");
  });

  it("clamps month-end anchors instead of rolling into the next month", () => {
    const rows = [
      tx("2025-12-31", 999, "ICLOUD STORAGE"),
      tx("2026-01-31", 999, "ICLOUD STORAGE"),
      tx("2026-02-28", 999, "ICLOUD STORAGE"),
      tx("2026-03-31", 999, "ICLOUD STORAGE"),
      tx("2026-04-30", 999, "ICLOUD STORAGE"),
    ];
    const [result] = detectSubscriptions(rows, { today: "2026-05-10" });
    expect(result?.cadence).toBe("monthly");
    expect(result?.nextChargeAt).toBe("2026-05-31");
  });

  it("detects annual plans from two observations", () => {
    const rows = [
      tx("2024-03-12", 9600, "NOTION LABS"),
      tx("2025-03-12", 9600, "NOTION LABS"),
      tx("2026-03-12", 9600, "NOTION LABS"),
    ];
    const [result] = detectSubscriptions(rows, { today: "2026-10-30" });
    expect(result?.cadence).toBe("annual");
    expect(result?.nextChargeAt).toBe("2027-03-12");
  });

  it("detects quarterly billing", () => {
    const rows = [
      tx("2025-01-15", 1499, "NAMECHEAP DOMAIN RENEW"),
      tx("2025-04-15", 1499, "NAMECHEAP DOMAIN RENEW"),
      tx("2025-07-15", 1499, "NAMECHEAP DOMAIN RENEW"),
      tx("2025-10-15", 1499, "NAMECHEAP DOMAIN RENEW"),
      tx("2026-01-15", 1499, "NAMECHEAP DOMAIN RENEW"),
    ];
    const [result] = detectSubscriptions(rows, { today: "2026-02-01" });
    expect(result?.cadence).toBe("quarterly");
    expect(result?.nextChargeAt).toBe("2026-04-15");
  });

  it("distinguishes a 28-day cycle from a calendar month", () => {
    const rows: Transaction[] = [];
    for (let i = 0; i < 7; i += 1) rows.push(tx(addDays("2026-01-02", i * 28), 3499, "BARKBOX"));
    const [result] = detectSubscriptions(rows, { today: "2026-06-25" });
    expect(result?.cadence).toBe("four_weekly");
    expect(result?.nextChargeAt).toBe("2026-07-17");
  });

  it("keeps a subscription when the price steps up", () => {
    const rows: Transaction[] = [];
    for (let i = 0; i < 9; i += 1) {
      rows.push(tx(addMonthsClamped("2026-04-21", i), i < 6 ? 1999 : 2999, "ADOBE *CREATIVE CLOUD"));
    }
    const [result] = detectSubscriptions(rows, { today: "2027-01-05" });
    expect(result?.cadence).toBe("monthly");
    expect(result?.priceChange).toMatchObject({ fromCents: 1999, toCents: 2999 });
    expect(result?.priceChange?.deltaPct).toBeCloseTo(50, 0);
  });

  it("rejects irregular purchases at the same merchant", () => {
    const rows = [
      tx("2026-05-02", 675, "SQ *BLUE BOTTLE COFFEE #4421"),
      tx("2026-05-09", 720, "SQ *BLUE BOTTLE COFFEE #4421"),
      tx("2026-05-23", 615, "SQ *BLUE BOTTLE COFFEE #4421"),
      tx("2026-06-06", 690, "SQ *BLUE BOTTLE COFFEE #4421"),
      tx("2026-06-19", 745, "SQ *BLUE BOTTLE COFFEE #4421"),
    ];
    const results = detectSubscriptions(rows, { today: "2026-06-25" });
    expect(results).toHaveLength(0);
  });

  it("ignores pending postings", () => {
    const rows = monthly("SPOTIFY USA", 1199, "2026-09-03", 6).map((row) => ({ ...row, isPending: true }));
    expect(detectSubscriptions(rows, { today: "2026-10-30" })).toHaveLength(0);
  });

  it("merges processor prefixes into one merchant", () => {
    const rows = [
      tx("2026-06-02", 1199, "SQ *SPOTIFY USA"),
      tx("2026-07-02", 1199, "SPOTIFY USA"),
      tx("2026-08-02", 1199, "PAYPAL *SPOTIFY"),
      tx("2026-09-02", 1199, "SQ *SPOTIFY USA 8841"),
    ];
    const results = detectSubscriptions(rows, { today: "2026-10-01" });
    expect(results).toHaveLength(1);
    expect(results[0]?.occurrences).toBe(4);
  });

  it("splits a bundled descriptor such as APPLE.COM/BILL into separate plans", () => {
    const rows: Transaction[] = [];
    for (let i = 0; i < 6; i += 1) {
      const date = addMonthsClamped("2026-05-01", i);
      rows.push(tx(date, 999, "APPLE.COM/BILL"));
      rows.push(tx(addDays(date, 2), 1099, "APPLE.COM/BILL"));
    }
    rows.push(tx("2026-05-07", 499, "APPLE.COM/BILL"));
    rows.push(tx("2026-06-21", 499, "APPLE.COM/BILL"));
    rows.push(tx("2026-08-03", 499, "APPLE.COM/BILL"));

    const results = detectSubscriptions(rows, { today: "2026-10-15" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const amounts = results.map((result) => result.amountCents).sort((a, b) => a - b);
    expect(amounts).toContain(999);
    expect(amounts).toContain(1099);
    expect(results.every((result) => result.cadence === "monthly")).toBe(true);
  });

  it("collapses duplicate same-day postings", () => {
    const rows = [
      ...monthly("GITHUB INC", 1000, "2026-09-20", 3),
      tx("2026-09-20", 1000, "GITHUB INC"),
    ];
    const [result] = detectSubscriptions(rows, { today: "2026-10-01" });
    expect(result?.occurrences).toBe(3);
  });

  it("marks an overdue subscription as lapsed", () => {
    const rows = monthly("PELOTON APP", 1299, "2026-03-24", 6);
    const [result] = detectSubscriptions(rows, { today: "2026-10-30" });
    expect(result?.status).toBe("lapsed");
    expect(result?.nextChargeAt).toBeNull();
  });

  it("flags ambiguous cadences for review instead of guessing", () => {
    const rows = monthly("ACME WIDGETS", 499, "2026-04-10", 3);
    const [result] = detectSubscriptions(rows, { today: "2026-06-12" });
    expect(result).toBeDefined();
    expect(result?.alternatives.length).toBeGreaterThan(0);
    expect(result?.needsReview).toBe(true);
  });

  it("detects variable usage-based billing for a known cloud merchant", () => {
    const amounts = [4210, 5280, 4675, 6120, 5505, 4980];
    const rows = amounts.map((amount, index) => tx(addMonthsClamped("2026-04-02", index), amount, "AMAZON WEB SERVICES"));
    const [result] = detectSubscriptions(rows, { today: "2026-10-20" });
    expect(result?.billingModel).toBe("variable");
    expect(result?.cadence).toBe("monthly");
  });

  it("ignores refunds when counting cycles", () => {
    const rows = [...monthly("NOTION LABS", 1000, "2026-09-20", 4), tx("2026-09-22", -1000, "NOTION LABS")];
    const [result] = detectSubscriptions(rows, { today: "2026-10-25" });
    expect(result?.occurrences).toBe(4);
    expect(result?.reasons.some((reason) => reason.code === "refund")).toBe(true);
  });
});

describe("money normalisation", () => {
  it("annualises every cadence", () => {
    expect(annualizedCents(1000, "monthly")).toBe(12_000);
    expect(annualizedCents(1000, "weekly")).toBe(52_000);
    expect(annualizedCents(1000, "four_weekly")).toBe(13_000);
    expect(annualizedCents(10_000, "annual")).toBe(10_000);
    expect(monthlyEquivalentCents(12_000, "annual")).toBe(1000);
  });
});
