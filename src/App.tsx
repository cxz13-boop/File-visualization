import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive,
  Copy,
  ExternalLink,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FoldHorizontal,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  FolderSearch,
  FolderTree,
  FoldVertical,
  Gauge,
  ListTree,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  UnfoldVertical,
  X,
} from "lucide-react";
import FlowCanvas from "./components/FlowCanvas";
import { NEW_FILE_TYPES } from "./fileTypes";
import { formatBytes, formatCount, formatDuration } from "./format";
import { getVisibleNodeIds } from "./layout";
import { useScanStore } from "./store";
import type {
  NodesBatch,
  ScanComplete,
  ScanError,
  ScanNode,
  ScanProgress,
  ScanStarted,
  CreateResult,
  SearchHit,
  TotalsBatch,
} from "./types";

const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".tar.gz",
  ".bz2",
  ".xz",
]);

const NEW_TYPE_GROUPS = [
  {
    label: "文件夹",
    items: NEW_FILE_TYPES.filter((type) => type.kind === "dir"),
  },
  {
    label: "文档",
    items: NEW_FILE_TYPES.filter(
      (type) =>
        type.kind === "file" && !ARCHIVE_EXTENSIONS.has(type.extension ?? "")
    ),
  },
  {
    label: "压缩包",
    items: NEW_FILE_TYPES.filter(
      (type) =>
        type.kind === "file" && ARCHIVE_EXTENSIONS.has(type.extension ?? "")
    ),
  },
];

