import readline from "node:readline";

// Pass every TAP line through as it arrives (a hung or killed step still shows the last test that finished),
// remember the skips, and give the verdict when the stream ends.
const skips = [];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  process.stdout.write(line + "\n");
  if (/# SKIP\b/.test(line)) skips.push(line);
});
// The text of a skip is the reason after "# SKIP"; a test skipped with no reason is identified by its name. The whole text must
// match one entry (every entry is anchored), so a text that only contains an allowed text does not pass.
const skipText = (line) => {
  const at = line.indexOf(" # SKIP");
  const reason = line.slice(at + " # SKIP".length).trim();
  if (reason) return reason;
  return line.slice(0, at).replace(/^\s*(?:not )?ok \d+ - /, "");
};
const allowed = [
  // server/test/smb.live.test.ts: the live SMB share exists only where FILEDECK_TEST_SMB names one (no reason is given, so the name is matched).
  /^smb live: skipped \(FILEDECK_TEST_SMB not set\)$/,
  // server/test/fanwatch.test.ts: the fanotify helper needs two capabilities; the root pass sets FILEDECK_REQUIRE_FANWATCH=1 and fails instead of skipping.
  /^helper cannot run here: .+$/,
  // server/test/{sandbox,git-sandbox,archive-sandbox}.test.ts: the tests that need root skip in the unprivileged pass; the root pass runs them.
  /^(?:git )?sandbox live: skipped \(not running as root\)$/,
  // server/test/sandbox.test.ts: the x32 system call tests exist only on x86-64, and only where the kernel has x32 calls enabled.
  /^sandbox live: skipped \(x32 calls exist on x86-64 only\)$/,
  /^sandbox live: skipped \(this kernel has x32 calls disabled(?:: .*)?\)$/,
];

rl.on("close", () => {
  const unexpected = skips.filter((line) => !allowed.some((re) => re.test(skipText(line))));
  if (unexpected.length > 0) {
    console.error("Unexpected TAP skips:");
    console.error(unexpected.join("\n"));
    process.exit(1);
  }
  console.error(`TAP skip gate passed: ${skips.length} skip(s), ${skips.length - unexpected.length} allowed live SMB skip(s)`);
});
