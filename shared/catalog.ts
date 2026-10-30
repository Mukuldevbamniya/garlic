import type { CancellationChannel, MerchantProfile } from "./types.ts";

interface CatalogEntry extends MerchantProfile {
  patterns: RegExp[];
  /** Days of free trial commonly offered, used for trial-ending alerts. */
  trialDays?: number;
}

const entry = (
  merchantKey: string,
  displayName: string,
  category: string,
  patterns: RegExp[],
  options: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  merchantKey,
  displayName,
  category,
  patterns,
  cancellationChannel: options.cancellationChannel ?? "web_form",
  cancellationUrl: options.cancellationUrl ?? null,
  tosNote: options.tosNote ?? null,
  noticePeriodDays: options.noticePeriodDays ?? 0,
  earlyTerminationFeeCents: options.earlyTerminationFeeCents ?? 0,
  isKnownSubscription: options.isKnownSubscription ?? true,
  source: "catalog",
  trialDays: options.trialDays,
});

/**
 * A deliberately small catalog. Anything outside it is still detectable from
 * cadence alone; the catalog only adds naming, cancellation routing and a prior.
 */
export const CATALOG: CatalogEntry[] = [
  entry("netflix", "Netflix", "Entertainment", [/NETFLIX/], {
    cancellationUrl: "https://www.netflix.com/cancelplan",
    tosNote: "Cancel anytime in Account → Cancel Membership. Access runs to the end of the paid period.",
  }),
  entry("spotify", "Spotify Premium", "Music", [/SPOTIFY/], {
    cancellationUrl: "https://www.spotify.com/account/subscription/",
    tosNote: "Cancel anytime. Playlists stay; downloads and ad-free listening stop at period end.",
  }),
  entry("adobe", "Adobe Creative Cloud", "Software", [/ADOBE/], {
    cancellationUrl: "https://account.adobe.com/plans",
    tosNote: "Annual plans paid monthly carry an early termination fee equal to 50% of remaining months.",
    earlyTerminationFeeCents: 3000,
    noticePeriodDays: 0,
  }),
  entry("apple", "Apple", "Software", [/APPLE\.COM\/BILL/, /APPLE COM BILL/, /APPLE\s*BILL/, /ITUNES/], {
    cancellationChannel: "app_store",
    cancellationUrl: "https://apps.apple.com/account/subscriptions",
    tosNote: "Apple-billed subscriptions can only be cancelled in iOS Settings → Apple ID → Subscriptions.",
  }),
  entry("icloud", "iCloud+ 2TB", "Cloud storage", [/ICLOUD/], {
    cancellationChannel: "app_store",
    cancellationUrl: "https://apps.apple.com/account/subscriptions",
    tosNote: "Downgrade in Settings → Apple ID → iCloud. Storage above 5GB becomes read-only at period end.",
  }),
  entry("google_one", "Google One 2TB", "Cloud storage", [/GOOGLE\s*\*?\s*ONE/, /GOOGLE\s+STORAGE/], {
    cancellationUrl: "https://one.google.com/settings",
    tosNote: "Cancel in Google One settings. Files above 15GB become read-only after the period ends.",
  }),
  entry("notion", "Notion Plus", "Productivity", [/NOTION/], {
    cancellationUrl: "https://www.notion.so/my-account",
    tosNote: "Cancel anytime in Settings → Plans. Workspace reverts to the free plan at period end.",
  }),
  entry("figma", "Figma Professional", "Software", [/FIGMA/], {
    cancellationUrl: "https://www.figma.com/billing",
    tosNote: "Downgrade in Billing. Editors over the free limit become view-only.",
  }),
  entry("nyt", "The New York Times", "News", [/NYTIMES/, /NYT\s/, /NEW YORK TIMES/], {
    cancellationUrl: "https://myaccount.nytimes.com/",
    tosNote: "Cancel anytime online or by chat. Access continues to the end of the billing period.",
  }),
  entry("amazon_prime", "Amazon Prime", "Shopping", [/AMZN\s*PRIME/, /AMAZON\s*PRIME/], {
    cancellationUrl: "https://www.amazon.com/gp/primecentral",
    tosNote: "Cancel in Prime Central. Unused period is refunded only if you have not used Prime benefits.",
  }),
  entry("aws", "Amazon Web Services", "Cloud infrastructure", [/AMAZON WEB SERVICES/, /AWS\s/, /AWS\.AMAZON/], {
    cancellationUrl: "https://console.aws.amazon.com/billing/",
    tosNote: "No contract, usage-based. Shutting down resources stops charges; the current bill is still due.",
  }),
  entry("chatgpt", "ChatGPT Plus", "AI tools", [/OPENAI/, /CHATGPT/], {
    cancellationUrl: "https://chatgpt.com/#settings/Subscription",
    tosNote: "Cancel in Settings → Subscription. Access continues until the renewal date.",
  }),
  entry("anthropic", "Claude Pro", "AI tools", [/ANTHROPIC/, /CLAUDE\.AI/], {
    cancellationUrl: "https://claude.ai/settings/billing",
    tosNote: "Cancel in Settings → Billing. Access continues to the end of the paid period.",
  }),
  entry("disney", "Disney+", "Entertainment", [/DISNEY/], {
    cancellationUrl: "https://www.disneyplus.com/account",
    tosNote: "Cancel in Account → Subscription. Access continues to the end of the billing period.",
  }),
  entry("hulu", "Hulu", "Entertainment", [/HULU/], {
    cancellationUrl: "https://secure.hulu.com/account",
    tosNote: "Cancel in Account. Access continues to the end of the current billing period.",
    trialDays: 30,
  }),
  entry("equinox", "Equinox", "Fitness", [/EQUINOX/], {
    cancellationChannel: "email",
    tosNote: "Memberships require written notice; the final month is billed after notice is processed.",
    noticePeriodDays: 30,
  }),
  entry("planet_fitness", "Planet Fitness", "Fitness", [/PLANET\s*FITNESS/], {
    cancellationChannel: "email",
    tosNote: "Cancel in person or by certified mail. Annual fee is non-refundable.",
    noticePeriodDays: 0,
  }),
  entry("peloton", "Peloton App", "Fitness", [/PELOTON/], {
    cancellationUrl: "https://www.onepeloton.com/membership",
    tosNote: "Cancel in Membership settings. Access continues to the end of the billing period.",
  }),
  entry("audible", "Audible", "Audiobooks", [/AUDIBLE/], {
    cancellationUrl: "https://www.audible.com/account",
    tosNote: "Cancel in Account Details. Unused credits expire 6 months after cancellation.",
  }),
  entry("dropbox", "Dropbox Plus", "Cloud storage", [/DROPBOX/], {
    cancellationUrl: "https://www.dropbox.com/account/plan",
    tosNote: "Cancel in Plan settings. Files above the free tier limit become read-only.",
  }),
  entry("duolingo", "Duolingo Super", "Education", [/DUOLINGO/], {
    cancellationChannel: "app_store",
    cancellationUrl: "https://apps.apple.com/account/subscriptions",
    tosNote: "Cancel in the store you subscribed through. Access continues to period end.",
  }),
  entry("1password", "1Password Families", "Security", [/1PASSWORD/], {
    cancellationUrl: "https://my.1password.com/billing",
    tosNote: "Cancel in Billing. Vaults become read-only after the billing period ends.",
  }),
  entry("github", "GitHub Copilot", "Software", [/GITHUB/], {
    cancellationUrl: "https://github.com/settings/billing",
    tosNote: "Cancel in Billing settings. Access continues to the end of the billing period.",
  }),
  entry("vercel", "Vercel Pro", "Cloud infrastructure", [/VERCEL/], {
    cancellationUrl: "https://vercel.com/account/billing",
    tosNote: "Downgrade in Billing. Usage above the free tier is billed at the end of the cycle.",
  }),
  entry("linear", "Linear", "Productivity", [/LINEAR\s*APP/, /LINEAR\.APP/], {
    cancellationUrl: "https://linear.app/settings/billing",
    tosNote: "Cancel in Workspace settings → Billing. Seats are prorated at downgrade.",
  }),
  entry("superhuman", "Superhuman", "Productivity", [/SUPERHUMAN/], {
    cancellationUrl: "https://mail.superhuman.com/",
    tosNote: "Cancel from the billing portal. No partial-month refunds.",
  }),
  entry("masterclass", "MasterClass", "Education", [/MASTERCLASS/], {
    cancellationUrl: "https://www.masterclass.com/account",
    tosNote: "Cancel in Account settings. Access continues to the end of the annual term.",
  }),
  entry("blue_apron", "Blue Apron", "Food", [/BLUE\s*APRON/], {
    cancellationUrl: "https://www.blueapron.com/account",
    tosNote: "Skip or cancel before the weekly cutoff (Wednesday 11:59pm ET) to avoid the next box.",
    noticePeriodDays: 7,
  }),
  entry("hellofresh", "HelloFresh", "Food", [/HELLO\s*FRESH/], {
    cancellationUrl: "https://www.hellofresh.com/account",
    tosNote: "Cancel before the weekly cutoff to avoid the next box; discounts may claw back.",
    noticePeriodDays: 5,
  }),
  entry("car_shield", "CarShield", "Insurance", [/CAR\s*SHIELD/], {
    cancellationChannel: "phone",
    tosNote: "Cancellation is phone-only. A cancellation fee may apply within the first 30 days.",
  }),
  entry("domain", "Domain renewal", "Software", [/DOMAIN\s*RENEW/, /NAMECHEAP/, /GODADDY/], {
    cancellationUrl: "https://www.namecheap.com/myaccount/",
    tosNote: "Turn off auto-renew in the registrar dashboard. Domains are not refunded after renewal.",
  }),
  entry("barkbox", "BarkBox", "Shopping", [/BARK\s*BOX/, /BARKBOX/], {
    cancellationUrl: "https://barkbox.com/account",
    tosNote: "Cancel before the 25th to avoid the next box. Prepaid plans are non-refundable.",
    noticePeriodDays: 5,
  }),
  entry("figma_duplicate", "Figma", "Software", [/FIGMA/], {}),
];

