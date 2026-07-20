const { articleAudioError } = require('./errors');

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_FLAC_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_FRAME_SCAN_BYTES = 64 * 1024;

const MPEG1_BITRATES = Object.freeze({
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
});
const MPEG2_BITRATES = Object.freeze({
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
});
const SAMPLE_RATES = Object.freeze({
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000]
});

function parseFrame(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  const header = buffer.readUInt32BE(offset);
  if ((header >>> 21) !== 0x7ff) return null;

  const versionBits = (header >>> 19) & 0x03;
  const layerBits = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  const padding = (header >>> 9) & 0x01;
  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }

  const layer = 4 - layerBits;
  const bitrateTable = versionBits === 3 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrate = bitrateTable[layer][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex];
  let frameLength;
  if (layer === 1) {
    frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  } else if (layer === 3 && versionBits !== 3) {
    frameLength = Math.floor((72 * bitrate) / sampleRate) + padding;
  } else {
    frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;
  }

  if (frameLength <= 4 || offset + frameLength > buffer.length) return null;
  return { frameLength };
}

function isValidId3FrameId(buffer, offset, length) {
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[offset + index];
    const isUppercaseLetter = byte >= 0x41 && byte <= 0x5a;
    const isDigit = byte >= 0x30 && byte <= 0x39;
    if (!isUppercaseLetter && !isDigit) return false;
  }
  return true;
}

function readSynchsafeUInt32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  const bytes = buffer.subarray(offset, offset + 4);
  if ([...bytes].some(byte => (byte & 0x80) !== 0)) return null;
  return (
    (bytes[0] << 21) |
    (bytes[1] << 14) |
    (bytes[2] << 7) |
    bytes[3]
  );
}

function hasOnlyZeroPadding(buffer, start, end) {
  for (let offset = start; offset < end; offset += 1) {
    if (buffer[offset] !== 0) return false;
  }
  return true;
}

function hasValidId3Frames(buffer, majorVersion, tagFlags, start, end) {
  const frameHeaderLength = majorVersion === 2 ? 6 : 10;
  const frameIdLength = majorVersion === 2 ? 3 : 4;
  let frameCount = 0;
  let offset = start;
  let sawPadding = false;

  while (offset < end) {
    if (buffer[offset] === 0) {
      if (!hasOnlyZeroPadding(buffer, offset, end)) return false;
      sawPadding = true;
      offset = end;
      break;
    }
    if (end - offset < frameHeaderLength) return false;
    if (!isValidId3FrameId(buffer, offset, frameIdLength)) return false;

    let frameSize;
    if (majorVersion === 2) {
      frameSize = buffer.readUIntBE(offset + 3, 3);
    } else if (majorVersion === 3) {
      frameSize = buffer.readUInt32BE(offset + 4);
      const statusFlags = buffer[offset + 8];
      const formatFlags = buffer[offset + 9];
      if ((statusFlags & ~0xe0) !== 0 || formatFlags !== 0) return false;
    } else {
      frameSize = readSynchsafeUInt32(buffer, offset + 4);
      if (frameSize === null) return false;
      const statusFlags = buffer[offset + 8];
      const formatFlags = buffer[offset + 9];
      if ((statusFlags & ~0x70) !== 0 || formatFlags !== 0) return false;
    }

    if (frameSize < 1) return false;
    const frameEnd = offset + frameHeaderLength + frameSize;
    if (!Number.isSafeInteger(frameEnd) || frameEnd > end) return false;
    frameCount += 1;
    offset = frameEnd;
  }

  const hasFooter = majorVersion === 4 && (tagFlags & 0x10) !== 0;
  return frameCount > 0 && offset === end && !(hasFooter && sawPadding);
}

