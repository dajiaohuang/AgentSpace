"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  matchesWorkspaceInvalidation,
  type WorkspaceInvalidationResourceType,
  type WorkspaceInvalidationEvent,
} from "@/features/dashboard/workspace-invalidation";
import type { WorkspaceModuleId } from "@/features/dashboard/workspace-module-route";

export type WorkspaceModuleCacheStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "error"
  | "forbidden";

export interface WorkspaceModuleCacheKey {
  workspaceId: string;
  moduleId: WorkspaceModuleId;
  resourceKey?: string;
  queryKey?: string;
  viewerIdentityVersion?: string | number;
  permissionVersion?: string | number;
}

export interface WorkspaceModuleCacheScope {
  viewerIdentityVersion?: string | number;
  permissionVersion?: string | number;
}

export interface WorkspaceModuleCacheMetadata {
  workspaceId: string;
  moduleId: WorkspaceModuleId;
  resourceKey?: string;
  resourceRefs?: Partial<Record<WorkspaceInvalidationResourceType, readonly string[]>>;
  queryKey: string;
  viewerIdentityVersion?: string | number;
  permissionVersion?: string | number;
  updatedAt: number;
  stale: boolean;
}

export interface WorkspaceModuleCacheEntry<TData = unknown> {
  status: WorkspaceModuleCacheStatus;
  data?: TData;
  error?: unknown;
  metadata: WorkspaceModuleCacheMetadata;
}

export interface WorkspaceModuleLoadOptions<TData> {
  cacheKey: WorkspaceModuleCacheKey;
  loader: (input: { signal: AbortSignal }) => Promise<TData>;
  metadata?: Partial<WorkspaceModuleCacheMetadata> | ((data: TData) => Partial<WorkspaceModuleCacheMetadata>);
  force?: boolean;
  forbidden?: (error: unknown) => boolean;
}

type WorkspaceModuleCacheContextValue = {
  get: <TData = unknown>(cacheKey: WorkspaceModuleCacheKey) => WorkspaceModuleCacheEntry<TData> | undefined;
  set: <TData>(cacheKey: WorkspaceModuleCacheKey, data: TData, metadata?: Partial<WorkspaceModuleCacheMetadata>) => void;
  load: <TData>(options: WorkspaceModuleLoadOptions<TData>) => Promise<TData>;
  markStale: (predicate: (entry: WorkspaceModuleCacheEntry) => boolean) => void;
  markInvalidated: (event: WorkspaceInvalidationEvent) => void;
  clearWorkspace: (workspaceId: string) => void;
  abort: (cacheKey: WorkspaceModuleCacheKey) => void;
};

type PendingWorkspaceModuleRequest<TData = unknown> = {
  controller: AbortController;
  promise: Promise<TData>;
};

const WorkspaceModuleCacheContext = createContext<WorkspaceModuleCacheContextValue | null>(null);
const WorkspaceModuleCacheRevisionContext = createContext(0);
const WorkspaceModuleCacheScopeContext = createContext<WorkspaceModuleCacheScope>({});

