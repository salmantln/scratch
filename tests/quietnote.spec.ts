import { test, expect, type Page } from '@playwright/test';
import { demoMeetings } from '../src/quietnote/seeds';
import { section, replaceSection, toggleAction, matchesMeeting, searchMeeting, makeMeeting, transcriptTurns, validProjectName, appendItem, actionItems, linkAction, issueFor } from '../src/quietnote/model';

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

test('sent action items keep their issue link in Markdown, and only the item leaves the device', () => {
  const blank = makeMeeting('Kickoff', 'Acme');
  const markdown = appendItem(appendItem(blank.markdown, 'Action items', 'Maya — send the plan'), 'Action items', 'Book the room');
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
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await dialog.getByRole('heading', { name: 'New meeting' }).click();
  await expect(dialog.getByLabel('Meeting title')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
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
  await expect(capture).toContainText('Recording needs the desktop app.');
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
  await page.getByRole('button', { name: /Acme onboarding call/ }).click();
  await tab(page, 'Action items').click();
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
    const live = (id: string, startedAt: string) => ({ meetingId: id, title: find(id).metadata.title, startedAt, mic: 'heard', system: 'waiting', micDevice: 'MacBook Pro Microphone', systemDevice: 'this Mac’s sound output', problem: null, note: null });
    const state = {
      calls: [] as string[],
      capture: { available: true, microphone, model, recording: recording ? live(recording, new Date(Date.now() - startedAgo * 1000).toISOString()) : null as unknown, transcribing: null as unknown, queued: [] as string[] },
      transcriptData: null as unknown,
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
          case 'load_meeting_archive': return { root: '/archive', projects: [...new Set(meetings.map(m => m.metadata.project))], meetings };
          case 'get_notes_folder': return '/archive';
          case 'quietnote_preferences': return args.value ?? {};
          case 'connector_status': return {};
          case 'capture_status': return state.capture;
          case 'create_meeting_bundle': meetings.push(args.meeting); return null;
          case 'save_meeting_metadata': { const m = find((args.metadata as Meta).id); m.metadata = args.metadata; return null; }
          case 'capture_start': {
            if (startFailure) throw startFailure;
            const m = find(args.meetingId);
            const startedAt = new Date().toISOString();
            state.capture = { ...state.capture, microphone: 'granted', recording: live(m.metadata.id, startedAt) };
            emit('quietnote://capture-state', state.capture);
            return update(m.metadata.id, { status: 'recording', captureStartedAt: startedAt, audioPath: `${m.metadata.project}/${m.metadata.id}/audio` });
          }
          case 'capture_stop': {
            const id = String((state.capture.recording as { meetingId: string }).meetingId);
            state.capture = { ...state.capture, recording: null, transcribing: { meetingId: id, title: find(id).metadata.title, percent: 40 } };
            emit('quietnote://capture-state', state.capture);
            return update(id, { status: 'processing', duration: 95, captureEndedAt: new Date().toISOString() });
          }
          case 'transcribe_meeting': return update(args.meetingId, { status: 'processing', error: null });
          case 'transcript_data': return state.transcriptData;
          default: return null;
        }
      },
    };
  }, fixture);
}
type Mock = { state: { calls: string[]; capture: Record<string, unknown>; transcriptData: unknown }; emit: (event: string, payload: unknown) => void; meetings: ReturnType<typeof makeMeeting>[] };
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
  await page.getByRole('button', { name: 'Start recording' }).click();
  const recorder = page.getByRole('dialog', { name: 'Design review' });
  await expect(recorder).toContainText('Not recording');
  await expect(recorder).not.toContainText('Prototype');
  await recorder.getByRole('button', { name: 'Start recording' }).click();
  await expect(recorder.getByRole('status')).toContainText('Recording');
  await expect(recorder).toContainText('Started by you · No bot joined');
  await expect(recorder).toContainText('Mic ✓ · Call audio: no sound yet');
  await expect(recorder).toContainText(/Recording continues in the (menu bar|system tray)/);
  // The window says it's recording in every view, with the same elapsed time as the recorder.
  const bar = page.locator('.recording-bar');
  await expect(bar).toContainText('Recording');
  await expect(bar).toContainText('Design review');
  await expect(bar.locator('.recording-time')).toHaveText(/^00:0\d$/);
  await qn(page, q => q.emit('quietnote://capture-state', { ...q.state.capture, recording: { ...(q.state.capture.recording as object), system: 'silent', note: 'Microphone changed to AirPods Pro.' } }));
  await expect(recorder.getByRole('alert')).toContainText('No call audio yet');
  await expect(recorder).toContainText('Microphone changed to AirPods Pro.');
  await recorder.getByRole('button', { name: /^Open (System )?Settings$/ }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
  await recorder.getByRole('button', { name: 'Hide' }).click();
  await expect(recorder).toHaveCount(0);
  await expect(page.getByText(/Recording on this (Mac|PC)\./)).toBeVisible();
  await recent(page).click();
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Stop recording' }).click();
  await expect(bar).toHaveCount(0);
  await bar.page().getByRole('button', { name: /Design review/ }).click();
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
  await expect(page.getByRole('button', { name: 'Show audio' })).toBeVisible();
});

