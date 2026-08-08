import { create } from "zustand";
import type {
  MotionMode,
  PercentBase,
  ScanComplete,
  ScanNode,
  ScanProgress,
  ScanStarted,
  SortMode,
} from "./types";

interface ScanState {
  nodes: Map<string, ScanNode>;
  rootId: string | null;
  rootPath: string | null;
  scanning: boolean;
  scanError: string | null;
  nodeCount: number;
  totalSize: number;
  durationMs: number | null;
  progress: ScanProgress | null;
  expandedIds: Set<string>;
  selectedId: string | null;
  focusRequest: { id: string; nonce: number } | null;
  expandRequest: { id: string; nonce: number } | null;
  fitRequest: { nonce: number } | null;
  percentBase: PercentBase;
  stale: boolean;
  contextMenu: { x: number; y: number; nodeId: string } | null;
  renamingId: string | null;
  createDialog: {
    parentId: string;
    step: "type" | "name";
    kind: "file" | "dir";
    extension: string | null;
  } | null;
  defaultDepth: number;
  sortMode: SortMode;
  motion: MotionMode;
  excludeRules: string[];
  shellMenuEnabled: boolean;
  progressNonce: number;
  localProgress: { nodeIds: string[]; nonce: number } | null;
  setStarted: (payload: ScanStarted) => void;
  addNodes: (nodes: ScanNode[]) => void;
  applyTotals: (items: Array<{ id: string; totalSize: number }>) => void;
  setProgress: (payload: ScanProgress) => void;
  setComplete: (payload: ScanComplete) => void;
  setError: (message: string) => void;
  clear: () => void;
  setExpanded: (id: string, expanded: boolean, animateIds?: string[]) => void;
  setExpandedMany: (
    ids: string[],
    expanded: boolean,
    animateIds?: string[]
  ) => void;
  setExpandedSet: (ids: Set<string>, animateIds?: string[]) => void;
  collapseAll: () => void;
  requestExpand: (id: string) => void;
  clearExpandRequest: () => void;
  requestFocus: (id: string) => void;
  requestFit: () => void;
  clearFitRequest: () => void;
  setSelected: (id: string | null) => void;
  setPercentBase: (base: PercentBase) => void;
  setStale: (stale: boolean) => void;
  setContextMenu: (menu: { x: number; y: number; nodeId: string } | null) => void;
  setRenaming: (id: string | null) => void;
  clearRenaming: () => void;
  setCreateDialog: (
    dialog: {
      parentId: string;
      step: "type" | "name";
      kind: "file" | "dir";
      extension: string | null;
    } | null
  ) => void;
  clearCreateDialog: () => void;
  renameNodeLocal: (oldId: string, newName: string, newPath: string) => void;
  removeSubtree: (id: string) => void;
  updateSettings: (
    partial: Partial<
      Pick<
        ScanState,
        "defaultDepth" | "sortMode" | "motion" | "excludeRules" | "shellMenuEnabled"
      >
    >
  ) => void;
  bumpProgress: () => void;
}

let nonce = 0;
let progressNonceCounter = 0;
let localProgressCounter = 0;

function collectDescendantIds(
  nodes: Map<string, ScanNode>,
  rootIds: string[]
): string[] {
  const result: string[] = [];
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    for (const childId of node.childrenIds) {
      if (!result.includes(childId)) {
        result.push(childId);
        stack.push(childId);
      }
    }
  }
  return result;
}

function collectSubtreeIds(
  nodes: Map<string, ScanNode>,
  rootIds: string[]
): Set<string> {
  const ids = new Set<string>(rootIds);
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    for (const childId of node.childrenIds) {
      if (!ids.has(childId)) {
        ids.add(childId);
        stack.push(childId);
      }
    }
  }
  return ids;
}

type StoredSettings = Pick<
  ScanState,
  "defaultDepth" | "sortMode" | "motion" | "excludeRules" | "shellMenuEnabled"
>;

const savedSettings: Partial<StoredSettings> = (() => {
  try {
    const raw = localStorage.getItem("file-visualizer-settings");
    return raw ? (JSON.parse(raw) as Partial<StoredSettings>) : {};
  } catch {
    return {};
  }
})();

