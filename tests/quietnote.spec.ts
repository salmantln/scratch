import { test, expect, type Page } from '@playwright/test';
import { demoMeetings } from '../src/quietnote/seeds';
import { section, replaceSection, toggleAction, matchesMeeting, searchMeeting, makeMeeting, transcriptTurns, validProjectName, appendItem, actionItems } from '../src/quietnote/model';

async function examples(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore example meetings' }).click();
  await expect(page.locator('.meeting-row')).toHaveCount(6);
}
async function firstProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}
async function newMeeting(page: Page, title: string) {
  await page.locator('.new-meeting').click();
  await page.getByLabel('Meeting title').fill(title);
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const recent = (page: Page) => page.getByRole('button', { name: 'Recent', exact: true });

test('model keeps Markdown sections separate and never invents content', () => {
  expect(demoMeetings).toHaveLength(6);
  for (const meeting of demoMeetings) {
    expect(section(meeting.markdown, 'Summary').length).toBeGreaterThan(80);
    expect(actionItems(meeting.markdown).length).toBeGreaterThanOrEqual(3);
    expect(meeting.markdown).not.toContain('### 00:');
    expect(transcriptTurns(meeting.transcript).length).toBeGreaterThan(0);
  }
  const meeting = demoMeetings[0];
  const changed = replaceSection(meeting.markdown, 'Notes', 'A new manual note.');
  expect(section(changed, 'Summary')).toBe(section(meeting.markdown, 'Summary'));
  expect(section(changed, 'Notes')).toBe('A new manual note.');
  expect(section(replaceSection(changed, 'Notes', '## My heading\nNested manual text'), 'Notes')).toContain('Nested manual text');
  expect(toggleAction(meeting.markdown, 1)).toContain('- [x] Tom');
  expect(matchesMeeting(meeting, 'sample dataset')).toBe(true);
  expect(searchMeeting(meeting, 'sample dataset')?.tab).toBe('Transcript');
  expect(searchMeeting(meeting, 'analytics credentials')?.tab).toBe('Action items');
  expect(searchMeeting(meeting, 'nothing like this')).toBeNull();
  const blank = makeMeeting('Kickoff', 'Acme');
  expect(section(blank.markdown, 'Summary')).toBe('');
  expect(transcriptTurns(blank.transcript)).toHaveLength(0);
  expect(blank.metadata.status).toBe('idle');
  const added = appendItem(blank.markdown, 'Action items', 'Maya — send the plan');
  expect(actionItems(added)).toEqual([{ index: 0, done: false, text: 'send the plan', owner: 'Maya' }]);
  expect(section(added, 'Notes')).toBe('');
  expect(validProjectName('Acme')).toBe('');
  expect(validProjectName('../Acme')).not.toBe('');
  expect(validProjectName('  ')).not.toBe('');
});

test('A: first launch creates a project, then a meeting', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Keep the useful part of every meeting.' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/00-welcome.png' });
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('../Acme');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('alert')).toContainText('Use letters, numbers');
  await page.getByLabel('Project name').fill('Acme');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(page.getByText('Nothing here yet.')).toBeVisible();
  await expect(page.getByText('Meetings for Acme will appear here.')).toBeVisible();
  await page.locator('.empty-state').getByRole('button', { name: 'New meeting' }).click();
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('Acme');
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  await expect(page.getByText('No summary yet.')).toBeVisible();
  await tab(page, 'Transcript').click();
  await expect(page.getByText('Transcript unavailable.')).toBeVisible();
  await tab(page, 'Action items').click();
  await expect(page.getByText('No action items yet.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Add an action item' }).fill('Maya — send the plan');
  await page.keyboard.press('Enter');
  await expect(page.locator('.action-text')).toHaveText('send the plan');
  await expect(page.locator('.action-owner')).toHaveText('Maya');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  await expect(tab(page, 'Action items')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.action-text')).toHaveText('send the plan');
});