function parseExcludes(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function App() {
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const searchNonce = useRef(0);
  const [createName, setCreateName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [excludeText, setExcludeText] = useState("");
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [shellMessage, setShellMessage] = useState<string | null>(null);
  const startScan = useCallback(async (path: string, refresh = false) => {
    try {
      const settings = useScanStore.getState();
      await invoke("scan_path", {
        path,
        refresh,
        defaultDepth: settings.defaultDepth,
        excludes: settings.excludeRules,
      });
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);
  const startScanRef = useRef(startScan);
  startScanRef.current = startScan;

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    const setup = async () => {
      unlisteners.push(
        await listen<ScanStarted>("scan://started", (event) => {
          useScanStore.getState().setStarted(event.payload);
        })
      );
      unlisteners.push(
        await listen<NodesBatch>("scan://nodes", (event) => {
          useScanStore.getState().addNodes(event.payload.nodes);
        })
      );
      unlisteners.push(
        await listen<ScanProgress>("scan://progress", (event) => {
          useScanStore.getState().setProgress(event.payload);
        })
      );
      unlisteners.push(
        await listen<TotalsBatch>("scan://totals", (event) => {
          useScanStore.getState().applyTotals(event.payload.items);
        })
      );
      unlisteners.push(
        await listen<ScanComplete>("scan://complete", (event) => {
          useScanStore.getState().setComplete(event.payload);
        })
      );
      unlisteners.push(
        await listen<ScanError>("scan://error", (event) => {
          useScanStore.getState().setError(event.payload.message);
        })
      );
      unlisteners.push(
        await listen<{ message: string }>("system://notice", (event) => {
          useScanStore.getState().setError(event.payload.message);
        })
      );
      unlisteners.push(
        await listen<string>("launch://path", (event) => {
          if (event.payload) void startScanRef.current(event.payload);
        })
      );

      try {
        const notice = await invoke<string | null>("startup_notice");
        if (notice) useScanStore.getState().setError(notice);
      } catch {
        // startup notice is optional
      }
      try {
        const launchPath = await invoke<string | null>("take_launch_path");
        if (launchPath) void startScanRef.current(launchPath);
      } catch {
        // launch path is optional
      }

      if (cancelled) return;
      const unlistenDrop = await getCurrentWindow().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragOver(true);
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          setDragOver(false);
          const target = payload.paths[0];
          if (target) void startScanRef.current(target);
        }
      });
      unlisteners.push(unlistenDrop);
    };

    void setup();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  const expandRequest = useScanStore((state) => state.expandRequest);
  useEffect(() => {
    if (!expandRequest) return;
    let cancelled = false;
    (async () => {
      try {
        const existingIds = new Set(useScanStore.getState().nodes.keys());
        const children = await invoke<ScanNode[]>("expand_nodes", {
          nodeIds: [expandRequest.id],
        });
        if (cancelled) return;
        const newNodes = children.filter((child) => !existingIds.has(child.id));
        const store = useScanStore.getState();
        store.addNodes(children);
        store.setExpanded(
          expandRequest.id,
          true,
          newNodes.length > 0 ? newNodes.map((child) => child.id) : undefined
        );
        store.clearExpandRequest();
      } catch (error) {
        if (cancelled) return;
        useScanStore.getState().setError(String(error));
        useScanStore.getState().clearExpandRequest();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandRequest?.nonce]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !useScanStore.getState().rootId) {
      searchNonce.current += 1;
      setSearchResults([]);
      return;
    }
    const nonce = ++searchNonce.current;
    const timer = window.setTimeout(() => {
      void invoke<SearchHit[]>("search_nodes", { query, limit: 50 })
        .then((hits) => {
          if (nonce === searchNonce.current) setSearchResults(hits);
        })
        .catch((error) => {
          if (nonce === searchNonce.current) {
            useScanStore.getState().setError(String(error));
          }
        });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const pickFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") void startScan(selected);
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, [startScan]);

  const clearAll = useCallback(() => {
    useScanStore.getState().clear();
  }, []);

  const loadSampleData = useCallback(async () => {
    try {
      await invoke("generate_stress_scan", {
        defaultDepth: useScanStore.getState().defaultDepth,
      });
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const collapseAll = useCallback(() => {
    useScanStore.getState().collapseAll();
  }, []);

  const expandOneLevel = useCallback(async () => {
    const store = useScanStore.getState();
    const rootId = store.rootId;
    if (!rootId) return;
    const visible = getVisibleNodeIds(
      store.nodes,
      rootId,
      store.expandedIds,
      store.sortMode
    );
    const dirIds = visible.filter((id) => store.nodes.get(id)?.kind === "dir");
    if (dirIds.length === 0) return;
    try {
      const existingIds = new Set(store.nodes.keys());
      const children = await invoke<ScanNode[]>("expand_nodes", {
        nodeIds: dirIds,
      });
      const newNodes = children.filter((child) => !existingIds.has(child.id));
      const latest = useScanStore.getState();
      latest.addNodes(children);
      latest.setExpandedMany(dirIds, true, newNodes.map((child) => child.id));
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const collapseOneLevel = useCallback(() => {
    const store = useScanStore.getState();
    const rootId = store.rootId;
    if (!rootId) return;
    const visible = getVisibleNodeIds(
      store.nodes,
      rootId,
      store.expandedIds,
      store.sortMode
    );
    const visibleSet = new Set(visible);
    const toCollapse = new Set<string>();
    for (const id of store.expandedIds) {
      const node = store.nodes.get(id);
      if (!node || node.kind !== "dir" || !visibleSet.has(id)) continue;
      const hasExpandedChild = node.childrenIds.some(
        (childId) =>
          store.nodes.has(childId) && store.expandedIds.has(childId)
      );
      if (!hasExpandedChild) toCollapse.add(id);
    }
    if (toCollapse.size > 0) {
      store.setExpandedMany(Array.from(toCollapse), false);
    }
  }, []);

  const resetDefaultDepth = useCallback(async () => {
    const rootId = useScanStore.getState().rootId;
    if (!rootId) return;
    useScanStore.getState().collapseAll();
    let guard = 0;
    while (guard < 12) {
      guard += 1;
      const current = useScanStore.getState();
      const target = current.defaultDepth;
      const visibleDirs = getVisibleNodeIds(
        current.nodes,
        rootId,
        current.expandedIds,
        current.sortMode
      ).filter((id) => {
        const node = current.nodes.get(id);
        return node?.kind === "dir" && node.depth < target;
      });
      const toLoad = visibleDirs.filter((id) => {
        const node = current.nodes.get(id);
        return node?.childrenIds.some((childId) => !current.nodes.has(childId));
      });
      const toExpand = visibleDirs.filter((id) => !current.expandedIds.has(id));
      if (toLoad.length === 0 && toExpand.length === 0) break;
      const nodeIds = toLoad.length > 0 ? toLoad : toExpand;
      try {
        const children = await invoke<ScanNode[]>("expand_nodes", {
          nodeIds,
        });
        const latest = useScanStore.getState();
        latest.addNodes(children);
        latest.setExpandedMany(nodeIds, true, []);
      } catch (error) {
        useScanStore.getState().setError(String(error));
        break;
      }
    }
    const latest = useScanStore.getState();
    const target = latest.defaultDepth;
    const expandedIds = new Set<string>();
    for (const node of latest.nodes.values()) {
      if (node.kind === "dir" && node.depth < target) {
        expandedIds.add(node.id);
      }
    }
    latest.setExpandedSet(expandedIds, []);
    latest.requestFit();
  }, []);

  const handleDelete = useCallback(async (node: ScanNode) => {
    const ok = await confirm(`确定删除“${node.name}”吗？将移入回收站。`, {
      title: "删除确认",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await invoke("delete_node", { path: node.path });
      const store = useScanStore.getState();
      store.removeSubtree(node.id);
      store.setStale(true);
      void invoke("invalidate_scan");
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const handleMove = useCallback(async (node: ScanNode) => {
    const target = await open({ directory: true, multiple: false });
    if (typeof target !== "string") return;
    try {
      await invoke("move_node", { path: node.path, targetDir: target });
      const store = useScanStore.getState();
      store.removeSubtree(node.id);
      store.setStale(true);
      void invoke("invalidate_scan");
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const handleCopy = useCallback(async (node: ScanNode) => {
    const target = await open({ directory: true, multiple: false });
    if (typeof target !== "string") return;
    try {
      await invoke("copy_node", { path: node.path, targetDir: target });
      useScanStore.getState().setStale(true);
      void invoke("invalidate_scan");
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const handleCreate = useCallback(async () => {
    const dialog = useScanStore.getState().createDialog;
    if (!dialog || dialog.step !== "name") return;
    const base = createName.trim() || (dialog.kind === "dir" ? "新建文件夹" : "新建文件");
    const name =
      dialog.kind === "dir" ? base : base + (dialog.extension ?? "");
    try {
      const result = await invoke<CreateResult>("create_node", {
        parentDir: dialog.parentId,
        kind: dialog.kind,
        name,
      });
      const store = useScanStore.getState();
      store.addNodes([result.parent, result.node]);
      store.setExpanded(dialog.parentId, true);
      store.setSelected(result.node.id);
      store.requestFocus(result.node.id);
      store.clearCreateDialog();
      setCreateName("");
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, [createName]);

  const handleClearCache = useCallback(async () => {
    try {
      await invoke("clear_cache");
      setCacheMessage("缓存已清理");
      window.setTimeout(() => setCacheMessage(null), 2500);
    } catch (error) {
      useScanStore.getState().setError(String(error));
    }
  }, []);

  const handleShellToggle = useCallback(
    async (enabled: boolean) => {
      useScanStore.getState().updateSettings({ shellMenuEnabled: enabled });
      try {
        if (enabled) {
          await invoke("register_shell");
        } else {
          await invoke("unregister_shell");
        }
        setShellMessage(enabled ? "右键菜单已启用" : "右键菜单已禁用");
        window.setTimeout(() => setShellMessage(null), 2500);
      } catch (error) {
        useScanStore.getState().setError(String(error));
      }
    },
    []
  );

  useEffect(() => {
    const enabled = useScanStore.getState().shellMenuEnabled;
    void (enabled
      ? invoke("register_shell")
      : invoke("unregister_shell")
    ).catch(() => {
      // shell menu registration is optional
    });
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const store = useScanStore.getState();
      const selectedId = store.selectedId;
      if (!selectedId) return;
      const node = store.nodes.get(selectedId);
      if (!node) return;
      if (event.key === "Enter") {
        void invoke("open_node", { path: node.path }).catch((error) =>
          useScanStore.getState().setError(String(error))
        );
      } else if (event.key === "F2") {
        store.setRenaming(selectedId);
      } else if (event.key === "Delete") {
        void handleDelete(node);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleDelete]);

  const nodes = useScanStore((state) => state.nodes);
  const rootId = useScanStore((state) => state.rootId);
  const scanning = useScanStore((state) => state.scanning);
  const scanError = useScanStore((state) => state.scanError);
  const rootPath = useScanStore((state) => state.rootPath);
  const nodeCount = useScanStore((state) => state.nodeCount);
  const totalSize = useScanStore((state) => state.totalSize);
  const durationMs = useScanStore((state) => state.durationMs);
  const progress = useScanStore((state) => state.progress);
  const percentBase = useScanStore((state) => state.percentBase);
  const setPercentBase = useScanStore((state) => state.setPercentBase);
  const stale = useScanStore((state) => state.stale);
  const contextMenu = useScanStore((state) => state.contextMenu);
  const setContextMenu = useScanStore((state) => state.setContextMenu);
  const setRenaming = useScanStore((state) => state.setRenaming);
  const createDialog = useScanStore((state) => state.createDialog);
  const setCreateDialog = useScanStore((state) => state.setCreateDialog);
  const clearCreateDialog = useScanStore((state) => state.clearCreateDialog);
  const defaultDepth = useScanStore((state) => state.defaultDepth);
  const sortMode = useScanStore((state) => state.sortMode);
  const motion = useScanStore((state) => state.motion);
  const excludeRules = useScanStore((state) => state.excludeRules);
  const shellMenuEnabled = useScanStore((state) => state.shellMenuEnabled);
  const updateSettings = useScanStore((state) => state.updateSettings);

  const contextNode = contextMenu ? nodes.get(contextMenu.nodeId) ?? null : null;

  const selectSearchResult = useCallback(
    async (hit: SearchHit) => {
      const store = useScanStore.getState();
      const rootId = store.rootId;
      if (!rootId) return;
      const targetId = hit.node.id;
      const toExpand: string[] = [];
      let previousId = rootId;
      try {
        for (const ancestorId of hit.ancestorIds) {
          const current = useScanStore.getState();
          if (!current.nodes.has(ancestorId)) {
            const children = await invoke<ScanNode[]>("expand_nodes", {
              nodeIds: [previousId],
            });
            useScanStore.getState().addNodes(children);
          }
          toExpand.push(ancestorId);
          previousId = ancestorId;
        }
        const beforeFinal = useScanStore.getState();
        if (targetId !== rootId && !beforeFinal.nodes.has(targetId)) {
          const children = await invoke<ScanNode[]>("expand_nodes", {
            nodeIds: [previousId],
          });
          const latest = useScanStore.getState();
          latest.addNodes(children);
        }
        const latest = useScanStore.getState();
        if (!latest.nodes.has(targetId)) {
          latest.addNodes([hit.node]);
        }
        if (toExpand.length > 0) {
          latest.setExpandedMany(toExpand, true);
        }
        latest.setSelected(targetId);
        latest.requestFocus(targetId);
        setSearchQuery("");
        setSearchResults([]);
      } catch (error) {
        useScanStore.getState().setError(String(error));
      }
    },
    []
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <FolderTree size={19} />
          <span>文件结构可视化</span>
        </div>
        <div className="search-wrap">
          <Search size={15} className="search-icon" />
          <input
            className="search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && searchResults[0]) {
                void selectSearchResult(searchResults[0]);
              }
            }}
            placeholder="搜索节点"
          />
          {searchQuery && (
            <button
              className="search-clear"
              onClick={() => setSearchQuery("")}
              title="清空搜索"
            >
              <X size={14} />
            </button>
          )}
          {searchQuery && searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((hit) => (
                <button
                  key={hit.node.id}
                  className="search-result"
                  onClick={() => void selectSearchResult(hit)}
                >
                  <span className="result-name">{hit.node.name}</span>
                  <span className="result-path">{hit.node.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="actions">
          <div className="segmented" title="占比基准">
            <button
              className={percentBase === "root" ? "active" : ""}
              onClick={() => setPercentBase("root")}
            >
              根目录
            </button>
            <button
              className={percentBase === "parent" ? "active" : ""}
              onClick={() => setPercentBase("parent")}
            >
              父目录
            </button>
          </div>
          <button
            className="btn"
            onClick={collapseAll}
            disabled={!rootId}
            title="收起全部"
          >
            <FoldVertical size={16} />
            <span>收起全部</span>
          </button>
          <button
            className="btn"
            onClick={collapseOneLevel}
            disabled={!rootId}
            title="收起一层"
          >
            <FoldHorizontal size={16} />
            <span>收起一层</span>
          </button>
          <button
            className="btn"
            onClick={() => void expandOneLevel()}
            disabled={!rootId}
            title="展开一级"
          >
            <UnfoldVertical size={16} />
            <span>展开一级</span>
          </button>
          <button
            className="btn"
            onClick={() => void resetDefaultDepth()}
            disabled={!rootId}
            title="默认层级"
          >
            <ListTree size={16} />
            <span>默认层级</span>
          </button>
          <button
            className="btn"
            onClick={() => {
              if (rootPath) void startScan(rootPath, true);
            }}
            disabled={!rootId}
            title="重新扫描"
          >
            <RefreshCw size={16} />
            <span>刷新</span>
          </button>
          <button
            className="btn"
            onClick={() => void pickFolder()}
            title="选择文件夹"
          >
            <FolderOpen size={16} />
            <span>选择文件夹</span>
          </button>
          <button
            className="btn"
            onClick={() => {
              setExcludeText(excludeRules.join("\n"));
              setSettingsOpen(true);
            }}
            title="设置"
          >
            <Settings size={16} />
            <span>设置</span>
          </button>
          <button
            className="btn btn-quiet"
            onClick={clearAll}
            disabled={!rootId}
            title="清空"
          >
            <RotateCcw size={16} />
            <span>清空</span>
          </button>
        </div>
      </header>

      {scanning && (
        <div className="scan-status">
          <LoaderCircle className="spin" size={15} />
          <span>扫描中</span>
          <span className="scan-count">
            {formatCount(progress?.scanned ?? nodeCount)} 项
          </span>
          {progress?.currentPath && (
            <span className="scan-path" title={progress.currentPath}>
              {progress.currentPath}
            </span>
          )}
        </div>
      )}

      {scanError && <div className="error-banner">{scanError}</div>}

      {stale && (
        <div className="stale-banner">
          <span>目录已变更，部分节点可能已过期</span>
          <button
            onClick={() => {
              if (rootPath) void startScan(rootPath, true);
            }}
          >
            重新扫描
          </button>
        </div>
      )}

      <div className="canvas-wrap">
        <ReactFlowProvider>
          <FlowCanvas />
        </ReactFlowProvider>

        {!rootId && !scanning && (
          <div className="empty-state">
            <FolderPlus size={44} strokeWidth={1.5} />
            <div className="empty-title">拖入文件夹</div>
            <button
              className="btn primary empty-action"
              onClick={() => void loadSampleData()}
              title="载入示例文件结构"
            >
              <Gauge size={16} />
              <span>示例文件展示</span>
            </button>
          </div>
        )}

        {dragOver && (
          <div className="drop-overlay">
            <FolderPlus size={34} strokeWidth={1.6} />
            <span>释放以扫描</span>
          </div>
        )}
      </div>

      {contextMenu && contextNode && (
        <>
          <div
            className="context-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextNode.kind === "dir" && (
              <>
                <button
                  onClick={() => {
                    setCreateDialog({
                      parentId: contextNode.id,
                      step: "type",
                      kind: "file",
                      extension: null,
                    });
                    setContextMenu(null);
                  }}
                >
                  <FilePlus2 size={14} />
                  <span>新建文件</span>
                </button>
                <button
                  onClick={() => {
                    setCreateDialog({
                      parentId: contextNode.id,
                      step: "name",
                      kind: "dir",
                      extension: null,
                    });
                    setContextMenu(null);
                  }}
                >
                  <FolderPlus size={14} />
                  <span>新建文件夹</span>
                </button>
              </>
            )}
            <button
              onClick={() => {
                void invoke("open_node", { path: contextNode.path }).catch(
                  (error) => useScanStore.getState().setError(String(error))
                );
                setContextMenu(null);
              }}
            >
              <ExternalLink size={14} />
              <span>打开</span>
            </button>
            <button
              onClick={() => {
                void revealItemInDir(contextNode.path);
                setContextMenu(null);
              }}
            >
              <FolderSearch size={14} />
              <span>打开所在位置</span>
            </button>
            <button
              onClick={() => {
                setRenaming(contextNode.id);
                setContextMenu(null);
              }}
            >
              <Pencil size={14} />
              <span>重命名</span>
            </button>
            <button
              onClick={() => {
                void handleCopy(contextNode);
                setContextMenu(null);
              }}
            >
              <Copy size={14} />
              <span>复制到...</span>
            </button>
            <button
              onClick={() => {
                void handleMove(contextNode);
                setContextMenu(null);
              }}
            >
              <FolderInput size={14} />
              <span>移动到...</span>
            </button>
            <button
              className="danger"
              onClick={() => {
                void handleDelete(contextNode);
                setContextMenu(null);
              }}
            >
              <Trash2 size={14} />
              <span>删除</span>
            </button>
          </div>
        </>
      )}

      {createDialog && (
        <>
          <div className="modal-overlay" onClick={clearCreateDialog} />
          <div className="modal modal-create">
            {createDialog.step === "type" ? (
              <>
                <div className="modal-title">选择文件类型</div>
                <div className="type-groups">
                  {NEW_TYPE_GROUPS.map((group) => (
                    <div key={group.label} className="type-group">
                      <div className="type-group-label">{group.label}</div>
                      <div className="type-grid">
                        {group.items.map((type) => (
                          <button
                            key={type.id}
                            className="type-item"
                            onClick={() => {
                              setCreateDialog({
                                ...createDialog,
                                step: "name",
                                kind: type.kind,
                                extension: type.extension,
                              });
                              setCreateName("");
                            }}
                          >
                            {type.kind === "dir" ? (
                              <Folder size={17} />
                            ) : ARCHIVE_EXTENSIONS.has(type.extension ?? "") ? (
                              <Archive size={17} />
                            ) : [".xls", ".xlsx"].includes(
                                type.extension ?? ""
                              ) ? (
                              <FileSpreadsheet size={17} />
                            ) : (
                              <FileText size={17} />
                            )}
                            <span>{type.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="modal-title">
                  新建{createDialog.kind === "dir" ? "文件夹" : "文件"}
                </div>
                <div className="selected-type">
                  <button
                    className="type-back"
                    onClick={() =>
                      setCreateDialog({ ...createDialog, step: "type" })
                    }
                  >
                    返回类型
                  </button>
                  <span className="type-chip">
                    {createDialog.kind === "dir"
                      ? "文件夹"
                      : createDialog.extension}
                  </span>
                </div>
                <input
                  className="modal-input"
                  value={createName}
                  autoFocus
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreate();
                    else if (event.key === "Escape") clearCreateDialog();
                  }}
                  placeholder={
                    createDialog.kind === "dir" ? "新建文件夹" : "新建文件"
                  }
                />
                {createDialog.kind === "file" && (
                  <div className="name-preview">
                    {createName.trim() || "新建文件"}
                    {createDialog.extension}
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn" onClick={clearCreateDialog}>
                    取消
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void handleCreate()}
                  >
                    创建
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {settingsOpen && (
        <>
          <div className="modal-overlay" onClick={() => setSettingsOpen(false)} />
          <div className="modal modal-settings">
            <div className="modal-title">设置</div>
            <div className="setting-row">
              <span>默认展开深度</span>
              <div className="stepper">
                <button
                  onClick={() =>
                    updateSettings({
                      defaultDepth: Math.max(1, defaultDepth - 1),
                    })
                  }
                  disabled={defaultDepth <= 1}
                >
                  <Minus size={14} />
                </button>
                <span>{defaultDepth}</span>
                <button
                  onClick={() =>
                    updateSettings({
                      defaultDepth: Math.min(8, defaultDepth + 1),
                    })
                  }
                  disabled={defaultDepth >= 8}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            <div className="setting-row">
              <span>子节点排序</span>
              <div className="segmented">
                <button
                  className={sortMode === "size" ? "active" : ""}
                  onClick={() => updateSettings({ sortMode: "size" })}
                >
                  大小
                </button>
                <button
                  className={sortMode === "name" ? "active" : ""}
                  onClick={() => updateSettings({ sortMode: "name" })}
                >
                  名称
                </button>
              </div>
            </div>
            <div className="setting-row">
              <span>动效强度</span>
              <div className="segmented">
                <button
                  className={motion === "standard" ? "active" : ""}
                  onClick={() => updateSettings({ motion: "standard" })}
                >
                  标准
                </button>
                <button
                  className={motion === "reduced" ? "active" : ""}
                  onClick={() => updateSettings({ motion: "reduced" })}
                >
                  减弱
                </button>
                <button
                  className={motion === "off" ? "active" : ""}
                  onClick={() => updateSettings({ motion: "off" })}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="setting-row setting-excludes">
              <span>排除目录（每行一个名称）</span>
              <textarea
                value={excludeText}
                onChange={(event) => setExcludeText(event.target.value)}
                placeholder={"node_modules\n.git\ndist"}
              />
            </div>
            <div className="setting-row">
              <span>右键菜单</span>
              <div className="segmented">
                <button
                  className={shellMenuEnabled ? "active" : ""}
                  onClick={() => void handleShellToggle(true)}
                >
                  启用
                </button>
                <button
                  className={!shellMenuEnabled ? "active" : ""}
                  onClick={() => void handleShellToggle(false)}
                >
                  禁用
                </button>
              </div>
              {shellMessage && (
                <span className="cache-message">{shellMessage}</span>
              )}
            </div>
            <div className="setting-row">
              <span>扫描缓存</span>
              <div className="cache-actions">
                <button className="btn" onClick={() => void handleClearCache()}>
                  清理缓存
                </button>
                {cacheMessage && (
                  <span className="cache-message">{cacheMessage}</span>
                )}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="btn primary"
                onClick={() => {
                  updateSettings({ excludeRules: parseExcludes(excludeText) });
                  setSettingsOpen(false);
                }}
              >
                完成
              </button>
            </div>
          </div>
        </>
      )}

      {rootId && !scanning && (
        <footer className="statusbar">
          <span className="status-path" title={rootPath ?? ""}>
            {rootPath}
          </span>
          <span>{formatCount(nodeCount)} 个节点</span>
          <span>{formatBytes(totalSize)}</span>
          {durationMs !== null && <span>{formatDuration(durationMs)}</span>}
        </footer>
      )}
    </div>
  );
}

export default App;
