// Responsibility: Skeleton —— loading placeholder (shimmer animation).
export function Skeleton({ height, width, style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: height ?? 120, width: width ?? '100%', ...style }} />;
}
