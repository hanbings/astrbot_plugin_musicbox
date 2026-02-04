import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { midiToTexts } from "@/lib/music";

export const runtime = "nodejs";

function resolveMediaPath(input: string) {
  const name = input.trim();
  const fileName = name.startsWith("/api/v0/file/")
    ? name.replace("/api/v0/file/", "")
    : name;
  if (!/^[A-Za-z0-9-]+\.(mid|midi)$/.test(fileName)) {
    throw new Error("MIDI 文件名无效");
  }
  return path.join(process.cwd(), ".media", fileName.replace(".midi", ".mid"));
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let fileRef = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: "缺少上传的 MIDI 文件（字段名 file）" },
          { status: 400 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = midiToTexts(buffer);
      return NextResponse.json({
        text: result.combinedText,
        tracks: result.tracks,
      });
    }

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { id?: string; file?: string };
      if (body.file) {
        fileRef = body.file;
      } else if (body.id) {
        fileRef = `${body.id}.mid`;
      }
    } else {
      fileRef = await request.text();
    }

    if (!fileRef.trim()) {
      return NextResponse.json(
        { error: "缺少 MIDI 文件引用（id 或 file）" },
        { status: 400 },
      );
    }

    const filePath = resolveMediaPath(fileRef);
    const midiBuffer = await fs.readFile(filePath);
    const result = midiToTexts(midiBuffer);

    return NextResponse.json({
      text: result.combinedText,
      tracks: result.tracks,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "MIDI 转文字失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
