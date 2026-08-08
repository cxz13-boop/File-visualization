import { memo, useRef, type CSSProperties } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  File,
  Folder,
  FolderRoot,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { formatBytes, formatCount, formatTime } from "../format";
import { useScanStore } from "../store";
import type { ScanNode } from "../types";

export type FileNodeData = {
  node: ScanNode;
  percentText: string;
  ratio: number;
  progressKey: number;
};
export type FileNodeType = Node<FileNodeData, "fileNode">;

function FileNodeCard({ data, selected }: NodeProps<FileNodeType>) {
  const { node, percentText } = data;
  const isDir = node.kind === "dir";
  const isRoot = node.depth === 0;
  const failed = node.status === "error";
  const Icon = isDir ? Folder : File;
  const nodes = useScanStore((state) => state.nodes);
  const expanded = useScanStore((state) => state.expandedIds.has(node.id));
  const requestExpand = useScanStore((state) => state.requestExpand);
  const setExpanded = useScanStore((state) => state.setExpanded);
  const renaming = useScanStore((state) => state.renamingId === node.id);
  const setRenaming = useScanStore((state) => state.setRenaming);
  const renameNodeLocal = useScanStore((state) => state.renameNodeLocal);
  const setCreateDialog = useScanStore((state) => state.setCreateDialog);
  const motion = useScanStore((state) => state.motion);
  const loadedChildCount = node.childrenIds.filter((id) => nodes.has(id)).length;
  const renameCancelled = useRef(false);
  const renameHandled = useRef(false);

  const handleToggle = () => {
    if (expanded) {
      setExpanded(node.id, false);
    } else if (loadedChildCount === 0 && node.childrenIds.length > 0) {
      requestExpand(node.id);
    } else {
      setExpanded(node.id, true);
    }
  };

  const progressDuration =
    motion === "off" ? 0 : motion === "reduced" ? 220 : 550;
  const ratioClass =
    data.ratio > 0.75
      ? "ratio-high"
      : data.ratio > 0.5
        ? "ratio-mid"
        : "ratio-low";

  const commitRename = async (value: string) => {
    if (renameHandled.current) return;
    renameHandled.current = true;
    const name = value.trim();
    try {
      if (!name || name === node.name) return;
      const newPath = await invoke<string>("rename_node", {
        path: node.path,
        newName: name,
      });
      renameNodeLocal(node.id, name, newPath);
      useScanStore.getState().setStale(true);
      void invoke("invalidate_scan");
    } catch (error) {
      useScanStore.getState().setError(String(error));
    } finally {
      setRenaming(null);
      renameHandled.current = false;
    }
  };

  return (
    <div
      className={`file-node-card ${isDir ? "node-dir" : "node-file"} ${
        selected ? "selected" : ""
      } ${failed ? "node-error" : ""}`}
      data-node-id={node.id}
      data-depth={node.depth}
      data-kind={node.kind}
    >
      <div
        key={data.progressKey}
        className={`card-progress-fill ${ratioClass}`}
        style={
          {
            "--target": `${Math.min(100, data.ratio * 100)}%`,
            "--duration": `${progressDuration}ms`,
          } as CSSProperties
        }
      />
      <Handle type="target" position={Position.Left} />
      <div className="card-top">
        <span className={`node-icon ${isDir ? "dir" : "file"}`}>
          {isRoot ? <FolderRoot size={18} /> : <Icon size={18} />}
        </span>
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={node.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void commitRename((event.target as HTMLInputElement).value);
              } else if (event.key === "Escape") {
                renameCancelled.current = true;
                setRenaming(null);
              }
            }}
            onBlur={(event) => {
              if (!renameCancelled.current) void commitRename(event.target.value);
              renameCancelled.current = false;
            }}
          />
        ) : (
          <span className="node-name" title={node.name}>
            {node.name}
          </span>
        )}
        {isRoot && <span className="root-badge">根目录</span>}
        {failed && (
          <span className="error-icon" title={node.path}>
            <TriangleAlert size={14} />
          </span>
        )}
        {isDir && (
          <button
            className="create-btn"
            onClick={(event) => {
              event.stopPropagation();
              setCreateDialog({
                parentId: node.id,
                step: "type",
                kind: "file",
                extension: null,
              });
            }}
            title="新建"
          >
            <Plus size={14} />
          </button>
        )}
        {isDir && node.childrenIds.length > 0 && (
          <button
            className={`expand-btn ${expanded ? "expanded" : "collapsed"}`}
            onClick={(event) => {
              event.stopPropagation();
              handleToggle();
            }}
            title={expanded ? "收起" : "展开"}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>
      <div className="card-bottom">
        <span className="card-size">{formatBytes(node.totalSize)}</span>
        <span className="card-meta">
          {isDir
            ? `${formatCount(node.childrenIds.length)} 个子项 · ${percentText}`
            : `${percentText} · ${formatTime(node.modifiedAt)}`}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const FileNode = memo(FileNodeCard, (previous, next) => {
  return (
    previous.data.node === next.data.node &&
    previous.data.percentText === next.data.percentText &&
    previous.data.ratio === next.data.ratio &&
    previous.data.progressKey === next.data.progressKey &&
    previous.selected === next.selected
  );
});

export default FileNode;
