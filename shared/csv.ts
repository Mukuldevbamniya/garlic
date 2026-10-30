export interface CsvRow {
  line: number;
  postedAt: string;
  descriptor: string;
  amountCents: number;
}

export interface CsvError {
  line: number;
  message: string;
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: CsvError[];
  detectedColumns: { date: string | null; description: string | null; amount: string | null };
  signConvention: "charges_positive" | "charges_negative";
}

/** RFC 4180-ish parser: handles quotes, escaped quotes, CRLF and stray blank lines. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const DATE_KEYS = ["date", "posted", "posted at", "posting date", "transaction date", "trans date"];
const DESCRIPTION_KEYS = ["description", "merchant", "memo", "details", "name", "payee", "transaction"];
const AMOUNT_KEYS = ["amount", "debit", "value", "charge"];
const CREDIT_KEYS = ["credit", "deposit"];

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim());
  for (const candidate of candidates) {
    const index = normalized.findIndex((header) => header === candidate);
    if (index >= 0) return index;
  }
  for (const candidate of candidates) {
    const index = normalized.findIndex((header) => header.includes(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

export function parseAmountCents(raw: string): number | null {
  let value = raw.trim();
  if (value === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[^0-9.,-]/g, "");
  // European style "1.234,56"
  if (/,\d{2}$/.test(value) && value.includes(".")) value = value.replace(/\./g, "").replace(",", ".");
  else value = value.replace(/,/g, "");
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) * (negative ? -1 : 1);
}

export function parseDate(raw: string): string | null {
  const value = raw.trim().split("T")[0]?.split(" ")[0] ?? "";
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${iso[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(value);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = us[3]!.length === 2 ? `20${us[3]}` : us[3]!;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

/**
 * Bank exports disagree on sign convention: some list charges as positive,
 * others as negative. We infer from the file as a whole instead of asking.
 */
export function parseCsv(text: string): CsvParseResult {
  const errors: CsvError[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return {
      rows: [],
      errors: [{ line: 0, message: "The file is empty." }],
      detectedColumns: { date: null, description: null, amount: null },
      signConvention: "charges_positive",
    };
  }

  const headers = parseCsvLine(lines[0]!);
  const dateIndex = findColumn(headers, DATE_KEYS);
  const descriptionIndex = findColumn(headers, DESCRIPTION_KEYS);
  const amountIndex = findColumn(headers, AMOUNT_KEYS);
  const creditIndex = findColumn(headers, CREDIT_KEYS);

  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && creditIndex < 0)) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message:
            "Could not find the required columns. Include a date column, a description column, and an amount (or debit/credit) column.",
        },
      ],
      detectedColumns: {
        date: dateIndex >= 0 ? headers[dateIndex]! : null,
        description: descriptionIndex >= 0 ? headers[descriptionIndex]! : null,
        amount: amountIndex >= 0 ? headers[amountIndex]! : null,
      },
      signConvention: "charges_positive",
    };
  }

  const raw: Array<{ line: number; postedAt: string; descriptor: string; amountCents: number }> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]!);
    const postedAt = parseDate(cells[dateIndex] ?? "");
    const descriptor = (cells[descriptionIndex] ?? "").trim();
    if (!postedAt) {
      errors.push({ line: i + 1, message: `Unreadable date: "${cells[dateIndex] ?? ""}"` });
      continue;
    }
    if (!descriptor) {
      errors.push({ line: i + 1, message: "Missing description." });
      continue;
    }
    let amount = amountIndex >= 0 ? parseAmountCents(cells[amountIndex] ?? "") : null;
    if (amount === null && creditIndex >= 0) {
      const credit = parseAmountCents(cells[creditIndex] ?? "");
      if (credit !== null) amount = -Math.abs(credit);
    }
    if (amount === null) {
      errors.push({ line: i + 1, message: `Unreadable amount: "${cells[amountIndex] ?? cells[creditIndex] ?? ""}"` });
      continue;
    }
    raw.push({ line: i + 1, postedAt, descriptor, amountCents: amount });
  }

  const charges = raw.filter((row) => row.amountCents !== 0);
  const positive = charges.filter((row) => row.amountCents > 0).length;
  const negative = charges.filter((row) => row.amountCents < 0).length;
  const signConvention = negative > positive ? "charges_negative" : "charges_positive";

  return {
    rows: raw.map((row) => ({
      ...row,
      amountCents: signConvention === "charges_negative" ? -row.amountCents : row.amountCents,
    })),
    errors,
    detectedColumns: {
      date: headers[dateIndex]!,
      description: headers[descriptionIndex]!,
      amount: amountIndex >= 0 ? headers[amountIndex]! : headers[creditIndex]!,
    },
    signConvention,
  };
}

export const SAMPLE_CSV = `Date,Description,Amount
2026-08-02,NETFLIX.COM 866-579-7172,-22.99
2026-08-05,SPOTIFY USA,-11.99
2026-08-11,OPENAI *CHATGPT SUBSCR,-20.00
2026-08-14,SQ *BLUE BOTTLE COFFEE #4421,-6.75
2026-08-15,AMZN Mktp US*2H45R7,-34.10
2026-08-19,DISNEYPLUS,-13.99
2026-08-21,ADOBE *CREATIVE CLOUD,-59.99
2026-08-24,UBER *TRIP,-18.40
`;
