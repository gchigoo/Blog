function mpeg1Layer3Frame(fill = 0) {
  const frame = Buffer.alloc(417, fill);
  frame.set([0xff, 0xfb, 0x90, 0x64], 0);
  return frame;
}

function validMp3() {
  return Buffer.concat([mpeg1Layer3Frame(1), mpeg1Layer3Frame(2)]);
}

function adtsFrame({
  payload = Buffer.from([1, 2, 3, 4]),
  protectionAbsent = true,
  profile = 1,
  frequencyIndex = 4,
  channelConfiguration = 2,
  rawDataBlocks = 0
} = {}) {
  const headerLength = protectionAbsent ? 7 : 9;
  const frameLength = headerLength + payload.length;
  const header = Buffer.alloc(headerLength);
  header[0] = 0xff;
  header[1] = protectionAbsent ? 0xf1 : 0xf0;
  header[2] = (
    (profile << 6) |
    (frequencyIndex << 2) |
    ((channelConfiguration >> 2) & 0x01)
  );
  header[3] = ((channelConfiguration & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc | rawDataBlocks;
  return Buffer.concat([header, payload]);
}

function validAac() {
  return Buffer.concat([
    adtsFrame({ payload: Buffer.from([1, 1, 1, 1]) }),
    adtsFrame({ payload: Buffer.from([2, 2, 2, 2]) })
  ]);
}

function box(type, payload, { extendedSize = false, sizeZero = false } = {}) {
  if (sizeZero) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, payload]);
  }
  if (extendedSize) {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write(type, 4, 4, 'ascii');
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function descriptor(tag, payload) {
  if (payload.length >= 128) throw new RangeError('fixture descriptor payload is too large');
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}

function validM4a({
  audioObjectType = 2,
  compatibleBrand = 'isom',
  extendedFtyp = false,
  handlerType = 'soun',
  majorBrand = 'M4A ',
  objectTypeIndication = 0x40,
  sizeZeroMdat = false,
  streamType = 0x05
} = {}) {
  const audioSpecificConfig = Buffer.from([
    (audioObjectType << 3) | 0x02,
    0x10
  ]);
  const decoderSpecificInfo = descriptor(0x05, audioSpecificConfig);
  const decoderConfig = descriptor(0x04, Buffer.concat([
    Buffer.from([objectTypeIndication, (streamType << 2) | 0x01, 0, 0, 0]),
    Buffer.alloc(8),
    decoderSpecificInfo
  ]));
  const esDescriptor = descriptor(0x03, Buffer.concat([
    Buffer.from([0, 1, 0]),
    decoderConfig
  ]));
  const esds = box('esds', Buffer.concat([Buffer.alloc(4), esDescriptor]));

  const audioSampleEntry = Buffer.alloc(28);
  audioSampleEntry.writeUInt16BE(1, 6);
  audioSampleEntry.writeUInt16BE(2, 16);
  audioSampleEntry.writeUInt16BE(16, 18);
  audioSampleEntry.writeUInt32BE(44100 * 65536, 24);
  const mp4a = box('mp4a', Buffer.concat([audioSampleEntry, esds]));

  const stsdHeader = Buffer.alloc(8);
  stsdHeader.writeUInt32BE(1, 4);
  const stsd = box('stsd', Buffer.concat([stsdHeader, mp4a]));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write(handlerType, 8, 4, 'ascii');
  const hdlr = box('hdlr', hdlrPayload);
  const mdia = box('mdia', Buffer.concat([hdlr, minf]));
  const moov = box('moov', box('trak', mdia));
  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from(majorBrand, 'ascii'),
    Buffer.alloc(4),
    Buffer.from(compatibleBrand, 'ascii')
  ]), { extendedSize: extendedFtyp });
  const mdat = box('mdat', Buffer.from([1, 2, 3, 4]), { sizeZero: sizeZeroMdat });
  return Buffer.concat([ftyp, moov, mdat]);
}

function flacCrc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function sevenByteFlacNumber(value) {
  const encoded = Buffer.alloc(7);
  encoded[0] = 0xfe;
  for (let index = 0; index < 6; index += 1) {
    const shift = BigInt((5 - index) * 6);
    encoded[index + 1] = 0x80 | Number((value >> shift) & 0x3fn);
  }
  return encoded;
}

function validFlac({
  blockSizeCode = 8,
  blockingStrategy = 0,
  frameOrSampleNumber = Buffer.from([0]),
  optionalHeaderFields = Buffer.alloc(0),
  payload = Buffer.from([0]),
  sampleRateCode = 9
} = {}) {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(256, 0);
  streamInfo.writeUInt16BE(256, 2);
  streamInfo.writeBigUInt64BE(
    (44100n << 44n) | (1n << 41n) | (15n << 36n) | 256n,
    10
  );
  const metadataHeader = Buffer.from([0x80, 0x00, 0x00, 0x22]);
  const frameHeaderWithoutCrc = Buffer.concat([
    Buffer.from([
      0xff,
      0xf8 | blockingStrategy,
      (blockSizeCode << 4) | sampleRateCode,
      0x18
    ]),
    frameOrSampleNumber,
    optionalHeaderFields
  ]);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    metadataHeader,
    streamInfo,
    frameHeaderWithoutCrc,
    Buffer.from([flacCrc8(frameHeaderWithoutCrc)]),
    payload
  ]);
}

module.exports = {
  adtsFrame,
  box,
  flacCrc8,
  mpeg1Layer3Frame,
  sevenByteFlacNumber,
  validAac,
  validFlac,
  validM4a,
  validMp3
};
