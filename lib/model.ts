// Token Radar's value model (radar-3): one sealed snapshot in, one auditable board out.
//
// What changed from radar-2, and why. radar-2 priced every protocol off one flat multiple
// (TVL x 0.30) with hand-set category tweaks. radar-3 anchors the price in the snapshot's own
// market evidence instead: of the snapshot's 758 protocols, 144 record a market cap, and 128 of
// those carry both a positive cap and a positive TVL — the usable comparables. They reveal,
// category by category, what the market actually pays per dollar of TVL. A pre-token
// protocol is priced off the shrunk median market-cap/TVL multiple of its tokenized comparables,
// with a low-high range from the comparables' interquartile band, then adjusted for the things
// the snapshot itself reports: seven-day TVL momentum, how long the protocol has run with no
// token, how many chains it reaches, and how directly its category's economics map to a token.
//
// The snapshot carries exactly ten fields per protocol, and this model uses only those: slug,
// name, category, chains, tvl_usd, change_7d, mcap_usd, listed_at, gecko_id, symbol. It carries
// no fees, no revenue, no user counts, no developer activity and no points-program data, so the
// model invents none: where a classic signal is absent from the record (a fee stream, a points
// program), the model says so in its risk flags instead of fabricating a number. Nothing here
// predicts that a token will launch, or when: the implied value is this entry's own claim about
// what a launch would be worth if the protocol's record stayed as it is, and the range is the
// honest width of that claim.
//
// The model in one breath:
//   comps(group)  = the tokenized protocols of the group; multiple = mcap_usd / tvl_usd,
//                   each clamped to [0.005, 6] so one dead or mania token cannot anchor a price
//   shrunk(q)     = (n x group quantile q + 6 x global quantile q) / (n + 6): a small comparable
//                   set is pulled toward the whole market's evidence, a large one stands alone
//   base          = tvl_usd x shrunk(median multiple of the protocol's category)
//   range         = tvl_usd x shrunk(P25 multiple) x adj x 0.90  ..  tvl_usd x shrunk(P75) x adj x 1.10
//   adj           = growthMult x maturityMult x chainMult x captureMult   (each defined below)
//   implied       = round(base x adj), ranked board-wide, ranks 1..N, values never rising
//   score (0-100) = 28 scale + 18 momentum + 14 maturity + 10 reach + 18 category fit
//                   + 12 resilience, every component a percentile inside the ranked universe,
//                   so a reader can audit exactly why one protocol stands above another.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** The model's constants, stated on the dashboard's Method view so a reader can re-run the sums. */
export const MODEL = {
  /** Comparable multiples are clamped to this band before any quantile is taken. */
  multiple_floor: 0.005,
  multiple_cap: 6,
  /** Shrinkage strength: a group of n comparables is blended with the global quantiles as (n, 6). */
  shrink_k: 6,
  /** Growth: implied moves by growth_weight of the clamped seven-day change. */
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 150,
  /** Maturity: a floor plus a range earned linearly over maturity_days of tokenless operation. */
  maturity_floor: 0.78,
  maturity_range: 0.4,
  maturity_days: 1460,
  unknown_age_days: 365,
  /** Reach: each chain past the first, up to chain_max_steps, adds chain_step. */
  chain_step: 0.04,
  chain_max_steps: 4,
  /** The range widens the interquartile band by this factor on each side. */
  range_pad: 0.1,
  /** Score weights, of 100. */
  weights: { scale: 28, momentum: 18, maturity: 14, reach: 10, fit: 18, resilience: 12 },
};

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when a date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * A value's percentile inside a sorted array, mid-ranked: ties share the middle of their span,
 * so the smallest value scores near 0 and the largest near 1, deterministically.
 */
export function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + equal / 2) / sorted.length;
}

/** A quantile of a sorted array by linear interpolation between closest ranks. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** The comparable evidence for one group of protocols: how the traded tokens of its kind price TVL. */
export interface CompStats {
  /** The group this evidence describes (a category, a family, or 'All tokenized protocols'). */
  group: string;
  /** How many tokenized protocols stand behind the numbers. */
  n: number;
  /** Raw quantiles of the group's clamped mcap/TVL multiples. */
  p25: number;
  median: number;
  p75: number;
  /** The same quantiles after shrinkage toward the global evidence; these are what prices rows. */
  use_p25: number;
  use_median: number;
  use_p75: number;
}

