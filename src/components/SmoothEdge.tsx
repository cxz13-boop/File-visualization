import {
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { useScanStore } from "../store";

const edgePathCache = new Map<string, string>();

export default function SmoothEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  interactionWidth = 20,
}: EdgeProps) {
  const motion = useScanStore((state) => state.motion);
  const duration =
    motion === "off" ? 0 : motion === "reduced" ? 120 : 260;
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const previousPath = edgePathCache.get(id);
  edgePathCache.set(id, path);
  const animating = previousPath !== undefined && previousPath !== path && duration > 0;
  const fromPath = previousPath ?? path;

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={interactionWidth}
      />
      <path
        id={id}
        d={path}
        fill="none"
        className="react-flow__edge-path"
        style={style}
        markerEnd={markerEnd}
      >
        {animating && (
          <animate
            attributeName="d"
            from={fromPath}
            to={path}
            dur={`${duration}ms`}
            fill="freeze"
            calcMode="linear"
          />
        )}
      </path>
    </>
  );
}
