import type { Meeting } from './model';
const records = [
  {
    id: 'acme-onboarding', title: 'Acme onboarding call', project: 'Acme', date: '2026-09-28T09:00:00', minutes: 42, people: ['Maya Chen', 'Tom Wilson', 'Alex Morgan'], tags: ['Onboarding', 'Launch'],
    summary: 'Acme is ready to move into implementation. The team agreed to move onboarding to 14 October, giving engineering time to complete the analytics integration. The first release will focus on a reliable reporting workflow; SSO will follow in phase two.',
    decisions: ['Move the launch to 14 October', 'Prioritize analytics integration for the first release', 'Keep SSO in phase two'],
    actions: ['Maya — send the revised onboarding plan by 30 September', 'Tom — share analytics credentials by 1 October', 'Alex — schedule a technical review for next week', 'Maya — confirm the new launch date with Acme'],
    notes: '## Before the call\nAcme has three regional teams. Start with the Amsterdam pilot before expanding.\n\n## Follow-up\nAsk whether the analytics sandbox includes historical data. Tom is the technical point of contact.\n\nThe next check-in is Monday at 10:00.',
    transcript: [['00:00', 'Maya Chen', 'Thanks everyone for joining. I want us to leave with a clear onboarding date and a realistic scope for the first release.'], ['00:14', 'Tom Wilson', 'The analytics integration is the main dependency. We can share sandbox credentials this week, but SSO needs a separate security review.'], ['00:31', 'Alex Morgan', 'Then I suggest 14 October for launch. That gives us a full week to validate reporting with the Amsterdam team.'], ['01:08', 'Maya Chen', 'Agreed. Let’s make analytics the priority and move SSO to phase two. I’ll update the onboarding plan and confirm the date with Acme.'], ['01:36', 'Tom Wilson', 'That works. I’ll get the credentials over by Thursday and include a sample dataset.'], ['02:04', 'Alex Morgan', 'I’ll schedule a technical review next week so we can check the integration together.']],
  },
  {
    id: 'weekly-product-sync', title: 'Weekly product sync', project: 'Internal', date: '2026-09-27T14:00:00', minutes: 31, people: ['Alex Morgan', 'Priya Shah', 'Ben Carter'], tags: ['Product'],
    summary: 'The team reviewed feedback from the first eight pilot users. Finding previous decisions is the clearest unmet need. This week will focus on search quality and action-item clarity, with the redesigned onboarding flow held until the next cycle.',
    decisions: ['Focus this cycle on meeting search', 'Show action owners directly in the summary', 'Hold the onboarding redesign until pilot feedback settles'],
    actions: ['Priya — group pilot feedback into three themes', 'Ben — investigate partial title search', 'Alex — write acceptance criteria for action owners'],
    notes: 'Pilot interviews consistently mention finding decisions from older calls.\n\n- Search should handle client names and phrases.\n- Keep the action list visible without scrolling on a laptop.\n- Review the next iteration on Friday.',
    transcript: [['00:00', 'Alex Morgan', 'We have feedback from eight pilot users now. What keeps coming up?'], ['00:22', 'Priya Shah', 'People can remember the client, but not the meeting title. Search and clearer action owners would help most.'], ['00:47', 'Ben Carter', 'I can look at partial matching this week. We should have a small test set from the pilot calls.'], ['01:12', 'Alex Morgan', 'Let’s prioritize that and hold onboarding until the next cycle.']],
  },
  {
    id: 'sales-discovery', title: 'Sales discovery call', project: 'Northstar', date: '2026-09-26T11:30:00', minutes: 48, people: ['Maya Chen', 'Elena Ruiz', 'Sam Patel'], tags: ['Discovery'],
    summary: 'Northstar’s consulting team spends several hours each week turning client calls into follow-up emails. They want a private meeting archive and clear next steps without inviting a bot. A two-week pilot with four consultants will test whether the workflow reduces that overhead.',
    decisions: ['Run a two-week pilot with four consultants', 'Measure time from call end to follow-up sent', 'Keep each client’s meetings in a separate project'],
    actions: ['Elena — nominate the four pilot consultants', 'Maya — send a pilot outline by Wednesday', 'Sam — document the current follow-up workflow', 'Maya — arrange a midpoint check-in'],
    notes: 'Northstar works with regulated clients. Clarify actual storage and processing before any pilot with client data.\n\nElena is the sponsor; Sam owns daily operations.',
    transcript: [['00:00', 'Maya Chen', 'Where does the team spend the most time after a client call?'], ['00:18', 'Elena Ruiz', 'Writing the follow-up. Everyone has their own notes, so decisions sometimes get lost.'], ['00:44', 'Sam Patel', 'We also cannot add a meeting bot to several client calls.'], ['01:15', 'Maya Chen', 'Let’s define a small pilot and measure the time to send a follow-up.']],
  },
  {
    id: 'client-strategy', title: 'Client strategy review', project: 'Acme', date: '2026-09-25T10:00:00', minutes: 55, people: ['Maya Chen', 'Jordan Lee', 'Tom Wilson'], tags: ['Strategy'],
    summary: 'Acme will start with its customer success team rather than a company-wide rollout. Success will be measured by weekly active use and the time needed to prepare account reviews. The team will revisit expansion after the first month of usage.',
    decisions: ['Start with the customer success team', 'Use weekly adoption and preparation time as success measures', 'Review expansion after four weeks'],
    actions: ['Jordan — identify ten initial users', 'Maya — draft the success criteria', 'Tom — confirm workspace access requirements'],
    notes: 'The customer success team has a regular Monday account review. This is a useful anchor for the pilot.\n\nAvoid adding a second reporting process just to measure adoption.',
    transcript: [['00:00', 'Jordan Lee', 'A full rollout feels too broad. Customer success already has a weekly rhythm we can use.'], ['00:26', 'Maya Chen', 'Then let’s start with ten people and agree on two useful measures.'], ['01:02', 'Tom Wilson', 'I’ll check the access requirements before we invite anyone.']],
  },
  {
    id: 'hiring-debrief', title: 'Hiring debrief', project: 'Internal', date: '2026-09-24T15:00:00', minutes: 26, people: ['Priya Shah', 'Alex Morgan', 'Ben Carter'], tags: ['Hiring'],
    summary: 'The panel aligned on the evaluation criteria for the product engineer role. The next round should use a practical pairing exercise with consistent prompts and a written rubric, so candidates are assessed against the same expectations.',
    decisions: ['Use a 45-minute pairing exercise', 'Share the evaluation rubric with every interviewer', 'Send candidates the exercise format in advance'],
    actions: ['Ben — prepare the pairing exercise', 'Priya — consolidate the interview rubric', 'Alex — update the candidate briefing email'],
    notes: 'Keep the exercise close to real product work. Leave ten minutes for candidate questions.\n\nThe rubric should separate communication from implementation correctness.',
    transcript: [['00:00', 'Priya Shah', 'We need the next round to be more consistent between interviewers.'], ['00:21', 'Ben Carter', 'A small pairing exercise would give us a shared reference point.'], ['00:53', 'Alex Morgan', 'Agreed. Let’s explain the format ahead of time so there are no surprises.']],
  },
  {
    id: 'quarterly-planning', title: 'Quarterly planning', project: 'Personal', date: '2026-09-23T08:30:00', minutes: 37, people: ['Alex Morgan', 'Jamie Reed'], tags: ['Planning'],
    summary: 'The next quarter will have two priorities: shipping the meeting workflow and protecting time for customer conversations. Administrative work will be batched on Fridays. A short monthly review will check whether the schedule is still realistic.',
    decisions: ['Reserve two mornings a week for focused product work', 'Batch administrative tasks on Friday afternoons', 'Review the plan at the end of each month'],
    actions: ['Alex — block focus mornings in the calendar', 'Jamie — draft a monthly review checklist', 'Alex — choose three customer conversations for October'],
    notes: 'Leave a buffer around launch week. A realistic plan is more useful than a full calendar.\n\nMonthly review: what shipped, what changed, what to stop.',
    transcript: [['00:00', 'Jamie Reed', 'What do you want to have made progress on by the end of the quarter?'], ['00:19', 'Alex Morgan', 'The meeting workflow, and a more regular habit of speaking to customers.'], ['00:48', 'Jamie Reed', 'Then we should put those in the calendar first and let admin fit around them.']],
  },
];
export const demoMeetings: Meeting[] = records.map(r => {
  const id = `${r.date.slice(0, 10)}-${r.id}`;
  return {
    metadata: { id, title: r.title, project: r.project, date: r.date, duration: r.minutes * 60, participants: r.people, status: 'ready', captureStartedAt: null, captureEndedAt: null, audioPath: null, transcriptPath: `${r.project}/${id}/transcript.md`, meetingPath: `${r.project}/${id}/meeting.md`, tags: r.tags },
    markdown: `# ${r.title}\n\nDate: ${r.date.slice(0, 10)}\nDuration: ${r.minutes} min\nProject: ${r.project}\n\n## Summary\n${r.summary}\n\n## Decisions\n${r.decisions.map(d => `- ${d}`).join('\n')}\n\n## Action items\n${r.actions.map(a => `- [ ] ${a}`).join('\n')}\n\n## Notes\n${r.notes.replace(/^## /gm, '### ')}\n`,
    transcript: `# Transcript\n\nDemo excerpt · illustrative content, not a recording\n\n${r.transcript.map(([time, speaker, words]) => `### ${time} ${speaker}\n${words}`).join('\n\n')}\n`,
  };
});
const exampleIds = new Set(demoMeetings.map(m => m.metadata.id));
export function isExample(id: string): boolean { return exampleIds.has(id); }
