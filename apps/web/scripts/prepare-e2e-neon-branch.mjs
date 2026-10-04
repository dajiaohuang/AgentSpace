#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_NEON_API_HOST = "https://console.neon.tech/api/v2";
const BRANCH_PREFIX = "e2e";

async function main() {
  const args = new Set(process.argv.slice(2));
  const json = args.has("--json");
  const dryRun = args.has("--dry-run");
  const result = await prepareE2eNeonBranch({ dryRun });

  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(JSON.stringify({
    branchCreated: result.branchCreated,
    branchId: result.branchId,
    branchName: result.branchName,
    projectId: result.projectId,
    databaseUrl: redactDatabaseUrl(result.databaseUrl),
  }, null, 2));
}

export async function prepareE2eNeonBranch(options = {}) {
  const repositoryRoot = findRepositoryRoot();
  const env = readPreparedEnv(repositoryRoot);
  const explicitTestDatabaseUrl = firstValue(
    env.AGENT_SPACE_TEST_DATABASE_URL,
    env.AGENT_SPACE_PG_TEST_URL,
  );

  if (
    explicitTestDatabaseUrl
    && env.AGENT_SPACE_E2E === "1"
    && env.AGENT_SPACE_E2E_NEON_BRANCH_ID
    && env.AGENT_SPACE_E2E_NEON_BRANCH_NAME?.startsWith(`${BRANCH_PREFIX}-`)
  ) {
    return buildResult({
      branchCreated: false,
      branchId: env.AGENT_SPACE_E2E_NEON_BRANCH_ID,
      branchName: env.AGENT_SPACE_E2E_NEON_BRANCH_NAME,
      databaseUrl: explicitTestDatabaseUrl,
      endpointId: env.AGENT_SPACE_E2E_NEON_ENDPOINT_ID,
      projectId: env.AGENT_SPACE_E2E_NEON_PROJECT_ID || env.NEON_PROJECT_ID,
      repositoryRoot,
    });
  }

  if (explicitTestDatabaseUrl && env.AGENT_SPACE_E2E_FORCE_NEON_BRANCH !== "1") {
    const branchName = env.AGENT_SPACE_E2E_NEON_BRANCH_NAME || "existing-test-database";
    const branchId = env.AGENT_SPACE_E2E_NEON_BRANCH_ID || "existing-test-database";
    return buildResult({
      branchCreated: false,
      branchId,
      branchName,
      databaseUrl: explicitTestDatabaseUrl,
      projectId: env.AGENT_SPACE_E2E_NEON_PROJECT_ID || env.NEON_PROJECT_ID,
      repositoryRoot,
    });
  }

  const apiKey = firstValue(env.NEON_API_KEY, env.AGENT_SPACE_NEON_API_KEY);
  if (!apiKey) {
    throw new Error(
      "E2E Neon branch setup requires NEON_API_KEY. "
      + "Put it in the shell environment or in the repository-local .env.neon file.",
    );
  }

  const parentDatabaseUrl = firstValue(
    env.AGENT_SPACE_E2E_NEON_PARENT_DATABASE_URL,
    env.NEON_DATABASE_URL,
    env.DATABASE_URL,
    env.AGENT_SPACE_PG_URL,
  );
  if (!parentDatabaseUrl) {
    throw new Error(
      "E2E Neon branch setup requires a parent Neon database URL. "
      + "Set AGENT_SPACE_E2E_NEON_PARENT_DATABASE_URL or NEON_DATABASE_URL.",
    );
  }

  const parentDatabase = parseDatabaseConnection(parentDatabaseUrl);
  const apiHost = firstValue(env.NEON_API_HOST, env.AGENT_SPACE_NEON_API_HOST) || DEFAULT_NEON_API_HOST;
  const projectId = await resolveProjectId({
    apiHost,
    apiKey,
    env,
    parentHost: parentDatabase.host,
  });
  const parentBranchId = await resolveParentBranchId({
    apiHost,
    apiKey,
    env,
    projectId,
  });
  const branchName = buildBranchName(env.AGENT_SPACE_E2E_NEON_BRANCH_NAME);

  if (options.dryRun === true) {
    return buildResult({
      branchCreated: false,
      branchId: "dry-run",
      branchName,
      databaseUrl: parentDatabaseUrl,
      projectId,
      repositoryRoot,
    });
  }

  const created = await createBranch({
    apiHost,
    apiKey,
    branchName,
    parentBranchId,
    projectId,
    suspendTimeoutSeconds: parsePositiveInteger(env.AGENT_SPACE_E2E_NEON_SUSPEND_TIMEOUT_SECONDS, 300),
  });
  const connectionUri = pickConnectionUri(created)
    || await fetchConnectionUri({
      apiHost,
      apiKey,
      branchId: created.branch.id,
      databaseName: parentDatabase.databaseName,
      projectId,
      roleName: parentDatabase.roleName,
    });

  return buildResult({
    branchCreated: true,
    branchId: created.branch.id,
    branchName: created.branch.name || branchName,
    databaseUrl: connectionUri,
    endpointId: created.endpoints?.[0]?.id,
    projectId,
    repositoryRoot,
  });
}

