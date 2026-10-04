"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveWorkspaceShellCounters,
  type WorkspaceShellCounters,
} from "@/features/dashboard/workspace-shell-counters";
import { recordWorkspaceShellCountersRefresh } from "@/features/dashboard/workspace-navigation-performance";
import type { WorkspaceShellData } from "@/features/dashboard/workspace-shell-data";

export function useWorkspaceShellCounters({
  initialShell,
  workspaceSlug,
}: {
  initialShell: WorkspaceShellData;
  workspaceSlug: string;
}): {
  counters: WorkspaceShellCounters;
  refreshCounters: () => void;
} {
  const initialCounters = useMemo(() => deriveWorkspaceShellCounters(initialShell), [initialShell]);
  const [counters, setCounters] = useState<WorkspaceShellCounters>(initialCounters);
  const pendingRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setCounters(initialCounters);
  }, [initialCounters]);

  const refreshCounters = useCallback(() => {
    recordWorkspaceShellCountersRefresh(workspaceSlug);
    pendingRequestRef.current?.abort();
    const controller = new AbortController();
    pendingRequestRef.current = controller;
    void fetch(`/api/workspaces/${encodeURIComponent(workspaceSlug)}/shell-counters`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json() as Promise<{ data: WorkspaceShellCounters }>;
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setCounters((current) => controller.signal.aborted ? current : payload.data);
        }
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.debug("[workspace:shell-counters] refresh failed", error);
        }
      })
      .finally(() => {
        if (pendingRequestRef.current === controller) {
          pendingRequestRef.current = null;
        }
      });
  }, [workspaceSlug]);

  useEffect(() => () => pendingRequestRef.current?.abort(), [workspaceSlug]);

  return { counters, refreshCounters };
}
