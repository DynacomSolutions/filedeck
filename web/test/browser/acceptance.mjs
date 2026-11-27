import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { isEnhancedContrastFailure } from './contrast.mjs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

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

/** The header of the gate's 503 for a Tailscale session while tailscaled does not answer. */
const TAILNET_DOWN = { 'x-filedeck-auth': 'tailnet-unavailable' };

// opts.vault: serve one saved password near expiry; opts.worktrees: serve a nested repository with worktrees;
// opts.signedOut: the hub has sign-in on and no session; opts.account: signed in as that name.
async function installFixture(page, opts = {}) {
  if (opts.vault) vaultExpiry = Date.now() + 30_000;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    // opts.requests: every API request the page makes, as path and query
    opts.requests?.push(pathname + url.search);
    // opts.tailnetDown: while set, every API request is the gate's tailnet 503 (a Tailscale session while tailscaled does not
    // answer; the session is kept), with its header
    if (opts.tailnetDown) return json({ error: 'tailnet identity unavailable' }, 503, TAILNET_DOWN);
    // opts.nodesBody / opts.lists: a check's own node list and folder listings (by path), answered before the shared fixtures
    if (opts.nodesBody && pathname === '/api/nodes') return json(opts.nodesBody);
    if (opts.lists?.[url.searchParams.get('path')] && pathname.includes('/api/fs/list')) return json({ path: url.searchParams.get('path'), entries: opts.lists[url.searchParams.get('path')], truncated: false });
    // Sign-in is off unless a check asks for a signed-out or signed-in hub. opts.session ({ out }) lets a check end the
    // session while the app is open: every API call is then the gate's 401 until a password sign-in starts a new one.
    if (opts.session) {
      if (pathname === '/api/auth/login' && req.method() === 'POST') {
        opts.session.out = false;
        return json({ auth: true, kind: 'virt', name: opts.account, admin: false });
      }
      if (opts.session.out) return json({ error: 'signed out' }, 401, { 'x-filedeck-auth': 'signed-out' });
    }
    // opts.kind / opts.admin: the signed-in account's kind and admin flag (default a virtual non-admin). opts.asRoot ({ until }):
    // the act-as-root switch; a POST with the password 'fixture-root-password' turns it on for 15 minutes, DELETE turns it off.
    if (opts.asRoot && pathname === '/api/auth/as-root') {
      if (req.method() === 'DELETE') {
        opts.asRoot.stopped = (opts.asRoot.stopped ?? 0) + 1;
        if (opts.asRoot.failStop) return json({ error: 'internal error' }, 500);
        opts.asRoot.until = undefined;
        return json({ ok: true });
      }
      const b = JSON.parse(req.postData() || '{}');
      opts.asRoot.bodies = [...(opts.asRoot.bodies ?? []), Object.keys(b).sort().join(',')];
      if (b.password !== 'fixture-root-password') return json({ error: 'sign-in failed' }, 401);
      const lasts = opts.asRoot.lasts ?? 15 * 60_000;
      opts.asRoot.until = Date.now() + lasts;
      return json({ asRootUntil: opts.asRoot.until, asRootLeftMs: lasts });
    }
    // opts.tailnet ({ body, status }): the hub's answer to GET /api/auth/tailnet (default `{}`: no tailnet identity).
    // opts.tailscale ({ posts, refuse, as }): POST /api/auth/login-tailscale is counted in `posts`; it answers 401 while `refuse`
    // is set, else signs in as `as` ({ account, kind, admin, subject }), so the next /api/auth/me reports a Tailscale session.
    // (opts.tailnet.delayMs: the answer comes that late; a 503 carries the gate's header)
    if (pathname === '/api/auth/tailnet') {
      if (opts.tailnet?.delayMs) await new Promise((r) => setTimeout(r, opts.tailnet.delayMs));
      const status = opts.tailnet?.status ?? 200;
      return json(opts.tailnet?.body ?? {}, status, status === 503 ? TAILNET_DOWN : {});
    }
    // opts.logouts: POST /api/auth/logout is counted; it ends the session
    if (pathname === '/api/auth/logout' && req.method() === 'POST') {
      opts.logouts = (opts.logouts ?? 0) + 1;
      Object.assign(opts, { account: undefined, signedOut: true, meUnavailable: 0 });
      return json({ ok: true });
    }
    if (pathname === '/api/auth/login-tailscale' && req.method() === 'POST') {
      const ts = opts.tailscale ?? {};
      ts.posts = (ts.posts ?? 0) + 1;
      ts.bodies = [...(ts.bodies ?? []), req.postData()];
      if (ts.refuse || !ts.as) return json({ error: 'sign-in failed' }, 401);
      Object.assign(opts, { signedOut: false, account: ts.as.account, kind: ts.as.kind, admin: ts.as.admin, method: 'tailscale', tailnetSubject: ts.as.subject });
      return json({ auth: true, kind: ts.as.kind, name: ts.as.account, admin: ts.as.admin });
    }
    if (pathname === '/api/auth/me') {
      // opts.meUnavailable: that many answers are the gate's tailnet 503 first; opts.meDelayMs: each comes that late
      if (opts.meDelayMs) await new Promise((r) => setTimeout(r, opts.meDelayMs));
      if (opts.meUnavailable > 0) {
        opts.meUnavailable--;
        return json({ error: 'tailnet identity unavailable' }, 503, TAILNET_DOWN);
      }
      if (opts.account) {
        const kind = opts.kind ?? 'virt';
        const until = opts.asRoot?.until;
        opts.meCalls = (opts.meCalls ?? 0) + 1;
        const how = opts.method ? { method: opts.method, ...(opts.tailnetSubject ? { tailnet: opts.tailnetSubject } : {}) } : {};
        return json({ auth: true, kind, name: opts.account, admin: opts.admin === true, ...(until !== undefined && until > Date.now() ? { asRootUntil: until, asRootLeftMs: until - Date.now() } : {}), ...how });
      }
      return opts.signedOut ? json({ error: 'signed out' }, 401, { 'x-filedeck-auth': 'signed-out' }) : json({ auth: false });
    }
    if (pathname === '/api/auth/login' && req.method() === 'POST') return json({ error: 'sign-in failed' }, 401);
    // opts.adminApi ({ posts, conflict, tailscale, patchConflict, extra, sessions }): the hub's admin routes. `extra`: more virtual
    // accounts ({ name, tailnet: [subjects], ... }); `sessions`: the Signed in list instead of the default one. Two virtual accounts exist: fixture-guest, with a machine and a
    // source that are no longer configured, and the signed-in fixture-admin. A POST of a new account is kept in `posts` and answers
    // 409 "exists" while `conflict` is set, else 201 with the new account.
    if (opts.adminApi && pathname.startsWith('/api/admin/')) {
      const a = opts.adminApi;
      const kinds = (list) => list.map((subject) => ({ subject, kind: subject.startsWith('tag:') ? 'tag' : 'login' }));
      const guest = { name: 'fixture-guest', admin: false, hasPassword: true, keys: [{ fingerprint: 'SHA256:fixture', type: 'ssh-ed25519', comment: 'fixture laptop' }], nodes: { [nodeName]: { runAs: 'fixture-run', grants: [{ path: '/work', write: true }, { path: '/', write: false }] }, 'fixture-retired': { runAs: 'fixture-run', grants: [{ path: '/old', write: false }] } }, sources: { 'fixture-s3': { write: false }, 'fixture-gone': { write: true } }, sessions: 1, tailnet: kinds(a.guestLinks ?? []) };
      const self = { name: 'fixture-admin', admin: true, hasPassword: true, keys: [], nodes: {}, sources: {}, sessions: 1, tailnet: [] };
      // sessions: the caller's own and fixture-guest's; ended / endedAll / puts / forgot keep what the page sent
      a.sessions ??= [
        { id: 'aa11aa11', kind: 'virt', name: 'fixture-admin', created: Date.now() - 7_200_000, lastUsed: Date.now() - 60_000, address: '203.0.113.7', current: true, method: 'password' },
        { id: 'bb22bb22', kind: 'virt', name: 'fixture-guest', created: Date.now() - 86_400_000, lastUsed: Date.now() - 3_600_000, address: '198.51.100.9', method: 'key' },
        { id: 'cc33cc33', kind: 'virt', name: 'fixture-guest', created: Date.now() - 90_000_000, lastUsed: Date.now() - 7_200_000, address: '192.0.2.5', method: 'tailscale', tailnet: 'alice@github' },
        { id: 'ee55ee55', kind: 'virt', name: 'fixture-ci', created: Date.now() - 3_600_000, lastUsed: Date.now() - 120_000, address: '100.64.0.9', method: 'tailscale', tailnet: 'tag:ci', tailnetSource: 'socket', tailnetDevice: 'ci-runner' },
      ];
      a.unowned ??= 2;
      a.ended ??= []; a.endedAll ??= []; a.calls ??= []; a.sysExtra ??= []; a.puts ??= []; a.tputs ??= []; a.patches ??= []; a.forgot ??= 0; a.sessionCalls ??= 0;
      if (pathname === '/api/admin/overview') return json({ nodes: [nodeName, 'fixture-dest'], sources: [{ name: 'fixture-s3', type: 's3' }], systemAdmins: [], unownedPasswords: a.unowned, tailscale: a.tailscale === undefined ? 'socket' : a.tailscale });
      if (pathname === '/api/admin/accounts' && req.method() === 'GET') return json({ accounts: [self, guest, ...(a.created ? [a.created] : []), ...(a.extra ?? []).map((x) => ({ admin: false, hasPassword: false, keys: [], nodes: {}, sources: {}, sessions: 0, ...x, tailnet: kinds(x.tailnet ?? []) }))], system: [{ name: 'fixture-root', admin: true, sources: {}, sessions: 0, tailnet: [] }, ...a.sysExtra.map((u) => ({ name: u.name, admin: false, sessions: 0, sources: u.sources, tailnet: kinds(u.tailnet) })), ...(a.puts.length ? [{ name: 'alice', admin: false, sources: a.puts.at(-1).sources, sessions: 0, tailnet: kinds(a.tputs.at(-1)?.links ?? []) }] : [])] });
      if (pathname === '/api/admin/sessions' && req.method() === 'GET') { a.sessionCalls++; return json({ sessions: a.sessions }); }
      if (pathname.startsWith('/api/admin/sessions/') && req.method() === 'DELETE') {
        const id = pathname.split('/').pop();
        a.ended.push(id);
        a.sessions = a.sessions.filter((x) => x.id !== id);
        return json({ ok: true });
      }
      if (pathname === '/api/admin/end-sessions' && req.method() === 'POST') { const b = req.postDataJSON(); a.endedAll.push(b); a.sessions = a.sessions.filter((x) => !(x.kind === b.kind && x.name === b.name)); return json({ ok: true }); }
      if (pathname === '/api/admin/vault/unowned' && req.method() === 'DELETE') { a.forgot++; const removed = a.unowned; a.unowned = 0; return json({ removed }); }
      // sysExtra: more system users ({ name, sources, tailnet }); their PUTs are kept in `calls` in the order they came. failTailnet and
      // failSources make that call answer an error, as the hub does for a user no machine has and for a refused source.
      const extra = /^\/api\/admin\/system\/([^/]+)\/(sources|tailnet)$/.exec(pathname);
      if (extra && req.method() === 'PUT' && a.sysExtra.some((u) => u.name === extra[1])) {
        const u = a.sysExtra.find((x) => x.name === extra[1]);
        const b = req.postDataJSON();
        a.calls.push({ kind: extra[2], name: u.name, body: b });
        if (a[extra[2] === 'tailnet' ? 'failTailnet' : 'failSources']) return json({ error: extra[2] === 'tailnet' ? `no machine has a system user ${u.name}` : 'source refused' }, 400);
        if (extra[2] === 'tailnet') u.tailnet = b.links; else u.sources = b.sources;
        return json({ name: u.name, admin: false, sources: u.sources, sessions: 0, tailnet: kinds(u.tailnet) });
      }
      if (pathname === '/api/admin/system/alice/sources' && req.method() === 'PUT') { const b = req.postDataJSON(); a.puts.push(b); return json({ name: 'alice', admin: false, sources: b.sources, sessions: 0, tailnet: [] }); }
      if (pathname === '/api/admin/system/alice/tailnet' && req.method() === 'PUT') { const b = req.postDataJSON(); a.tputs.push(b); return json({ name: 'alice', admin: false, sources: {}, sessions: 0, tailnet: kinds(b.links) }); }
      if (pathname === '/api/admin/accounts/fixture-guest' && req.method() === 'PATCH') {
        const b = req.postDataJSON();
        a.patches.push(b);
        if (a.patchConflict) return json({ error: 'this tag is linked to virt:fixture-other' }, 409);
        a.guestLinks = b.tailnet;
        return json({ ...guest, tailnet: kinds(b.tailnet) });
      }
      if (pathname === '/api/admin/accounts' && req.method() === 'POST') {
        const b = req.postDataJSON();
        a.posts.push(b);
        if (a.conflict) return json({ error: 'exists' }, 409);
        a.created = { name: b.name, admin: b.admin, hasPassword: typeof b.password === 'string', keys: [], nodes: b.nodes, sources: b.sources, sessions: 0, tailnet: kinds(b.tailnet ?? []) };
        return json(a.created, 201);
      }
      return json({ error: 'not found' }, 404);
    }
    // opts.roots: the virtual account's granted folders on the one machine it may use
    if (pathname === '/api/nodes') return json(opts.roots ? { nodes: [{ name: nodeName, online: true, roots: opts.roots }] } : { nodes: [{ name: nodeName, online: true }, { name: 'fixture-dest', online: true }] });
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
      // a virtual account may list only its granted folders and what is below them
      if (opts.roots && !opts.roots.some((r) => path === r || path.startsWith(`${r}/`))) return json({ error: 'no access to this path' }, 403);
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
      // a virtual account: its granted folders are folders, and nothing outside them can be read
      if (opts.roots?.includes(path)) return json({ name: path.split('/').at(-1), path, type: 'dir', size: 0, mtime: 1791264000000, mode: 0o755 });
      if (opts.roots && !opts.roots.some((r) => path.startsWith(`${r}/`))) return json({ error: 'no access to this path' }, 403);
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
    if (opts.status && pathname === '/api/status') {
      const selected = url.searchParams.get('node');
      return json({ nodes: opts.status.nodes.filter(({ node }) => !selected || node === selected) });
    }
    if (opts.status && pathname === '/api/groups') return json({ error: 'not found' }, 404);
    if (opts.status && pathname === '/api/diff/jobs') return json({ jobs: [] });
    if (pathname.endsWith('/api/jobs')) return json({ jobs: pathname.includes('/' + nodeName + '/') ? opts.status?.jobs ?? [] : [] });
    if (pathname === '/api/ops/jobs' && req.method() === 'POST') {
      opCalls.push(req.postDataJSON());
      return json({ id: `fixture-op-${opCalls.length}`, state: 'queued' });
    }
    // Web Push at the fake hub: a fixed P-256 public key; each subscribe and delete body goes to opts.pushLog when given
    if (pathname === '/api/push/key') return json({ publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' });
    if (pathname === '/api/push/subscribe' && (req.method() === 'POST' || req.method() === 'DELETE')) {
      opts.pushLog?.push({ method: req.method(), body: req.postDataJSON() });
      return json(req.method() === 'POST' ? { ok: true } : { removed: 1 });
    }
    // opts.opJobs: a check's own hub job list (the jobs tray polls it)
    if (pathname === '/api/ops/jobs') return json({ jobs: opts.opJobs ? opts.opJobs() : [] });
    if (pathname.endsWith('/api/trash/list')) return json({ volumes: [{ volume: '/', items: trashItems, truncated: false }] });
    if (pathname.endsWith('/api/fs/read')) return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: markdownText });
    if (pathname.endsWith('/api/fs/text')) return json({ path: url.searchParams.get('path'), content: url.searchParams.get('path')?.endsWith('.md') ? markdownText : url.searchParams.get('path')?.endsWith('/mixed.txt') ? 'one\r\ntwo\r\nthree\nfour\r\n' : 'saved text\n', size: 12, mtime: 1791264000000, etag: 'etag-1' });
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
      stats: { dirsScanned: 1, dirsQueued: 0, entries: 3, hashed: 0, hashQueued: 0, hashedBytes: 0, cacheHits: 0, cacheMisses: 0, startedAt: Date.now() - 100, finishedAt: Date.now(), rev: 1,
        warnings: opts.skipped ? ['2 paths were left out because the include/exclude patterns are too expensive to match against them (the comparison is incomplete), for example: deep/odd-name-one, deep/odd-name-two'] : [],
        ...(opts.skipped ? { incomplete: true, skipped: { count: 2, paths: ['deep/odd-name-one', 'deep/odd-name-two'] } } : {}) },
      files: { identical: 1, different: 1, leftOnly: 1, rightOnly: 0, error: 0 }, dirs: { identical: 0, different: 0, leftOnly: 0, rightOnly: 0, error: 0 },
    });
    if (pathname === '/api/diff/jobs/diff-fixture/rows' && opts.skipped) return json({ rel: url.searchParams.get('rel') || '', listed: true, status: 'identical', rev: 1, rows: [] });
    if (pathname === '/api/diff/jobs/diff-fixture/rows' && opts.manyRows) return json({ rel: url.searchParams.get('rel') || '', listed: true, status: 'different', rev: 1, rows: Array.from({ length: 40 }, (_, i) => ({ p: `entry-${String(i).padStart(2, '0')}.txt`, status: i % 3 === 0 ? 'different' : 'identical', l: diffSide(128), r: diffSide(i % 3 === 0 ? 256 : 128) })) });
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

