import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isEnhancedContrastFailure } from './contrast.mjs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const baseURL = process.env.FILEDECK_URL;
if (!baseURL) throw new Error('Set FILEDECK_URL to the local build or deployed Filedeck URL.');
const nodeName = 'browser-fixture';
const tracked = '/work/tracked.txt';
const plain = '/outside.txt';
const trackedDir = dirname(tracked);
const only = (process.env.FILEDECK_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const evidenceDir = resolve(process.env.FILEDECK_EVIDENCE_DIR || './evidence');
await mkdir(evidenceDir, { recursive: true });
const originalMode = 0o644;
const changedMode = 0o600;
const permCalls = [];
const opCalls = [];
const worktreeRequests = [];
const vaultEntryId = 'fixture-vault-entry';
let vaultExpiry = 0;
let vaultListCalls = 0;
let fakeMode = originalMode;

const entry = (path, mode = originalMode) => ({
  name: path.split('/').at(-1), path, type: 'file', size: 128,
  mtime: 1791264000000, mode,
});
const gitInfo = (path, worktrees) => worktrees && path.startsWith('/parent-repo') ? {
  repo: {
    root: path.startsWith('/parent-repo/nested-repo/') ? '/parent-repo/nested-repo' : '/parent-repo',
    kind: 'worktree', rel: path.slice('/parent-repo/'.length),
    summary: { kind: 'worktree', branch: 'fixture', head: '0123456789abcdef', staged: 0, modified: 0, untracked: 0, conflicted: 0 },
    lastCommit: null, stash: 0, remotes: [],
    lists: { staged: [], modified: [], untracked: [], conflicted: [] },
    counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, listCap: 100,
    file: { tracked: true, letters: '', lastCommit: null },
  },
} : path.startsWith('/work/') ? {
  repo: {
    root: '/work', kind: 'worktree', rel: path.slice('/work/'.length),
    summary: { kind: 'worktree', branch: 'fixture', head: '0123456789abcdef', staged: 0, modified: 0, untracked: 0, conflicted: 0 },
    lastCommit: null, stash: 0, remotes: [],
    lists: { staged: [], modified: [], untracked: [], conflicted: [] },
    counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, listCap: 100,
    file: { tracked: true, letters: '', lastCommit: null },
  },
} : { repo: null };

function appState({ path = '/work', selected = tracked, props = true, extra = {} } = {}) {
  const leaf = { i: 'p1', n: nodeName, p: path, s: selected };
  if (props) leaf.v = ['right', 40, 'p'];
  return `?s=${encodeURIComponent(JSON.stringify({ t: leaf, a: 'p1', ...extra }))}`;
}

function directState(extra = {}) {
  return `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work' }, a: 'p1', ...extra }))}`;
}

// A deterministic listing of `n` files for the virtual-list check.
const bigEntries = (n) => Array.from({ length: n }, (_, i) => ({ name: `file-${String(i).padStart(5, '0')}.txt`, path: `/big/file-${String(i).padStart(5, '0')}.txt`, type: 'file', size: 128, mtime: 1791264000000, mode: originalMode }));
const bigRows = bigEntries(20_000);
const markdownText = '# Fixture heading\n\nA paragraph with a [link](https://example.com/) and `code`.\n\n- one\n- two\n\n```\nblock\n```\n';
const diffSide = (size = 128) => ({ t: 'file', s: size, m: 1791264000000 });
const trashItems = [
  { id: 'trash-1', name: 'old-report.txt', originalPath: '/work/old-report.txt', deletedAt: 1791264000000, type: 'file', size: 512 },
  { id: 'trash-2', name: 'old-folder', originalPath: '/work/old-folder', deletedAt: 1791263000000, type: 'dir', size: 0 },
  { id: 'trash-3', name: 'older.log', originalPath: '/work/older.log', deletedAt: 1791262000000, type: 'file', size: 2048 },
];
const stateOf = (tree, extra = {}) => `?s=${encodeURIComponent(JSON.stringify({ t: tree, a: 'p1', ...extra }))}`;

// opts.vault: serve one saved password near expiry; opts.worktrees: serve a nested repository with worktrees.
async function installFixture(page, opts = {}) {
  if (opts.vault) vaultExpiry = Date.now() + 30_000;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/nodes') return json({ nodes: [{ name: nodeName, online: true }, { name: 'fixture-dest', online: true }] });
    if (pathname === `/api/nodes/${encodeURIComponent(nodeName)}/api/mounts`) return json({ mounts: [] });
    if (pathname === '/api/vault') {
      if (!opts.vault) return json({ entries: [], persistent: false, ttlSeconds: 3600, maxHours: 24 });
      vaultListCalls++;
      return json({ entries: [{ id: vaultEntryId, node: nodeName, scope: 'file', path: '/work/tracked.txt', remembered: false, createdAt: Date.now() - 3_600_000, lastUsed: Date.now(), expiresAt: vaultExpiry }], persistent: true, ttlSeconds: 3600, maxHours: 24 });
    }
    if (pathname === `/api/vault/${vaultEntryId}/extend` && req.method() === 'POST') {
      vaultExpiry = Date.now() + 3_600_000;
      return json({ id: vaultEntryId, node: nodeName, scope: 'file', path: '/work/tracked.txt', remembered: false, createdAt: Date.now() - 3_600_000, lastUsed: Date.now(), expiresAt: vaultExpiry });
    }
    if (pathname.includes('/api/fs/list')) {
      const path = url.searchParams.get('path') || '/';
      if (pathname.includes('/fixture-dest/')) {
        const rows = path === '/' ? [{ name: 'destination', path: '/destination', type: 'dir', size: 0, mtime: 1791264000000, mode: 0o755 }] : [];
        return json({ path, entries: rows, truncated: false });
      }
      if (path === '/big') return json({ path, entries: bigRows, truncated: false });
      const rows = opts.worktrees && path === '/parent-repo/nested-repo/sub'
        ? [entry('/parent-repo/nested-repo/sub/current.txt')]
        : path === '/work'
        ? [entry(tracked, fakeMode), entry('/work/readme.md'), entry('/work/package.zip'), { name: 'subdir', path: '/work/subdir', type: 'dir', size: 0, mtime: 1791264000000, mode: 0o755 }]
        : path === '/'
          ? [entry(plain, fakeMode), { name: 'work', path: '/work', type: 'dir', size: 0, mtime: 1791264000000, mode: 0o755 }]
          : [];
      return json({ path, entries: rows, truncated: false });
    }
    if (pathname.endsWith('/api/fs/props')) {
      const path = url.searchParams.get('path') || tracked;
      const isTracked = path.startsWith('/work/');
      return json({
        name: path.split('/').at(-1), path, type: 'file', size: 128,
        diskBytes: 4096, mtime: 1791264000000, atime: 1791264000000, ctime: 1791264000000,
        ino: 42, nlink: 1, mode: isTracked && path === tracked ? fakeMode : originalMode,
        uid: 1000, gid: 1000, owner: 'tester', group: 'users', volume: null,
      });
    }
    if (pathname.endsWith('/api/fs/stat')) {
      const path = url.searchParams.get('path') || tracked;
      return json(entry(path, path === tracked ? fakeMode : originalMode));
    }
    if (pathname.endsWith('/api/git/info')) return json(gitInfo(url.searchParams.get('path') || '/', opts.worktrees));
    if (pathname.endsWith('/api/git/status')) return json({ repo: null, entries: {}, children: {}, pending: false });
    if (pathname.endsWith('/api/git/worktrees')) {
      const queriedPath = url.searchParams.get('path') || '/';
      worktreeRequests.push(queriedPath);
      if (opts.worktrees) {
        const nested = queriedPath.startsWith('/parent-repo/nested-repo');
        const root = nested ? '/parent-repo/nested-repo' : queriedPath.startsWith('/parent-repo') ? '/parent-repo' : '/work';
        const names = nested ? ['nested-main', 'nested-unrelated'] : root === '/parent-repo' ? ['parent-main', 'parent-feature', 'parent-release'] : ['main', 'feature-checkout', 'release-checkout'];
        return json({ repo: root, bare: false, truncated: false, worktrees: names.map((name, i) => ({
          path: i === 0 ? root : `${root}-${name}`, gitPath: `/host/${name}`, name, main: i === 0, bare: false,
          branch: i === 0 ? 'main' : name, detached: false, head: '01234567', locked: false, prunable: false, dirty: false, current: i === 0,
        })) });
      }
      return json({ worktrees: [] });
    }
    if (pathname.endsWith('/api/fs/perms') && req.method() === 'POST') {
      const body = req.postDataJSON();
      permCalls.push(body);
      if (typeof body.mode === 'number' && (body.path || tracked) === tracked) fakeMode = body.mode;
      return json({ changed: 1, errors: 0 });
    }
    if (pathname.endsWith('/api/jobs')) return json({ jobs: [] });
    if (pathname === '/api/ops/jobs' && req.method() === 'POST') {
      opCalls.push(req.postDataJSON());
      return json({ id: `fixture-op-${opCalls.length}`, state: 'queued' });
    }
    if (pathname === '/api/ops/jobs') return json({ jobs: [] });
    if (pathname.endsWith('/api/trash/list')) return json({ volumes: [{ volume: '/', items: trashItems, truncated: false }] });
    if (pathname.endsWith('/api/fs/read')) return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: markdownText });
    if (pathname.endsWith('/api/fs/text')) return json({ path: url.searchParams.get('path'), content: url.searchParams.get('path')?.endsWith('.md') ? markdownText : 'saved text\n', size: 12, mtime: 1791264000000, etag: 'etag-1' });
    if (pathname.endsWith('/api/fs/rename') || pathname.endsWith('/api/fs/mkdir')) return json({ ok: true });
    if (pathname.endsWith('/api/archive/list')) return json({ entries: [{ name: 'inside.txt', type: 'file', size: 128, date: '2026-10-06' }], truncated: false, bytes: 128 });
    if (pathname.endsWith('/api/git/refs')) return json({ bare: false, refs: ['main'], prs: [{ n: 12, subject: 'Fixture pull request' }] });
    if (pathname.endsWith('/api/git/diff')) return json({
      base: { ref: 'main', sha: '0123456789abcdef0123456789abcdef01234567' },
      head: { ref: 'fixture/pr-12', sha: '89abcdef0123456789abcdef0123456789abcdef' },
      mergeBase: '0123456789abcdef0123456789abcdef01234567', files: [], truncated: false, pr: 12,
    });
    if (pathname.endsWith('/api/diff/jobs') && req.method() === 'POST') return json({ id: 'diff-fixture', kind: 'diff', title: 'Compare', state: 'running', progress: { bytes: 0, totalBytes: 0, entries: 0, totalEntries: 0, current: '' }, createdAt: Date.now() });
    if (pathname === '/api/diff/jobs/diff-fixture') return json({
      id: 'diff-fixture', kind: 'diff', title: 'Compare', state: 'done', progress: { bytes: 0, totalBytes: 0, entries: 3, totalEntries: 3, current: '' }, createdAt: Date.now(),
      stats: { dirsScanned: 1, dirsQueued: 0, entries: 3, hashed: 0, hashQueued: 0, hashedBytes: 0, cacheHits: 0, cacheMisses: 0, startedAt: Date.now() - 100, finishedAt: Date.now(), rev: 1, warnings: [] },
      files: { identical: 1, different: 1, leftOnly: 1, rightOnly: 0, error: 0 }, dirs: { identical: 0, different: 0, leftOnly: 0, rightOnly: 0, error: 0 },
    });
    if (pathname === '/api/diff/jobs/diff-fixture/rows') return json({ rel: url.searchParams.get('rel') || '', listed: true, status: 'different', rev: 1, rows: [
      { p: 'tracked.txt', status: 'different', l: diffSide(128), r: diffSide(256), newer: 'right' },
      { p: 'same.txt', status: 'identical', l: diffSide(), r: diffSide() },
      { p: 'only-left.txt', status: 'left-only', l: diffSide() },
    ] });
    if (pathname === '/api/diff/jobs/diff-fixture/subtree') return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ p: 'tracked.txt', status: 'different', l: diffSide(128), r: diffSide(256), newer: 'right' })}\n` });
    if (pathname.startsWith('/api/diff/jobs/')) return json({});
    if (pathname.endsWith('/api/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    if (pathname.endsWith('/api/fs/search')) return json({ results: [], truncated: false });
    return json({});
  });
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 });
}
let currentCheck = 'check';
let pendingShots = [];

async function openPage(browser, { viewport = { width: 1365, height: 900 }, colorScheme = 'light', state = appState(), fixture = {} } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  // The last screenshot of each page is kept in memory and written only when its check fails.
  const realClose = context.close.bind(context);
  context.close = async (...args) => {
    try { pendingShots.push(await page.screenshot({ timeout: 3000 })); } catch { /* the page may be gone already */ }
    return realClose(...args);
  };
  const diagnostics = [];
  page.on('pageerror', (error) => diagnostics.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push({ type: 'console', message: message.text() });
  });
  page.on('requestfailed', (request) => diagnostics.push({ type: 'requestfailed', url: request.url(), error: request.failure()?.errorText }));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('/api/git/')) diagnostics.push({ type: 'git-response', status: response.status(), url: response.url() });
  });
  await page.addInitScript((mode) => localStorage.setItem('filedeck-theme', mode), colorScheme);
  await installFixture(page, fixture);
  await page.goto(new URL(state, baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('.fp').first().waitFor({ state: 'visible', timeout: 15000 });
  return { context, page, diagnostics };
}

// The pull request diff is no longer a routed dialog: it is a labelled region inside the Git section of Properties,
// opened by the Git tab, which the URL state carries as the leaf's `pt` field.
const gitTabState = () => `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', s: tracked, v: ['right', 40, 'p'], pt: 'git' }, a: 'p1' }))}`;

