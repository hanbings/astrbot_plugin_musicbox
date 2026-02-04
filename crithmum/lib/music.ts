import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as JSSynth from "js-synthesizer";
import libfluidsynth from "js-synthesizer/libfluidsynth";
import lamejs from "lamejs";

const DEFAULT_HEADER = {
  key: "C",
  bpm: 120,
  volume: 0.8,
  octave: 4,
  program: 0,
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

const KEY_OFFSETS: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

const INSTRUMENT_MAP: Record<string, number> = {
  piano: 0,
};

type ScoreHeader = {
  key: string;
  bpm: number;
  volume: number;
  octave: number;
  program: number;
};

type NoteSpec = {
  degree: number;
  octaveShift: number;
  accidental: number;
};

type ScoreEvent = {
  type: "note" | "chord" | "rest";
  durationBeats: number;
  notes: NoteSpec[];
};

export type ParsedScore = {
  header: ScoreHeader;
  events: ScoreEvent[];
  totalBeats: number;
};

type MidiEvent = {
  tick: number;
  order: number;
  bytes: number[];
};

let synthReady: Promise<void> | null = null;

function ensureSynthReady() {
  if (!synthReady) {
    JSSynth.Synthesizer.initializeWithFluidSynthModule(libfluidsynth as any);
    synthReady = JSSynth.waitForReady();
  }
  return synthReady;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseHeader(input: string): { header: ScoreHeader; rest: string } {
  const match = input.match(/^\s*\[([^\]]+)\]/);
  if (!match) {
    return { header: { ...DEFAULT_HEADER }, rest: input };
  }

  const headerText = match[1].trim();
  const header: ScoreHeader = { ...DEFAULT_HEADER };
  const pairs = Array.from(headerText.matchAll(/([A-Za-z]+)\s*=\s*([^\s]+)/g));

  if (pairs.length === 0) {
    const tokens = headerText.split(/\s+/).filter(Boolean);
    if (tokens.length >= 1) {
      header.key = tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1);
    }
    if (tokens.length >= 2) {
      const programNumber = Number(tokens[1]);
      if (!Number.isNaN(programNumber)) {
        header.program = clamp(Math.round(programNumber), 0, 127);
      }
    }
    if (tokens.length >= 3) {
      const bpm = Number(tokens[2]);
      if (!Number.isNaN(bpm) && bpm > 0) {
        header.bpm = bpm;
      }
    }
    return { header, rest: input.slice(match[0].length) };
  }

  for (const [, keyRaw, valueRaw] of pairs) {
    const key = keyRaw.toLowerCase();
    const value = valueRaw.trim();

    if (key === "key") {
      header.key = value.charAt(0).toUpperCase() + value.slice(1);
      continue;
    }

    if (key === "instr" || key === "program") {
      const programNumber = Number(value);
      if (!Number.isNaN(programNumber)) {
        header.program = clamp(Math.round(programNumber), 0, 127);
      } else {
        const mapped = INSTRUMENT_MAP[value.toLowerCase()];
        if (mapped !== undefined) {
          header.program = mapped;
        }
      }
      continue;
    }

    if (key === "bpm") {
      const bpm = Number(value);
      if (!Number.isNaN(bpm) && bpm > 0) {
        header.bpm = bpm;
      }
      continue;
    }

    if (key === "vol") {
      const vol = Number(value);
      if (!Number.isNaN(vol) && vol > 0) {
        header.volume = vol > 1 ? clamp(vol / 127, 0, 1) : clamp(vol, 0, 1);
      }
      continue;
    }

    if (key === "oct") {
      const oct = Number(value);
      if (!Number.isNaN(oct)) {
        header.octave = Math.round(oct);
      }
    }
  }

  return { header, rest: input.slice(match[0].length) };
}

function parseNoteSpecs(segment: string): NoteSpec[] {
  const notes: NoteSpec[] = [];
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (!/[1-7]/.test(ch)) {
      throw new Error(`和弦内仅允许音符与音高修饰符: ${segment}`);
    }

    const degree = Number(ch);
    i += 1;

    let octaveShift = 0;
    let accidental = 0;
    while (i < segment.length) {
      const mod = segment[i];
      if (mod === "+") {
        octaveShift += 1;
      } else if (mod === "-") {
        octaveShift -= 1;
      } else if (mod === "#") {
        accidental += 1;
      } else if (mod === "b") {
        accidental -= 1;
      } else if (mod === "_") {
        accidental += 1;
      } else if (/\s/.test(mod)) {
        i += 1;
        continue;
      } else {
        break;
      }
      i += 1;
    }

    notes.push({ degree, octaveShift, accidental });
  }

  return notes;
}