test('B: prototype capture is labelled honestly and invents nothing', async ({ page }) => {
  await firstProject(page, 'Acme');
  await newMeeting(page, 'Design handoff');
  await page.getByRole('button', { name: 'Start capture' }).click();
  const capture = page.getByRole('dialog', { name: 'Design handoff' });
  await expect(capture).toContainText('This version does not record audio.');
  await expect(capture).toContainText('Not capturing');
  await capture.getByRole('button', { name: 'Start capture' }).click();
  await expect(capture).toContainText('Capturing');
  await expect(capture).toContainText('Started by you · No bot joins the call');
  await expect(capture.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(capture).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/03-capture.png' });
  await capture.getByRole('button', { name: 'Stop capture' }).click();
  await expect(capture).toContainText('Capture ended');
  await expect(capture).toContainText('No audio was recorded.');
  await capture.getByRole('button', { name: 'Add notes' }).click();
  await expect(capture).toHaveCount(0);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tiptap')).toBeVisible();
  await tab(page, 'Summary').click();
  await expect(page.getByText('No summary yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start capture' })).toHaveCount(0);
  await tab(page, 'Transcript').click();
  await expect(page.getByText('Transcript unavailable.')).toBeVisible();
  await recent(page).click();
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await expect(page.locator('.meeting-row .status')).toHaveCount(0);
});

