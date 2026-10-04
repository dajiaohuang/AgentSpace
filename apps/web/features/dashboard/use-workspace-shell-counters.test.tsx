import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceShellCounters } from "./use-workspace-shell-counters";
import type { WorkspaceShellData } from "./workspace-shell-data";

vi.mock("./workspace-navigation-performance", () => ({ recordWorkspaceShellCountersRefresh: vi.fn() }));

const initialShell: WorkspaceShellData = {
  organizationName: "Northstar Labs",
  humanMembers: 1, channelCount: 1, messageCount: 1, unreadNotificationCount: 0,
  openTaskCount: 0, pendingApprovalCount: 0, localAgentCount: 0, remoteAgentCount: 0,
  skillCount: 0, knowledgePageCount: 0, contactCount: 0,
  channels: [], channelMemberCandidates: [], humanContacts: [], agents: [], directMessages: [],
};

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps newer counters when the cancelled response body resolves later", async () => {
  let resolveOlder!: (data: unknown) => void;
  const olderBody = new Promise((resolve) => { resolveOlder = resolve; });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: () => olderBody })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { unreadNotificationCount: 3 } }) });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useWorkspaceShellCounters({ initialShell, workspaceSlug: "northstar" }));

  await act(async () => { result.current.refreshCounters(); });
  await act(async () => { result.current.refreshCounters(); });
  expect(result.current.counters.unreadNotificationCount).toBe(3);
  await act(async () => { resolveOlder({ data: { unreadNotificationCount: 1 } }); });

  expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(result.current.counters.unreadNotificationCount).toBe(3);
});

it("cancels the previous workspace counters when the workspace changes", async () => {
  let resolveOlder!: (data: unknown) => void;
  const olderBody = new Promise((resolve) => { resolveOlder = resolve; });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => olderBody });
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(
    ({ workspaceSlug, shell }) => useWorkspaceShellCounters({ initialShell: shell, workspaceSlug }),
    { initialProps: { workspaceSlug: "northstar", shell: initialShell } },
  );

  await act(async () => { result.current.refreshCounters(); });
  rerender({ workspaceSlug: "other", shell: { ...initialShell, unreadNotificationCount: 5 } });
  await act(async () => { resolveOlder({ data: { unreadNotificationCount: 1 } }); });

  expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(result.current.counters.unreadNotificationCount).toBe(5);
});