export function WorkspaceModuleCacheProvider({
  children,
  scope,
  workspaceId,
}: {
  children: React.ReactNode;
  scope?: WorkspaceModuleCacheScope;
  workspaceId?: string;
}) {
  const [cacheState, setCacheState] = useState<{
    entries: Map<string, WorkspaceModuleCacheEntry>;
    revision: number;
  }>(() => ({
    entries: new Map(),
    revision: 0,
  }));
  const entriesRef = useRef(cacheState.entries);
  const pendingRequestsRef = useRef<Map<string, PendingWorkspaceModuleRequest>>(new Map());
  const previousScopeSignatureRef = useRef<string | null>(null);
  entriesRef.current = cacheState.entries;
  const setEntries = useCallback((update: (current: Map<string, WorkspaceModuleCacheEntry>) => Map<string, WorkspaceModuleCacheEntry>) => {
    setCacheState((current) => {
      const nextEntries = update(current.entries);
      if (nextEntries === current.entries) {
        entriesRef.current = current.entries;
        return current;
      }

      entriesRef.current = nextEntries;
      return {
        entries: nextEntries,
        revision: current.revision + 1,
      };
    });
  }, []);
  const cacheScope = useMemo<WorkspaceModuleCacheScope>(
    () => ({
      viewerIdentityVersion: scope?.viewerIdentityVersion,
      permissionVersion: scope?.permissionVersion,
    }),
    [scope?.permissionVersion, scope?.viewerIdentityVersion],
  );
  const scopeSignature = useMemo(
    () => buildWorkspaceModuleCacheScopeSignature(cacheScope),
    [cacheScope.permissionVersion, cacheScope.viewerIdentityVersion],
  );

  const get = useCallback(<TData,>(cacheKey: WorkspaceModuleCacheKey): WorkspaceModuleCacheEntry<TData> | undefined => {
    return entriesRef.current.get(buildWorkspaceModuleCacheKey(cacheKey)) as WorkspaceModuleCacheEntry<TData> | undefined;
  }, []);

  const set = useCallback(<TData,>(
    cacheKey: WorkspaceModuleCacheKey,
    data: TData,
    metadata?: Partial<WorkspaceModuleCacheMetadata>,
  ) => {
    const normalizedKey = normalizeWorkspaceModuleCacheKey(cacheKey);
    setEntries((current) => {
      const next = new Map(current);
      next.set(normalizedKey.cacheKey, {
        status: "ready",
        data,
        metadata: {
          ...normalizedKey.metadata,
          ...metadata,
          updatedAt: metadata?.updatedAt ?? Date.now(),
          stale: metadata?.stale ?? false,
        },
      });
      return next;
    });
  }, [setEntries]);

  const markStale = useCallback((predicate: (entry: WorkspaceModuleCacheEntry) => boolean) => {
    setEntries((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [cacheKey, entry] of current.entries()) {
        if (!predicate(entry) || entry.metadata.stale) {
          continue;
        }
        changed = true;
        next.set(cacheKey, {
          ...entry,
          metadata: {
            ...entry.metadata,
            stale: true,
          },
        });
      }
      return changed ? next : current;
    });
  }, [setEntries]);
  const markInvalidated = useCallback((event: WorkspaceInvalidationEvent) => {
    markStale((entry) => matchesWorkspaceInvalidation(entry, event));
  }, [markStale]);

  const clearWorkspace = useCallback((workspaceId: string) => {
    for (const [cacheKey, pendingRequest] of pendingRequestsRef.current.entries()) {
      if (cacheKey.startsWith(`${workspaceId}:`)) {
        pendingRequest.controller.abort();
        pendingRequestsRef.current.delete(cacheKey);
      }
    }

    setEntries((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [cacheKey, entry] of current.entries()) {
        if (entry.metadata.workspaceId === workspaceId) {
          changed = true;
          next.delete(cacheKey);
        }
      }
      return changed ? next : current;
    });
  }, [setEntries]);

  useEffect(() => {
    if (!workspaceId) {
      previousScopeSignatureRef.current = scopeSignature;
      return;
    }

    const previousScopeSignature = previousScopeSignatureRef.current;
    previousScopeSignatureRef.current = scopeSignature;
    if (previousScopeSignature !== null && previousScopeSignature !== scopeSignature) {
      clearWorkspace(workspaceId);
    }
  }, [clearWorkspace, scopeSignature, workspaceId]);

  const abort = useCallback((cacheKey: WorkspaceModuleCacheKey) => {
    const normalizedKey = buildWorkspaceModuleCacheKey(cacheKey);
    const pendingRequest = pendingRequestsRef.current.get(normalizedKey);
    if (!pendingRequest) {
      return;
    }
    pendingRequest.controller.abort();
    pendingRequestsRef.current.delete(normalizedKey);
  }, []);

  const load = useCallback(<TData,>({
    cacheKey,
    loader,
    metadata,
    force = false,
    forbidden,
  }: WorkspaceModuleLoadOptions<TData>): Promise<TData> => {
    const normalizedKey = normalizeWorkspaceModuleCacheKey(cacheKey);
    const currentEntry = entriesRef.current.get(normalizedKey.cacheKey) as WorkspaceModuleCacheEntry<TData> | undefined;
    if (!force && currentEntry?.status === "ready" && !currentEntry.metadata.stale && currentEntry.data !== undefined) {
      return Promise.resolve(currentEntry.data);
    }

    const pendingRequest = pendingRequestsRef.current.get(normalizedKey.cacheKey) as PendingWorkspaceModuleRequest<TData> | undefined;
    if (!force && pendingRequest) {
      return pendingRequest.promise;
    }
    if (force && pendingRequest) {
      pendingRequest.controller.abort();
      pendingRequestsRef.current.delete(normalizedKey.cacheKey);
    }

    const controller = new AbortController();
    setEntries((current) => {
      const next = new Map(current);
      const previousEntry = current.get(normalizedKey.cacheKey);
      next.set(normalizedKey.cacheKey, {
        status: previousEntry?.data === undefined ? "loading" : "refreshing",
        data: previousEntry?.data,
        metadata: {
          ...normalizedKey.metadata,
          resourceRefs: previousEntry?.metadata.resourceRefs,
          updatedAt: previousEntry?.metadata.updatedAt ?? Date.now(),
          stale: previousEntry?.metadata.stale ?? false,
        },
      });
      return next;
    });

    const promise = loader({ signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) {
          return data;
        }
        const loadedMetadata = typeof metadata === "function" ? metadata(data) : metadata;
        setEntries((current) => {
          if (controller.signal.aborted) {
            return current;
          }
          const next = new Map(current);
          next.set(normalizedKey.cacheKey, {
            status: "ready",
            data,
            metadata: {
              ...normalizedKey.metadata,
              ...loadedMetadata,
              updatedAt: Date.now(),
              stale: false,
            },
          });
          return next;
        });
        return data;
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          throw error;
        }
        setEntries((current) => {
          if (controller.signal.aborted) {
            return current;
          }
          const next = new Map(current);
          const previousEntry = current.get(normalizedKey.cacheKey);
          const isForbidden = forbidden?.(error) ?? false;
          next.set(normalizedKey.cacheKey, {
            status: isForbidden ? "forbidden" : "error",
            data: isForbidden ? undefined : previousEntry?.data,
            error,
            metadata: {
              ...normalizedKey.metadata,
              resourceRefs: previousEntry?.metadata.resourceRefs,
              updatedAt: previousEntry?.metadata.updatedAt ?? Date.now(),
              stale: true,
            },
          });
          return next;
        });
        throw error;
      })
      .finally(() => {
        if (pendingRequestsRef.current.get(normalizedKey.cacheKey)?.controller === controller) {
          pendingRequestsRef.current.delete(normalizedKey.cacheKey);
        }
      });

    pendingRequestsRef.current.set(normalizedKey.cacheKey, { controller, promise });
    return promise;
  }, [setEntries]);

  const value = useMemo<WorkspaceModuleCacheContextValue>(
    () => ({ get, set, load, markStale, markInvalidated, clearWorkspace, abort }),
    [abort, clearWorkspace, get, load, markInvalidated, markStale, set],
  );

  return (
    <WorkspaceModuleCacheScopeContext.Provider value={cacheScope}>
      <WorkspaceModuleCacheRevisionContext.Provider value={cacheState.revision}>
        <WorkspaceModuleCacheContext.Provider value={value}>
          {children}
        </WorkspaceModuleCacheContext.Provider>
      </WorkspaceModuleCacheRevisionContext.Provider>
    </WorkspaceModuleCacheScopeContext.Provider>
  );
}