/** Processor prefixes that hide the real merchant in statement descriptors. */
const PROCESSOR_PREFIXES = [
  // The asterisk is mandatory for short prefixes, otherwise "SPOTIFY" loses
  // its first two letters to the "SP *" rule.
  /^SQ\s*\*\s*/,
  /^TST\s*\*\s*/,
  /^PAYPAL\s*\*?\s*/,
  /^PP\s*\*\s*/,
  /^SP\s*\*\s*/,
  /^STRIPE\s*\*\s*/,
  /^SHOPIFY\s*\*\s*/,
  /^2CO\s*\*\s*/,
  /^CHECKCARD\s+/,
  /^POS\s+/,
  /^ACH\s+DEBIT\s+/,
  /^RECURRING\s+PAYMENT\s+/,
  /^PURCHASE\s+/,
];

const NOISE_TOKENS = [
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
  /\bXX+\d{2,}\b/g, // masked card fragments
  /\bX{2,}\d{2,}\b/g,
  /\b\d{6,}\b/g, // long reference numbers
  /#\s*\d+/g,
  /\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, // embedded dates
  /\s(?:US|USA|CA|NY|WA|TX|FL|IL|MA|SEA|SF|NYC)\b/g,
];

/**
 * Turn a raw statement descriptor into a stable merchant key. "SQ *BLUE BOTTLE
 * COFFEE #4421 SEATTLE WA" and "BLUE BOTTLE COFFEE" must land on the same key,
 * otherwise the same subscription looks like two.
 */