async function verifyPrDiffSection(browser) {
  const { context, page } = await openPage(browser, { state: gitTabState() });
  try {
    const region = page.getByRole('region', { name: 'Pull request diff' });
    await region.waitFor({ state: 'visible', timeout: 8000 });
    await region.getByRole('textbox', { name: 'Pull request number' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected'), 'true', 'a direct link with the Git section selected must open it');
  } finally {
    await context.close();
  }
}

async function verifyPropsTabKeySequence(browser) {
  const { context, page } = await openPage(browser);
  try {
    const details = page.getByRole('tab', { name: 'Details', exact: true });
    const permissions = page.getByRole('tab', { name: 'Permissions', exact: true });
    await permissions.focus();
    const beforeHome = await page.evaluate(() => ({ id: document.activeElement?.id, role: document.activeElement?.getAttribute('role') }));
    await page.keyboard.press('Home');
    assert.equal(await details.getAttribute('aria-selected'), 'true', 'Home should select Details');
    const afterHome = await page.evaluate(() => ({ id: document.activeElement?.id, role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent?.trim() }));
    await page.keyboard.press('End');
    const endState = { details: await details.getAttribute('aria-selected'), permissions: await permissions.getAttribute('aria-selected'), focus: await page.evaluate(() => ({ id: document.activeElement?.id, role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent?.trim() })) };
    console.log('Properties tab key diagnostic:', JSON.stringify({ beforeHome, afterHome, endState }));
    assert.equal(endState.permissions, 'true', 'End should select the final applicable Properties tab');
  } finally {
    await context.close();
  }
}

async function verifyPresentation(browser) {
  const { context, page } = await openPage(browser);
  try {
    const opener = page.getByRole('button', { name: 'Settings' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'Reading presentation' }).waitFor({ state: 'visible' });
    const size = dialog.getByRole('slider', { name: 'Text size' });
    await size.fill('32');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--user-reading-size').trim() === '32px');
    assert.equal(await size.inputValue(), '32', 'presentation size control should accept 32px');
    assert.ok(await page.evaluate(() => localStorage.getItem('filedeck.presentation')?.includes('32')), 'presentation size should persist');
    const controls = dialog.locator('button:visible, input:visible, select:visible, [role="button"]:visible');
    const clippedAtMaxSize = [];
    for (let i = 0; i < await controls.count(); i++) {
      const control = controls.nth(i);
      await control.scrollIntoViewIfNeeded();
      clippedAtMaxSize.push(...await control.evaluate((e) => {
        // A native radio or checkbox may be visually hidden behind its card: the label is what the user sees and presses.
        if (e instanceof HTMLInputElement && ['radio', 'checkbox'].includes(e.type) && e.labels?.[0]) { e = e.labels[0]; e.scrollIntoView({ block: 'nearest' }); }
        const r = e.getBoundingClientRect();
        const failures = [];
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          const clipsX = ['hidden', 'clip'].includes(s.overflowX);
          const clipsY = ['hidden', 'clip'].includes(s.overflowY);
          if (!clipsX && !clipsY) continue;
          const pr = p.getBoundingClientRect();
          const left = pr.left + p.clientLeft, top = pr.top + p.clientTop;
          const right = left + p.clientWidth, bottom = top + p.clientHeight;
          const outsideX = clipsX && (r.left < left - 1 || r.right > right + 1);
          const outsideY = clipsY && (r.top < top - 1 || r.bottom > bottom + 1);
          if (outsideX || outsideY) {
            const reachableScrollports = [];
            for (let a = p.parentElement; a && a !== document.body; a = a.parentElement) {
              const as = getComputedStyle(a);
              const axes = [];
              if (['auto', 'scroll'].includes(as.overflowX) && a.scrollWidth > a.clientWidth + 1) axes.push('x');
              if (['auto', 'scroll'].includes(as.overflowY) && a.scrollHeight > a.clientHeight + 1) axes.push('y');
              if (axes.length) reachableScrollports.push({ ancestor: a.className?.toString?.() || a.tagName, axes, scrollLeft: a.scrollLeft, scrollTop: a.scrollTop, maxScrollLeft: a.scrollWidth - a.clientWidth, maxScrollTop: a.scrollHeight - a.clientHeight });
            }
            failures.push({
              html: e.outerHTML.slice(0, 200),
              label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 40),
              ancestor: p.className?.toString?.() || p.tagName,
              overflow: { x: s.overflowX, y: s.overflowY },
              outside: { x: outsideX, y: outsideY },
              reachableScrollports,
              bounds: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
              visibleBounds: { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) },
            });
          }
        }
        return failures;
      }));
    }
    assert.deepEqual(clippedAtMaxSize, [], '32px reading presentation must not clip Settings controls');
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await close.click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate((e) => e === document.activeElement), true, 'closing Settings restores focus to its opener');
    await page.reload();
    await opener.click();
    const restoredDialog = page.getByRole('dialog', { name: 'Settings' });
    await restoredDialog.waitFor({ state: 'visible' });
    await restoredDialog.getByRole('heading', { name: 'Reading presentation' }).waitFor({ state: 'visible' });
    const restoredSize = restoredDialog.getByRole('slider', { name: 'Text size' });
    await restoredSize.scrollIntoViewIfNeeded();
    await restoredSize.waitFor({ state: 'visible' });
    assert.equal(await restoredSize.inputValue(), '32', 'presentation preference should restore after reload');
    await page.getByRole('button', { name: 'Reset reading presentation' }).click();
    const defaults = { foreground: '', background: '', font: 'system', fontSize: 16, lineHeight: 1.6, paragraphSpace: 2.4, lineMeasure: 80 };
    await page.waitForFunction(() => document.querySelector('[aria-label="Text size"]')?.value === '16' && !document.documentElement.hasAttribute('data-user-presentation'));
    assert.equal(await page.getByRole('slider', { name: 'Text size' }).inputValue(), '16', 'reset should restore the text size control');
    const assertParagraphSpacingDefault = async (settings) => {
      const spacing = settings.getByRole('slider', { name: 'Paragraph spacing' });
      assert.equal(await spacing.getAttribute('min'), '2.4', 'paragraph spacing default minimum should be 2.4');
      assert.equal(await spacing.inputValue(), '2.4', 'paragraph spacing should remain at its 2.4 default');
      const association = await spacing.evaluate((input) => ({
        id: input.id,
        labels: [...input.labels].map((label) => ({ htmlFor: label.htmlFor, text: label.textContent.trim() })),
      }));
      assert.ok(association.id, 'paragraph spacing control should have an id');
      assert.ok(association.labels.some((label) => label.htmlFor === association.id && label.text === 'Paragraph spacing'), 'paragraph spacing should have an explicit matching label association');
    };
    await assertParagraphSpacingDefault(dialog);
    assert.equal(await page.locator('html').getAttribute('data-user-presentation'), null, 'reset should remove the user presentation marker');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('filedeck.presentation'))), defaults, 'reset should persist default presentation values');
    await page.reload();
    await page.locator('.fp').first().waitFor({ state: 'visible', timeout: 15000 });
    const defaultDialog = page.getByRole('dialog', { name: 'Settings' });
    if (await opener.getAttribute('aria-pressed') !== 'true') await opener.click();
    try {
      await defaultDialog.waitFor({ state: 'visible' });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        body: document.body.innerText.slice(0, 500),
      }));
      throw new Error(`Settings dialog did not open after reload: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await defaultDialog.getByRole('heading', { name: 'Reading presentation' }).waitFor({ state: 'visible' });
    const defaultSize = defaultDialog.getByRole('slider', { name: 'Text size' });
    await defaultSize.scrollIntoViewIfNeeded();
    await defaultSize.waitFor({ state: 'visible' });
    assert.equal(await defaultSize.inputValue(), '16', 'default text size should restore after reset and reload');
    await assertParagraphSpacingDefault(defaultDialog);
    assert.equal(await page.locator('html').getAttribute('data-user-presentation'), null, 'default presentation should remain unmarked after reload');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('filedeck.presentation'))), defaults, 'default presentation values should remain persisted after reload');
  } finally {
    await context.close();
  }
}

// The destination node is a custom dropdown: a trigger button named "Destination node: <current>" opening a menu of radio items.
async function chooseDestinationNode(page, dialog, node) {
  await dialog.getByRole('button', { name: /^Destination node/ }).click();
  await page.getByRole('menuitemradio', { name: node, exact: true }).click();
  await dialog.getByRole('button', { name: `Destination node: ${node}`, exact: true }).waitFor({ state: 'visible' });
}

async function verifyOperations(browser) {
  const { context, page } = await openPage(browser);
  try {
    const file = page.locator('.fp.active .fp-scroll [data-path="/work/tracked.txt"]');
    await file.waitFor({ state: 'visible' });
    const openTransfer = async (kind) => {
      await file.click();
      await page.keyboard.press('Shift+F10');
      const menu = page.getByRole('menu').last();
      await menu.waitFor({ state: 'visible' });
      const action = kind === 'copy' ? 'Copy to folder...' : 'Move to folder...';
      await menu.getByRole('menuitem', { name: action, exact: true }).press('Enter');
      const dialog = page.getByRole('dialog', { name: kind === 'copy' ? 'Copy to folder' : 'Move to folder' });
      await dialog.waitFor({ state: 'visible' });
      return dialog;
    };
    for (const kind of ['copy', 'move']) {
      const before = opCalls.length;
      let dialog = await openTransfer(kind);
      await chooseDestinationNode(page, dialog, 'fixture-dest');
      await dialog.getByRole('button', { name: 'destination', exact: true }).waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'destination', exact: true }).click();
      assert.equal(opCalls.length, before, `${kind} must not queue while choosing a destination`);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(opCalls.length, before, `cancelling ${kind} must not queue a job`);

      dialog = await openTransfer(kind);
      await chooseDestinationNode(page, dialog, 'fixture-dest');
      await dialog.getByRole('button', { name: 'destination', exact: true }).click();
      const queued = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ops/jobs');
      await dialog.getByRole('button', { name: kind === 'copy' ? 'Copy here' : 'Move here' }).click();
      await queued;
      assert.equal(opCalls.length, before + 1, `explicit ${kind} confirmation must submit one queued operation`);
      assert.deepEqual(opCalls.at(-1), { op: kind, items: [{ node: nodeName, path: '/work/tracked.txt' }], dst: { node: 'fixture-dest', dir: '/destination' }, conflict: 'ask' }, `${kind} job must target the selected arbitrary node and folder`);
    }
  } finally {
    await context.close();
  }

  const vault = await openPage(browser, { state: directState({ se: 1 }), fixture: { vault: true } });
  try {
    await vault.page.getByRole('heading', { name: 'Saved passwords' }).waitFor({ state: 'visible' });
    const warning = vault.page.getByRole('alert').filter({ hasText: 'saved password expires' });
    await warning.waitFor({ state: 'visible' });
    const renew = vault.page.getByRole('button', { name: 'Keep the saved password for /work/tracked.txt active' });
    await renew.waitFor({ state: 'visible' });
    const extended = vault.page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/vault/${vaultEntryId}/extend`);
    await renew.click();
    await extended;
    await vault.page.waitForFunction(() => !document.querySelector('.vault-warning'));
    assert.ok(vaultListCalls >= 2, 'renewal should refresh the vault list');
    assert.equal(await vault.page.getByRole('button', { name: 'Keep the saved password for /work/tracked.txt active' }).count(), 0, 'renewed entry should leave the near-expiry state');
  } finally {
    await vault.context.close();
  }
}

