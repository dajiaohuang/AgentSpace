import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CubeSandbox, CUBE_EXEC_NOT_READY_MESSAGE } from "./cube-sandbox.ts";

async function withCubeFetchStub(
  handler: (request: { url: string; method: string; body: string }) => Promise<Response> | Response,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("CubeSandbox.exec throws a not-ready error until remote exec is wired", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-space-cube-exec-"));

  await withCubeFetchStub(async ({ url, method }) => {
    if (method === "POST" && url === "http://cube.test/sandboxes") {
      return new Response(JSON.stringify({
        templateID: "tpl-demo",
        sandboxID: "sbx-exec",
        clientID: "client-demo",
        envdVersion: "test",
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }, async () => {
    try {
      const sandbox = await CubeSandbox.connect({
        runtimeId: "runtime-cube-exec",
        workDir,
        provider: "cube",
        env: {
          AGENT_SPACE_CUBE_ENABLE_EXPERIMENTAL: "true",
          AGENT_SPACE_CUBE_API_URL: "http://cube.test",
          AGENT_SPACE_CUBE_API_KEY: "dummy",
          AGENT_SPACE_CUBE_TEMPLATE_ID: "tpl-demo",
        },
      });

      await assert.rejects(
        () => sandbox.exec({ command: "codex", args: ["--version"] }),
        new RegExp(CUBE_EXEC_NOT_READY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

test("CubeSandbox.snapshot falls back to a local snapshot when the Cube route is unavailable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-space-cube-snapshot-"));
  const workDir = join(tempRoot, "work");
  await mkdir(workDir);
  await writeFile(join(workDir, "notes.txt"), "hello cube\n", "utf8");

  await withCubeFetchStub(async ({ url, method }) => {
    if (method === "POST" && url === "http://cube.test/sandboxes") {
      return new Response(JSON.stringify({
        templateID: "tpl-demo",
        sandboxID: "sbx-snapshot",
        clientID: "client-demo",
        envdVersion: "test",
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && url === "http://cube.test/sandboxes/sbx-snapshot/snapshots") {
      return new Response(JSON.stringify({
        message: "Not Found",
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }, async () => {
    try {
      const sandbox = await CubeSandbox.connect({
        runtimeId: "runtime-cube-snapshot",
        workDir,
        provider: "cube",
        env: {
          AGENT_SPACE_CUBE_ENABLE_EXPERIMENTAL: "true",
          AGENT_SPACE_CUBE_API_URL: "http://cube.test",
          AGENT_SPACE_CUBE_API_KEY: "dummy",
          AGENT_SPACE_CUBE_TEMPLATE_ID: "tpl-demo",
        },
      });

      const snapshotPath = await sandbox.snapshot();
      const copiedFile = await readFile(join(snapshotPath, "notes.txt"), "utf8");
      assert.equal(copiedFile, "hello cube\n");
      assert.ok(snapshotPath.includes(".snapshots"));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test("CubeSandbox.refreshStatus maps paused and unknown remote states", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agent-space-cube-status-"));
  let currentState = "paused";

  await withCubeFetchStub(async ({ url, method }) => {
    if (method === "POST" && url === "http://cube.test/sandboxes") {
      return new Response(JSON.stringify({
        templateID: "tpl-demo",
        sandboxID: "sbx-status",
        clientID: "client-demo",
        envdVersion: "test",
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "GET" && url === "http://cube.test/sandboxes/sbx-status") {
      return new Response(JSON.stringify({
        templateID: "tpl-demo",
        sandboxID: "sbx-status",
        clientID: "client-demo",
        envdVersion: "test",
        state: currentState,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }, async () => {
    try {
      const sandbox = await CubeSandbox.connect({
        runtimeId: "runtime-cube-status",
        workDir,
        provider: "cube",
        env: {
          AGENT_SPACE_CUBE_ENABLE_EXPERIMENTAL: "true",
          AGENT_SPACE_CUBE_API_URL: "http://cube.test",
          AGENT_SPACE_CUBE_API_KEY: "dummy",
          AGENT_SPACE_CUBE_TEMPLATE_ID: "tpl-demo",
        },
      });

      assert.equal(await sandbox.refreshStatus(), "hibernated");
      currentState = "mystery";
      assert.equal(await sandbox.refreshStatus(), "failed");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
