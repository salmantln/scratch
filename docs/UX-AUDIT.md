# QuietNote UX audit and refinement

Audit of the shell as of commit `d0c9c23`, followed by what changed and why. The goal: *create project → start meeting → meet normally → keep what mattered → find it instantly later*, with nothing implied that the prototype can't do.

## Audit by view

| View | User goal | Friction / unnecessary UI | Missing feedback | Change |
|---|---|---|---|---|
| First launch | Get started | Six demos seeded silently; there was no first step | No sense of what QuietNote is | One screen with a headline, one line of copy, **Create your first project**, and an optional *Explore example meetings*. Demos are opt-in and badged Example. |
| Projects | Organize meetings | Hard-coded list; couldn't create one | — | One-field dialog. Validation mirrors the Rust `safe_component` rule. A new project opens straight into its empty state ("Nothing here yet."). |
| Library | Scan, reopen | Eyebrow, tagline, pulse motif, search box, project and sort selects, tags under titles, two footers, a "ready" badge on every row | — | Title and count; rows grouped by time; status shown only when it needs attention. Search moved to its own view; project filtering lives in the sidebar. |
| Sidebar | Orientation | Recent titles, shield indicator, the capture button competing for attention | — | New meeting; Recent / All meetings; Projects (+); Search and Settings pinned at the bottom. It becomes an icon rail below 720px. |
| New meeting | Start quickly | It went through capture, which made recording look mandatory | — | Optional title and a preselected project, then the meeting opens. Capture is a separate, explicit action. |
| Capture | Know whether it's capturing | Fake waveform, pause, audio-source row, confirm checkbox, 1.4s fake "Preparing your notes…", "Notes ready" | Honest prototype state | Title, project, prototype line, state text + dot + timer, one primary control. Stop gives "Capture ended. No audio was recorded." with **Add notes**. |
| Meeting detail | "What happened?" | Everything scrolled away; avatar stack; review button; endnote; Summary duplicated both lists in full | — | Sticky title and tabs. Summary shows the summary text, up to 3 decisions and an "n of m open" link. ARIA tabs with arrow keys. |
| Decisions / actions | Scan, tick, add | "Add them in the Markdown workspace" | — | Inline add inputs. Owner shown under the task. Order stays stable when an item is ticked, so the row under the cursor never moves. |
| Notes | Write | Header copy and a shortcut label | — | The editor fills the tab, with a "Start writing…" placeholder. Save state sits in the window bar. |
| Transcript | Reference | Timestamp-first. Contradictory copy on prototype records | — | Speaker, then time, then text. "Transcript unavailable." when there are no turns. Example transcripts are labelled illustrative. |
| Search | Find a decision weeks later | It was just the library with a different H1; results had no context | Where it matched | Dedicated view (⌘K). Snippets with highlighted matches. Opens on the matching tab; Enter opens the first result. "No meetings found for '…'." |
| Settings / privacy | Trust | Hero headline; disabled toggles posing as settings; a transcript toggle that did nothing | Which settings are real | Sections: Privacy · Local archive · About. **Active now** lists facts plus the one enforced switch. **Planned** is visibly inert. |
| Local archive | Know where files live | The raw path was the headline | — | Plain explanation, **Open archive**, **Reload from disk**. Path, workspace and examples under *Advanced*. |
| Errors | Recover without fear | One generic banner for everything; a silent refresh counter | Whether notes are lost | Separate states for: archive unreadable (Retry / Open archive location / details), save failed (Retry / Reload saved version, with a confirm step), recovered draft (Save now / Discard), external change (Refresh), and interrupted meeting (Add notes / Mark as ended). |

## Laws applied (decisions, not decoration)

- **Jakob**:
  - Finder-style sidebar and date groups (Today / Yesterday / Previous 7 days / month).
  - ⌘K search.
  - Tabs behave as ARIA tabs.
  - Checkboxes stay checkboxes.
- **Hick**:
  - First run has one primary decision.
  - Project creation has one field; New meeting has two, both optional or prefilled.
  - Filter and sort selects were removed.
