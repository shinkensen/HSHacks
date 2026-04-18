import Link from "next/link";
import Workout from "@/components/workout/workout";

export default function WorkoutPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Workout</h1>
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
        >
          Back to Home
        </Link>
      </div>
      <Workout />
    </main>
  );
}
