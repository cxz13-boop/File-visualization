import type { ScanNode, SortMode } from "./types";

export const NODE_WIDTH = 252;
export const NODE_HEIGHT = 78;
export const H_GAP = 64;
export const V_GAP = 18;

export interface NodePosition {
  x: number;
  y: number;
}

function sortChildren(
  node: ScanNode,
  nodes: Map<string, ScanNode>,
  sortMode: SortMode
): string[] {
  const children = node.childrenIds.slice();
  if (sortMode === "name") {
    children.sort((left, right) =>
      (nodes.get(left)?.name ?? "").localeCompare(nodes.get(right)?.name ?? "")
    );
  } else {
    children.sort(
      (left, right) =>
        (nodes.get(right)?.totalSize ?? 0) -
        (nodes.get(left)?.totalSize ?? 0)
    );
  }
  return children;
}

export function getVisibleNodeIds(
  nodes: Map<string, ScanNode>,
  rootId: string,
  expandedIds: Set<string>,
  sortMode: SortMode
): string[] {
  const visible: string[] = [];
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    visible.push(id);
    if (node.kind === "dir" && expandedIds.has(id)) {
      const children = sortChildren(node, nodes, sortMode);
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
  }
  return visible;
}

export function computeTreeLayout(
  nodes: Map<string, ScanNode>,
  rootId: string,
  expandedIds: Set<string>,
  sortMode: SortMode
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  const root = nodes.get(rootId);
  if (!root) return positions;

  const visibleOrder = getVisibleNodeIds(nodes, rootId, expandedIds, sortMode);
  const visibleSet = new Set(visibleOrder);

  let cursor = 0;
  const stack: Array<{ id: string; depth: number }> = [
    { id: rootId, depth: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = nodes.get(frame.id);
    if (!node) continue;
    const visibleChildren = sortChildren(node, nodes, sortMode).filter(
      (childId) => visibleSet.has(childId)
    );

    positions.set(frame.id, {
      x: frame.depth * (NODE_WIDTH + H_GAP),
      y: cursor * (NODE_HEIGHT + V_GAP),
    });
    if (visibleChildren.length === 0) {
      cursor += 1;
    } else {
      for (let i = visibleChildren.length - 1; i >= 0; i -= 1) {
        stack.push({
          id: visibleChildren[i],
          depth: frame.depth + 1,
        });
      }
    }
  }

  return positions;
}
