import { test, expect } from '@playwright/test';
import { demoMeetings } from '../src/quietnote/seeds';
import { section, replaceSection, toggleAction, matchesMeeting } from '../src/quietnote/model';

test('Markdown sections preserve other sections and transcript is separate', () => {
  expect(demoMeetings).toHaveLength(6);
  for (const meeting of demoMeetings) {
    expect(section(meeting.markdown, 'Summary').length).toBeGreaterThan(80);
    expect(section(meeting.markdown, 'Action items').split('\n').length).toBeGreaterThanOrEqual(3);
    expect(meeting.markdown).not.toContain('### 00:');
    expect(meeting.transcript).toContain('### 00:00');
  }
  const meeting = demoMeetings[0];
  const changed = replaceSection(meeting.markdown, 'Notes', 'A new manual note.');
  expect(section(changed, 'Summary')).toBe(section(meeting.markdown, 'Summary'));
  expect(section(changed, 'Notes')).toBe('A new manual note.');
  const nested = replaceSection(changed, 'Notes', '## My heading\nNested manual text');
  expect(section(nested, 'Notes')).toContain('Nested manual text');
  expect(toggleAction(meeting.markdown, 1)).toContain('- [x] Tom');
  expect(matchesMeeting(meeting, 'historical data')).toBe(true);
  expect(matchesMeeting(meeting, 'sample dataset')).toBe(true);
});

test('library, projects, search and task persistence', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.meeting-row')).toHaveCount(6);
  await page.screenshot({ path: 'docs/screenshots/01-library.png' });
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('Acme');
  await expect(page.locator('.meeting-row')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('All projects');
  await page.getByRole('textbox', { name: 'Search meetings', exact: true }).fill('sample dataset');
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await page.locator('.meeting-row').click();
  await expect(page.getByRole('heading', { name: 'Acme onboarding call' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/02-summary.png' });
  await page.locator('.action-row input').first().check();
  await expect(page.getByText('1 of 4 complete')).toBeVisible();
  await page.reload();
  await page.locator('.meeting-row').first().click();
  await expect(page.locator('.action-row input').first()).toBeChecked();
});

test('original editor saves while switching meetings; transcripts remain separate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.locator('.meeting-row').first().click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const editor = page.locator('.tiptap');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Confirm sandbox access before Monday’s review.');
  await page.getByRole('button', { name: 'Weekly product sync', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(editor).not.toContainText('Confirm sandbox access before Monday’s review.');
  await page.getByRole('button', { name: 'Acme onboarding call', exact: true }).click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  await page.screenshot({ path: 'docs/screenshots/05-notes.png' });
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.locator('.transcript-turn')).toHaveCount(6);
  await page.screenshot({ path: 'docs/screenshots/06-transcript.png' });
  await page.getByRole('textbox', { name: 'Find in transcript' }).fill('credentials');
  await expect(page.locator('.transcript-turn')).toHaveCount(2);
  await page.reload();
  await page.locator('.meeting-row').first().click();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  expect(errors).toEqual([]);
});

test('capture confirmation, pause, stop and ready record', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /New capture/ }).click();
  await page.getByLabel('Meeting title').fill('Design handoff');
  await expect(page.getByRole('button', { name: 'Start capture' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start capture' }).click();
  await expect(page.getByText('Recording started by you')).toBeVisible();
  await expect(page.getByText('No bot joined', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/03-capture.png' });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.getByRole('heading', { name: 'Preparing your notes…' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Open meeting' }).click();
  await expect(page.getByRole('heading', { name: 'Design handoff' })).toBeVisible();
  await expect(page.getByText('This is a prototype capture. No audio has been recorded or transcribed.')).toBeVisible();
  await page.reload();
  await expect(page.locator('.meeting-row')).toHaveCount(7);
});

test('privacy preferences persist and viewport fits desktop sizes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByRole('switch', { name: 'Allow cloud fallback' })).toBeDisabled();
  await page.getByRole('switch', { name: 'Confirm before recording' }).click();
  await page.getByRole('combobox', { name: 'Keep meeting data' }).selectOption('30');
  await page.screenshot({ path: 'docs/screenshots/04-privacy.png' });
  await page.reload();
  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByRole('switch', { name: 'Confirm before recording' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Keep meeting data' })).toHaveValue('30');
  for (const width of [600, 800, 1080, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'QuietNote.' }).click();
    await expect(page.locator('.meeting-row').first()).toBeVisible();
    expect(await page.locator('.qn-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

test('failed saves retain a recoverable draft and retry writes it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.meeting-row').first().click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'quietnote.preview.archive.v1') throw new Error('Simulated unavailable archive');
      return original.call(this, key, value);
    };
  });
  await page.locator('.action-row input').first().check();
  await expect(page.getByRole('alert')).toContainText('Couldn’t save');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Recovered unsaved edits');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.meeting-row').first().click();
  await expect(page.locator('.action-row input').first()).toBeChecked();
});