async function verifyProperties(browser) {
  const { context, page } = await openPage(browser);
  const tabs = page.getByRole('tablist', { name: 'Properties sections' });
  await tabs.waitFor({ state: 'visible' });
  await tabs.getByRole('tab', { name: 'Details', exact: true }).waitFor({ state: 'visible' });
  {
    for (const name of ['Git', 'Permissions']) await tabs.getByRole('tab', { name, exact: true }).waitFor({ state: 'visible' });
    const gitTab = tabs.getByRole('tab', { name: 'Git', exact: true });
    assert.ok(await gitTab.getAttribute('aria-controls'), 'each Properties tab should identify its tabpanel');
    await gitTab.click();
    assert.equal(await gitTab.getAttribute('aria-selected'), 'true', 'Git tab must become active');
    assert.match(page.url(), /[?&]s=/, 'tab selection must update shareable URL state');
    const gitURL = page.url();
    await page.reload();
    await page.getByRole('tab', { name: 'Git', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected'), 'true', 'active tab must survive reload');
    await page.goto(gitURL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Git', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('tab', { name: 'Git', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected'), 'true', 'ArrowRight must move between tabs');
    await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const octal = page.getByRole('textbox', { name: 'Octal mode' });
    await octal.waitFor({ state: 'visible' });
    await octal.fill('600');
    const setMode = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/fs/perms'));
    await octal.press('Enter');
    await setMode;
    await page.waitForFunction(() => document.querySelector('[aria-label="Octal mode"]')?.value === '0600');
    assert.ok(permCalls.some((c) => c.mode === changedMode), 'fake API should receive chmod 0600');
    await octal.fill('644');
    const restoreMode = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/fs/perms'));
    await octal.press('Enter');
    await restoreMode;
    await page.waitForFunction(() => document.querySelector('[aria-label="Octal mode"]')?.value === '0644');
    assert.equal(fakeMode, originalMode, 'fixture mode must be restored to 0644');
  }
  await context.close();
}

async function verifyOutsideGit(browser) {
  const { context, page } = await openPage(browser, { state: appState({ path: '/', selected: plain }) });
  await page.getByRole('tablist', { name: 'Properties sections' }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab', { name: 'Git', exact: true }).count(), 0, 'Git tab must be hidden outside a repository');
  await context.close();
}

// A defect found by a check that the owner of the component has not fixed yet. The check keeps running: it must still fail
// (so it cannot rot) and it is listed in the output; once the defect is fixed the run fails until the entry is removed.
const knownDefects = [];
// axe findings that are reported to the owner of the component and not yet fixed; matched by rule, window width and target.
const knownAxe = [
  { id: 'target-size', width: 320, target: 'Folders in', label: 'target-size: the breadcrumb "Folders in <path>" button (.crumb-sep) is 24 px wide and overlapped by the Recent locations button (AddressBar), so its target spacing is under 24 px' },
];
async function expectKnownDefect(id, description, check) {
  let failure = null;
  try { await check(); } catch (error) { failure = error; }
  if (!failure) assert.fail(`known defect ${id} no longer reproduces: remove it from the script (${description})`);
  knownDefects.push(`${id}: ${description} -- ${String(failure.message).split('\n')[0]}`);
}

// The worktrees of the repository are listed inside the Git section of Properties.
async function verifyGitWorktrees(browser) {
  const { context, page } = await openPage(browser, { state: gitTabState(), fixture: { worktrees: true } });
  try {
    await page.locator('.wt-list').waitFor({ state: 'visible' });
    for (const name of ['main', 'feature-checkout', 'release-checkout']) {
      await page.locator('.wt-name', { hasText: name }).waitFor({ state: 'visible' });
    }
    assert.ok(worktreeRequests.includes('/work'), 'the worktrees API must receive the repository context');
    const url = page.url();
    await page.reload();
    await page.locator('.wt-name', { hasText: 'feature-checkout' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    await page.goBack();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    assert.equal(page.url(), url, 'Back should restore the Git section URL');
    await page.locator('.wt-name', { hasText: 'release-checkout' }).waitFor({ state: 'visible' });
    await page.goForward();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  } finally {
    await context.close();
  }

  const nestedPath = '/parent-repo/nested-repo/sub';
  const { context: nestedContext, page: nestedPage } = await openPage(browser, { state: appState({ path: nestedPath, selected: `${nestedPath}/current.txt` }), fixture: { worktrees: true } });
  try {
    await nestedPage.locator('nav.crumbs .crumb').filter({ hasText: /^parent-repo$/ }).click({ button: 'right' });
    await nestedPage.getByRole('menuitem', { name: 'Properties', exact: true }).click();
    await nestedPage.getByRole('tab', { name: 'Git', exact: true }).click();
    await nestedPage.locator('.wt-list').waitFor({ state: 'visible' });
    for (const name of ['parent-main', 'parent-feature', 'parent-release']) {
      await nestedPage.locator('.wt-name', { hasText: name }).waitFor({ state: 'visible' });
    }
    assert.ok(!await nestedPage.locator('.wt-name', { hasText: 'nested-unrelated' }).count(), 'breadcrumb Properties must list the parent repository, not the nested current-folder repository');
    assert.ok(worktreeRequests.includes('/parent-repo'), 'the Git section repository root should be the worktrees API context');
    await expectKnownDefect('breadcrumb-properties-reload', 'Properties opened from a breadcrumb folder is not kept in the URL, so a reload shows the selected file instead', async () => {
      await nestedPage.reload();
      await nestedPage.getByRole('tab', { name: 'Git', exact: true }).waitFor({ state: 'visible' });
      await nestedPage.locator('.wt-name', { hasText: 'parent-main' }).waitFor({ state: 'visible', timeout: 4000 });
    });
  } finally {
    await nestedContext.close();
  }
}

async function verifyHistoryAndDirectLinks(browser) {
  const { context, page } = await openPage(browser);
  // Selecting a Properties tab replaces the current URL entry. Opening Settings
  // after that should preserve the selected section when returning to the view.
  const gitTab = page.getByRole('tab', { name: 'Git', exact: true });
  await gitTab.waitFor({ state: 'visible' });
  const beforePanelState = page.url();
  await gitTab.click();
  const gitPanelState = page.url();
  assert.notEqual(gitPanelState, beforePanelState, 'panel selection should replace shareable URL state');
  assert.equal(await gitTab.getAttribute('aria-selected'), 'true', 'selected tab should become active');
  const initial = page.url();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  const settingsURL = page.url();
  assert.notEqual(settingsURL, initial, 'Settings should push a URL state');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await settingsDialog.waitFor({ state: 'detached' });
  assert.equal(page.url(), initial, 'closing Settings should return to its route boundary');
  assert.equal(await page.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected'), 'true', 'closing Settings should restore the previously selected tab');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  await page.goBack();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
  assert.equal(page.url(), initial, 'Back should restore the file view URL');
  assert.equal(await page.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected'), 'true', 'Back should preserve the selected tab');
  await page.goForward();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  await page.goto(new URL(directState({ se: 1 }), baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });

  await page.goto(new URL(directState({ r: [nodeName, ''] }), baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Trash on ${nodeName}`).waitFor({ state: 'visible' });
  await page.goBack();
  await page.getByLabel(`Trash on ${nodeName}`).waitFor({ state: 'detached' });
  await page.goForward();
  await page.getByLabel(`Trash on ${nodeName}`).waitFor({ state: 'visible' });

  await page.goto(new URL(gitTabState(), baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Pull request diff' }).waitFor({ state: 'visible', timeout: 8000 });
  await context.close();
}

async function verifyFolderHistory(browser) {
  const tree = { i: 'p3', d: 'v', k: [
    { i: 'p1', n: nodeName, p: '/work', s: tracked, v: ['right', 40, 'p'] },
    { i: 'p2', n: nodeName, p: '/', s: plain },
  ] };
  const state = `?s=${encodeURIComponent(JSON.stringify({ t: tree, a: 'p1' }))}`;
  const { context, page } = await openPage(browser, { state });
  try {
    const decode = () => page.evaluate(() => JSON.parse(new URL(location.href).searchParams.get('s') || 'null'));
    const start = await decode();
    const selectedPath = (wire) => wire?.t?.k?.find((leaf) => leaf.i === 'p1')?.s;
    const secondaryPath = (wire) => wire?.t?.k?.find((leaf) => leaf.i === 'p2')?.s;
    assert.equal(selectedPath(start), tracked, 'initial primary selection should be encoded');
    assert.equal(secondaryPath(start), plain, 'secondary panel selection should be encoded');
    const list = page.locator('.fp[data-fp="p1"] .fp-scroll');
    await list.focus();
    // Folders sort first, so the folder is the first row; the last row is tracked.txt.
    await page.keyboard.press('End');
    assert.equal(selectedPath(await decode()), '/work/tracked.txt', 'End should select the last row');
    await page.keyboard.press('Home');
    const selectedFolder = await decode();
    assert.equal(selectedPath(selectedFolder), '/work/subdir', 'Home should select the first row, the folder');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.k?.[0]?.p === '/work/subdir');
    await page.goBack();
    await page.waitForFunction((path) => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.k?.[0]?.p === path, '/work');
    const restored = await decode();
    assert.equal(selectedPath(restored), '/work/subdir', 'Back should restore prior primary selection/cursor');
    assert.equal(secondaryPath(restored), plain, 'Back should preserve secondary panel selection');
    await page.goForward();
    await page.waitForFunction(() => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.k?.[0]?.p === '/work/subdir');
    const forwarded = await decode();
    assert.equal(secondaryPath(forwarded), plain, 'Forward should preserve secondary panel state');
  } finally {
    await context.close();
  }
}

async function verifyNestedViews(browser) {
  const archiveState = `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', s: '/work/package.zip', v: ['right', 40] }, a: 'p1' }))}`;
  const state = archiveState;
  const { context, page } = await openPage(browser, { state });
  try {
    // The archive is an inline preview. Its URL identity remains the selected archive
    // while its contents are browsed, and Back/Forward restores route selection.
    await expectText(page, 'inside.txt');
    assert.match(page.url(), /package\.zip/, 'selected archive remains represented in the route');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    await page.goBack();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    await page.goForward();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    // A direct sync state is validated as a route even when no operation is submitted.
    const split = { i: 'p3', d: 'v', k: [
      { i: 'p1', n: nodeName, p: '/work' },
      { i: 'p2', n: nodeName, p: '/work' },
    ] };
    const sync = `?s=${encodeURIComponent(JSON.stringify({ t: split, a: 'p1', g: { l: [nodeName, '/work'], r: [nodeName, '/work'], a: 'p1', b: 'p2' }, sy: ['copy-lr', ['tracked.txt']] }))}`;
    await page.goto(new URL(sync, baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await page.getByRole('dialog', { name: 'Copy left to right' }).waitFor({ state: 'visible', timeout: 8000 });
    assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get('s')).sy, ['copy-lr', ['tracked.txt']], 'sync route payload survives direct URL load');
  } finally {
    await context.close();
  }
}

async function verifyKeyboardIsolation(browser) {
  const { context, page } = await openPage(browser);
  try {
    // Both list and grid render file entries with data-path and the shared .sel state.
    const selected = page.locator('.fp.active .fp-scroll [data-path].sel');
    await selected.first().waitFor({ state: 'visible' });
    const before = await selected.allTextContents();
    const panel = page.locator('.props-tabpanel:visible').first();
    await panel.focus();
    for (const key of ['Home', 'End', 'Delete', 'Control+a']) await page.keyboard.press(key);
    assert.equal(await page.getByRole('dialog').count(), 0, 'Delete on a Properties tabpanel must not trigger a file action');
    assert.equal(await page.locator('.fp.active .fp-scroll [data-path].sel').count(), before.length, 'Properties keyboard commands must not change file selection');
    const list = page.locator('.fp.active .fp-scroll');
    await list.focus();
    assert.ok(await list.evaluate((e) => e === document.activeElement), 'file viewport should be the keyboard event target');
    // Ctrl+A on the Properties panel intentionally selects page text. Start a fresh
    // file-list interaction with no browser text selection to test file select-all.
    const beforeClear = await page.evaluate(() => ({ selectedText: window.getSelection()?.toString() || '', activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.className, selectedFiles: document.querySelectorAll('.fp.active .fp-scroll [data-path].sel').length }));
    console.log(`Keyboard isolation before file Ctrl+A: ${JSON.stringify(beforeClear)}`);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const initialSelection = await page.locator('.fp.active .fp-scroll [data-path].sel').count();
    await page.keyboard.press('Control+a');
    const selectAllCount = await page.locator('.fp.active .fp-scroll [data-path].sel').count();
    assert.ok(selectAllCount > initialSelection, 'Ctrl+A in the file viewport should still select multiple files');
    assert.ok(await list.evaluate((e) => e.matches(':focus')), 'file viewport should retain keyboard focus');
  } finally {
    await context.close();
  }
}

async function verifyKeyboardAndConfirmation(browser) {
  const { context, page } = await openPage(browser);
  const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
  if (await shortcuts.count()) {
    const before = page.url();
    await shortcuts.click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await dialog.waitFor({ state: 'visible' });
    {
      await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"][aria-label="Keyboard shortcuts"]'));
      const focusables = dialog.locator('button:not([disabled]):visible,input:not([disabled]):visible,select:not([disabled]):visible,textarea:not([disabled]):visible,a[href]:visible,summary:visible,[tabindex]:not([tabindex="-1"]):visible');
      const count = await focusables.count();
      assert.ok(count > 0, 'keyboard shortcuts dialog should contain a focusable close control');
      await focusables.last().focus();
      await page.keyboard.press('Tab');
      assert.equal(await focusables.first().evaluate((e) => e === document.activeElement), true, 'Tab should wrap within the shortcuts dialog');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focusables.last().evaluate((e) => e === document.activeElement), true, 'Shift+Tab should wrap within the shortcuts dialog');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Keyboard shortcuts');
      assert.equal(await shortcuts.evaluate((e) => e === document.activeElement), true, 'closing shortcuts should restore focus to its opener');
      await shortcuts.click();
      await dialog.waitFor({ state: 'visible' });
    }
    {
      const opened = page.url();
      assert.notEqual(opened, before, 'Shortcuts view should have a shareable URL');
      await page.goBack();
      await dialog.waitFor({ state: 'detached' });
      await page.goForward();
      await dialog.waitFor({ state: 'visible' });
    }
  } else {
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ state: 'visible' });
  }
  // After history Back/Forward the dialog is a fresh node: make sure it holds focus before Escape is sent.
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).focus();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ state: 'detached' });
  // Modal opener restoration is checked before history Back/Forward above, when
  // the original opener is still mounted. Route-remounted dialogs use a fresh node.
  {
    await page.getByRole('tab', { name: 'Permissions', exact: true }).focus();
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: 'Details', exact: true }).getAttribute('aria-selected'), 'true', 'Home should select first Properties tab');
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected'), 'true', 'End should select last Properties tab');
  }

  const beforeConfirm = page.url();
  const deleteButton = page.getByRole('button', { name: /Trash|Delete/i }).first();
  if (await deleteButton.count()) {
    await deleteButton.click();
    const dialog = page.getByRole('dialog');
    if (await dialog.count()) {
      assert.equal(page.url(), beforeConfirm, 'confirmation dialogs must not add URL history entries');
      await page.keyboard.press('Escape');
    }
  }
  await context.close();
}