/**
 * The broad family a category belongs to, for the dashboard's grouping and for the capture
 * multiplier. Ordered: the narrowest match wins, so "Cross Chain Bridge" reads as a bridge and
 * "Restaking" never reads as plain staking.
 */
export function categoryFamily(category: string | null): { family: string; capture: number } {
  const c = (category ?? '').toLowerCase();
  if (c.includes('bridge')) return { family: 'Bridges', capture: 0.94 };
  if (c.includes('restaking') || c.includes('restak')) return { family: 'Restaking', capture: 1.03 };
  if (c.includes('liquid staking') || c.includes('staking')) return { family: 'Staking', capture: 0.95 };
  if (c.includes('dex') || c.includes('lend') || c.includes('derivative') || c.includes('perpetual') || c.includes('option')) {
    return { family: 'Fee-earning core', capture: 1.08 };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager') || c.includes('collateral')) {
    return { family: 'Curators & managers', capture: 0.98 };
  }
  if (c.includes('yield') || c.includes('cdp') || c.includes('basis') || c.includes('rwa') || c.includes('launchpad') || c.includes('prediction') || c.includes('synthetic') || c.includes('leveraged') || c.includes('farm')) {
    return { family: 'Yield & markets', capture: 1.04 };
  }
  if (c.includes('stable') || c.includes('algo')) return { family: 'Stable assets', capture: 0.93 };
  return { family: 'Other', capture: 1.0 };
}

/** One tokenized protocol, as the Comparables view shows it: the market's own verdict on its kind. */
export interface CompRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

/**
 * The comparable universe: every protocol whose token trades (a market cap on record), its
 * clamped mcap/TVL multiple, and the quantile evidence per category and for the whole market.
 * Thin categories shrink toward the global quantiles, so a group of two mania tokens cannot
 * anchor a price; the shrinkage weight is stated in MODEL and shown on the Method view.
 */
export function compUniverse(snapshot: Snapshot): { rows: CompRow[]; byCategory: Map<string, CompStats>; global: CompStats } {
  const rows: CompRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, p.mcap_usd! / p.tvl_usd)),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1));

  const quantilesOf = (list: number[]): { p25: number; median: number; p75: number } => {
    const sorted = [...list].sort((a, b) => a - b);
    return { p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
  };
  const g = quantilesOf(rows.map((r) => r.multiple));
  const shrink = (n: number, own: number, all: number): number => (n * own + MODEL.shrink_k * all) / (n + MODEL.shrink_k);
  const global: CompStats = {
    group: 'All tokenized protocols',
    n: rows.length,
    p25: g.p25, median: g.median, p75: g.p75,
    use_p25: g.p25, use_median: g.median, use_p75: g.p75,
  };

  const byCategory = new Map<string, CompStats>();
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.category ?? 'Uncategorized';
    const list = buckets.get(key) ?? [];
    list.push(r.multiple);
    buckets.set(key, list);
  }
  for (const [key, list] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const q = quantilesOf(list);
    byCategory.set(key, {
      group: key,
      n: list.length,
      p25: q.p25, median: q.median, p75: q.p75,
      use_p25: shrink(list.length, q.p25, g.p25),
      use_median: shrink(list.length, q.median, g.median),
      use_p75: shrink(list.length, q.p75, g.p75),
    });
  }
  return { rows, byCategory, global };
}