function id3PayloadOffset(buffer, strict = false) {
  if (buffer.length < 3 || buffer.toString('ascii', 0, 3) !== 'ID3') return 0;
  if (buffer.length < 10) return null;
  const majorVersion = buffer[3];
  const revision = buffer[4];
  const flags = buffer[5];
  if (strict) {
    const allowedFlags = new Map([[2, 0xc0], [3, 0xe0], [4, 0xf0]]);
    const allowedMask = allowedFlags.get(majorVersion);
    if (
      allowedMask === undefined ||
      revision === 0xff ||
      (flags & ~allowedMask) !== 0 ||
      (flags & 0x40) !== 0 ||
      (flags & ~0x10) !== 0
    ) {
      return null;
    }
  }
  const sizeBytes = buffer.subarray(6, 10);
  if ([...sizeBytes].some(byte => (byte & 0x80) !== 0)) return null;
  const payloadSize = (
    (sizeBytes[0] << 21) |
    (sizeBytes[1] << 14) |
    (sizeBytes[2] << 7) |
    sizeBytes[3]
  );
  const payloadEnd = 10 + payloadSize;
  const footerSize = (flags & 0x10) !== 0 ? 10 : 0;
  const offset = payloadEnd + footerSize;
  if (offset > buffer.length) return null;
  if (strict && !hasValidId3Frames(buffer, majorVersion, flags, 10, payloadEnd)) {
    return null;
  }
  return offset;
}

function aacPayloadOffset(buffer) {
  const offset = id3PayloadOffset(buffer, true);
  if (offset === null || buffer.toString('ascii', 0, 3) !== 'ID3') return offset;
  if ((buffer[5] & 0x10) === 0) return offset;
  if (buffer[3] !== 4) return null;

  const footerOffset = offset - 10;
  if (
    buffer.toString('ascii', footerOffset, footerOffset + 3) !== '3DI' ||
    !buffer.subarray(3, 10).equals(buffer.subarray(footerOffset + 3, footerOffset + 10))
  ) {
    return null;
  }
  return offset;
}

function validateMp3Buffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw articleAudioError(400, 'audio_content_invalid', 'MP3 文件内容无效');
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw articleAudioError(413, 'audio_asset_too_large', '单个 MP3 文件超过 20 MiB');
  }

  const start = id3PayloadOffset(buffer);
  if (start === null) {
    throw articleAudioError(400, 'audio_content_invalid', 'MP3 文件内容无效');
  }
  const scanEnd = Math.min(buffer.length - 4, start + MAX_FRAME_SCAN_BYTES);
  for (let offset = start; offset <= scanEnd; offset += 1) {
    const first = parseFrame(buffer, offset);
    if (!first) continue;
    const secondOffset = offset + first.frameLength;
    if (parseFrame(buffer, secondOffset)) return;
  }

  throw articleAudioError(400, 'audio_content_invalid', 'MP3 文件内容无效');
}

function validateAacBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw articleAudioError(400, 'audio_content_invalid', 'AAC 文件内容无效');
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw articleAudioError(413, 'audio_asset_too_large', '单个 AAC 文件超过 20 MiB');
  }

  let offset = aacPayloadOffset(buffer);
  if (offset === null) {
    throw articleAudioError(400, 'audio_content_invalid', 'AAC 文件内容无效');
  }

  let frameCount = 0;
  while (offset < buffer.length) {
    if (offset + 7 > buffer.length) {
      throw articleAudioError(400, 'audio_content_invalid', 'AAC 文件内容无效');
    }

    const protectionAbsent = (buffer[offset + 1] & 0x01) === 1;
    const headerLength = protectionAbsent ? 7 : 9;
    const profile = (buffer[offset + 2] >> 6) & 0x03;
    const frequencyIndex = (buffer[offset + 2] >> 2) & 0x0f;
    const channelConfiguration = (
      ((buffer[offset + 2] & 0x01) << 2) |
      ((buffer[offset + 3] >> 6) & 0x03)
    );
    const frameLength = (
      ((buffer[offset + 3] & 0x03) << 11) |
      (buffer[offset + 4] << 3) |
      (buffer[offset + 5] >> 5)
    );
    const rawDataBlocks = buffer[offset + 6] & 0x03;

    if (
      buffer[offset] !== 0xff ||
      (buffer[offset + 1] & 0xf0) !== 0xf0 ||
      ((buffer[offset + 1] >> 1) & 0x03) !== 0 ||
      profile !== 1 ||
      frequencyIndex > 12 ||
      channelConfiguration < 1 ||
      channelConfiguration > 7 ||
      rawDataBlocks !== 0 ||
      frameLength < headerLength ||
      offset + frameLength > buffer.length
    ) {
      throw articleAudioError(400, 'audio_content_invalid', 'AAC 文件内容无效');
    }

    offset += frameLength;
    frameCount += 1;
  }

  if (frameCount < 2 || offset !== buffer.length) {
    throw articleAudioError(400, 'audio_content_invalid', 'AAC 文件内容无效');
  }
}

