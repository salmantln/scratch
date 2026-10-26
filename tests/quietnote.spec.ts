import { test, expect, type Page } from '@playwright/test';
import { demoMeetings } from '../src/quietnote/seeds';
import { section, replaceSection, toggleAction, matchesMeeting, searchMeeting, makeMeeting, transcriptTurns, validProjectName, appendAction, actionItems, enhancedNotes, openingTab, linkAction, issueFor, previousMeeting, notesMarkdown, summaryBlocks, templateFor, people, owns, projectFor, type Meeting } from '../src/quietnote/model';

async function examples(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore example meetings' }).click();
  await expect(page.locator('.meeting-row')).toHaveCount(6);
}
async function firstProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started' }).click();
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
// The Notes tab shows the enhanced notes or your own.
const view = (page: Page, name: 'Enhanced notes' | 'My notes') => page.getByRole('group', { name: 'Notes view' }).getByRole('button', { name });
async function myNotes(page: Page) { await tab(page, 'Notes').click(); await view(page, 'My notes').click(); }
const home = (page: Page) => page.getByRole('button', { name: 'Home', exact: true });
// Home also names meetings beside their action items, so rows are found by their own class.
const row = (page: Page, title: string) => page.locator('.meeting-row', { hasText: title });

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
  expect(searchMeeting(meeting, 'analytics credentials')?.tab).toBe('Enhanced');
  expect(searchMeeting(meeting, 'Amsterdam pilot')?.tab).toBe('Notes');
  expect(openingTab(meeting)).toBe('Enhanced');
  expect(searchMeeting(meeting, 'nothing like this')).toBeNull();
  const blank = makeMeeting('Kickoff', 'Acme');
  expect(section(blank.markdown, 'Summary')).toBe('');
  expect(transcriptTurns(blank.transcript)).toHaveLength(0);
  expect(blank.metadata.status).toBe('idle');
  // A new meeting has no Decisions section, and opens on your own notes until there's something enhanced.
  expect(blank.markdown).not.toContain('## Decisions');
  expect(openingTab(blank)).toBe('Notes');
  expect(openingTab({ ...blank, transcript: '# Transcript\n\n### 00:00 You\nHello.\n' })).toBe('Enhanced');
  // An earlier build's Decisions section stays visible (and searchable) in the enhanced notes.
  const older = replaceSection(blank.markdown, 'Decisions', '- Ship on Fridays');
  expect(enhancedNotes(older)).toBe('### Decisions\n- Ship on Fridays');
  expect(searchMeeting({ ...blank, markdown: older }, 'Fridays')?.tab).toBe('Enhanced');
  const added = appendAction(blank.markdown, 'Maya — send the plan');
  expect(openingTab({ ...blank, markdown: added })).toBe('Enhanced');
  expect(actionItems(added)).toEqual([{ index: 0, done: false, text: 'send the plan', owner: 'Maya' }]);
  expect(section(added, 'Notes')).toBe('');
  expect(validProjectName('Acme')).toBe('');
  expect(validProjectName('../Acme')).not.toBe('');
  expect(validProjectName('  ')).not.toBe('');
});

test('the meeting before carries over what it left open: the same series first, else the project', () => {
  const at = (title: string, project: string, date: string, open = true) => {
    const m = makeMeeting(title, project);
    m.metadata.date = date;
    if (open) m.markdown = appendAction(m.markdown, `Maya — follow up on ${title}`);
    return m;
  };
  const none = () => false;
  const weekly1 = at('Weekly sync', 'Acme', '2026-10-01T09:00:00.000Z');
  const review = at('Design review', 'Acme', '2026-10-06T09:00:00.000Z');
  const call = at('Zoom call', 'Acme', '2026-10-07T09:00:00.000Z');
  const other = at('Weekly sync', 'Beta', '2026-10-07T10:00:00.000Z');
  const weekly2 = at('Weekly sync', 'Acme', '2026-10-08T09:00:00.000Z');
  const all: Meeting[] = [weekly1, review, call, other, weekly2];
  // A series follows its own last meeting, not whatever happened in between or in another project.
  expect(previousMeeting(weekly2, all, none)?.metadata.id).toBe(weekly1.metadata.id);
  // Titles QuietNote made up ("Zoom call") aren't a series: the project's latest earlier meeting.
  const call2 = at('Zoom call', 'Acme', '2026-10-09T09:00:00.000Z');
  expect(previousMeeting(call2, [...all, call2], none)?.metadata.id).toBe(weekly2.metadata.id);
  expect(previousMeeting(weekly1, all, none)).toBeNull();
  // Nothing left open: nothing to show.
  const done = at('Retro', 'Gamma', '2026-10-01T09:00:00.000Z', false);
  expect(previousMeeting(at('Retro', 'Gamma', '2026-10-08T09:00:00.000Z'), [done], none)).toBeNull();
  done.markdown = toggleAction(appendAction(done.markdown, 'All done'), 0);
  expect(previousMeeting(at('Retro', 'Gamma', '2026-10-08T09:00:00.000Z'), [done], none)).toBeNull();
  // Decisions from an earlier build don't carry over; only open action items do.
  done.markdown = replaceSection(done.markdown, 'Decisions', '- Ship on Fridays');
  expect(previousMeeting(at('Retro', 'Gamma', '2026-10-08T09:00:00.000Z'), [done], none)).toBeNull();
});

test('enhanced notes are Markdown sections whose transcript lines keep their time, and a template fits the title', () => {
  const markdown = notesMarkdown([{ heading: 'Overview', lines: [{ text: 'Annual plan it is.', atMs: 65_000 }, { text: 'Pricing was the open question.', atMs: null }] }, { heading: 'Next steps', lines: [{ text: 'Maya sends the draft.', atMs: 3_725_000 }] }]);
  expect(markdown).toBe('### Overview\n- Annual plan it is. [01:05]\n- Pricing was the open question.\n\n### Next steps\n- Maya sends the draft. [1:02:05]');
  expect(summaryBlocks(`A paragraph\nthat wraps.\n\n${markdown}`)).toEqual([
    { kind: 'paragraph', text: 'A paragraph that wraps.' },
    { kind: 'heading', text: 'Overview' },
    { kind: 'list', items: [{ text: 'Annual plan it is.', at: '01:05' }, { text: 'Pricing was the open question.', at: null }] },
    { kind: 'heading', text: 'Next steps' },
    { kind: 'list', items: [{ text: 'Maya sends the draft.', at: '1:02:05' }] },
  ]);
  const names = ['General', '1:1', 'Standup', 'Sales call', 'User interview', 'Project kickoff'];
  expect(templateFor('Weekly 1:1 with Sam', names)).toBe('1:1');
  expect(templateFor('Daily stand-up', names)).toBe('Standup');
  expect(templateFor('Acme demo', names)).toBe('Sales call');
  expect(templateFor('Zoom call', names)).toBe('General');
  expect(templateFor('Kickoff', ['Retro'])).toBe('Retro');
  // The kind chosen when setting up leads unless the title says otherwise.
  expect(templateFor('Zoom call', names, 'User interview')).toBe('User interview');
  expect(templateFor('Daily stand-up', names, 'User interview')).toBe('Standup');
  expect(templateFor('Zoom call', names, 'Removed')).toBe('General');
});

test('people come from invites, grouped by their company but not by personal or the user’s own addresses', () => {
  const invite = (title: string, date: string, project: string, attendees: { name: string; email: string; me?: boolean }[], series?: string) => {
    const m = makeMeeting(title, project);
    Object.assign(m.metadata, { date, attendees, participants: attendees.filter(a => !a.me).map(a => a.name), ...(series && { calendarSeries: series }) });
    return m;
  };
  const me = { name: 'Me', email: 'me@acme.com', me: true };
  const a = invite('Pricing', '2026-10-01T09:00:00.000Z', 'Sales', [me, { name: 'Maria Lopez', email: 'maria@globex.com' }, { name: 'Sam', email: 'sam@globex.com' }], 's1');
  const b = invite('Pricing', '2026-10-08T09:00:00.000Z', 'Sales', [me, { name: 'Maria Lopez', email: 'maria@globex.com' }, { name: 'Tom', email: 'tom@acme.com' }, { name: 'Ana', email: 'ana@gmail.com' }]);
  const typed = makeMeeting('Coffee', 'Personal');
  typed.metadata.participants = ['Lea'];
  const found = people([a, b, typed]);
  // Most recently met first (the typed meeting is today's); colleagues at the user's domain and personal addresses have no company.
  expect(found.map(p => p.name)).toEqual(['Lea', 'Maria Lopez', 'Tom', 'Ana', 'Sam']);
  expect(Object.fromEntries(found.map(p => [p.name, [p.company, p.meetingIds.length]]))).toEqual({ Lea: ['', 1], 'Maria Lopez': ['globex.com', 2], Tom: ['', 1], Ana: ['', 1], Sam: ['globex.com', 1] });
  const maria = found.find(p => p.name === 'Maria Lopez')!;
  expect([owns(maria, 'Maria'), owns(maria, 'maria lopez'), owns(maria, 'Mario'), owns(maria, '')]).toEqual([true, true, false, false]);
  // A meeting from an event goes where the series went, else where those people's meetings are.
  const event = { id: 'e@1', series: 's1', title: 'Pricing', startMs: 0, endMs: 1, attendees: [me, { name: 'Maria Lopez', email: 'maria@globex.com' }], link: null };
  expect(projectFor(event, [a, b, typed], 'Inbox')).toBe('Sales');
  expect(projectFor({ ...event, series: 'other' }, [a, b, typed], 'Inbox')).toBe('Sales');
  expect(projectFor({ ...event, series: null, attendees: [me, { name: 'Zed', email: 'zed@initech.com' }] }, [a, b, typed], 'Inbox')).toBe('Inbox');
});

test('sent action items keep their issue link in Markdown, and only the item leaves the device', () => {
  const blank = makeMeeting('Kickoff', 'Acme');
  const markdown = appendAction(appendAction(blank.markdown, 'Maya — send the plan'), 'Book the room');
  const url = 'https://linear.app/acme/issue/ENG-12';
  const linked = linkAction(markdown, 0, 'ENG-12', url);
  expect(section(linked, 'Action items')).toContain(`- [ ] Maya — send the plan [ENG-12](${url})`);
  expect(actionItems(linked)[0]).toEqual({ index: 0, done: false, text: 'send the plan', owner: 'Maya', link: { label: 'ENG-12', url } });
  expect(actionItems(linked)[1].link).toBeUndefined();
  expect(linkAction(linked, 0, 'ENG-13', 'https://linear.app/acme/issue/ENG-13')).toBe(linked);
  expect(actionItems(toggleAction(linked, 0))[0]).toMatchObject({ done: true, link: { label: 'ENG-12' } });
  const issue = issueFor(actionItems(linked)[0], { ...blank.metadata, title: 'Kickoff', date: '2026-09-28T09:00:00' });
  expect(issue).toEqual({ title: 'send the plan', body: 'From “Kickoff” (2026-09-28, Acme). Owner: Maya.' });
});