function parseDuration(text: string, startIndex: number): [number, number] {
  let i = startIndex;
  let dotCount = 0;
  let sustainCount = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === ".") {
      dotCount += 1;
      i += 1;
      continue;
    }
    if (ch === "~") {
      sustainCount += 1;
      i += 1;
      continue;
    }
    break;
  }

  const dotMultiplier = Math.pow(1.5, dotCount);
  const duration = 1 * dotMultiplier + sustainCount;

  return [duration, i];
}

export function parseScore(input: string): ParsedScore {
  const { header, rest } = parseHeader(input);
  const events: ScoreEvent[] = [];
  let i = 0;
  let totalBeats = 0;

  while (i < rest.length) {
    const ch = rest[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(") {
      const endIndex = rest.indexOf(")", i + 1);
      if (endIndex === -1) {
        throw new Error("和弦缺少右括号 )");
      }
      const chordBody = rest.slice(i + 1, endIndex);
      const notes = parseNoteSpecs(chordBody);
      if (notes.length === 0) {
        throw new Error("和弦内必须包含至少一个音符");
      }
      i = endIndex + 1;
      const [duration, nextIndex] = parseDuration(rest, i);
      i = nextIndex;
      events.push({ type: "chord", durationBeats: duration, notes });
      totalBeats += duration;
      continue;
    }

    if (ch === "0") {
      i += 1;
      const [duration, nextIndex] = parseDuration(rest, i);
      i = nextIndex;
      events.push({ type: "rest", durationBeats: duration, notes: [] });
      totalBeats += duration;
      continue;
    }

    if (/[1-7]/.test(ch)) {
      const degree = Number(ch);
      i += 1;
      let octaveShift = 0;
      let accidental = 0;
      while (i < rest.length) {
        const mod = rest[i];
        if (mod === "+") {
          octaveShift += 1;
        } else if (mod === "-") {
          octaveShift -= 1;
        } else if (mod === "#") {
          accidental += 1;
        } else if (mod === "b") {
          accidental -= 1;
        } else if (mod === "_") {
          accidental += 1;
        } else {
          break;
        }
        i += 1;
      }
      const [duration, nextIndex] = parseDuration(rest, i);
      i = nextIndex;
      events.push({
        type: "note",
        durationBeats: duration,
        notes: [{ degree, octaveShift, accidental }],
      });
      totalBeats += duration;
      continue;
    }

    throw new Error(`无法识别的符号: ${ch}`);
  }

  return { header, events, totalBeats };
}

function degreeToMidi(
  degree: number,
  octaveShift: number,
  accidental: number,
  header: ScoreHeader,
) {
  const keyOffset = KEY_OFFSETS[header.key] ?? 0;
  const baseC = 12 * (header.octave + 1);
  const tonic = baseC + keyOffset;
  const scaleOffset = MAJOR_SCALE[degree - 1] ?? 0;
  const midi =
    tonic + scaleOffset + accidental + octaveShift * 12;

  return clamp(Math.round(midi), 0, 127);
}

function writeVarLen(value: number) {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
  return bytes;
}

function createMidiFile(
  header: ScoreHeader,
  events: ScoreEvent[],
  ticksPerBeat = 480,
) {
  const velocity = clamp(Math.round(header.volume * 127), 1, 127);
  const bpm = header.bpm;
  const tempo = Math.round(60000000 / bpm);

  const midiEvents: MidiEvent[] = [
    {
      tick: 0,
      order: 0,
      bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff],
    },
    {
      tick: 0,
      order: 1,
      bytes: [0xc0, header.program & 0x7f],
    },
    {
      tick: 0,
      order: 2,
      bytes: [0xb0, 0x07, velocity],
    },
  ];

  let tick = 0;
  for (const event of events) {
    const durationTicks = Math.round(event.durationBeats * ticksPerBeat);
    if (event.type === "rest") {
      tick += durationTicks;
      continue;
    }

    const midiNotes = event.notes.map((note) =>
      degreeToMidi(note.degree, note.octaveShift, note.accidental, header),
    );
    for (const note of midiNotes) {
      midiEvents.push({
        tick,
        order: 3,
        bytes: [0x90, note, velocity],
      });
      midiEvents.push({
        tick: tick + durationTicks,
        order: 0,
        bytes: [0x80, note, 0],
      });
    }
    tick += durationTicks;
  }

  midiEvents.sort((a, b) => {
    if (a.tick !== b.tick) {
      return a.tick - b.tick;
    }
    return a.order - b.order;
  });

  const trackData: number[] = [];
  let lastTick = 0;
  for (const event of midiEvents) {
    const delta = event.tick - lastTick;
    trackData.push(...writeVarLen(delta), ...event.bytes);
    lastTick = event.tick;
  }
  trackData.push(0x00, 0xff, 0x2f, 0x00);

  const headerChunk = Buffer.alloc(14);
  headerChunk.write("MThd", 0);
  headerChunk.writeUInt32BE(6, 4);
  headerChunk.writeUInt16BE(0, 8);
  headerChunk.writeUInt16BE(1, 10);
  headerChunk.writeUInt16BE(ticksPerBeat, 12);

  const trackChunkHeader = Buffer.alloc(8);
  trackChunkHeader.write("MTrk", 0);
  trackChunkHeader.writeUInt32BE(trackData.length, 4);

  return Buffer.concat([headerChunk, trackChunkHeader, Buffer.from(trackData)]);
}