function invalidM4a() {
  return articleAudioError(400, 'audio_content_invalid', 'M4A 文件内容无效');
}

// Only container layouts whose payload structure is defined here are traversed.
// Unknown boxes remain leaves instead of having arbitrary media payload guessed as boxes.
const M4A_CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta',
  'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi', 'wave', 'ilst'
]);
const M4A_AUDIO_SAMPLE_ENTRY_BOXES = new Set([
  'mp4a', 'alac', 'enca', '.mp3', 'mp3 '
]);

function parseBoxes(buffer, start, end, depth, state, topLevel = false) {
  if (depth > 8 || start < 0 || end > buffer.length || start > end) throw invalidM4a();
  const boxes = [];
  let offset = start;

  while (offset < end) {
    if (end - offset < 8) throw invalidM4a();
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;

    if (size32 === 1) {
      if (end - offset < 16) throw invalidM4a();
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidM4a();
      size = Number(largeSize);
      headerSize = 16;
    } else if (size32 === 0) {
      if (!topLevel || type !== 'mdat') throw invalidM4a();
      size = end - offset;
    }

    if (!Number.isSafeInteger(size) || size < headerSize) throw invalidM4a();
    const boxEnd = offset + size;
    if (!Number.isSafeInteger(boxEnd) || boxEnd > end) throw invalidM4a();

    state.count += 1;
    if (state.count > 4096) throw invalidM4a();
    boxes.push({
      type,
      start: offset,
      end: boxEnd,
      payloadStart: offset + headerSize,
      depth
    });
    offset = boxEnd;
  }

  if (offset !== end) throw invalidM4a();
  return boxes;
}

function scanM4aBoxRange(
  buffer,
  start,
  end,
  depth,
  state,
  { topLevel = false, parentType = null } = {}
) {
  if (start === end) return [];
  const boxes = parseBoxes(buffer, start, end, depth, state, topLevel);
  for (const box of boxes) scanM4aBoxChildren(buffer, box, state, parentType);
  return boxes;
}

function scanCountedFullBoxChildren(buffer, box, state) {
  if (box.end - box.payloadStart < 8) throw invalidM4a();
  const entryCount = buffer.readUInt32BE(box.payloadStart + 4);
  const children = scanM4aBoxRange(
    buffer,
    box.payloadStart + 8,
    box.end,
    box.depth + 1,
    state,
    { parentType: box.type }
  );
  if (children.length !== entryCount) throw invalidM4a();
}

function scanAudioSampleEntryChildren(buffer, box, state) {
  if (box.end - box.payloadStart < 28) throw invalidM4a();
  const version = buffer.readUInt16BE(box.payloadStart + 8);
  const childOffsetByVersion = new Map([[0, 28], [1, 44], [2, 64]]);
  const childOffset = childOffsetByVersion.get(version);
  if (childOffset === undefined || box.payloadStart + childOffset > box.end) {
    throw invalidM4a();
  }
  scanM4aBoxRange(
    buffer,
    box.payloadStart + childOffset,
    box.end,
    box.depth + 1,
    state,
    { parentType: box.type }
  );
}

function scanM4aBoxChildren(buffer, box, state, parentType) {
  if (parentType === 'ilst') {
    scanM4aBoxRange(
      buffer,
      box.payloadStart,
      box.end,
      box.depth + 1,
      state,
      { parentType: box.type }
    );
    return;
  }

  if (box.type === 'meta') {
    if (box.end - box.payloadStart < 4) throw invalidM4a();
    scanM4aBoxRange(
      buffer,
      box.payloadStart + 4,
      box.end,
      box.depth + 1,
      state,
      { parentType: box.type }
    );
    return;
  }

  if (box.type === 'stsd' || box.type === 'dref') {
    scanCountedFullBoxChildren(buffer, box, state);
    return;
  }

  if (M4A_AUDIO_SAMPLE_ENTRY_BOXES.has(box.type)) {
    scanAudioSampleEntryChildren(buffer, box, state);
    return;
  }

  if (M4A_CONTAINER_BOXES.has(box.type)) {
    scanM4aBoxRange(
      buffer,
      box.payloadStart,
      box.end,
      box.depth + 1,
      state,
      { parentType: box.type }
    );
  }
}