// clockOffsetMs: the page's Date runs that far ahead of the fake hub's clock (timers are untouched).
// serviceWorkers: 'block' (the default) keeps the app's service worker out of every check but the installable-app one,
// so those checks see the page exactly as before it had one. initScripts: functions run in the page before its own scripts.
async function openPage(browser, { viewport = { width: 1365, height: 900 }, colorScheme = 'light', state = appState(), fixture = {}, clockOffsetMs = 0, fakeClock = false, serviceWorkers = 'block', initScripts = [], origin = baseURL, mobile = false } = {}) {
  // bypassCSP only lets the harness inject axe-core into the page; the app's own scripts are unaffected.
  const context = await browser.newContext({ viewport, colorScheme, bypassCSP: true, serviceWorkers, isMobile: mobile, hasTouch: mobile });
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
  if (clockOffsetMs) {
    await page.addInitScript((off) => {
      const Real = Date;
      const now = () => Real.now() + off;
      globalThis.Date = class extends Real {
        constructor(...a) { if (a.length) super(...a); else super(now()); }
        static now() { return now(); }
      };
    }, clockOffsetMs);
  }
  // fakeClock: timers run in real time until a check moves them on with page.clock.fastForward
  if (fakeClock) await context.clock.install();
  for (const f of initScripts) await page.addInitScript(f);
  await installFixture(page, fixture);
  await page.goto(new URL(state, origin).toString(), { waitUntil: 'domcontentloaded' });
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
const knownAxe = [];
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
    // The folder named from the breadcrumb is part of the URL: a reload shows its repository, not the selected file's.
    assert.ok(nestedPage.url().includes('%22wp%22'), 'the breadcrumb folder must be kept in the URL (wp)');
    await nestedPage.reload();
    await nestedPage.getByRole('tab', { name: 'Git', exact: true }).waitFor({ state: 'visible' });
    await nestedPage.locator('.wt-name', { hasText: 'parent-main' }).waitFor({ state: 'visible', timeout: 4000 });
    assert.ok(!await nestedPage.locator('.wt-name', { hasText: 'nested-unrelated' }).count(), 'after a reload the Git tab still lists the breadcrumb folder\'s repository');
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
    // The scroll into view above also moves the content of a box whose overflow is hidden or clipped. A user cannot scroll such a
    // box, so put it back where it starts before measuring: a control that is only visible after that move is cut off for the user.
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (['hidden', 'clip'].includes(s.overflowX) && p.scrollLeft !== 0) p.scrollLeft = 0;
      if (['hidden', 'clip'].includes(s.overflowY) && p.scrollTop !== 0) p.scrollTop = 0;
    }
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
      // Either a solid outline (2px, or the thin 1px ring of bar buttons) or an inset ring in the same colour: one colour, no halo.
      const ringColour = `rgb(${t['--focus-ring'].join(', ')})`;
      const outline = ring.outlineStyle === 'solid' && ['1px', '2px'].includes(ring.outlineWidth) && ring.boxShadow === 'none';
      const inset = ring.outlineStyle === 'none' && ring.boxShadow === `${ringColour} 0px 0px 0px 2px inset`;
      if (!outline && !inset) failures.push(`${scheme}: the focus indicator is not a single 1px or 2px ring in the focus colour: ${JSON.stringify(ring)}`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'theme tokens, selection mark and focus indicator');
}

// WCAG 2.0, 2.1 and 2.2 A and AA rules, run by axe-core over the whole document in every state listed.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function runAxe(page, label, failures) {
  // axe reads the colours the page shows now: a button still fading to its theme colour (150 ms transition) reads as low contrast, so let running transitions end and the fonts load first.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => undefined)));
  });
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

// A compact Compare toolbar on a phone: at most two rows (100 px) and enough compared rows stay in view; every moved action is
// reachable with the keyboard and the menu gives focus back to its button.
async function verifyCompareToolbarCompact(browser) {
  const split = { i: 'p3', d: 'v', k: [{ i: 'p1', n: nodeName, p: '/work' }, { i: 'p2', n: nodeName, p: '/work' }] };
  const state = stateOf(split, { g: { l: [nodeName, '/work'], r: [nodeName, '/work'], a: 'p1', b: 'p2' } });
  const failures = [];
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const { context, page } = await openPage(browser, { viewport: { width, height }, state, fixture: { manyRows: true } });
    try {
      await page.getByText('entry-01.txt').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.cmp-bar');
        const fp = bar.closest('.fp');
        const pr = fp.getBoundingClientRect();
        const rows = [...fp.querySelectorAll('.cmp-row[role=row]')].filter((r) => !r.classList.contains('up') && !r.classList.contains('skel'));
        const scroller = fp.querySelector('.cmp-scroll').getBoundingClientRect();
        const full = rows.filter((r) => { const x = r.getBoundingClientRect(); return x.height > 0 && x.top >= scroller.top - .5 && x.bottom <= Math.min(scroller.bottom, pr.bottom, innerHeight) + .5; }).length;
        return { barHeight: Math.round(bar.getBoundingClientRect().height), full, panel: Math.round(pr.height) };
      });
      if (m.barHeight > 100) failures.push(`${width}x${height}: the Compare toolbar is ${m.barHeight} px tall (limit 100)`);
      if (width === 390 && m.full < 8) failures.push(`${width}x${height}: only ${m.full} compared rows fully visible (need 8; panel ${m.panel} px)`);
      if (width === 390) {
        // Keyboard: Filter and More open with Enter, every item has a name, Escape returns focus to the button.
        for (const name of ['Filter', 'More']) {
          const button = page.locator('.cmp-bar').first().getByRole('button', { name: new RegExp(`^${name}`) });
          await button.focus();
          await page.keyboard.press('Enter');
          const menu = page.getByRole('menu').last();
          await menu.waitFor({ state: 'visible' });
          const names = await menu.getByRole(name === 'Filter' ? 'menuitemcheckbox' : 'menuitem').evaluateAll((els) => els.map((e) => e.textContent.trim()));
          const want = name === 'Filter' ? 3 : 6;
          if (names.length < want || names.some((x) => !x)) failures.push(`${name} menu items: ${JSON.stringify(names)}`);
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'detached' });
          const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() || '');
          if (!focused.startsWith(name)) failures.push(`after closing the ${name} menu focus is on "${focused}"`);
        }
        // a moved action works from the keyboard: Select differing from More enables Clear selection
        const more = page.locator('.cmp-bar').first().getByRole('button', { name: /^More/ });
        await more.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('menuitem', { name: 'Select differing' }).focus();
        await page.keyboard.press('Enter');
        await page.getByText(/^[1-9][0-9]* selected$/).first().waitFor({ state: 'visible', timeout: 5000 });
      }
    } finally {
      await context.close();
    }
  }
  // wide window: the full toolbar fits on one row once the panel is wide enough
  const { context, page } = await openPage(browser, { viewport: { width: 3000, height: 900 }, state });
  try {
    await page.getByText('only-left.txt').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => [...document.querySelectorAll('.cmp-bar')].map((b) => ({ h: Math.round(b.getBoundingClientRect().height), compact: b.classList.contains('compact') })));
    if (h.some((x) => x.h > 60 || x.compact)) failures.push(`3000px: toolbar should be one full row, got ${JSON.stringify(h)}`);
  } finally {
    await context.close();
  }
  assert.deepEqual(failures, [], 'the compact Compare toolbar');
}

// A compare that left paths out reports them: the count and the first paths show in the warning area (full and compact toolbar
// layouts), and the view never presents the result as complete ("Comparison done", "Nothing to show ... with the current filters").
async function verifyCompareSkippedPaths(browser) {
  const split = { i: 'p3', d: 'v', k: [{ i: 'p1', n: nodeName, p: '/work' }, { i: 'p2', n: nodeName, p: '/work' }] };
  const state = stateOf(split, { g: { l: [nodeName, '/work'], r: [nodeName, '/work'], a: 'p1', b: 'p2' } });
  const failures = [];
  for (const [width, height] of [[1365, 900], [390, 844]]) {
    const { context, page } = await openPage(browser, { viewport: { width, height }, state, fixture: { skipped: true } });
    try {
      const warn = page.locator('.side-cmp-warn').filter({ hasText: /2 paths skipped: comparison incomplete/ }).first();
      await warn.waitFor({ state: 'visible', timeout: 10000 });
      const full = await warn.evaluate((el) => el.parentElement?.getAttribute('aria-label') || el.closest('[data-tip]')?.getAttribute('data-tip') || '');
      void full;
      await warn.hover();
      await page.getByText(/odd-name-one, deep\/odd-name-two/).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => failures.push(`${width}px: the skipped paths are not named in the warning`));
      const box = await warn.boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width + 1) failures.push(`${width}px: the warning is outside the window ${JSON.stringify(box)}`);
      const text = await page.evaluate(() => document.body.innerText);
      if (/Nothing to show here with the current filters/.test(text)) failures.push(`${width}px: the empty state says there is nothing to show with the current filters`);
      if (!/comparison is incomplete|some paths were skipped/.test(text + '\n' + (await page.locator('[role=status]').allTextContents()).join('\n'))) failures.push(`${width}px: nothing says the comparison is incomplete`);
      const status = (await page.locator('p.visually-hidden[role=status]').allTextContents()).join(' | ');
      if (/Comparison done/.test(status)) failures.push(`${width}px: the status says "Comparison done" for an incomplete compare: ${status}`);
      if (!/The comparison is incomplete: 2 paths were skipped/.test(status)) failures.push(`${width}px: the status does not say the comparison is incomplete and how many paths were skipped: ${status}`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'a compare that skipped paths says so');
}

// Address bar: every control is at least 24x24 CSS px with no overlap (2.5.8), 44 px tall, the last breadcrumb segment stays
// visible, and focusing "Edit address" with the keyboard does not start editing (Enter or Space does).
async function verifyAddressBar(browser) {
  const nested = `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work/subdir/deep', s: tracked }, a: 'p1' }))}`;
  const failures = [];
  for (const [width, height] of [[1365, 900], [390, 844], [320, 568]]) {
    const { context, page } = await openPage(browser, { viewport: { width, height }, state: nested });
    try {
      await page.locator('.addr nav.crumbs').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      const report = await page.evaluate(() => {
        const addr = document.querySelector('.addr').getBoundingClientRect();
        const nodes = [...document.querySelectorAll('.addr button, .addr .addr-fill')].map((e) => ({ name: e.getAttribute('aria-label') || e.textContent.trim(), r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 || x.name.startsWith('Edit address'));
        const bad = [];
        for (const { name, r } of nodes) {
          if (r.height < 43.5) bad.push(`${name}: ${Math.round(r.height)} px tall`);
          if ((r.width < 24 || r.height < 24)) bad.push(`${name}: ${r.width}x${r.height} is under 24x24`);
          if (r.left < addr.left - .5 || r.right > addr.right + .5) bad.push(`${name}: outside the address bar`);
        }
        for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) {
          const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (ox > .05 && oy > .05) bad.push(`${a.name} overlaps ${b.name} by ${ox.toFixed(1)} px`);
        }
        const last = document.querySelector('.addr .crumb.last button');
        const lr = last?.getBoundingClientRect();
        if (!last || !lr || lr.width < 24 || lr.right > addr.right + .5) bad.push('the last breadcrumb segment is not visible');
        return { bad, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      for (const b of report.bad) failures.push(`${width}px: ${b}`);
      if (report.overflow > 1) failures.push(`${width}px: the document scrolls horizontally by ${report.overflow} px`);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPage(browser, { viewport: { width: 1365, height: 900 }, state: nested });
  try {
    const edit = page.getByRole('button', { name: 'Edit address' });
    await edit.focus();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('combobox', { name: 'Address' }).count(), 0, 'focusing Edit address with the keyboard must not start editing');
    await page.keyboard.press('Enter');
    await page.getByRole('combobox', { name: 'Address' }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Address' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Edit address' }).focus();
    await page.keyboard.press('Space');
    await page.getByRole('combobox', { name: 'Address' }).waitFor({ state: 'visible' });
  } finally {
    await context.close();
  }
  assert.deepEqual(failures, [], 'address bar targets');
}

// Compare toolbar: every action stays inside its panel and readable at the common widths (it wraps instead of scrolling sideways).
async function verifyCompareToolbar(browser) {
  const split = { i: 'p3', d: 'v', k: [{ i: 'p1', n: nodeName, p: '/work' }, { i: 'p2', n: nodeName, p: '/work' }] };
  const state = stateOf(split, { g: { l: [nodeName, '/work'], r: [nodeName, '/work'], a: 'p1', b: 'p2' } });
  const failures = [];
  for (const [width, height] of [[1365, 900], [1280, 800], [1024, 768], [390, 844], [320, 568]]) {
    const { context, page } = await openPage(browser, { viewport: { width, height }, state });
    try {
      await page.getByText('only-left.txt').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(200);
      const report = await page.evaluate(() => [...document.querySelectorAll('.cmp-bar')].map((bar) => {
        const panel = bar.closest('.fp').getBoundingClientRect();
        const wrap = bar.parentElement.getBoundingClientRect();
        const bad = [];
        for (const b of bar.querySelectorAll('button')) {
          const r = b.getBoundingClientRect();
          const name = b.textContent.trim() || b.getAttribute('aria-label') || 'button';
          if (r.left < panel.left - .5 || r.right > panel.right + .5 || r.top < wrap.top - .5 || r.bottom > wrap.bottom + .5) bad.push(`${name} outside the panel ${JSON.stringify([r.left, r.right, r.top, r.bottom].map(Math.round))}`);
          else if (b.scrollWidth > b.clientWidth + 1) bad.push(`${name} text cut (${b.scrollWidth} > ${b.clientWidth})`);
        }
        if (bar.scrollWidth > bar.clientWidth + 1) bad.push(`toolbar scrolls sideways (${bar.scrollWidth} > ${bar.clientWidth})`);
        return { bad, wrapHeight: Math.round(wrap.height), buttons: bar.querySelectorAll('button').length };
      }));
      assert.ok(report.length >= 1 && report.every((x) => x.buttons >= 1), `the Compare toolbar renders at ${width}px`);
      for (const x of report) for (const b of x.bad) failures.push(`${width}px: ${b}`);
      if (report.length === 2 && report[0].wrapHeight !== report[1].wrapHeight) failures.push(`${width}px: the two toolbars differ in height (${report[0].wrapHeight} and ${report[1].wrapHeight}), so the rows below do not line up`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'no Compare toolbar action is clipped by its panel');
}

// A phone header with a selection: the count, the actions that fit and Clear never overflow, clip or overlap, the menu button stays at the
// left and Jobs at the right, every button is at least 44 px wide, and every action that is not shown is in the More menu.
async function verifyPhoneSelectionHeader(browser) {
  const failures = [];
  for (const scheme of ['light', 'dark']) {
    for (const [width, height] of [[320, 568], [360, 640], [390, 844], [430, 932], [844, 390]]) {
      const { context, page } = await openPage(browser, { viewport: { width, height }, colorScheme: scheme, state: directState() });
      const tag = `${width}x${height} ${scheme}`;
      try {
        const rows = page.locator('.fp.active .fp-scroll [data-path]');
        await rows.first().waitFor({ state: 'visible' });
        await rows.nth(0).click({ modifiers: ['Control'] });
        await rows.nth(1).click({ modifiers: ['Control'] });
        await page.locator('.selbar-actions').waitFor({ state: 'visible' });
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
          const hdr = document.querySelector('.site-header__inner');
          const btns = [...hdr.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ({ label: b.getAttribute('aria-label') || b.textContent.trim(), ...box(b) }));
          const bar = document.querySelector('.selbar');
          return { hdr: box(hdr), hdrScroll: hdr.scrollWidth, hdrClient: hdr.clientWidth, barScroll: bar.scrollWidth, barClient: bar.clientWidth, bar: box(bar), btns, doc: document.documentElement.scrollWidth, win: window.innerWidth };
        });
        if (m.hdrScroll > m.hdrClient + 1) failures.push(`${tag}: header scrollWidth ${m.hdrScroll} > clientWidth ${m.hdrClient}`);
        if (m.barScroll > m.barClient + 1) failures.push(`${tag}: selection bar scrollWidth ${m.barScroll} > clientWidth ${m.barClient}`);
        if (m.doc > m.win + 1) failures.push(`${tag}: the page scrolls sideways`);
        for (const b of m.btns) {
          if (b.l < -0.5 || b.r > m.win + 0.5) failures.push(`${tag}: "${b.label}" leaves the window`);
          if (b.w < 43.5) failures.push(`${tag}: "${b.label}" is ${b.w}px wide`);
          if (b.t < m.hdr.t - 0.5 || b.b > m.hdr.b + 0.5) failures.push(`${tag}: "${b.label}" leaves the header`);
        }
        const sorted = [...m.btns].sort((a, b) => a.l - b.l);
        for (let i = 1; i < sorted.length; i++) if (sorted[i].l < sorted[i - 1].r - 0.5) failures.push(`${tag}: "${sorted[i - 1].label}" overlaps "${sorted[i].label}"`);
        if (sorted[0]?.label !== 'Open navigation') failures.push(`${tag}: the menu button is not at the far left (${sorted[0]?.label})`);
        if (sorted.at(-1)?.label !== 'Jobs') failures.push(`${tag}: the Jobs button is not at the far right (${sorted.at(-1)?.label})`);
        const shownActions = m.btns.map((b) => b.label).filter((l) => ['Copy', 'Cut', 'Download', 'Trash'].includes(l));
        if (!m.btns.some((b) => b.label === 'Clear')) failures.push(`${tag}: Clear is not visible`);
        await page.getByRole('button', { name: 'More selection actions' }).click();
        const items = await page.getByRole('menu').first().getByRole('menuitem').allInnerTexts();
        for (const a of ['Copy', 'Cut', 'Download', 'Trash']) if (!shownActions.includes(a) && !items.some((t) => t.trim().startsWith(a))) failures.push(`${tag}: "${a}" is neither shown nor in More (${items.join(' | ')})`);
        await page.keyboard.press('Escape');
        await page.addScriptTag({ path: axePath });
        const ax = await page.evaluate(async (tags) => window.axe.run(document.querySelector('.site-header'), { runOnly: { type: 'tag', values: tags } }), AXE_TAGS);
        for (const v of ax.violations) failures.push(`${tag}: axe ${v.id} on ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(', ')}`);
      } finally {
        await context.close();
      }
    }
  }
  assert.deepEqual(failures, [], 'the phone header with a selection fits at every width');
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

// Sign-in on and no session: the sign-in screen replaces the app. It passes axe in both schemes, with an error shown too,
// and does not scroll sideways on a phone. Signed in, the header names the account and offers "Sign out".
async function verifySignIn(browser, schemes = ['light', 'dark']) {
  const once = schemes.includes('light');
  const failures = [];
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, bypassCSP: true });
      const page = await context.newPage();
      try {
        await page.addInitScript((mode) => localStorage.setItem('filedeck-theme', mode), scheme);
        await installFixture(page, { signedOut: true });
        await page.goto(new URL(directState(), baseURL).toString(), { waitUntil: 'domcontentloaded' });
        const heading = page.getByRole('heading', { name: /^Sign in to / });
        await heading.waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await page.locator('.fp').count(), 0, 'no file panel behind the sign-in screen');
        const label = `${viewport.width}x${viewport.height} ${scheme}`;
        const overflow = async (what) => {
          const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth, form: document.querySelector('.signin-form')?.getBoundingClientRect().right ?? 0 }));
          if (o.scroll > o.client + 1 || o.body > o.client + 1 || o.form > o.client + 1) failures.push({ view: `${what} ${label}`, rule: 'horizontal overflow', ...o });
        };
        await overflow('password form');
        await runAxe(page, `sign-in password ${label}`, failures);
        await page.getByRole('textbox', { name: 'Name' }).fill('fixture-user');
        await page.getByLabel('Password', { exact: true }).fill('not-the-password');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('alert').filter({ hasText: 'Sign-in failed' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '', 'the password is cleared after a failed attempt');
        await runAxe(page, `sign-in error ${label}`, failures);
        await page.getByRole('radio', { name: 'Key file' }).click();
        await page.getByLabel('Key file').waitFor({ state: 'visible' });
        await overflow('key file form');
        await runAxe(page, `sign-in key file ${label}`, failures);
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
        if (stored.includes('not-the-password')) failures.push({ view: label, rule: 'password kept in storage' });
      } finally {
        await context.close();
      }
    }
  }
  if (once) {
    const { context, page } = await openPage(browser, { state: directState(), fixture: { account: 'fixture-user' } });
    try {
      await page.getByRole('button', { name: 'Account: fixture-user' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).waitFor({ state: 'visible' });
    } finally {
      await context.close();
    }
    await verifyResumeAfterSessionEnds(browser);
  }
  await verifyTailscaleSignIn(browser, failures, schemes);
  assert.deepEqual(failures, [], 'the sign-in screen passes axe and fits the window');
}

