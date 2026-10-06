# WCAG 2.2 audit (source review, 6 October 2026)

This is a criterion-by-criterion source audit, not a conformance claim. WCAG 2.2 AAA conformance requires every applicable A, AA, and AAA criterion across complete pages and processes. See the [W3C WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/). Runtime checks remain necessary for every supported theme, viewport, browser/assistive-technology combination, node configuration, and user-provided file/content. The public repository cannot certify deployment theme overrides or third-party/user content. `Unverified` therefore means source inspection alone did not prove a criterion; it is not a pass. `N/A` is scoped to the current Filedeck interface and must be revisited if the product adds the described content or flow.

## Findings and changes

- `Tooltip.tsx`: tooltip remains pointer-hoverable, closes on Escape, and stays associated with its trigger. This addresses the prior immediate close/pointer-events failure against 1.4.13.
- `ContextMenu.tsx`: enabled menu items receive real DOM focus with roving tab stops; arrows, Home/End, type-ahead and nested menu navigation operate on the focused item. Escape returns focus to the opener.
- `ArchiveDialog.tsx`: the dialog form itself carries the dialog semantics, initially focuses its first available control (or dialog), traps Tab, and returns focus on close.
- `FilePanel.tsx`: sort headers are buttons and expose current sort via `aria-sort`.
- `FilePanel.tsx`: tabs now have tablist/tab/tabpanel relationships, one active tab stop and arrow/Home/End navigation. Grid tiles no longer claim listbox/option semantics because the focus model is a keyboard-operated file group containing independent actions; screen-reader interaction remains for browser verification.
- `Compare.tsx`: aligned comparison rows now expose row/cell relationships and the focused grid exposes its active row.
- `AddressBar.tsx`: recent/folder popups expose menu/menuitem semantics, move DOM focus with arrow/Home/End keys, and Escape/Left returns focus to the opener.
- `Dialogs.tsx` and `FilePanel.tsx`: invalid name/link/create fields reference their inline error text; new errors are announced. `Jobs.tsx` keeps interactive job controls outside its concise live-status announcement.
- `Shortcuts.tsx`: the help dialog keeps keyboard focus within its controls and returns it on close.
- T75's `AccessibilityChrome.tsx` and `accessibility.css` add a skip link, main landmark focus target, contextual document title, reduced-motion overrides and higher-contrast bundled theme tokens. Reported token calculations include a lowest muted-text contrast of 7.09:1 on light surfaces, 8.44:1 on dark surfaces, control boundaries at least 5.54:1, and accent text at least 10.64:1. They do not measure runtime custom colors, deployment overrides, overlays or every state.
- T75 also adds foreground/background, font, size, spacing and line-measure controls for 1.4.8. T76 adds a destination picker as a non-drag alternative to file drops (2.5.7). T79 adds vault expiry warnings and idle-time extension bounded by the existing maximum lifetime (2.2.1, 2.2.6). These are source remediation claims pending browser/runtime verification. User-provided media has no inferable equivalent text: Filedeck offers native playback and a titled PDF frame but cannot supply captions/descriptions for arbitrary content.
- `styles.css`: larger targets and a dual-colour focus indicator are applied to shared controls. Dynamic measurements in each theme and viewport are still required.

## Criterion matrix

Status is `N/A`, `Remediated in source; runtime verification pending`, or `Unverified`. The matrix records source-level applicability and evidence limits; no row by itself establishes conformance.

