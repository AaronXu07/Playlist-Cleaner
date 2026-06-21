interface LoadingSkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

export function LoadingSkeleton({
  width,
  height,
  borderRadius,
  className = "",
}: LoadingSkeletonProps) {
  const style: React.CSSProperties = {
    width: width !== undefined ? width : undefined,
    height: height !== undefined ? height : undefined,
    borderRadius:
      borderRadius !== undefined ? borderRadius : "var(--radius-card)",
  };

  return (
    <div
      className={`animate-pulse bg-bg-surface-hover ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}
