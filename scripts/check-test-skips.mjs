import readline from "node:readline";

// Pass every TAP line through as it arrives (a hung or killed step still shows the last test that finished),
// remember the skips, and give the verdict when the stream ends.
const skips = [];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  process.stdout.write(line + "\n");
  if (/# SKIP\b/.test(line)) skips.push(line);
});
rl.on("close", () => {
  const allowed = /smb live: skipped \(FILEDECK_TEST_SMB not set\)|fanwatch live: skipped/;
  const unexpected = skips.filter((line) => !allowed.test(line));
  if (unexpected.length > 0) {
    console.error("Unexpected TAP skips:");
    console.error(unexpected.join("\n"));
    process.exit(1);
  }
  console.error(`TAP skip gate passed: ${skips.length} skip(s), ${skips.length - unexpected.length} allowed live SMB skip(s)`);
});
