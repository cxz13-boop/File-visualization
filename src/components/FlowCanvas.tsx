import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type Viewport,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import FileNode, { type FileNodeData } from "./FileNode";
import SmoothEdge from "./SmoothEdge";
import {
  computeTreeLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  type NodePosition,
} from "../layout";
import { useScanStore } from "../store";
import type { MotionMode, PercentBase, ScanNode } from "../types";

const nodeTypes = { fileNode: FileNode };
const edgeTypes = { smoothstep: SmoothEdge };
const CULL_THRESHOLD = 12_000;
const VIEWPORT_MARGIN = 360;

function nodeVisible(
  position: NodePosition,
  viewport: Viewport | null,
  size: { width: number; height: number }
): boolean {
  if (!viewport || viewport.zoom <= 0 || size.width <= 0 || size.height <= 0) {
    return true;
  }
  const zoom = viewport.zoom;
  const x = position.x * zoom + viewport.x;
  const y = position.y * zoom + viewport.y;
  const width = NODE_WIDTH * zoom;
  const height = NODE_HEIGHT * zoom;
  return (
    x < size.width + VIEWPORT_MARGIN &&
    x + width > -VIEWPORT_MARGIN &&
    y < size.height + VIEWPORT_MARGIN &&
    y + height > -VIEWPORT_MARGIN
  );
}