// Sign in with Tailscale: the button shows only when the hub gives a tailnet identity, names the login (or the tags), and is never
// pressed for the person (no POST before the click, focus stays on the name field). A refusal shows "Sign-in failed", as for a
// password. 503 shows a note; `{}` shows nothing new. axe passes and nothing overflows sideways at 1365x900, 390x844 and 320x568
// in light and dark. The click sends one POST with `{}`; the app then loads and the account menu names the method. Acting as root
// from a Tailscale session still asks for the password. A 503 from /api/auth/me is a wait with a retry, never the sign-in screen.
async function verifyTailscaleSignIn(browser, failures, schemes = ['light', 'dark']) {
  const once = schemes.includes('light');
  const open = async (viewport, scheme, fixture) => {
    const context = await browser.newContext({ viewport, colorScheme: scheme, bypassCSP: true });
    const page = await context.newPage();
    fixture.requests = [];
    await page.addInitScript((mode) => localStorage.setItem('filedeck-theme', mode), scheme);
    await installFixture(page, fixture);
    await page.goto(new URL(directState(), baseURL).toString(), { waitUntil: 'domcontentloaded' });
    return { context, page };
  };
  const overflow = async (page, what) => {
    const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth, form: document.querySelector('.signin-form')?.getBoundingClientRect().right ?? 0, menu: Math.max(0, ...[...document.querySelectorAll('.ctx, .ctx button')].map((e) => e.getBoundingClientRect().right)) }));
    if (o.scroll > o.client + 1 || o.body > o.client + 1 || o.form > o.client + 1 || o.menu > o.client + 1) failures.push({ view: what, rule: 'horizontal overflow', ...o });
  };
  const posts = (fixture) => fixture.requests.filter((r) => r === '/api/auth/login-tailscale').length;
  const tsButton = (page) => page.getByRole('button', { name: 'Sign in with Tailscale', exact: true });
  const heading = (page) => page.getByRole('heading', { name: /^Sign in to / });
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const label = `${viewport.width}x${viewport.height} ${scheme}`;
      const fixture = { signedOut: true, tailnet: { body: { login: 'alice.with.a.rather.long.name@example-github', displayName: 'Alice Example', node: { name: 'alice-laptop' } } }, tailscale: { refuse: true } };
      const { context, page } = await open(viewport, scheme, fixture);
      try {
        await tsButton(page).waitFor({ state: 'visible', timeout: 15000 });
        const as = page.locator('.signin-as');
        assert.match(await as.innerText(), /^as Alice Example \(alice\.with\.a\.rather\.long\.name@example-github\) on alice-laptop$/, `the button names the login (${label})`);
        assert.equal(await as.locator('bdi').count(), 3, 'the login, display name and device name are in <bdi>');
        assert.match(await tsButton(page).getAttribute('aria-describedby'), /.+/, 'the button is described by the login line');
        await page.waitForTimeout(400);
        assert.equal(posts(fixture), 0, `no sign-in before the click (${label})`);
        assert.equal(await page.getByRole('textbox', { name: 'Name' }).evaluate((el) => el === document.activeElement), true, `focus stays on the name field (${label})`);
        await overflow(page, `tailscale button ${label}`);
        await runAxe(page, `tailscale button ${label}`, failures);
        await tsButton(page).click();
        await page.getByRole('alert').filter({ hasText: 'Sign-in failed' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(posts(fixture), 1, 'one POST per click');
        assert.equal(await tsButton(page).evaluate((el) => el === document.activeElement), true, `focus stays on the button after a refusal (${label})`);
        assert.equal(await heading(page).count(), 1, 'a refusal stays on the sign-in screen');
        await overflow(page, `tailscale refused ${label}`);
        await runAxe(page, `tailscale refused ${label}`, failures);
      } finally {
        await context.close();
      }
    }
    // a tagged device: the button names its tags
    {
      const fixture = { signedOut: true, tailnet: { body: { tags: ['tag:ci', 'tag:web'], node: { name: 'ci-runner' } } } };
      const { context, page } = await open({ width: 390, height: 844 }, scheme, fixture);
      try {
        await tsButton(page).waitFor({ state: 'visible', timeout: 15000 });
        assert.equal((await page.locator('.signin-as').innerText()).trim(), 'as this device (ci-runner): tag:ci, tag:web', 'the button names the tags');
        await runAxe(page, `tailscale tags ${scheme}`, failures);
      } finally {
        await context.close();
      }
    }
    // the hub's source does not answer: a note, no button
    {
      const fixture = { signedOut: true, tailnet: { status: 503, body: { error: 'tailnet identity unavailable' } } };
      const { context, page } = await open({ width: 1365, height: 900 }, scheme, fixture);
      try {
        await page.getByText('Tailscale sign-in is not available now.', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await tsButton(page).count(), 0, 'no button while the source does not answer');
        await runAxe(page, `tailscale unavailable ${scheme}`, failures);
      } finally {
        await context.close();
      }
    }
    // /api/auth/me answers 503 for a Tailscale session: a wait that asks again, never the sign-in screen
    {
      const fixture = { account: 'fixture-ts', kind: 'virt', method: 'tailscale', tailnetSubject: 'alice@github', meUnavailable: 2 };
      const { context, page } = await open({ width: 320, height: 568 }, scheme, fixture);
      try {
        await page.getByRole('status').filter({ hasText: 'Tailscale is not answering, trying again.' }).waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await heading(page).count(), 0, 'a 503 from me is not the sign-in screen');
        await overflow(page, `tailscale waiting ${scheme}`);
        await runAxe(page, `tailscale waiting ${scheme}`, failures);
        // the second answer is a 503 too; the third (after 1 s, then 2 s) brings the app
        await page.getByRole('button', { name: 'Account: fixture-ts' }).waitFor({ state: 'visible', timeout: 10000 });
        assert.equal(fixture.meUnavailable, 0, 'me was asked again after each 503');
      } finally {
        await context.close();
      }
    }
  }
  // a button that comes late does not move the form: its space is kept while the request is pending, so a tap meant for the
  // name field (made at the field's place from before) lands there and signs nobody in
  for (const viewport of !once ? [] : [{ width: 1365, height: 900 }, { width: 320, height: 568 }]) {
    const fixture = { signedOut: true, tailnet: { body: { login: 'alice@github' }, delayMs: 1500 }, tailscale: { as: { account: 'fixture-ts', kind: 'virt', admin: false, subject: 'alice@github' } } };
    const { context, page } = await open(viewport, 'light', fixture);
    try {
      const name = page.getByRole('textbox', { name: 'Name' });
      await name.waitFor({ state: 'visible', timeout: 15000 });
      // (fonts first: their swap moves the form by itself)
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      assert.equal(await tsButton(page).count(), 0, 'the button is not there yet');
      const before = await name.boundingBox();
      await tsButton(page).waitFor({ state: 'visible', timeout: 8000 });
      const after = await name.boundingBox();
      assert.ok(Math.abs(after.y - before.y) <= 1, `the name field does not move when the button comes (${viewport.width}px: ${before.y} then ${after.y})`);
      await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
      await page.waitForTimeout(400);
      assert.equal(posts(fixture), 0, `a tap at the name field signs nobody in (${viewport.width}px)`);
      assert.equal(await name.evaluate((el) => el === document.activeElement), true, 'the tap lands in the name field');
    } finally {
      await context.close();
    }
  }
  // the waiting screen: "Try now" shows "Trying…" while in flight, then the status says "still"; Sign out ends the session and
  // shows the sign-in screen; a 401 while waiting shows the sign-in screen too
  if (once) {
    const fixture = { account: 'fixture-ts', kind: 'virt', method: 'tailscale', tailnetSubject: 'alice@github', meUnavailable: 1000 };
    const { context, page } = await open({ width: 390, height: 844 }, 'light', fixture);
    try {
      const status = page.getByRole('status');
      await status.filter({ hasText: 'Tailscale is not answering, trying again.' }).waitFor({ state: 'visible', timeout: 15000 });
      fixture.meDelayMs = 1200;
      const tryNow = page.getByRole('button', { name: 'Try now' });
      await tryNow.click();
      const trying = page.getByRole('button', { name: 'Trying…' });
      await trying.waitFor({ state: 'visible', timeout: 2000 });
      assert.equal(await trying.getAttribute('aria-disabled'), 'true', '"Trying…" is aria-disabled');
      assert.equal(await trying.evaluate((el) => el === document.activeElement), true, 'focus stays on the button while trying');
      await status.filter({ hasText: 'Tailscale is still not answering, trying again.' }).waitFor({ state: 'visible', timeout: 8000 });
      await page.getByRole('button', { name: 'Try now' }).waitFor({ state: 'visible', timeout: 4000 });
      fixture.meDelayMs = 0;
      await runAxe(page, 'tailscale waiting, still', failures);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await heading(page).waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(fixture.logouts, 1, 'Sign out posts /api/auth/logout once');
    } finally {
      await context.close();
    }
  }
  if (once) {
    const fixture = { account: 'fixture-ts', kind: 'virt', method: 'tailscale', tailnetSubject: 'alice@github', meUnavailable: 1000 };
    const { context, page } = await open({ width: 390, height: 844 }, 'light', fixture);
    try {
      await page.getByRole('status').filter({ hasText: 'Tailscale is not answering, trying again.' }).waitFor({ state: 'visible', timeout: 15000 });
      // the session ends meanwhile: the next answer is the gate's 401
      Object.assign(fixture, { meUnavailable: 0, account: undefined, signedOut: true });
      await heading(page).waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(fixture.logouts ?? 0, 0, 'no logout was sent');
    } finally {
      await context.close();
    }
  }
  // the hub's tailnet 503 while the app is open: a banner over the app, which stays mounted (the panel keeps its state), and goes
  // once me answers again; axe passes and it fits at 1365x900 and 320x568 in light and dark
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 320, height: 568 }]) {
      const label = `${viewport.width}x${viewport.height} ${scheme}`;
      const fixture = { account: 'fixture-ts', kind: 'virt', method: 'tailscale', tailnetSubject: 'alice@github' };
      const { context, page } = await open(viewport, scheme, fixture);
      try {
        const panel = page.locator('.fp').first();
        await panel.locator('.fp-scroll [data-path]').first().waitFor({ state: 'visible', timeout: 15000 });
        // a mark on the panel's element: it is still there afterwards only if the app was not mounted again
        await panel.evaluate((el) => el.setAttribute('data-kept', 'yes'));
        const url = page.url();
        fixture.tailnetDown = true;
        await page.evaluate(() => fetch('/api/nodes').catch(() => {}));
        const banner = page.getByRole('region', { name: 'Tailscale' });
        await banner.getByRole('status').filter({ hasText: /Tailscale is (still )?not answering, trying again\./ }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(await heading(page).count(), 0, `the tailnet 503 is not a sign-out (${label})`);
        await banner.getByRole('button', { name: 'Sign out' }).waitFor({ state: 'visible' });
        await page.waitForTimeout(150);
        await overflow(page, `tailscale banner ${label}`);
        const bannerRight = await banner.evaluate((el) => el.getBoundingClientRect().right);
        const width = await page.evaluate(() => document.documentElement.clientWidth);
        if (bannerRight > width + 1) failures.push({ view: `tailscale banner ${label}`, rule: 'horizontal overflow', banner: bannerRight, client: width });
        await runAxe(page, `tailscale banner ${label}`, failures);
        fixture.tailnetDown = false;
        await banner.waitFor({ state: 'detached', timeout: 10000 });
        assert.equal(await page.locator('.fp[data-kept="yes"]').count(), 1, `the app stays mounted, the panel keeps its state (${label})`);
        assert.equal(page.url(), url, 'the layout in the URL is unchanged');
        assert.equal(await heading(page).count(), 0, 'still signed in');
      } finally {
        await context.close();
      }
    }
  }
  // Sign out from the banner ends the session and shows the sign-in screen
  if (once) {
    const fixture = { account: 'fixture-ts', kind: 'virt', method: 'tailscale', tailnetSubject: 'alice@github' };
    const { context, page } = await open({ width: 1365, height: 900 }, 'light', fixture);
    try {
      await page.locator('.fp .fp-scroll [data-path]').first().waitFor({ state: 'visible', timeout: 15000 });
      fixture.tailnetDown = true;
      await page.evaluate(() => fetch('/api/nodes').catch(() => {}));
      const banner = page.getByRole('region', { name: 'Tailscale' });
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      fixture.tailnetDown = false;
      fixture.meUnavailable = 1000;
      await banner.getByRole('button', { name: 'Sign out' }).click();
      await heading(page).waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(fixture.logouts, 1, 'Sign out from the banner posts /api/auth/logout once');
    } finally {
      await context.close();
    }
  }
  // no tailnet identity: the page is as before
  if (once) {
    const fixture = { signedOut: true, tailnet: { body: {} } };
    const { context, page } = await open({ width: 1365, height: 900 }, 'light', fixture);
    try {
      await heading(page).waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(400);
      assert.equal(await tsButton(page).count(), 0, 'no button without a tailnet identity');
      assert.equal(await page.locator('.signin-or').count(), 0, 'no divider without a tailnet identity');
    } finally {
      await context.close();
    }
  }
  // the click signs in; the account menu names the method; acting as root still asks for the password
  for (const scheme of schemes) {
    const asRoot = {};
    const fixture = { signedOut: true, asRoot, tailnet: { body: { login: 'alice@github' } }, tailscale: { as: { account: 'fixture-root', kind: 'sys', admin: true, subject: 'alice@github' } } };
    const { context, page } = await open({ width: 390, height: 844 }, scheme, fixture);
    try {
      await tsButton(page).click({ timeout: 15000 });
      const account = page.getByRole('button', { name: 'Account: fixture-root' });
      await account.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(fixture.tailscale.posts, 1, 'one POST signs in');
      assert.deepEqual(fixture.tailscale.bodies, ['{}'], 'the POST body is {}');
      await account.click();
      const line = page.getByRole('menuitem', { name: 'Signed in with Tailscale as alice@github' });
      await line.waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await line.locator('bdi').innerText(), 'alice@github', 'the subject is in <bdi>');
      await page.waitForTimeout(150);
      await overflow(page, `tailscale account menu ${scheme}`);
      await runAxe(page, `tailscale account menu ${scheme}`, failures);
      await page.getByRole('menuitem', { name: 'Act as root…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Act as root' });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByLabel('Password', { exact: true }).fill('fixture-root-password');
      await dialog.getByRole('button', { name: 'Act as root' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 8000 });
      await page.locator('.asroot-banner').waitFor({ state: 'visible', timeout: 8000 });
      assert.deepEqual(asRoot.bodies, ['password'], 'act as root from a Tailscale session sends the password');
    } finally {
      await context.close();
    }
  }
  // a password session's menu has no Tailscale line
  if (once) {
    const { context, page } = await openPage(browser, { state: directState(), fixture: { account: 'fixture-user', method: 'password' } });
    try {
      await page.getByRole('button', { name: 'Account: fixture-user' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('menuitem', { name: /Tailscale/ }).count(), 0, 'no Tailscale line for a password session');
    } finally {
      await context.close();
    }
  }
}

