import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceModulePermissionVersion,
  buildWorkspaceModuleCacheKey,
  scopeWorkspaceModuleCacheKey,
  WorkspaceModuleCacheProvider,
  type WorkspaceModuleCacheScope,
  type WorkspaceModuleCacheKey,
  type WorkspaceModuleCacheStatus,
  useWorkspaceModuleCacheRevision,
  useWorkspaceModuleCache,
} from "@/features/dashboard/workspace-module-cache";

type CacheApi = ReturnType<typeof useWorkspaceModuleCache>;

const cacheKey: WorkspaceModuleCacheKey = {
  workspaceId: "workspace-1",
  moduleId: "performance",
  queryKey: "period=month",
  viewerIdentityVersion: "user-1",
  permissionVersion: 1,
};

function CacheProbe({ onReady }: { onReady: (api: CacheApi) => void }) {
  const api = useWorkspaceModuleCache();
  onReady(api);
  return null;
}

function CacheRevisionProbe({ onReady }: { onReady: (api: CacheApi) => void }) {
  const api = useWorkspaceModuleCache();
  const revision = useWorkspaceModuleCacheRevision();
  const entry = api.get<{ value: number }>(cacheKey);
  onReady(api);
  return (
    <output data-testid="cache-revision">
      {revision}:{entry?.status ?? "missing"}:{entry?.data?.value ?? "empty"}
    </output>
  );
}

function renderCacheProbe(options?: {
  scope?: WorkspaceModuleCacheScope;
  workspaceId?: string;
}): {
  getApi: () => CacheApi;
  rerenderWithScope: (scope?: WorkspaceModuleCacheScope) => void;
} {
  let api: CacheApi | null = null;
  const view = render(
    <WorkspaceModuleCacheProvider scope={options?.scope} workspaceId={options?.workspaceId}>
      <CacheProbe onReady={(nextApi) => {
        api = nextApi;
      }} />
    </WorkspaceModuleCacheProvider>,
  );

  return {
    getApi: () => {
      if (!api) {
        throw new Error("Cache API was not initialized.");
      }
      return api;
    },
    rerenderWithScope: (scope?: WorkspaceModuleCacheScope) => {
      view.rerender(
        <WorkspaceModuleCacheProvider scope={scope} workspaceId={options?.workspaceId}>
          <CacheProbe onReady={(nextApi) => {
            api = nextApi;
          }} />
        </WorkspaceModuleCacheProvider>,
      );
    },
  };
}