function parseDescriptor(buffer, offset, end) {
  if (offset + 2 > end) throw invalidM4a();
  const tag = buffer[offset];
  let cursor = offset + 1;
  let length = 0;
  let terminated = false;

  for (let index = 0; index < 4; index += 1) {
    if (cursor >= end) throw invalidM4a();
    const byte = buffer[cursor];
    cursor += 1;
    length = (length * 128) + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      terminated = true;
      break;
    }
  }

  if (!terminated || !Number.isSafeInteger(length)) throw invalidM4a();
  const descriptorEnd = cursor + length;
  if (!Number.isSafeInteger(descriptorEnd) || descriptorEnd > end) throw invalidM4a();
  return { tag, payloadStart: cursor, end: descriptorEnd };
}

function parseDescriptorList(buffer, start, end) {
  const descriptors = [];
  let offset = start;
  while (offset < end) {
    const descriptor = parseDescriptor(buffer, offset, end);
    descriptors.push(descriptor);
    offset = descriptor.end;
  }
  if (offset !== end) throw invalidM4a();
  return descriptors;
}

function createBitReader(buffer) {
  let bitOffset = 0;
  return {
    read(bitCount) {
      if (
        !Number.isInteger(bitCount) ||
        bitCount < 1 ||
        bitCount > 24 ||
        bitOffset + bitCount > buffer.length * 8
      ) {
        throw invalidM4a();
      }
      let value = 0;
      for (let index = 0; index < bitCount; index += 1) {
        const absoluteBit = bitOffset + index;
        const byte = buffer[Math.floor(absoluteBit / 8)];
        value = (value * 2) + ((byte >> (7 - (absoluteBit % 8))) & 0x01);
      }
      bitOffset += bitCount;
      return value;
    },
    remaining() {
      return (buffer.length * 8) - bitOffset;
    },
    hasCanonicalZeroPadding() {
      const expectedPaddingBits = (8 - (bitOffset % 8)) % 8;
      if ((buffer.length * 8) - bitOffset !== expectedPaddingBits) return false;
      if (expectedPaddingBits === 0) return true;
      const paddingMask = (1 << expectedPaddingBits) - 1;
      return (buffer[buffer.length - 1] & paddingMask) === 0;
    }
  };
}

function readAudioObjectType(reader) {
  const audioObjectType = reader.read(5);
  return audioObjectType === 31 ? 32 + reader.read(6) : audioObjectType;
}

function readSamplingFrequency(reader) {
  const frequencyIndex = reader.read(4);
  if (frequencyIndex === 15) {
    const explicitFrequency = reader.read(24);
    if (explicitFrequency === 0) throw invalidM4a();
    return;
  }
  if (frequencyIndex > 12) throw invalidM4a();
}

function isAacLcAudioSpecificConfig(buffer) {
  const reader = createBitReader(buffer);
  if (readAudioObjectType(reader) !== 2) return false;
  readSamplingFrequency(reader);
  const channelConfiguration = reader.read(4);
  if (channelConfiguration < 1 || channelConfiguration > 7) return false;

  // GASpecificConfig for AAC-LC. The frameLengthFlag is supported; unsupported
  // core-coder and extension payloads must still be structurally complete.
  reader.read(1);
  if (reader.read(1) === 1) reader.read(14);
  if (reader.read(1) === 1 && reader.read(1) !== 0) return false;

  if (reader.remaining() === 0) return true;
  if (reader.remaining() < 11) return reader.hasCanonicalZeroPadding();
  if (reader.read(11) !== 0x2b7) return false;
  if (readAudioObjectType(reader) !== 5) return false;
  if (reader.read(1) !== 0) return false;
  return reader.hasCanonicalZeroPadding();
}

