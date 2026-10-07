// Price and usage per type of user, shared by marketplace agents and registry listings.

export const AUDIENCES = ['education', 'individuals', 'business'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const AUDIENCE_LABELS: Record<Audience, { title: string; who: string }> = {
  education: { title: 'Education', who: 'Students, teachers, schools, orphanages and non-profits' },
  individuals: { title: 'Individuals', who: 'People using it for themselves' },
  business: { title: 'Business', who: 'Companies and businesses' },
};

export type PriceKind = 'free' | 'paid' | 'contact' | 'unknown';

export interface Plan {
  price: PriceKind;
  amount?: number;
  currency?: string;
  period?: 'month' | 'year' | 'one-time' | 'per-use';
  usage?: string;
}

export type Pricing = Record<Audience, Plan>;

const PERIOD_LABELS: Record<NonNullable<Plan['period']>, string> = {
  month: '/ month',
  year: '/ year',
  'one-time': 'one-time',
  'per-use': 'per use',
};

/** "Free", "$19 / month", "Contact the developer", "Not published". */
export function formatPlan(plan: Plan | undefined): string {
  if (!plan) return 'Not published';
  switch (plan.price) {
    case 'free':
      return 'Free';
    case 'contact':
      return 'Contact the developer';
    case 'unknown':
      return 'Not published';
    case 'paid': {
      if (plan.amount == null) return 'Paid';
      const money = new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: plan.currency || 'USD',
        maximumFractionDigits: plan.amount % 1 === 0 ? 0 : 2,
      }).format(plan.amount);
      return plan.period ? `${money} ${PERIOD_LABELS[plan.period]}` : money;
    }
  }
}

/** Free-for-everyone, or a short "Free for education · $19 / month for business". */
export function pricingSummary(pricing: Pricing | undefined): string {
  if (!pricing) return 'Pricing not published';
  const labels = AUDIENCES.map((a) => formatPlan(pricing[a]));
  if (labels.every((l) => l === 'Free')) return 'Free for everyone';
  if (labels.every((l) => l === 'Not published')) return 'Pricing not published';
  const business = formatPlan(pricing.business);
  return pricing.education?.price === 'free' ? `Free for education · ${business} for business` : `${business} for business`;
}

/**
 * Check pricing submitted for a marketplace agent. Agents must be free for education.
 * Returns the cleaned pricing, or an error message.
 */
export function parseAgentPricing(input: unknown): { pricing: Pricing } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'pricing must be an object' };
  const out = {} as Pricing;
  for (const audience of AUDIENCES) {
    const raw = (input as Record<string, unknown>)[audience] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return { error: `pricing.${audience} is required` };
    const price = raw.price;
    if (!['free', 'paid', 'contact', 'unknown'].includes(price as string)) {
      return { error: `pricing.${audience}.price must be free, paid, contact or unknown` };
    }
    const plan: Plan = { price: price as PriceKind };
    if (price === 'paid') {
      const amount = Number(raw.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { error: `pricing.${audience}.amount must be a positive number` };
      if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) {
        return { error: `pricing.${audience}.currency must be a 3-letter code like USD` };
      }
      if (!['month', 'year', 'one-time', 'per-use'].includes(raw.period as string)) {
        return { error: `pricing.${audience}.period must be month, year, one-time or per-use` };
      }
      plan.amount = amount;
      plan.currency = raw.currency;
      plan.period = raw.period as Plan['period'];
    }
    if (raw.usage != null) {
      if (typeof raw.usage !== 'string' || raw.usage.length > 200) {
        return { error: `pricing.${audience}.usage must be text of at most 200 characters` };
      }
      plan.usage = raw.usage.trim();
    }
    out[audience] = plan;
  }
  if (out.education.price !== 'free') return { error: 'Agents must be free for education' };
  return { pricing: out };
}
