"use client";

import { useState } from "react";

type RenderResponse = {
  id: string;
  midiUrl: string;
  audioUrl: string;
  format: "wav" | "mp3";
  error?: string;
};

export default function Home() {
  const [text, setText] = useState(
    "[Key=C Instr=piano BPM=100]\n1 1 (135)~ 0 5 5 (246+).",
  );
  const [format, setFormat] = useState<"wav" | "mp3">("wav");
  const [audioUrl, setAudioUrl] = useState<string>("");
  const [midiUrl, setMidiUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [midiRef, setMidiRef] = useState<string>("");
  const [midiText, setMidiText] = useState<string>("");
  const [midiStatus, setMidiStatus] = useState<string>("");
  const [isMidiLoading, setIsMidiLoading] = useState(false);
  const [midiFile, setMidiFile] = useState<File | null>(null);

  const handleRender = async () => {
    setIsLoading(true);
    setStatus("正在渲染，请稍候...");
    setAudioUrl("");
    setMidiUrl("");

    try {
      const response = await fetch("/api/v0/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, format }),
      });
      const data = (await response.json()) as RenderResponse;

      if (!response.ok || data.error) {
        setStatus(data.error ?? "渲染失败");
        return;
      }

      setAudioUrl(data.audioUrl);
      setMidiUrl(data.midiUrl);
      setStatus("渲染完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setStatus(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMidiToText = async () => {
    setIsMidiLoading(true);
    setMidiStatus("正在解析 MIDI...");
    setMidiText("");

    try {
      let response: Response;
      if (midiFile) {
        const formData = new FormData();
        formData.append("file", midiFile);
        response = await fetch("/api/v0/midi", {
          method: "POST",
          body: formData,
        });
      } else {
        response = await fetch("/api/v0/midi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: midiRef.trim(),
            id: midiRef.trim(),
          }),
        });
      }
      const data = (await response.json()) as {
        text?: string;
        error?: string;
        tracks?: { index: number; text: string }[];
      };

      if (!response.ok || data.error) {
        setMidiStatus(data.error ?? "解析失败");
        return;
      }

      if (data.tracks && data.tracks.length > 1) {
        setMidiText(
          data.tracks
            .map((track) => `// Track ${track.index + 1}\n${track.text}`)
            .join("\n\n"),
        );
      } else {
        setMidiText(data.text ?? "");
      }
      setMidiStatus("解析完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setMidiStatus(message);
    } finally {
      setIsMidiLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 text-zinc-900">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">🎼 文本编曲测试</h1>
          <p className="text-sm text-zinc-600">
            输入简谱文本，点击渲染即可获得音频与 MIDI 链接。
          </p>
        </header>

        <section className="space-y-3">
          <textarea
            className="min-h-[180px] w-full rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm focus:border-zinc-400 focus:outline-none"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />

          <div className="flex flex-wrap items-center gap-3">
            <select
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={format}
              onChange={(event) =>
                setFormat(event.target.value === "mp3" ? "mp3" : "wav")
              }
            >
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
            </select>
            <button
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              type="button"
              onClick={handleRender}
              disabled={isLoading}
            >
              {isLoading ? "渲染中..." : "生成音频"}
            </button>
            <span className="text-sm text-zinc-600">{status}</span>
          </div>
        </section>

        <section className="space-y-3">
          {audioUrl ? (
            <audio controls src={audioUrl} className="w-full">
              <track kind="captions" />
            </audio>
          ) : (
            <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
              暂无音频输出
            </div>
          )}

          <div className="space-y-1 text-sm text-zinc-600">
            <div>
              MIDI:{" "}
              {midiUrl ? (
                <a className="text-blue-600 hover:underline" href={midiUrl}>
                  {midiUrl}
                </a>
              ) : (
                "暂无"
              )}
            </div>
            <div>
              音频:{" "}
              {audioUrl ? (
                <a className="text-blue-600 hover:underline" href={audioUrl}>
                  {audioUrl}
                </a>
              ) : (
                "暂无"
              )}
            </div>
          </div>
        </section>

        <section className="space-y-3 border-t border-zinc-200 pt-6">
          <h2 className="text-lg font-semibold">MIDI 转文字</h2>
          <p className="text-sm text-zinc-600">
            输入生成后的 id 或完整文件路径（例如 /api/v0/file/xxx.mid）。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="min-w-[220px] flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
              placeholder="输入 id 或 /api/v0/file/xxx.mid"
              value={midiRef}
              onChange={(event) => setMidiRef(event.target.value)}
              disabled={Boolean(midiFile)}
            />
            <input
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
              type="file"
              accept=".mid,.midi"
              onChange={(event) =>
                setMidiFile(event.target.files?.[0] ?? null)
              }
            />
            <button
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              type="button"
              onClick={handleMidiToText}
              disabled={isMidiLoading}
            >
              {isMidiLoading ? "解析中..." : "生成文字"}
            </button>
            <button
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-600 disabled:opacity-60"
              type="button"
              onClick={() => setMidiFile(null)}
              disabled={!midiFile}
            >
              清除文件
            </button>
            <span className="text-sm text-zinc-600">{midiStatus}</span>
          </div>

          <textarea
            className="min-h-[180px] w-full rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm focus:border-zinc-400 focus:outline-none"
            value={midiText}
            readOnly
            placeholder="解析结果会显示在这里"
          />
        </section>
      </div>
    </div>
  );
}