describe("WorkspaceModuleCacheProvider", () => {
  it("stores, marks stale, and clears workspace-scoped module data", async () => {
    const { getApi } = renderCacheProbe();

    act(() => {
      getApi().set(cacheKey, { value: 42 }, { updatedAt: 1000 });
    });

    await waitFor(() => {
      expect(getApi().get<{ value: number }>(cacheKey)?.data?.value).toBe(42);
    });
    expect(getApi().get(cacheKey)?.metadata.stale).toBe(false);

    act(() => {
      getApi().markStale((entry) => entry.metadata.moduleId === "performance");
    });

    await waitFor(() => {
      expect(getApi().get(cacheKey)?.metadata.stale).toBe(true);
    });

    act(() => {
      getApi().clearWorkspace("workspace-1");
    });

    await waitFor(() => {
      expect(getApi().get(cacheKey)).toBeUndefined();
    });
  });

  it("marks only entries matched by workspace invalidation events as stale", async () => {
    const { getApi } = renderCacheProbe();
    const imKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "im",
      resourceKey: "channel-detail:general",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const agentsKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "agents",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const knowledgeKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "knowledge",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };

    act(() => {
      getApi().set(imKey, { value: "im" });
      getApi().set(agentsKey, { value: "agents" });
      getApi().set(knowledgeKey, { value: "knowledge" });
    });

    await waitFor(() => {
      expect(getApi().get(imKey)?.metadata.stale).toBe(false);
      expect(getApi().get(agentsKey)?.metadata.stale).toBe(false);
      expect(getApi().get(knowledgeKey)?.metadata.stale).toBe(false);
    });

    act(() => {
      getApi().markInvalidated({
        workspaceId: "workspace-1",
        resources: [{ type: "channel", id: "general" }],
      });
    });

    await waitFor(() => {
      expect(getApi().get(imKey)?.metadata.stale).toBe(true);
      expect(getApi().get(agentsKey)?.metadata.stale).toBe(false);
      expect(getApi().get(knowledgeKey)?.metadata.stale).toBe(false);
    });
  });

  it("does not stale unrelated modules for targeted task invalidations", async () => {
    const { getApi } = renderCacheProbe();
    const taskBoardKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "task-board",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const inboxKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "inbox",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const agentsKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "agents",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const imKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "im",
      resourceKey: "channel-detail:travel",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const knowledgeKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "knowledge",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const marketKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "market",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const settingsKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "settings",
      queryKey: "section=account",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };

    act(() => {
      getApi().set(taskBoardKey, { value: "task-board" });
      getApi().set(inboxKey, { value: "inbox" });
      getApi().set(agentsKey, { value: "agents" });
      getApi().set(imKey, { value: "im" });
      getApi().set(knowledgeKey, { value: "knowledge" });
      getApi().set(marketKey, { value: "market" });
      getApi().set(settingsKey, { value: "settings" });
    });

    await waitFor(() => {
      expect(getApi().get(settingsKey)?.metadata.stale).toBe(false);
    });

    act(() => {
      getApi().markInvalidated({
        workspaceId: "workspace-1",
        modules: ["task-board", "inbox", "agents", "im"],
        resources: [{ type: "task", id: "task-1" }],
        shell: "counters",
      });
    });

    await waitFor(() => {
      expect(getApi().get(taskBoardKey)?.metadata.stale).toBe(true);
      expect(getApi().get(inboxKey)?.metadata.stale).toBe(true);
      expect(getApi().get(agentsKey)?.metadata.stale).toBe(true);
      expect(getApi().get(imKey)?.metadata.stale).toBe(true);
      expect(getApi().get(knowledgeKey)?.metadata.stale).toBe(false);
      expect(getApi().get(marketKey)?.metadata.stale).toBe(false);
      expect(getApi().get(settingsKey)?.metadata.stale).toBe(false);
    });
  });

  it("matches targeted document invalidations through cache metadata refs", async () => {
    const { getApi } = renderCacheProbe();
    const imKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "im",
      resourceKey: "channel-detail:planning",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };
    const otherImKey: WorkspaceModuleCacheKey = {
      workspaceId: "workspace-1",
      moduleId: "im",
      resourceKey: "channel-detail:random",
      viewerIdentityVersion: "user-1",
      permissionVersion: "owner",
    };

    act(() => {
      getApi().set(imKey, { value: "planning" }, { resourceRefs: { document: ["doc-1"] } });
      getApi().set(otherImKey, { value: "random" }, { resourceRefs: { document: ["doc-2"] } });
    });

    await waitFor(() => {
      expect(getApi().get(imKey)?.metadata.stale).toBe(false);
      expect(getApi().get(otherImKey)?.metadata.stale).toBe(false);
    });

    act(() => {
      getApi().markInvalidated({
        workspaceId: "workspace-1",
        resources: [{ type: "document", id: "doc-1" }],
      });
    });

    await waitFor(() => {
      expect(getApi().get(imKey)?.metadata.stale).toBe(true);
      expect(getApi().get(otherImKey)?.metadata.stale).toBe(false);
    });
  });

  it("keeps the cache API stable while publishing entry revisions", async () => {
    let firstApi: CacheApi | null = null;
    let latestApi: CacheApi | null = null;
    render(
      <WorkspaceModuleCacheProvider>
        <CacheRevisionProbe onReady={(api) => {
          firstApi ??= api;
          latestApi = api;
        }} />
      </WorkspaceModuleCacheProvider>,
    );

    expect(screen.getByTestId("cache-revision")).toHaveTextContent("0:missing:empty");

    act(() => {
      latestApi?.set(cacheKey, { value: 42 });
    });

    await waitFor(() => {
      expect(screen.getByTestId("cache-revision")).toHaveTextContent("1:ready:42");
    });
    expect(latestApi).toBe(firstApi);
  });

  it("dedupes concurrent loads for the same cache key", async () => {
    const { getApi } = renderCacheProbe();
    const loader = vi.fn(async () => ({ loaded: true }));

    const [firstResult, secondResult] = await act(async () => {
      const first = getApi().load({ cacheKey, loader });
      const second = getApi().load({ cacheKey, loader });
      return Promise.all([first, second]);
    });

    expect(firstResult).toEqual({ loaded: true });
    expect(secondResult).toEqual({ loaded: true });
    expect(loader).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(getApi().get<{ loaded: boolean }>(cacheKey)?.status).toBe("ready");
    });
  });

  it("aborts an older pending request when a forced load starts", async () => {
    const { getApi } = renderCacheProbe();
    const observedStatuses: WorkspaceModuleCacheStatus[] = [];
    const abortSpy = vi.fn();
    let resolveSecond: ((value: { fresh: boolean }) => void) | undefined;
    let callCount = 0;

    const loader = vi.fn(({ signal }: { signal: AbortSignal }) => {
      callCount += 1;
      if (callCount === 1) {
        signal.addEventListener("abort", abortSpy);
        return new Promise<{ fresh: boolean }>(() => {});
      }

      return new Promise<{ fresh: boolean }>((resolve) => {
        resolveSecond = resolve;
      });
    });

    act(() => {
      void getApi().load({ cacheKey, loader });
    });

    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });

    const secondPromise = act(async () => {
      const promise = getApi().load({ cacheKey, loader, force: true });
      resolveSecond?.({ fresh: true });
      return promise;
    });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(await secondPromise).toEqual({ fresh: true });
    expect(loader).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      const entry = getApi().get<{ fresh: boolean }>(cacheKey);
      if (entry) {
        observedStatuses.push(entry.status);
      }
      expect(entry?.data?.fresh).toBe(true);
    });
    expect(observedStatuses).toContain("ready");
  });

  it("keeps the forced refresh when the cancelled older loader resolves later", async () => {
    const { getApi } = renderCacheProbe();
    let resolveOlder!: (data: { value: string }) => void;
    let olderRequest!: Promise<{ value: string }>;
    act(() => {
      olderRequest = getApi().load({
        cacheKey,
        loader: () => new Promise((resolve) => { resolveOlder = resolve; }),
      });
    });

    await act(async () => {
      await getApi().load({ cacheKey, force: true, loader: async () => ({ value: "fresh" }) });
    });
    await act(async () => {
      resolveOlder({ value: "outdated" });
      await olderRequest;
    });

    expect(getApi().get<{ value: string }>(cacheKey)?.data?.value).toBe("fresh");
  });

  it("does not recreate a cleared workspace entry when its cancelled loader resolves", async () => {
    const { getApi } = renderCacheProbe();
    let resolveOlder!: (data: { value: string }) => void;
    let olderRequest!: Promise<{ value: string }>;
    act(() => {
      olderRequest = getApi().load({
        cacheKey,
        loader: () => new Promise((resolve) => { resolveOlder = resolve; }),
      });
    });
    act(() => { getApi().clearWorkspace(cacheKey.workspaceId); });
    await act(async () => {
      resolveOlder({ value: "outdated" });
      await olderRequest;
    });

    expect(getApi().get(cacheKey)).toBeUndefined();
  });

  it("keeps stale data for normal load failures and clears it for forbidden failures", async () => {
    const { getApi } = renderCacheProbe();

    act(() => {
      getApi().set(cacheKey, { value: "previous" }, { updatedAt: 1000 });
    });

    await waitFor(() => {
      expect(getApi().get<{ value: string }>(cacheKey)?.data?.value).toBe("previous");
    });

    await act(async () => {
      await expect(getApi().load({
        cacheKey,
        force: true,
        loader: async () => {
          throw new Error("network failed");
        },
      })).rejects.toThrow("network failed");
    });

    await waitFor(() => {
      const entry = getApi().get<{ value: string }>(cacheKey);
      expect(entry?.status).toBe("error");
      expect(entry?.data?.value).toBe("previous");
    });

    await act(async () => {
      await expect(getApi().load({
        cacheKey,
        force: true,
        loader: async () => {
          throw new Error("forbidden");
        },
        forbidden: () => true,
      })).rejects.toThrow("forbidden");
    });

    await waitFor(() => {
      const entry = getApi().get<{ value: string }>(cacheKey);
      expect(entry?.status).toBe("forbidden");
      expect(entry?.data).toBeUndefined();
    });
  });

  it("uses a stable serialized cache key", () => {
    expect(buildWorkspaceModuleCacheKey(cacheKey)).toBe("workspace-1:performance:period%3Dmonth:user-1:1");
  });

  it("includes optional subresource keys without changing existing module keys", () => {
    expect(buildWorkspaceModuleCacheKey({
      workspaceId: "workspace-1",
      moduleId: "im",
      resourceKey: "channel-detail:tour visit",
      viewerIdentityVersion: "user-1",
      permissionVersion: "workspace:owner",
    })).toBe("workspace-1:im:channel-detail%3Atour%20visit::user-1:workspace%3Aowner");
  });

  it("serializes permission scope and applies it to cache keys", () => {
    const permissionVersion = buildWorkspaceModulePermissionVersion({
      accessScope: "channel",
      role: "member",
      channelNames: ["travel", "general", "travel"],
    });
    const scopedKey = scopeWorkspaceModuleCacheKey(
      {
        workspaceId: "workspace-1",
        moduleId: "im",
        queryKey: "focus=channel%3Ageneral",
      },
      {
        viewerIdentityVersion: "user-2",
        permissionVersion,
      },
    );

    expect(permissionVersion).toBe(JSON.stringify({
      accessScope: "channel",
      role: "member",
      channelNames: ["general", "travel"],
    }));
    expect(buildWorkspaceModuleCacheKey(scopedKey)).toBe(
      "workspace-1:im:focus%3Dchannel%253Ageneral:user-2:%7B%22accessScope%22%3A%22channel%22%2C%22role%22%3A%22member%22%2C%22channelNames%22%3A%5B%22general%22%2C%22travel%22%5D%7D",
    );
  });

  it("clears workspace entries when the viewer or permission scope changes", async () => {
    const { getApi, rerenderWithScope } = renderCacheProbe({
      workspaceId: "workspace-1",
      scope: {
        viewerIdentityVersion: "user-1",
        permissionVersion: "workspace:owner:",
      },
    });

    const ownerKey = scopeWorkspaceModuleCacheKey(cacheKey, {
      viewerIdentityVersion: "user-1",
      permissionVersion: "workspace:owner:",
    });
    act(() => {
      getApi().set(ownerKey, { value: "owner-only" });
    });

    await waitFor(() => {
      expect(getApi().get<{ value: string }>(ownerKey)?.data?.value).toBe("owner-only");
    });

    rerenderWithScope({
      viewerIdentityVersion: "user-1",
      permissionVersion: "channel:member:general",
    });

    await waitFor(() => {
      expect(getApi().get(ownerKey)).toBeUndefined();
    });
  });
});
