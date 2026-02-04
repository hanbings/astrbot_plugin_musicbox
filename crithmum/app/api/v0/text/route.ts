import { NextRequest, NextResponse } from "next/server";
import { parseScore, persistScoreMedia } from "@/lib/music";

export const runtime = "nodejs";

function normalizeFormat(value: string | null | undefined) {
  if (!value) {
    return "wav";
  }
  const format = value.toLowerCase();
  return format === "mp3" ? "mp3" : "wav";
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let format = normalizeFormat(request.nextUrl.searchParams.get("format"));

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as {
        text?: string;
        format?: string;
      };
      text = body.text ?? "";
      if (body.format) {
        format = normalizeFormat(body.format);
      }
    } else {
      text = await request.text();
    }

    if (!text.trim()) {
      return NextResponse.json(
        { error: "缺少文本内容 text" },
        { status: 400 },
      );
    }

    const score = parseScore(text);
    const media = await persistScoreMedia(score, format);

    return NextResponse.json({
      id: media.id,
      midiUrl: media.midiUrl,
      audioUrl: media.audioUrl,
      format,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "未知解析或渲染错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
