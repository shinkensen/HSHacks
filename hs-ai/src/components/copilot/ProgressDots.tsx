export function ProgressDots({
  total,
  current,
}: {
  total: number;
  current: number;
}) {
  return (
    <div className="flex items-center gap-2" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, index) => {
        const isComplete = index < current;
        const isActive = index === current;

        return (
          <span
            key={`progress-dot-${index}`}
            className={[
              "size-2 rounded-full transition-colors",
              isComplete ? "bg-primary/70" : "bg-muted",
              isActive ? "bg-primary" : "",
            ].join(" ")}
          />
        );
      })}
      <p className="ml-2 text-xs text-muted-foreground">step {current + 1} of ~{total}</p>
    </div>
  );
}