| SC | Level | Criterion | Applicability and source evidence | Status |
|---|---|---|---|---|
| 1.1.1 | A | Non-text Content | First-party Lucide icons are paired with adjacent text or hidden from AT; `Preview.tsx` gives images a file-derived `alt`, so meaningfulness for arbitrary user images is not established. A rendered accessible-name sweep remains. | Unverified |
| 1.2.1 | A | Audio-only and Video-only (Prerecorded) | File preview may render user-provided media; alternatives depend on each file. | Unverified |
| 1.2.2 | A | Captions (Prerecorded) | Any displayed user-provided prerecorded media requires per-item review. | Unverified |
| 1.2.3 | A | Audio Description or Media Alternative (Prerecorded) | Any displayed user-provided video requires per-item review. | Unverified |
| 1.2.4 | AA | Captions (Live) | No first-party live audio/video stream found. | N/A |
| 1.2.5 | AA | Audio Description (Prerecorded) | Any displayed user-provided video requires per-item review. | Unverified |
| 1.2.6 | AAA | Sign Language (Prerecorded) | No first-party prerecorded speech/video content exists in this web UI; criterion is N/A for first-party content. A user-supplied media file's conformance is outside this source audit. | N/A |
| 1.2.7 | AAA | Extended Audio Description (Prerecorded) | Any displayed user-provided video requires per-item review. | Unverified |
| 1.2.8 | AAA | Media Alternative (Prerecorded) | Any displayed user-provided media requires per-item review. | Unverified |
| 1.2.9 | AAA | Audio-only (Live) | No first-party live audio. | N/A |
| 1.3.1 | A | Info and Relationships | Landmarks, lists, tables, dialogs and controls reviewed; visual-only relationships may remain in runtime content. | Unverified |
| 1.3.2 | A | Meaningful Sequence | DOM ordering is source-reviewable; dynamic panels and assistive-technology reading order need testing. | Unverified |
| 1.3.3 | A | Sensory Characteristics | Instructions and status reviewed at source level; exhaustive route/content review pending. | Unverified |
| 1.3.4 | AA | Orientation | Responsive layout source reviewed; portrait/landscape operation not exercised. | Unverified |
| 1.3.5 | AA | Identify Input Purpose | Account/personal-data fields are not established as applicable; visible forms need runtime audit for autocomplete tokens. | Unverified |
| 1.3.6 | AAA | Identify Purpose | UI component purpose semantics require complete rendered accessibility-tree inspection. | Unverified |
| 1.4.1 | A | Use of Color | State colors and themes require rendered-state inspection. | Unverified |
| 1.4.2 | A | Audio Control | No first-party automatically playing audio found. | N/A |
| 1.4.3 | AA | Contrast (Minimum) | T75 calculated higher-contrast replacements for bundled light/dark tokens; runtime/deployment overrides and arbitrary preview content remain unmeasured. | Remediated in source; runtime verification pending |
| 1.4.4 | AA | Resize Text | CSS reviewed; 200% browser zoom and text expansion need runtime measurement. | Unverified |
| 1.4.5 | AA | Images of Text | No first-party images of text identified; user file previews vary. | Unverified |
| 1.4.6 | AAA | Contrast (Enhanced) | T75 calculated bundled muted text at 7.09:1 minimum on light surfaces and 8.44:1 on dark; accent text at least 10.64:1. Dynamic/custom combinations, deployment overrides and preview content remain unmeasured. | Remediated in source; runtime verification pending |
| 1.4.7 | AAA | Low or No Background Audio | No first-party audio. | N/A |
| 1.4.8 | AAA | Visual Presentation | `PresentationSettings.tsx` provides foreground/background, font, text size through 200%, line/paragraph spacing and line measure controls, persisted in `filedeck.presentation`. Browser verification must prove changes apply across real app content without clipping/overlap. | Remediated in source; runtime verification pending |
| 1.4.9 | AAA | Images of Text (No Exception) | No first-party images of text identified; user file previews vary. | Unverified |
| 1.4.10 | AA | Reflow | Responsive CSS reviewed; 320 CSS px and 400% zoom need browser verification, including file tables. | Unverified |
| 1.4.11 | AA | Non-text Contrast | Focus, control boundaries and state contrast depend on rendered themes. | Unverified |
| 1.4.12 | AA | Text Spacing | User style override needs browser verification across controls and content. | Unverified |
| 1.4.13 | AA | Content on Hover or Focus | Tooltip portal now accepts pointer hover and Escape dismissal; runtime pointer traversal and persistence require confirmation. | Remediated in source; runtime verification pending |
| 2.1.1 | A | Keyboard | File list, menus, tabs and sortable headings need full keyboard-path testing; sortable headings fixed to native buttons. | Unverified |
| 2.1.2 | A | No Keyboard Trap | Modal Tab trap is bounded and Escape closes; all overlays require runtime traversal. | Unverified |
| 2.1.3 | AAA | Keyboard (No Exception) | `FilePanel.tsx` provides keyboard grid navigation, menu actions, sortable native buttons and tab arrow-key movement; T76's `TransferDestination.tsx` allows choosing a node/folder for copy/move without drag. Full action-path verification remains. | Remediated in source; runtime verification pending |
| 2.1.4 | A | Character Key Shortcuts | `App.tsx` limits global `?` to non-editable/non-widget context and honours `filedeck.help-key-disabled`; `Shortcuts.tsx` provides a preference and an always-available button. Test collisions and persisted toggle at runtime. | Remediated in source; runtime verification pending |
| 2.2.1 | A | Timing Adjustable | `SavedPasswords.tsx` warns within 60 seconds and offers Keep active; `vault.extend` renews idle expiry subject to the unchanged creation-time `maxHours` cap. The absolute lifetime is not adjustable, so deployment purpose/exceptions still require owner review. | Remediated in source; runtime verification pending |
| 2.2.2 | A | Pause, Stop, Hide | No first-party auto-updating motion/content identified; dynamic external previews require review. | Unverified |
| 2.2.3 | AAA | No Timing | Any server expiry/session limits require deployment review. | Unverified |
| 2.2.4 | AAA | Interruptions | Notification behavior requires runtime review. | Unverified |
| 2.2.5 | AAA | Re-authenticating | Authentication/session flow is deployment-dependent. | Unverified |
| 2.2.6 | AAA | Timeouts | `SavedPasswords.tsx` starts its alert within the final 60 seconds, exceeding the 20-second warning lead; `server/src/vault.ts` preserves the absolute max lifetime when extending idle expiry. Verify with a short configured TTL and server integration. | Remediated in source; runtime verification pending |
| 2.3.1 | A | Three Flashes or Below Threshold | No first-party flashing content identified; arbitrary preview content is not audited. | Unverified |
| 2.3.2 | AAA | Three Flashes | No first-party flashing content identified; arbitrary preview content is not audited. | Unverified |
| 2.3.3 | AAA | Animation from Interactions | T75 adds reduced-motion overrides; inspect animated interactions and the browser preference response at runtime. | Remediated in source; runtime verification pending |
| 2.4.1 | A | Bypass Blocks | T75 adds a visible-on-focus skip link to the main focus target. Keyboard/screen-reader navigation still needs runtime confirmation. | Remediated in source; runtime verification pending |
| 2.4.2 | A | Page Titled | T75 adds a default title and updates from active file panel/dialog context. Verify dialogs, route changes and `document.title` in browser. | Remediated in source; runtime verification pending |
| 2.4.3 | A | Focus Order | Modal focus was improved; complete overlays, tabs, menus and route transitions require testing. | Unverified |
| 2.4.4 | A | Link Purpose (In Context) | Link text and icon-link names need exhaustive rendered review. | Unverified |
| 2.4.5 | AA | Multiple Ways | Search/navigation alternatives depend on route and deployment feature set. | Unverified |
| 2.4.6 | AA | Headings and Labels | Labels are partly source-reviewed; complete dialogs and dynamic controls need review. | Unverified |
| 2.4.7 | AA | Focus Visible | Dual-colour focus indicator added; size, contrast and visibility through all themes/overlays require measurement. | Remediated in source; runtime verification pending |
| 2.4.8 | AAA | Location | Current location/path cues reviewed, but assistive-technology and deep-route behavior require runtime checks. | Unverified |
| 2.4.9 | AAA | Link Purpose (Link Only) | All link purposes need exhaustive review. | Unverified |
| 2.4.10 | AAA | Section Headings | Route and overlay heading structure requires complete review. | Unverified |
| 2.4.11 | AA | Focus Not Obscured (Minimum) | Sticky bars, overlays and scrolling focus require browser checks. | Unverified |
| 2.4.12 | AAA | Focus Not Obscured (Enhanced) | Full focus visibility through overlays and scrolling not verified. | Unverified |
| 2.4.13 | AAA | Focus Appearance | Indicator styled globally; required area/contrast measurements per focused component remain. | Unverified |
| 2.5.1 | A | Pointer Gestures | Gestural interactions need feature-by-feature alternative review. | Unverified |
| 2.5.2 | A | Pointer Cancellation | Click/drag activation timing needs interaction testing. | Unverified |
| 2.5.3 | A | Label in Name | Accessible names need comparison against all visible text labels. | Unverified |
| 2.5.4 | A | Motion Actuation | Source search found no device-motion/orientation event listener or motion-actuated command; no first-party motion control is present. Revisit if a device-motion feature is added. | N/A |
| 2.5.5 | AAA | Target Size (Enhanced) | Shared target sizing updated to 44px minimum; exclusions, overlap and effective rendered target dimensions require audit. | Remediated in source; runtime verification pending |
| 2.5.6 | AAA | Concurrent Input Mechanisms | Device/browser input-mode operation not exercised. | Unverified |
| 2.5.7 | AA | Dragging Movements | T76's `TransferDestination.tsx` offers keyboard/pointer node and destination selection with Copy to folder and Move to folder actions; existing tab Move left/right also substitutes for tab dragging. Verify destination filtering and transfer result. | Remediated in source; runtime verification pending |
| 2.5.8 | AA | Target Size (Minimum) | Shared 44px minimum exceeds 24px baseline in affected controls; all exceptions and spacing need rendered audit. | Remediated in source; runtime verification pending |
| 3.1.1 | A | Language of Page | `web/index.html` declares `lang="en-GB"`; loaded SPA document needs runtime verification. | Remediated in source; runtime verification pending |
| 3.1.2 | AA | Language of Parts | Dynamic/user-provided language segments not fully identified. | Unverified |
| 3.1.3 | AAA | Unusual Words | `TechnicalGlossary.tsx` defines Node, Panel, Compare, Quick compare, Hash/SHA-256, Job, Vault, TTL, Glob and Regular expression in keyboard help. Remaining UI copy terminology requires inventory/editorial review. | Remediated in source; runtime verification pending |
| 3.1.4 | AAA | Abbreviations | The UI includes TTL and SHA-256; `TechnicalGlossary.tsx` expands these. A repository-wide UI abbreviation inventory and rendered-page review remain. | Remediated in source; runtime verification pending |
| 3.1.5 | AAA | Reading Level | Full user-facing copy and generated server errors require editorial assessment. | Unverified |
| 3.1.6 | AAA | Pronunciation | Proper names and user content require context-specific pronunciation support review. | Unverified |
| 3.2.1 | A | On Focus | Focus-triggered behavior needs runtime testing across routes and custom widgets. | Unverified |
| 3.2.2 | A | On Input | Input-triggered changes need runtime testing, including permission and filter forms. | Unverified |
| 3.2.3 | AA | Consistent Navigation | Route/page comparison requires complete application traversal. | Unverified |
| 3.2.4 | AA | Consistent Identification | Repeated controls and icon names need cross-route comparison. | Unverified |
| 3.2.5 | AAA | Change on Request | Navigation and context actions need end-to-end review. | Unverified |
| 3.2.6 | A | Consistent Help | The global `?` key and keyboard-help button open `Shortcuts.tsx`; the same entry point remains mounted at app level. Verify route/deployment consistency and collisions. | Remediated in source; runtime verification pending |
| 3.3.1 | A | Error Identification | Validation/error paths need complete form exercise. | Unverified |
| 3.3.2 | A | Labels or Instructions | Form labels/source hints reviewed; exhaustive path coverage pending. | Unverified |
| 3.3.3 | AA | Error Suggestion | Invalid input feedback needs form-by-form review. | Unverified |
| 3.3.4 | AA | Error Prevention (Legal, Financial, Data) | Destructive and data-changing flows require testing; Properties draft-blur behavior handled separately by T75. | Unverified |
| 3.3.5 | AAA | Help | Forms provide labelled fields and some inline hints, and technical terms have an opt-in glossary; there is no demonstrated context-sensitive help for each form. Audit every operation/dialog before claiming this criterion. | Unverified |
| 3.3.6 | AAA | Error Prevention (All) | All state-changing forms need confirmation/reversibility review. | Unverified |
| 3.3.7 | A | Redundant Entry | Multi-step processes and retained values need end-to-end testing. | Unverified |
| 3.3.8 | AA | Accessible Authentication (Minimum) | No first-party cognitive-function authentication identified; deployment authentication remains outside this checkout. | Unverified |
| 3.3.9 | AAA | Accessible Authentication (Enhanced) | No first-party authentication flow identified; deployment authentication remains outside this checkout. | Unverified |
| 4.1.2 | A | Name, Role, Value | Context menu roving focus and native sortable buttons improve semantics; full rendered accessibility-tree review pending. | Remediated in source; runtime verification pending |
| 4.1.3 | AA | Status Messages | Live status/error announcements need complete runtime review. | Unverified |

WCAG 2.2 removes 4.1.1 Parsing; it is not a success criterion in this matrix. This audit has not run assistive technology, contrast automation, zoom/reflow, all menu/dialog workflows, third-party media review, or deployment-theme testing. No AAA conformance claim is made.