function hasAacLcDecoderConfig(buffer, esdsBox) {
  if (
    esdsBox.end - esdsBox.payloadStart < 6 ||
    buffer.readUInt32BE(esdsBox.payloadStart) !== 0
  ) {
    throw invalidM4a();
  }
  const top = parseDescriptor(buffer, esdsBox.payloadStart + 4, esdsBox.end);
  if (top.tag !== 0x03 || top.end !== esdsBox.end || top.end - top.payloadStart < 3) {
    return false;
  }

  const flags = buffer[top.payloadStart + 2];
  let cursor = top.payloadStart + 3;
  if ((flags & 0x80) !== 0) cursor += 2;
  if ((flags & 0x40) !== 0) {
    if (cursor >= top.end) throw invalidM4a();
    const urlLength = buffer[cursor];
    cursor += 1 + urlLength;
  }
  if ((flags & 0x20) !== 0) cursor += 2;
  if (cursor > top.end) throw invalidM4a();

  const decoderConfigs = parseDescriptorList(buffer, cursor, top.end)
    .filter(descriptor => descriptor.tag === 0x04);
  if (decoderConfigs.length !== 1) return false;
  const decoderConfig = decoderConfigs[0];
  if (decoderConfig.end - decoderConfig.payloadStart < 13) return false;
  const streamTypeByte = buffer[decoderConfig.payloadStart + 1];
  if (
    buffer[decoderConfig.payloadStart] !== 0x40 ||
    ((streamTypeByte >> 2) & 0x3f) !== 0x05 ||
    (streamTypeByte & 0x01) !== 0x01
  ) {
    return false;
  }

  const decoderSpecificInfos = parseDescriptorList(
    buffer,
    decoderConfig.payloadStart + 13,
    decoderConfig.end
  ).filter(descriptor => descriptor.tag === 0x05);
  if (
    decoderSpecificInfos.length !== 1 ||
    decoderSpecificInfos[0].end - decoderSpecificInfos[0].payloadStart < 2
  ) {
    return false;
  }
  const decoderSpecificInfo = decoderSpecificInfos[0];
  return isAacLcAudioSpecificConfig(buffer.subarray(
    decoderSpecificInfo.payloadStart,
    decoderSpecificInfo.end
  ));
}

function isAacLcSampleEntry(buffer, sampleEntry, state) {
  if (sampleEntry.end - sampleEntry.payloadStart < 28) throw invalidM4a();
  const version = buffer.readUInt16BE(sampleEntry.payloadStart + 8);
  const childOffsetByVersion = new Map([[0, 28], [1, 44], [2, 64]]);
  const childOffset = childOffsetByVersion.get(version);
  if (childOffset === undefined || sampleEntry.payloadStart + childOffset > sampleEntry.end) {
    return false;
  }

  const children = parseBoxes(
    buffer,
    sampleEntry.payloadStart + childOffset,
    sampleEntry.end,
    sampleEntry.depth + 1,
    state
  );
  if (children.some(child => M4A_CONTAINER_BOXES.has(child.type))) return false;
  const elementaryStreamDescriptors = children.filter(child => child.type === 'esds');
  return (
    elementaryStreamDescriptors.length === 1 &&
    hasAacLcDecoderConfig(buffer, elementaryStreamDescriptors[0])
  );
}

function stsdHasOnlyAacLc(buffer, stsdBox, state) {
  if (stsdBox.end - stsdBox.payloadStart < 8) throw invalidM4a();
  const entryCount = buffer.readUInt32BE(stsdBox.payloadStart + 4);
  const entries = parseBoxes(
    buffer,
    stsdBox.payloadStart + 8,
    stsdBox.end,
    stsdBox.depth + 1,
    state
  );
  if (entries.length !== entryCount) throw invalidM4a();
  return entries.length > 0 && entries.every(entry => (
    entry.type === 'mp4a' && isAacLcSampleEntry(buffer, entry, state)
  ));
}