export function normalizeMerchantKey(rawDescriptor: string): string {
  let value = rawDescriptor.toUpperCase().replace(/\s+/g, " ").trim();
  for (const prefix of PROCESSOR_PREFIXES) value = value.replace(prefix, "");
  for (const pattern of NOISE_TOKENS) value = value.replace(pattern, " ");
  value = value
    .replace(/[^A-Z0-9&+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = value.split(" ").filter((token) => token.length > 0);
  // Drop trailing store/terminal codes such as "STORE 1042" or a lone "01".
  while (tokens.length > 1 && /^(?:\d{3,5}|STORE|TERM|TRM|LOC)$/.test(tokens[tokens.length - 1] ?? "")) {
    tokens.pop();
  }
  const key = tokens.slice(0, 5).join(" ").toLowerCase() || "unknown";
  // Collapse descriptor variants onto the catalog identity when we recognise the
  // merchant, so "PAYPAL *SPOTIFY" and "SPOTIFY USA" are one subscription.
  return matchCatalog(key)?.merchantKey ?? key;
}

export function matchCatalog(rawDescriptor: string): CatalogEntry | null {
  const upper = rawDescriptor.toUpperCase();
  let best: CatalogEntry | null = null;
  for (const item of CATALOG) {
    if (item.merchantKey === "figma_duplicate") continue;
    if (item.patterns.some((pattern) => pattern.test(upper))) {
      // Prefer the most specific match (longest matched pattern) so
      // "GOOGLE *ONE" beats a generic "GOOGLE" rule.
      if (!best || item.merchantKey.length > best.merchantKey.length) best = item;
    }
  }
  return best;
}

export function humanizeMerchantKey(key: string): string {
  return key
    .split(" ")
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

export function catalogProfile(rawDescriptor: string, merchantKey: string): MerchantProfile {
  const match = matchCatalog(rawDescriptor);
  if (match) {
    return {
      merchantKey: match.merchantKey,
      displayName: match.displayName,
      category: match.category,
      cancellationChannel: match.cancellationChannel,
      cancellationUrl: match.cancellationUrl,
      tosNote: match.tosNote,
      noticePeriodDays: match.noticePeriodDays,
      earlyTerminationFeeCents: match.earlyTerminationFeeCents,
      isKnownSubscription: match.isKnownSubscription,
      source: "catalog",
    };
  }
  return {
    merchantKey,
    displayName: humanizeMerchantKey(merchantKey),
    category: "Uncategorized",
    cancellationChannel: "unknown" as CancellationChannel,
    cancellationUrl: null,
    tosNote: null,
    noticePeriodDays: 0,
    earlyTerminationFeeCents: 0,
    isKnownSubscription: false,
    source: "catalog",
  };
}

export function catalogTrialDays(rawDescriptor: string): number | null {
  return matchCatalog(rawDescriptor)?.trialDays ?? null;
}

export function isKnownSubscriptionDescriptor(rawDescriptor: string): boolean {
  return matchCatalog(rawDescriptor) !== null;
}
