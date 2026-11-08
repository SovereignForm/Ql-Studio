/**
 * QL STUDIO — Clean-Room FLP Binary Format Parser (`FLhd` + `FLdt` TLV Stream)
 *
 * Grounded in public open-source documentation of the `.flp` container:
 * - Header Chunk (`FLhd`): 6-byte payload (u16 format, u16 channelCount, u16 ppq)
 * - Data Chunk (`FLdt`): Stream of TLV events:
 *   - 0..63    : BYTE events (1-byte value)
 *   - 64..127  : WORD events (2-byte little-endian u16)
 *   - 128..191 : DWORD events (4-byte little-endian u32)
 *   - 192..255 : Variable-length TEXT/DATA events (7-bit LEB128 length + payload)
 */

import type { PpqResolution } from "./schemas.ts";

export const FlpEventId = {
  ByteEnabled: 0,
  ByteNoteOn: 1,
  ByteVol: 2,
  BytePan: 3,
  WordNewChan: 64,
  WordNewPat: 65,
  WordTempoCoarse: 66,
  WordCurrentPatNum: 67,
  DwordColor: 128,
  DwordFineTempo: 156, // Millibeats per minute (e.g., 140000 = 140.000 BPM)
  TextChanName: 192,
  TextPatName: 193,
  TextTitle: 194,
  TextAuthor: 207,
  TextVersion: 199,
  DataPatNotes: 224,   // Array of 24-byte note records
} as const;

export type FlpEventCategory = "BYTE" | "WORD" | "DWORD" | "VARIABLE";

export interface FlpParsedEvent {
  readonly eventId: number;
  readonly category: FlpEventCategory;
  readonly byteOffset: number;
  readonly numericValue: number | null;
  readonly rawPayload: Uint8Array | null;
  readonly textUtf8: string | null;
}

export interface FlpHeaderChunk {
  readonly formatType: number;
  readonly channelCount: number;
  readonly ppq: PpqResolution;
}

export interface FlpParsedDocument {
  readonly header: FlpHeaderChunk;
  readonly dataChunkLength: number;
  readonly events: readonly FlpParsedEvent[];
  readonly derivedTitle: string | null;
  readonly derivedBpm: number | null;
}

/**
 * Decodes a 7-bit unsigned LEB128 integer from `bytes` starting at `offset`.
 */
export function decodeUnsignedLeb128(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly nextOffset: number } {
  let result = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < bytes.length) {
    const byte = bytes[cursor]!;
    cursor++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: cursor };
    }
    shift += 7;
    if (shift > 35) {
      throw new Error(`Malformed LEB128 varint at offset ${offset}`);
    }
  }
  throw new Error(`Unexpected EOF while decoding LEB128 at offset ${offset}`);
}

/**
 * Encodes an unsigned integer as 7-bit LEB128 bytes.
 */
export function encodeUnsignedLeb128(value: number): Uint8Array {
  const out: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining !== 0);
  return new Uint8Array(out);
}

/**
 * Parses a clean-room `.flp` binary buffer into structured header and TLV events.
 */