export function scoreToMidiBuffer(score: ParsedScore) {
  return createMidiFile(score.header, score.events);
}

function durationToTokens(duration: number) {
  const epsilon = 0.0001;
  const base = Math.max(1, Math.floor(duration));
  const isInteger = Math.abs(duration - base) < epsilon;
  if (isInteger) {
    return "~".repeat(Math.max(0, base - 1));
  }

  const isDotted = Math.abs(duration - (base + 0.5)) < epsilon;
  if (isDotted) {
    return `.${"~".repeat(Math.max(0, base - 1))}`;
  }

  return "~".repeat(Math.max(0, Math.round(duration) - 1));
}

function noteToText(note: NoteSpec) {
  const octaveMods =
    (note.octaveShift > 0 ? "+".repeat(note.octaveShift) : "") +
    (note.octaveShift < 0 ? "-".repeat(-note.octaveShift) : "");
  const accidentalMods =
    (note.accidental > 0 ? "#".repeat(note.accidental) : "") +
    (note.accidental < 0 ? "b".repeat(-note.accidental) : "");
  return `${note.degree}${octaveMods}${accidentalMods}`;
}

export function scoreToText(score: ParsedScore) {
  const header = score.header;
  const headerText = `[Key=${header.key} Instr=${header.program} BPM=${header.bpm} Vol=${header.volume} Oct=${header.octave}]`;
  const body = score.events
    .map((event) => {
      const duration = durationToTokens(event.durationBeats);
      if (event.type === "rest") {
        return `0${duration}`;
      }
      if (event.type === "chord") {
        const chordNotes = event.notes.map(noteToText).join("");
        return `(${chordNotes})${duration}`;
      }
      return `${noteToText(event.notes[0])}${duration}`;
    })
    .join(" ");

  return `${headerText}\n${body}`;
}

type MidiNoteEvent = {
  startTick: number;
  endTick: number;
  note: number;
  velocity: number;
};

type ParsedMidiTrack = {
  program: number;
  volume: number;
  noteEvents: MidiNoteEvent[];
};

type ParsedMidiData = {
  ticksPerBeat: number;
  tempo: number;
  tracks: ParsedMidiTrack[];
};

function readUInt32BE(data: Uint8Array, offset: number) {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

function readVarLen(data: Uint8Array, offset: number) {
  let value = 0;
  let i = offset;
  while (i < data.length) {
    const byte = data[i];
    value = (value << 7) | (byte & 0x7f);
    i += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
  }
  return { value, next: i };
}

function quantizeBeats(beats: number) {
  return Math.max(0.5, Math.round(beats * 2) / 2);
}

function midiNoteToSpec(
  note: number,
  header: ScoreHeader,
): NoteSpec {
  const keyOffset = KEY_OFFSETS[header.key] ?? 0;
  const tonic = 12 * (header.octave + 1) + keyOffset;
  const diff = note - tonic;
  const octaveShift = Math.floor(diff / 12);
  const pitchClass = ((diff % 12) + 12) % 12;

  let bestDegree = 1;
  let bestAccidental = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let degree = 1; degree <= 7; degree += 1) {
    const scaleOffset = MAJOR_SCALE[degree - 1] ?? 0;
    let accidental = pitchClass - scaleOffset;
    if (accidental > 6) accidental -= 12;
    if (accidental < -6) accidental += 12;
    const distance = Math.abs(accidental);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDegree = degree;
      bestAccidental = accidental;
    }
  }

  return {
    degree: bestDegree,
    accidental: bestAccidental,
    octaveShift,
  };
}

