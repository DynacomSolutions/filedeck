import { test } from "node:test";
import assert from "node:assert/strict";
import { hubToken, hubUrl, IN_CLUSTER_URL, SA_TOKEN_PATH } from "../src/cli-auth.ts";

const pod = { KUBERNETES_SERVICE_HOST: "10.0.0.1" };

test("host: FILEDECK_URL and FILEDECK_TOKEN only, nothing is guessed", () => {
  assert.equal(hubUrl({}), undefined);
  assert.equal(hubUrl({ FILEDECK_URL: "https://h/" }), "https://h");
  assert.equal(hubToken({}, () => "file"), undefined);
  assert.equal(hubToken({ FILEDECK_TOKEN: "t" }, () => "file"), "t");
});

test("pod: default hub URL and projected token", () => {
  assert.equal(hubUrl(pod), IN_CLUSTER_URL);
  assert.equal(IN_CLUSTER_URL, "http://filedeck.dynacom.svc");
  const files: string[] = [];
  assert.equal(hubToken(pod, (f) => (files.push(f), "sa-token\n")), "sa-token");
  assert.deepEqual(files, [SA_TOKEN_PATH]);
});

test("pod: explicit settings win, a missing token file gives nothing", () => {
  assert.equal(hubUrl({ ...pod, FILEDECK_URL: "https://other" }), "https://other");
  assert.equal(hubToken({ ...pod, FILEDECK_TOKEN: "t" }, () => "file"), "t");
  assert.equal(hubToken({ ...pod, FILEDECK_SA_TOKEN_FILE: "/x" }, (f) => f), "/x");
  assert.equal(hubToken(pod, () => { throw new Error("ENOENT"); }), undefined);
  assert.equal(hubToken(pod, () => " \n"), undefined);
});

test("filedeck du in a pod with no FILEDECK_* sends the projected token to the in-cluster hub", async () => {
  const { run } = await import("../src/du-cli.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sa-"));
  try {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, "sa-1\n");
    const seen: [string, string][] = [];
    const io = {
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push([u, (init?.headers as Record<string, string>)["x-filedeck-token"] as string]);
        return new Response(JSON.stringify({ path: "/d", entries: [{ path: "/d", type: "dir", bytes: 1, diskBytes: 1 }], cached: false, truncated: false, watched: false }));
      }) as never,
      out: () => undefined,
      err: () => undefined,
      sleep: async () => undefined,
      now: () => 1,
    };
    const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1", FILEDECK_SA_TOKEN_FILE: file };
    assert.equal(await run(["-s", "n:/d"], env, io), 0);
    fs.writeFileSync(file, "sa-2\n"); // the kubelet rotates the file; the next call reads it again
    assert.equal(await run(["-s", "n:/d"], env, io), 0);
    assert.deepEqual(seen.map((s) => s[1]), ["sa-1", "sa-2"]);
    assert.match(seen[0]![0], /^http:\/\/filedeck\.dynacom\.svc\/api\/nodes\/n\/api\/du/);
    // on a host with neither setting the CLI still refuses
    assert.equal(await run(["-s", "n:/d"], {}, io), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hubToken order: FILEDECK_TOKEN, then FILEDECK_TOKEN_FILE, then the pod's ServiceAccount token", () => {
  const read = (f: string) => ({ "/m/tok": " from-file\n", "/sa": "from-sa" })[f] ?? assert.fail(`no file ${f}`);
  const pod = { KUBERNETES_SERVICE_HOST: "10.0.0.1", FILEDECK_SA_TOKEN_FILE: "/sa" };
  assert.equal(hubToken({ ...pod, FILEDECK_TOKEN: "env", FILEDECK_TOKEN_FILE: "/m/tok" }, read), "env");
  assert.equal(hubToken({ ...pod, FILEDECK_TOKEN_FILE: "/m/tok" }, read), "from-file");
  assert.equal(hubToken({ FILEDECK_TOKEN_FILE: "/m/tok" }, read), "from-file", "also outside a pod");
  assert.equal(hubToken(pod, read), "from-sa");
  assert.equal(hubToken({ ...pod, FILEDECK_TOKEN_FILE: "/gone" }, () => { throw new Error("ENOENT"); }), undefined, "an unreadable named file does not fall through");
});