test('K: the tray opens New meeting to record, and recording starts only from its button', async ({ page }) => {
  await mockDesktop(page, { meetings: [makeMeeting('Earlier call', 'Acme')] });
  await page.goto('/');
  await expect(page.locator('.meeting-row')).toHaveCount(1);
  await qn(page, q => q.emit('quietnote://new-meeting', { record: true }));
  const dialog = page.getByRole('dialog', { name: 'New meeting' });
  await dialog.getByLabel('Meeting title').fill('Customer call');
  expect(await qn(page, q => q.state.calls.includes('capture_start'))).toBe(false);
  await dialog.getByRole('button', { name: 'Start recording' }).click();
  const recorder = page.getByRole('dialog', { name: 'Customer call' });
  await expect(recorder.getByRole('status')).toContainText('Recording');
  expect(await qn(page, q => q.state.calls.filter(c => c === 'capture_start').length)).toBe(1);
  await recorder.getByRole('button', { name: 'Stop recording' }).click();
  await expect(recorder).toContainText('Recording ended');
  await expect(recorder).toContainText(/Transcribing on this (Mac|PC)… 40%/);
  await recorder.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Active now' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Keep audio on this device' })).toHaveCount(0);
  await expect(page.getByText('If transcription fails, the audio is kept so you can try again.', { exact: false })).toBeVisible();
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
  const recorder = page.getByRole('dialog', { name: 'First call' });
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
  await expect(recorder).toContainText('Not recording');
  await recorder.getByRole('button', { name: /^Open (System )?Settings$/ }).click();
  expect(await qn(page, q => q.state.calls.includes('open_privacy_settings'))).toBe(true);
  await recorder.getByRole('button', { name: 'Cancel' }).click();
  // No ambiguous state: the meeting is still idle and nothing says it's recording.
  await expect(page.locator('.recording-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  await recent(page).click();
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
  await expect(notice).toContainText('The transcript was recovered.');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  expect(await qn(page, q => q.meetings[0].metadata.interrupted)).toBe(false);
  await recent(page).click();
  await page.getByRole('button', { name: /Design review/ }).click();
  const failure = page.locator('.notice.attention');
  await expect(failure).toContainText('The transcript couldn’t be made.');
  await expect(failure).toContainText('The speech model is missing from this installation of QuietNote.');
  await expect(failure).toContainText('The audio is saved (2 min), so you can try again.');
  await expect(failure.getByRole('button', { name: 'Show audio' })).toBeVisible();
  await expect(page.locator('.meeting-meta .status')).toHaveText('Needs attention');
  await failure.getByRole('button', { name: 'Try again' }).click();
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
  await bar.getByRole('button', { name: 'Acme onboarding' }).click();
  await page.getByRole('button', { name: 'Show recorder' }).click();
  const recorder = page.getByRole('dialog', { name: 'Acme onboarding' });
  await expect(recorder.getByRole('alert')).toContainText('Microphone disconnected. Reconnecting…');
  await expect(recorder.locator('.capture-status strong')).toHaveText(/^01:0[5-9]$/);
});
