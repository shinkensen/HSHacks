import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function StepCard({ text }: { text: string }) {
  return (
    <Card className="w-full bg-card/90">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Current step
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-balance text-2xl leading-tight font-medium sm:text-3xl">
          {text}
        </p>
      </CardContent>
    </Card>
  );
}
