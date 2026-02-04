import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  mid: "audio/midi",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file: fileName } = await params;
  if (!/^[A-Za-z0-9-]+\.(mid|wav|mp3)$/.test(fileName)) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const outputDir = path.join(process.cwd(), ".media");
  const filePath = path.join(outputDir, fileName);
  try {
    const data = await fs.readFile(filePath);
    const extension = fileName.split(".").pop() ?? "mid";
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${fileName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
}