async function verifyMenusAndTooltips(browser) {
  const { context, page } = await openPage(browser);
  const fileList = page.getByRole('grid', { name: /Files in/ });
  await fileList.focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu').last();
  await menu.waitFor({ state: 'visible' });
  const enabled = menu.locator('[role="menuitem"][data-menu-index]:not([disabled])');
  assert.ok(await enabled.count() > 1, 'context menu should expose multiple enabled items');
  assert.equal(await enabled.first().evaluate((e) => e === document.activeElement), true, 'context menu should focus its first enabled item');
  await page.keyboard.press('End');
  assert.equal(await enabled.last().evaluate((e) => e === document.activeElement), true, 'End should focus the last enabled menu item');
  await page.keyboard.press('Home');
  assert.equal(await enabled.first().evaluate((e) => e === document.activeElement), true, 'Home should focus the first enabled menu item');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.matches('.fp.active .fp-scroll'));
  assert.equal(await fileList.evaluate((e) => e === document.activeElement), true, 'Escape should return focus to the context-menu opener');

  const trigger = page.locator('button[aria-label="Up one folder"]');
  await trigger.focus();
  await page.waitForTimeout(220);
  const tipId = await trigger.getAttribute('aria-describedby');
  assert.ok(tipId, 'keyboard focus should describe the tooltip');
  // The bubble is aria-hidden (aria-describedby on the trigger is what assistive technology reads), so find it by attribute.
  const tip = page.locator('[role="tooltip"]').last();
  await tip.waitFor({ state: 'visible' });
  const triggerBox = await trigger.boundingBox();
  const tipBox = await tip.boundingBox();
  assert.ok(triggerBox && tipBox, 'tooltip and trigger should have visible bounds');
  await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
  await page.waitForTimeout(500);
  await page.mouse.move(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  await page.waitForTimeout(250);
  await tip.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await tip.waitFor({ state: 'detached' });
  await context.close();
}