function parseMidiTrack(
  data: Uint8Array,
  offset: number,
  trackLength: number,
  tempoHint?: number,
) {
  let currentTick = 0;
  let runningStatus = 0;
  let program = 0;
  let volume = 0.8;
  let tempo = tempoHint ?? 500000;

  const activeNotes = new Map<
    string,
    { startTick: number; velocity: number }
  >();
  const noteEvents: MidiNoteEvent[] = [];

  const trackEnd = offset + trackLength;
  while (offset < trackEnd) {
    const delta = readVarLen(data, offset);
    offset = delta.next;
    currentTick += delta.value;

    let status = data[offset];
    if (status < 0x80) {
      status = runningStatus;
    } else {
      offset += 1;
      runningStatus = status;
    }

    if (status === 0xff) {
      const metaType = data[offset];
      offset += 1;
      const lengthInfo = readVarLen(data, offset);
      offset = lengthInfo.next;
      const metaData = data.subarray(offset, offset + lengthInfo.value);
      offset += lengthInfo.value;

      if (metaType === 0x51 && metaData.length === 3) {
        tempo =
          (metaData[0] << 16) | (metaData[1] << 8) | metaData[2];
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const lengthInfo = readVarLen(data, offset);
      offset = lengthInfo.next + lengthInfo.value;
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = data[offset];
    const data2 = data[offset + 1];

    if (eventType === 0xc0) {
      program = data1;
      offset += 1;
      continue;
    }

    if (eventType === 0xb0) {
      if (data1 === 0x07) {
        volume = clamp(data2 / 127, 0, 1);
      }
      offset += 2;
      continue;
    }

    if (eventType === 0x90) {
      const note = data1;
      const velocity = data2;
      offset += 2;
      const key = `${channel}-${note}`;
      if (velocity === 0) {
        const active = activeNotes.get(key);
        if (active) {
          noteEvents.push({
            startTick: active.startTick,
            endTick: currentTick,
            note,
            velocity: active.velocity,
          });
          activeNotes.delete(key);
        }
      } else {
        activeNotes.set(key, { startTick: currentTick, velocity });
      }
      continue;
    }

    if (eventType === 0x80) {
      const note = data1;
      offset += 2;
      const key = `${channel}-${note}`;
      const active = activeNotes.get(key);
      if (active) {
        noteEvents.push({
          startTick: active.startTick,
          endTick: currentTick,
          note,
          velocity: active.velocity,
        });
        activeNotes.delete(key);
      }
      continue;
    }

    offset += eventType === 0xc0 || eventType === 0xd0 ? 1 : 2;
  }

  return { program, volume, noteEvents, tempo };
}

function parseMidiBuffer(midiBuffer: Buffer): ParsedMidiData {
  const data = new Uint8Array(midiBuffer);
  let offset = 0;

  const headerChunk = data.subarray(offset, offset + 4);
  if (String.fromCharCode(...headerChunk) !== "MThd") {
    throw new Error("MIDI 文件头无效");
  }
  offset += 4;
  const headerLength = readUInt32BE(data, offset);
  offset += 4;
  const format = (data[offset] << 8) | data[offset + 1];
  const numTracks = (data[offset + 2] << 8) | data[offset + 3];
  const ticksPerBeat = (data[offset + 4] << 8) | data[offset + 5];
  offset += headerLength;

  if (numTracks < 1) {
    throw new Error("MIDI 轨道数量无效");
  }

  const tracks: ParsedMidiTrack[] = [];
  let tempo = 500000;

  for (let trackIndex = 0; trackIndex < numTracks; trackIndex += 1) {
    const trackHeader = data.subarray(offset, offset + 4);
    if (String.fromCharCode(...trackHeader) !== "MTrk") {
      throw new Error("MIDI 轨道头无效");
    }
    offset += 4;
    const trackLength = readUInt32BE(data, offset);
    offset += 4;

    const parsed = parseMidiTrack(data, offset, trackLength, tempo);
    if (trackIndex === 0) {
      tempo = parsed.tempo;
    }
    tracks.push({
      program: parsed.program,
      volume: parsed.volume,
      noteEvents: parsed.noteEvents,
    });

    offset += trackLength;
  }

  return {
    ticksPerBeat,
    tempo,
    tracks,
  };
}

function normalizeNoteEvents(
  noteEvents: MidiNoteEvent[],
  _ticksPerBeat: number,
) {
  return noteEvents;
}

function buildScoreFromNoteEvents(
  noteEvents: MidiNoteEvent[],
  header: ScoreHeader,
  ticksPerBeat: number,
) {
  const events: ScoreEvent[] = [];

  const normalizedEvents = normalizeNoteEvents(noteEvents, ticksPerBeat);
  const grouped = new Map<string, MidiNoteEvent[]>();
  for (const noteEvent of normalizedEvents) {
    const key = `${noteEvent.startTick}-${noteEvent.endTick}`;
    const list = grouped.get(key) ?? [];
    list.push(noteEvent);
    grouped.set(key, list);
  }

  const timePoints = Array.from(grouped.keys())
    .map((key) => {
      const [start, end] = key.split("-").map(Number);
      return { startTick: start, endTick: end };
    })
    .sort((a, b) => a.startTick - b.startTick);

  let currentTick = 0;
  let totalBeats = 0;

  for (const timePoint of timePoints) {
    if (timePoint.startTick > currentTick) {
      const restBeats = quantizeBeats(
        (timePoint.startTick - currentTick) / ticksPerBeat,
      );
      events.push({ type: "rest", durationBeats: restBeats, notes: [] });
      totalBeats += restBeats;
      currentTick = timePoint.startTick;
    }

    const groupKey = `${timePoint.startTick}-${timePoint.endTick}`;
    const notes = grouped.get(groupKey) ?? [];
    const durationBeats = quantizeBeats(
      (timePoint.endTick - timePoint.startTick) / ticksPerBeat,
    );
    const noteSpecs = notes
      .sort((a, b) => a.note - b.note)
      .map((noteEvent) => midiNoteToSpec(noteEvent.note, header));

    events.push({
      type: noteSpecs.length > 1 ? "chord" : "note",
      durationBeats,
      notes: noteSpecs,
    });
    totalBeats += durationBeats;
    currentTick = timePoint.endTick;
  }

  return { header, events, totalBeats };
}

export function midiToScores(midiBuffer: Buffer): ParsedScore[] {
  const { ticksPerBeat, tempo, tracks } = parseMidiBuffer(midiBuffer);
  const bpm = Math.max(30, Math.round(60000000 / tempo));

  return tracks.map((track) =>
    buildScoreFromNoteEvents(
      track.noteEvents,
      {
        key: "C",
        bpm,
        volume: track.volume,
        octave: 4,
        program: track.program,
      },
      ticksPerBeat,
    ),
  );
}

export function midiToScore(midiBuffer: Buffer): ParsedScore {
  const scores = midiToScores(midiBuffer);
  return scores[0] ?? {
    header: { key: "C", bpm: 120, volume: 0.8, octave: 4, program: 0 },
    events: [],
    totalBeats: 0,
  };
}

export function midiToText(midiBuffer: Buffer) {
  const scores = midiToScores(midiBuffer);
  if (scores.length <= 1) {
    return scoreToText(scores[0]);
  }
  return scores
    .map((score, index) => `// Track ${index + 1}\n${scoreToText(score)}`)
    .join("\n\n");
}

export function midiToTexts(midiBuffer: Buffer) {
  const scores = midiToScores(midiBuffer);
  const tracks = scores.map((score, index) => ({
    index,
    text: scoreToText(score),
  }));
  const combinedText =
    tracks.length <= 1
      ? tracks[0]?.text ?? ""
      : tracks
          .map((track) => `// Track ${track.index + 1}\n${track.text}`)
          .join("\n\n");
  return { combinedText, tracks };
}

function encodeWav(samples: Float32Array[], sampleRate: number) {
  const numChannels = samples.length;
  const length = samples[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const buffer = Buffer.alloc(44 + length * blockAlign);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + length * blockAlign, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(length * blockAlign, 40);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < numChannels; channel += 1) {
      const sample = clamp(samples[channel][i] ?? 0, -1, 1);
      buffer.writeInt16LE(Math.round(sample * 32767), offset);
      offset += 2;
    }
  }

  return buffer;
}

function encodeMp3(samples: Float32Array[], sampleRate: number) {
  const numChannels = samples.length;
  const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 128);
  const samplesPerFrame = 1152;
  const left = samples[0];
  const right = samples[1] ?? samples[0];
  const mp3Chunks: Buffer[] = [];

  for (let i = 0; i < left.length; i += samplesPerFrame) {
    const leftChunk = left.subarray(i, i + samplesPerFrame);
    const rightChunk = right.subarray(i, i + samplesPerFrame);
    const leftInt = new Int16Array(leftChunk.length);
    const rightInt = new Int16Array(rightChunk.length);
    for (let j = 0; j < leftChunk.length; j += 1) {
      leftInt[j] = Math.round(clamp(leftChunk[j], -1, 1) * 32767);
      rightInt[j] = Math.round(clamp(rightChunk[j], -1, 1) * 32767);
    }
    const mp3buf = mp3Encoder.encodeBuffer(leftInt, rightInt);
    if (mp3buf.length > 0) {
      mp3Chunks.push(Buffer.from(mp3buf));
    }
  }
  const endBuffer = mp3Encoder.flush();
  if (endBuffer.length > 0) {
    mp3Chunks.push(Buffer.from(endBuffer));
  }
  return Buffer.concat(mp3Chunks);
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

export async function renderMidiToAudio(options: {
  midiData: Buffer;
  durationSeconds: number;
  program: number;
  volume: number;
  format: "wav" | "mp3";
  soundfontPath?: string;
}) {
  const sampleRate = 44100;
  const blockSize = 4096;
  const totalSamples = Math.max(1, Math.ceil(options.durationSeconds * sampleRate));

  const soundfontPath =
    options.soundfontPath ??
    path.join(process.cwd(), "public", "piano.sf2");

  const soundfontData = await fs.readFile(soundfontPath);
  await ensureSynthReady();

  const synth = new JSSynth.Synthesizer();
  synth.init(sampleRate);
  synth.setGain(clamp(options.volume, 0, 1));

  const sfontId = await synth.loadSFont(toArrayBuffer(soundfontData));
  synth.midiSFontSelect(0, sfontId);
  synth.midiProgramSelect(0, sfontId, 0, options.program);

  await synth.addSMFDataToPlayer(toArrayBuffer(options.midiData));
  await synth.playPlayer();

  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  let offset = 0;

  while (offset < totalSamples) {
    const frames = Math.min(blockSize, totalSamples - offset);
    const leftBlock = new Float32Array(frames);
    const rightBlock = new Float32Array(frames);
    synth.render([leftBlock, rightBlock]);
    left.set(leftBlock, offset);
    right.set(rightBlock, offset);
    offset += frames;
  }

  synth.stopPlayer();
  await synth.waitForVoicesStopped();
  synth.close();

  const samples = [left, right];
  if (options.format === "mp3") {
    return encodeMp3(samples, sampleRate);
  }
  return encodeWav(samples, sampleRate);
}

export async function persistScoreMedia(
  score: ParsedScore,
  format: "wav" | "mp3",
) {
  const outputDir = path.join(process.cwd(), ".media");
  await fs.mkdir(outputDir, { recursive: true });

  const id = crypto.randomUUID();
  const midiBuffer = scoreToMidiBuffer(score);
  const midiPath = path.join(outputDir, `${id}.mid`);
  await fs.writeFile(midiPath, midiBuffer);

  const durationSeconds = score.totalBeats * (60 / score.header.bpm) + 1;
  const audioBuffer = await renderMidiToAudio({
    midiData: midiBuffer,
    durationSeconds,
    program: score.header.program,
    volume: score.header.volume,
    format,
  });

  const audioPath = path.join(outputDir, `${id}.${format}`);
  await fs.writeFile(audioPath, audioBuffer);

  return {
    id,
    midiUrl: `/api/v0/file/${id}.mid`,
    audioUrl: `/api/v0/file/${id}.${format}`,
  };
}
