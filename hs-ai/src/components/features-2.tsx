import { cn } from "@/lib/utils";

const FEATURES = [
  {
    title: "Single-step execution",
    description:
      "Only one next action is visible so focus stays narrow and calm.",
  },
  {
    title: "Stuck recovery",
    description:
      "Answer one blocker question and get a simpler recovery action instantly.",
  },
  {
    title: "Soft focus timer",
    description:
      "Track elapsed focus time without countdown pressure or urgency noise.",
  },
  {
    title: "Session resume",
    description:
      "Reload and continue the same active step with saved progress and timestamps.",
  },
  {
    title: "Secure defaults",
    description:
      "Route protection, server-side auth checks, and validated inputs across APIs.",
  },
  {
    title: "Clerk + Convex sync",
    description:
      "Per-user session persistence in local storage and Convex-backed state sync.",
  },
];

function FeatureGridRow({
  features,
  rowIndex,
}: {
  features: typeof FEATURES;
  rowIndex: number;
}) {
  return (
    <div
      className={cn(
        "grid md:grid-cols-3",
        rowIndex > 0 ? "border-t border-border" : "",
      )}
    >
      {features.map((feature, index) => (
        <article
          key={feature.title}
          className={cn(
            "flex flex-col p-6 sm:p-7",
            index > 0 ? "border-t border-border md:border-l md:border-t-0" : "",
          )}
        >
          <h3 className="text-lg font-medium text-foreground">{feature.title}</h3>
          <p className="mt-2 text-sm leading-7 text-muted-foreground md:min-h-[5.25rem]">
            {feature.description}
          </p>
        </article>
      ))}
    </div>
  );
}

export default function FeaturesSection() {
  const firstRow = FEATURES.slice(0, 3);
  const secondRow = FEATURES.slice(3, 6);

  return (
    <section
      id="features"
      className="mx-auto w-full max-w-5xl scroll-mt-20 px-6 py-14 sm:px-8 sm:py-20"
    >
      <div id="how-it-works" className="mx-auto max-w-2xl scroll-mt-20 text-center">
        <h2 className="text-balance text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
          Built for daily focus recovery
        </h2>
        <p className="mt-4 text-pretty text-base text-muted-foreground sm:text-lg">
          A minimal flow for turning vague goals into immediate, executable steps.
        </p>
      </div>
      <div
        id="security"
        className="mt-10 scroll-mt-20 overflow-hidden rounded-2xl border border-border bg-card/70"
      >
        <FeatureGridRow features={firstRow} rowIndex={0} />
        <FeatureGridRow features={secondRow} rowIndex={1} />
      </div>
    </section>
  );
}