export function useWorkspaceModuleCache(): WorkspaceModuleCacheContextValue {
  const context = useContext(WorkspaceModuleCacheContext);
  if (!context) {
    throw new Error("useWorkspaceModuleCache must be used within WorkspaceModuleCacheProvider.");
  }
  return context;
}

export function useOptionalWorkspaceModuleCache(): WorkspaceModuleCacheContextValue | null {
  return useContext(WorkspaceModuleCacheContext);
}

export function useWorkspaceModuleCacheRevision(): number {
  return useContext(WorkspaceModuleCacheRevisionContext);
}

export function useWorkspaceModuleCacheScope(): WorkspaceModuleCacheScope {
  return useContext(WorkspaceModuleCacheScopeContext);
}

export function buildWorkspaceModuleCacheScopeSignature(scope: WorkspaceModuleCacheScope): string {
  return [
    scope.viewerIdentityVersion ?? "",
    scope.permissionVersion ?? "",
  ].map(encodeCacheKeyPart).join(":");
}

export function buildWorkspaceModulePermissionVersion(input: {
  accessScope: "workspace" | "channel";
  role: string;
  channelNames?: readonly string[];
}): string {
  const channelNames = input.accessScope === "channel"
    ? [...new Set((input.channelNames ?? []).map((name) => name.trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }))
    : [];
  return JSON.stringify({
    accessScope: input.accessScope,
    role: input.role,
    channelNames,
  });
}

export function scopeWorkspaceModuleCacheKey(
  cacheKey: WorkspaceModuleCacheKey,
  scope: WorkspaceModuleCacheScope,
): WorkspaceModuleCacheKey {
  return {
    ...cacheKey,
    viewerIdentityVersion: scope.viewerIdentityVersion ?? cacheKey.viewerIdentityVersion,
    permissionVersion: scope.permissionVersion ?? cacheKey.permissionVersion,
  };
}

export function buildWorkspaceModuleCacheKey(cacheKey: WorkspaceModuleCacheKey): string {
  return normalizeWorkspaceModuleCacheKey(cacheKey).cacheKey;
}

function normalizeWorkspaceModuleCacheKey(cacheKey: WorkspaceModuleCacheKey): {
  cacheKey: string;
  metadata: WorkspaceModuleCacheMetadata;
} {
  const queryKey = cacheKey.queryKey ?? "";
  const viewerIdentityVersion = cacheKey.viewerIdentityVersion ?? "";
  const permissionVersion = cacheKey.permissionVersion ?? "";
  const cacheKeyParts = cacheKey.resourceKey === undefined
    ? [
        cacheKey.workspaceId,
        cacheKey.moduleId,
        queryKey,
        viewerIdentityVersion,
        permissionVersion,
      ]
    : [
        cacheKey.workspaceId,
        cacheKey.moduleId,
        cacheKey.resourceKey,
        queryKey,
        viewerIdentityVersion,
        permissionVersion,
      ];

  return {
    cacheKey: cacheKeyParts.map(encodeCacheKeyPart).join(":"),
    metadata: {
      workspaceId: cacheKey.workspaceId,
      moduleId: cacheKey.moduleId,
      resourceKey: cacheKey.resourceKey,
      queryKey,
      viewerIdentityVersion: cacheKey.viewerIdentityVersion,
      permissionVersion: cacheKey.permissionVersion,
      updatedAt: Date.now(),
      stale: false,
    },
  };
}

function encodeCacheKeyPart(value: string | number): string {
  return encodeURIComponent(String(value));
}
