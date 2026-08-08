export type PercentBase = "root" | "parent";
export type SortMode = "size" | "name";
export type MotionMode = "standard" | "reduced" | "off";

export type NodeKind = "dir" | "file";
export type NodeStatus = "loaded" | "loading" | "error";

export interface ScanNode {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
  totalSize: number;
  childrenIds: string[];
  depth: number;
  status: NodeStatus;
  modifiedAt: number | null;
}

export interface ScanStarted {
  path: string;
  rootId: string;
  generation: number;
}

export interface NodesBatch {
  nodes: ScanNode[];
  batchIndex: number;
}

export interface ScanProgress {
  scanned: number;
  currentPath: string;
}

export interface TotalsBatch {
  items: Array<{ id: string; totalSize: number }>;
}

export interface ScanComplete {
  rootId: string;
  totalSize: number;
  nodeCount: number;
  durationMs: number;
}

export interface ScanError {
  path: string;
  message: string;
}

export interface CreateResult {
  node: ScanNode;
  parent: ScanNode;
}

export interface SearchHit {
  node: ScanNode;
  ancestorIds: string[];
}
