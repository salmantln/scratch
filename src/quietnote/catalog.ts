import type { Service } from './storage';
import asana from './brands/asana.svg';
import github from './brands/github.svg';
import gmail from './brands/gmail.svg';
import googleCalendar from './brands/google-calendar.svg';
import googleDocs from './brands/google-docs.svg';
import googleMeet from './brands/google-meet.svg';
import jira from './brands/jira.svg';
import linear from './brands/linear.svg';
import notion from './brands/notion.svg';
import obsidian from './brands/obsidian.svg';
import outlook from './brands/outlook.svg';
import slack from './brands/slack.svg';
import teams from './brands/teams.svg';
import todoist from './brands/todoist.svg';
import zoom from './brands/zoom.svg';
export const categories = ['Tasks', 'Meetings', 'Calendars', 'Email & chat', 'Notes & docs'] as const;
export type Category = typeof categories[number];
/**
 * A directory entry. Only entries with `service` actually connect; the rest are planned and do nothing.
 * `logo` is a bundled brand mark. `app` entries show the icon of the app installed on this Mac (Apple doesn't
 * publish its icons for reuse), falling back to a `monogram` tile in `color`.
 */
export interface Connector { id: string; name: string; category: Category; blurb: string; logo?: string; app?: true; color?: string; monogram?: string; service?: Service; setup?: { url: string; hint: string } }
const call = 'Notice a call on this Mac and offer to start capture. Never joins the call.';
const events = 'Fill in a meeting’s title, time and attendees from an event. Never joins or starts capture.';
export const connectors: Connector[] = [
  { id: 'linear', name: 'Linear', category: 'Tasks', blurb: 'Send action items to a team as Linear issues.', logo: linear, service: 'linear', setup: { url: 'https://linear.app/settings/account/security', hint: 'Create a personal API key in Linear under Settings → Security & access.' } },
  { id: 'github', name: 'GitHub', category: 'Tasks', blurb: 'Send action items to a repository as issues.', logo: github, service: 'github', setup: { url: 'https://github.com/settings/personal-access-tokens/new', hint: 'Create a fine-grained token with Issues set to “Read and write” for the repositories you want.' } },
  { id: 'jira', name: 'Jira', category: 'Tasks', blurb: 'Send action items as Jira issues.', logo: jira },
  { id: 'asana', name: 'Asana', category: 'Tasks', blurb: 'Send action items as Asana tasks.', logo: asana },
  { id: 'todoist', name: 'Todoist', category: 'Tasks', blurb: 'Add action items to a Todoist project.', logo: todoist },
  { id: 'things', name: 'Things', category: 'Tasks', blurb: 'Add action items to Things on this Mac.', app: true, color: '2473E7', monogram: 'T' },
  { id: 'reminders', name: 'Apple Reminders', category: 'Tasks', blurb: 'Add action items to Reminders on this Mac.', app: true, color: 'F29B38', monogram: 'R' },
  { id: 'zoom', name: 'Zoom', category: 'Meetings', blurb: call, logo: zoom },
  { id: 'meet', name: 'Google Meet', category: 'Meetings', blurb: call, logo: googleMeet },
  { id: 'teams', name: 'Microsoft Teams', category: 'Meetings', blurb: call, logo: teams },
  { id: 'gcal', name: 'Google Calendar', category: 'Calendars', blurb: events, logo: googleCalendar },
  { id: 'outlook', name: 'Outlook Calendar', category: 'Calendars', blurb: events, logo: outlook },
  { id: 'ical', name: 'Apple Calendar', category: 'Calendars', blurb: events, app: true, color: 'FF3B30', monogram: '31' },
  { id: 'gmail', name: 'Gmail', category: 'Email & chat', blurb: 'Draft a follow-up email for you to review and send yourself.', logo: gmail },
  { id: 'slack', name: 'Slack', category: 'Email & chat', blurb: 'Draft a post of a meeting’s decisions for you to review before sending.', logo: slack },
  { id: 'notion', name: 'Notion', category: 'Notes & docs', blurb: 'Export a meeting to a Notion page when you choose.', logo: notion },
  { id: 'obsidian', name: 'Obsidian', category: 'Notes & docs', blurb: 'Copy a meeting into an Obsidian vault on this Mac.', logo: obsidian },
  { id: 'gdocs', name: 'Google Docs', category: 'Notes & docs', blurb: 'Export a meeting as a Google Doc when you choose.', logo: googleDocs },
];
export const serviceName = (service: Service) => connectors.find(c => c.service === service)!.name;
export function matchesConnector(c: Connector, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${c.name} ${c.blurb} ${c.category}`.toLowerCase().includes(q);
}
