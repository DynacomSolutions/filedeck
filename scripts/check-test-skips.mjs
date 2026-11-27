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
  // server/test/{sandbox,git-sandbox,archive-sandbox,agent-keys}.test.ts: the tests that need root skip in the unprivileged pass; the root pass runs them.
  /^(?:git )?sandbox live: skipped \(not running as root\)$/,
  // the worker tests (sign-in part 2) that need root to start a worker as another user skip in the unprivileged pass; the root pass runs them.
  /^worker live: skipped \(not running as root\)$/,
  // server/test/agent-workers.test.ts: two virtual accounts with one runAs need Landlock (their workers are confined); a kernel without it skips.
  /^sandbox live: skipped \(no Landlock on this kernel\)$/,
  // server/test/worker-confine.test.ts: a helper program a worker starts (git, bsdtar, ffmpeg, 7zz, qpdf) that is not installed on a development machine.
  /^worker helpers: skipped \((?:git|bsdtar|ffmpeg|7zz|qpdf) not installed here\)$/,
  // server/test/trash-owners.test.ts: the bind-mount restore test needs CAP_SYS_ADMIN, which root in the image build lacks; the CI root pass sets FILEDECK_REQUIRE_MOUNT=1.
  /^trash live: skipped \(bind mounts not permitted here\)$/,
  // server/test/{host-helpers,host-pam}.test.ts: the host helper tests (filedeck-id, filedeck-pam) need root (the chroot, and the test PAM
  // service files in /etc/pam.d) and a glibc machine (dynamic glibc helpers); the root pass sets FILEDECK_REQUIRE_HOST_HELPERS=1, which
  // turns the glibc skip into a failure.
  /^host helpers live: skipped \(not running as root\)$/,
  /^host helpers live: skipped \(no glibc here\)$/,
  // server/test/sandbox.test.ts: the x32 system call tests exist only on x86-64, and only where the kernel has x32 calls enabled.
  /^sandbox live: skipped \(x32 calls exist on x86-64 only\)$/,
  /^sandbox live: skipped \(this kernel has x32 calls disabled(?:: .*)?\)$/,
  // server/test/iotrace-{unit,helper}.test.ts: the eBPF helper needs clang and libbpf to build (the image build sets FILEDECK_REQUIRE_IOTRACE=1 and fails instead of skipping),
  // and its live run needs a process that may load BPF (CAP_BPF and CAP_PERFMON); an unprivileged pass skips the live run and runs the refusal test instead.
  /^iotrace (?:unit|helper): skipped \(.+\)$/,
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