/** The comp evidence a protocol is priced from: its own category's, or the market's when its kind has none. */
export function compsFor(p: SnapshotProtocol, universe: { byCategory: Map<string, CompStats>; global: CompStats }): CompStats {
  return universe.byCategory.get(p.category ?? 'Uncategorized') ?? universe.global;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * Categories that are not protocols waiting on a launch of their own, whatever their record
 * says: a liquid-staking or restaking product is a claim on a token that already trades, and
 * the bridge categories are transit for other assets, not protocols. The snapshot proves the
 * point: its pre-token Bridge rows are WBTC ($7.9B), Coinbase Bridge ($7.2B), Binance Bitcoin,
 * USDT0 and a row of wrapped-Bitcoin products — the house's watchlist rule excludes the same
 * categories for the same reason, and a board that crowns WBTC has failed at its first job.
 */
const PRODUCT_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Canonical Bridge', 'Bridge', 'Cross Chain Bridge', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether the board may rank a protocol: it records no token, and it is not a wrapped, staked,
 * bridged or versioned product of one that trades, nor an exchange's own product. Every
 * watchlist slug passes by construction, so the gate's coverage is carried by this same filter.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !PRODUCT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_START.test(p.name)
  );
}

/** The six audit components of a row's score, each 0..1 as a percentile inside the ranked universe. */
export interface Components {
  scale: number;
  momentum: number;
  maturity: number;
  reach: number;
  fit: number;
  resilience: number;
}

/** One ranked row of board.json, with the whole audit trail the detail card renders. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  /** The board's claim: what a launch would be worth, base case, in whole dollars. */
  implied_value_usd: number;
  /** The honest width of the claim: the comparables' interquartile band, padded. */
  implied_low_usd: number;
  implied_high_usd: number;
  /** 0..100 audit score: the weighted blend of the six components below. */
  score: number;
  components: Components;
  /** The model's working for this row, every multiplier named. */
  model: {
    comp_group: string;
    comp_n: number;
    comp_median_multiple: number;
    comp_p25_multiple: number;
    comp_p75_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    capture_multiplier: number;
    family: string;
  };
  /** Why the row stands where it stands, in the model's own words. */
  reasons: string[];
  /** What could make the claim wrong, in the model's own words; an empty list is itself stated. */
  risks: string[];
  /** The farm plan's totals, so the board can show a plan's price without opening the card. */
  plan: { steps: number; capital_usd: number; weekly_usd: number; hold_days: number };
  farm_steps: string[];
}

const fmtUsd = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

/** An ordinal for a percentile: 1st, 2nd, 3rd, 81st, 92nd, 93rd, everything else th. */
function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

/** The multipliers one protocol gets, before the comparable multiple is applied. */
function adjustments(p: SnapshotProtocol, asOf: string): {
  growthPct: number; growthMult: number; maturityMult: number; chainMult: number; captureMult: number; family: string; age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const chainMult = 1 + MODEL.chain_step * Math.min(Math.max(p.chains.length - 1, 0), MODEL.chain_max_steps);
  const { family, capture } = categoryFamily(p.category);
  return { growthPct, growthMult, maturityMult, chainMult, captureMult: capture, family, age };
}

/** The risk flags one protocol earns from its own record; each names the figure behind it. */
function risksFor(p: SnapshotProtocol, age: number | null, comps: CompStats, floorUsd: number): string[] {
  const risks: string[] = [];
  if (p.change_7d !== null && p.change_7d <= -15) {
    risks.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in seven days: the base the model prices is shrinking, and a launch into outflows prices worse than this base case.`);
  }
  if (p.change_7d === null) {
    risks.push('The snapshot reports no seven-day TVL change for this protocol, so momentum is scored neutral and the growth adjustment is 1.00 by default, not by evidence.');
  }
  if (age !== null && age < 90) {
    risks.push(`Only ${age} days on DefiLlama's record: a young protocol has had little time to build the user base a launch prices, and its TVL has survived no market stress yet.`);
  }
  if (age === null) {
    risks.push('DefiLlama reports no tracking start date, so maturity is scored at the neutral 365-day default; the protocol may be older or younger than the model can see.');
  }
  if (p.chains.length <= 1) {
    risks.push('Live on a single chain: one chain\'s users are the whole market for a launch, and a chain outage or exodus hits the whole position at once.');
  }
  if (comps.n < 5) {
    risks.push(`Only ${comps.n} tokenized comparable${comps.n === 1 ? '' : 's'} in its category, so its price leans on the whole market's multiples (shrunk with weight ${MODEL.shrink_k}); treat the range as wider than printed.`);
  }
  if (comps.use_median < 0.1) {
    risks.push(`Its kind trades cheap: tokenized comparables price at a median ${comps.use_median.toFixed(3)}x TVL, so even a large TVL may launch small; the base case already reflects this.`);
  }
  if (p.tvl_usd < floorUsd) {
    risks.push(`Below the house's $${Math.round(floorUsd / 1e6)}M watchlist floor: an early-radar pick, where launches are likelier to be small and likelier never to come at all.`);
  }
  return risks;
}

