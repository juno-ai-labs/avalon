import { PLAN_IDS, PLANS, weeklyQuotaMicrousd, type PlanId } from '@rally/contracts/plans';

const presentation = {
  starter: { action: 'start', description: 'A little room to begin.' },
  growth: { action: 'grow', description: 'For a steady flow of good work.' },
  max: { action: 'max', description: 'For bigger ideas and busy days.' },
  ultra: { action: 'ultra', description: 'For the work that keeps growing.' },
} satisfies Record<PlanId, { action: string; description: string }>;

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

/** Build-time pricing uses the same catalog and weekly allowance as the product. */
export function renderHomePricing(): string {
  return PLAN_IDS.map((id) => {
    const plan = PLANS[id];
    const { action, description } = presentation[id];
    const featured = id === 'growth';
    const free = plan.monthlyPriceUsd === 0;
    return `<article class="plan${featured ? ' grow' : ''}" aria-labelledby="plan-${action}">
      <h3 class="plan-name" id="plan-${action}">${plan.name}${featured ? ' <span>A little more room</span>' : ''}</h3>
      <p class="price">${dollars.format(plan.monthlyPriceUsd)}<span> / month</span></p>
      <p>${description}</p>
      <ul>
        <li>${dollars.format(plan.includedUsageUsd)} of effective usage</li>
        <li>${dollars.format(weeklyQuotaMicrousd(id) / 1_000_000)} allocated each week</li>
        <li>One shared quota for everyone</li>
        <li>No seat limit</li>
      </ul>
      <a class="button ${featured ? 'primary' : 'secondary'}" data-site-action="download-pricing-${action}"
        href="https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg" download>
        ${free ? 'Start for free' : 'Start free trial'}
        <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M4 14L14 4M4 4h10v10" /></svg></span>
      </a>
    </article>`;
  }).join('');
}