function edgeStrokeWidth(parent: ScanNode, child: ScanNode): number {
  if (parent.totalSize === 0) return 1;
  const ratio = child.totalSize / parent.totalSize;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function percentText(
  node: ScanNode,
  nodes: Map<string, ScanNode>,
  rootId: string | null,
  base: PercentBase
): string {
  if (node.depth === 0) return "100%";
  let basis = 0;
  if (base === "parent" && node.parentId) {
    basis = nodes.get(node.parentId)?.totalSize ?? 0;
  } else if (rootId) {
    basis = nodes.get(rootId)?.totalSize ?? 0;
  }
  const value = basis > 0 ? (node.totalSize / basis) * 100 : 0;
  return `${value.toFixed(1)}%`;
}

function progressRatio(
  node: ScanNode,
  nodes: Map<string, ScanNode>,
  rootId: string | null,
  base: PercentBase
): number {
  if (node.depth === 0) return 1;
  let basis = 0;
  if (base === "parent" && node.parentId) {
    basis = nodes.get(node.parentId)?.totalSize ?? 0;
  } else if (rootId) {
    basis = nodes.get(rootId)?.totalSize ?? 0;
  }
  return basis > 0 ? node.totalSize / basis : 0;
}

function motionDuration(motion: MotionMode, standard: number): number {
  if (motion === "off") return 0;
  if (motion === "reduced") return Math.round(standard / 2.5);
  return standard;
}

export default function FlowCanvas() {
  const nodes = useScanStore((state) => state.nodes);
  const rootId = useScanStore((state) => state.rootId);
  const scanning = useScanStore((state) => state.scanning);
  const expandedIds = useScanStore((state) => state.expandedIds);
  const selectedId = useScanStore((state) => state.selectedId);
  const focusRequest = useScanStore((state) => state.focusRequest);
  const percentBase = useScanStore((state) => state.percentBase);
  const sortMode = useScanStore((state) => state.sortMode);
  const motion = useScanStore((state) => state.motion);
  const progressNonce = useScanStore((state) => state.progressNonce);
  const localProgress = useScanStore((state) => state.localProgress);
  const fitRequest = useScanStore((state) => state.fitRequest);
  const setSelected = useScanStore((state) => state.setSelected);
  const { fitView, setCenter, getNode, getViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(() => ({
    x: 0,
    y: 0,
    zoom: 1,
  }));
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setViewportSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(element);
    setViewport(getViewport());
    return () => observer.disconnect();
  }, [getViewport]);

  const layoutPositions = useMemo(() => {
    if (!rootId) return new Map<string, NodePosition>();
    return computeTreeLayout(nodes, rootId, expandedIds, sortMode);
  }, [nodes, rootId, expandedIds, sortMode]);

  const cull = layoutPositions.size > CULL_THRESHOLD;
  const visibleNodes = useMemo(() => {
    const result: Array<{ id: string; position: NodePosition }> = [];
    for (const [id, position] of layoutPositions) {
      if (cull && !nodeVisible(position, viewport, viewportSize)) continue;
      result.push({ id, position });
    }
    return result;
  }, [
    layoutPositions,
    cull,
    cull ? viewport : null,
    cull ? viewportSize : null,
  ]);

  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of visibleNodes) ids.add(item.id);
    return ids;
  }, [visibleNodes]);

  const flowNodes = useMemo(() => {
    const result: Array<Node<FileNodeData, "fileNode">> = [];
    for (const item of visibleNodes) {
      const node = nodes.get(item.id);
      if (!node) continue;
      let progressKey = progressNonce;
      if (localProgress && localProgress.nodeIds.includes(node.id)) {
        progressKey = localProgress.nonce;
      }
      result.push({
        id: node.id,
        type: "fileNode",
        position: item.position,
        data: {
          node,
          percentText: percentText(node, nodes, rootId, percentBase),
          ratio: progressRatio(node, nodes, rootId, percentBase),
          progressKey,
        },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        selected: node.id === selectedId,
      });
    }
    return result;
  }, [
    visibleNodes,
    nodes,
    selectedId,
    percentBase,
    progressNonce,
    localProgress,
  ]);

  const flowEdges = useMemo(() => {
    const edges: Edge[] = [];
    for (const item of visibleNodes) {
      const node = nodes.get(item.id);
      if (!node) continue;
      for (const childId of node.childrenIds) {
        const child = nodes.get(childId);
        if (!child || !visibleNodeIds.has(childId)) continue;
        edges.push({
          id: `${node.id}->${childId}`,
          source: node.id,
          target: childId,
          type: "smoothstep",
          style: {
            stroke: "#8ba0b3",
            strokeWidth: edgeStrokeWidth(node, child),
          },
        });
      }
    }
    return edges;
  }, [visibleNodes, visibleNodeIds, nodes]);

  useEffect(() => {
    if (rootId && !scanning) {
      const timer = window.setTimeout(() => {
        void fitView({
          padding: 0.16,
          duration: motionDuration(motion, 400),
        });
      }, 80);
      return () => window.clearTimeout(timer);
    }
  }, [rootId, scanning, fitView, motion]);

  useEffect(() => {
    if (!focusRequest) return;
    const rfNode = getNode(focusRequest.id);
    if (!rfNode) return;
    const width = rfNode.measured?.width ?? NODE_WIDTH;
    const height = rfNode.measured?.height ?? NODE_HEIGHT;
    void setCenter(rfNode.position.x + width / 2, rfNode.position.y + height / 2, {
      zoom: 0.8,
      duration: motionDuration(motion, 400),
    });
  }, [focusRequest, getNode, setCenter, motion]);

  useEffect(() => {
    if (!fitRequest) return;
    void fitView({
      padding: 0.16,
      duration: motionDuration(motion, 400),
    });
    useScanStore.getState().clearFitRequest();
  }, [fitRequest, fitView, motion]);

  return (
    <div className="flow-canvas-root" ref={containerRef}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        style={
          {
            "--layout-duration": `${motionDuration(motion, 260)}ms`,
          } as CSSProperties
        }
        minZoom={0.05}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        onlyRenderVisibleElements
        onMove={(_, next) => setViewport(next)}
        onNodeClick={(_, node) => setSelected(node.id)}
        onNodeDoubleClick={(_, node) => {
          const data = node.data as FileNodeData;
          void invoke("open_node", { path: data.node.path }).catch((error) =>
            useScanStore.getState().setError(String(error))
          );
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          useScanStore
            .getState()
            .setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
        }}
        onPaneClick={() => useScanStore.getState().setContextMenu(null)}
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.5}
          color="#c4cdd7"
        />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const data = node.data as FileNodeData | undefined;
            return data?.node?.kind === "dir" ? "#d97706" : "#2563eb";
          }}
        />
      </ReactFlow>
    </div>
  );
}