async function checkContrast(page) {
  const candidates = await page.evaluate(() => {
    const parse = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]) => {
      const f = (x) => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };
      return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
    };
    const blend = (fg, bg) => {
      const a = fg[3] + bg[3] * (1 - fg[3]);
      return [0, 1, 2].map((i) => a ? (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a : 0).concat(a);
    };
    const selector = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const bits = [];
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        let part = p.tagName.toLowerCase();
        if (typeof p.className === 'string' && p.className.trim()) part += `.${p.className.trim().split(/\s+/).map(CSS.escape).join('.')}`;
        if (p.parentElement) {
          const siblings = [...p.parentElement.children].filter((n) => n.tagName === p.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(p) + 1})`;
        }
        bits.unshift(part);
        if (p.classList.contains('fp') || p.classList.contains('props-tabpanel') || p.classList.contains('modal')) break;
      }
      return bits.join(' > ');
    };
    const candidates = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      if (!text) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) continue;
      let bg = [255, 255, 255, 1];
      const ancestors = [];
      for (let p = el; p; p = p.parentElement) ancestors.push(p);
      let groupOpacity = 1;
      for (const p of ancestors.reverse()) {
        const style = getComputedStyle(p);
        groupOpacity *= Number.parseFloat(style.opacity || '1');
        const c = parse(style.backgroundColor);
        if (c && c[3] > 0) bg = blend([c[0], c[1], c[2], c[3] * groupOpacity], bg);
      }
      const renderedFg = blend([fg[0], fg[1], fg[2], fg[3] * groupOpacity], bg);
      const ratio = (Math.max(lum(renderedFg), lum(bg)) + .05) / (Math.min(lum(renderedFg), lum(bg)) + .05);
      const size = Number.parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number.parseInt(cs.fontWeight) >= 700);
      const required = large ? 4.5 : 7;
      if (ratio < required) candidates.push({ selector: selector(el), text: el.textContent.trim().slice(0, 80), foreground: getComputedStyle(el).color, background: `rgba(${bg.map((v, i) => i < 3 ? Math.round(v) : Number(v.toFixed(3))).join(', ')})`, ratio: Number(ratio.toFixed(3)), required, disabled: Boolean(el.closest(':disabled, [aria-disabled="true"]')), fontSize: cs.fontSize, fontWeight: cs.fontWeight });
    }
    return candidates;
  });
  return candidates.filter(isEnhancedContrastFailure).map(({ disabled, ...failure }) => failure);
}

async function verifyAccessibility(browser, viewport, colorScheme) {
  // On the phone layout a selected file takes the whole screen (its preview), so measure the folder list there.
  const { context, page } = await openPage(browser, { viewport, colorScheme, state: viewport.width <= 700 ? directState() : appState() });
  const failures = [];
  await page.locator('.fp-scroll:visible').waitFor({ state: 'visible' });
  await page.addScriptTag({ path: axePath });
  // Hard failures: the WCAG 2.0, 2.1 and 2.2 A and AA rules. Advisory: the AAA and best-practice rules, which the product does not claim.
  const runRules = (tags) => page.evaluate(async (values) => window.axe.run(document, { runOnly: { type: 'tag', values } }), tags);
  const axe = await runRules(AXE_TAGS);
  const advisoryAxe = await runRules(['wcag2aaa', 'wcag21aaa', 'wcag22aaa', 'best-practice']);
  const advisory = advisoryAxe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`);
  const serious = axe.violations;
  const targetSizeDiagnostics = await page.evaluate((selectors) => selectors.map((selector) => {
    let elements = [];
    try { elements = [...document.querySelectorAll(selector)].slice(0, 10); } catch { /* preserve diagnostic run for nonstandard selectors */ }
    return { selector, matches: elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const points = [
        ['center', .5, .5], ['top-left', .08, .08], ['top', .5, .08], ['top-right', .92, .08],
        ['right', .92, .5], ['bottom-right', .92, .92], ['bottom', .5, .92], ['bottom-left', .08, .92], ['left', .08, .5],
      ];
      const label = (node) => node ? {
        tag: node.tagName.toLowerCase(),
        class: typeof node.className === 'string' ? node.className : '',
        label: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent?.trim().slice(0, 60) || '',
      } : null;
      return {
        element: label(element),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        style: { pointerEvents: style.pointerEvents, zIndex: style.zIndex, position: style.position, visibility: style.visibility, display: style.display },
        hits: points.map(([point, fx, fy]) => {
          const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width * fx));
          const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height * fy));
          return { point, x, y, topmost: label(document.elementFromPoint(x, y)) };
        }),
      };
    }) };
  }), serious.filter((v) => v.id === 'target-size').flatMap((v) => v.nodes.flatMap((n) => n.target)));
  let targetSizeIndex = 0;
  const axeDiagnostics = serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({
    target: n.target,
    summary: n.failureSummary,
    ...(v.id === 'target-size' ? { targetSizeDiagnostics: n.target.map(() => targetSizeDiagnostics[targetSizeIndex++]) } : {}),
  })) }));
  for (const violation of axeDiagnostics) {
    const known = knownAxe.find((k) => k.id === violation.id && k.width === viewport.width && violation.nodes.every((n) => n.target.every((t) => t.includes(k.target))));
    if (known) knownDefects.push(`${known.label} at ${viewport.width}px ${colorScheme}`);
    else failures.push({ kind: 'axe', ...violation });
  }
  const targets = await page.locator('button:visible, a[href]:visible, input:visible, select:visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    let width = r.width, height = r.height;
    if (e instanceof HTMLInputElement && ['checkbox', 'radio'].includes(e.type)) {
      const label = e.labels?.[0];
      if (label) { const lr = label.getBoundingClientRect(); width = Math.max(width, lr.width); height = Math.max(height, lr.height); }
    }
    return { selector: e.id ? `#${CSS.escape(e.id)}` : `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`, label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 45) || e.tagName, width: Math.round(width), height: Math.round(height) };
  }).filter((x) => x.width < 44 || x.height < 44));
  if (targets.length) advisory.push(`44px targets (2.5.5, AAA): ${targets.length} below 44 CSS px: ${targets.map((t) => `${t.label.slice(0, 24)} ${t.width}x${t.height}`).join('; ')}`);
  const contrast = await checkContrast(page);
  for (const violation of axeDiagnostics) for (const node of violation.nodes) {
    node.computedContrast = node.target.flatMap((target) => {
      const matching = contrast.find((entry) => target.includes(entry.selector) || entry.selector.includes(target));
      return matching ? [{ target, foreground: matching.foreground, background: matching.background, ratio: matching.ratio, required: matching.required }] : [];
    });
  }
  // Visually hidden controls (screen reader only) are clipped on purpose; a control inside a scroll container that can scroll is reachable.
  const clippingControls = page.locator('button:visible, a[href]:visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible');
  const clipped = [];
  for (let i = 0; i < await clippingControls.count(); i++) {
    const control = clippingControls.nth(i);
    await control.scrollIntoViewIfNeeded();
    clipped.push(...await control.evaluate((e) => {
    if (e.closest('.sr-only, .visually-hidden')) return []; // visually hidden on purpose
    const r = e.getBoundingClientRect();
    const bad = [];
    const scrollports = [];
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      const clipsX = ['hidden', 'clip'].includes(s.overflowX);
      const clipsY = ['hidden', 'clip'].includes(s.overflowY);
      const axes = [];
      if (['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + 1) axes.push('x');
      if (['auto', 'scroll'].includes(s.overflowY) && p.scrollHeight > p.clientHeight + 1) axes.push('y');
      if (axes.length) scrollports.push({ ancestor: p.className?.toString?.() || p.tagName, axes, scrollLeft: p.scrollLeft, scrollTop: p.scrollTop, maxScrollLeft: p.scrollWidth - p.clientWidth, maxScrollTop: p.scrollHeight - p.clientHeight });
      if (!clipsX && !clipsY) continue;
      const pr = p.getBoundingClientRect();
      if (clipsX && (r.left < pr.left - 1 || r.right > pr.right + 1) || clipsY && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1)) {
        bad.push({ selector: e.id ? `#${CSS.escape(e.id)}` : `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`, label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 40), bounds: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }, ancestor: p.className?.toString?.() || p.tagName, overflow: { x: s.overflowX, y: s.overflowY }, ancestorBounds: { left: Math.round(pr.left), top: Math.round(pr.top), right: Math.round(pr.right), bottom: Math.round(pr.bottom) }, reachableScrollports: scrollports });
        break;
      }
    }
    return bad;
    }));
  }
  const lostToClipping = clipped.filter((c) => !c.reachableScrollports.length);
  if (lostToClipping.length) failures.push({ kind: 'clipped-interactive-targets', targets: lostToClipping });
  if (contrast.length) advisory.push(`7:1 text contrast (1.4.6, AAA): ${contrast.length} below 7:1`);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const e = document.activeElement;
    if (!(e instanceof HTMLElement)) return null;
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return { tag: e.tagName, label: e.getAttribute('aria-label'), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow, opacity: s.opacity, disabled: e.matches(':disabled'),
      inViewport: r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      centerUnobscured: !!hit && (hit === e || e.contains(hit)) };
  });
  if (!focus || !(focus.outlineStyle !== 'none' && focus.outlineWidth !== '0px' || focus.boxShadow !== 'none')) failures.push({ kind: 'focus-indicator', focus });
  if (!focus?.inViewport || !focus?.centerUnobscured) failures.push({ kind: 'focus-position', focus });
  if (focus && !focus.disabled && Number(focus.opacity) < 0.5) failures.push({ kind: 'focus-opacity', focus });
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
  assert.ok(await page.locator('.fp-scroll:visible').count(), 'file content should remain available with WCAG text-spacing overrides');
  const spacingControls = page.locator('button:visible, a[href]:visible, [role="button"]:visible, [role="tab"]:visible');
  const spacingClips = [];
  for (let i = 0; i < await spacingControls.count(); i++) {
    const control = spacingControls.nth(i);
    await control.scrollIntoViewIfNeeded();
    spacingClips.push(...await control.evaluate((e) => {
    if (e.closest('.sr-only, .visually-hidden')) return []; // visually hidden on purpose
    const r = e.getBoundingClientRect();
    const scrollports = [];
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p), pr = p.getBoundingClientRect();
      const axes = [];
      if (['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + 1) axes.push('x');
      if (['auto', 'scroll'].includes(s.overflowY) && p.scrollHeight > p.clientHeight + 1) axes.push('y');
      if (axes.length) scrollports.push({ ancestor: p.className?.toString?.() || p.tagName, axes, scrollLeft: p.scrollLeft, scrollTop: p.scrollTop, maxScrollLeft: p.scrollWidth - p.clientWidth, maxScrollTop: p.scrollHeight - p.clientHeight });
      const outsideX = ['hidden', 'clip'].includes(s.overflowX) && (r.left < pr.left - 1 || r.right > pr.right + 1);
      const outsideY = ['hidden', 'clip'].includes(s.overflowY) && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1);
      if (outsideX || outsideY) return [{ label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 40), ancestor: p.className?.toString?.() || p.tagName, overflow: { x: s.overflowX, y: s.overflowY }, outside: { x: outsideX, y: outsideY }, reachableScrollports: scrollports }];
    }
    return [];
    }));
  }
  const lostToSpacing = spacingClips.filter((c) => !c.reachableScrollports.length);
  if (lostToSpacing.length) failures.push({ kind: 'text-spacing-clipping', targets: lostToSpacing });
  const width = viewport.width;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) failures.push({ kind: 'document-overflow', emulation: '100%', overflow });
  // CSS zoom emulates layout pressure, not browser zoom. 400% is meaningful at desktop CSS widths >=1280px.
  const viewportMetrics = await page.evaluate(() => ({ innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, mediaWidth: matchMedia('(max-width: 320px)').matches }));
  await page.screenshot({ path: resolve(evidenceDir, `${viewport.width}-${colorScheme}.png`), fullPage: true });
  await context.close();
  const report = { viewport, colorScheme, axe: axeDiagnostics, undersizedTargets: targets, clippedInteractiveTargets: clipped, contrastFailures: contrast, focus, textSpacingClipping: spacingClips, viewportMetrics, failures };
  const reportPath = resolve(evidenceDir, `${viewport.width}-${colorScheme}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  if (advisory.length) console.log(`advisory ${viewport.width}px ${colorScheme}: ${advisory.join(' | ')}`);
  console.log(`      ${viewport.width}px ${colorScheme}: axe ${axeDiagnostics.length} findings, clipped ${lostToClipping.length}, text spacing ${lostToSpacing.length}, overflow ${overflow}px, report ${reportPath}`);
  assert.deepEqual(failures, [], `accessibility measurements at ${viewport.width}px ${colorScheme}`);
}

// ---- Checks that guard the accessibility and keyboard work of the review programme -------------------------------------

const fileGrid = (page) => page.getByRole('grid', { name: /Files in/ }).first();
const listIsFocused = (page) => page.evaluate(() => !!document.activeElement?.matches('.fp-scroll'));
const describeFocus = (page) => page.evaluate(() => {
  const e = document.activeElement;
  return e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : ''}${e.getAttribute('aria-label') ? ` "${e.getAttribute('aria-label')}"` : ''}` : 'nothing';
});
async function expectListFocus(page, why) {
  try {
    await page.waitForFunction(() => !!document.activeElement?.matches('.fp-scroll'), null, { timeout: 3000 });
  } catch {
    assert.fail(`${why}: focus should be on the file list but is on ${await describeFocus(page)}`);
  }
}

