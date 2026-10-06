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
const scope = process.env.FILEDECK_SCOPE || 't79';
const evidenceDir = resolve(process.env.FILEDECK_EVIDENCE_DIR || './evidence');
await mkdir(evidenceDir, { recursive: true });
const originalMode = 0o644;
const changedMode = 0o600;
const permCalls = [];
const opCalls = [];
const worktreeRequests = [];
const vaultEntryId = 'fixture-vault-entry';
let vaultExpiry = Date.now() + 30_000;
let vaultListCalls = 0;
let fakeMode = originalMode;

const entry = (path, mode = originalMode) => ({
  name: path.split('/').at(-1), path, type: 'file', size: 128,
  mtime: 1791264000000, mode,
});
const gitInfo = (path) => path.startsWith('/work/') ? {
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

async function installFixture(page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/nodes') return json({ nodes: [{ name: nodeName, online: true }, ...(['operations', 't79'].includes(scope) ? [{ name: 'fixture-dest', online: true }] : [])] });
    if (pathname === `/api/nodes/${encodeURIComponent(nodeName)}/api/mounts`) return json({ mounts: [] });
    if (pathname === '/api/vault') {
      if (!['operations', 't79'].includes(scope)) return json({ entries: [], persistent: false, ttlSeconds: 3600, maxHours: 24 });
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
      const rows = path === '/work'
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
    if (pathname.endsWith('/api/git/info')) return json(gitInfo(url.searchParams.get('path') || '/'));
    if (pathname.endsWith('/api/git/status')) return json({ repo: null, entries: {}, children: {}, pending: false });
    if (pathname.endsWith('/api/git/worktrees')) {
      worktreeRequests.push(url.searchParams.get('path') || '/');
      if (scope === 't75-worktrees') return json({ repo: '/work', bare: false, truncated: false, worktrees: [
        { path: '/work', gitPath: '/host/work', name: 'main', main: true, bare: false, branch: 'main', detached: false, head: '01234567', locked: false, prunable: false, dirty: false, current: true },
        { path: '/work-feature', gitPath: '/host/work-feature', name: 'feature-checkout', main: false, bare: false, branch: 'feature', detached: false, head: '89abcdef', locked: false, prunable: false, dirty: true, current: false },
        { path: '/work-release', gitPath: '/host/work-release', name: 'release-checkout', main: false, bare: false, branch: 'release/next', detached: false, head: 'fedcba98', locked: false, prunable: false, dirty: false, current: false },
      ] });
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
    if (pathname.endsWith('/api/trash/list')) return json({ volumes: [] });
    if (pathname.endsWith('/api/archive/list')) return json({ entries: [{ name: 'inside.txt', type: 'file', size: 128, date: '2026-10-06' }], truncated: false, bytes: 128 });
    if (pathname.endsWith('/api/git/refs')) return json({ bare: false, refs: ['main'], prs: [{ n: 12, subject: 'Fixture pull request' }] });
    if (pathname.endsWith('/api/git/diff')) return json({
      base: { ref: 'main', sha: '0123456789abcdef0123456789abcdef01234567' },
      head: { ref: 'fixture/pr-12', sha: '89abcdef0123456789abcdef0123456789abcdef' },
      mergeBase: '0123456789abcdef0123456789abcdef01234567', files: [], truncated: false, pr: 12,
    });
    if (pathname.endsWith('/api/diff/jobs')) return json({ id: 'diff-fixture', state: 'done', result: { rows: [] } });
    if (pathname.endsWith('/api/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    if (pathname.endsWith('/api/fs/search')) return json({ results: [], truncated: false });
    return json({});
  });
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 });
}
async function openPage(browser, { viewport = { width: 1365, height: 900 }, colorScheme = 'light', state = appState() } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
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
  await installFixture(page);
  await page.goto(new URL(state, baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('group', { name: /Files in/ }).waitFor({ state: 'visible', timeout: 15000 });
  return { context, page, diagnostics };
}

async function verifyPrDirectLink(browser) {
  const state = directState({ pd: { n: nodeName, p: trackedDir, r: 12 } });
  const { context, page, diagnostics } = await openPage(browser, { state });
  try {
    await page.getByRole('dialog', { name: 'Pull request diff' }).waitFor({ state: 'visible', timeout: 8000 });
    const restored = JSON.parse(new URL(page.url()).searchParams.get('s') || 'null');
    assert.equal(restored?.pd?.r, 12, 'PR number should survive direct-link decoding');
  } catch (error) {
    let stateJSON = null;
    try { stateJSON = JSON.parse(new URL(page.url()).searchParams.get('s') || 'null'); } catch { /* retain null */ }
    console.error('PR direct-link diagnostic:', JSON.stringify({
      url: page.url(), stateJSON, body: await page.locator('body').innerText().catch(() => ''),
      diagnostics, gitRequests: await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.includes('/api/git/'))),
    }));
    throw error;
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
    await page.getByRole('group', { name: /Files in/ }).waitFor({ state: 'visible', timeout: 15000 });
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

async function verifyAccessibilityScope(browser) {
  await verifyMenusAndTooltips(browser);
  for (const scheme of ['light', 'dark']) {
    await verifyAccessibility(browser, { width: 1365, height: 900 }, scheme);
    await verifyAccessibility(browser, { width: 390, height: 844 }, scheme);
    await verifyAccessibility(browser, { width: 320, height: 760 }, scheme);
  }
}

async function verifyMeasurementsScope(browser) {
  const failures = [];
  for (const scheme of ['light', 'dark']) {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 760 }]) {
      try {
        await verifyAccessibility(browser, viewport, scheme);
      } catch (error) {
        failures.push({ viewport, scheme, message: error.message });
        console.error(`Measurement failure ${viewport.width}px ${scheme}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, [], 'accessibility measurement matrix should pass every viewport/theme');
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
      await dialog.getByLabel('Destination node').selectOption('fixture-dest');
      await dialog.getByRole('button', { name: 'destination', exact: true }).waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'destination', exact: true }).click();
      assert.equal(opCalls.length, before, `${kind} must not queue while choosing a destination`);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(opCalls.length, before, `cancelling ${kind} must not queue a job`);

      dialog = await openTransfer(kind);
      await dialog.getByLabel('Destination node').selectOption('fixture-dest');
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

  const vault = await openPage(browser, { state: directState({ se: 1 }) });
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

async function verifyGitWorktrees(browser) {
  const { context, page } = await openPage(browser);
  try {
    const gitTab = page.getByRole('tab', { name: 'Git', exact: true });
    await gitTab.waitFor({ state: 'visible' });
    await gitTab.click();
    const link = page.getByRole('button', { name: 'All worktrees', exact: true });
    await link.waitFor({ state: 'visible' });
    await link.click();
    await page.locator('.wt-list').waitFor({ state: 'visible' });
    for (const name of ['main', 'feature-checkout', 'release-checkout']) {
      await page.locator('.wt-name', { hasText: name }).waitFor({ state: 'visible' });
    }
    assert.ok(worktreeRequests.includes('/work'), 'the existing worktrees API must receive the repository context');
    assert.match(page.url(), /[?&]s=/, 'opening all worktrees must update URL state');
    const worktreesURL = page.url();
    await page.reload();
    await page.locator('.wt-name', { hasText: 'feature-checkout' }).waitFor({ state: 'visible' });
    assert.ok(worktreeRequests.length >= 2, 'reloading the worktrees route should reload the complete list');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    await page.goBack();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    assert.equal(page.url(), worktreesURL, 'Back should restore the worktrees route URL');
    await page.locator('.wt-name', { hasText: 'release-checkout' }).waitFor({ state: 'visible' });
    await page.goForward();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  } finally {
    await context.close();
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

  const pr = directState({ pd: { n: nodeName, p: trackedDir, r: 12 } });
  await page.goto(new URL(pr, baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Pull request diff' }).waitFor({ state: 'visible', timeout: 8000 });
  await context.close();
}

async function verifyFolderHistory(browser) {
  const tree = { i: 's1', d: 'v', k: [
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
    await page.keyboard.press('End');
    const selectedFolder = await decode();
    assert.equal(selectedPath(selectedFolder), '/work/subdir', 'End should select the final folder row');
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
  const archiveState = `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', s: '/work/package.zip', v: ['right', 40, 'p'] }, a: 'p1' }))}`;
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
    const split = { i: 's1', d: 'v', k: [
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
    if (scope !== 't76') {
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
    if (scope !== 't79') {
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
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ state: 'detached' });
  // Modal opener restoration is checked before history Back/Forward above, when
  // the original opener is still mounted. Route-remounted dialogs use a fresh node.
  if (scope !== 't79') {
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
  const fileList = page.getByRole('group', { name: /Files in/ });
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
  const tip = page.getByRole('tooltip').last();
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
  const { context, page } = await openPage(browser, { viewport, colorScheme });
  const failures = [];
  await page.locator('.fp-scroll:visible').waitFor({ state: 'visible' });
  await page.addScriptTag({ path: axePath });
  const axe = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa', 'wcag22aa', 'wcag22aaa', 'best-practice'] },
  }));
  const serious = axe.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
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
  for (const violation of axeDiagnostics) failures.push({ kind: 'axe', ...violation });
  const targets = await page.locator('button:visible, a[href]:visible, input:visible, select:visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    let width = r.width, height = r.height;
    if (e instanceof HTMLInputElement && ['checkbox', 'radio'].includes(e.type)) {
      const label = e.labels?.[0];
      if (label) { const lr = label.getBoundingClientRect(); width = Math.max(width, lr.width); height = Math.max(height, lr.height); }
    }
    return { selector: e.id ? `#${CSS.escape(e.id)}` : `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`, label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 45) || e.tagName, width: Math.round(width), height: Math.round(height) };
  }).filter((x) => x.width < 44 || x.height < 44));
  if (targets.length) failures.push({ kind: 'undersized-targets', targets });
  const contrast = await checkContrast(page);
  for (const violation of axeDiagnostics) for (const node of violation.nodes) {
    node.computedContrast = node.target.flatMap((target) => {
      const matching = contrast.find((entry) => target.includes(entry.selector) || entry.selector.includes(target));
      return matching ? [{ target, foreground: matching.foreground, background: matching.background, ratio: matching.ratio, required: matching.required }] : [];
    });
  }
  const clippingControls = page.locator('button:visible, a[href]:visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible');
  const clipped = [];
  for (let i = 0; i < await clippingControls.count(); i++) {
    const control = clippingControls.nth(i);
    await control.scrollIntoViewIfNeeded();
    clipped.push(...await control.evaluate((e) => {
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
  if (clipped.length) failures.push({ kind: 'clipped-interactive-targets', targets: clipped });
  if (contrast.length) failures.push({ kind: 'wcag-aaa-contrast', entries: contrast });
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
  if (spacingClips.length) failures.push({ kind: 'text-spacing-clipping', targets: spacingClips });
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
  console.log(JSON.stringify({ viewport, colorScheme, axe: axeDiagnostics.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.flatMap((n) => n.target), computedContrast: nodes.flatMap((n) => n.computedContrast) })), contrastFailures: contrast, undersizedTargets: targets.length, clippedInteractiveTargets: clipped, focus, textSpacingClipping: spacingClips, viewportMetrics, failureKinds: failures.map((f) => f.kind), reportPath }));
  assert.deepEqual(failures, [], `accessibility measurements at ${viewport.width}px ${colorScheme}`);
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  if (scope === 't79') {
    await verifyKeyboardAndConfirmation(browser);
    await verifyPresentation(browser);
    await verifyOperations(browser);
    await verifyMenusAndTooltips(browser);
    for (const scheme of ['light', 'dark']) {
      await verifyAccessibility(browser, { width: 1365, height: 900 }, scheme);
      await verifyAccessibility(browser, { width: 390, height: 844 }, scheme);
      await verifyAccessibility(browser, { width: 320, height: 760 }, scheme);
    }
  } else if (scope === 't75') {
    await verifyProperties(browser);
    await verifyOutsideGit(browser);
  } else if (scope === 't75-worktrees') {
    await verifyGitWorktrees(browser);
  } else if (scope === 'pr') {
    await verifyPrDirectLink(browser);
  } else if (scope === 'propskeys') {
    await verifyPropsTabKeySequence(browser);
  } else if (scope === 'presentation') {
    await verifyPresentation(browser);
  } else if (scope === 'a11y320light') {
    await verifyAccessibility(browser, { width: 320, height: 760 }, 'light');
  } else if (scope === 'a11y') {
    await verifyAccessibilityScope(browser);
  } else if (scope === 'measurements') {
    await verifyMeasurementsScope(browser);
  } else if (scope === 'operations') {
    await verifyOperations(browser);
  } else if (scope === 'routes') {
    await verifyHistoryAndDirectLinks(browser);
    await verifyNestedViews(browser);
  } else if (scope === 'folderhistory') {
    await verifyFolderHistory(browser);
  } else if (scope === 'keys') {
    await verifyKeyboardIsolation(browser);
  } else if (scope === 't76') {
    await verifyHistoryAndDirectLinks(browser);
    await verifyKeyboardAndConfirmation(browser);
  } else {
    await verifyProperties(browser);
    await verifyOutsideGit(browser);
    await verifyHistoryAndDirectLinks(browser);
    await verifyKeyboardAndConfirmation(browser);
    await verifyKeyboardIsolation(browser);
    await verifyPresentation(browser);
    await verifyNestedViews(browser);
    await verifyFolderHistory(browser);
    await verifyMenusAndTooltips(browser);
    for (const scheme of ['light', 'dark']) {
      await verifyAccessibility(browser, { width: 1365, height: 900 }, scheme);
      await verifyAccessibility(browser, { width: 390, height: 844 }, scheme);
      await verifyAccessibility(browser, { width: 320, height: 760 }, scheme);
    }
  }
  console.log('Filedeck acceptance passed with deterministic fake API fixtures.');
} finally {
  await browser.close();
}
