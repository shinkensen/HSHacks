import { ConvexHttpClient } from "convex/browser";

let cachedClient: ConvexHttpClient | null = null;

function readConvexUrl(): string {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) {
    throw new Error("Convex URL missing. Set NEXT_PUBLIC_CONVEX_URL or CONVEX_URL.");
  }
  return url;
}

function getClient(): ConvexHttpClient {
  if (!cachedClient) {
    cachedClient = new ConvexHttpClient(readConvexUrl());
  }
  return cachedClient;
}

export async function queryConvex<TResponse>(
  functionName: string,
  args: Record<string, unknown>,
): Promise<TResponse> {
  const client = getClient();
  return (await client.query(functionName as never, args as never)) as TResponse;
}

export async function mutateConvex<TResponse>(
  functionName: string,
  args: Record<string, unknown>,
): Promise<TResponse> {
  const client = getClient();
  return (await client.mutation(functionName as never, args as never)) as TResponse;
}
