import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the E2E setup CLI emits its result from a path containing spaces", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent space e2e cli "));
  try {
    const script = join(directory, "prepare-e2e-neon-branch.mjs");
    copyFileSync(fileURLToPath(new URL("./prepare-e2e-neon-branch.mjs", import.meta.url)), script);
    writeFileSync(join(directory, "Target.md"), "E2E CLI test fixture\n");
    const databaseUrl = "postgres://test-user:test-password@127.0.0.1:5432/agent_space_test";
    const stdout = execFileSync(process.execPath, [script, "--json", "--dry-run"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        AGENT_SPACE_E2E: "0",
        AGENT_SPACE_E2E_FORCE_NEON_BRANCH: "0",
        AGENT_SPACE_TEST_DATABASE_URL: databaseUrl,
      },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.branchCreated, false);
    assert.equal(result.env.AGENT_SPACE_TEST_DATABASE_URL, databaseUrl);
    assert.equal(result.env.AGENT_SPACE_REPOSITORY_ROOT, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