function mdiaHasOnlyAacLc(buffer, mdiaBox, state) {
  const mdiaChildren = parseBoxes(
    buffer,
    mdiaBox.payloadStart,
    mdiaBox.end,
    mdiaBox.depth + 1,
    state
  );
  const handlers = mdiaChildren.filter(child => child.type === 'hdlr');
  if (
    handlers.length !== 1 ||
    handlers[0].end - handlers[0].payloadStart < 12 ||
    buffer.toString(
      'ascii',
      handlers[0].payloadStart + 8,
      handlers[0].payloadStart + 12
    ) !== 'soun'
  ) {
    return false;
  }

  const sampleDescriptions = [];
  for (const minf of mdiaChildren.filter(child => child.type === 'minf')) {
    const minfChildren = parseBoxes(
      buffer,
      minf.payloadStart,
      minf.end,
      minf.depth + 1,
      state
    );
    for (const stbl of minfChildren.filter(child => child.type === 'stbl')) {
      const stblChildren = parseBoxes(
        buffer,
        stbl.payloadStart,
        stbl.end,
        stbl.depth + 1,
        state
      );
      for (const stsd of stblChildren.filter(child => child.type === 'stsd')) {
        sampleDescriptions.push(stsd);
      }
    }
  }
  return (
    sampleDescriptions.length > 0 &&
    sampleDescriptions.every(stsd => stsdHasOnlyAacLc(buffer, stsd, state))
  );
}

function inspectMoovAudio(buffer, moovBox, state) {
  const moovChildren = parseBoxes(
    buffer,
    moovBox.payloadStart,
    moovBox.end,
    moovBox.depth + 1,
    state
  );
  let trackCount = 0;
  let allTracksSupported = true;
  for (const trak of moovChildren.filter(child => child.type === 'trak')) {
    trackCount += 1;
    const trackChildren = parseBoxes(
      buffer,
      trak.payloadStart,
      trak.end,
      trak.depth + 1,
      state
    );
    const mediaBoxes = trackChildren.filter(child => child.type === 'mdia');
    if (
      mediaBoxes.length !== 1 ||
      !mdiaHasOnlyAacLc(buffer, mediaBoxes[0], state)
    ) {
      allTracksSupported = false;
    }
  }
  return { trackCount, allTracksSupported };
}

function hasSupportedFtyp(buffer, ftypBox) {
  const payloadLength = ftypBox.end - ftypBox.payloadStart;
  if (payloadLength < 8 || (payloadLength - 8) % 4 !== 0) throw invalidM4a();
  const brands = [buffer.toString('ascii', ftypBox.payloadStart, ftypBox.payloadStart + 4)];
  for (let offset = ftypBox.payloadStart + 8; offset < ftypBox.end; offset += 4) {
    brands.push(buffer.toString('ascii', offset, offset + 4));
  }
  const supportedBrands = new Set(['M4A ', 'isom', 'iso2', 'mp41', 'mp42']);
  return brands.some(brand => supportedBrands.has(brand));
}

function validateM4aBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalidM4a();
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw articleAudioError(413, 'audio_asset_too_large', '单个 M4A 文件超过 20 MiB');
  }

  const topLevel = scanM4aBoxRange(
    buffer,
    0,
    buffer.length,
    0,
    { count: 0 },
    { topLevel: true }
  );
  const state = { count: 0 };
  const ftypBoxes = topLevel.filter(box => box.type === 'ftyp');
  const moovBoxes = topLevel.filter(box => box.type === 'moov');
  const mdatBoxes = topLevel.filter(box => box.type === 'mdat');
  let trackCount = 0;
  let allTracksSupported = true;
  for (const moov of moovBoxes) {
    const audio = inspectMoovAudio(buffer, moov, state);
    trackCount += audio.trackCount;
    if (!audio.allTracksSupported) allTracksSupported = false;
  }
  if (
    ftypBoxes.length !== 1 ||
    moovBoxes.length === 0 ||
    mdatBoxes.length === 0 ||
    !hasSupportedFtyp(buffer, ftypBoxes[0]) ||
    trackCount === 0 ||
    !allTracksSupported
  ) {
    throw invalidM4a();
  }
}

function invalidFlac() {
  return articleAudioError(400, 'audio_content_invalid', 'FLAC 文件内容无效');
}