/** The reasons one protocol stands where it stands: its three strongest components, in words. */
function reasonsFor(
  p: SnapshotProtocol, age: number | null, comps: CompStats, c: Components,
): string[] {
  const named: [string, number][] = [
    [`Scale: ${fmtUsd(p.tvl_usd)} of TVL puts it at the ${ordinal(Math.round(c.scale * 100))} percentile of the ranked pre-token universe`, c.scale],
    [`Momentum: TVL moved ${p.change_7d === null ? 'an unreported amount' : `${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}%`} in seven days, the ${ordinal(Math.round(c.momentum * 100))} percentile of the board`, c.momentum],
    [`Maturity: ${age === null ? 'an unreported span' : `${age.toLocaleString('en-US')} days`} tracked with no token on record, the ${ordinal(Math.round(c.maturity * 100))} percentile of tokenless patience`, c.maturity],
    [`Reach: live on ${p.chains.length} chain${p.chains.length === 1 ? '' : 's'} (${p.chains.slice(0, 3).join(', ')}${p.chains.length > 3 ? ', ...' : ''}), the ${ordinal(Math.round(c.reach * 100))} percentile of the board`, c.reach],
    [`Comparables: ${comps.n} tokenized ${comps.group === 'All tokenized protocols' ? 'protocols market-wide' : `${comps.group} protocol${comps.n === 1 ? '' : 's'}`} with a median price of ${comps.use_median.toFixed(2)}x TVL after shrinkage, the ${ordinal(Math.round(c.fit * 100))} percentile of category pricing`, c.fit],
    [`Resilience: its seven-day drawdown is among the shallowest ${Math.round((1 - c.resilience) * 100)}% of the board, so the base is not melting under the price`, c.resilience],
  ];
  return named.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text]) => text);
}