export const useScanStore = create<ScanState>()((set) => ({
  nodes: new Map(),
  rootId: null,
  rootPath: null,
  scanning: false,
  scanError: null,
  nodeCount: 0,
  totalSize: 0,
  durationMs: null,
  progress: null,
  expandedIds: new Set(),
  selectedId: null,
  focusRequest: null,
  expandRequest: null,
  fitRequest: null,
  percentBase: "root",
  stale: false,
  contextMenu: null,
  renamingId: null,
  createDialog: null,
  defaultDepth: savedSettings.defaultDepth ?? 3,
  sortMode: savedSettings.sortMode ?? "size",
  motion: savedSettings.motion ?? "standard",
  excludeRules: savedSettings.excludeRules ?? [],
  shellMenuEnabled: savedSettings.shellMenuEnabled ?? false,
  progressNonce: 0,
  localProgress: null,

  setStarted: (payload) =>
    set({
      nodes: new Map(),
      rootId: payload.rootId,
      rootPath: payload.path,
      scanning: true,
      scanError: null,
      nodeCount: 0,
      totalSize: 0,
      durationMs: null,
      progress: null,
      expandedIds: new Set(),
      selectedId: null,
      focusRequest: null,
      expandRequest: null,
      fitRequest: null,
      stale: false,
      contextMenu: null,
      renamingId: null,
      createDialog: null,
      progressNonce: 0,
      localProgress: null,
    }),

  addNodes: (incoming) =>
    set((state) => {
      const nodes = new Map(state.nodes);
      for (const node of incoming) {
        nodes.set(node.id, node);
      }
      return {
        nodes,
        nodeCount: state.nodeCount + incoming.length,
      };
    }),

  applyTotals: (items) =>
    set((state) => {
      const nodes = new Map(state.nodes);
      for (const item of items) {
        const node = nodes.get(item.id);
        if (node) {
          nodes.set(item.id, { ...node, totalSize: item.totalSize });
        }
      }
      const rootNode = state.rootId ? nodes.get(state.rootId) : undefined;
      return {
        nodes,
        totalSize: rootNode?.totalSize ?? state.totalSize,
      };
    }),

  setProgress: (progress) => set({ progress }),

  setComplete: (payload) =>
    set((state) => {
      const expandedIds = new Set<string>();
      for (const node of state.nodes.values()) {
        if (node.kind === "dir" && node.depth < state.defaultDepth) {
          expandedIds.add(node.id);
        }
      }
      return {
        scanning: false,
        nodeCount: payload.nodeCount,
        totalSize: payload.totalSize,
        durationMs: payload.durationMs,
        expandedIds,
        progressNonce: ++progressNonceCounter,
        localProgress: null,
      };
    }),

  setError: (message) =>
    set({
      scanError: message,
      scanning: false,
      progress: null,
      expandRequest: null,
      fitRequest: null,
      stale: false,
      contextMenu: null,
      renamingId: null,
      createDialog: null,
    }),

  clear: () =>
    set({
      nodes: new Map(),
      rootId: null,
      rootPath: null,
      scanning: false,
      scanError: null,
      nodeCount: 0,
      totalSize: 0,
      durationMs: null,
      progress: null,
      expandedIds: new Set(),
      selectedId: null,
      focusRequest: null,
      expandRequest: null,
      fitRequest: null,
      stale: false,
      contextMenu: null,
      renamingId: null,
      createDialog: null,
      progressNonce: 0,
      localProgress: null,
    }),

  setExpanded: (id, expanded, animateIds) =>
    set((state) => {
      const expandedIds = new Set(state.expandedIds);
      if (expanded) {
        expandedIds.add(id);
      } else {
        const subtreeIds = collectSubtreeIds(state.nodes, [id]);
        for (const subtreeId of subtreeIds) {
          expandedIds.delete(subtreeId);
        }
      }
      return {
        expandedIds,
        localProgress: expanded
          ? {
              nodeIds: animateIds ?? collectDescendantIds(state.nodes, [id]),
              nonce: ++localProgressCounter,
            }
          : null,
      };
    }),

  setExpandedMany: (ids, expanded, animateIds) =>
    set((state) => {
      const expandedIds = new Set(state.expandedIds);
      for (const id of ids) {
        if (expanded) {
          expandedIds.add(id);
        }
      }
      if (!expanded && ids.length > 0) {
        const subtreeIds = collectSubtreeIds(state.nodes, ids);
        for (const subtreeId of subtreeIds) {
          expandedIds.delete(subtreeId);
        }
      }
      return {
        expandedIds,
        localProgress: expanded
          ? {
              nodeIds: animateIds ?? collectDescendantIds(state.nodes, ids),
              nonce: ++localProgressCounter,
            }
          : null,
      };
    }),

  setExpandedSet: (ids, animateIds) =>
    set((state) => ({
      expandedIds: new Set(ids),
      localProgress: {
        nodeIds:
          animateIds ?? collectDescendantIds(state.nodes, Array.from(ids)),
        nonce: ++localProgressCounter,
      },
    })),

  collapseAll: () =>
    set({ expandedIds: new Set(), localProgress: null }),

  requestExpand: (id) => set({ expandRequest: { id, nonce: ++nonce } }),

  clearExpandRequest: () => set({ expandRequest: null }),

  requestFocus: (id) => set({ focusRequest: { id, nonce: ++nonce } }),

  requestFit: () => set({ fitRequest: { nonce: ++nonce } }),

  clearFitRequest: () => set({ fitRequest: null }),

  setSelected: (id) => set({ selectedId: id }),

  setPercentBase: (base) =>
    set({
      percentBase: base,
      progressNonce: ++progressNonceCounter,
      localProgress: null,
    }),

  setStale: (stale) => set({ stale }),

  setContextMenu: (menu) => set({ contextMenu: menu }),

  setRenaming: (id) => set({ renamingId: id }),

  clearRenaming: () => set({ renamingId: null }),

  setCreateDialog: (dialog) => set({ createDialog: dialog }),

  clearCreateDialog: () => set({ createDialog: null }),

  renameNodeLocal: (oldId, newName, newPath) =>
    set((state) => {
      const oldNode = state.nodes.get(oldId);
      if (!oldNode) return {};
      const nodes = new Map(state.nodes);
      const affected = new Map<string, string>();
      const stack = [oldId];
      const oldIds: string[] = [];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const node = nodes.get(current);
        if (!node) continue;
        oldIds.push(current);
        for (let i = node.childrenIds.length - 1; i >= 0; i -= 1) {
          stack.push(node.childrenIds[i]);
        }
      }
      for (const id of oldIds) {
        affected.set(id, newPath + id.slice(oldId.length));
      }
      for (const [old, next] of affected) {
        const node = nodes.get(old)!;
        const newParentId = node.parentId
          ? (affected.get(node.parentId) ?? node.parentId)
          : null;
        nodes.set(next, {
          ...node,
          id: next,
          parentId: newParentId,
          name: node.id === oldId ? newName : node.name,
          path: node.id === oldId ? newPath : newPath + node.path.slice(oldId.length),
          childrenIds: node.childrenIds.map(
            (childId) => affected.get(childId) ?? childId
          ),
        });
      }
      for (const old of affected.keys()) {
        nodes.delete(old);
      }
      if (oldNode.parentId) {
        const parent = nodes.get(oldNode.parentId);
        if (parent) {
          nodes.set(parent.id, {
            ...parent,
            childrenIds: parent.childrenIds.map(
              (childId) => affected.get(childId) ?? childId
            ),
          });
        }
      }
      const remap = (id: string | null) =>
        id ? (affected.get(id) ?? id) : null;
      const expandedIds = new Set<string>();
      for (const id of state.expandedIds) {
        const next = remap(id);
        if (next) expandedIds.add(next);
      }
      const rootChanged = state.rootId === oldId;
      return {
        nodes,
        rootId: rootChanged ? (affected.get(oldId) ?? state.rootId) : state.rootId,
        rootPath: rootChanged ? newPath : state.rootPath,
        expandedIds,
        selectedId: remap(state.selectedId),
        renamingId: null,
        stale: true,
      };
    }),

  removeSubtree: (id) =>
    set((state) => {
      const nodes = new Map(state.nodes);
      const removed = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const node = nodes.get(current);
        if (!node) continue;
        removed.add(current);
        for (const childId of node.childrenIds) {
          stack.push(childId);
        }
      }
      const removedTotal = nodes.get(id)?.totalSize ?? 0;
      for (const removedId of removed) {
        nodes.delete(removedId);
      }
      const parentId = state.nodes.get(id)?.parentId ?? null;
      if (parentId) {
        const parent = nodes.get(parentId);
        if (parent) {
          nodes.set(parentId, {
            ...parent,
            childrenIds: parent.childrenIds.filter((childId) => childId !== id),
          });
        }
      }
      let cursor = parentId;
      while (cursor) {
        const node = nodes.get(cursor);
        if (!node) break;
        nodes.set(cursor, {
          ...node,
          totalSize: Math.max(0, node.totalSize - removedTotal),
        });
        cursor = node.parentId;
      }
      const expandedIds = new Set(state.expandedIds);
      for (const removedId of removed) {
        expandedIds.delete(removedId);
      }
      return {
        nodes,
        expandedIds,
        selectedId:
          state.selectedId && removed.has(state.selectedId) ? null : state.selectedId,
        renamingId: null,
        stale: true,
      };
    }),

  updateSettings: (partial) =>
    set((state) => {
      const next = { ...state, ...partial };
      try {
        localStorage.setItem(
          "file-visualizer-settings",
          JSON.stringify({
            defaultDepth: next.defaultDepth,
            sortMode: next.sortMode,
            motion: next.motion,
            excludeRules: next.excludeRules,
            shellMenuEnabled: next.shellMenuEnabled,
          })
        );
      } catch {
        // settings persistence is optional
      }
      return partial;
    }),

  bumpProgress: () => set({ progressNonce: ++progressNonceCounter }),
}));