// The list exposes the current and the selected item, and each row's name says whether it is a file or a folder.
async function verifyListSemantics(browser) {
  const { context, page } = await openPage(browser);
  try {
    const grid = fileGrid(page);
    assert.equal(await grid.getAttribute('aria-multiselectable'), 'true', 'the file list is a multi-select grid');
    assert.equal(await page.locator('[data-path="/work/tracked.txt"]').getAttribute('aria-selected'), 'true', 'the selected row has aria-selected=true');
    assert.equal(await page.locator('[data-path="/work/readme.md"]').getAttribute('aria-selected'), 'false', 'an unselected row has aria-selected=false');
    await page.getByRole('row', { name: /^File, tracked\.txt/ }).waitFor({ state: 'visible' });
    await page.getByRole('row', { name: /^Folder, subdir/ }).waitFor({ state: 'visible' });
    await grid.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.fp-scroll')?.getAttribute('aria-activedescendant'));
    const current = await grid.evaluate((g) => {
      const row = document.getElementById(g.getAttribute('aria-activedescendant'));
      return row ? { path: row.getAttribute('data-path'), selected: row.getAttribute('aria-selected') } : null;
    });
    assert.deepEqual(current, { path: '/work/subdir', selected: 'true' }, 'aria-activedescendant names the current row, which is selected');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.getElementById(document.querySelector('.fp-scroll').getAttribute('aria-activedescendant'))?.getAttribute('data-path') === '/work/package.zip');
    assert.equal(await page.locator('[data-path="/work/subdir"]').getAttribute('aria-selected'), 'false', 'moving the cursor moves the selection');
  } finally {
    await context.close();
  }
}