test('C: review an example meeting, toggle actions, edit notes, read the transcript', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await examples(page);
  await expect(page.locator('.meeting-row .badge.example')).toHaveCount(6);
  await page.screenshot({ path: 'docs/screenshots/01-library.png' });
  await page.getByRole('button', { name: /Acme onboarding call/ }).click();
  await expect(page.getByText('Acme is ready to move into implementation.', { exact: false })).toBeVisible();
  await expect(page.locator('.summary-preview .decision-list li')).toHaveCount(3);
  await page.screenshot({ path: 'docs/screenshots/02-summary.png' });
  await page.getByRole('button', { name: '4 of 4 open' }).click();
  await expect(tab(page, 'Action items')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.action-row input').first().check();
  await expect(tab(page, 'Action items')).toContainText('3');
  await page.reload();
  await expect(page.locator('.action-row input').first()).toBeChecked();
  await expect(page.locator('.action-row.complete')).toHaveCount(1);
  await tab(page, 'Notes').click();
  const editor = page.locator('.tiptap');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Confirm sandbox access before Monday’s review.');
  await expect(page.getByRole('status').filter({ hasText: 'Saved in this browser' })).toBeVisible();
  await recent(page).click();
  await page.getByRole('button', { name: /Weekly product sync/ }).click();
  await tab(page, 'Notes').click();
  await expect(editor).not.toContainText('Confirm sandbox access');
  await recent(page).click();
  await page.getByRole('button', { name: /Acme onboarding call/ }).click();
  await tab(page, 'Notes').click();
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  await page.screenshot({ path: 'docs/screenshots/05-notes.png' });
  await tab(page, 'Transcript').click();
  await expect(page.locator('.transcript-turn')).toHaveCount(6);
  await expect(page.getByText('Example transcript · illustrative, not a recording')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/06-transcript.png' });
  await page.getByRole('textbox', { name: 'Find in transcript' }).fill('credentials');
  await expect(page.locator('.transcript-turn')).toHaveCount(2);
  await page.reload();
  await tab(page, 'Notes').click();
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  expect(errors).toEqual([]);
});

test('D: search finds a decision weeks later and opens the right place', async ({ page }) => {
  await examples(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('searchbox', { name: 'Search meetings' });
  await expect(input).toBeFocused();
  await input.fill('phase two');
  const result = page.locator('.result').first();
  await expect(result).toContainText('Acme onboarding call');
  await expect(result.locator('mark').first()).toHaveText(/phase two/i);
  await page.screenshot({ path: 'docs/screenshots/07-search.png' });
  await input.fill('sample dataset');
  await expect(page.locator('.result')).toHaveCount(1);
  await expect(page.locator('.result-meta')).toContainText('in Transcript');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.transcript-turn').filter({ hasText: 'sample dataset' })).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await input.fill('zzqx');
  await expect(page.getByText('No meetings found for ‘zzqx’.')).toBeVisible();
});

test('E: privacy separates active from planned, and the confirm preference is enforced', async ({ page }) => {
  await firstProject(page, 'Internal');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Active now' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Planned/ })).toBeVisible();
  await expect(page.getByText('Stored in this browser')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Allow cloud processing' })).toBeDisabled();
  await page.getByRole('switch', { name: 'Confirm before capture' }).click();
  await page.getByRole('combobox', { name: 'Keep meeting data' }).selectOption('30');
  await page.screenshot({ path: 'docs/screenshots/04-privacy.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Confirm before capture' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Keep meeting data' })).toHaveValue('30');
  await page.getByRole('button', { name: 'Local archive' }).click();
  await expect(page.getByText('This browser preview keeps meetings in this browser only.', { exact: false })).toBeVisible();
  await newMeeting(page, 'Standup');
  await page.getByRole('button', { name: 'Start capture' }).click();
  await expect(page.getByRole('dialog')).toContainText('Capturing');
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.getByRole('dialog')).toContainText('Capture ended');
  await page.getByRole('button', { name: 'Close' }).click();
  for (const width of [600, 800, 1080, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'QuietNote', exact: true }).click();
    await expect(page.locator('.meeting-row').first()).toBeVisible();
    expect(await page.locator('.qn-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

test('F: a failed save keeps a draft that can be retried or discarded', async ({ page }) => {
  await examples(page);
  await page.getByRole('button', { name: /Acme onboarding call/ }).click();
  await tab(page, 'Action items').click();
  const failWrites = () => page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'quietnote.preview.archive.v1') throw new Error('Simulated unavailable archive');
      return original.call(this, key, value);
    };
  });
  await failWrites();
  await page.locator('.action-row input').first().check();
  await expect(page.getByRole('alert')).toContainText('Your latest changes haven’t been saved in this browser.');
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Recovered unsaved changes from your last session.');
  await page.getByRole('button', { name: 'Save now' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.action-row input').first()).toBeChecked();
  await failWrites();
  await page.locator('.action-row input').nth(1).check();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Reload saved version' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.action-row.complete')).toHaveCount(1);
});

test('G: a meeting interrupted mid-capture reopens as needing attention', async ({ page }) => {
  await firstProject(page, 'Northstar');
  await newMeeting(page, 'Pilot review');
  await page.evaluate(() => {
    const key = 'quietnote.preview.archive.v1';
    const meetings = JSON.parse(localStorage.getItem(key)!);
    meetings[0].metadata.status = 'recording';
    localStorage.setItem(key, JSON.stringify(meetings));
  });
  await page.reload();
  await expect(page.getByText('This meeting was interrupted before it finished.')).toBeVisible();
  await recent(page).click();
  await expect(page.locator('.meeting-row .status')).toHaveText('Needs attention');
  await page.getByRole('button', { name: /Pilot review/ }).click();
  await page.getByRole('button', { name: 'Mark as ended' }).click();
  await expect(page.getByText('This meeting was interrupted before it finished.')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('This meeting was interrupted before it finished.')).toHaveCount(0);
});

test('H: shortcut hints stay hidden until ⌘ is held on its own', async ({ page }) => {
  await examples(page);
  const hints = page.locator('.qn-sidebar kbd');
  await expect(hints).toHaveCount(7);
  for (const hint of await hints.all()) await expect(hint).toBeHidden();
  await page.keyboard.down('Meta');
  for (const hint of await hints.all()) await expect(hint).toBeVisible();
  await page.keyboard.up('Meta');
  for (const hint of await hints.all()) await expect(hint).toBeHidden();
  await page.keyboard.down('Meta');
  await page.keyboard.press(',');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  for (const hint of await hints.all()) await expect(hint).toBeHidden();
  await page.keyboard.down('Meta');
  await expect(page.locator('.project-item', { hasText: 'Internal' }).locator('kbd')).toHaveText('⌘2');
  await expect(page.locator('.project-item', { hasText: 'Internal' }).locator('.sidebar-count')).toBeHidden();
  await page.keyboard.press('2');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('heading', { level: 1, name: 'Internal' })).toBeVisible();
  await expect(page.locator('.project-item', { hasText: 'Internal' }).locator('.sidebar-count')).toHaveText('2');
});