test('A: first launch creates a project, then a meeting', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Meeting notes, without a bot.' })).toBeVisible();
  // The preview can't record, so the first screen doesn't promise it, and there's no permission to ask for.
  await expect(page.locator('.onboarding')).not.toContainText('Recorded');
  await expect(page.locator('.onboarding .hush')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/00-welcome.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByRole('heading', { name: 'What meetings do you have most?' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Meeting notes, without a bot.' })).toBeFocused();
  await page.getByRole('button', { name: 'Get started' }).click();
  // The one question can be left unanswered; then the project is just “Work”.
  await expect(page.getByLabel('Project name')).toHaveValue('Work');
  await page.getByLabel('Project name').fill('../Acme');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('alert')).toContainText('Use letters, numbers');
  await page.getByLabel('Project name').fill('Acme');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(page.getByText('No meetings in Acme yet.')).toBeVisible();
  await expect(page.getByText('Create a meeting to take notes.')).toBeVisible();
  await page.locator('.empty-state').getByRole('button', { name: 'New meeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await dialog.getByRole('heading', { name: 'New meeting' }).click();
  await expect(dialog.getByLabel('Meeting title')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.locator('.empty-state').getByRole('button', { name: 'New meeting' }).click();
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('Acme');
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  // Two tabs; a new meeting opens on your own notes.
  await expect(page.getByRole('tab')).toHaveText(['Notes', 'Transcript']);
  await expect(view(page, 'My notes')).toHaveAttribute('aria-pressed', 'true');
  await tab(page, 'Transcript').click();
  await expect(page.getByText('Transcript unavailable.')).toBeVisible();
  // Back on Notes, it's the notes you were on.
  await tab(page, 'Notes').click();
  await expect(view(page, 'My notes')).toHaveAttribute('aria-pressed', 'true');
  await view(page, 'Enhanced notes').click();
  await expect(page.getByText('No enhanced notes yet.')).toBeVisible();
  await expect(page.locator('.empty-inline .hush')).toHaveClass(/hush-resting/);
  await page.getByRole('textbox', { name: 'Add an action item' }).fill('Maya — send the plan');
  await page.keyboard.press('Enter');
  await expect(page.locator('.action-text')).toHaveText('send the plan');
  await expect(page.locator('.action-owner')).toHaveText('Maya');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  await expect(view(page, 'Enhanced notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.action-text')).toHaveText('send the plan');
});

test('B: prototype capture is labelled honestly and invents nothing', async ({ page }) => {
  await firstProject(page, 'Acme');
  await newMeeting(page, 'Design handoff');
  // Pressing Start capture starts it: there's no second confirmation.
  await page.getByRole('button', { name: 'Start capture' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder).toContainText('Prototype: recording needs the desktop app. No audio is recorded.');
  await expect(recorder.getByRole('status')).toContainText('Capturing');
  // The recorder is a strip in the meeting, not a dialog: Notes opens and stays usable while it runs.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.tiptap').click();
  await page.keyboard.type('Ship on Friday.');
  await page.screenshot({ path: 'docs/screenshots/03-capture.png' });
  await recorder.getByRole('button', { name: 'Stop capture' }).click();
  await expect(recorder).toHaveCount(0);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tiptap')).toContainText('Ship on Friday.');
  await view(page, 'Enhanced notes').click();
  await expect(page.getByText('No enhanced notes yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start capture' })).toHaveCount(0);
  await tab(page, 'Transcript').click();
  await expect(page.getByText('Transcript unavailable.')).toBeVisible();
  await home(page).click();
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await expect(page.locator('.meeting-row .status')).toHaveCount(0);
});

test('C: review an example meeting, toggle actions, edit notes, read the transcript', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await examples(page);
  await expect(page.locator('.meeting-row .badge.example')).toHaveCount(6);
  await page.screenshot({ path: 'docs/screenshots/01-library.png' });
  await row(page, 'Acme onboarding call').click();
  await expect(page.getByText('Acme is ready to move into implementation.', { exact: false })).toBeVisible();
  // A meeting with enhanced notes opens on them, led by its action items, and nothing about decisions.
  await expect(view(page, 'Enhanced notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.note-actions .action-row')).toHaveCount(4);
  expect(await page.locator('.note-actions').evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('.summary-text')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.locator('.meeting-content')).not.toContainText('Decisions');
  await expect(page.locator('.summary-text h3').first()).toHaveText('Summary');
  await page.screenshot({ path: 'docs/screenshots/02-summary.png' });
  const sidebarItems = page.getByRole('button', { name: 'Action items' });
  const before = Number(await sidebarItems.locator('.sidebar-count').textContent());
  await page.locator('.action-row input').first().check();
  await expect(sidebarItems.locator('.sidebar-count')).toHaveText(String(before - 1));
  await page.reload();
  await expect(page.locator('.action-row input').first()).toBeChecked();
  await expect(page.locator('.action-row.complete')).toHaveCount(1);
  await view(page, 'My notes').click();
  const editor = page.locator('.tiptap');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Confirm sandbox access before Monday’s review.');
  await expect(page.getByRole('status').filter({ hasText: 'Saved in this browser' })).toBeVisible();
  await home(page).click();
  await row(page, 'Weekly product sync').click();
  await myNotes(page);
  await expect(editor).not.toContainText('Confirm sandbox access');
  await home(page).click();
  await row(page, 'Acme onboarding call').click();
  await myNotes(page);
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  await page.screenshot({ path: 'docs/screenshots/05-notes.png' });
  await tab(page, 'Transcript').click();
  await expect(page.locator('.transcript-turn')).toHaveCount(6);
  await expect(page.getByText('Example transcript · illustrative, not a recording')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/06-transcript.png' });
  await page.getByRole('textbox', { name: 'Find in transcript' }).fill('credentials');
  await expect(page.locator('.transcript-turn')).toHaveCount(2);
  await page.reload();
  await myNotes(page);
  await expect(editor).toContainText('Confirm sandbox access before Monday’s review.');
  expect(errors).toEqual([]);
});

test('D: search finds what was agreed weeks later and opens the right place', async ({ page }) => {
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
  await expect(page.locator('.result-meta')).toContainText('in the transcript');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.transcript-turn').filter({ hasText: 'sample dataset' })).toBeVisible();
  // The transcript opens filtered to the search, so the passage is on screen; clearing it shows everything.
  const find = page.getByRole('textbox', { name: 'Find in transcript' });
  await expect(find).toHaveValue('sample dataset');
  await expect(page.locator('.transcript-turn')).toHaveCount(await page.locator('.transcript-turn').filter({ hasText: /sample dataset/i }).count());
  const matching = await page.locator('.transcript-turn').count();
  await find.fill('');
  expect(await page.locator('.transcript-turn').count()).toBeGreaterThan(matching);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await input.fill('zzqx');
  await expect(page.getByText('No meetings found for ‘zzqx’.')).toBeVisible();
});

test('E: privacy separates active from planned, and starting takes one press', async ({ page }) => {
  await firstProject(page, 'Internal');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Active now' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Planned/ })).toBeVisible();
  await expect(page.getByText('Stored in this browser')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Allow cloud processing' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Confirm before capture' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Keep meeting data' }).selectOption('30');
  await page.screenshot({ path: 'docs/screenshots/04-privacy.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Keep meeting data' })).toHaveValue('30');
  await page.getByRole('button', { name: 'Local archive' }).click();
  await expect(page.getByText('This browser preview keeps meetings in this browser only.', { exact: false })).toBeVisible();
  await newMeeting(page, 'Standup');
  await page.getByRole('button', { name: 'Start capture' }).click();
  await expect(page.getByRole('region', { name: 'Recorder' })).toContainText('Capturing');
  await page.getByRole('button', { name: 'Stop capture' }).click();
  await expect(page.getByRole('region', { name: 'Recorder' })).toHaveCount(0);
  for (const width of [600, 800, 1080, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await home(page).click();
    await expect(page.locator('.meeting-row').first()).toBeVisible();
    expect(await page.locator('.qn-main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

test('F: a failed save keeps a draft that can be retried or discarded', async ({ page }) => {
  await examples(page);
  await row(page, 'Acme onboarding call').click();
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
  await home(page).click();
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

test('I: connections are a directory; only Linear and GitHub connect, and only in the desktop app', async ({ page }) => {
  await examples(page);
  await page.getByRole('button', { name: 'Connections' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connections' });
  const search = dialog.getByRole('searchbox', { name: 'Search connections' });
  await expect(search).toBeFocused();
  const zoom = dialog.locator('.connector', { hasText: 'Zoom' });
  await expect(zoom.getByText('Planned')).toBeVisible();
  await expect(zoom.getByRole('button')).toHaveCount(0);
  const logos = dialog.locator('.brand-mark.logo img');
  await expect(logos).toHaveCount(15);
  await expect.poll(() => logos.evaluateAll(images => images.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(dialog.locator('.connector', { hasText: 'Apple Calendar' }).locator('.brand-mark')).toHaveText('31');
  await search.fill('linear');
  await expect(dialog.locator('.connector')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Desktop only' })).toBeDisabled();
  await search.fill('fax machine');
  await expect(dialog.getByText('No connections match “fax machine”.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const key = 'quietnote.preview.archive.v1';
    const meetings = JSON.parse(localStorage.getItem(key)!);
    const acme = meetings.find((m: { metadata: { title: string } }) => m.metadata.title === 'Acme onboarding call');
    acme.markdown = acme.markdown.replace(/^(- \[ \] .*)$/m, '$1 [ENG-7](https://linear.app/acme/issue/ENG-7)');
    localStorage.setItem(key, JSON.stringify(meetings));
  });
  await page.reload();
  await row(page, 'Acme onboarding call').click();
  await expect(page.getByRole('button', { name: 'ENG-7' })).toBeVisible();
  await expect(page.locator('.action-text').first()).not.toContainText('linear.app');
  await expect(page.getByRole('button', { name: /^Send to/ })).toHaveCount(0);
});

// A stand-in for the desktop app's Rust side, so the real recorder UI can be driven in the browser.
// Only the commands and events the recording flow uses are modelled; everything else resolves to null.
type Fixture = { meetings: ReturnType<typeof makeMeeting>[]; microphone?: string; model?: string; recording?: string; startedAgo?: number; startFailure?: { code: string; message: string } };
async function mockDesktop(page: Page, fixture: Fixture) {
  await page.addInitScript(({ meetings, microphone = 'granted', model = 'ready', recording, startedAgo = 0, startFailure }) => {
    type Meta = (typeof meetings)[number]['metadata'];
    const w = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners: Record<string, number[]> = {};
    let next = 1;
    const find = (id: string) => meetings.find(m => m.metadata.id === id)!;
    const live = (id: string, startedAt: string) => ({ meetingId: id, title: find(id).metadata.title, startedAt, recordedMs: 0, resumedAt: startedAt as string | null, mic: 'heard', system: 'waiting', micDevice: 'MacBook Pro Microphone', systemDevice: 'this Mac’s sound output', problem: null, note: null, liveText: 'on' });
    const state = {
      calls: [] as string[],
      preferences: {} as Record<string, unknown>,
      capture: { available: true, detectsCalls: true, liveTranscript: true, microphone, model, recording: recording ? live(recording, new Date(Date.now() - startedAgo * 1000).toISOString()) : null as unknown, transcribing: null as unknown, queued: [] as string[] },
      transcriptData: null as unknown,
      devices: { devices: ['MacBook Pro Microphone', 'AirPods Pro'], selected: null as string | null },
      draft: null as unknown,
      compact: false,
      summaryKey: false,
      suggestions: null as unknown,
      saved: '',
      clipboard: '',
      templates: [{ name: 'General', sections: [{ heading: 'Overview', description: '' }, { heading: 'Next steps', description: '' }], builtIn: true }, { name: '1:1', sections: [{ heading: 'Updates', description: '' }], builtIn: true }],
      enhanced: null as unknown,
      enhancedWith: '',
      calendarAccess: 'undetermined',
      // What the macOS microphone prompt answers when the first-run screens ask.
      micAnswer: 'granted',
      // Browser sign-in: the services this build signs in to, the last sign-in still waiting, and links opened.
      signInServices: [] as string[],
      pendingSignIn: null as null | { service: string; resolve: (account: unknown) => void; reject: (error: string) => void },
      opened: [] as string[],
      names: null as unknown,
      renamed: [] as string[][],
      events: [] as unknown[],
      now: null as unknown,
      // Whether macOS lets QuietNote use Accessibility; the prompt (`ask`) doesn't change it by itself.
      accessibility: false,
      // The AI apps on this computer, as `mcp_agents` lists them; `mcp_agent_set` turns one on or off.
      agents: [] as { id: string; name: string; state: string; path: string; problem: string | null }[],
      // The license `license_status` reads; `license_activate` answers `licenseAnswer`, a license or an error to throw.
      license: { available: true, license: null as unknown },
      licenseAnswer: null as unknown,
      // Start recording from any app, as Rust registered it (`hotkey_set`; '' is off), and keys another app holds.
      hotkey: 'Control+Alt+R',
      hotkeyTaken: [] as string[],
      // What `disk_encryption` reports about FileVault.
      disk: 'on',
      // The folder the Export audio picker answers (null: cancelled), and what `audio_export` was asked to write.
      folder: '/Users/me/Desktop' as string | null,
      exported: [] as { meetingId: string; folder: string }[],
    };
    const emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach(id => callbacks.get(id)?.({ event, id: 0, payload }));
    const update = (id: string, change: Partial<Meta>) => { const m = find(id); m.metadata = { ...m.metadata, ...change }; return m.metadata; };
    w.isTauri = true;
    w.__qn = { state, emit, meetings };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback(callback: (event: unknown) => void) { const id = next++; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, never>) {
        state.calls.push(cmd);
        switch (cmd) {
          case 'plugin:event|listen': (listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'plugin:event|unlisten': listeners[args.event] = (listeners[args.event] ?? []).filter(id => id !== args.eventId); return null;
          case 'load_meeting_archive': return { root: '/archive', projects: [...new Set(meetings.map(m => m.metadata.project))], meetings };
          case 'get_notes_folder': return '/archive';
          case 'quietnote_preferences': if (args.value) state.preferences = args.value; return state.preferences;
          case 'connector_status': return {};
          case 'connector_sign_in_services': return state.signInServices;
          case 'connector_app_icons': return {};
          case 'connector_sign_in': return new Promise((resolve, reject) => { state.pendingSignIn = { service: args.service, resolve, reject }; });
          case 'connector_sign_in_cancel': state.pendingSignIn?.reject(`${args.service === 'linear' ? 'Linear' : 'GitHub'} sign-in was cancelled.`); state.pendingSignIn = null; return null;
          case 'open_url_safe': state.opened.push(args.url); return null;
          case 'capture_status': return state.capture;
          case 'capture_allow_microphone': if (state.capture.microphone === 'undetermined') state.capture = { ...state.capture, microphone: state.micAnswer }; emit('quietnote://capture-state', state.capture); return state.capture;
          case 'create_meeting_bundle': meetings.push(args.meeting); return null;
          case 'save_meeting_metadata': { const m = find((args.metadata as Meta).id); m.metadata = args.metadata; return null; }
          case 'trash_meeting': meetings.splice(meetings.indexOf(find(args.id)), 1); return null;
          case 'capture_start': {
            if (startFailure) throw startFailure;
            const m = find(args.meetingId);
            const startedAt = new Date().toISOString();
            // Recording more of a finished meeting: the clock carries on from it.
            state.capture = { ...state.capture, microphone: 'granted', recording: { ...live(m.metadata.id, startedAt), recordedMs: m.metadata.status === 'ready' ? m.metadata.duration * 1000 : 0 } };
            emit('quietnote://capture-state', state.capture);
            return update(m.metadata.id, { status: 'recording', captureStartedAt: startedAt, audioPath: `${m.metadata.project}/${m.metadata.id}/audio` });
          }
          case 'capture_stop': {
            const id = String((state.capture.recording as { meetingId: string }).meetingId);
            state.capture = { ...state.capture, recording: null, transcribing: { meetingId: id, title: find(id).metadata.title, percent: 40 } };
            emit('quietnote://capture-state', state.capture);
            return update(id, { status: 'processing', duration: 95, captureEndedAt: new Date().toISOString() });
          }
          case 'capture_pause': case 'capture_resume': {
            const r = state.capture.recording as ReturnType<typeof live>;
            const recording = cmd === 'capture_pause' ? { ...r, recordedMs: r.recordedMs + Date.now() - Date.parse(r.resumedAt!), resumedAt: null } : { ...r, resumedAt: new Date().toISOString() };
            state.capture = { ...state.capture, recording };
            emit('quietnote://capture-state', state.capture);
            return null;
          }
          case 'capture_devices': return state.devices;
          case 'capture_live_transcript': return state.draft;
          case 'window_compact': state.compact = args.compact; return null;
          case 'capture_set_device': state.devices = { ...state.devices, selected: args.name }; return null;
          case 'transcribe_meeting': return update(args.meetingId, { status: 'processing', error: null });
          case 'transcript_data': return state.transcriptData;
          case 'save_file_direct': state.saved = args.content; return { path: args.path, content: args.content, title: '', modified: 0 };
          case 'license_status': return state.license;
          case 'license_activate': if (typeof state.licenseAnswer === 'string') throw state.licenseAnswer; state.license = { available: true, license: state.licenseAnswer }; return state.licenseAnswer;
          case 'license_remove': state.license = { available: true, license: null }; return null;
          case 'summary_key_status': return state.summaryKey;
          case 'summary_set_key': state.summaryKey = true; return null;
          case 'summary_suggest': return state.suggestions;
          case 'plugin:clipboard-manager|write_text': state.clipboard = args.text; return null;
          case 'call_accessibility': return state.accessibility;
          case 'disk_encryption': return state.disk;
          case 'plugin:dialog|open': return state.folder;
          case 'audio_export': state.exported.push({ meetingId: args.meetingId, folder: args.folder }); return [`${args.folder}/${args.meetingId} mic.wav`];
          case 'hotkey_set': if (state.hotkeyTaken.includes(args.accelerator)) throw 'Another app already uses this shortcut. Choose another.'; state.hotkey = args.accelerator; return null;
          case 'mcp_agents': return state.agents;
          case 'mcp_agent_set': { const a = state.agents.find(x => x.id === args.id)!; a.state = args.on ? 'on' : 'off'; return { ...a }; }
          case 'note_templates': return state.templates;
          case 'meeting_names': return state.names;
          case 'transcript_rename_speaker': {
            state.renamed.push([args.from, args.to]);
            const m = find(args.meetingId);
            m.transcript = m.transcript.split(`### `).map((chunk: string) => chunk.replace(new RegExp(`^(\\d+:\\d+) ${args.from}\\n`), `$1 ${args.to}\n`)).join('### ');
            state.transcriptData = (state.transcriptData as { speaker: string }[]).map(t => t.speaker === args.from ? { ...t, speaker: args.to } : t);
            return m.transcript;
          }
          case 'calendar_access': if (args.ask && state.calendarAccess === 'undetermined') state.calendarAccess = 'granted'; return state.calendarAccess;
          case 'calendar_events': return state.preferences.calendar ? state.events : [];
          case 'calendar_now': return state.preferences.calendar ? state.now : null;
          case 'notes_enhance': state.enhancedWith = args.template; return state.enhanced;
          case 'capture_keep': { const r = state.capture.recording as Record<string, unknown>; state.capture = { ...state.capture, recording: { ...r, ending: null } }; emit('quietnote://capture-state', state.capture); return null; }
          default: return null;
        }
      },
    };
  }, fixture);
}
type Mock = { state: { calls: string[]; preferences: Record<string, unknown>; capture: Record<string, unknown>; transcriptData: unknown; devices: { devices: string[]; selected: string | null }; draft: unknown; compact: boolean; summaryKey: boolean; suggestions: unknown; saved: string }; emit: (event: string, payload: unknown) => void; meetings: ReturnType<typeof makeMeeting>[] };
/** Runs `fn` in the page with the mock. It's serialized, so it can't use variables from the test. */
const qn = <T,>(page: Page, fn: (qn: Mock) => T) => page.evaluate(`(${fn.toString()})(window.__qn)`) as Promise<T>;
const writes = ['save_meeting_metadata', 'render_transcripts', 'create_meeting_bundle', 'capture_start', 'capture_stop', 'transcribe_meeting'];
function meetingWith(title: string, change: Partial<ReturnType<typeof makeMeeting>['metadata']>) {
  const meeting = makeMeeting(title, 'Acme');
  meeting.metadata = { ...meeting.metadata, ...change };
  return meeting;
}

test('J: desktop recording runs in the background, then shows a clean transcript with the raw words kept', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Design review', 'Acme')] });
  await page.goto('/');
  await page.getByRole('button', { name: /Design review/ }).click();
  await tab(page, 'Transcript').click();
  await expect(page.getByText('No transcript yet.')).toBeVisible();
  // On a meeting that hasn't been recorded, Start recording is the one primary action, and one press starts it.
  await expect(page.locator('.meeting-header').getByRole('button', { name: 'Start recording' })).toHaveClass(/primary/);
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await page.getByRole('button', { name: 'Start recording' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder.getByRole('status')).toContainText('Recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await expect(recorder).not.toContainText('Prototype');
  // The levels show at once that it's recording, from whichever side is louder; the word is for screen readers.
  const levels = recorder.getByRole('button', { name: 'Recording details' }).locator('i.on');
  await expect(levels).toHaveCount(0);
  await qn(page, q => q.emit('quietnote://levels', [0.3, 0]));
  await expect(levels).toHaveCount(5);
  await qn(page, q => q.emit('quietnote://levels', [0.01, 0.05]));
  await expect(levels).toHaveCount(3);
  await expect(recorder.locator('.recorder-time')).toHaveText(/^00:0\d$/);
  // Recording opens Notes and nothing covers it. Here the strip is the recorder, so the window bar steps aside.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tiptap')).toBeVisible();
  const bar = page.locator('.recording-bar');
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(1);
  await qn(page, q => q.emit('quietnote://capture-state', { ...q.state.capture, recording: { ...(q.state.capture.recording as object), system: 'silent', note: 'Microphone changed to AirPods Pro.' } }));
  await expect(recorder.getByRole('alert')).toContainText('No call audio yet');
  await expect(recorder).toContainText('Microphone changed to AirPods Pro.');
  await recorder.getByRole('button', { name: /^Open (System )?Settings$/ }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
  // In every other view, the window says it's recording, with the same elapsed time.
  await home(page).click();
  await expect(bar).toContainText('Recording');
  await expect(bar).toContainText('Design review');
  await expect(bar.locator('.recording-time')).toHaveText(/^00:0\d$/);
  await bar.getByRole('button', { name: 'Stop recording' }).click();
  await expect(bar).toHaveCount(0);
  // Stopping away from the meeting still says the recording was saved and where it went.
  const saved = page.getByRole('status').filter({ hasText: 'Recording saved' });
  await expect(saved).toContainText('Transcribing “Design review”');
  await saved.getByRole('button', { name: 'Open meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Design review' })).toBeVisible();
  await expect(saved).toHaveCount(0);
  await expect(page.getByText(/Transcribing on this (Mac|PC)… 40%/)).toBeVisible();
  await expect(page.getByText('The audio is kept until the transcript is saved.', { exact: false })).toBeVisible();
  await qn(page, q => {
    const [m] = q.meetings;
    q.state.transcriptData = [
      { startMs: 0, speaker: 'You', text: 'Um, so, uh, we should we should ship on Friday.', clean: 'So, we should ship on Friday.' },
      { startMs: 5000, speaker: 'Others', text: 'Sounds good.', clean: 'Sounds good.' },
    ];
    q.emit('quietnote://capture-state', { ...q.state.capture, transcribing: null });
    q.emit('quietnote://meeting-changed', { metadata: { ...m.metadata, status: 'ready' }, transcript: '# Transcript\n\n### 00:00 You\nSo, we should ship on Friday.\n\n### 00:05 Others\nSounds good.\n', problem: null });
  });
  await tab(page, 'Transcript').click();
  await expect(page.locator('.transcript-turn').first()).toContainText('So, we should ship on Friday.');
  await expect(page.getByRole('button', { name: 'Clean' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription.')).toBeVisible();
  const before = await qn(page, q => q.state.calls.length);
  await page.getByRole('button', { name: 'Verbatim' }).click();
  await expect(page.locator('.transcript-turn').first()).toContainText('Um, so, uh, we should we should ship on Friday.');
  await page.getByRole('button', { name: 'Clean' }).click();
  await expect(page.locator('.transcript-turn').first()).toContainText('So, we should ship on Friday.');
  // Switching views only changes what's shown: nothing is written.
  expect((await qn(page, q => q.state.calls)).slice(before).filter(c => writes.includes(c))).toEqual([]);
  await expect(page.getByRole('button', { name: 'Export audio…' })).toBeVisible();
  // Copy transcript copies every turn in the view shown, even while Find narrows the list.
  await page.getByLabel('Find in transcript').fill('Friday');
  await page.getByRole('button', { name: 'Copy transcript' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await qn(page, q => q.state.clipboard)).toBe('Design review\n\n[00:00] You: So, we should ship on Friday.\n[00:05] Others: Sounds good.\n');
});

test('K: New meeting records with one press, or creates without recording; recording starts only from its button', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Earlier call', 'Acme')] });
  await page.goto('/');
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await page.locator('.new-meeting').click();
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await expect(dialog.getByRole('button', { name: 'Start recording' })).toHaveClass(/primary/);
  await dialog.getByLabel('Meeting title').fill('Planning');
  await dialog.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await qn(page, q => q.emit('quietnote://new-meeting', null));
  await dialog.getByLabel('Meeting title').fill('Customer call');
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await dialog.getByLabel('Meeting title').press('Enter');
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder.getByRole('status')).toContainText('Recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await recorder.getByRole('button', { name: 'Stop recording' }).click();
  // Stopping needs no confirmation step: the strip goes and the meeting says it's transcribing.
  await expect(recorder).toHaveCount(0);
  await expect(page.getByText(/Transcribing on this (Mac|PC)… 40%/)).toBeVisible();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Active now' })).toBeVisible();
  // Where recording is real, every privacy setting shown is enforced: nothing planned or inert.
  await expect(page.getByRole('heading', { name: /Planned/ })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Keep audio on this device' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Allow cloud processing' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Keep meeting data' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Confirm before capture' })).toHaveCount(0);
  await expect(page.getByText('for meetings transcribed after you turn this on. Audio you already have is kept. If transcription fails, the audio is kept so you can retry.', { exact: false })).toBeVisible();
  await page.getByRole('switch', { name: 'Remove filler words' }).click();
  await expect(page.getByRole('switch', { name: 'Remove filler words' })).not.toBeChecked();
  await expect.poll(() => qn(page, q => q.state.calls.includes('render_transcripts'))).toBe(true);
  await expect(page.getByRole('switch', { name: 'Delete audio after transcribing' })).not.toBeChecked();
});

test('L: the first recording explains permissions before macOS asks, and a denied microphone is clear', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Earlier call', 'Acme')], microphone: 'undetermined', model: 'missing', startFailure: { code: 'mic-denied', message: 'QuietNote can’t use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.' } });
  await page.goto('/');
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await qn(page, q => q.emit('quietnote://new-meeting', { record: true }));
  await page.getByRole('dialog', { name: 'New meeting' }).getByLabel('Meeting title').fill('First call');
  await page.getByRole('dialog', { name: 'New meeting' }).getByRole('button', { name: 'Start recording' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  // Nothing starts, and no prompt appears, until the explanation has been seen and Start pressed.
  if (await page.evaluate(() => /Mac/.test(navigator.userAgent))) {
    await expect(recorder).toContainText('Before your first recording');
    await expect(recorder).toContainText('Microphone, to record your side of the meeting.');
    await expect(recorder).toContainText('System audio recording, to record what the others say');
    await expect(recorder).toContainText('QuietNote doesn’t join the call or add a bot. Nothing records until you press Start, and the audio is transcribed on this Mac.');
  }
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await expect(recorder.getByRole('alert')).toContainText('Transcription is unavailable');
  await recorder.getByRole('button', { name: 'Start recording' }).click();
  await expect(recorder.getByRole('alert').filter({ hasText: 'Microphone access is off' })).toContainText('Allow it in System Settings');
  await expect(recorder.getByRole('button', { name: 'Try again' })).toBeVisible();
  await recorder.getByRole('button', { name: /^Open (System )?Settings$/ }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
  await recorder.getByRole('button', { name: 'Cancel' }).click();
  await expect(recorder).toHaveCount(0);
  // No ambiguous state: the meeting is still idle and nothing says it's recording.
  await expect(page.locator('.recording-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  await home(page).click();
  await expect(page.locator('.meeting-row .status')).toHaveCount(0);
});

test('M: a recovered recording and a failed transcription say what happened and keep the audio', async ({ page }) => {
  const recovered = meetingWith('Acme onboarding', { status: 'ready', interrupted: true, audioPath: 'Acme/x/audio', duration: 1500, captureStartedAt: '2026-09-29T10:00:00.000Z', captureEndedAt: '2026-09-29T10:25:00.000Z' });
  const failed = meetingWith('Design review', { status: 'error', error: 'The speech model is missing from this installation of QuietNote.', duration: 120, captureEndedAt: '2026-09-29T11:00:00.000Z' });
  failed.metadata.audioPath = `Acme/${failed.metadata.id}/audio`;
  await mockDesktop(page, { meetings: [recovered, failed] });
  await page.goto('/');
  const banner = page.getByRole('status').filter({ hasText: 'Recovered recording' });
  await expect(banner).toContainText('We found an interrupted recording from “Acme onboarding”.');
  await banner.getByRole('button', { name: 'Open meeting' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme onboarding' })).toBeVisible();
  const notice = page.locator('.notice').filter({ hasText: 'Recovered recording' });
  await expect(notice).toContainText('QuietNote closed before this recording was stopped.');
  await expect(notice).toContainText('Its transcript is ready.');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  expect(await qn(page, q => q.meetings[0].metadata.interrupted)).toBe(false);
  await home(page).click();
  await page.getByRole('button', { name: /Design review/ }).click();
  const failure = page.locator('.notice.attention');
  await expect(failure).toContainText('Transcription couldn’t finish.');
  await expect(failure).toContainText('Your recording is still saved (2 min), so you can retry.');
  // The technical reason is available, but only behind Details.
  await expect(failure.locator('details')).toContainText('The speech model is missing from this installation of QuietNote.');
  await expect(failure.getByText('The speech model is missing from this installation of QuietNote.')).toBeHidden();
  await failure.getByText('Details').click();
  await expect(failure.getByText('The speech model is missing from this installation of QuietNote.')).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Export audio…' })).toBeVisible();
  await expect(page.locator('.meeting-meta .status')).toHaveText('Needs attention');
  await failure.getByRole('button', { name: 'Retry transcription' }).click();
  expect(await qn(page, q => q.state.calls.includes('transcribe_meeting'))).toBe(true);
  await expect(page.getByText('Waiting to transcribe…')).toBeVisible();
  await expect(page.locator('.meeting-meta .status')).toHaveText('Transcribing');
});

test('N: one recording at a time, and device problems show everywhere', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording, makeMeeting('Design review', 'Acme')], recording: recording.metadata.id, startedAgo: 65 });
  await page.goto('/');
  const bar = page.locator('.recording-bar');
  await expect(bar).toContainText('Acme onboarding');
  await expect(bar.locator('.recording-time')).toHaveText(/^01:0[5-8]$/);
  await page.getByRole('button', { name: /Design review/ }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeDisabled();
  await expect(page.getByText('“Acme onboarding” is recording. Stop it before recording this meeting.')).toBeVisible();
  await qn(page, q => q.emit('quietnote://capture-state', { ...q.state.capture, recording: { ...(q.state.capture.recording as object), problem: 'Microphone disconnected. Reconnecting…' } }));
  await expect(bar.locator('.recording-problem')).toHaveAttribute('title', 'Microphone disconnected. Reconnecting…');
  await expect(bar.getByRole('img', { name: 'Microphone disconnected. Reconnecting…' })).toBeVisible();
  await bar.getByRole('button', { name: 'Acme onboarding' }).click();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder.getByRole('alert')).toContainText('Microphone disconnected. Reconnecting…');
  await expect(recorder.locator('.recorder-time')).toHaveText(/^01:0[5-9]$/);
});

test('O: a first recording from the tray carries through project creation, and a tray stop says where it went', async ({ page }) => {
  await mockDesktop(page, { meetings: [] });
  await page.goto('/');
  await expect(page.locator('.onboarding')).toContainText('Recorded and transcribed on this Mac.');
  await qn(page, q => q.emit('quietnote://new-meeting', { record: true }));
  await page.getByLabel('Project name').fill('Acme');
  await page.getByRole('button', { name: 'Create project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue('Acme');
  await dialog.getByLabel('Meeting title').fill('Acme onboarding');
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await dialog.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
  await home(page).click();
  // Stop from the tray: Rust stops, then reports the new state and the meeting.
  await qn(page, q => {
    const [m] = q.meetings;
    q.state.capture = { ...q.state.capture, recording: null };
    q.emit('quietnote://capture-state', q.state.capture);
    q.emit('quietnote://meeting-changed', { metadata: { ...m.metadata, status: 'processing' }, transcript: null, problem: null });
  });
  await expect(page.locator('.recording-bar')).toHaveCount(0);
  const banner = page.getByRole('status').filter({ hasText: 'Recording saved' });
  await expect(banner).toContainText('Transcribing “Acme onboarding”');
  await qn(page, q => { const [m] = q.meetings; q.emit('quietnote://meeting-changed', { metadata: { ...m.metadata, status: 'ready' }, transcript: '# Transcript\n\n### 00:00 You\nWelcome aboard.\n', problem: null }); });
  const ready = page.getByRole('status').filter({ hasText: 'Transcript ready' });
  await expect(ready).toContainText('“Acme onboarding” is ready to review.');
  await ready.getByRole('button', { name: 'Open meeting' }).click();
  await expect(tab(page, 'Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.transcript-turn')).toContainText('Welcome aboard.');
  await expect(ready).toHaveCount(0);
});

test('P: the sidebar hides and shows from the header button or ⌘\\, and stays hidden while navigating', async ({ page }) => {
  await examples(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar).toBeHidden();
  await page.locator('.meeting-row').first().click();
  await expect(tab(page, 'Notes')).toBeVisible();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute('aria-expanded', 'true');
});

test('P2: double-clicking the sidebar’s divider switches between icons with labels and icons only, and it’s remembered', async ({ page }) => {
  await examples(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  const divider = page.getByRole('separator', { name: 'Resize sidebar width' });
  const width = () => sidebar.evaluate(el => el.getBoundingClientRect().width);
  // No logo or wordmark in the sidebar; the app's name is the window's.
  await expect(sidebar.getByRole('button', { name: 'QuietNote' })).toHaveCount(0);
  await expect.poll(width).toBe(232);
  await divider.dblclick();
  await expect.poll(width).toBe(56);
  await expect(sidebar.locator('.label').first()).toHaveCSS('position', 'absolute');
  // Still usable: every button keeps its name, and projects show their initial.
  await sidebar.getByRole('button', { name: 'All meetings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'All meetings' })).toBeVisible();
  await expect(sidebar.locator('.project-item .initial').first()).toBeVisible();
  await page.reload();
  await expect.poll(width).toBe(56);
  // Enter on the divider switches back, and the width chosen before is kept.
  await divider.focus();
  await page.keyboard.press('Enter');
  await expect.poll(width).toBe(232);
  await expect(sidebar.locator('.label').first()).not.toHaveCSS('position', 'absolute');
});

test('Q: Home lists open action items from every meeting, and a tick is written to the meeting', async ({ page }) => {
  await examples(page);
  const card = page.getByRole('region', { name: 'Recording' });
  await expect(card).toContainText('Recording needs the desktop app.');
  await expect(card.locator('.hush')).toHaveClass(/hush-resting/);
  await expect(card.getByRole('button', { name: 'New meeting' })).toHaveClass(/secondary/);
  const items = page.locator('.home-section', { has: page.getByRole('heading', { name: /^Open action items/ }) });
  const total = demoMeetings.reduce((n, m) => n + actionItems(m.markdown).length, 0);
  await expect(items.locator('.home-count')).toHaveText(String(total));
  await expect(items.locator('.action-row')).toHaveCount(6);
  // Newest meeting first, with each item's owner and where it came from.
  const first = items.locator('.action-row').first();
  await expect(first.locator('.action-text')).toHaveText('send the revised onboarding plan by 30 September');
  await expect(first.locator('.action-owner')).toHaveText('Maya');
  await first.locator('input').check();
  // A ticked item stays, struck through, until you leave Home.
  await expect(first).toHaveClass(/complete/);
  await expect(items.locator('.home-count')).toHaveText(String(total - 1));
  await expect(page.getByRole('status').filter({ hasText: 'Saved in this browser' })).toBeVisible();
  await first.getByRole('button', { name: 'Acme onboarding call' }).click();
  await expect(view(page, 'Enhanced notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.action-row', { hasText: 'send the revised onboarding plan' }).locator('input')).toBeChecked();
  await home(page).click();
  await expect(page.locator('.action-text', { hasText: 'send the revised onboarding plan' })).toHaveCount(0);
  await expect(row(page, 'Acme onboarding call').locator('.open-count')).toHaveText('3 open');
  // Search from Home keeps typing in the search page.
  await page.getByRole('searchbox', { name: 'Search meetings' }).click();
  await page.keyboard.type('phase two');
  await expect(page.getByRole('searchbox', { name: 'Search meetings' })).toHaveValue('phase two');
  await expect(page.locator('.result').first()).toContainText('Acme onboarding call');
});

test('Q1: a tick says so in a toast, and Undo puts the item back as it was', async ({ page }) => {
  await examples(page);
  const items = page.locator('.home-section', { has: page.getByRole('heading', { name: /^Open action items/ }) });
  const total = demoMeetings.reduce((n, m) => n + actionItems(m.markdown).length, 0);
  const first = items.locator('.action-row').first();
  await first.locator('input').check();
  const done = page.locator('[data-sonner-toast]', { hasText: 'Marked done' });
  await expect(done).toBeVisible();
  await expect(items.locator('.home-count')).toHaveText(String(total - 1));
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(done).toHaveCount(0);
  await expect(first.locator('input')).not.toBeChecked();
  await expect(items.locator('.home-count')).toHaveText(String(total));
  // In a meeting too, and both ways: ticking the same item again replaces its toast, and reopening can be undone.
  await first.getByRole('button', { name: 'Acme onboarding call' }).click();
  const item = page.locator('.action-row', { hasText: 'send the revised onboarding plan' }).locator('input');
  await expect(item).not.toBeChecked();
  await item.check();
  await item.uncheck();
  const reopened = page.locator('[data-sonner-toast]', { hasText: 'Reopened' });
  await expect(reopened).toBeVisible();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
  await reopened.getByRole('button', { name: 'Undo' }).click();
  await expect(item).toBeChecked();
});

test('Q2: the Action items page lists every meeting’s items under the meeting, open or done', async ({ page }) => {
  await examples(page);
  const total = demoMeetings.reduce((n, m) => n + actionItems(m.markdown).length, 0);
  // Home shows a few and leads to the rest.
  await page.getByRole('button', { name: 'All action items' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Action items' })).toBeVisible();
  await expect(page.locator('.actions-page')).toContainText(`${total} open`);
  await expect(page.locator('.action-group')).toHaveCount(demoMeetings.length);
  await expect(page.locator('.actions-page .action-row')).toHaveCount(total);
  await page.screenshot({ path: 'docs/screenshots/08-action-items.png' });
  const acme = page.getByRole('region', { name: 'Acme onboarding call' });
  await acme.locator('.action-row input').first().check();
  // A ticked item stays, struck through, until you leave or switch.
  await expect(acme.locator('.action-row.complete')).toHaveCount(1);
  await expect(page.locator('.actions-page')).toContainText(`${total - 1} open`);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.actions-page .action-row')).toHaveCount(1);
  await expect(page.locator('.actions-page .action-text')).toHaveText('send the revised onboarding plan by 30 September');
  // The meeting's title opens its enhanced notes, where the item is ticked.
  await page.getByRole('region', { name: 'Acme onboarding call' }).getByRole('button', { name: 'Acme onboarding call' }).click();
  await expect(view(page, 'Enhanced notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.note-actions .action-row input').first()).toBeChecked();
});

test('R: Home says whether recording is ready, and a recording never gets a second Stop', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording, makeMeeting('Design review', 'Acme')], recording: recording.metadata.id, startedAgo: 65 });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Recording' });
  await expect(card).toContainText('Recording “Acme onboarding”');
  await expect(card).toContainText(/Started \d\d:\d\d by you · No bot joined/);
  await expect(card).toContainText('Mic ✓ · Call audio: waiting for others');
  await expect(card.getByRole('button', { name: 'Start recording' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(1);
  await card.getByRole('button', { name: 'Open meeting' }).click();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
  await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(1);
  await home(page).click();
  // Stopped from the tray: the card offers Start again and follows the transcription.
  await qn(page, q => {
    q.state.capture = { ...q.state.capture, recording: null, transcribing: { meetingId: q.meetings[0].metadata.id, title: 'Acme onboarding', percent: 40 }, queued: ['other'] };
    q.emit('quietnote://capture-state', q.state.capture);
  });
  await expect(card).toContainText(/Transcribing on this (Mac|PC)/);
  await expect(card).toContainText('“Acme onboarding” · 40% · 1 more waiting');
  await expect(card.getByRole('progressbar', { name: 'Transcription progress' })).toHaveAttribute('aria-valuenow', '40');
  await expect(card.getByRole('button', { name: 'Start recording' })).toHaveClass(/primary/);
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await qn(page, q => q.emit('quietnote://capture-state', { ...q.state.capture, transcribing: null, queued: [], microphone: 'denied', model: 'missing' }));
  await expect(card).toContainText('Microphone access is off');
  await expect(card).toContainText('Transcription is unavailable: the speech model is missing. You can still record.');
  await card.getByRole('button', { name: /^Open (System )?Settings$/ }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
  // Start recording needs no dialog: one press makes an untitled meeting in the project and records it, on Notes.
  await qn(page, q => { q.state.capture = { ...q.state.capture, recording: null, transcribing: null, queued: [], microphone: 'granted', model: 'ready' }; q.emit('quietnote://capture-state', q.state.capture); });
  await card.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
  expect(await qn(page, q => q.meetings.filter(m => m.metadata.title === 'Untitled meeting').map(m => m.metadata.project))).toEqual(['Acme']);
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
});

test('R1: the tray and ⌘⇧R record at once, never over an open dialog, and the first recording still explains itself first', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Design review', 'Acme')], microphone: 'undetermined' });
  await page.goto('/');
  await expect(row(page, 'Design review')).toBeVisible();
  // With a dialog open, the tray's Start recording doesn't replace it.
  await page.keyboard.press('ControlOrMeta+n');
  await qn(page, q => q.emit('quietnote://record-now', null));
  await expect(page.getByRole('dialog', { name: 'New meeting' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.includes('create_meeting_bundle'))).toBe(false);
  await page.keyboard.press('Escape');
  // Before the first recording the explanation comes first, then macOS asks.
  await qn(page, q => q.emit('quietnote://record-now', null));
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder).toContainText('Before your first recording');
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await recorder.getByRole('button', { name: 'Start recording' }).click();
  await expect(recorder.getByRole('status')).toContainText('Recording');
  // While recording, ⌘⇧R opens the recording meeting rather than starting another.
  await home(page).click();
  await page.keyboard.press('ControlOrMeta+Shift+r');
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  expect(await qn(page, q => q.meetings.filter(m => m.metadata.title === 'Untitled meeting').length)).toBe(1);
});

test('R1b: shortcuts can be changed in Settings, never to one that clashes, and Start recording works from any app', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Design review', 'Acme')] });
  await page.goto('/');
  await expect(row(page, 'Design review')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Shortcuts' }).click();
  const record = page.getByRole('button', { name: 'Start recording shortcut' });
  await expect(record).toHaveText(/^(⇧⌘R|Ctrl\+Shift\+R)$/);
  // A key another action has, or one without ⌘/Ctrl, is refused with the reason; Esc keeps the old one.
  await record.click();
  await expect(record).toHaveText('Press keys…');
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.getByRole('alert').filter({ hasText: 'is already the shortcut for New meeting.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Shift+e');
  await expect(page.getByRole('alert').filter({ hasText: /^Include/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(record).toHaveText(/^(⇧⌘R|Ctrl\+Shift\+R)$/);
  // A new key is saved, and it records; the old one does nothing now.
  await record.click();
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(record).toHaveText(/^(⇧⌘E|Ctrl\+Shift\+E)$/);
  await expect.poll(() => qn(page, q => q.state.preferences.keyRecord)).toBe('CmdOrCtrl+Shift+E');
  await page.keyboard.press('ControlOrMeta+Shift+r');
  expect(await qn(page, q => q.state.calls.includes('create_meeting_bundle'))).toBe(false);
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled meeting' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  // Reset brings the default back.
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(record).toHaveText(/^(⇧⌘R|Ctrl\+Shift\+R)$/);
  // From any app: ⌃⌥R by default, registered by Rust; a key another app holds is refused and the old one kept.
  const anyApp = page.getByRole('button', { name: 'Start recording from any app shortcut' });
  await expect(anyApp).toHaveText(/^(⌃⌥R|Ctrl\+Alt\+R)$/);
  await qn(page, q => { q.state.hotkeyTaken = ['Control+Alt+Shift+R', 'CmdOrCtrl+Alt+Shift+R']; });
  await anyApp.click();
  await page.keyboard.press('Control+Alt+Shift+r');
  await expect(page.getByRole('alert').filter({ hasText: 'Another app already uses this shortcut.' })).toBeVisible();
  expect(await qn(page, q => q.state.hotkey)).toBe('Control+Alt+R');
  await page.getByRole('switch', { name: 'Start recording from any app' }).click();
  await expect.poll(() => qn(page, q => q.state.preferences.globalRecord)).toBe('');
  expect(await qn(page, q => q.state.hotkey)).toBe('');
  await expect(anyApp).toHaveCount(0);
  // Pressed in another app, Rust shows the window and asks it to record, as the tray does.
  await qn(page, q => q.emit('quietnote://record-now', null));
  await expect.poll(() => qn(page, q => q.meetings.filter(m => m.metadata.title === 'Untitled meeting').length)).toBe(2);
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
});

test('R2: Hush on the Home card shows the real capture state, looks at whoever is talking, and holds still with Reduce motion', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording], recording: recording.metadata.id, startedAgo: 65 });
  await page.goto('/');
  const hush = page.getByRole('region', { name: 'Recording' }).locator('.hush');
  await expect(hush).toHaveCount(1);
  await expect(hush).toHaveClass(/hush-listening/);
  // The eyes follow the live levels: you on the mic, the others on the call audio, and back once it's quiet.
  await qn(page, q => q.emit('quietnote://levels', [0.3, 0]));
  await expect(hush).toHaveClass(/look-you/);
  await qn(page, q => q.emit('quietnote://levels', [0, 0.3]));
  await expect(hush).toHaveClass(/look-others/);
  await page.waitForTimeout(1300);
  await qn(page, q => q.emit('quietnote://levels', [0, 0]));
  await expect(hush).not.toHaveClass(/look-/);
  const set = (change: Record<string, unknown>) => page.evaluate(c => {
    const q = (window as unknown as { __qn: Mock }).__qn;
    q.state.capture = { ...q.state.capture, ...c }; q.emit('quietnote://capture-state', q.state.capture);
  }, change);
  await set({ recording: { ...(await qn(page, q => q.state.capture.recording)) as object, resumedAt: null } });
  await expect(hush).toHaveClass(/hush-paused/);
  await set({ recording: null, transcribing: { meetingId: recording.metadata.id, title: 'Acme onboarding', percent: 40 }, queued: [] });
  await expect(hush).toHaveClass(/hush-transcribing/);
  await set({ transcribing: null, microphone: 'denied' });
  await expect(hush).toHaveClass(/hush-attention/);
  await set({ microphone: 'granted' });
  await expect(hush).toHaveClass(/hush-ready/);
  expect(await hush.evaluate(el => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await hush.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
});

test('R3: Show Hush turns him off everywhere in the window, brings the status dot back, and follows the saved preference', async ({ page }) => {
  const done = meetingWith('Acme onboarding', { status: 'ready' });
  await mockDesktop(page, { meetings: [done] });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Recording' });
  await expect(card.locator('.hush')).toHaveClass(/hush-ready/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Appearance' }).click();
  const show = page.getByRole('switch', { name: 'Show Hush' });
  await expect(show).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.hush-setting .hush')).toHaveCount(1);
  await show.click();
  await expect(show).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.hush')).toHaveCount(0);
  await expect.poll(() => qn(page, q => q.state.preferences.showHush)).toBe(false);
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(card.locator('.hush')).toHaveCount(0);
  await expect(card.locator('.ready-dot')).toBeVisible();
  // The window follows the saved preference, as it does when another window changes it.
  await qn(page, q => { q.state.preferences = { ...q.state.preferences, showHush: true }; q.emit('quietnote://preferences-changed', null); });
  await expect(card.locator('.hush')).toHaveClass(/hush-ready/);
  await expect(card.locator('.ready-dot')).toHaveCount(0);
});

test('R3b: the theme is light, dark or the computer’s own, saved with the preferences, and Hush turns white in the dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await mockDesktop(page, { meetings: [meetingWith('Acme onboarding', { status: 'ready' })] });
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Appearance' }).click();
  const theme = page.getByRole('group', { name: 'Theme' });
  await expect(theme.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  await theme.getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/dark/);
  await expect.poll(() => qn(page, q => q.state.preferences.theme)).toBe('dark');
  // The native window follows too, so its menus match.
  await expect.poll(() => qn(page, q => q.state.calls.includes('plugin:window|set_theme'))).toBe(true);
  const body = page.locator('.hush-setting .h-body');
  await expect.poll(() => body.evaluate(el => getComputedStyle(el).fill)).toBe('rgb(246, 244, 239)');
  await expect.poll(() => page.locator('.quietnote-shell').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(22, 20, 19)');
  await theme.getByRole('button', { name: 'Light' }).click();
  await expect(html).not.toHaveClass(/dark/);
  await expect.poll(() => body.evaluate(el => getComputedStyle(el).fill)).toBe('rgb(6, 12, 40)');
  // System follows the computer's appearance as it changes.
  await theme.getByRole('button', { name: 'System' }).click();
  await expect.poll(() => qn(page, q => q.state.preferences.theme)).toBe('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/dark/);
});

test('R4: Hush shows a meeting’s transcription and problems, rests in empty places, and is one per screen', async ({ page }) => {
  const processing = meetingWith('Weekly product sync', { status: 'processing' });
  const failed = meetingWith('Design review', { status: 'error', audioPath: 'Acme/design-review/audio', error: 'Whisper stopped.' });
  await mockDesktop(page, { meetings: [processing, failed] });
  await page.goto('/');
  await qn(page, q => { q.state.capture = { ...q.state.capture, transcribing: { meetingId: q.meetings[0].metadata.id, title: 'Weekly product sync', percent: 30 }, queued: [] }; q.emit('quietnote://capture-state', q.state.capture); });
  const card = page.getByRole('region', { name: 'Recording' });
  await expect(card).toContainText('Transcribing on this');
  await expect(card.locator('.hush')).toHaveAttribute('style', /--hush-progress: 0\.3/);
  await row(page, 'Weekly product sync').click();
  await tab(page, 'Transcript').click();
  // The notice's Hush has the screen; the empty transcript below doesn't get a second one.
  await expect(page.locator('.notice .hush')).toHaveClass(/hush-transcribing/);
  await expect(page.locator('.hush')).toHaveCount(1);
  await page.getByRole('button', { name: 'All meetings' }).click();
  await row(page, 'Design review').click();
  await expect(page.locator('.notice.attention .hush')).toHaveClass(/hush-attention/);
  await expect(page.locator('.hush')).toHaveCount(1);
  await page.getByRole('button', { name: 'Action items' }).first().click();
  await expect(page.locator('.empty-state .hush')).toHaveClass(/hush-resting/);
  await page.getByRole('button', { name: 'People' }).click();
  await expect(page.locator('.empty-state .hush')).toHaveClass(/hush-resting/);
});

test('S: if the notes editor fails to load, the window stays usable and Reload recovers it', async ({ page }) => {
  await examples(page);
  await page.route('**/src/components/editor/Editor.tsx*', route => route.abort());
  await row(page, 'Acme onboarding call').click();
  await myNotes(page);
  const failure = page.getByRole('alert').filter({ hasText: 'Notes couldn’t open.' });
  await expect(failure).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeVisible();
  await page.unroute('**/src/components/editor/Editor.tsx*');
  await failure.getByRole('button', { name: 'Reload' }).click();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tiptap')).toBeVisible();
});

test('T: a detected call records from the panel in a meeting named after the app, and muted apps can be allowed again', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Design review', 'Acme')] });
  await page.goto('/');
  await expect(row(page, 'Design review')).toBeVisible();
  // With a dialog open, the panel's Start recording doesn't replace it.
  await page.getByRole('button', { name: 'New meeting' }).first().click();
  await qn(page, q => q.emit('quietnote://record-call', 'Zoom'));
  await expect(page.getByRole('dialog', { name: 'New meeting' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.includes('create_meeting_bundle'))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Otherwise it creates "Zoom call" in the project and starts recording it on Notes.
  await qn(page, q => q.emit('quietnote://record-call', 'Zoom'));
  await expect(page.getByRole('heading', { level: 1, name: 'Zoom call' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  expect(await qn(page, q => q.meetings.map(m => [m.metadata.title, m.metadata.project]).filter(([title]) => title === 'Zoom call'))).toEqual([['Zoom call', 'Acme']]);
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  // Like a notepad beside the call: the window becomes a narrow column with only the meeting in it.
  const navigation = page.getByRole('navigation', { name: 'Meetings and projects' });
  await expect.poll(() => qn(page, q => q.state.compact)).toBe(true);
  await expect(navigation).toBeHidden();
  await expect(page.locator('[data-format-bar]')).toBeHidden();
  await expect(page.locator('.tiptap')).toBeVisible();
  await expect(page.locator('.recording-bar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open full window' }).click();
  await expect.poll(() => qn(page, q => q.state.compact)).toBe(false);
  await expect(navigation).toBeVisible();
  // A second press while recording opens the recording meeting rather than starting another.
  await home(page).click();
  await qn(page, q => q.emit('quietnote://record-call', 'Chrome'));
  await expect(page.getByRole('heading', { level: 1, name: 'Zoom call' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await expect.poll(() => qn(page, q => q.state.compact)).toBe(true);
  // Going anywhere else (here ⌘, for Settings) brings the full window back.
  await page.keyboard.press('ControlOrMeta+,');
  await expect.poll(() => qn(page, q => q.state.compact)).toBe(false);
  await expect(navigation).toBeVisible();
  // "Don't notify for Chrome" is written by Rust; Settings picks it up and can undo it.
  await expect(page.getByRole('switch', { name: 'Offer to record calls' })).toHaveAttribute('aria-checked', 'true');
  await qn(page, q => { q.state.preferences = { ...q.state.preferences, mutedCallApps: ['Chrome'] }; q.emit('quietnote://preferences-changed', null); });
  const muted = page.locator('.setting-row').filter({ hasText: 'Not offered for Chrome' });
  await muted.getByRole('button', { name: 'Notify again' }).click();
  await expect(muted).toHaveCount(0);
  await expect.poll(() => qn(page, q => q.state.preferences.mutedCallApps)).toEqual([]);
  // Recognizing meetings in browsers is opt-in and needs macOS's Accessibility permission, which it asks for.
  const recognize = page.getByRole('switch', { name: 'Recognize meetings in browsers' });
  await expect(recognize).toHaveAttribute('aria-checked', 'false');
  await recognize.click();
  await expect.poll(() => qn(page, q => q.state.preferences.confirmMeetings)).toBe(true);
  const notAllowed = page.getByRole('alert').filter({ hasText: 'macOS hasn’t allowed this yet' });
  await expect(notAllowed).toBeVisible();
  await expect(notAllowed.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
  // Allowed in System Settings: coming back to QuietNote clears the message.
  await qn(page, q => { q.state.accessibility = true; window.dispatchEvent(new Event('focus')); });
  await expect(notAllowed).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Remove call audio from your microphone' })).toHaveAttribute('aria-checked', 'true');
  // Open at login is on unless turned off, so calls are noticed without opening QuietNote first.
  const login = page.getByRole('switch', { name: 'Open at login' });
  await expect(login).toHaveAttribute('aria-checked', 'true');
  await login.click();
  await expect.poll(() => qn(page, q => q.state.preferences.openAtLogin)).toBe(false);
  await page.getByRole('switch', { name: 'Offer to record calls' }).click();
  await expect.poll(() => qn(page, q => q.state.preferences.detectCalls)).toBe(false);
});

test('T2: Record in the call panel starts at once, even before the first-run explanation; macOS asks by itself', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Design review', 'Acme')], microphone: 'undetermined' });
  await page.goto('/');
  await expect(row(page, 'Design review')).toBeVisible();
  await qn(page, q => q.emit('quietnote://record-call', 'Zoom'));
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder.getByRole('status')).toContainText('Recording');
  await expect(recorder).not.toContainText('Before your first recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
});

test('U: the recorder stays at the bottom while notes grow, pauses and resumes, and the microphone can be chosen', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording], recording: recording.metadata.id, startedAgo: 65 });
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.goto('/');
  await page.locator('.recording-bar').getByRole('button', { name: 'Acme onboarding' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder).toContainText('Let everyone know you’re recording.');
  // A message to paste into the call's chat; QuietNote never types into the call app.
  await recorder.getByRole('button', { name: 'Copy message' }).click();
  await expect(recorder.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await qn(page, q => q.state.clipboard)).toBe('Heads up: I’m recording this call for my notes. It’s transcribed on my computer, and no bot joins the call.');
  // Pinned to the bottom of the window, also once the notes are longer than the window.
  await page.locator('.tiptap').click();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Enter');
  expect(await page.locator('.qn-main').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const box = (await recorder.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(640 - 40);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  // Details fold away, and come back.
  const details = recorder.getByRole('button', { name: 'Recording details' });
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  // Folded, it's a small pill: no consent line or microphone, only the levels, the time, Pause and Stop.
  await expect(recorder.getByRole('button', { name: 'Copy message' })).toHaveCount(0);
  await expect(recorder.getByLabel('Microphone')).toHaveCount(0);
  expect((await recorder.boundingBox())!.width).toBeLessThan(300);
  await details.click();
  await expect(recorder.getByRole('button', { name: 'Copy message' })).toBeVisible();
  await expect(recorder.getByLabel('Microphone')).toBeVisible();
  // Pause: the clock stops, Resume is the one primary action, and Stop still ends the recording.
  await recorder.getByRole('button', { name: 'Pause' }).click();
  await expect(recorder.getByRole('status')).toHaveText('Paused');
  await expect(recorder).toContainText('The microphone and call audio aren’t being recorded until you resume.');
  await expect(recorder.getByRole('button', { name: 'Resume' })).toHaveClass(/primary/);
  await expect(recorder.getByRole('button', { name: 'Stop recording' })).not.toHaveClass(/primary/);
  const time = recorder.locator('.recorder-time');
  const paused = await time.textContent();
  await page.waitForTimeout(1200);
  await expect(time).toHaveText(paused!);
  // Everywhere else the window bar says it's paused, and resumes from there.
  await home(page).click();
  const bar = page.locator('.recording-bar');
  await expect(bar).toContainText('Paused');
  await expect(page.getByRole('region', { name: 'Recording' })).toContainText('Paused “Acme onboarding”');
  await bar.getByRole('button', { name: 'Resume' }).click();
  await expect(bar.locator('.recording-label')).toHaveText('Recording');
  await expect(bar.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_pause' || c === 'capture_resume'))).toEqual(['capture_pause', 'capture_resume']);
  // The microphone can be switched during the recording, and the choice is kept.
  await bar.getByRole('button', { name: 'Acme onboarding' }).click();
  const mic = recorder.getByLabel('Microphone');
  await expect(mic).toHaveValue('');
  await expect(mic.locator('option').first()).toHaveText('System default (MacBook Pro Microphone)');
  await mic.selectOption('AirPods Pro');
  await expect.poll(() => qn(page, q => q.state.devices.selected)).toBe('AirPods Pro');
});

test('V: the live transcript follows the recording as a labelled draft, and the full transcript replaces it', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording], recording: recording.metadata.id, startedAgo: 30 });
  await page.goto('/');
  await page.locator('.recording-bar').getByRole('button', { name: 'Acme onboarding' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  const log = recorder.getByRole('log', { name: 'Live transcript' });
  await expect(log).toContainText('Words appear here a few seconds after they’re spoken.');
  // Someone talking before their words arrive shows as dots, never as made-up words.
  await qn(page, q => q.emit('quietnote://levels', [0.3, 0]));
  await expect(log.locator('.listening.you')).toBeVisible();
  await expect(log.locator('.listening.others')).toHaveCount(0);
  // Rust keeps the latest draft (for a view opened later) and sends it.
  await qn(page, q => {
    q.state.draft = { meetingId: q.meetings[0].metadata.id, turns: [
      { startMs: 0, speaker: 'You', text: 'Um, so shall we start?', clean: 'So shall we start?' },
      { startMs: 3000, speaker: 'Others', text: 'Yes, let’s start.', clean: 'Yes, let’s start.' },
    ] };
    q.emit('quietnote://live-transcript', q.state.draft);
  });
  await expect(log.locator('.live-turn.you').first()).toHaveText('YouSo shall we start?');
  await expect(log.locator('.live-turn.others')).toHaveText('OthersYes, let’s start.');
  await expect(recorder).toContainText('Live draft · the full transcript is made when you stop');
  // The Transcript tab shows the same draft (once: the recorder leaves it to the tab), and only this meeting's.
  await tab(page, 'Transcript').click();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('So shall we start?');
  await expect(page.getByRole('log', { name: 'Live transcript' })).toHaveCount(1);
  await expect(recorder.getByRole('log')).toHaveCount(0);
  await qn(page, q => q.emit('quietnote://live-transcript', { meetingId: 'another-meeting', turns: [{ startMs: 0, speaker: 'You', text: 'Wrong meeting', clean: 'Wrong meeting' }] }));
  await expect(panel).not.toContainText('Wrong meeting');
  // After Stop the draft stays, labelled, until the full transcript is ready; then that replaces it.
  await recorder.getByRole('button', { name: 'Stop recording' }).click();
  await expect(panel).toContainText('Live draft. The full transcript replaces it when it’s ready.');
  await expect(panel).toContainText('So shall we start?');
  await qn(page, q => {
    const [m] = q.meetings;
    q.state.transcriptData = [{ startMs: 0, speaker: 'You', text: 'Um, so, shall we start?', clean: 'So, shall we start?' }];
    q.emit('quietnote://meeting-changed', { metadata: { ...m.metadata, status: 'ready' }, transcript: '# Transcript\n\n### 00:00 You\nSo, shall we start?\n', problem: null });
  });
  await expect(panel.locator('.transcript-turn')).toContainText('So, shall we start?');
  await expect(panel).not.toContainText('Live draft');
  await expect(panel.locator('.live-turn')).toHaveCount(0);
});

test('W: a finished meeting records more, and its transcript keeps the earlier part', async ({ page }) => {
  const done = meetingWith('Acme onboarding', { status: 'ready', duration: 754, captureStartedAt: new Date(Date.now() - 3_600_000).toISOString(), captureEndedAt: new Date(Date.now() - 2_800_000).toISOString() });
  done.metadata.audioPath = `Acme/${done.metadata.id}/audio`;
  done.transcript = '# Transcript\n\n### 00:00 You\nLet’s start with the pilot.\n';
  await mockDesktop(page, { meetings: [done] });
  await page.goto('/');
  await page.getByRole('button', { name: /Acme onboarding/ }).click();
  // Recording more is offered, but it isn't the page's main action.
  const header = page.locator('.meeting-header');
  await expect(header.getByRole('button', { name: 'Start recording' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Resume recording' })).not.toHaveClass(/primary/);
  await header.getByRole('button', { name: 'Resume recording' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  await expect(recorder.getByRole('status')).toHaveText('Recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(header.getByRole('button', { name: 'Resume recording' })).toHaveCount(0);
  // The clock carries on from the earlier recording.
  await expect(recorder.locator('.recorder-time')).toHaveText(/^12:3[4-6]$/);
  // The earlier transcript stays, and the new part follows it as a live draft.
  await tab(page, 'Transcript').click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.locator('.transcript-turn')).toContainText('Let’s start with the pilot.');
  // Only one side has spoken, so a label would say nothing: just the time.
  await expect(panel.locator('.transcript-turn h3')).toHaveText('00:00');
  await qn(page, q => {
    q.state.draft = { meetingId: q.meetings[0].metadata.id, turns: [{ startMs: 760_000, speaker: 'Others', text: 'We’re back.', clean: 'We’re back.' }] };
    q.emit('quietnote://live-transcript', q.state.draft);
  });
  await expect(panel.locator('.live-turn.others')).toContainText('We’re back.');
  expect(await panel.evaluate(el => el.querySelector('.transcript-turn')!.compareDocumentPosition(el.querySelector('.live-turn')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
});

test('X: summary suggestions ask before sending, cite the transcript, and write only what you add', async ({ page }) => {
  const done = meetingWith('Pricing sync', { status: 'ready', duration: 600, captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString() });
  done.metadata.audioPath = `Acme/${done.metadata.id}/audio`;
  done.transcript = '# Transcript\n\n### 00:00 Others\nMaya will send the pricing draft by Friday.\n\n### 01:05 You\nThen we go with the annual plan.\n';
  await mockDesktop(page, { meetings: [done] });
  await page.goto('/');
  await page.getByRole('button', { name: /Pricing sync/ }).click();
  // Off by default: nothing to ask, and the empty state says where to turn it on.
  await expect(page.getByRole('button', { name: 'Suggest from transcript…' })).toHaveCount(0);
  await expect(view(page, 'Enhanced notes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Turn on summary suggestions in Settings → Privacy', { exact: false })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByLabel('Drafted by').selectOption('anthropic');
  await page.getByLabel('Anthropic API key').fill('sk-ant-test');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Anthropic key saved')).toBeVisible();
  await expect(page.getByText('or ask Claude for summary suggestions', { exact: false })).toBeVisible();
  await qn(page, q => {
    q.state.transcriptData = [
      { startMs: 0, speaker: 'Others', text: 'Maya will send the pricing draft by Friday.', clean: 'Maya will send the pricing draft by Friday.' },
      { startMs: 65_000, speaker: 'You', text: 'Then we go with the annual plan.', clean: 'Then we go with the annual plan.' },
    ];
    q.state.suggestions = {
      summary: 'The team settled on annual pricing.',
      actions: [{ text: 'Send the pricing draft by Friday', owner: 'Maya', atMs: 0, quote: 'Maya will send the pricing draft' }, { text: 'Update the annual plan page', owner: '', atMs: 65_000, quote: 'we go with the annual plan' }],
      dropped: 1,
    };
  });
  await page.getByRole('button', { name: 'All meetings' }).click();
  await page.getByRole('button', { name: /Pricing sync/ }).click();
  await page.getByRole('button', { name: 'Suggest from transcript…' }).click();
  // Asking first says exactly what leaves the device; cancelling sends nothing.
  const ask = page.getByRole('dialog', { name: 'Suggest from transcript' });
  await expect(ask).toContainText('Send this transcript to Anthropic?');
  await expect(ask).toContainText('The audio, your notes and the meeting’s title stay on this');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(await qn(page, q => q.state.calls.includes('summary_suggest'))).toBe(false);
  await page.getByRole('button', { name: 'Suggest from transcript…' }).click();
  await ask.getByRole('button', { name: 'Send transcript' }).click();
  const panel = page.getByRole('region', { name: 'Suggestions' });
  await expect(panel).toContainText('The team settled on annual pricing.');
  await expect(panel).toContainText('One more was left out because it couldn’t be traced to your notes or the transcript.');
  // Drafting writes nothing.
  expect(await qn(page, q => q.state.saved)).toBe('');
  await panel.getByRole('button', { name: 'Use as summary' }).click();
  await expect(page.locator('.summary-text')).toHaveText('The team settled on annual pricing.');
  await panel.getByRole('listitem').filter({ hasText: 'Send the pricing draft' }).getByRole('button', { name: 'Add' }).click();
  expect(await qn(page, q => q.state.saved)).toContain('- [ ] Maya — Send the pricing draft by Friday');
  // An added item leads the enhanced notes.
  await expect(page.locator('.note-actions .action-text')).toHaveText('Send the pricing draft by Friday');
  await panel.getByRole('button', { name: 'Dismiss “Update the annual plan page”' }).click();
  await expect(panel).toHaveCount(0);
  expect(await qn(page, q => q.state.saved)).not.toContain('annual plan page');
  // A citation opens the transcript at the line it quotes.
  await page.getByRole('button', { name: 'Suggest from transcript…' }).click();
  await ask.getByRole('button', { name: 'Send transcript' }).click();
  await panel.getByRole('button', { name: /01:05.*we go with the annual plan/ }).click();
  await expect(tab(page, 'Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.transcript-turn[data-time="01:05"]')).toHaveClass(/cited/);
});

test('Y: a recording about to stop by itself counts down where you are, and Keep recording cancels it', async ({ page }) => {
  const recording = meetingWith('Acme onboarding', { status: 'recording' });
  await mockDesktop(page, { meetings: [recording], recording: recording.metadata.id, startedAgo: 600 });
  await page.goto('/');
  await page.locator('.recording-bar').getByRole('button', { name: 'Acme onboarding' }).click();
  const recorder = page.getByRole('region', { name: 'Recorder' });
  // Rust noticed the call app let go of the microphone and started the countdown.
  await qn(page, q => {
    const r = q.state.capture.recording as Record<string, unknown>;
    q.state.capture = { ...q.state.capture, recording: { ...r, ending: { reason: 'The Zoom call ended.', stopsAt: new Date(Date.now() + 45_000).toISOString() } } };
    q.emit('quietnote://capture-state', q.state.capture);
  });
  const alert = recorder.getByRole('alert').filter({ hasText: 'The Zoom call ended.' });
  await expect(alert).toContainText(/Recording stops in 00:4\d\./);
  // Elsewhere the recording bar says so too, and can keep it.
  await home(page).click();
  const bar = page.locator('.recording-bar');
  await expect(bar).toContainText('The Zoom call ended.');
  await bar.getByRole('button', { name: 'Keep recording' }).click();
  await expect(bar).not.toContainText('The Zoom call ended.');
  expect(await qn(page, q => q.state.calls.includes('capture_keep'))).toBe(true);
  // Past its time, it waits for quiet rather than cutting someone off.
  await qn(page, q => {
    const r = q.state.capture.recording as Record<string, unknown>;
    q.state.capture = { ...q.state.capture, recording: { ...r, ending: { reason: 'Nothing has been heard for 15 minutes.', stopsAt: new Date(Date.now() - 1000).toISOString() } } };
    q.emit('quietnote://capture-state', q.state.capture);
  });
  await expect(bar).toContainText('Recording stops once it’s quiet.');
});

test('Z: the next meeting of a series shows what the last one left open, and ticking it updates that meeting', async ({ page }) => {
  const last = meetingWith('Weekly sync', { date: new Date(Date.now() - 7 * 86_400_000).toISOString(), status: 'ready', duration: 1800 });
  last.markdown = appendAction(appendAction(last.markdown, 'Maya — send the pricing draft'), 'Book the venue');
  const next = meetingWith('Weekly sync', { status: 'idle' });
  await mockDesktop(page, { meetings: [last, next] });
  await page.goto('/');
  await row(page, 'Weekly sync').first().click();
  await tab(page, 'Notes').click();
  const card = page.locator('.last-time');
  await expect(card).toContainText('Last time');
  await expect(card).toContainText('send the pricing draft');
  await card.getByRole('checkbox').first().click();
  // Written to the earlier meeting's file.
  await expect.poll(() => qn(page, q => q.state.saved)).toContain('- [x] Maya — send the pricing draft');
  await expect(card.getByRole('checkbox').first()).toBeChecked();
  // The earlier meeting itself doesn't carry the card; it opens from the card.
  await card.getByRole('button', { name: 'Open Weekly sync' }).click();
  await myNotes(page);
  await expect(page.locator('.last-time')).toHaveCount(0);
});

test('X2: enhancing notes says what leaves the device, picks a template, and writes only when used', async ({ page }) => {
  const done = meetingWith('Weekly 1:1 with Sam', { status: 'ready', duration: 600, captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString() });
  done.metadata.audioPath = `Acme/${done.metadata.id}/audio`;
  done.transcript = '# Transcript\n\n### 01:05 You\nThen we go with the annual plan.\n';
  done.markdown = replaceSection(done.markdown, 'Notes', '- pricing: annual plan?');
  await mockDesktop(page, { meetings: [done] });
  // Claude is set up, and these are what Rust would return.
  await page.addInitScript(() => {
    const { state } = (window as unknown as { __qn: { state: Record<string, unknown> } }).__qn;
    Object.assign(state, {
      preferences: { summaryProvider: 'anthropic' }, summaryKey: true,
      transcriptData: [{ startMs: 65_000, speaker: 'You', text: 'Then we go with the annual plan.', clean: 'Then we go with the annual plan.' }],
      enhanced: { sections: [{ heading: 'Updates', lines: [{ text: 'They went with the annual plan.', atMs: 65_000, quote: 'we go with the annual plan' }, { text: 'Pricing was the open question.', atMs: null, quote: 'pricing annual plan' }] }], dropped: 2 },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Weekly 1:1 with Sam/ }).click();
  await page.getByRole('button', { name: 'Enhance notes…' }).click();
  const ask = page.getByRole('dialog', { name: 'Enhance notes' });
  await expect(ask).toContainText('Send your notes and this transcript to Anthropic?');
  await expect(ask).toContainText('Your notes (3 words) and about');
  await expect(ask).toContainText('The audio and the meeting’s title stay on this');
  // The title says it's a 1:1, so that template is chosen.
  await expect(ask.getByLabel('Template')).toHaveValue('1:1');
  await ask.getByRole('button', { name: 'Send notes and transcript' }).click();
  const panel = page.getByRole('region', { name: 'Enhanced notes' });
  await expect(panel).toContainText('They went with the annual plan.');
  await expect(panel).toContainText('From your notes: “pricing annual plan”');
  await expect(panel).toContainText('2 more were left out');
  expect(await qn(page, q => q.state.enhancedWith)).toBe('1:1');
  expect(await qn(page, q => q.state.saved)).toBe('');
  await panel.getByRole('button', { name: 'Use these notes' }).click();
  expect(await qn(page, q => q.state.saved)).toContain('### Updates\n- They went with the annual plan. [01:05]\n- Pricing was the open question.');
  // The summary shows its sections, and a transcript line's time opens the transcript there.
  const summary = page.locator('.summary-text');
  await expect(summary.getByRole('heading', { name: 'Updates' })).toBeVisible();
  await summary.getByRole('button', { name: '01:05' }).click();
  await expect(tab(page, 'Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.transcript-turn[data-time="01:05"]')).toHaveClass(/cited/);
});

test('AA: the calendar names meetings and says who is invited, and never starts recording by itself', async ({ page }) => {
  const earlier = meetingWith('Weekly sync', { date: new Date(Date.now() - 7 * 86_400_000).toISOString(), status: 'ready', project: 'Beta', calendarSeries: 'series-1' });
  await mockDesktop(page, { meetings: [earlier, makeMeeting('Design review', 'Acme')] });
  await page.addInitScript(() => {
    const { state } = (window as unknown as { __qn: { state: Record<string, unknown> } }).__qn;
    const at = (minutes: number) => Date.now() + minutes * 60_000;
    const people = [{ name: 'You Me', email: 'me@acme.com', me: true }, { name: 'Maria Lopez', email: 'maria@globex.com' }, { name: 'Sam Lee', email: 'sam@globex.com' }];
    const sync = { id: 'ev-sync@1', series: 'series-1', title: 'Weekly sync', startMs: at(-5), endMs: at(25), attendees: people, link: 'https://meet.google.com/abc-defg-hij' };
    const lunch = { id: 'ev-lunch@1', series: null, title: 'Lunch with Ana', startMs: at(40), endMs: at(90), attendees: [], link: null };
    Object.assign(state, { events: [sync, lunch], now: sync });
  });
  await page.goto('/');
  // Off until turned on: nothing about the calendar shows, and nothing is read.
  await expect(page.getByRole('heading', { name: 'Up next' })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+,');
  const use = page.getByRole('switch', { name: 'Use your calendar' });
  await use.click();
  await expect(use).toHaveAttribute('aria-checked', 'true');
  expect(await qn(page, q => q.state.calendarAccess)).toBe('granted');
  // Home lists what's next; Prepare notes makes the meeting from the event, in the series' project, without recording.
  await home(page).click();
  const next = page.getByRole('region', { name: 'Up next' });
  await expect(next).toContainText('Weekly sync');
  await expect(next).toContainText('2 others');
  await next.getByRole('listitem').filter({ hasText: 'Weekly sync' }).getByRole('button', { name: 'Prepare notes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly sync' })).toBeVisible();
  const made = await qn(page, q => q.meetings.find(m => m.metadata.calendarEvent === 'ev-sync@1')?.metadata);
  expect(made).toMatchObject({ project: 'Beta', participants: ['Maria Lopez', 'Sam Lee'], calendarSeries: 'series-1', status: 'idle' });
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await expect(page.getByRole('img', { name: 'Participants: Maria Lopez, Sam Lee' })).toBeVisible();
  // Its Notes start with what last week's meeting in the series left open.
  await home(page).click();
  await expect(next.getByRole('button', { name: 'Open notes' })).toBeVisible();
  // New meeting fills in from the event happening now, and can drop it.
  await page.keyboard.press('ControlOrMeta+n');
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await expect(dialog.getByLabel('Meeting title')).toHaveValue('Weekly sync');
  await expect(dialog).toContainText('From your calendar');
  await dialog.getByRole('button', { name: 'Don’t use' }).click();
  await expect(dialog.getByLabel('Meeting title')).toHaveValue('');
  await page.keyboard.press('Escape');
  // ⌘⇧R records into the meeting already prepared for the event happening now.
  await page.keyboard.press('ControlOrMeta+Shift+r');
  await expect(page.getByRole('region', { name: 'Recorder' }).getByRole('status')).toContainText('Recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  expect(await qn(page, q => q.meetings.filter(m => m.metadata.title === 'Weekly sync').length)).toBe(2);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  // A call recorded from the panel is named after the event.
  await qn(page, q => q.emit('quietnote://record-call', 'Chrome'));
  await expect.poll(() => qn(page, q => q.meetings.filter(m => m.metadata.title === 'Weekly sync').length)).toBe(3);
  expect(await qn(page, q => q.meetings.some(m => m.metadata.title === 'Chrome call'))).toBe(false);
  // People: everyone invited, grouped by company, each with the meetings they were in.
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', { name: 'People' }).click();
  const globex = page.getByRole('region', { name: 'globex.com' });
  await expect(globex).toContainText('Maria Lopez');
  await expect(globex).toContainText('Sam Lee');
  await globex.getByRole('button', { name: /Maria Lopez/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maria Lopez' })).toBeVisible();
  // The two meetings made from the event; last week's had no invite.
  await expect(page.locator('.meeting-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'globex.com' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'globex.com' })).toBeVisible();
  await page.getByRole('button', { name: 'People' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
});

test('AB: a meeting and its voices get names only from what shows them, or by hand', async ({ page }) => {
  const call = meetingWith('Chrome call', { status: 'ready', duration: 600, captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), attendees: [{ name: 'Me', email: 'me@acme.com', me: true }, { name: 'Maria Lopez', email: 'maria@globex.com' }, { name: 'Sam Lee', email: 'sam@globex.com' }], participants: ['Maria Lopez', 'Sam Lee'] });
  call.metadata.audioPath = `Acme/${call.metadata.id}/audio`;
  call.transcript = '# Transcript\n\n### 00:00 You\nMaria, do you want to start?\n\n### 00:04 Speaker 1\nSure, I\'m Maria from Globex.\n\n### 00:09 Speaker 2\nHi all.\n';
  await mockDesktop(page, { meetings: [call] });
  await page.addInitScript(() => {
    const { state } = (window as unknown as { __qn: { state: Record<string, unknown> } }).__qn;
    Object.assign(state, {
      preferences: { summaryProvider: 'anthropic' }, summaryKey: true,
      transcriptData: [
        { startMs: 0, speaker: 'You', text: 'Maria, do you want to start?', clean: 'Maria, do you want to start?' },
        { startMs: 4000, speaker: 'Speaker 1', text: 'Sure, I\'m Maria from Globex.', clean: 'Sure, I\'m Maria from Globex.' },
        { startMs: 9000, speaker: 'Speaker 2', text: 'Hi all.', clean: 'Hi all.' },
      ],
      names: { title: 'Globex pricing kickoff', speakers: [{ speaker: 'Speaker 1', name: 'Maria Lopez', atMs: 4000, quote: 'I\'m Maria from Globex' }], dropped: 1 },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Chrome call/ }).click();
  await page.getByRole('button', { name: 'Name the meeting and speakers…' }).click();
  const ask = page.getByRole('dialog', { name: 'Name the meeting and speakers' });
  await expect(ask).toContainText('and the names of the 2 people invited go to Claude');
  await ask.getByRole('button', { name: 'Send transcript' }).click();
  const panel = page.getByRole('region', { name: 'Names' });
  await expect(panel).toContainText('Speaker 1 is Maria Lopez');
  await expect(panel).toContainText('One more was left out');
  // Nothing changes until used.
  expect(await qn(page, q => q.state.calls.includes('save_meeting_metadata') || q.state.renamed.length > 0)).toBe(false);
  await panel.getByRole('listitem').filter({ hasText: 'Title:' }).getByRole('button', { name: 'Use' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Globex pricing kickoff' })).toBeVisible();
  await expect.poll(() => qn(page, q => q.state.saved)).toContain('# Globex pricing kickoff');
  await panel.getByRole('listitem').filter({ hasText: 'Maria Lopez' }).getByRole('button', { name: 'Use' }).click();
  await expect(panel).toHaveCount(0);
  expect(await qn(page, q => q.state.renamed)).toEqual([['Speaker 1', 'Maria Lopez']]);
  // By hand: press a voice's label in the transcript, or the title.
  await tab(page, 'Transcript').click();
  await page.getByRole('button', { name: 'Speaker 2' }).click();
  await page.getByLabel('Name for Speaker 2').fill('Sam Lee');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.transcript-turn').filter({ hasText: 'Hi all.' })).toContainText('Sam Lee');
  expect(await qn(page, q => q.state.renamed.at(-1))).toEqual(['Speaker 2', 'Sam Lee']);
  await page.getByRole('button', { name: 'Globex pricing kickoff' }).click();
  await page.getByLabel('Meeting title').fill('Pricing kickoff');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Pricing kickoff' })).toBeVisible();
});

test('AC: with one other person invited, the other voice can be named from the invite without asking a model', async ({ page }) => {
  const call = meetingWith('Zoom call', { status: 'ready', duration: 300, captureStartedAt: new Date().toISOString(), captureEndedAt: new Date().toISOString(), attendees: [{ name: 'Me', email: 'me@acme.com', me: true }, { name: 'Maria Lopez', email: 'maria@globex.com' }], participants: ['Maria Lopez'] });
  call.metadata.audioPath = `Acme/${call.metadata.id}/audio`;
  call.transcript = '# Transcript\n\n### 00:00 You\nHello.\n\n### 00:03 Others\nHi there.\n';
  await mockDesktop(page, { meetings: [call] });
  await page.addInitScript(() => {
    const { state } = (window as unknown as { __qn: { state: Record<string, unknown> } }).__qn;
    state.transcriptData = [{ startMs: 0, speaker: 'You', text: 'Hello.', clean: 'Hello.' }, { startMs: 3000, speaker: 'Others', text: 'Hi there.', clean: 'Hi there.' }];
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Zoom call/ }).click();
  await tab(page, 'Transcript').click();
  await expect(page.getByRole('status').filter({ hasText: 'Is “Others” Maria Lopez?' })).toContainText('Maria Lopez was the only other person invited.');
  await page.getByRole('button', { name: 'Name them' }).click();
  await expect.poll(() => qn(page, q => q.state.renamed)).toEqual([['Others', 'Maria Lopez']]);
  await expect(page.getByText('Is “Others” Maria Lopez?')).toHaveCount(0);
  expect(await qn(page, q => q.state.calls.includes('meeting_names'))).toBe(false);
});

test('AD: first launch on a Mac explains both permissions on one screen before asking, asks one optional question, and records nothing', async ({ page }) => {
  await mockDesktop(page, { meetings: [], microphone: 'undetermined' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Meeting notes, without a bot.' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  // The reasons come first; macOS is asked only on Allow, and that never starts a recording.
  await expect(page.getByRole('heading', { name: 'Allow access.' })).toBeFocused();
  await expect(page.locator('.onboarding')).toContainText('Hears your side, only while you record.');
  expect(await qn(page, q => q.state.calls.includes('capture_allow_microphone'))).toBe(false);
  await page.screenshot({ path: 'docs/screenshots/00-onboarding-microphone.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.locator('.ob-allowed')).toHaveCount(1);
  await page.getByRole('button', { name: 'Use my calendar' }).click();
  await expect(page.locator('.ob-allowed')).toHaveCount(2);
  await expect.poll(() => qn(page, q => q.state.preferences.calendar)).toBe(true);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What meetings do you have most?' })).toBeVisible();
  await page.getByRole('radio', { name: 'User interviews' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Research');
  // In person too: one press of Start recording makes the meeting.
  await expect(page.locator('.onboarding')).toContainText(/In person or on a call, press Start recording \((⇧⌘R|Ctrl\+Shift\+R)\) and the meeting is made for you\./);
  await expect(page.locator('.onboarding')).toContainText('It never starts by itself.');
  await page.screenshot({ path: 'docs/screenshots/00-onboarding-kind.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Research' })).toBeVisible();
  await expect.poll(() => qn(page, q => q.state.preferences.noteTemplate)).toBe('User interview');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(0);
  // The microphone is allowed now, so the first recording starts without the explainer.
  expect(await qn(page, q => q.state.capture.microphone)).toBe('granted');
});

test('AE: a refused microphone shows where to allow it, and skipping it keeps the explainer for the first recording', async ({ page }) => {
  await mockDesktop(page, { meetings: [], microphone: 'undetermined' });
  await page.addInitScript(() => { (window as unknown as { __qn: { state: { micAnswer: string } } }).__qn.state.micAnswer = 'denied'; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone access is off.');
  await expect(page.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  expect(await qn(page, q => q.state.preferences.calendar)).toBeUndefined();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible();
  expect(await qn(page, q => q.state.preferences.noteTemplate)).toBeUndefined();
});

test('AF: Linear and GitHub sign in through the browser, with a way out of every step', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.addInitScript(() => { (window as unknown as { __qn: { state: { signInServices: string[] } } }).__qn.state.signInServices = ['linear', 'github']; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connections' });
  await expect(dialog).toContainText('access is kept in your macOS Keychain, never on a QuietNote server');
  const linear = dialog.locator('.connector', { hasText: 'Linear' }).first();
  // Linear: the browser opens; the window says what's happening and can reopen it or give the link.
  await linear.getByRole('button', { name: 'Connect' }).click();
  await expect(linear.getByRole('status')).toContainText('Starting to sign in to Linear');
  const url = 'https://linear.app/oauth/authorize?client_id=abc';
  await qn(page, q => q.emit('quietnote://sign-in', { service: 'linear', url: 'https://linear.app/oauth/authorize?client_id=abc', code: null, opened: true }));
  await expect(linear.getByRole('status')).toContainText('Finish signing in to Linear in your browser.');
  await linear.getByRole('button', { name: 'Copy link' }).click();
  await expect.poll(() => qn(page, q => q.state.clipboard)).toBe(url);
  await linear.getByRole('button', { name: 'Reopen browser' }).click();
  await expect.poll(() => qn(page, q => q.state.opened)).toEqual([url]);
  // Cancelling ends it quietly, and Connect comes back.
  await linear.getByRole('button', { name: 'Cancel' }).click();
  await expect(linear.getByRole('status')).toHaveCount(0);
  await expect(linear.getByRole('alert')).toHaveCount(0);
  // A failed sign-in says why, and offers a pasted key instead.
  await linear.getByRole('button', { name: 'Connect' }).click();
  await qn(page, q => q.state.pendingSignIn!.reject('Linear didn’t finish signing in: invalid_scope'));
  await expect(linear.getByRole('alert')).toContainText('Linear didn’t finish signing in');
  await expect(linear.getByRole('button', { name: 'Try again' })).toBeVisible();
  await linear.getByRole('button', { name: 'Use a key instead' }).click();
  await expect(linear.getByPlaceholder('Paste your key')).toBeFocused();
  await linear.getByRole('button', { name: 'Cancel' }).click();
  await linear.getByRole('button', { name: 'Connect' }).click();
  await qn(page, q => q.state.pendingSignIn!.resolve({ account: 'Maya Chen' }));
  await expect(dialog.locator('.connector', { hasText: 'Connected as Maya Chen' })).toBeVisible();
  // GitHub: a code to type on GitHub's page, copied and opened in one click.
  const github = dialog.locator('.connector', { hasText: 'GitHub' }).first();
  await github.getByRole('button', { name: 'Connect' }).click();
  await qn(page, q => q.emit('quietnote://sign-in', { service: 'github', url: 'https://github.com/login/device', code: 'WDJB-MJHT', opened: false }));
  await expect(github.locator('.device-code')).toHaveText('WDJB-MJHT');
  await github.getByRole('button', { name: 'Copy code and open GitHub' }).click();
  await expect.poll(() => qn(page, q => q.state.clipboard)).toBe('WDJB-MJHT');
  await expect.poll(() => qn(page, q => q.state.opened.at(-1))).toBe('https://github.com/login/device');
  await qn(page, q => q.state.pendingSignIn!.resolve({ account: 'maya' }));
  await expect(dialog.locator('.connector', { hasText: 'Connected as maya' })).toBeVisible();
});

test('AG: without sign-in built in, Linear and GitHub still connect with a pasted key', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections' }).click();
  const linear = page.getByRole('dialog', { name: 'Connections' }).locator('.connector', { hasText: 'Linear' }).first();
  await linear.getByRole('button', { name: 'Connect' }).click();
  await expect(linear.getByPlaceholder('Paste your key')).toBeFocused();
  expect(await qn(page, q => q.state.calls.includes('connector_sign_in'))).toBe(false);
});

test('AG2: a meeting is deleted only after asking, and on desktop it goes to the Trash; never while it’s being transcribed', async ({ page }) => {
  const busy = makeMeeting('Board prep', 'Acme');
  busy.metadata.status = 'processing';
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme'), busy] });
  await page.goto('/');
  await page.getByRole('button', { name: /Board prep/ }).click();
  await expect(page.getByRole('button', { name: 'Delete meeting' })).toBeDisabled();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /Weekly sync/ }).click();
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Weekly sync”?' });
  await expect(dialog).toContainText('move to the Trash');
  // Cancel is focused, and cancelling changes nothing.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await qn(page, q => q.state.calls.includes('trash_meeting'))).toBe(false);
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByText('Moved “Weekly sync” to the Trash')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(row(page, 'Weekly sync')).toHaveCount(0);
  await expect(row(page, 'Board prep')).toHaveCount(1);
  expect(await qn(page, q => q.state.calls.filter(c => c === 'trash_meeting').length)).toBe(1);
});
test('AG3: in the browser preview a deleted meeting is gone from every list and stays gone', async ({ page }) => {
  await examples(page);
  await row(page, 'Acme onboarding call').click();
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Acme onboarding call”?' });
  await expect(dialog).toContainText('removed from this browser');
  await dialog.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(page.getByText('Deleted “Acme onboarding call”')).toBeVisible();
  await page.getByRole('button', { name: 'All meetings' }).click();
  await expect(page.locator('.meeting-row')).toHaveCount(5);
  await page.reload();
  await page.getByRole('button', { name: 'All meetings' }).click();
  await expect(page.locator('.meeting-row')).toHaveCount(5);
  await expect(row(page, 'Acme onboarding call')).toHaveCount(0);
});

test('AH: AI apps on this computer are added to QuietNote in one click, and files it can’t read are left alone', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.addInitScript(() => {
    (window as unknown as { __qn: { state: { agents: unknown[] } } }).__qn.state.agents = [
      { id: 'claude-desktop', name: 'Claude Desktop', state: 'off', path: '/Users/me/Library/Application Support/Claude/claude_desktop_config.json', problem: null },
      { id: 'codex', name: 'Codex', state: 'other', path: '/Users/me/.codex/config.toml', problem: null },
      { id: 'vscode', name: 'VS Code', state: 'unreadable', path: '/Users/me/Library/Application Support/Code/User/mcp.json', problem: 'VS Code’s settings file couldn’t be read, so it was left as it is (expected value at line 2 column 3). Copy the configuration and add it by hand.' },
    ];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Local archive' }).click();
  const claude = page.getByRole('switch', { name: 'Use with Claude Desktop' });
  await expect(claude).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Adds QuietNote to ~/Library/Application Support/Claude/claude_desktop_config.json.')).toBeVisible();
  await claude.click();
  await expect(claude).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Restart Claude Desktop if it’s open.', { exact: false })).toBeVisible();
  await expect(page.getByText('Set up for another copy of QuietNote', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Use this copy' }).click();
  await expect(page.getByText('Added to ~/.codex/config.toml.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'VS Code’s settings file couldn’t be read' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Use with VS Code' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy configuration' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
});

test('AI: a license is optional, unlocks nothing, and is entered and removed in About', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'Support QuietNote' })).toBeVisible();
  await expect(page.getByText('it doesn’t unlock anything', { exact: false })).toBeVisible();
  // This build has no checkout links, so there's nothing to buy.
  await expect(page.getByRole('button', { name: 'Become a supporter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy for your team' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter license key' }).click();
  await qn(page, q => { (q.state as unknown as Record<string, unknown>).licenseAnswer = 'This key isn’t for QuietNote.'; });
  await page.getByLabel('License key').fill('not-ours');
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByRole('alert')).toHaveText('This key isn’t for QuietNote.');
  await qn(page, q => { (q.state as unknown as Record<string, unknown>).licenseAnswer = { kind: 'commercial', name: 'Acme BV', seats: 12, activatedAt: '2026-10-25T10:00:00Z', expiresAt: '2027-10-25T10:00:00Z' }; });
  await page.getByLabel('License key').fill('QN-ACME');
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Licensed to Acme BV')).toBeVisible();
  await expect(page.getByText('12 seats · Renews 25 Oct 2027')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove license' }).click();
  await expect(page.getByRole('button', { name: 'Enter license key' })).toBeVisible();
  expect(await qn(page, q => q.state.calls.filter(c => c === 'license_activate' || c === 'license_remove'))).toEqual(['license_activate', 'license_activate', 'license_remove']);
});

test('AJ: Give feedback opens a new email with only the version filled in', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Give feedback' }).click();
  await expect.poll(() => qn(page, q => q.state.opened.at(-1))).toMatch(/^mailto:sarl\.the\.developer@gmail\.com\?subject=QuietNote%20feedback&body=/);
});
test('AL: Export audio saves a playable copy in the folder picked each time', async ({ page }) => {
  const recorded = meetingWith('Design review', { status: 'ready', audioPath: 'Acme/design-review/audio' });
  recorded.transcript = '# Transcript\n\n### 00:00 You\nLet’s ship on Friday.\n';
  await mockDesktop(page, { meetings: [recorded] });
  await page.goto('/');
  await page.getByRole('button', { name: /Design review/ }).click();
  await tab(page, 'Transcript').click();
  await page.getByRole('button', { name: 'Export audio…' }).click();
  await expect(page.getByText('Exported the audio to “Desktop”')).toBeVisible();
  expect(await qn(page, q => (q.state as unknown as { exported: unknown[] }).exported)).toEqual([{ meetingId: recorded.metadata.id, folder: '/Users/me/Desktop' }]);
  // Cancelling the picker exports nothing; the folder is asked for every time.
  await qn(page, q => { (q.state as unknown as { folder: null }).folder = null; });
  await page.getByRole('button', { name: 'Export audio…' }).click();
  await expect.poll(() => qn(page, q => q.state.calls.filter(c => c === 'plugin:dialog|open').length)).toBe(2);
  expect(await qn(page, q => q.state.calls.filter(c => c === 'audio_export').length)).toBe(1);
});
test('AK: Privacy says whether FileVault encrypts the disk, and recordings stay out of Time Machine unless turned on', async ({ page }) => {
  test.skip(process.platform !== 'darwin', 'FileVault and Time Machine are macOS only');
  await mockDesktop(page, { meetings: [makeMeeting('Weekly sync', 'Acme')] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Encrypted by FileVault')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open System Settings' })).toHaveCount(0);
  // Recordings are encrypted unless turned off.
  const encrypt = page.getByRole('switch', { name: 'Encrypt recordings' });
  await expect(encrypt).toBeChecked();
  await encrypt.click();
  await expect.poll(() => qn(page, q => q.state.preferences.encryptAudio)).toBe(false);
  const backup = page.getByRole('switch', { name: 'Back up recordings with Time Machine' });
  await expect(backup).not.toBeChecked();
  await backup.click();
  await expect.poll(() => qn(page, q => q.state.preferences.backupAudio)).toBe(true);
  // Turned off, it says what that means and where to turn it on, checked again on coming back.
  await qn(page, q => { (q.state as unknown as { disk: string }).disk = 'off'; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('FileVault is off')).toBeVisible();
  await expect(page.getByText('Encrypted by FileVault')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open System Settings' }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
});
