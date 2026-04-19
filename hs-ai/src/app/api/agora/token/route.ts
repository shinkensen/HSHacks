import { NextRequest, NextResponse } from "next/server";
import { RtcRole, RtcTokenBuilder } from "agora-access-token";

export const runtime = "nodejs";

const TOKEN_TTL_SECONDS = 60 * 60;

function parseUid(rawUid: string | null): number | null {
  if (!rawUid) return null;
  const uid = Number(rawUid);
  if (!Number.isFinite(uid) || uid < 0) return null;
  return Math.floor(uid);
}

function sanitizeChannel(raw: string | null): string {
  if (!raw) return "";
  return raw.trim();
}

export async function GET(request: NextRequest) {
  const appId =
    process.env.AGORA_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_AGORA_APP_ID?.trim() ||
    "";
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim() || "";

  if (!appId || !appCertificate) {
    console.error("[agora-token] missing server env", {
      hasAppId: !!appId,
      hasCertificate: !!appCertificate,
    });
    return NextResponse.json(
      {
        error:
          "Agora server env missing. Set AGORA_APP_ID (or NEXT_PUBLIC_AGORA_APP_ID) and AGORA_APP_CERTIFICATE.",
      },
      { status: 500 },
    );
  }

  const channel = sanitizeChannel(request.nextUrl.searchParams.get("channel"));
  const uid = parseUid(request.nextUrl.searchParams.get("uid"));
  console.log("[agora-token] request", {
    channel,
    uid,
    hasAppId: !!appId,
    hasCertificate: !!appCertificate,
  });
  if (!channel || uid === null) {
    return NextResponse.json(
      { error: "channel and numeric uid query params are required" },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expireAt = now + TOKEN_TTL_SECONDS;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      RtcRole.PUBLISHER,
      expireAt,
    );

    return NextResponse.json({
      token,
      appId,
      uid,
      channel,
      expiresAt: expireAt,
    });
  } catch {
    console.error("[agora-token] token generation failed", {
      channel,
      uid,
    });
    return NextResponse.json(
      { error: "Failed to generate Agora token" },
      { status: 500 },
    );
  }
}
