import prDashboard from './canvas-template-prompts/developers/pr-dashboard.md?canvas-template';
import emailNotificationScreener from './canvas-template-prompts/developers/email-notification-screener.md?canvas-template';
import repositoryChangesPodcast from './canvas-template-prompts/developers/repository-changes-podcast.md?canvas-template';
import granolaFeatureRequests from './canvas-template-prompts/product-managers/granola-feature-requests.md?canvas-template';
import competitorChangeMonitor from './canvas-template-prompts/product-managers/competitor-change-monitor.md?canvas-template';
import schoolNotificationsAndCalendar from './canvas-template-prompts/parents/school-notifications-and-calendar.md?canvas-template';
import sharedGroceryList from './canvas-template-prompts/parents/shared-grocery-list.md?canvas-template';
import familyCalendarFeed from './canvas-template-prompts/parents/family-calendar-feed.md?canvas-template';
import recruitingMarketMap from './canvas-template-prompts/recruiters/recruiting-market-map.md?canvas-template';

const templates = [
  prDashboard,
  emailNotificationScreener,
  repositoryChangesPodcast,
  granolaFeatureRequests,
  competitorChangeMonitor,
  schoolNotificationsAndCalendar,
  sharedGroceryList,
  familyCalendarFeed,
  recruitingMarketMap,
];

function category(tag: string, label: string) {
  return { label, templates: templates.filter((template) => template.tags.includes(tag)) };
}

export const CANVAS_TEMPLATE_CATEGORIES = [
  category('developers', 'Developers'),
  category('product-managers', 'Product managers'),
  category('parents', 'Parents'),
  category('recruiters', 'Recruiters'),
] as const;