/** The ranked board: every rankable pre-token protocol, priced from comparables, strongest first. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const universe = compUniverse(snapshot);
  const watch = new Set(snapshot.watchlist);
  const ranked = snapshot.protocols.filter(isRankable);
  const adj = new Map(ranked.map((p) => [p.slug, adjustments(p, snapshot.as_of)]));

  // Percentile axes over the ranked universe itself, so every component is auditable against the board.
  const logTvl = ranked.map((p) => Math.log10(Math.max(1, p.tvl_usd))).sort((a, b) => a - b);
  const growth = ranked.map((p) => finite(p.change_7d, 0)).sort((a, b) => a - b);
  const ages = ranked.map((p) => adj.get(p.slug)!.age ?? MODEL.unknown_age_days).sort((a, b) => a - b);
  const reaches = ranked.map((p) => p.chains.length).sort((a, b) => a - b);
  const drawdowns = ranked.map((p) => Math.min(0, finite(p.change_7d, 0))).sort((a, b) => a - b);
  const fits = [...universe.byCategory.values()].map((s) => s.use_median).sort((a, b) => a - b);
  const w = MODEL.weights;

  const scored = ranked.map((p) => {
    const a = adj.get(p.slug)!;
    const comps = compsFor(p, universe);
    const components: Components = {
      scale: percentile(logTvl, Math.log10(Math.max(1, p.tvl_usd))),
      momentum: percentile(growth, finite(p.change_7d, 0)),
      maturity: percentile(ages, a.age ?? MODEL.unknown_age_days),
      reach: percentile(reaches, p.chains.length),
      fit: percentile(fits, comps.use_median),
      resilience: percentile(drawdowns, Math.min(0, finite(p.change_7d, 0))),
    };
    const score = Math.round(
      w.scale * components.scale + w.momentum * components.momentum + w.maturity * components.maturity +
      w.reach * components.reach + w.fit * components.fit + w.resilience * components.resilience,
    );
    const adjAll = a.growthMult * a.maturityMult * a.chainMult * a.captureMult;
    const implied = Math.max(1, Math.round(p.tvl_usd * comps.use_median * adjAll));
    const low = Math.max(1, Math.min(implied, Math.round(p.tvl_usd * comps.use_p25 * adjAll * (1 - MODEL.range_pad))));
    const high = Math.max(implied, Math.round(p.tvl_usd * comps.use_p75 * adjAll * (1 + MODEL.range_pad)));
    return { p, a, comps, components, score, implied, low, high };
  });

  scored.sort((x, y) => y.implied - x.implied || (x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const steps = farmSteps(s.p, s.a.age);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.a.age,
      on_watchlist: watch.has(s.p.slug),
      token_status: 'pre-token' as const,
      implied_value_usd: s.implied,
      implied_low_usd: s.low,
      implied_high_usd: s.high,
      score: s.score,
      components: {
        scale: round4(s.components.scale), momentum: round4(s.components.momentum),
        maturity: round4(s.components.maturity), reach: round4(s.components.reach),
        fit: round4(s.components.fit), resilience: round4(s.components.resilience),
      },
      model: {
        comp_group: s.comps.group,
        comp_n: s.comps.n,
        comp_median_multiple: round4(s.comps.use_median),
        comp_p25_multiple: round4(s.comps.use_p25),
        comp_p75_multiple: round4(s.comps.use_p75),
        growth_pct: s.a.growthPct,
        growth_multiplier: round4(s.a.growthMult),
        maturity_multiplier: round4(s.a.maturityMult),
        chain_multiplier: round4(s.a.chainMult),
        capture_multiplier: s.a.captureMult,
        family: s.a.family,
      },
      reasons: reasonsFor(s.p, s.a.age, s.comps, s.components),
      risks: risksFor(s.p, s.a.age, s.comps, snapshot.floor_usd),
      plan: planTotals(s.p, s.a.age),
      farm_steps: steps.map(stepText),
    };
  });
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL: deeper books, deeper tickets. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** What one transaction costs on the protocol's main chain, in the words a farmer budgets with. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $8-15 of gas per transaction on Ethereum';
  if (c === 'solana') return 'under $0.05 of gas per transaction on Solana';
  if (c === 'bitcoin' || c === 'tron' || c === 'hyperliquid l1') return 'a few dollars of gas per transaction';
  return 'about $0.10-0.50 of gas per transaction on this low-fee chain';
}

/** The category's main qualifying action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then put the bridged funds to work in an app on that chain instead of bridging straight back.`;
  if (c.includes('restak')) return `Restake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the same wallet.`;
  if (c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position you can explain.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one small position on an early market on ${name}, sized so a total loss is acceptable.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares untouched.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the balance.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it in the farming wallet.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for its full term.`;
  if (c.includes('launchpad')) return `Join ${name}'s next sale on ${chain} with $${capital} and hold the allocation through its lock.`;
  if (c.includes('farm')) return `Stake $${capital} of LP tokens in ${name}'s farm on ${chain} and let the rewards accrue untouched.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s shielded pool on ${chain} and keep the private balance for the holding window.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action: a different touch, so the wallet shows real use. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const half = Math.max(10, Math.round(capital / 2));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow 10-20% of your supplied collateral in a stablecoin from ${name}, hold it two days, then repay in full: a borrow and a repay are two more qualifying touches.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('liquidity manager')) return `Swap about $10 through ${name}'s main pool on ${chain}, then add a second, smaller $${half} liquidity position and leave both in place.`;
  if (c.includes('bridge')) return `A week later, bridge a second, smaller $${half} the other way through ${name} so the record shows two-way use across two snapshot windows, not one deposit.`;
  if (c.includes('restak') || c.includes('staking')) return `Add a second $${half} tranche through ${name}, claim any rewards the app shows, and restake them instead of withdrawing.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Close the first position, then open a second small one in the opposite direction on ${name}, keeping total exposure under $${capital} at all times.`;
  if (c.includes('prediction')) return `Place a second small position on a different ${name} market, early in its life, and let it settle instead of trading it out.`;
  if (c.includes('rwa')) return `Mint a second $${half} tranche a week later and check the yield accrual page each week so the position shows steady holding.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit a second $${half} into a different ${name} vault on ${chain} and compare the two vaults' reported yields each week.`;
  return `A week later, deposit a second $${half} and use one more feature of ${name} on ${chain} - a vote, a claim, or the points page - so the wallet shows more than a single deposit.`;
}

/** A plan's totals: what the whole plan costs a farmer, before they open the card. */
export function planTotals(p: SnapshotProtocol, age: number | null): { steps: number; capital_usd: number; weekly_usd: number; hold_days: number } {
  return { steps: 8, capital_usd: capitalFor(p), weekly_usd: 2, hold_days: holdDaysFor(age) };
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL, age) by the same rules for every row. The plan
 * starts with eligibility reconnaissance, because farming a protocol with no points or snapshot
 * program is speculation, and says so in the plan itself when the record cannot confirm one.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const half = Math.max(10, Math.round(capital / 2));
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper, never in a screenshot, a note app or a chat.`,
      cost: 'nothing but a new wallet',
      time: '5 minutes',
    },
    {
      text: `Before depositing anything, open ${p.name}'s own site from the protocol's official listing and read its points, rewards or docs page: note whether a points program or snapshot is actually running, its start date and what it counts. If none exists, this farm is early speculation - size it like one.`,
      cost: 'nothing to read',
      time: '15 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, capital, chain),
      cost: `about $${half} of capital and ${gas}`,
      time: '10 minutes',
    },
    secondChain !== null
      ? {
          text: `Repeat the main action once on ${secondChain}, where ${p.name} also runs, with about $${half}: multi-chain use is the cheapest signal that a wallet is a real user and not a one-chain script.`,
          cost: `about $${half} of capital and the second chain's gas`,
          time: '15 minutes',
        }
      : {
          text: `Deepen instead of widening: add about $${half} to the same position on ${chain} a week after the first deposit, so the wallet's balance history rises in steps instead of landing in one lump.`,
          cost: `about $${half} of capital and ${gas}`,
          time: '10 minutes',
        },
    {
      text: `Once a week, repeat one qualifying action - a deposit, a swap, a borrow, a vote or a claim - and claim any points or rewards the app shows, restaking them rather than selling, so the wallet reads as a steady user across the whole window.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot window. While holding, re-check ${p.name}'s TVL trend and its own announcements monthly; a protocol draining TVL for a month is a reason to leave early, plan or no plan.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Keep a farm log as you go - wallet address, dates, amounts, every transaction hash - and when you unwind, withdraw in two tranches a day apart so one failed transaction never strands the whole position. If a claim ever opens, claim only from the link the protocol itself publishes.`,
      cost: `nothing but the log, and ${gas} to exit`,
      time: '5 minutes to log, 10 minutes to exit',
    },
  ];
}

/** Everything the dashboard renders: the board, the comparable universe, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  protocols_scanned: number;
  tokenized_seen: number;
  board_size: number;
  watchlist_size: number;
  early_size: number;
  global_comps: CompStats;
  categories: CompStats[];
  comps: CompRow[];
  rows: BoardRow[];
}

/** The whole radar from one snapshot: board, comparables, and the dashboard's dataset in one pass. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const universe = compUniverse(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    protocols_scanned: snapshot.protocols.length,
    tokenized_seen: universe.rows.length,
    board_size: board.length,
    watchlist_size: snapshot.watchlist.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    global_comps: universe.global,
    categories: [...universe.byCategory.values()].sort((a, b) => b.n - a.n || (a.group < b.group ? -1 : 1)),
    comps: universe.rows,
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, farm steps, ranges. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!(r.implied_low_usd <= r.implied_value_usd && r.implied_value_usd <= r.implied_high_usd)) return `${r.slug} has a range that does not hold its base case`;
    if (r.score < 0 || r.score > 100) return `${r.slug} has score ${r.score}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