function validateStreamInfo(buffer, offset) {
  const minimumBlockSize = buffer.readUInt16BE(offset);
  const maximumBlockSize = buffer.readUInt16BE(offset + 2);
  const minimumFrameSize = buffer.readUIntBE(offset + 4, 3);
  const maximumFrameSize = buffer.readUIntBE(offset + 7, 3);
  const packed = buffer.readBigUInt64BE(offset + 10);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x07n) + 1;
  const bitsPerSample = Number((packed >> 36n) & 0x1fn) + 1;

  if (
    minimumBlockSize < 16 ||
    maximumBlockSize < 16 ||
    minimumBlockSize > maximumBlockSize ||
    (minimumFrameSize !== 0 && maximumFrameSize !== 0 && minimumFrameSize > maximumFrameSize) ||
    sampleRate < 1 ||
    sampleRate > 655350 ||
    channels < 1 ||
    channels > 8 ||
    bitsPerSample < 4 ||
    bitsPerSample > 32
  ) {
    throw invalidFlac();
  }

  return {
    minimumBlockSize,
    maximumBlockSize,
    sampleRate,
    channels,
    bitsPerSample
  };
}

function parseFlacUtf8Number(buffer, offset) {
  if (offset >= buffer.length) throw invalidFlac();
  const first = buffer[offset];
  if (first <= 0x7f) return { offset: offset + 1, value: BigInt(first) };

  let length = 0;
  for (let mask = 0x80; (first & mask) !== 0; mask >>= 1) length += 1;
  if (length < 2 || length > 7 || offset + length > buffer.length) throw invalidFlac();

  const firstPayloadBits = 7 - length;
  const firstMask = firstPayloadBits === 0 ? 0 : (1 << firstPayloadBits) - 1;
  let value = BigInt(first & firstMask);
  for (let index = 1; index < length; index += 1) {
    const byte = buffer[offset + index];
    if ((byte & 0xc0) !== 0x80) throw invalidFlac();
    value = (value << 6n) | BigInt(byte & 0x3f);
  }

  const minimumValues = [0n, 0n, 0x80n, 0x800n, 0x10000n, 0x200000n, 0x4000000n, 0x80000000n];
  if (value < minimumValues[length] || value >= (1n << 36n)) throw invalidFlac();
  return { offset: offset + length, value };
}