function buildResult(input) {
  const env = {
    AGENT_SPACE_E2E: "1",
    AGENT_SPACE_E2E_DATABASE_URL: input.databaseUrl,
    AGENT_SPACE_E2E_NEON_BRANCH_ID: input.branchId,
    AGENT_SPACE_E2E_NEON_BRANCH_NAME: input.branchName,
    AGENT_SPACE_REPOSITORY_ROOT: input.repositoryRoot,
    AGENT_SPACE_TEST_DATABASE_URL: input.databaseUrl,
    AGENT_SPACE_PG_TEST_URL: input.databaseUrl,
    AGENT_SPACE_PG_URL: input.databaseUrl,
    DATABASE_URL: input.databaseUrl,
    NEON_DATABASE_URL: input.databaseUrl,
  };
  if (input.projectId) {
    env.AGENT_SPACE_E2E_NEON_PROJECT_ID = input.projectId;
  }
  if (input.endpointId) {
    env.AGENT_SPACE_E2E_NEON_ENDPOINT_ID = input.endpointId;
  }

  return {
    branchCreated: input.branchCreated,
    branchId: input.branchId,
    branchName: input.branchName,
    databaseUrl: input.databaseUrl,
    endpointId: input.endpointId,
    env,
    projectId: input.projectId,
  };
}

async function createBranch(input) {
  const body = {
    branch: {
      name: input.branchName,
      ...(input.parentBranchId ? { parent_id: input.parentBranchId } : {}),
    },
    endpoints: [
      {
        type: "read_write",
        suspend_timeout_seconds: input.suspendTimeoutSeconds,
      },
    ],
  };

  const payload = await neonRequest(input.apiHost, input.apiKey, `/projects/${encodeURIComponent(input.projectId)}/branches`, {
    body: JSON.stringify(body),
    method: "POST",
  });
  if (!payload.branch?.id) {
    throw new Error("Neon did not return a branch id for the E2E branch.");
  }
  return payload;
}

async function fetchConnectionUri(input) {
  const params = new URLSearchParams({
    branch_id: input.branchId,
    database_name: input.databaseName,
    role_name: input.roleName,
  });
  const payload = await neonRequest(
    input.apiHost,
    input.apiKey,
    `/projects/${encodeURIComponent(input.projectId)}/connection_uri?${params.toString()}`,
  );
  const connectionUri = payload.connection_uri || payload.connection_uris?.[0]?.connection_uri;
  if (!connectionUri) {
    throw new Error("Neon did not return a connection URI for the E2E branch.");
  }
  return connectionUri;
}