// A virtual account opens each machine at its first granted folder: with no panel in the URL the first panel shows it, the sidebar
// lists it under the machine with the Trash, and nothing lists / or asks for the machine's mounts. axe passes in light and dark.
async function verifyVirtualAccount(browser) {
  const failures = [];
  const share = '/srv/share';
  for (const scheme of ['light', 'dark']) {
    const fixture = { account: 'fixture-guest', kind: 'virt', roots: [share], requests: [] };
    const { context, page } = await openPage(browser, { colorScheme: scheme, state: '/', fixture });
    try {
      await page.waitForFunction((p) => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.p === p, share, { timeout: 10000 });
      // the address bar's last folder menu is the one of the granted folder
      await page.locator('.fp').first().getByRole('button', { name: `Folders in ${share}`, exact: true }).waitFor({ state: 'visible', timeout: 8000 });
      // above the granted folder the account has no access: up is disabled, as at /
      assert.equal(await page.locator('.fp').first().getByRole('button', { name: 'Up one folder', exact: true }).isDisabled(), true, 'up is disabled at the granted folder');
      const tree = page.getByRole('tree', { name: 'Navigation' });
      await tree.getByRole('treeitem', { name: share }).waitFor({ state: 'visible', timeout: 8000 });
      await tree.getByRole('treeitem', { name: 'Trash' }).waitFor({ state: 'visible' });
      assert.equal(await tree.getByRole('treeitem', { name: '/ (root)' }).count(), 0, 'no "/ (root)" row');
      // open the granted folder's row too: it lists that folder, never /
      await tree.getByRole('treeitem', { name: share }).click();
      await page.waitForTimeout(400);
      await runAxe(page, `virtual account (${scheme})`, failures);
      const node = encodeURIComponent(nodeName);
      const bad = fixture.requests.filter((r) => r === `/api/nodes/${node}/api/mounts` || (r.startsWith(`/api/nodes/${node}/api/fs/list?`) && new URLSearchParams(r.slice(r.indexOf('?'))).get('path') === '/'));
      assert.deepEqual(bad, [], `no list of / and no mounts request (${scheme})`);
      assert.ok(fixture.requests.some((r) => r.startsWith(`/api/nodes/${node}/api/fs/list?`) && new URLSearchParams(r.slice(r.indexOf('?'))).get('path') === share), `the granted folder is listed (${scheme})`);
      // the address bar's first crumb is the granted folder, not the root sign
      const panel = page.locator('.fp').first();
      assert.equal((await panel.locator('.crumbs .crumb').first().locator('.crumb-t').textContent())?.trim(), share, 'the first crumb shows the granted folder');
      // "/" typed against the granted folder's base stays in it; the machine's / typed in full is refused (the fixture answers 403):
      // the panel offers the home folder instead of the bare error, and does not move by itself
      const go = async (text) => {
        await panel.getByRole('button', { name: 'Edit address' }).click();
        const box = panel.getByRole('combobox', { name: 'Address' });
        await box.fill(text);
        await box.press('Enter');
        await box.waitFor({ state: 'detached' });
      };
      await go('/');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.p), share, `"/" stays in the granted folder (${scheme})`);
      await go(`${nodeName}:/`);
      const offer = panel.getByRole('button', { name: `Open ${share}`, exact: true });
      await offer.waitFor({ state: 'visible', timeout: 8000 });
      await panel.getByRole('alert').filter({ hasText: 'You have no access to this folder.' }).waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.p), '/', 'no silent redirect');
      await runAxe(page, `virtual account, no access (${scheme})`, failures);
      await offer.click();
      await page.waitForFunction((p) => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.p === p, share, { timeout: 8000 });
      await offer.waitFor({ state: 'detached', timeout: 8000 }); // the offer goes once the home folder is listed
    } finally {
      await context.close();
    }
  }
  // Saved state from elsewhere: a node list saved with sign-in off (no roots), one saved by another account and one in the format
  // from before accounts, plus a bookmark of / on the machine. None of them may make the page list / or ask for mounts. Then
  // "Copy to folder..." on a second machine opens at that machine's granted folder.
  {
    const dest = '/srv/dest';
    const plainList = [{ name: nodeName, online: true }, { name: 'fixture-dest', online: true }];
    const fixture = {
      account: 'fixture-guest', kind: 'virt', roots: [share, dest], requests: [],
      nodesBody: { nodes: [{ name: nodeName, online: true, roots: [share] }, { name: 'fixture-dest', online: true, roots: [dest] }] },
      lists: { [share]: [entry(`${share}/report.txt`)] },
    };
    const { context, page } = await openPage(browser, { state: '/', fixture });
    try {
      // each load starts from the saved list chosen below (kept in sessionStorage, which outlives the navigation) and the bookmark
      await page.addInitScript((node) => {
        const seed = sessionStorage.getItem('fixture-seed-swr');
        if (seed) localStorage.setItem('filedeck.swr.v1', seed);
        localStorage.setItem('filedeck.bookmarks', JSON.stringify([{ node, path: '/' }]));
      }, nodeName);
      const seeds = [
        JSON.stringify({ owner: 'anon', entries: [['nodes', { data: plainList }]] }),
        JSON.stringify({ owner: 'virt:someone-else', entries: [['nodes', { data: [{ name: nodeName, online: true, roots: ['/srv/other'] }] }]] }),
        JSON.stringify([['nodes', { data: plainList }]]),
      ];
      for (const [round, seed] of seeds.entries()) {
        await page.evaluate((v) => sessionStorage.setItem('fixture-seed-swr', v), seed);
        fixture.requests.length = 0;
        await page.goto(new URL('/', baseURL).toString(), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((p) => JSON.parse(new URL(location.href).searchParams.get('s') || 'null')?.t?.p === p, share, { timeout: 10000 });
        await page.getByRole('tree', { name: 'Navigation' }).getByRole('treeitem', { name: share }).waitFor({ state: 'visible' });
        await page.waitForTimeout(500);
        const bad = fixture.requests.filter((r) => r.includes('/api/mounts') || (r.includes('/api/fs/list?') && new URLSearchParams(r.slice(r.indexOf('?'))).get('path') === '/'));
        assert.deepEqual(bad, [], `saved state ${round} from elsewhere: no list of / and no mounts request`);
        const kept = await page.evaluate(() => localStorage.getItem('filedeck.swr.v1') ?? '');
        assert.ok(!kept.includes('/srv/other') && !kept.includes('"anon"') && !kept.startsWith('['), `saved state ${round}: the list saved elsewhere is dropped`);
      }
      fixture.requests.length = 0;
      await page.locator('[data-path="/srv/share/report.txt"]').click();
      await page.keyboard.press('Shift+F10');
      await page.getByRole('menu').last().getByRole('menuitem', { name: 'Copy to folder...', exact: true }).press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Copy to folder' });
      await dialog.waitFor({ state: 'visible' });
      await chooseDestinationNode(page, dialog, 'fixture-dest');
      await dialog.getByText(`fixture-dest:${dest}`).waitFor({ state: 'visible' });
      assert.equal(await dialog.getByRole('button', { name: 'Up one destination folder' }).isDisabled(), true, 'up is disabled at the granted folder in the dialog');
      const listed = fixture.requests.filter((r) => r.includes('/api/fs/list?')).map((r) => r.slice(0, r.indexOf('/api/fs/list')) + ' ' + new URLSearchParams(r.slice(r.indexOf('?'))).get('path'));
      assert.deepEqual(listed.filter((l) => l.endsWith(' /')), [], 'switching the machine in "Copy to folder" lists no /');
      assert.ok(listed.includes(`/api/nodes/fixture-dest ${dest}`), 'the second machine opens at its granted folder');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'the virtual account view passes axe in light and dark');
}

// Accounts (administrators): "Accounts…" in the account menu opens the view; "New account" with a name, a password, a run-as user
// and a folder picked in the folder picker sends one POST /api/admin/accounts with exactly that body; the hub's 409 shows its text
// in the alert next to the button, and a second try creates the account and opens its editor. axe passes on the list, the editor
// and the picker in light and dark, none of them overflows sideways at 1365x900, 390x844 and 320x568, and the password never
// reaches a URL or storage. At 1365x900 also: the overlay (and Settings) fits the window without scrolling the page; axe passes on
// an existing account's editor (with a machine and a source no longer configured), "Discard changes?", the delete confirm, one's
// own account's editor and its confirm; Settings closes Accounts. A system administrator gets the menu item too; an account that
// is not an administrator does not.
// A dialog fades in: axe measures colours as they are on screen, so it waits for running animations and transitions to end.
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 8000 });
// A tooltip that is open takes the next Escape (it dismisses itself first). One opens 450 ms after the pointer rests on a control with
// one, also when the layout moved a control under a pointer that did not move. So a check that expects Escape to reach the view first
// moves the pointer away and waits until no tooltip is open.
async function pressEscape(page) {
  await page.mouse.move(2, 2);
  await page.locator('[role=tooltip]').waitFor({ state: 'detached', timeout: 8000 });
  await page.keyboard.press('Escape');
}
// Focus reaches `loc` within 4 s and is still there 300 ms later (nothing moves it on afterwards).
async function focusStaysOn(page, loc, why) {
  const on = () => loc.evaluate((el) => el === document.activeElement);
  for (let i = 0; i < 40 && !(await on()); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  const at = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
  assert.ok(await on(), `${why} (focus is on ${at})`);
}
// Polls `read` for a value above `than` (a few seconds at most).
async function expectMore(read, than, why) {
  for (let i = 0; i < 80 && !(read() > than); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(read() > than, why);
}
// System users editor (Task 6 review): the order of the two calls of a save, a half save that says what was saved, grants for sources that
// are no longer configured, a save with nothing to save, text left in the link field, and a links-only change that asks before it is dropped.
async function verifySystemEditor({ page, view, sys, adminApi, label, failures, overflow }) {
  const bob = sys.getByRole('button', { name: 'Edit sources and Tailscale links of bob' });
  const heading = () => sys.getByRole('heading', { name: 'Sources of bob' });
  const save = () => sys.getByRole('button', { name: 'Save', exact: true });
  const links = sys.getByRole('region', { name: 'Tailscale' });
  const field = links.getByRole('textbox', { name: 'Tailnet login or tag' });
  const add = async (v) => { await field.fill(v); await links.getByRole('button', { name: 'Add', exact: true }).click(); };
  const discard = page.getByRole('dialog', { name: 'Discard changes?' });
  const rowOf = () => sys.getByRole('row').filter({ hasText: 'bob' });
  const back = () => rowOf().waitFor({ state: 'visible', timeout: 8000 });

  // grants for a source that is no longer configured go with any save: a links-only change sends the sources too, without them
  await bob.click();
  await heading().waitFor({ state: 'visible', timeout: 8000 });
  await sys.getByText('Not configured now:').waitFor({ state: 'visible' });
  assert.equal(await save().isDisabled(), false, `Save is on while a grant is to be left out (${label})`);
  await links.getByRole('button', { name: 'Remove login b@x.y' }).click();
  await save().click();
  await back();
  assert.deepEqual(adminApi.calls.map((c) => `${c.kind}:${c.name}`), ['tailnet:bob', 'sources:bob'], `the links go first, then the sources (${label})`);
  assert.deepEqual(adminApi.calls[1].body, { sources: {} }, `the source that is not configured is left out (${label})`);
  assert.deepEqual(adminApi.calls[0].body, { links: ['a@x.y'] }, `the links body (${label})`);

  // nothing to save: Save is off, and removing a link and adding it back is no change (Cancel closes without asking)
  await bob.click();
  await heading().waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await save().isDisabled(), true, `Save is off with nothing to save (${label})`);
  await links.getByRole('button', { name: 'Remove login a@x.y' }).click();
  assert.equal(await save().isDisabled(), false, `a removed link is a change (${label})`);
  await add('A@X.Y');
  assert.equal(await save().isDisabled(), true, `removing a link and adding it back is no change (${label})`);
  await sys.getByRole('button', { name: 'Cancel', exact: true }).click();
  await back();
  assert.equal(await discard.count(), 0, `no prompt for no change (${label})`);
  assert.equal(adminApi.calls.length, 2, `nothing was sent (${label})`);

  // a links-only change asks before it is dropped
  await bob.click();
  await heading().waitFor({ state: 'visible', timeout: 8000 });
  await links.getByRole('button', { name: 'Remove login a@x.y' }).click();
  await pressEscape(page);
  await discard.waitFor({ state: 'visible', timeout: 8000 });
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await discard.waitFor({ state: 'detached', timeout: 8000 });
  // so does text left in the link field, and Save refuses it
  await links.getByRole('button', { name: 'Add', exact: true }).waitFor({ state: 'visible' });
  await field.fill('c@x.y');
  await save().click();
  await sys.getByRole('alert').filter({ hasText: 'Add or clear the link you typed before saving.' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT', null, { timeout: 8000 });
  await runAxe(page, `system users editor, field refused ${label}`, failures);
  await field.fill('');
  await sys.getByRole('button', { name: 'Cancel', exact: true }).click();
  await discard.waitFor({ state: 'visible', timeout: 8000 });
  await discard.getByRole('button', { name: 'Discard' }).click();
  await back();
  assert.equal(adminApi.calls.length, 2, `nothing was sent (${label})`);

  // a refused links call saves nothing: no second call is made
  adminApi.failTailnet = true;
  await bob.click();
  await heading().waitFor({ state: 'visible', timeout: 8000 });
  await sys.getByRole('button', { name: /^Access to fixture-s3/ }).click();
  await page.getByRole('menuitemradio', { name: 'Read only' }).click();
  await add('c@x.y');
  await save().click();
  await sys.getByRole('alert').filter({ hasText: 'no machine has a system user bob' }).waitFor({ state: 'visible', timeout: 8000 });
  assert.deepEqual(adminApi.calls.slice(2).map((c) => `${c.kind}:${c.name}`), ['tailnet:bob'], `a refused links call stops the save (${label})`);
  adminApi.failTailnet = false;

  // links saved, sources refused: the alert says what was saved, and the list is read again when the editor closes
  adminApi.failSources = true;
  await save().click();
  await sys.getByRole('alert').filter({ hasText: 'Links saved; sources not saved: source refused' }).waitFor({ state: 'visible', timeout: 8000 });
  await overflow('system users editor, half saved');
  await runAxe(page, `system users editor, half saved ${label}`, failures);
  adminApi.failSources = false;
  await sys.getByRole('button', { name: 'Cancel', exact: true }).click();
  await discard.waitFor({ state: 'visible', timeout: 8000 });
  await discard.getByRole('button', { name: 'Discard' }).click();
  await back();
  await rowOf().locator('bdi', { hasText: 'c@x.y' }).waitFor({ state: 'visible', timeout: 8000 });

  // an editor with a tag and the headers note
  adminApi.tailscale = 'headers';
  await sys.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(300);
  await bob.click();
  await heading().waitFor({ state: 'visible', timeout: 8000 });
  await add('tag:ci');
  await sys.getByText('Tag links need the socket source; they do not work on this hub now.').waitFor({ state: 'visible' });
  await field.fill('tag:ops');
  assert.match(await field.getAttribute('aria-describedby'), /-risk /, `the tag warning is part of the field's description while a tag is typed (${label})`);
  await field.fill('');
  await overflow('system users editor, headers');
  // Tab to Add: the browser scrolls it clear of the sticky Cancel and Save bar (scroll-padding on the Accounts body), as it does for a keyboard user
  await sys.getByRole('button', { name: 'Add', exact: true }).focus();
  await runAxe(page, `system users editor, tag and headers note ${label}`, failures);
  await sys.getByRole('button', { name: 'Cancel', exact: true }).click();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await back();
  adminApi.tailscale = 'socket';
  await sys.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(300);
}

// One's own system account: changing sources and links together cannot be saved in one go, and that is said at once, before the confirm.
async function verifySystemOwnAccount(browser, scheme, failures) {
  const adminApi = { posts: [], sysExtra: [{ name: 'fixture-sys', sources: {}, tailnet: [] }] };
  const { context, page } = await openPage(browser, { colorScheme: scheme, state: directState(), fixture: { account: 'fixture-sys', kind: 'sys', admin: true, adminApi, requests: [] } });
  try {
    await page.getByRole('button', { name: 'Account: fixture-sys' }).click();
    await page.getByRole('menuitem', { name: 'Accounts…' }).click();
    const view = page.getByRole('dialog', { name: 'Accounts' });
    await view.waitFor({ state: 'visible', timeout: 8000 });
    await view.getByRole('tab', { name: 'System users' }).click();
    const sys = view.getByRole('tabpanel', { name: 'System users' });
    await sys.getByRole('button', { name: 'Edit sources and Tailscale links of fixture-sys' }).click();
    await sys.getByRole('heading', { name: 'Sources of fixture-sys' }).waitFor({ state: 'visible', timeout: 8000 });
    await sys.getByRole('button', { name: /^Access to fixture-s3/ }).click();
    await page.getByRole('menuitemradio', { name: 'Read only' }).click();
    const links = sys.getByRole('region', { name: 'Tailscale' });
    await links.getByRole('textbox', { name: 'Tailnet login or tag' }).fill('a@x.y');
    await links.getByRole('button', { name: 'Add', exact: true }).click();
    const save = sys.getByRole('button', { name: 'Save', exact: true });
    await save.click();
    await sys.getByRole('alert').filter({ hasText: 'Save the sources and the Tailscale links one after the other.' }).waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.getByRole('dialog', { name: 'Change your own account' }).count(), 0, `no confirm opens for a save that cannot go ahead (${scheme})`);
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Save', null, { timeout: 8000 });
    assert.deepEqual(adminApi.calls, [], `nothing was sent (${scheme})`);
    await settled(page);
    await runAxe(page, `system users editor, own account refused ${scheme}`, failures);
    // sources alone: the confirm opens, and Cancel gives focus back to Save
    await links.getByRole('button', { name: 'Remove login a@x.y' }).click();
    await save.click();
    const own = page.getByRole('dialog', { name: 'Change your own account' });
    await own.waitFor({ state: 'visible', timeout: 8000 });
    await own.getByRole('button', { name: 'Cancel' }).click();
    await own.waitFor({ state: 'detached', timeout: 8000 });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Save', null, { timeout: 8000 });
    assert.deepEqual(adminApi.calls, [], `Cancel sends nothing (${scheme})`);
  } finally {
    await context.close();
  }
}

async function verifyAccounts(browser, schemes = ['light', 'dark']) {
  const failures = [];
  const password = 'fixture account password';
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const label = `${viewport.width}x${viewport.height} ${scheme}`;
      const adminApi = { posts: [], conflict: true, sysExtra: [{ name: 'bob', sources: { 'fixture-retired': { write: true } }, tailnet: ['a@x.y', 'b@x.y'] }] };
      const fixture = { account: 'fixture-admin', kind: 'virt', admin: true, adminApi, requests: [] };
      const { context, page } = await openPage(browser, { viewport, colorScheme: scheme, state: directState(), fixture, fakeClock: true });
      try {
        const overflow = async (what) => {
          const o = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            body: document.body.scrollWidth,
            dialog: Math.max(0, ...[...document.querySelectorAll('[role=dialog]')].map((e) => e.getBoundingClientRect().right)),
            // content that sticks out of the overlay's own box (the overlay scrolls up and down, never sideways)
            inner: (() => { const b = document.querySelector('.acc-body'); return b ? b.scrollWidth - b.clientWidth : 0; })(),
          }));
          if (o.scroll > o.client + 1 || o.body > o.client + 1 || o.dialog > o.client + 1 || o.inner > 1) failures.push({ view: `${what} ${label}`, rule: 'horizontal overflow', ...o });
        };
        // on a phone the account menu sits in the header too
        await page.getByRole('button', { name: 'Account: fixture-admin' }).click();
        await page.getByRole('menuitem', { name: 'Accounts…' }).click();
        const view = page.getByRole('dialog', { name: 'Accounts' });
        await view.waitFor({ state: 'visible', timeout: 8000 });
        await view.getByRole('cell', { name: 'fixture-guest', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
        await overflow('list');
        // old saved passwords: the notice counts them; its axe run is the list's
        const notice = view.getByRole('region', { name: 'Old saved passwords' });
        await notice.getByText('2 saved passwords from before sign-in was on are kept but not used.').waitFor({ state: 'visible', timeout: 8000 });
        await runAxe(page, `accounts list ${label}`, failures);

        // forget the old passwords after a confirm; the notice goes away and focus goes to the list's heading
        await notice.getByRole('button', { name: 'Forget them' }).click();
        const forget = page.getByRole('dialog', { name: 'Forget saved passwords' });
        await forget.waitFor({ state: 'visible', timeout: 8000 });
        await settled(page);
        await runAxe(page, `forget confirm ${label}`, failures);
        assert.equal(adminApi.forgot, 0, `nothing is sent before the confirm (${label})`);
        await forget.getByRole('button', { name: 'Forget them' }).click();
        await notice.waitFor({ state: 'detached', timeout: 8000 });
        assert.equal(adminApi.forgot, 1, `one DELETE of the old passwords (${label})`);
        await page.waitForFunction(() => document.activeElement?.textContent === 'Virtual accounts', null, { timeout: 8000 });

        // closing the view with an unsaved editor asks first, from another tab too (Escape) and from the header's Close
        await view.getByRole('button', { name: 'Edit fixture-guest' }).click();
        const guestRunAs = view.locator('.acc-machine').filter({ hasText: nodeName }).getByRole('textbox', { name: 'Run as (system user)' });
        await guestRunAs.fill('fixture-other');
        await view.getByRole('tab', { name: 'Signed in' }).click();
        await pressEscape(page);
        const keep = page.getByRole('dialog', { name: 'Discard changes?' });
        await keep.waitFor({ state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Keep editing', null, { timeout: 8000 });
        await keep.getByRole('button', { name: 'Keep editing' }).click();
        await keep.waitFor({ state: 'detached', timeout: 8000 });
        assert.equal(await view.isVisible(), true, `Keep editing leaves the view open (${label})`);
        await view.getByRole('tab', { name: 'Signed in' }).click();
        await view.getByRole('button', { name: 'Close', exact: true }).click();
        await keep.waitFor({ state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Keep editing', null, { timeout: 8000 });
        await keep.getByRole('button', { name: 'Keep editing' }).click();
        await keep.waitFor({ state: 'detached', timeout: 8000 });
        assert.equal(await guestRunAs.inputValue(), 'fixture-other', `the typed text is still there (${label})`);
        await view.getByRole('button', { name: 'Cancel', exact: true }).click();
        await keep.getByRole('button', { name: 'Discard' }).click();
        await view.getByRole('cell', { name: 'fixture-guest', exact: true }).waitFor({ state: 'visible', timeout: 8000 });

        // the tabs are a tablist: aria-selected, arrow keys, and a tabpanel named by the tab
        const tabs = view.getByRole('tablist', { name: 'Accounts sections' });
        assert.deepEqual(await tabs.getByRole('tab').evaluateAll((els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-selected')])), [['Accounts', 'true'], ['Signed in', 'false'], ['System users', 'false']], `tabs (${label})`);
        await tabs.getByRole('tab', { name: 'Accounts' }).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Signed in' && document.activeElement.getAttribute('aria-selected') === 'true', null, { timeout: 8000 });
        // Home and End move to the first and last tab
        await page.keyboard.press('End');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'System users' && document.activeElement.getAttribute('aria-selected') === 'true', null, { timeout: 8000 });
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Accounts' && document.activeElement.getAttribute('aria-selected') === 'true', null, { timeout: 8000 });
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Signed in' && document.activeElement.getAttribute('aria-selected') === 'true', null, { timeout: 8000 });
        const panel = view.getByRole('tabpanel', { name: 'Signed in' });
        const rowOf = (address) => panel.getByRole('row').filter({ hasText: address });
        await panel.getByRole('heading', { name: 'Signed in' }).waitFor({ state: 'visible', timeout: 8000 });
        const mine = panel.getByRole('row').filter({ hasText: 'This session' });
        await mine.getByText('203.0.113.7').waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(await panel.getByText('This session').count(), 1, `the caller's session is marked once (${label})`);
        assert.equal(await panel.locator('bdi', { hasText: '198.51.100.9' }).count(), 1, `an address is isolated in bdi (${label})`);
        // how each session signed in: the method, and for Tailscale the source, the login or tag that matched and the device (all in <bdi>)
        const ciRow = rowOf('100.64.0.9');
        assert.match(await ciRow.innerText(), /Tailscale \(socket\)/, `a Tailscale session names its source (${label})`);
        assert.equal(await ciRow.locator('bdi', { hasText: 'tag:ci' }).count(), 1, `the matched tag is isolated in bdi (${label})`);
        assert.equal(await ciRow.locator('bdi', { hasText: 'ci-runner' }).count(), 1, `the device is isolated in bdi (${label})`);
        assert.match(await rowOf('192.0.2.5').innerText(), /Tailscale\s+alice@github/, `a Tailscale session without a known source names the login (${label})`);
        assert.match(await rowOf('198.51.100.9').innerText(), /\bKey\b/, `a key session says Key (${label})`);
        assert.match(await mine.innerText(), /\bPassword\b/, `a password session says Password (${label})`);
        await overflow('sessions');
        await runAxe(page, `signed in tab ${label}`, failures);
        // End all sessions asks first, says jobs are cancelled, and sending nothing until confirmed
        await panel.getByRole('button', { name: 'End all sessions of fixture-guest' }).click();
        const endAll = page.getByRole('dialog', { name: 'End all sessions' });
        await endAll.waitFor({ state: 'visible', timeout: 8000 });
        await endAll.getByText(/jobs are cancelled/).waitFor({ state: 'visible' });
        assert.equal(await endAll.getByText(/signed out too/).count(), 0, `no own-account warning for another account (${label})`);
        assert.deepEqual(adminApi.endedAll, [], `nothing is sent before the confirm (${label})`);
        await settled(page);
        await runAxe(page, `end all sessions confirm ${label}`, failures);
        await endAll.getByRole('button', { name: 'Cancel' }).click();
        await endAll.waitFor({ state: 'detached', timeout: 8000 });
        await focusStaysOn(page, panel.getByRole('button', { name: 'End all sessions of fixture-guest' }), `focus returns to the button that opened the confirm (${label})`);
        // your own account: the confirm warns that you are signed out too
        await panel.getByRole('button', { name: 'End all sessions of fixture-admin' }).click();
        await endAll.waitFor({ state: 'visible', timeout: 8000 });
        await endAll.getByText(/signed out too/).waitFor({ state: 'visible' });
        await endAll.getByRole('button', { name: 'Cancel' }).click();
        await endAll.waitFor({ state: 'detached', timeout: 8000 });
        // End on the other session sends its DELETE and the row goes away
        await rowOf('198.51.100.9').getByRole('button', { name: 'End', exact: true }).click();
        await page.waitForFunction(() => ![...document.querySelectorAll('tr')].some((r) => r.textContent.includes('198.51.100.9')), null, { timeout: 8000 });
        assert.deepEqual(adminApi.ended, ['bb22bb22'], `End sends one DELETE for that session (${label})`);
        // confirming "End all sessions" sends the POST, and the account's remaining row goes away when the list refreshes
        await panel.getByRole('button', { name: 'End all sessions of fixture-guest' }).click();
        await endAll.waitFor({ state: 'visible', timeout: 8000 });
        await endAll.getByRole('button', { name: 'End all sessions', exact: true }).click();
        await endAll.waitFor({ state: 'detached', timeout: 8000 });
        await page.waitForFunction(() => ![...document.querySelectorAll('tr')].some((r) => r.textContent.includes('192.0.2.5')), null, { timeout: 8000 });
        assert.deepEqual(adminApi.endedAll, [{ kind: 'virt', name: 'fixture-guest' }], `confirming sends one POST (${label})`);
        assert.equal(await panel.getByRole('button', { name: 'End all sessions of fixture-guest' }).count(), 0, `the account's group is gone (${label})`);
        // the caller's own End asks first (and reloads the page after it: not run here, the fixture page would lose its state)
        await mine.getByRole('button', { name: 'End', exact: true }).click();
        const endOwn = page.getByRole('dialog', { name: 'End your own session' });
        await endOwn.waitFor({ state: 'visible', timeout: 8000 });
        await endOwn.getByRole('button', { name: 'Cancel' }).click();
        await endOwn.waitFor({ state: 'detached', timeout: 8000 });
        assert.deepEqual(adminApi.ended, ['bb22bb22'], `Cancel on one's own session sends nothing (${label})`);
        // the list refreshes every 30 s only while its tab is shown
        const polled = adminApi.sessionCalls;
        await page.clock.fastForward(31_000);
        await expectMore(() => adminApi.sessionCalls, polled, `the list refreshes while the tab is shown (${label})`);

        await tabs.getByRole('tab', { name: 'Signed in' }).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'System users', null, { timeout: 8000 });
        const sys = view.getByRole('tabpanel', { name: 'System users' });
        await sys.getByRole('heading', { name: 'System users' }).waitFor({ state: 'visible', timeout: 8000 });
        await sys.getByRole('cell', { name: 'fixture-root', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
        const afterAway = adminApi.sessionCalls;
        await page.clock.fastForward(95_000);
        await page.waitForTimeout(300);
        assert.equal(adminApi.sessionCalls, afterAway, `the list does not refresh while another tab is shown (${label})`);
        await overflow('system users');
        await runAxe(page, `system users tab ${label}`, failures);
        assert.equal(await sys.getByRole('button', { name: 'Edit sources and Tailscale links of bob' }).count(), 1, `the edit label names the links (${label})`);
        await sys.getByRole('button', { name: 'Add system user' }).click();
        const nameField = sys.getByRole('textbox', { name: 'System user name' });
        await nameField.fill('root');
        await sys.getByRole('button', { name: 'Continue' }).click();
        await sys.getByRole('alert').filter({ hasText: 'root' }).waitFor({ state: 'visible', timeout: 8000 });
        await nameField.fill('alice');
        await sys.getByRole('button', { name: 'Continue' }).click();
        await sys.getByRole('heading', { name: 'Sources of alice' }).waitFor({ state: 'visible', timeout: 8000 });
        await sys.getByRole('button', { name: /^Access to fixture-s3/ }).click();
        await page.getByRole('menuitemradio', { name: 'Read only' }).click();
        // the same Tailscale section as the account editor: a login is added with Enter and saved with one PUT of its own
        const sysLinks = sys.getByRole('region', { name: 'Tailscale' });
        await sysLinks.getByRole('textbox', { name: 'Tailnet login or tag' }).fill('Alice@GitHub');
        await sysLinks.getByRole('button', { name: 'Add', exact: true }).click();
        await sysLinks.getByRole('list', { name: 'Tailnet links' }).getByText('Login', { exact: true }).waitFor({ state: 'visible' });
        await overflow('system user sources');
        // unsaved sources ask before Escape or Close drops them
        await pressEscape(page);
        const keepSys = page.getByRole('dialog', { name: 'Discard changes?' });
        await keepSys.waitFor({ state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Keep editing', null, { timeout: 8000 });
        await keepSys.getByRole('button', { name: 'Keep editing' }).click();
        await keepSys.waitFor({ state: 'detached', timeout: 8000 });
        await view.getByRole('button', { name: 'Close', exact: true }).click();
        await keepSys.waitFor({ state: 'visible', timeout: 8000 });
        await keepSys.getByRole('button', { name: 'Keep editing' }).click();
        await keepSys.waitFor({ state: 'detached', timeout: 8000 });
        await sys.getByRole('heading', { name: 'Sources of alice' }).waitFor({ state: 'visible' });
        await runAxe(page, `system user sources ${label}`, failures);
        await sys.getByRole('button', { name: 'Save', exact: true }).click();
        await sys.getByRole('cell', { name: 'alice', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
        assert.deepEqual(adminApi.puts, [{ sources: { 'fixture-s3': { write: false } } }], `one PUT with the source (${label})`);
        assert.deepEqual(adminApi.tputs, [{ links: ['alice@github'] }], `one PUT with the link (${label})`);
        assert.equal(await sys.getByRole('row').filter({ hasText: 'alice' }).locator('bdi', { hasText: 'alice@github' }).count(), 1, `the list shows the link in bdi (${label})`);
        await settled(page);
        await runAxe(page, `system users tab with links ${label}`, failures);
        await verifySystemEditor({ page, view, sys, adminApi, label, failures, overflow });
        await tabs.getByRole('tab', { name: 'Accounts' }).click();
        await view.getByRole('cell', { name: 'fixture-guest', exact: true }).waitFor({ state: 'visible', timeout: 8000 });

        // the link editor of an existing account: a login and a tag are listed with their kind, the tag with its warning
        await view.getByRole('button', { name: 'Edit fixture-guest' }).click();
        await view.getByRole('heading', { name: 'Edit fixture-guest' }).waitFor({ state: 'visible', timeout: 8000 });
        const links = view.getByRole('region', { name: 'Tailscale' });
        const linkField = links.getByRole('textbox', { name: 'Tailnet login or tag' });
        const linkList = links.getByRole('list', { name: 'Tailnet links' });
        const RISK = 'Anyone who may apply this tag in your tailnet can make a device that signs in as this account.';
        await links.getByText('For example alice@github or tag:server.').waitFor({ state: 'visible' });
        await linkField.fill('tag:ci');
        assert.equal(await links.getByText(RISK).count(), 1, `typing a tag shows the warning before it is added (${label})`);
        await linkField.fill('tag:a_b');
        await links.getByRole('button', { name: 'Add', exact: true }).click();
        await links.getByRole('alert').filter({ hasText: 'not a tailnet login or tag' }).waitFor({ state: 'visible' });
        assert.equal(await linkField.getAttribute('aria-invalid'), 'true', `the bad value marks the field (${label})`);
        assert.ok((await linkField.getAttribute('aria-describedby')).split(' ').includes(await links.getByRole('alert').getAttribute('id')), `the error is tied to the field (${label})`);
        assert.equal(await linkList.count(), 0, `a bad value is not added (${label})`);
        await linkField.fill('alice@github');
        await links.getByRole('button', { name: 'Add', exact: true }).click();
        await linkField.fill('TAG:CI');
        await linkField.press('Enter');
        await linkField.fill('alice@github');
        await links.getByRole('button', { name: 'Add', exact: true }).click();
        await links.getByRole('alert').filter({ hasText: 'already in the list' }).waitFor({ state: 'visible' });
        // text left in the field is not saved by accident: Save refuses and puts focus in the field; it also counts as unsaved
        await view.getByRole('button', { name: 'Save', exact: true }).click();
        await view.getByRole('alert').filter({ hasText: 'Add or clear the link you typed before saving.' }).waitFor({ state: 'visible' });
        await focusStaysOn(page, linkField, `a refused Save puts focus in the link field (${label})`);
        assert.equal(adminApi.patches.length, 0, `nothing is sent while the field holds text (${label})`);
        await linkField.fill('');
        assert.deepEqual(await linkList.getByRole('listitem').evaluateAll((els) => els.map((e) => e.querySelector('.pill').textContent + ':' + e.querySelector('bdi').textContent)), ['Login:alice@github', 'Tag:tag:ci'], `the links are listed with their kind (${label})`);
        assert.equal(await linkList.locator('bdi').count(), 2, `each subject is in bdi (${label})`);
        assert.equal(await linkList.getByText(RISK).count(), 1, `the listed tag shows the warning (${label})`);
        await overflow('link editor');
        await runAxe(page, `link editor ${label}`, failures);
        // a refusal of the hub shows its text in the alert next to Save, and nothing is closed
        adminApi.patchConflict = true;
        await view.getByRole('button', { name: 'Save', exact: true }).click();
        await view.getByRole('alert').filter({ hasText: 'this tag is linked to virt:fixture-other' }).waitFor({ state: 'visible', timeout: 8000 });
        await runAxe(page, `link editor, refused ${label}`, failures);
        adminApi.patchConflict = false;
        await view.getByRole('button', { name: 'Save', exact: true }).click();
        await view.getByRole('status').filter({ hasText: 'Account fixture-guest saved.' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(adminApi.patches.length, 2, `each Save sends one PATCH (${label})`);
        assert.deepEqual(adminApi.patches.map((b) => b.tailnet), [['alice@github', 'tag:ci'], ['alice@github', 'tag:ci']], `the PATCH carries the links (${label})`);
        await view.getByRole('row').filter({ hasText: 'fixture-guest' }).getByText('Tailscale', { exact: true }).waitFor({ state: 'visible', timeout: 8000 });

        // the notes follow the hub's source: off, then headers with a tag listed
        adminApi.tailscale = null;
        await view.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(300);
        await view.getByRole('button', { name: 'Edit fixture-guest' }).click();
        await view.getByText('Tailscale sign-in is off on this hub. Links are kept and work once it is turned on.').waitFor({ state: 'visible', timeout: 8000 });
        await runAxe(page, `link editor, Tailscale off ${label}`, failures);
        await view.getByRole('button', { name: 'Cancel', exact: true }).click();
        adminApi.tailscale = 'headers';
        await view.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(300);
        await view.getByRole('button', { name: 'Edit fixture-guest' }).click();
        await view.getByText('Tag links need the socket source; they do not work on this hub now.').waitFor({ state: 'visible', timeout: 8000 });
        await overflow('link editor, headers');
        await runAxe(page, `link editor, headers ${label}`, failures);
        // keyboard only: the field, Add and each Remove are reached with Tab and work with Enter; focus goes back to the field
        const active = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim());
        await linkField.focus();
        await page.keyboard.type('bob@github');
        await page.keyboard.press('Tab');
        assert.equal(await active(), 'Add', `Tab from the field reaches Add (${label})`);
        await page.keyboard.press('Enter');
        await linkList.getByText('bob@github').waitFor({ state: 'visible' });
        await linkField.focus();
        await page.keyboard.press('Shift+Tab');
        assert.equal(await active(), 'Remove login bob@github', `Shift+Tab from the field reaches the last Remove (${label})`);
        assert.equal(await links.getByText(/Removing a link ends the sessions/).count(), 0, `a link that was never saved says nothing about sessions (${label})`);
        await page.keyboard.press('Enter');
        await linkList.getByText('bob@github').waitFor({ state: 'detached' });
        await focusStaysOn(page, linkField, `removing a link returns focus to the field (${label})`);
        // taking off a saved link says before saving that its sessions end
        await linkList.getByRole('button', { name: 'Remove tag tag:ci' }).click();
        await links.getByText('Removing a link ends the sessions that signed in through it when you save.').waitFor({ state: 'visible' });
        await runAxe(page, `link editor, link removed ${label}`, failures);
        await view.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();
        await view.getByRole('cell', { name: 'fixture-guest', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
        adminApi.tailscale = 'socket';
        await view.getByRole('button', { name: 'Refresh' }).click();
        await page.waitForTimeout(300);

        await view.getByRole('button', { name: 'New account' }).click();
        await view.getByRole('textbox', { name: 'Name' }).fill('fixture-new');
        await view.getByLabel('Password', { exact: true }).fill(password);
        const machine = view.locator('.acc-machine').filter({ hasText: nodeName });
        await machine.getByRole('textbox', { name: 'Run as (system user)' }).fill('fixture-run');
        await overflow('editor');
        await runAxe(page, `account editor ${label}`, failures);

        await machine.getByRole('button', { name: 'Add folder…' }).click();
        const picker = page.getByRole('dialog', { name: 'Add folder' });
        await picker.waitFor({ state: 'visible', timeout: 8000 });
        await picker.getByRole('button', { name: 'work', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.acc-pick-path input')?.value === '/work', null, { timeout: 8000 });
        await picker.getByRole('region', { name: 'Folders' }).and(page.locator('[aria-busy=false]')).waitFor({ timeout: 8000 });
        await overflow('picker');
        await settled(page);
        await runAxe(page, `folder picker ${label}`, failures);
        await picker.getByRole('button', { name: 'Add folder', exact: true }).click();
        await picker.waitFor({ state: 'detached', timeout: 8000 });
        await machine.getByText('/work', { exact: true }).waitFor({ state: 'visible' });
        // Escape in the picker closes the picker only: the view and the editor with its typed text stay
        await machine.getByRole('button', { name: 'Add folder…' }).click();
        await picker.waitFor({ state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]')?.getAttribute('aria-label') === 'Add folder', null, { timeout: 8000 });
        await pressEscape(page);
        await picker.waitFor({ state: 'detached', timeout: 8000 });
        await focusStaysOn(page, machine.getByRole('button', { name: 'Add folder…' }), `Escape in the picker returns focus to "Add folder…" (${label})`);
        assert.equal(await view.getByRole('textbox', { name: 'Name' }).inputValue(), 'fixture-new', `the editor stays open (${label})`);

        await view.getByRole('button', { name: 'Create account' }).click();
        await view.getByRole('alert').filter({ hasText: 'exists' }).waitFor({ state: 'visible', timeout: 8000 });
        const expected = { name: 'fixture-new', password, admin: false, nodes: { [nodeName]: { runAs: 'fixture-run', grants: [{ path: '/work', write: false }] } }, sources: {}, tailnet: [] };
        assert.deepEqual(adminApi.posts, [expected], `one POST with the form's body (${label})`);
        await runAxe(page, `account editor, refused ${label}`, failures);

        // created: the new account's editor opens (for its keys), focus on its heading; Escape with no changes goes back to the list
        adminApi.conflict = false;
        await view.getByRole('button', { name: 'Create account' }).click();
        await view.getByRole('heading', { name: 'Edit fixture-new' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(adminApi.posts.length, 2, `the second try sends the second POST (${label})`);
        await view.getByRole('status').filter({ hasText: 'Account fixture-new created.' }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.activeElement?.textContent === 'Edit fixture-new', null, { timeout: 8000 });
        await pressEscape(page);
        await view.getByRole('cell', { name: 'fixture-new', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
        await page.waitForFunction(() => document.activeElement?.textContent === 'Virtual accounts', null, { timeout: 8000 });

        if (fixture.requests.some((r) => r.includes(encodeURIComponent(password)) || r.includes(password))) failures.push({ view: label, rule: 'password in a URL' });
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
        if (stored.includes(password)) failures.push({ view: label, rule: 'password kept in storage' });

        if (viewport.width === 1365) {
          await verifySystemOwnAccount(browser, scheme, failures);
          // the overlay fits the window and opening it scrolled nothing (Accounts here, Settings below)
          const fits = (sel) => page.evaluate((s) => ({ top: document.scrollingElement.scrollTop, bottom: document.querySelector(s)?.getBoundingClientRect().bottom ?? 0, height: innerHeight }), sel);
          const fit = await fits('.acc-view');
          if (fit.top !== 0 || fit.bottom > fit.height + 1) failures.push({ view: `Accounts ${label}`, rule: 'overlay scrolls the page or ends below the window', ...fit });

          // an existing account with a machine and a source that are no longer configured; unsaved changes ask before they go
          await view.getByRole('button', { name: 'Edit fixture-guest' }).click();
          await view.getByRole('heading', { name: 'Edit fixture-guest' }).waitFor({ state: 'visible', timeout: 8000 });
          await view.locator('.acc-machine').filter({ hasText: 'fixture-retired' }).getByText('(not configured now)').waitFor({ state: 'visible' });
          await view.locator('.acc-sources li').filter({ hasText: 'fixture-gone' }).getByText('(not configured now)').waitFor({ state: 'visible' });
          await runAxe(page, `existing account editor ${label}`, failures);
          const runAs = view.locator('.acc-machine').filter({ hasText: nodeName }).getByRole('textbox', { name: 'Run as (system user)' });
          await runAs.fill('fixture-other');
          await pressEscape(page);
          const discard = page.getByRole('dialog', { name: 'Discard changes?' });
          await discard.waitFor({ state: 'visible', timeout: 8000 });
          await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Keep editing', null, { timeout: 8000 });
          await settled(page);
          await runAxe(page, `discard changes ${label}`, failures);
          // "Keep editing" gives focus back to what opened the prompt: the field Escape was pressed in, then the Cancel button
          await discard.getByRole('button', { name: 'Keep editing' }).click();
          await discard.waitFor({ state: 'detached', timeout: 8000 });
          await focusStaysOn(page, runAs, `"Keep editing" returns focus to the field Escape was pressed in (${label})`);
          const cancel = view.getByRole('button', { name: 'Cancel', exact: true });
          await cancel.click();
          await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Keep editing', null, { timeout: 8000 });
          await page.keyboard.press('Enter');
          await discard.waitFor({ state: 'detached', timeout: 8000 });
          await focusStaysOn(page, cancel, `"Keep editing" returns focus to Cancel (${label})`);
          await cancel.click();
          await discard.getByRole('button', { name: 'Discard' }).click();
          await view.getByRole('cell', { name: 'fixture-guest', exact: true }).waitFor({ state: 'visible', timeout: 8000 });

          await view.getByRole('button', { name: 'Delete fixture-guest' }).click();
          const del = page.getByRole('dialog', { name: 'Delete account' });
          await del.waitFor({ state: 'visible', timeout: 8000 });
          await settled(page);
          await runAxe(page, `delete confirm ${label}`, failures);
          await del.getByRole('button', { name: 'Cancel' }).click();
          await del.waitFor({ state: 'detached', timeout: 8000 });

          // one's own account: the banner, and Save asks first
          await view.getByRole('button', { name: 'Edit fixture-admin' }).click();
          await view.getByText('This is your own account.').waitFor({ state: 'visible', timeout: 8000 });
          await runAxe(page, `own account editor ${label}`, failures);
          await view.getByRole('button', { name: 'Save', exact: true }).click();
          const own = page.getByRole('dialog', { name: 'Change your own account' });
          await own.waitFor({ state: 'visible', timeout: 8000 });
          await settled(page);
          await runAxe(page, `own account confirm ${label}`, failures);
          await own.getByRole('button', { name: 'Cancel' }).click();
          await own.waitFor({ state: 'detached', timeout: 8000 });

          // one view at a time: Settings closes Accounts, and it too fits the window without scrolling the page
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 8000 });
          await view.waitFor({ state: 'detached', timeout: 8000 });
          const sfit = await fits('.settings.over');
          if (sfit.top !== 0 || sfit.bottom > sfit.height + 1) failures.push({ view: `Settings ${label}`, rule: 'overlay scrolls the page or ends below the window', ...sfit });
        } else {
          await pressEscape(page);
          await view.waitFor({ state: 'detached', timeout: 8000 });
        }
      } finally {
        await context.close();
      }
    }
  }
  if (!schemes.includes('light')) {
    assert.deepEqual(failures, [], 'the Accounts view passes axe, fits the window and keeps the password out of URLs and storage');
    return;
  }
  // closing the view clears the refresh: with the Signed in tab shown, close, move the clock on, and no list is asked for
  {
    const adminApi = { posts: [] };
    const { context, page } = await openPage(browser, { state: directState(), fixture: { account: 'fixture-admin', kind: 'virt', admin: true, adminApi }, fakeClock: true });
    try {
      await page.getByRole('button', { name: 'Account: fixture-admin' }).click();
      await page.getByRole('menuitem', { name: 'Accounts…' }).click();
      const view = page.getByRole('dialog', { name: 'Accounts' });
      await view.getByRole('tab', { name: 'Signed in' }).click();
      await view.getByRole('tabpanel', { name: 'Signed in' }).getByText('This session').waitFor({ state: 'visible', timeout: 8000 });
      await pressEscape(page);
      await view.waitFor({ state: 'detached', timeout: 8000 });
      const n = adminApi.sessionCalls;
      await page.clock.fastForward(95_000);
      await page.waitForTimeout(300);
      assert.equal(adminApi.sessionCalls, n, 'closing the view stops the refresh');
    } finally {
      await context.close();
    }
  }
  // "Acting as root" shows for a session the hub lists with asRootUntil, whatever the page's clock says (here 20 minutes ahead); ending
  // one's own session asks, then the page reloads: a marker set on the page is gone afterwards and the hub got the DELETE
  {
    const mine = { id: 'dd44dd44', kind: 'sys', name: 'fixture-root', created: Date.now() - 600_000, lastUsed: Date.now() - 1000, address: '203.0.113.7', asRootUntil: Date.now() + 10 * 60_000, current: true };
    const adminApi = { posts: [], sessions: [mine] };
    const { context, page } = await openPage(browser, { state: directState(), fixture: { account: 'fixture-root', kind: 'sys', admin: true, adminApi }, clockOffsetMs: 20 * 60_000 });
    try {
      await page.getByRole('button', { name: 'Account: fixture-root' }).click();
      await page.getByRole('menuitem', { name: 'Accounts…' }).click();
      const view = page.getByRole('dialog', { name: 'Accounts' });
      await view.getByRole('tab', { name: 'Signed in' }).click();
      const panel = view.getByRole('tabpanel', { name: 'Signed in' });
      await panel.getByText('Acting as root', { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
      await runAxe(page, 'signed in tab with the root pill', failures);
      await page.evaluate(() => { window.__beforeReload = true; });
      await panel.getByRole('row').filter({ hasText: 'This session' }).getByRole('button', { name: 'End', exact: true }).click();
      const own = page.getByRole('dialog', { name: 'End your own session' });
      await own.waitFor({ state: 'visible', timeout: 8000 });
      await own.getByRole('button', { name: 'End session' }).click();
      await page.waitForFunction(() => window.__beforeReload === undefined && document.readyState !== 'loading', null, { timeout: 15000 });
      assert.deepEqual(adminApi.ended, ['dd44dd44'], 'the own session was ended at the hub');
      await page.locator('.fp').first().waitFor({ state: 'visible', timeout: 15000 });
    } finally {
      await context.close();
    }
  }
  for (const [who, fixture, has] of [
    ['a system administrator', { account: 'fixture-root', kind: 'sys', admin: true }, true],
    ['a virtual account that is not an administrator', { account: 'fixture-user', kind: 'virt', admin: false }, false],
    ['a system account that is not an administrator', { account: 'fixture-user', kind: 'sys', admin: false }, false],
  ]) {
    const { context, page } = await openPage(browser, { state: directState(), fixture });
    try {
      await page.getByRole('button', { name: `Account: ${fixture.account}` }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('menuitem', { name: 'Accounts…' }).count(), has ? 1 : 0, `${who}: ${has ? 'the' : 'no'} "Accounts…" item`);
    } finally {
      await context.close();
    }
  }
  await verifyTailnetCanSignIn(browser);
  assert.deepEqual(failures, [], 'the Accounts view passes axe, fits the window and keeps the password out of URLs and storage');
}

// Tailnet links and "Can sign in", by the lock-out rule: with the headers source a tag link does not count and a login link does;
// with Tailscale off no link counts. The editor of an account with only a tag link says so under headers. The Signed in tab's
// Method column: "Tailscale (socket)" with the subject and "on" the device (each in <bdi>), "Tailscale (headers)", plain
// "Tailscale" for an unknown source, "Password" and "Key".
async function verifyTailnetCanSignIn(browser) {
  const now = Date.now();
  const sess = (id, address, more) => ({ id, kind: 'virt', name: 'fixture-tagonly', created: now - 3_600_000, lastUsed: now - 60_000, address, ...more });
  const adminApi = {
    posts: [],
    tailscale: 'headers',
    extra: [{ name: 'fixture-tagonly', tailnet: ['tag:ci'] }, { name: 'fixture-login', tailnet: ['alice@github'] }],
    sessions: [
      { ...sess('a1', '203.0.113.7', { method: 'password' }), name: 'fixture-admin', current: true },
      sess('a2', '203.0.113.21', { method: 'tailscale', tailnet: 'tag:ci', tailnetSource: 'socket', tailnetDevice: 'ci-runner' }),
      sess('a3', '203.0.113.22', { method: 'tailscale', tailnet: 'bob@github', tailnetSource: 'headers' }),
      sess('a4', '203.0.113.23', { method: 'tailscale' }),
      sess('a5', '203.0.113.24', { method: 'key' }),
    ],
  };
  const { context, page } = await openPage(browser, { state: directState(), fixture: { account: 'fixture-admin', kind: 'virt', admin: true, adminApi } });
  try {
    await page.getByRole('button', { name: 'Account: fixture-admin' }).click();
    await page.getByRole('menuitem', { name: 'Accounts…' }).click();
    const view = page.getByRole('dialog', { name: 'Accounts' });
    await view.waitFor({ state: 'visible', timeout: 8000 });
    const row = (name) => view.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    // (the cell also has a "Tailscale" pill when links exist)
    const signIn = async (name) => (await row(name).locator('td').nth(2).innerText()).trim().match(/^Can(not)? sign in/)?.[0];
    await row('fixture-tagonly').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await signIn('fixture-tagonly'), 'Cannot sign in', 'headers source: a tag link alone does not count');
    assert.equal(await signIn('fixture-login'), 'Can sign in', 'headers source: a login link counts');
    await view.getByRole('button', { name: 'Edit fixture-tagonly' }).click();
    await view.getByText('Without a password, a key or a tailnet link that works now, this account cannot sign in.', { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
    await view.getByRole('button', { name: 'Cancel', exact: true }).click();
    adminApi.tailscale = null;
    await view.getByRole('button', { name: 'Refresh' }).click();
    await row('fixture-login').filter({ hasText: 'Cannot sign in' }).waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await signIn('fixture-tagonly'), 'Cannot sign in', 'Tailscale off: no link counts');
    assert.equal(await signIn('fixture-login'), 'Cannot sign in', 'Tailscale off: no link counts');
    await view.getByRole('tab', { name: 'Signed in' }).click();
    const panel = view.getByRole('tabpanel', { name: 'Signed in' });
    const method = (address) => panel.getByRole('row').filter({ hasText: address }).locator('.sess-method');
    await method('203.0.113.21').waitFor({ state: 'visible', timeout: 8000 });
    const socket = method('203.0.113.21');
    assert.match((await socket.innerText()).replace(/\s+/g, ' ').trim(), /^Tailscale \(socket\) ?tag:ci ?on ci-runner$/, 'a socket session: source, subject and device');
    assert.deepEqual(await socket.locator('bdi').allInnerTexts(), ['tag:ci', 'ci-runner'], 'the subject and the device are in <bdi>');
    assert.match((await method('203.0.113.22').innerText()).replace(/\s+/g, ' ').trim(), /^Tailscale \(headers\) ?bob@github$/, 'a headers session');
    assert.equal((await method('203.0.113.23').innerText()).trim(), 'Tailscale', 'an unknown source: plain Tailscale');
    assert.equal((await method('203.0.113.7').innerText()).trim(), 'Password');
    assert.equal((await method('203.0.113.24').innerText()).trim(), 'Key');
  } finally {
    await context.close();
  }
}

// Act as root (a system administrator only): the "Act as root…" item opens a dialog with the sign-in fields; while the hub
// reports the switch the header shows "Acting as root until HH:MM" (local end from the hub's time left) with Stop. Banner and open dialog pass axe in light and dark and fit at 390x844
// and 320x568; the password is cleared after a failed attempt and is never stored. Stop and the end time hide the banner and
// ask the hub again. Non-admins and virtual accounts never see the item or the banner.
async function verifyActAsRoot(browser, schemes = ['light', 'dark']) {
  const once = schemes.includes('light');
  const failures = [];
  const hhmm = (t) => page0.evaluate((u) => { const d = new Date(u); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, t);
  // The page counts the end from its own clock after the request. A short delay can move the end into the next minute, so accept both minutes.
  const endsAt = async (t) => [await hhmm(t), await hhmm(t + 15_000)];
  let page0;
  const overflow = async (page, what) => {
    const o = await page.evaluate(() => {
      const right = (sel) => Math.max(0, ...[...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().right));
      return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth, banner: right('.asroot-banner'), dialog: right('[role=dialog]') };
    });
    if (o.scroll > o.client + 1 || o.body > o.client + 1 || o.banner > o.client + 1 || o.dialog > o.client + 1) failures.push({ view: what, rule: 'horizontal overflow', ...o });
  };
  const openDialog = async (page) => {
    await page.getByRole('button', { name: 'Account: fixture-admin' }).click();
    await page.getByRole('menuitem', { name: 'Act as root…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Act as root' });
    await dialog.waitFor({ state: 'visible' });
    return dialog;
  };
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const asRoot = { until: Date.now() + 10 * 60_000 };
      const { context, page } = await openPage(browser, { viewport, colorScheme: scheme, state: directState(), fixture: { account: 'fixture-admin', kind: 'sys', admin: true, asRoot } });
      page0 = page;
      const label = `${viewport.width}x${viewport.height} ${scheme}`;
      try {
        const banner = page.locator('.asroot-banner');
        await banner.waitFor({ state: 'visible', timeout: 8000 });
        const text = (await banner.getByRole('status').innerText()).trim();
        assert.ok((await endsAt(asRoot.until)).map((m) => `Acting as root until ${m}`).includes(text), `the banner names the end time (${label}), got '${text}'`);
        await page.waitForTimeout(150);
        await overflow(page, `banner ${label}`);
        await runAxe(page, `act as root banner ${label}`, failures);
        const dialog = await openDialog(page);
        await page.waitForTimeout(150);
        await overflow(page, `dialog ${label}`);
        await runAxe(page, `act as root dialog ${label}`, failures);
        await dialog.getByLabel('Password', { exact: true }).fill('not-the-password');
        await dialog.getByRole('button', { name: 'Act as root' }).click();
        await dialog.getByRole('alert').filter({ hasText: 'Sign-in failed' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.equal(await dialog.getByLabel('Password', { exact: true }).inputValue(), '', 'the password is cleared after a failed attempt');
        await runAxe(page, `act as root dialog error ${label}`, failures);
        await dialog.getByRole('radio', { name: 'Key file' }).click();
        await dialog.getByLabel('Key file').waitFor({ state: 'visible' });
        await overflow(page, `dialog key file ${label}`);
        await runAxe(page, `act as root dialog key file ${label}`, failures);
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
        if (stored.includes('not-the-password')) failures.push({ view: label, rule: 'password kept in storage' });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      } finally {
        await context.close();
      }
    }
  }
  // Stop, then turn it on again with the password; the end time hides the banner and the app asks the hub again.
  if (once) {
    const asRoot = { until: Date.now() + 10 * 60_000 };
    const fixture = { account: 'fixture-admin', kind: 'sys', admin: true, asRoot };
    const { context, page } = await openPage(browser, { state: directState(), fixture });
    page0 = page;
    try {
      const banner = page.locator('.asroot-banner');
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      const before = fixture.meCalls;
      await banner.getByRole('button', { name: 'Stop' }).click();
      await banner.waitFor({ state: 'hidden', timeout: 8000 });
      assert.equal(asRoot.stopped, 1, 'Stop turns the switch off on the hub');
      await expectPoll(() => fixture.meCalls > before, 'Stop asks the hub who is signed in again');
      const dialog = await openDialog(page);
      await dialog.getByLabel('Password', { exact: true }).fill('fixture-root-password');
      await dialog.getByRole('button', { name: 'Act as root' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 8000 });
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      assert.deepEqual(asRoot.bodies, ['password'], 'the dialog sends the password and nothing else');
      // the hub ends the switch 4 seconds from now; the banner goes at that time and the app asks the hub again
      asRoot.until = Date.now() + 4000;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await banner.filter({ hasText: new RegExp(`until (${(await endsAt(asRoot.until)).join('|')})`) }).waitFor({ state: 'visible', timeout: 8000 });
      const ended = fixture.meCalls;
      await banner.waitFor({ state: 'hidden', timeout: 8000 });
      await expectPoll(() => fixture.meCalls > ended, 'the end time asks the hub who is signed in again');
    } finally {
      await context.close();
    }
  }
  // the end time the hub gave when the switch was turned on hides the banner on its own (one timer, nothing asked first)
  if (once) {
    const asRoot = { lasts: 3000 };
    const fixture = { account: 'fixture-admin', kind: 'sys', admin: true, asRoot };
    const { context, page } = await openPage(browser, { state: directState(), fixture });
    try {
      const banner = page.locator('.asroot-banner');
      const dialog = await openDialog(page);
      await dialog.getByLabel('Password', { exact: true }).fill('fixture-root-password');
      await dialog.getByRole('button', { name: 'Act as root' }).click();
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      const before = fixture.meCalls;
      await banner.waitFor({ state: 'hidden', timeout: 8000 });
      await expectPoll(() => fixture.meCalls > before, 'the end time asks the hub who is signed in again');
    } finally {
      await context.close();
    }
  }
  // A browser clock 20 minutes ahead of the hub: the hub's time left decides. The banner shows, names the local end, and
  // a switch with 3 seconds left by the hub's clock hides about 3 seconds later by the browser's timers.
  if (once) {
    const skew = 20 * 60_000;
    const asRoot = { until: Date.now() + 10 * 60_000, lasts: 3000 };
    const fixture = { account: 'fixture-admin', kind: 'sys', admin: true, asRoot };
    const { context, page } = await openPage(browser, { state: directState(), fixture, clockOffsetMs: skew });
    page0 = page;
    try {
      const banner = page.locator('.asroot-banner');
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      const text = (await banner.getByRole('status').innerText()).trim();
      assert.ok((await endsAt(asRoot.until + skew)).map((m) => `Acting as root until ${m}`).includes(text), `a skewed browser names the end by its own clock, got '${text}'`);
      await banner.getByRole('button', { name: 'Stop' }).click();
      await banner.waitFor({ state: 'hidden', timeout: 8000 });
      const dialog = await openDialog(page);
      await dialog.getByLabel('Password', { exact: true }).fill('fixture-root-password');
      await dialog.getByRole('button', { name: 'Act as root' }).click();
      await banner.waitFor({ state: 'visible', timeout: 8000 });
      const shown = Date.now();
      await banner.waitFor({ state: 'hidden', timeout: 10000 });
      const after = Date.now() - shown;
      assert.ok(after > 1500 && after < 6000, `the banner hides at the local end, about 3 s after it showed (${after} ms)`);
    } finally {
      await context.close();
    }
  }
  // A Stop the hub does not confirm keeps the banner and says so in an alert; it passes axe and fits the window.
  for (const scheme of schemes) {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 320, height: 568 }]) {
      const asRoot = { until: Date.now() + 10 * 60_000, failStop: true };
      const { context, page } = await openPage(browser, { viewport, colorScheme: scheme, state: directState(), fixture: { account: 'fixture-admin', kind: 'sys', admin: true, asRoot } });
      const label = `${viewport.width}x${viewport.height} ${scheme}`;
      try {
        const banner = page.locator('.asroot-banner');
        await banner.waitFor({ state: 'visible', timeout: 8000 });
        await banner.getByRole('button', { name: 'Stop' }).click();
        await banner.getByRole('alert').filter({ hasText: 'Could not stop acting as root. Try again.' }).waitFor({ state: 'visible', timeout: 8000 });
        assert.ok(await banner.getByRole('status').isVisible(), `the banner stays after a failed Stop (${label})`);
        assert.equal(asRoot.stopped, 1);
        await page.waitForTimeout(150);
        await overflow(page, `failed stop ${label}`);
        await runAxe(page, `act as root failed stop ${label}`, failures);
      } finally {
        await context.close();
      }
    }
  }
  // a system account that is not an administrator, and a virtual account, never see the item or the banner
  for (const fixture of !once ? [] : [{ account: 'fixture-admin', kind: 'sys', admin: false, asRoot: { until: Date.now() + 600_000 } }, { account: 'fixture-admin', kind: 'virt', admin: false, asRoot: { until: Date.now() + 600_000 } }]) {
    const { context, page } = await openPage(browser, { state: directState(), fixture });
    try {
      await page.getByRole('button', { name: 'Account: fixture-admin' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('menuitem', { name: 'Act as root…' }).count(), 0, `no "Act as root…" for a ${fixture.kind} account that is not an administrator`);
      assert.equal(await page.locator('.asroot-banner').count(), 0, `no banner for a ${fixture.kind} account that is not an administrator`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'the act-as-root banner and dialog pass axe and fit the window');
}

async function expectPoll(fn, message) {
  for (let i = 0; i < 80; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(message);
}

// The session ends while a file is being edited. Signing in again as the same account brings the app back without a
// page load, and the unsaved text is still in the editor.
async function verifyResumeAfterSessionEnds(browser) {
  const session = { out: false };
  const state = `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', e: [nodeName, '/work/tracked.txt'] }, a: 'p1' }))}`;
  const { context, page } = await openPage(browser, { state, fixture: { account: 'fixture-user', session } });
  try {
    const lines = () => page.getByRole('dialog', { name: 'Editing tracked.txt' }).locator('.monaco-editor .view-lines');
    await lines().waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => /saved\s*text/.test(document.querySelector('.monaco-editor .view-lines')?.textContent ?? ''), null, { timeout: 20000 });
    await lines().click();
    await page.keyboard.type('TYPED-BEFORE-SIGN-OUT');
    await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('TYPED-BEFORE-SIGN-OUT'), null, { timeout: 8000 });
    // A marker on the window shows whether the page was loaded again.
    await page.evaluate(() => { window.__sameDocument = true; });
    session.out = true;
    await page.evaluate(() => fetch('/api/nodes').catch(() => {}));
    await page.getByRole('heading', { name: /^Sign in to / }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('textbox', { name: 'Name' }).fill('fixture-user');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await lines().waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('TYPED-BEFORE-SIGN-OUT'), null, { timeout: 8000 }).catch(() => {});
    assert.match(await lines().innerText(), /TYPED-BEFORE-SIGN-OUT/, 'the unsaved text is back in the editor after signing in again');
    assert.equal(await page.evaluate(() => window.__sameDocument === true), true, 'signing in again does not load the page again');
  } finally {
    await context.close();
  }
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

async function verifyMixedLineEndingsNotice(browser) {
  const stateFor = (file) => `?s=${encodeURIComponent(JSON.stringify({ t: { i: 'p1', n: nodeName, p: '/work', e: [nodeName, file] }, a: 'p1' }))}`;
  const expected = 'This file mixes Windows (CRLF) and Unix (LF) line endings. A save changes all of them to CRLF.';
  for (const [width, height] of [[1365, 900], [390, 844], [320, 760]]) {
    const { context, page } = await openPage(browser, { viewport: { width, height }, state: stateFor('/work/mixed.txt') });
    try {
      const editor = page.getByRole('dialog', { name: 'Editing mixed.txt' });
      await editor.locator('.monaco-editor .view-lines').waitFor({ state: 'visible', timeout: 20000 });
      const notice = editor.getByRole('status').filter({ hasText: 'line endings' });
      await notice.waitFor({ state: 'visible', timeout: 8000 });
      assert.equal((await notice.innerText()).trim(), expected, `the notice names what a save writes at ${width}px`);
      const box = await page.evaluate(() => {
        const n = document.querySelector('.ed .ed-notice').getBoundingClientRect();
        const body = document.querySelector('.ed .ed-body').getBoundingClientRect();
        return { noticeBottom: n.bottom, bodyTop: body.top, right: n.right, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(box.noticeBottom <= box.bodyTop + 0.5, `the notice does not cover the editor text at ${width}px`);
      assert.ok(box.right <= width && !box.overflow, `the notice fits the window at ${width}px`);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPage(browser, { state: stateFor(tracked) });
  try {
    const editor = page.getByRole('dialog', { name: 'Editing tracked.txt' });
    await editor.locator('.monaco-editor .view-lines').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => /saved\s*text/.test(document.querySelector('.monaco-editor .view-lines')?.textContent ?? ''), null, { timeout: 20000 });
    assert.equal((await editor.locator('.ed-notice').innerText()).trim(), '', 'a file with one kind of line ending shows no notice');
  } finally {
    await context.close();
  }
}

// ---- Installable app -------------------------------------------------------------------------------------------------

// Spies installed before the app's scripts: notification permission starts as "default" and is granted when asked (the
// count shows whether the app asked, and when); notifications shown through the service worker are recorded; the page
// can be made to look hidden (window.__hidden) without leaving the tab.
function pwaSpies() {
  const log = (window.__notify = { asked: 0, shown: [] });
  let perm = 'default';
  if (window.Notification) {
    Object.defineProperty(window.Notification, 'permission', { get: () => perm, configurable: true });
    window.Notification.requestPermission = async () => { log.asked += 1; perm = 'granted'; return perm; };
  }
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = async function (title, o) { log.shown.push({ title, body: o?.body ?? '', tag: o?.tag ?? '' }); };
  }
  // Push: headless browsers have no push service. `__pushMode` 'fail' (the default) makes subscribe fail as there; 'ok' gives a
  // stand-in subscription on a push service address, so the page hands it to the hub.
  window.__pushMode = 'fail';
  const push = (window.__push = { subscribed: 0, current: null });
  if (window.PushManager) {
    PushManager.prototype.getSubscription = async function () { return push.current; };
    PushManager.prototype.subscribe = async function (o) {
      if (window.__pushMode !== 'ok') throw new DOMException('push service not available', 'AbortError');
      push.subscribed += 1;
      const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
      const endpoint = 'https://fcm.googleapis.com/fcm/send/acceptance-stand-in';
      push.current = { endpoint, options: { applicationServerKey: o.applicationServerKey.buffer ?? o.applicationServerKey }, toJSON: () => ({ endpoint, keys }), unsubscribe: async () => { push.current = null; return true; } };
      return push.current;
    };
  }
  window.__hidden = false;
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => (window.__hidden ? 'hidden' : 'visible'), configurable: true });
}

/** Waits up to 10 s for `ok()` (a test-side condition, such as a request seen), else fails with `what`. */
async function waitFor(ok, what) {
  for (const end = Date.now() + 10000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return;
  assert.fail(`timed out: ${what}`);
}

const fixtureOp = (state) => ({
  id: 'fixture-op-pwa', kind: 'ops', op: 'copy', title: 'Copy tracked.txt', state,
  progress: { bytes: state === 'done' ? 128 : 64, totalBytes: 128, entries: 1, totalEntries: 1, current: '' }, speed: 0,
  counts: { total: 1, done: state === 'done' ? 1 : 0, skipped: 0, failed: 0 }, createdAt: Date.now() - 5000, startedAt: Date.now() - 4000,
  ...(state === 'done' ? { finishedAt: Date.now() } : {}),
});

// A local port that forwards to FILEDECK_URL and can be stopped and started again on the same port, so the browser
// meets a hub that really cannot be reached (connection refused) without stopping the hub other checks use. Browser
// offline emulation is not used: Firefox's refuses page loads before a service worker sees them, which a dropped
// network does not do.
async function hubDoor() {
  const target = new URL(baseURL);
  const sockets = new Set();
  const door = { swSuffix: '' };
  const server = http.createServer((req, res) => {
    // door.swSuffix: /sw.js answered with that text appended, as a new build would change it
    const nextSw = door.swSuffix && req.url.startsWith('/sw.js');
    const headers = { ...req.headers, host: target.host };
    if (nextSw) delete headers['accept-encoding'];
    const up = (target.protocol === 'https:' ? https : http).request({ host: target.hostname, port: target.port || undefined, path: req.url, method: req.method, headers }, (r) => {
      if (!nextSw) {
        res.writeHead(r.statusCode ?? 502, r.headers);
        return r.pipe(res);
      }
      const parts = [];
      r.on('data', (d) => parts.push(d));
      r.on('end', () => {
        const body = Buffer.concat([...parts, Buffer.from(door.swSuffix)]);
        const h = { ...r.headers, 'content-length': String(body.length) };
        res.writeHead(r.statusCode ?? 502, h);
        res.end(body);
      });
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return Object.assign(door, {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); }),
    open: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
  });
}

async function verifyInstallableApp(browser) {
  const failures = [];
  let op = fixtureOp('running');
  const pushLog = [];
  const fixture = { opJobs: () => [op], pushLog };
  const door = await hubDoor();
  const { context, page } = await openPage(browser, { serviceWorkers: 'allow', fixture, initScripts: [pwaSpies], origin: door.origin });
  try {
    // The worker takes control of the first page load (clients.claim), so the next start works without a network.
    // Installing stores the shell and its files first; late in a full run that can take a while, so the wait is generous.
    const state = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((r) => setTimeout(() => r('not ready'), 45000)),
    ]));
    assert.equal(state, 'ready', 'the service worker installs and activates');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {
      throw new Error('the active service worker does not control the page (clients.claim)');
    });

    // Manifest, icons and headers
    const m = await page.evaluate(async () => {
      const r = await fetch('/site.webmanifest');
      const sw = await fetch('/sw.js');
      const body = await r.json();
      const icons = [];
      for (const i of body.icons) {
        if (!i.type.startsWith('image/png')) continue;
        const img = new Image();
        img.src = i.src;
        await img.decode();
        icons.push({ src: i.src, purpose: i.purpose, sizes: i.sizes, w: img.naturalWidth, h: img.naturalHeight });
      }
      return { body, icons, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), swCache: sw.headers.get('cache-control'), theme: document.querySelector('meta[name="theme-color"]')?.content };
    });
    assert.match(m.type, /^application\/manifest\+json/, 'the manifest is served as a manifest');
    assert.equal(m.cache, 'no-cache', 'the manifest is revalidated');
    assert.equal(m.swCache, 'no-cache', 'the service worker script is revalidated');
    for (const [k, v] of Object.entries({ id: '/', name: 'Filedeck', short_name: 'Filedeck', start_url: '/', scope: '/', display: 'standalone', theme_color: '#151518', background_color: '#0c0c0e' })) assert.equal(m.body[k], v, `manifest ${k}`);
    assert.ok(m.body.categories.includes('productivity'), 'manifest categories');
    for (const [purpose, size] of [['any', 192], ['any', 512], ['maskable', 192], ['maskable', 512], ['monochrome', 512]]) {
      const icon = m.icons.find((i) => i.purpose === purpose && i.sizes === `${size}x${size}`);
      assert.ok(icon, `a ${purpose} icon of ${size} px is listed`);
      assert.deepEqual([icon.w, icon.h], [size, size], `${icon.src} is ${size} px`);
    }
    assert.equal(m.theme, '#e9ebef', 'the title bar takes the light theme colour');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#151518', 'the title bar follows a switch to the dark theme');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    if (engineName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
      assert.deepEqual(installabilityErrors, [], 'Chromium finds the app installable');
      const { errors } = await cdp.send('Page.getAppManifest');
      assert.deepEqual(errors, [], 'Chromium reads the manifest without errors');
    }

    // Nothing under /api is stored, though the page has listed folders and polled jobs by now.
    const stored = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    assert.ok(stored.includes('/'), 'the shell is stored');
    assert.ok(stored.some((p) => /^\/assets\/index-[\w-]{8}\.js$/.test(p)), 'the entry script is stored');
    assert.deepEqual(stored.filter((p) => /^\/api(\/|$)/i.test(p)), [], 'no API answer is stored');

    // Notifications: never asked on load; the Settings switch asks; a job that ends while hidden notifies once.
    assert.equal(await page.evaluate(() => window.__notify.asked), 0, 'permission is not asked on load');
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const sw = dialog.getByRole('switch', { name: /Notify me when a job ends/ });
    await sw.waitFor({ state: 'attached' });
    assert.equal(await sw.isChecked(), false, 'the switch starts off');
    assert.equal(await page.evaluate(() => window.__notify.asked), 0, 'opening Settings does not ask');
    await dialog.locator('label.set-opt', { hasText: 'Notify me when a job ends' }).click();
    await page.waitForFunction(() => window.__notify.asked === 1);
    await expectChecked(sw);
    // no push service here: the switch stays on and says notifications come only while a tab is open
    await dialog.getByText(/cannot send notifications while Filedeck is closed/).waitFor({ timeout: 10000 });
    await runAxe(page, 'Settings App section (light)', failures);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__hidden = true; });
    op = fixtureOp('done');
    await page.waitForFunction(() => window.__notify.shown.length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    assert.deepEqual(await page.evaluate(() => window.__notify.shown), [{ title: 'Copy tracked.txt finished', body: '1 done', tag: 'filedeck-job:o:fixture-op-pwa' }], 'one notification for the job that ended while hidden');
    await page.evaluate(() => { window.__hidden = false; });

    // Web Push where the browser has a push service: the switch subscribes with the hub's key and hands the subscription to the hub;
    // turning it off removes it there and in the browser.
    const pushCalls = [];
    const onPush = (r) => { if (new URL(r.url()).pathname.startsWith('/api/push/')) pushCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on('request', onPush);
    try {
      await page.evaluate(() => { window.__pushMode = 'ok'; });
      await page.getByRole('button', { name: 'Settings' }).click();
      const label = dialog.locator('label.set-opt', { hasText: 'Notify me when a job ends' });
      await label.click();
      await page.waitForFunction(() => !document.querySelector('[role=dialog] input[role=switch]')?.checked);
      await label.click();
      await expectChecked(sw);
      await page.waitForFunction(() => window.__push.subscribed === 1);
      await waitFor(() => pushCalls.includes('POST /api/push/subscribe'), 'the subscription is sent to the hub');
      const posted = pushLog.find((x) => x.method === 'POST')?.body;
      assert.equal(posted?.endpoint, 'https://fcm.googleapis.com/fcm/send/acceptance-stand-in');
      assert.ok(posted?.keys?.p256dh && posted?.keys?.auth, 'with its keys');
      assert.equal(await dialog.getByText(/cannot send notifications while Filedeck is closed/).count(), 0, 'no fallback note when push works');
      const key = await page.evaluate(async () => (await (await fetch('/api/push/key')).json()).publicKey);
      assert.equal(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4)).length, 65, 'the hub has a P-256 public key');
      await label.click();
      await waitFor(() => pushCalls.includes('DELETE /api/push/subscribe'), 'turning off removes the subscription at the hub');
      assert.deepEqual(pushLog.filter((x) => x.method === 'DELETE').map((x) => x.body), [{ endpoint: 'https://fcm.googleapis.com/fcm/send/acceptance-stand-in' }]);
      // the browser drops it once the hub has answered the DELETE
      await page.waitForFunction(() => window.__push.current === null, null, { timeout: 10000 }).catch(() => assert.fail('and in the browser'));
      await page.keyboard.press('Escape');
    } finally {
      page.off('request', onPush);
    }

    // A new build: the changed worker waits, the page offers Reload and does not reload by itself; Reload switches.
    door.swSuffix = '\n// next build\n';
    await page.evaluate(() => { window.__sameLoad = true; return navigator.serviceWorker.getRegistration().then((r) => r.update()); });
    const banner = page.getByRole('status').filter({ hasText: 'A new version of Filedeck is ready.' });
    await banner.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => window.__sameLoad), true, 'the page does not reload before Reload is pressed');
    await runAxe(page, 'update banner (light)', failures);
    await Promise.all([page.waitForEvent('load', { timeout: 15000 }), banner.getByRole('button', { name: 'Reload' }).click()]);
    await page.locator('.fp').first().waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__sameLoad), undefined, 'Reload loads the page again');
    assert.equal(await page.getByText('A new version of Filedeck is ready.').count(), 0, 'the new version runs, no banner');

    // Without a hub: a reload opens the stored shell and says the hub is not reachable, in both themes and at 320 px.
    await page.unroute('**/api/**');
    await door.close();
    for (const scheme of ['light', 'dark']) {
      await page.evaluate((t) => localStorage.setItem('filedeck-theme', t), scheme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Filedeck hub not reachable' }).waitFor({ state: 'visible', timeout: 15000 });
      // the card fades in; contrast is measured once it is fully shown
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      await runAxe(page, `hub not reachable (${scheme})`, failures);
    }
    await page.setViewportSize({ width: 320, height: 568 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the hub-not-reachable screen fits 320 px');
    await page.setViewportSize({ width: 1365, height: 900 });
    await door.open();
    await installFixture(page, fixture);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.fp').first().waitFor({ state: 'visible', timeout: 15000 });
  } finally {
    await context.close();
    await door.close().catch(() => {});
  }
  assert.deepEqual(failures, [], 'axe-core on the installable-app views');
}

async function expectChecked(locator) {
  for (let i = 0; i < 50 && !(await locator.isChecked()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await locator.isChecked(), true, 'the switch is on after permission is granted');
}

// ---- Runner ---------------------------------------------------------------------------------------------------------

function schemePair(name, verify) {
  return ['light', 'dark'].map((scheme) => [`${name} (${scheme})`, (b) => verify(b, [scheme])]);
}

async function verifyJobsStatus(browser) {
  const now = Date.now();
  const progress = { bytes: 4800, totalBytes: 8000, entries: 42, totalEntries: 70, current: '/work' };
  const status = {
    jobs: [
      { id: 'size-1', kind: 'du', title: 'Scan /work', state: 'running', origin: 'cli', progress, createdAt: now - 7000, startedAt: now - 5000 },
      { id: 'index-1', kind: 'index', title: 'Index /documents', state: 'queued', origin: 'background', progress, createdAt: now - 3500 },
      { id: 'archive-1', kind: 'archive', title: 'Archive reports', state: 'failed', origin: 'ui', progress, error: 'Destination is read-only.', createdAt: now - 120000, startedAt: now - 117000, finishedAt: now - 60000 },
    ],
    nodes: [{ node: nodeName, state: 'available', status: {
      sampledAt: now,
      sizeStore: { available: true, damaged: false },
      roots: [
        { path: '/', scannedAt: now - 180000, fullScan: true, state: 'current' },
        { path: '/archive', scannedAt: now - 380000, fullScan: true, state: 'stale' },
        { path: '/incoming', scannedAt: null, fullScan: false, state: 'missing' },
      ],
      watcher: { kind: 'fanotify', running: true, ready: false, mounts: 3, watched: 2, unwatched: 1, excluded: 1, backlog: 4,
        lostEvents: 2, unresolved: 1, unwatchedPaths: ['/incoming'],
        coverage: [{ path: '/', state: 'watched' }, { path: '/archive', state: 'watched' }, { path: '/incoming', state: 'unwatched' }],
      },
      journal: { serving: true, epoch: 'fixture', oldestCursor: 'fixture:1', newestCursor: 'fixture:84', oldestAgeMs: 1000,
        bytes: 7000, subscribers: { socket: 1, http: 2, internal: 0 }, lagMs: 12, overflows: 2, dropped: 0 },
    } }, { node: 'fixture-offline', state: 'unavailable', reason: 'The agent returned HTTP 401.' }],
  };
  const stream = () => {
    const original = window.fetch.bind(window);
    window.statusStreams = [];
    window.statusReplies = [];
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (url.pathname !== '/api/v1/changes') return original(input, init);
      const stream = { query: Object.fromEntries(url.searchParams), aborted: false };
      window.statusStreams.push(stream);
      const reply = window.statusReplies.shift();
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          window.statusEmit = (rows) => controller.enqueue(enc.encode(rows.map((row) => JSON.stringify(row) + '\n').join('')));
          if (reply) {
            controller.enqueue(enc.encode(reply.line));
            if (!reply.networkError) controller.close();
            return;
          }
          init.signal.addEventListener('abort', () => {
            stream.aborted = true;
            controller.error(init.signal.reason);
          }, { once: true });
          const rows = ['report.log', 'notes.log', 'daily.log'].map((name, i) => ({
            kind: stream.query.kind || 'create', path: '/work/' + name, cursor: 'fixture:' + (i + 1), time: Date.now(),
          }));
          window.statusEmit(rows);
        },
        pull(controller) {
          if (reply?.networkError) controller.error(new TypeError('Network connection lost.'));
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    };
  };
  const failures = [];
  const stamp = process.env.FILEDECK_STATUS_SHOT_VERSION;
  for (const [size, viewport, colorScheme] of [
    ['desktop', { width: 1365, height: 900 }, 'light'],
    ['narrow', { width: 390, height: 844 }, 'dark'],
  ]) {
    const requests = [];
    const nodesBody = { nodes: [{ name: nodeName, online: true }, { name: 'fixture-offline', online: false }] };
    const mobile = size === 'narrow' && browser.browserType().name() === 'chromium';
    const { page, context } = await openPage(browser, { viewport, colorScheme, mobile, fixture: { status, nodesBody, requests }, initScripts: [stream] });
    const nav = page.getByRole('navigation', { name: 'Status sections' });
    const widthFits = () => page.locator('.status-page').evaluate((el) => el.scrollWidth <= el.clientWidth);
    const audit = async (section) => {
      assert.equal(await widthFits(), true, section + ' fits at ' + size);
      await runAxe(page, section + ' ' + size, failures);
      if (stamp) await page.locator('.status-wrap').screenshot({
        path: resolve(evidenceDir, `status-${section}-${size}-${stamp}.png`),
        style: 'html, body, #root, .status-page { height: auto !important; overflow: visible !important; }',
      });
    };
    const section = (name) => nav.getByRole('link', { name, exact: true });
    const streamState = () => page.evaluate(() => window.statusStreams.at(-1));
    try {
      await page.locator('button[aria-controls="jobs-panel"]').click();
      await page.getByRole('link', { name: 'Open jobs and status' }).click();
      const title = page.getByRole('heading', { name: 'Jobs and status' });
      await title.waitFor();
      const job = page.getByRole('button', { name: 'Scan /work' });
      await job.focus();
      await job.press('Enter');
      await expectText(page, 'Data processed');
      assert.equal(await job.getAttribute('aria-expanded'), 'true');
      assert.match(new URL(page.url()).searchParams.get('job'), /^agent:/);
      await page.reload();
      await expectText(page, 'Data processed');
      await page.getByRole('list', { name: 'Jobs', exact: true }).getByText('Destination is read-only.').scrollIntoViewIfNeeded();
      await title.scrollIntoViewIfNeeded();
      await audit('jobs');
      assert.equal(await page.getByRole('option', { name: 'fixture-offline (offline)' }).count(), 1);
      assert.equal(requests.some((path) => path.startsWith('/api/nodes/fixture-offline/api/jobs')), false, 'do not poll jobs on an offline node');

      await section('Node health').click();
      await expectText(page, 'The agent returned HTTP 401.');
      await page.getByText('Dropped readers').scrollIntoViewIfNeeded();
      await title.scrollIntoViewIfNeeded();
      await audit('nodes');

      await page.getByLabel('Node', { exact: true }).selectOption(nodeName);
      await expectText(page, 'Not stored yet');
      assert.equal(new URL(page.url()).pathname, '/status/' + nodeName);
      await page.goBack();
      await expectText(page, 'Scan coverage, watcher activity and journal health.');
      assert.equal(new URL(page.url()).pathname, '/status');
      assert.equal(await title.evaluate((el) => el === document.activeElement), true);
      await page.goForward();
      await expectText(page, 'Not stored yet');
      assert.equal(new URL(page.url()).pathname, '/status/' + nodeName);

      await section('Live events').click();
      await page.getByLabel('Path prefix').fill('/work');
      await page.getByLabel('Glob').fill('*.log');
      await page.getByRole('button', { name: 'Apply paths' }).click();
      await page.getByLabel('Kind').selectOption('modify');
      await page.getByLabel('Entry type').selectOption('file');
      await expectText(page, '/work/report.log');
      assert.deepEqual((await streamState()).query, { node: nodeName, prefix: '/work', glob: '*.log', kind: 'modify', type: 'file' });
      await page.reload();
      await expectText(page, '/work/report.log');
      assert.equal(await page.getByLabel('Glob').inputValue(), '*.log');
      assert.equal(await page.getByLabel('Kind').inputValue(), 'modify');
      await audit('events');
      const streamsBeforeSkip = await page.evaluate(() => window.statusStreams.length);
      const skip = page.getByRole('link', { name: 'Skip to jobs and status' });
      await skip.focus();
      await skip.press('Enter');
      assert.equal(new URL(page.url()).hash, '#filedeck-main');
      await page.goBack();
      await page.goForward();
      await expectText(page, '/work/report.log');
      assert.equal(await page.evaluate(() => window.statusStreams.length), streamsBeforeSkip, 'fragment history keeps the current stream');
      assert.equal((await streamState()).aborted, false);

      await page.getByRole('button', { name: 'Pause' }).click();
      assert.equal((await streamState()).aborted, true);
      await page.getByRole('button', { name: 'Clear' }).click();
      await expectText(page, 'No events received.');
      await page.getByRole('button', { name: 'Resume' }).click();
      await expectText(page, '/work/report.log');
      assert.equal((await streamState()).query.since, 'fixture:3');

      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal((await streamState()).aborted, true);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal((await streamState()).aborted, false);

      await section('Storage').click();
      await expectText(page, 'This hub does not provide grouped storage data yet.');
      assert.equal((await streamState()).aborted, true);
      await audit('storage');

      if (size === 'desktop') {
        await section('Live events').click();
        await expectText(page, '/work/report.log');
        await page.evaluate(() => window.statusEmit(Array.from({ length: 497 }, (_, i) => ({ kind: 'modify', path: '/work/buffer-' + i }))));
        await expectText(page, 'Showing 500 of up to 500 recent events');
        const retained = page.getByRole('listitem').filter({ has: page.getByText('/work/buffer-0', { exact: true }) });
        const row = await retained.elementHandle();
        await page.evaluate(() => window.statusEmit([{ kind: 'modify', path: '/work/one-more' }]));
        await expectText(page, '/work/one-more');
        assert.equal(await retained.evaluate((element, before) => element === before, row), true, 'retained rows keep their DOM identity');
        await row.dispose();

        await page.clock.install();
        await section('Storage').click();
        const before = await page.evaluate(() => {
          window.statusReplies.push(
            { line: '{bad}\n' },
            { line: 'x'.repeat(1024 * 1024 + 1) },
            { line: '{"kind":"modify","path":"/work/healthy.log"}\n', networkError: true },
          );
          return window.statusStreams.length;
        });
        await section('Live events').click();
        await expectText(page, 'Reconnecting…');
        await page.clock.fastForward(3000);
        await page.waitForFunction((n) => window.statusStreams.length === n, before + 2);
        await expectText(page, 'Reconnecting…');
        await page.clock.fastForward(3000);
        assert.equal(await page.evaluate(() => window.statusStreams.length), before + 2, 'the second failure must wait six seconds');
        await page.clock.fastForward(3000);
        await page.waitForFunction((n) => window.statusStreams.length === n, before + 3);
        await expectText(page, '/work/healthy.log');
        await expectText(page, 'Reconnecting…');
        await page.clock.fastForward(3000);
        await page.waitForFunction((n) => window.statusStreams.length === n, before + 4);
        await expectText(page, '/work/report.log');
      }
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'the jobs and status sections pass axe in both themes');
}

const allChecks = [
  ['jobs and node status', verifyJobsStatus],
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
  ['mixed line endings notice', verifyMixedLineEndingsNotice],
  ['address bar targets and keyboard', verifyAddressBar],
  ['Compare toolbar is not clipped', verifyCompareToolbar],
  ['Compare toolbar is compact on a phone', verifyCompareToolbarCompact],
  ['a compare with skipped paths is marked incomplete', verifyCompareSkippedPaths],
  ['no horizontal overflow', verifyNoHorizontalOverflow],
  ['phone header with a selection', verifyPhoneSelectionHeader],
  ['rows visible in a short window', verifyShortWindowRows],
  ['theme tokens, selection mark, focus indicator', verifyThemeTokens],
  ['axe-core A and AA in every view', verifyAxeViews],
  // The three long checks run once per colour scheme, as two checks. Parts that do not depend on the scheme run with the light one.
  ...schemePair('sign-in screen and account menu', verifySignIn),
  ...schemePair('act as root from the account menu', verifyActAsRoot),
  ['Virtual account opens its first granted folder', verifyVirtualAccount],
  ...schemePair('Accounts', verifyAccounts),
  ['installable app: manifest, worker, offline start, notifications', verifyInstallableApp],
  ...['light', 'dark'].flatMap((scheme) => [[1365, 900], [390, 844], [320, 760]].map(([width, height]) => [`measurements ${width}px ${scheme}`, (b) => verifyAccessibility(b, { width, height }, scheme)])),
];

// Expected seconds per check, from CI timings (the slower of the two browsers, split parts halved). Unknown names count as 3 s.
// Only used by FILEDECK_SHARD to spread the checks over processes.
const expectedSeconds = {
  'Accounts (light)': 100,
  'Accounts (dark)': 95,
  'sign-in screen and account menu (light)': 42,
  'sign-in screen and account menu (dark)': 31,
  'act as root from the account menu (light)': 28,
  'act as root from the account menu (dark)': 20,
  'axe-core A and AA in every view': 25,
  'phone header with a selection': 13,
  'no horizontal overflow': 10,
  'installable app: manifest, worker, offline start, notifications': 9,
  'Virtual account opens its first granted folder': 9,
  'unsaved editor text survives a resize': 8,
};

// FILEDECK_SHARD=i/n (1-based) runs shard i of n. Checks go to the shard with the least expected time so far, longest first.
// The same list always gives the same shards. The checks keep their listed order inside a shard.
function selectShard(list, spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`FILEDECK_SHARD must look like i/n with 1 <= i <= n, not ${spec}`);
  const index = Number(m[1]) - 1;
  const count = Number(m[2]);
  const load = Array(count).fill(0);
  const owner = new Map();
  const order = list.map((c, position) => ({ name: c[0], position, seconds: expectedSeconds[c[0]] ?? 3 }))
    .sort((a, b) => b.seconds - a.seconds || a.position - b.position);
  for (const c of order) {
    let best = 0;
    for (let k = 1; k < count; k++) if (load[k] < load[best]) best = k;
    owner.set(c.name, best);
    load[best] += c.seconds;
  }
  return list.filter((c) => owner.get(c[0]) === index);
}

const selected = allChecks.filter(([name]) => !only.length || only.some((o) => name.includes(o)));
const shardSpec = process.env.FILEDECK_SHARD || '';
const checks = shardSpec ? selectShard(selected, shardSpec) : selected;
if (shardSpec || process.env.FILEDECK_LIST) console.log(`shard ${shardSpec || 'all'}: ${checks.length} checks\n${checks.map(([name]) => `  - ${name}`).join('\n')}`);
// FILEDECK_LIST=1 prints the checks that would run and exits, without a browser. It is for checking shard splits.
if (process.env.FILEDECK_LIST) process.exit(0);

// BROWSER=firefox runs the same checks in Playwright's Firefox; the default is Chromium.
const engineName = process.env.BROWSER || 'chromium';
if (!['chromium', 'firefox'].includes(engineName)) throw new Error(`BROWSER must be chromium or firefox, not ${engineName}`);
const browser = engineName === 'firefox'
  ? await firefox.launch({ headless: true })
  : await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const started = Date.now();
const failed = [];
const results = [];
try {
  for (const [name, run] of checks) {
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