- **Fitts**:
  - New meeting is full-width at the top of the sidebar.
  - Stop capture is full-width in the panel.
  - The discard action needs a second click and is never adjacent to Retry without that step.
- **Miller / progressive disclosure**:
  - One tab of meeting content at a time.
  - Participants appear as one quiet line.
  - Storage path and workspace sit under *Advanced*.
- **Tesler**: filesystem detail is absorbed by the archive layer and shown only in Settings.
- **Doherty**:
  - Everything is local state, so view switches are synchronous.
  - Search debounces the Tantivy call at 150ms while local matching is immediate.
  - Toggles are optimistic only because the recovery draft makes that safe.
- **Von Restorff**:
  - Cobalt fill appears only on the single primary action in each context: sidebar New meeting, dialog primaries, Stop capture, the welcome button and Retry.
  - Status colour appears only for attention states.
- **Proximity / common region**:
  - Title, project, date, duration and participants form one block.
  - Dividers are used instead of cards. Nested cards were removed.
- **Peak-end**:
  - Ending a capture is a calm, complete state with one next step.
  - Search success highlights the phrase and lands on the right tab.
- **Zeigarnik**: capturing, needs-attention and unsaved states are visible but subdued (a dot plus text, never colour alone).

## Final review

| # | Question | Answer |
|---|---|---|
| 1 | Create first project without explanation? | Yes: one button, one field. Covered by test A. |
| 2 | First meeting in seconds? | Yes: New meeting → Create meeting. The title is optional and the project is preselected. |
| 3 | Prototype distinguished from real? | "Prototype" badge and "does not record audio" line in capture. Planned settings are grouped as "Not active yet". Examples are badged. |
| 4 | Any UI implying audio/transcription/AI exists? | No. The waveform, processing step and canned summary are gone. Empty states name what's unavailable. |
| 5 | Meeting is the primary object? | Yes. Every view resolves to meetings; projects only group them. |
| 6 | Understand a seeded meeting in 5 seconds? | Summary text plus the first three decisions and an open-actions count, above the fold at 1280×800. |
| 7 | Find a decision from weeks ago quickly? | ⌘K, type, Enter. Tested with "phase two" and "sample dataset" in test D. |
| 8 | Local and trustworthy without shouting? | No shields or lock icons. Plain facts in Privacy, "Saved" in the window bar, and a Browser preview badge where relevant. |
| 9 | Planned privacy visibly distinct? | A separate group with a badge, muted switches and "They have no effect in this version." |
| 10 | Unnecessary UI left? | Review mode is keyboard-only; the button was removed. The window bar carries only context and save state. |
| 11 | Scroll regions predictable? | The sidebar is fixed, with only the project list scrolling. The window bar is fixed. There is a single content scroller with a sticky meeting header. The capture panel doesn't scroll. |
| 12 | More than one dominant action? | No. Empty-state and in-meeting actions use the secondary style. |
| 13 | Important actions visible? | Yes. There are no overflow menus. |
| 14 | Notes editor reliable and integrated? | Same Scratch editor, drafts and queue. Switching between meetings with persistence is covered by test C. |
| 15 | Errors explicit? | Yes. Each failure state names the problem and the next step. Covered by tests F and G. |
| 16 | Calm? | Neutral surfaces, a restrained type scale (22/26/16/14/12px), and motion limited to a dialog fade and the capture dot. |
| 17 | Meeting workspace, not generic notes? | Notes is one tab among five; the library lists meetings, not files. |
| 18 | Hierarchy survives without styling? | Semantic headings (h1 page or meeting, h2 groups and sections), lists, a tablist and labelled dialogs. |

## Known limits

- Delete and rename for meetings and projects are intentionally not implemented. Use Finder or the Markdown workspace.
- Search opens the matching tab but does not scroll to the exact passage.
- The external-change prompt ignores QuietNote's own writes for about four seconds per path. This path is desktop-only and was not exercised in a live desktop session in this pass. The browser preview has no file watcher.