function pickConnectionUri(created) {
  const value = created.connection_uris?.[0]?.connection_uri;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveProjectId(input) {
  const explicitProjectId = firstValue(
    input.env.AGENT_SPACE_E2E_NEON_PROJECT_ID,
    input.env.NEON_PROJECT_ID,
  );
  if (explicitProjectId) {
    return explicitProjectId;
  }

  const orgIds = await resolveOrganizationIds(input);
  const matches = [];
  for (const orgId of orgIds) {
    const projectsPayload = await neonRequest(
      input.apiHost,
      input.apiKey,
      `/projects?${new URLSearchParams({ org_id: orgId }).toString()}`,
    );
    for (const project of projectsPayload.projects ?? []) {
      if (input.env.AGENT_SPACE_E2E_NEON_PROJECT_NAME && project.name !== input.env.AGENT_SPACE_E2E_NEON_PROJECT_NAME) {
        continue;
      }
      if (!input.parentHost) {
        matches.push(project);
        continue;
      }
      const endpointsPayload = await neonRequest(
        input.apiHost,
        input.apiKey,
        `/projects/${encodeURIComponent(project.id)}/endpoints`,
      );
      const hasHost = (endpointsPayload.endpoints ?? []).some((endpoint) => endpointMatchesHost(endpoint, input.parentHost));
      if (hasHost) {
        matches.push(project);
      }
    }
  }

  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Neon projects matched the configured database host. Set AGENT_SPACE_E2E_NEON_PROJECT_ID. Matches: ${
        matches.map((project) => `${project.name} (${project.id})`).join(", ")
      }`,
    );
  }

  throw new Error(
    "Could not infer the Neon project for E2E. "
    + "Set AGENT_SPACE_E2E_NEON_PROJECT_ID to the project id that should receive E2E branches.",
  );
}

async function resolveOrganizationIds(input) {
  const explicitOrgId = firstValue(input.env.AGENT_SPACE_E2E_NEON_ORG_ID, input.env.NEON_ORG_ID);
  if (explicitOrgId) {
    return [explicitOrgId];
  }
  const payload = await neonRequest(input.apiHost, input.apiKey, "/users/me/organizations");
  const organizations = payload.organizations ?? [];
  if (organizations.length === 0) {
    throw new Error("The Neon API key is not associated with any organization.");
  }
  return organizations.map((organization) => organization.id);
}

async function resolveParentBranchId(input) {
  const parent = firstValue(
    input.env.AGENT_SPACE_E2E_NEON_PARENT_BRANCH_ID,
    input.env.AGENT_SPACE_E2E_NEON_PARENT_BRANCH,
  );
  if (!parent) {
    return undefined;
  }
  if (parent.startsWith("br-")) {
    return parent;
  }

  const payload = await neonRequest(input.apiHost, input.apiKey, `/projects/${encodeURIComponent(input.projectId)}/branches`);
  const branch = (payload.branches ?? []).find((candidate) => candidate.name === parent);
  if (!branch) {
    throw new Error(`Could not find Neon parent branch named "${parent}".`);
  }
  return branch.id;
}

function endpointMatchesHost(endpoint, host) {
  const hosts = [
    endpoint.host,
    endpoint.hosts?.read_write_host,
    endpoint.hosts?.read_write_pooled_host,
  ].filter(Boolean);
  return hosts.includes(host);
}

async function neonRequest(apiHost, apiKey, path, init = {}) {
  const response = await fetch(`${apiHost.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Neon API request failed (${response.status}) for ${path}: ${message}`);
  }
  return response.json();
}

function readPreparedEnv(repositoryRoot) {
  return {
    ...readEnvFile(join(repositoryRoot, ".env")),
    ...readEnvFile(join(repositoryRoot, ".env.neon")),
    ...process.env,
  };
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseDotEnv(readFileSync(filePath, "utf8"));
}

function parseDotEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const rawKey = trimmed.slice(0, separatorIndex).trim();
    const key = rawKey.startsWith("export ") ? rawKey.slice("export ".length).trim() : rawKey;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function findRepositoryRoot() {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, "Target.md"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    }
    current = parent;
  }
}

function parseDatabaseConnection(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The configured Neon database URL is not a valid URL.");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const roleName = decodeURIComponent(url.username);
  if (!databaseName || !roleName || !url.hostname) {
    throw new Error("The configured Neon database URL must include a host, role name, and database name.");
  }
  return {
    databaseName,
    host: url.hostname,
    roleName,
  };
}

function buildBranchName(explicitName) {
  if (explicitName?.trim()) {
    return explicitName.trim();
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  const random = Math.random().toString(36).slice(2, 8);
  return `${BRANCH_PREFIX}-${timestamp}-${random}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function redactDatabaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.password) {
      url.password = "***";
    }
    return url.toString();
  } catch {
    return String(rawUrl).replace(/:[^:@/]+@/, ":***@");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
