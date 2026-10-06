import fs from "node:fs";

const tap = fs.readFileSync(0, "utf8");
process.stdout.write(tap);

const skips = tap.split(/\r?\n/).filter((line) => /# SKIP\b/.test(line));
const allowed = /smb live: skipped \(FILEDECK_TEST_SMB not set\)/;
const unexpected = skips.filter((line) => !allowed.test(line));
if (unexpected.length > 0) {
  console.error("Unexpected TAP skips:");
  console.error(unexpected.join("\n"));
  process.exit(1);
}

console.error(`TAP skip gate passed: ${skips.length} skip(s), ${skips.length - unexpected.length} allowed live SMB skip(s)`);