function flacCrc8(buffer, start, end) {
  let crc = 0;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= buffer[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function validateFlacFrameHeader(buffer, frameOffset, streamInfo) {
  if (
    frameOffset + 6 >= buffer.length ||
    buffer[frameOffset] !== 0xff ||
    (buffer[frameOffset + 1] & 0xfe) !== 0xf8
  ) {
    throw invalidFlac();
  }

  const blockSizeCode = buffer[frameOffset + 2] >> 4;
  const sampleRateCode = buffer[frameOffset + 2] & 0x0f;
  const channelAssignment = buffer[frameOffset + 3] >> 4;
  const sampleSizeCode = (buffer[frameOffset + 3] >> 1) & 0x07;
  if (
    blockSizeCode === 0 ||
    sampleRateCode === 15 ||
    channelAssignment > 10 ||
    sampleSizeCode === 3 ||
    sampleSizeCode === 7 ||
    (buffer[frameOffset + 3] & 0x01) !== 0
  ) {
    throw invalidFlac();
  }

  const independentChannels = channelAssignment <= 7 ? channelAssignment + 1 : 2;
  if (independentChannels !== streamInfo.channels) throw invalidFlac();
  const sampleSizes = new Map([[0, streamInfo.bitsPerSample], [1, 8], [2, 12], [4, 16], [5, 20], [6, 24]]);
  if (sampleSizes.get(sampleSizeCode) !== streamInfo.bitsPerSample) throw invalidFlac();

  const blockingStrategy = buffer[frameOffset + 1] & 0x01;
  const frameOrSampleNumber = parseFlacUtf8Number(buffer, frameOffset + 4);
  if (blockingStrategy === 0 && frameOrSampleNumber.value > 0x7fffffffn) throw invalidFlac();
  let cursor = frameOrSampleNumber.offset;
  let blockSize;
  if (blockSizeCode === 1) blockSize = 192;
  else if (blockSizeCode >= 2 && blockSizeCode <= 5) blockSize = 576 << (blockSizeCode - 2);
  else if (blockSizeCode === 6) {
    if (cursor >= buffer.length) throw invalidFlac();
    blockSize = buffer[cursor] + 1;
    cursor += 1;
  } else if (blockSizeCode === 7) {
    if (cursor + 2 > buffer.length) throw invalidFlac();
    blockSize = buffer.readUInt16BE(cursor) + 1;
    cursor += 2;
  } else {
    blockSize = 256 << (blockSizeCode - 8);
  }
  if (blockSize < streamInfo.minimumBlockSize || blockSize > streamInfo.maximumBlockSize) {
    throw invalidFlac();
  }

  const fixedSampleRates = new Map([
    [0, streamInfo.sampleRate], [1, 88200], [2, 176400], [3, 192000],
    [4, 8000], [5, 16000], [6, 22050], [7, 24000], [8, 32000],
    [9, 44100], [10, 48000], [11, 96000]
  ]);
  let sampleRate = fixedSampleRates.get(sampleRateCode);
  if (sampleRateCode === 12) {
    if (cursor >= buffer.length) throw invalidFlac();
    sampleRate = buffer[cursor] * 1000;
    cursor += 1;
  } else if (sampleRateCode === 13 || sampleRateCode === 14) {
    if (cursor + 2 > buffer.length) throw invalidFlac();
    sampleRate = buffer.readUInt16BE(cursor) * (sampleRateCode === 14 ? 10 : 1);
    cursor += 2;
  }
  if (sampleRate !== streamInfo.sampleRate || sampleRate < 1 || sampleRate > 655350) {
    throw invalidFlac();
  }

  if (cursor + 1 >= buffer.length || flacCrc8(buffer, frameOffset, cursor) !== buffer[cursor]) {
    throw invalidFlac();
  }
}

function validateFlacBuffer(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    buffer.length < 4 ||
    buffer.toString('ascii', 0, 4) !== 'fLaC'
  ) {
    throw invalidFlac();
  }
  if (buffer.length > MAX_FLAC_AUDIO_BYTES) {
    throw articleAudioError(413, 'audio_asset_too_large', '单个 FLAC 文件超过 50 MiB');
  }

  let offset = 4;
  let lastMetadata = false;
  let streamInfo = null;
  let metadataIndex = 0;
  while (!lastMetadata) {
    if (offset + 4 > buffer.length) throw invalidFlac();
    lastMetadata = (buffer[offset] & 0x80) !== 0;
    const type = buffer[offset] & 0x7f;
    const length = buffer.readUIntBE(offset + 1, 3);
    const payloadStart = offset + 4;
    const metadataEnd = payloadStart + length;
    if (type === 127 || metadataEnd > buffer.length) throw invalidFlac();
    if (metadataIndex === 0 && (type !== 0 || length !== 34)) throw invalidFlac();
    if (type === 0) {
      if (streamInfo !== null || length !== 34) throw invalidFlac();
      streamInfo = validateStreamInfo(buffer, payloadStart);
    }
    offset = metadataEnd;
    metadataIndex += 1;
  }

  if (streamInfo === null || offset >= buffer.length) throw invalidFlac();
  validateFlacFrameHeader(buffer, offset, streamInfo);
}

const AUDIO_FORMATS = Object.freeze({
  '.mp3': Object.freeze({
    extension: '.mp3',
    mimeType: 'audio/mpeg',
    maxBytes: MAX_AUDIO_BYTES,
    validate: validateMp3Buffer
  }),
  '.aac': Object.freeze({
    extension: '.aac',
    mimeType: 'audio/aac',
    maxBytes: MAX_AUDIO_BYTES,
    validate: validateAacBuffer
  }),
  '.m4a': Object.freeze({
    extension: '.m4a',
    mimeType: 'audio/mp4',
    maxBytes: MAX_AUDIO_BYTES,
    validate: validateM4aBuffer
  }),
  '.flac': Object.freeze({
    extension: '.flac',
    mimeType: 'audio/flac',
    maxBytes: MAX_FLAC_AUDIO_BYTES,
    validate: validateFlacBuffer
  })
});

module.exports = {
  AUDIO_FORMATS,
  MAX_AUDIO_BYTES,
  MAX_FLAC_AUDIO_BYTES,
  validateAacBuffer,
  validateFlacBuffer,
  validateM4aBuffer,
  validateMp3Buffer
};