export function parseFlpBinary(bytes: Uint8Array): FlpParsedDocument {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });

  if (bytes.byteLength < 22) {
    throw new Error("Invalid FLP buffer: shorter than minimum 22-byte header");
  }

  const magicFlhd = decoder.decode(bytes.subarray(0, 4));
  if (magicFlhd !== "FLhd") {
    throw new Error(`Expected FLhd magic at offset 0, got ${JSON.stringify(magicFlhd)}`);
  }

  const flhdSize = view.getUint32(4, true);
  if (flhdSize !== 6) {
    throw new Error(`Expected FLhd size 6, got ${flhdSize}`);
  }

  const formatType = view.getUint16(8, true);
  const channelCount = view.getUint16(10, true);
  const rawPpq = view.getUint16(12, true);
  const ppq: PpqResolution =
    rawPpq === 192 ? 192 : rawPpq === 384 ? 384 : 96;

  const magicFldt = decoder.decode(bytes.subarray(14, 18));
  if (magicFldt !== "FLdt") {
    throw new Error(`Expected FLdt magic at offset 14, got ${JSON.stringify(magicFldt)}`);
  }

  const dataChunkLength = view.getUint32(18, true);
  const eventsEnd = Math.min(bytes.byteLength, 22 + dataChunkLength);

  const events: FlpParsedEvent[] = [];
  let cursor = 22;
  let derivedTitle: string | null = null;
  let derivedBpm: number | null = null;

  while (cursor < eventsEnd) {
    const eventOffset = cursor;
    const eventId = bytes[cursor]!;
    cursor++;

    if (eventId < 64) {
      const val = bytes[cursor]!;
      cursor += 1;
      events.push({
        eventId,
        category: "BYTE",
        byteOffset: eventOffset,
        numericValue: val,
        rawPayload: null,
        textUtf8: null,
      });
    } else if (eventId < 128) {
      const val = view.getUint16(cursor, true);
      cursor += 2;
      if (eventId === FlpEventId.WordTempoCoarse && derivedBpm === null) {
        derivedBpm = val;
      }
      events.push({
        eventId,
        category: "WORD",
        byteOffset: eventOffset,
        numericValue: val,
        rawPayload: null,
        textUtf8: null,
      });
    } else if (eventId < 192) {
      const val = view.getUint32(cursor, true);
      cursor += 4;
      if (eventId === FlpEventId.DwordFineTempo) {
        derivedBpm = val / 1000.0;
      }
      events.push({
        eventId,
        category: "DWORD",
        byteOffset: eventOffset,
        numericValue: val,
        rawPayload: null,
        textUtf8: null,
      });
    } else {
      const { value: payloadLen, nextOffset } = decodeUnsignedLeb128(
        bytes,
        cursor,
      );
      cursor = nextOffset;
      const payload = bytes.subarray(cursor, cursor + payloadLen);
      cursor += payloadLen;

      const isTextEvent =
        eventId === FlpEventId.TextTitle ||
        eventId === FlpEventId.TextAuthor ||
        eventId === FlpEventId.TextChanName ||
        eventId === FlpEventId.TextPatName ||
        eventId === FlpEventId.TextVersion;

      const textUtf8 = isTextEvent
        ? decoder.decode(payload).replace(/\0+$/g, "")
        : null;

      if (eventId === FlpEventId.TextTitle && textUtf8 !== null) {
        derivedTitle = textUtf8;
      }

      events.push({
        eventId,
        category: "VARIABLE",
        byteOffset: eventOffset,
        numericValue: null,
        rawPayload: payload,
        textUtf8,
      });
    }
  }

  return {
    header: { formatType, channelCount, ppq },
    dataChunkLength,
    events,
    derivedTitle,
    derivedBpm,
  };
}

/**
 * Generates a synthetic clean-room `.flp` binary buffer for testing REA binary inspection.
 */
export function buildCleanRoomSampleFlp(options: {
  readonly title: string;
  readonly bpm: number;
  readonly ppq: PpqResolution;
  readonly channelNames: readonly string[];
}): Uint8Array {
  const encoder = new TextEncoder();
  const eventChunks: Uint8Array[] = [];

  const pushTextEvent = (eventId: number, text: string) => {
    const strBytes = encoder.encode(`${text}\0`);
    const lenBytes = encodeUnsignedLeb128(strBytes.byteLength);
    const chunk = new Uint8Array(1 + lenBytes.byteLength + strBytes.byteLength);
    chunk[0] = eventId;
    chunk.set(lenBytes, 1);
    chunk.set(strBytes, 1 + lenBytes.byteLength);
    eventChunks.push(chunk);
  };

  // Version & Title
  pushTextEvent(FlpEventId.TextVersion, "QlStudio-CleanRoom-1.0.0");
  pushTextEvent(FlpEventId.TextTitle, options.title);

  // Fine Tempo (DWORD 156 = millibeats per minute)
  const tempoChunk = new Uint8Array(5);
  tempoChunk[0] = FlpEventId.DwordFineTempo;
  new DataView(tempoChunk.buffer).setUint32(
    1,
    Math.round(options.bpm * 1000),
    true,
  );
  eventChunks.push(tempoChunk);

  // Channels
  options.channelNames.forEach((name, idx) => {
    const newChan = new Uint8Array(3);
    newChan[0] = FlpEventId.WordNewChan;
    new DataView(newChan.buffer).setUint16(1, idx, true);
    eventChunks.push(newChan);
    pushTextEvent(FlpEventId.TextChanName, name);
  });

  const dataLength = eventChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(22 + dataLength);
  const view = new DataView(out.buffer);

  // FLhd (14 bytes total: 4 magic + 4 size + 6 payload)
  out.set(encoder.encode("FLhd"), 0);
  view.setUint32(4, 6, true);
  view.setUint16(8, 0, true); // format 0 = full project
  view.setUint16(10, options.channelNames.length, true);
  view.setUint16(12, options.ppq, true);

  // FLdt (8 bytes header + event stream)
  out.set(encoder.encode("FLdt"), 14);
  view.setUint32(18, dataLength, true);

  let offset = 22;
  for (const chunk of eventChunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}