// After a menu, a rename or a create the list has focus, not the page body.
async function verifyFocusReturnsToList(browser) {
  const { context, page } = await openPage(browser);
  try {
    const grid = fileGrid(page);
    await page.locator('[data-path="/work/tracked.txt"]').click();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menu').last().waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await expectListFocus(page, 'after Shift+F10 then Escape');

    await page.keyboard.press('F2');
    const name = page.getByRole('textbox', { name: 'New name for tracked.txt' });
    await name.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await name.waitFor({ state: 'detached' });
    await expectListFocus(page, 'after cancelling a rename');

    await page.keyboard.press('F2');
    await name.waitFor({ state: 'visible' });
    await name.fill('renamed.txt');
    const renamed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/fs/rename'));
    await page.keyboard.press('Enter');
    await renamed;
    await name.waitFor({ state: 'detached' });
    await expectListFocus(page, 'after a rename');

    await grid.focus();
    await page.keyboard.press('F7');
    const folder = page.getByRole('textbox', { name: 'Name of the new folder' });
    await folder.waitFor({ state: 'visible' });
    await folder.fill('newdir');
    const made = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/fs/mkdir'));
    await page.keyboard.press('Enter');
    await made;
    await folder.waitFor({ state: 'detached' });
    await expectListFocus(page, 'after creating a folder');

    // A menu opened from a toolbar button gives focus back to that button on Escape.
    const more = page.getByRole('button', { name: 'New', exact: true });
    await more.click();
    await page.getByRole('menu').last().waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'New', null, { timeout: 3000 }).catch(async () => assert.fail(`Escape from the New menu should return focus to the New button but it is on ${await describeFocus(page)}`));
  } finally {
    await context.close();
  }
}

// At 1366x768 the row context menu is taller than the window: it must scroll so that every item can be reached.
async function verifyContextMenuScrolls(browser) {
  const { context, page } = await openPage(browser, { viewport: { width: 1366, height: 768 } });
  try {
    await page.locator('[data-path="/work/tracked.txt"]').click({ button: 'right' });
    const menu = page.getByRole('menu').last();
    await menu.waitFor({ state: 'visible' });
    const inside = () => page.evaluate(() => {
      const m = [...document.querySelectorAll('[role="menu"]')].at(-1);
      const e = document.activeElement;
      const mr = m.getBoundingClientRect();
      const r = e.getBoundingClientRect();
      return { menuInWindow: mr.top >= 0 && mr.bottom <= innerHeight + 1 && mr.left >= 0 && mr.right <= innerWidth + 1, itemInMenu: m.contains(e) && r.top >= mr.top - 1 && r.bottom <= mr.bottom + 1 && r.height > 0, label: e.textContent.trim().slice(0, 30) };
    });
    const total = await menu.locator('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])').count();
    assert.ok(total >= 8, `the row menu should have many enabled items (found ${total})`);
    const scrolls = await menu.evaluate((m) => m.scrollHeight > m.clientHeight + 1);
    const bad = [];
    for (let i = 0; i < total + 1; i++) {
      const s = await inside();
      if (!s.menuInWindow || !s.itemInMenu) bad.push({ step: i, ...s });
      await page.keyboard.press('ArrowDown');
    }
    assert.deepEqual(bad, [], `every enabled item of the row menu is reachable at 1366x768 (the menu ${scrolls ? 'scrolls' : 'does not need to scroll'})`);
    // A submenu opens inside the window too.
    await page.keyboard.press('Home');
    const sub = menu.locator('[role="menuitem"][aria-haspopup="menu"]:not([disabled])').first();
    if (await sub.count()) {
      await sub.focus();
      await page.keyboard.press('ArrowRight');
      const submenu = page.getByRole('menu').last();
      await submenu.waitFor({ state: 'visible' });
      const box = await submenu.boundingBox();
      const win = page.viewportSize();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= win.width + 1 && box.y + box.height <= win.height + 1, `the submenu is placed inside the window (${JSON.stringify(box)})`);
    }
  } finally {
    await context.close();
  }
}

// Tab follows the page order from one panel to the next, and Alt+PageDown / Alt+PageUp switch panels.
async function verifyPanelTabOrder(browser) {
  const leaf = (id) => ({ i: id, n: nodeName, p: '/work' });
  for (const ids of [['p1', 'p2'], ['p1', 'p2', 'p3']]) {
    const { context, page } = await openPage(browser, { state: stateOf({ i: 'p4', d: 'h', k: ids.map(leaf) }) });
    try {
      assert.equal(await page.locator('.fp').count(), ids.length, `${ids.length} panels are open`);
      for (let i = 0; i < ids.length - 1; i++) {
        const lastTabbable = await page.evaluate((panel) => {
          const root = document.querySelector(`.fp[data-fp="${panel}"]`);
          const t = [...root.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
          t.at(-1).focus();
          return t.length;
        }, ids[i]);
        assert.ok(lastTabbable > 3, `${ids[i]} has controls to tab through`);
        await page.keyboard.press('Tab');
        // The resize handle between two panels is a Tab stop of its own (it resizes with the arrow keys): one more Tab leaves it.
        if (await page.evaluate(() => document.activeElement?.getAttribute('role') === 'separator' && !document.activeElement.closest('.fp'))) await page.keyboard.press('Tab');
        const landed = await page.evaluate(() => { const e = document.activeElement; return { panel: e.closest('.fp')?.getAttribute('data-fp') ?? null, inBar: !!e.closest('.fp-bar'), label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30) }; });
        assert.deepEqual({ panel: landed.panel, inBar: landed.inBar }, { panel: ids[i + 1], inBar: true }, `Tab from the last control of ${ids[i]} reaches the toolbar of ${ids[i + 1]} (landed on ${JSON.stringify(landed)})`);
      }
      // Alt+PageDown / Alt+PageUp move between the panels' lists.
      await page.locator(`.fp[data-fp="p1"] .fp-scroll`).focus();
      await page.keyboard.press('Alt+PageDown');
      await page.waitForFunction(() => document.activeElement?.closest('.fp')?.getAttribute('data-fp') === 'p2' && document.activeElement.matches('.fp-scroll'));
      await page.keyboard.press('Alt+PageUp');
      await page.waitForFunction(() => document.activeElement?.closest('.fp')?.getAttribute('data-fp') === 'p1' && document.activeElement.matches('.fp-scroll'));
    } finally {
      await context.close();
    }
  }
}

// The Trash view is a grid that the keyboard drives: one item can be selected and the selection moves with the arrows.
async function verifyTrashKeyboard(browser) {
  const { context, page } = await openPage(browser, { state: directState({ r: [nodeName, ''] }) });
  try {
    const grid = page.getByRole('grid', { name: 'Trashed items' });
    await grid.waitFor({ state: 'visible' });
    const selected = () => page.locator('[aria-label="Trashed items"] tr[aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id')));
    assert.deepEqual(await selected(), [], 'nothing is selected when the view opens');
    await page.locator('[aria-label="Trashed items"] tr[tabindex="0"]').focus();
    await page.keyboard.press('Space');
    assert.equal((await selected()).length, 1, 'Space selects exactly one trashed item');
    const first = (await selected())[0];
    await page.keyboard.press('ArrowDown');
    const moved = await selected();
    assert.equal(moved.length, 1, 'ArrowDown keeps a single selection');
    assert.notEqual(moved[0], first, 'ArrowDown moves the selection to the next item');
    await page.keyboard.press('End');
    assert.deepEqual(await selected(), ['trash-3'].filter((id) => id), 'End selects the last item (oldest first by deletion date)');
  } finally {
    await context.close();
  }
}

const relativeLuminance = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrastOf = (a, b) => { const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// Theme tokens as the browser computes them, in both themes: boundaries, the focus ring and the selection mark reach 3:1 on
// every surface, muted text reaches 7:1, the focus indicator is one 2px ring in a single colour, and a selected row carries a mark
// that does not depend on hue (a bar on its leading edge) besides aria-selected.
async function verifyThemeTokens(browser) {
  const failures = [];
  for (const scheme of ['light', 'dark']) {
    const { context, page } = await openPage(browser, { colorScheme: scheme });
    try {
      const t = await page.evaluate(() => {
        const probe = document.createElement('div');
        document.body.append(probe);
        const out = {};
        for (const k of ['--surface', '--surface-2', '--surface-3', '--muted', '--a11y-control-boundary', '--focus-ring', '--sel-mark']) {
          probe.style.color = `var(${k})`;
          out[k] = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
        }
        probe.remove();
        return out;
      });
      for (const surface of ['--surface', '--surface-2', '--surface-3']) {
        for (const [token, min] of [['--a11y-control-boundary', 3], ['--focus-ring', 3], ['--sel-mark', 3], ['--muted', 7]]) {
          const ratio = contrastOf(t[token], t[surface]);
          if (ratio < min) failures.push(`${scheme}: ${token} on ${surface} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
        }
      }
      const row = await page.locator('[data-path="/work/tracked.txt"]').evaluate((r) => ({ selected: r.getAttribute('aria-selected'), bar: getComputedStyle(r.querySelector('td')).boxShadow }));
      if (row.selected !== 'true' || !/inset/.test(row.bar)) failures.push(`${scheme}: the selected row has aria-selected=${row.selected} and leading-edge mark "${row.bar}"`);
      await page.getByRole('button', { name: 'Refresh' }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow }; });
      // Either a 2px solid outline, or (toolbar buttons) an inset 2px ring in the same colour: one colour, no halo.
      const ringColour = `rgb(${t['--focus-ring'].join(', ')})`;
      const outline = ring.outlineStyle === 'solid' && ring.outlineWidth === '2px' && ring.boxShadow === 'none';
      const inset = ring.outlineStyle === 'none' && ring.boxShadow === `${ringColour} 0px 0px 0px 2px inset`;
      if (!outline && !inset) failures.push(`${scheme}: the focus indicator is not a single 2px ring in the focus colour: ${JSON.stringify(ring)}`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'theme tokens, selection mark and focus indicator');
}

// WCAG 2.0, 2.1 and 2.2 A and AA rules, run by axe-core over the whole document in every state listed.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function runAxe(page, label, failures) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), AXE_TAGS);
  for (const v of result.violations) failures.push({ view: label, rule: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) });
  return result.passes.length;
}

async function verifyAxeViews(browser) {
  const failures = [];
  const split = { i: 'p3', d: 'v', k: [{ i: 'p1', n: nodeName, p: '/work' }, { i: 'p2', n: nodeName, p: '/work' }] };
  const views = [
    ['main view', {}, async () => {}],
    ['context menu', {}, async (page) => { await page.locator('[data-path="/work/tracked.txt"]').click({ button: 'right' }); await page.getByRole('menu').last().waitFor({ state: 'visible' }); }],
    ['dialog', {}, async (page) => { await page.getByRole('button', { name: 'Keyboard shortcuts' }).click(); await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ state: 'visible' }); }],
    ['Settings', { state: directState({ se: 1 }) }, async (page) => { await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' }); }],
    ['Trash', { state: directState({ r: [nodeName, ''] }) }, async (page) => { await page.getByRole('grid', { name: 'Trashed items' }).waitFor({ state: 'visible' }); }],
    ['Compare', { state: stateOf(split, { g: { l: [nodeName, '/work'], r: [nodeName, '/work'], a: 'p1', b: 'p2' } }) }, async (page) => { await page.getByText('only-left.txt').first().waitFor({ state: 'visible', timeout: 10000 }); }],
    ['Markdown preview', { state: `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', s: '/work/readme.md', v: ['right', 40] }, a: 'p1' }))}` }, async (page) => { await page.getByRole('heading', { name: 'Fixture heading' }).waitFor({ state: 'visible', timeout: 10000 }); }],
    ['phone layout', { viewport: { width: 390, height: 844 }, state: directState() }, async () => {}],
  ];
  for (const scheme of ['light', 'dark']) {
    for (const [name, opts, prepare] of views) {
      const { context, page } = await openPage(browser, { colorScheme: scheme, ...opts });
      try {
        await prepare(page);
        await page.waitForTimeout(150);
        await runAxe(page, `${name} (${scheme})`, failures);
      } finally {
        await context.close();
      }
    }
  }
  assert.deepEqual(failures, [], `axe-core reports no ${AXE_TAGS.join(', ')} violations in ${views.length} views x 2 colour schemes`);
}

// No horizontal scrolling of the document at any supported window size; the phone layout in a short window still lists files.
async function verifyNoHorizontalOverflow(browser) {
  const sizes = [[1440, 900], [1024, 768], [768, 1024], [390, 844], [320, 568], [844, 390], [320, 256]];
  const failures = [];
  for (const [width, height] of sizes) {
    for (const [name, state] of [['folder list', directState()], ['properties', appState()]]) {
      const { context, page } = await openPage(browser, { viewport: { width, height }, state });
      try {
        await page.waitForTimeout(150);
        const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
        if (o.scroll > o.client + 1 || o.body > o.client + 1) failures.push({ width, height, name, ...o });
      } finally {
        await context.close();
      }
    }
  }
  assert.deepEqual(failures, [], 'the document never scrolls horizontally');
}

async function verifyShortWindowRows(browser) {
  const { context, page } = await openPage(browser, { viewport: { width: 844, height: 390 }, state: `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/big' }, a: 'p1' }))}` });
  try {
    await page.locator('.fp-scroll [data-path]').first().waitFor({ state: 'visible' });
    const rows = await page.evaluate(() => {
      const list = document.querySelector('.fp-scroll').getBoundingClientRect();
      const head = document.querySelector('.fp-scroll thead')?.getBoundingClientRect();
      const top = Math.max(list.top, head ? head.bottom : 0, 0);
      const bottom = Math.min(list.bottom, innerHeight);
      return [...document.querySelectorAll('.fp-scroll [data-path]')].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= top - 1 && b.bottom <= bottom + 1; }).length;
    });
    assert.ok(rows >= 5, `at 844x390 at least five rows are fully visible (found ${rows})`);
  } finally {
    await context.close();
  }
}

// A 20,000-entry listing renders only the rows near the viewport, and End and Home reach its ends.
async function verifyLargeListing(browser) {
  const { context, page } = await openPage(browser, { state: `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/big' }, a: 'p1' }))}` });
  try {
    const grid = fileGrid(page);
    await page.locator('.fp-scroll [data-path]').first().waitFor({ state: 'visible' });
    const rendered = () => page.locator('.fp-scroll [data-path]').count();
    assert.ok(await rendered() < 400, `the DOM stays small for 20,000 entries (${await rendered()} rows rendered)`);
    assert.equal(await grid.getAttribute('aria-rowcount'), '20001', 'the grid reports the full row count');
    await grid.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.getElementById(document.querySelector('.fp-scroll').getAttribute('aria-activedescendant'))?.getAttribute('data-path') === '/big/file-19999.txt');
    assert.ok(await page.locator('[data-path="/big/file-19999.txt"]').isVisible(), 'End scrolls the last entry into view');
    assert.ok(await rendered() < 400, `the DOM stays small after End (${await rendered()} rows rendered)`);
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.getElementById(document.querySelector('.fp-scroll').getAttribute('aria-activedescendant'))?.getAttribute('data-path') === '/big/file-00000.txt');
    assert.ok(await page.locator('[data-path="/big/file-00000.txt"]').isVisible(), 'Home scrolls the first entry into view');
  } finally {
    await context.close();
  }
}

// Text typed in the editor survives the editor being rebuilt when the window crosses the panel-width threshold.
async function verifyUnsavedTextSurvivesResize(browser) {
  const state = `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', e: [nodeName, '/work/tracked.txt'] }, a: 'p1' }))}`;
  const { context, page } = await openPage(browser, { state });
  try {
    const editor = page.getByRole('dialog', { name: 'Editing tracked.txt' });
    await editor.locator('.monaco-editor .view-lines').waitFor({ state: 'visible', timeout: 20000 });
    // The editor appears before the file text arrives; typing earlier would be overwritten by the load.
    await page.waitForFunction(() => /saved\s*text/.test(document.querySelector('.monaco-editor .view-lines')?.textContent ?? ''), null, { timeout: 20000 });
    await editor.locator('.monaco-editor .view-lines').click();
    await page.keyboard.type('TYPED-BEFORE-RESIZE');
    await editor.getByRole('img', { name: 'Unsaved changes' }).first().waitFor({ state: 'visible' });
    const text = () => page.getByRole('dialog', { name: 'Editing tracked.txt' }).locator('.monaco-editor .view-lines').innerText();
    await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('TYPED-BEFORE-RESIZE'), null, { timeout: 8000 }).catch(() => {});
    assert.match(await text(), /TYPED-BEFORE-RESIZE/, 'the typed text is in the editor');
    for (const width of [640, 1365, 390, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      // Let the editor be rebuilt (if the layout needs it) and reload its text before looking, so that the old view is not mistaken for the new one.
      await page.waitForTimeout(1500);
      await page.getByRole('dialog', { name: 'Editing tracked.txt' }).locator('.monaco-editor .view-lines').waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('TYPED-BEFORE-RESIZE'), null, { timeout: 8000 }).catch(() => {});
      assert.match(await text(), /TYPED-BEFORE-RESIZE/, `the typed text is still there after resizing to ${width}px`);
    }
  } finally {
    await context.close();
  }
}

// ---- Runner ---------------------------------------------------------------------------------------------------------

const checks = [
  ['list semantics', verifyListSemantics],
  ['keyboard shortcuts dialog and confirmations', verifyKeyboardAndConfirmation],
  ['keyboard isolation', verifyKeyboardIsolation],
  ['focus returns to the list', verifyFocusReturnsToList],
  ['context menu, tooltip', verifyMenusAndTooltips],
  ['context menu scrolls at 1366x768', verifyContextMenuScrolls],
  ['panel tab order and Alt+PageDown', verifyPanelTabOrder],
  ['Trash keyboard selection', verifyTrashKeyboard],
  ['Properties tabs', verifyProperties],
  ['Properties tab keys', verifyPropsTabKeySequence],
  ['no Git tab outside a repository', verifyOutsideGit],
  ['Git worktrees', verifyGitWorktrees],
  ['pull request diff section', verifyPrDiffSection],
  ['history and direct links', verifyHistoryAndDirectLinks],
  ['folder history', verifyFolderHistory],
  ['archive and sync routes', verifyNestedViews],
  ['presentation settings', verifyPresentation],
  ['copy and move to another node, vault renewal', verifyOperations],
  ['large listing', verifyLargeListing],
  ['unsaved editor text survives a resize', verifyUnsavedTextSurvivesResize],
  ['no horizontal overflow', verifyNoHorizontalOverflow],
  ['rows visible in a short window', verifyShortWindowRows],
  ['theme tokens, selection mark, focus indicator', verifyThemeTokens],
  ['axe-core A and AA in every view', verifyAxeViews],
  ...['light', 'dark'].flatMap((scheme) => [[1365, 900], [390, 844], [320, 760]].map(([width, height]) => [`measurements ${width}px ${scheme}`, (b) => verifyAccessibility(b, { width, height }, scheme)])),
];

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const started = Date.now();
const failed = [];
const results = [];
try {
  for (const [name, run] of checks) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    currentCheck = name.replace(/\W+/g, '-');
    pendingShots = [];
    const t0 = Date.now();
    results.push(name);
    try {
      await run(browser);
      console.log(`ok    ${name} (${Date.now() - t0} ms)`);
    } catch (error) {
      failed.push(name);
      console.log(`FAIL  ${name} (${Date.now() - t0} ms)`);
      console.log(String(error?.message ?? error).split('\n').slice(0, 40).join('\n').replace(/^/gm, '      '));
      for (const [i, s] of pendingShots.entries()) await writeFile(resolve(evidenceDir, `fail-${currentCheck}-${i + 1}.png`), s).catch(() => {});
    }
  }
} finally {
  await browser.close();
}
const ran = results.length;
if (knownDefects.length) console.log(`Known defects still present (${new Set(knownDefects).size}):\n${[...new Set(knownDefects)].map((d) => `  - ${d}`).join('\n')}`);
console.log(`${ran - failed.length}/${ran} checks passed in ${Math.round((Date.now() - started) / 1000)} s`);
if (failed.length) {
  console.error(`Failed: ${failed.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('Filedeck acceptance passed with deterministic fake API fixtures.');
}
