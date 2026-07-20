const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateAacBuffer,
  validateFlacBuffer,
  validateM4aBuffer,
  validateMp3Buffer
} = require('../server/article-audio/formats');

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
  const packedStreamInfo = (
    (44100n << 44n) |
    (1n << 41n) |
    (15n << 36n) |
    256n
  );
  streamInfo.writeBigUInt64BE(packedStreamInfo, 10);

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
  const frameHeader = Buffer.concat([
    frameHeaderWithoutCrc,
    Buffer.from([flacCrc8(frameHeaderWithoutCrc)])
  ]);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    metadataHeader,
    streamInfo,
    frameHeader,
    payload
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
  assert.ok(payload.length < 128);
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}

function bitsToBuffer(bits) {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from(padded.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
}

function aacAudioSpecificConfig(audioObjectType = 2) {
  return Buffer.from([(audioObjectType << 3) | 0x02, 0x10]);
}

function decoderConfigDescriptor({
  audioSpecificConfigs = [aacAudioSpecificConfig()],
  objectTypeIndication = 0x40,
  streamType = 0x05
} = {}) {
  return descriptor(0x04, Buffer.concat([
    Buffer.from([objectTypeIndication, (streamType << 2) | 0x01, 0, 0, 0]),
    Buffer.alloc(8),
    ...audioSpecificConfigs.map(config => descriptor(0x05, config))
  ]));
}

function esdsBox({
  decoderConfigs = [decoderConfigDescriptor()],
  versionFlags = 0
} = {}) {
  const esDescriptor = descriptor(0x03, Buffer.concat([
    Buffer.from([0, 1, 0]),
    ...decoderConfigs
  ]));
  const fullBox = Buffer.alloc(4);
  fullBox.writeUInt32BE(versionFlags, 0);
  return box('esds', Buffer.concat([fullBox, esDescriptor]));
}

function audioSampleEntry(type, children = Buffer.alloc(0), version = 0) {
  const headerLengthByVersion = new Map([[0, 28], [1, 44], [2, 64]]);
  const headerLength = headerLengthByVersion.get(version);
  assert.notEqual(headerLength, undefined);
  const header = Buffer.alloc(headerLength);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(version, 8);
  return box(type, Buffer.concat([header, children]));
}

function sampleDescription(entries) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(entries.length, 4);
  return box('stsd', Buffer.concat([header, ...entries]));
}

function handlerBox(type) {
  const payload = Buffer.alloc(24);
  payload.write(type, 8, 4, 'ascii');
  return box('hdlr', payload);
}

function mediaBox({ handlerTypes = ['vide'], sampleEntries = [] } = {}) {
  const handlers = handlerTypes.map(handlerBox);
  const stbl = box('stbl', sampleDescription(sampleEntries));
  return box('mdia', Buffer.concat([...handlers, box('minf', stbl)]));
}

function trackBox(mediaBoxes) {
  return box('trak', Buffer.concat(mediaBoxes));
}

function validM4a({
  additionalHandlers = [],
  additionalMdias = [],
  additionalMp4aChildren = [],
  additionalSampleEntries = [],
  additionalTracks = [],
  additionalEsds = [],
  audioSpecificConfig = null,
  audioObjectType = 2,
  compatibleBrand = 'isom',
  decoderConfigs = null,
  esdsVersionFlags = 0,
  extendedFtyp = false,
  handlerType = 'soun',
  includeDirectEsds = true,
  majorBrand = 'M4A ',
  objectTypeIndication = 0x40,
  sizeZeroMdat = false,
  streamType = 0x05
} = {}) {
  const effectiveDecoderConfigs = decoderConfigs || [decoderConfigDescriptor({
    audioSpecificConfigs: [audioSpecificConfig || aacAudioSpecificConfig(audioObjectType)],
    objectTypeIndication,
    streamType
  })];
  const esds = esdsBox({
    decoderConfigs: effectiveDecoderConfigs,
    versionFlags: esdsVersionFlags
  });

  const audioSampleEntry = Buffer.alloc(28);
  audioSampleEntry.writeUInt16BE(1, 6);
  audioSampleEntry.writeUInt16BE(2, 16);
  audioSampleEntry.writeUInt16BE(16, 18);
  audioSampleEntry.writeUInt32BE(44100 * 65536, 24);
  const mp4a = box('mp4a', Buffer.concat([
    audioSampleEntry,
    ...(includeDirectEsds ? [esds] : []),
    ...additionalEsds,
    ...additionalMp4aChildren
  ]));

  const stsd = sampleDescription([mp4a, ...additionalSampleEntries]);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);

  const handlers = [handlerType, ...additionalHandlers].map(handlerBox);
  const mdia = box('mdia', Buffer.concat([...handlers, minf]));
  const trak = box('trak', Buffer.concat([mdia, ...additionalMdias]));
  const moov = box('moov', Buffer.concat([trak, ...additionalTracks]));
  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from(majorBrand, 'ascii'),
    Buffer.alloc(4),
    Buffer.from(compatibleBrand, 'ascii')
  ]), { extendedSize: extendedFtyp });
  const mdat = box('mdat', Buffer.from([1, 2, 3, 4]), { sizeZero: sizeZeroMdat });
  return Buffer.concat([ftyp, moov, mdat]);
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

function synchsafe32(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ]);
}

function id3Header(version, revision = 0, flags = 0, payloadSize = 0) {
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, revision, flags]),
    synchsafe32(payloadSize)
  ]);
}

function id3Frame(version, {
  data = Buffer.from([0x00, 0x41]),
  declaredSize = data.length,
  id = version === 2 ? 'TT2' : 'TIT2',
  flags = 0
} = {}) {
  if (version === 2) {
    const header = Buffer.alloc(6);
    header.write(id, 0, 3, 'ascii');
    header.writeUIntBE(declaredSize, 3, 3);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  if (version === 4) synchsafe32(declaredSize).copy(header, 4);
  else header.writeUInt32BE(declaredSize, 4);
  header.writeUInt16BE(flags, 8);
  return Buffer.concat([header, data]);
}

function id3Tag(version, {
  footer = false,
  payload = id3Frame(version)
} = {}) {
  const flags = footer ? 0x10 : 0;
  const header = id3Header(version, 0, flags, payload.length);
  if (!footer) return Buffer.concat([header, payload]);
  const footerBytes = Buffer.concat([Buffer.from('3DI', 'ascii'), header.subarray(3)]);
  return Buffer.concat([header, payload, footerBytes]);
}

test('accepts contiguous AAC-LC ADTS frames with optional ID3 and CRC headers', () => {
  const sevenByteHeaders = Buffer.concat([adtsFrame(), adtsFrame()]);
  const nineByteHeaders = Buffer.concat([
    adtsFrame({ protectionAbsent: false }),
    adtsFrame({ protectionAbsent: false })
  ]);
  const id3WithFooter = id3Tag(4, { footer: true });

  assert.doesNotThrow(() => validateAacBuffer(sevenByteHeaders));
  assert.doesNotThrow(() => validateAacBuffer(nineByteHeaders));
  for (const version of [2, 3, 4]) {
    assert.doesNotThrow(() => validateAacBuffer(Buffer.concat([
      id3Tag(version),
      sevenByteHeaders
    ])));
  }
  assert.doesNotThrow(() => validateAacBuffer(Buffer.concat([id3WithFooter, sevenByteHeaders])));
});

test('rejects malformed, unsupported, incomplete, or non-contiguous ADTS streams', () => {
  const valid = Buffer.concat([adtsFrame(), adtsFrame()]);
  const malformedFooter = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x10, 0, 0, 0, 0,
    0x00, 0x00, 0x00, 0x04, 0x00, 0x10, 0, 0, 0, 0
  ]);
  const invalidId3Headers = [
    id3Header(2),
    id3Header(3),
    id3Header(4),
    id3Header(0),
    id3Header(1),
    id3Header(0xff),
    id3Header(4, 0xff),
    id3Header(2, 0, 0x01),
    id3Header(3, 0, 0x01),
    id3Header(4, 0, 0x0f),
    id3Header(2, 0, 0x40),
    id3Header(3, 0, 0x40),
    id3Header(4, 0, 0x40)
  ].map(header => Buffer.concat([header, valid]));
  const invalidId3Payloads = [
    id3Tag(2, { payload: Buffer.alloc(4) }),
    id3Tag(3, { payload: Buffer.alloc(4) }),
    id3Tag(4, { payload: Buffer.alloc(4) }),
    id3Tag(4, { payload: Buffer.from('TIT2', 'ascii') }),
    id3Tag(4, { payload: id3Frame(4, { id: 'bad!' }) }),
    id3Tag(4, { payload: id3Frame(4, { data: Buffer.alloc(0), declaredSize: 0 }) }),
    id3Tag(4, { payload: id3Frame(4, { declaredSize: 3 }) }),
    id3Tag(4, {
      footer: true,
      payload: Buffer.concat([id3Frame(4), Buffer.alloc(4)])
    })
  ].map(tag => Buffer.concat([tag, valid]));

  for (const invalid of [
    Buffer.alloc(0),
    adtsFrame(),
    Buffer.concat([Buffer.from([0]), valid]),
    Buffer.concat([adtsFrame({ profile: 0 }), adtsFrame()]),
    Buffer.concat([adtsFrame({ frequencyIndex: 13 }), adtsFrame()]),
    Buffer.concat([adtsFrame({ channelConfiguration: 0 }), adtsFrame()]),
    Buffer.concat([adtsFrame({ rawDataBlocks: 1 }), adtsFrame()]),
    Buffer.concat([valid, Buffer.from([0])]),
    valid.subarray(0, valid.length - 1),
    Buffer.concat([malformedFooter, valid]),
    ...invalidId3Headers,
    ...invalidId3Payloads
  ]) {
    assert.throws(
      () => validateAacBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('keeps the MP3 validator public through the format seam', () => {
  assert.equal(typeof validateMp3Buffer, 'function');
});

test('accepts a bounded AAC-LC M4A track with matching descriptors', () => {
  assert.doesNotThrow(() => validateM4aBuffer(validM4a()));
  assert.doesNotThrow(() => validateM4aBuffer(validM4a({
    extendedFtyp: true,
    sizeZeroMdat: true
  })));
  assert.doesNotThrow(() => validateM4aBuffer(fs.readFileSync(path.join(
    __dirname,
    'fixtures',
    'article-audio',
    'tone.m4a'
  ))));
});

test('rejects implicit HE-AAC, truncated ASC, and ambiguous M4A descriptors', () => {
  const aacLc = aacAudioSpecificConfig(2);
  const heAac = aacAudioSpecificConfig(5);
  const implicitHeAac = Buffer.from([0x13, 0x90, 0x56, 0xe5, 0xa0]);
  const implicitParametricStereo = bitsToBuffer(
    `0001001000010000${(0x2b7).toString(2).padStart(11, '0')}001010` +
    `${(0x548).toString(2).padStart(11, '0')}1`
  );
  const truncatedExplicitFrequency = Buffer.from([0x17, 0x90]);
  const extraZeroByte = Buffer.concat([aacLc, Buffer.from([0])]);
  const oversizedZeroPadding = Buffer.concat([
    Buffer.from('120856e500', 'hex'),
    Buffer.alloc(64)
  ]);
  const lcDecoderConfig = decoderConfigDescriptor({ audioSpecificConfigs: [aacLc] });
  const heDecoderConfig = decoderConfigDescriptor({ audioSpecificConfigs: [heAac] });

  for (const invalid of [
    validM4a({ audioSpecificConfig: implicitHeAac }),
    validM4a({ audioSpecificConfig: implicitParametricStereo }),
    validM4a({ audioSpecificConfig: truncatedExplicitFrequency }),
    validM4a({ audioSpecificConfig: extraZeroByte }),
    validM4a({ audioSpecificConfig: oversizedZeroPadding }),
    validM4a({ esdsVersionFlags: 1 }),
    validM4a({ additionalEsds: [esdsBox({ decoderConfigs: [heDecoderConfig] })] }),
    validM4a({
      audioSpecificConfig: heAac,
      additionalEsds: [esdsBox({ decoderConfigs: [lcDecoderConfig] })]
    }),
    validM4a({ decoderConfigs: [lcDecoderConfig, heDecoderConfig] }),
    validM4a({
      decoderConfigs: [decoderConfigDescriptor({
        audioSpecificConfigs: [aacLc, heAac]
      })]
    })
  ]) {
    assert.throws(
      () => validateM4aBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('rejects nested or duplicate codec configuration containers inside mp4a', () => {
  const lcEsds = esdsBox({
    decoderConfigs: [decoderConfigDescriptor({
      audioSpecificConfigs: [aacAudioSpecificConfig(2)]
    })]
  });
  const heEsds = esdsBox({
    decoderConfigs: [decoderConfigDescriptor({
      audioSpecificConfigs: [aacAudioSpecificConfig(5)]
    })]
  });

  for (const invalid of [
    validM4a({ additionalMp4aChildren: [box('wave', heEsds)] }),
    validM4a({ additionalMp4aChildren: [box('wave', lcEsds)] }),
    validM4a({
      additionalMp4aChildren: [box('wave', box('wave', heEsds))]
    }),
    validM4a({
      includeDirectEsds: false,
      additionalMp4aChildren: [box('wave', lcEsds)]
    })
  ]) {
    assert.throws(
      () => validateM4aBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('rejects AAC-LC M4A files whose audio sample descriptions include unsupported codecs', () => {
  for (const type of ['alac', 'enca', '.mp3']) {
    assert.throws(
      () => validateM4aBuffer(validM4a({
        additionalSampleEntries: [audioSampleEntry(type)]
      })),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }

  const mixedAacAlac = fs.readFileSync(path.join(
    __dirname,
    'fixtures',
    'article-audio',
    'mixed-aac-alac.m4a'
  ));
  assert.throws(
    () => validateM4aBuffer(mixedAacAlac),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
});

test('rejects M4A containers containing video, text, unknown, or ambiguous tracks', () => {
  const visualSampleEntry = box('avc1', Buffer.alloc(78));
  const videoMedia = mediaBox({ sampleEntries: [visualSampleEntry] });
  const textMedia = mediaBox({ handlerTypes: ['text'] });
  const unknownMedia = mediaBox({ handlerTypes: ['zzzz'] });
  const missingHandlerMedia = mediaBox({ handlerTypes: [] });

  for (const invalid of [
    fs.readFileSync(path.join(
      __dirname,
      'fixtures',
      'article-audio',
      'mixed-aac-h264.m4a'
    )),
    validM4a({ additionalTracks: [trackBox([videoMedia])] }),
    validM4a({ additionalTracks: [trackBox([textMedia])] }),
    validM4a({ additionalTracks: [trackBox([unknownMedia])] }),
    validM4a({ additionalTracks: [trackBox([missingHandlerMedia])] }),
    validM4a({ additionalTracks: [box('trak', Buffer.alloc(0))] }),
    validM4a({ additionalHandlers: ['vide'] }),
    validM4a({ additionalMdias: [videoMedia] })
  ]) {
    assert.throws(
      () => validateM4aBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('enforces M4A count and depth limits inside known unsupported audio sample entries', () => {
  const unsupportedWithTooManyBoxes = audioSampleEntry(
    'enca',
    Buffer.concat(Array.from({ length: 4097 }, () => box('free', Buffer.alloc(0))))
  );
  let nestedPayload = Buffer.alloc(0);
  for (let index = 0; index < 9; index += 1) nestedPayload = box('udta', nestedPayload);
  const unsupportedTooDeep = audioSampleEntry('alac', nestedPayload);

  for (const unsupportedEntry of [unsupportedWithTooManyBoxes, unsupportedTooDeep]) {
    const outOfBandSampleDescription = sampleDescription([unsupportedEntry]);
    assert.throws(
      () => validateM4aBuffer(Buffer.concat([validM4a(), outOfBandSampleDescription])),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('enforces the M4A global count limit inside udta/meta containers', () => {
  const nestedMetadata = count => box('moov', box('udta', box('meta', Buffer.concat([
    Buffer.alloc(4),
    ...Array.from({ length: count }, () => box('free', Buffer.alloc(0)))
  ]))));
  const exactLimit = Buffer.concat([validM4a(), nestedMetadata(4082)]);
  const overLimit = Buffer.concat([validM4a(), nestedMetadata(4083)]);

  assert.doesNotThrow(() => validateM4aBuffer(exactLimit));
  assert.throws(
    () => validateM4aBuffer(overLimit),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
});

test('enforces the M4A depth limit inside nested known containers', () => {
  function nestedUdta(depth) {
    let payload = Buffer.alloc(0);
    for (let index = 0; index < depth; index += 1) payload = box('udta', payload);
    return Buffer.concat([validM4a(), box('moov', payload)]);
  }

  assert.doesNotThrow(() => validateM4aBuffer(nestedUdta(8)));
  assert.throws(
    () => validateM4aBuffer(nestedUdta(9)),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
});

test('rejects malformed child boxes inside a M4A meta container', () => {
  const malformedChild = Buffer.alloc(8);
  malformedChild.writeUInt32BE(7, 0);
  malformedChild.write('free', 4, 4, 'ascii');
  const malformed = Buffer.concat([
    validM4a(),
    box('moov', box('udta', box('meta', Buffer.concat([Buffer.alloc(4), malformedChild]))))
  ]);

  assert.throws(
    () => validateM4aBuffer(malformed),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
});

test('rejects unsupported M4A brands, tracks, AAC profiles, descriptors, and box bounds', () => {
  const invalidSize = validM4a();
  invalidSize.writeUInt32BE(7, 0);

  const malformedDescriptor = validM4a();
  const esdsTypeOffset = malformedDescriptor.indexOf(Buffer.from('esds', 'ascii'));
  malformedDescriptor[esdsTypeOffset + 9] = 0x80;

  const oversizedLargeBox = Buffer.alloc(16);
  oversizedLargeBox.writeUInt32BE(1, 0);
  oversizedLargeBox.write('ftyp', 4, 4, 'ascii');
  oversizedLargeBox.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);

  for (const invalid of [
    Buffer.alloc(0),
    validM4a({ audioObjectType: 5 }),
    validM4a({ audioObjectType: 29 }),
    validM4a({ handlerType: 'vide' }),
    validM4a({ majorBrand: 'xxxx', compatibleBrand: 'yyyy' }),
    validM4a({ objectTypeIndication: 0x69 }),
    validM4a({ streamType: 0x04 }),
    invalidSize,
    malformedDescriptor,
    oversizedLargeBox,
    validM4a().subarray(0, validM4a().length - 1)
  ]) {
    assert.throws(
      () => validateM4aBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('accepts FLAC STREAMINFO followed immediately by a CRC-8-valid frame header', () => {
  assert.doesNotThrow(() => validateFlacBuffer(validFlac()));
  assert.doesNotThrow(() => validateFlacBuffer(validFlac({
    blockSizeCode: 6,
    optionalHeaderFields: Buffer.from([255, 0xac, 0x44]),
    sampleRateCode: 13
  })));
  assert.doesNotThrow(() => validateFlacBuffer(validFlac({
    blockingStrategy: 1,
    frameOrSampleNumber: sevenByteFlacNumber(1n << 31n)
  })));
});

test('rejects a fixed-block FLAC frame number that exceeds the canonical 31-bit range', () => {
  const tooLargeFrameNumber = sevenByteFlacNumber(1n << 31n);
  assert.throws(
    () => validateFlacBuffer(validFlac({ frameOrSampleNumber: tooLargeFrameNumber })),
    error => error.code === 'audio_content_invalid' && error.status === 400
  );
});

test('rejects invalid FLAC metadata, STREAMINFO fields, frame fields, UTF-8 numbers, and CRC', () => {
  const badMarker = validFlac();
  badMarker.write('xxxx', 0, 4, 'ascii');

  const wrongFirstMetadata = validFlac();
  wrongFirstMetadata[4] = 0x81;

  const duplicateStreamInfo = validFlac();
  duplicateStreamInfo[4] = 0x00;
  const secondStreamInfo = Buffer.concat([
    Buffer.from([0x80, 0x00, 0x00, 0x22]),
    duplicateStreamInfo.subarray(8, 42)
  ]);
  const duplicateMetadata = Buffer.concat([
    duplicateStreamInfo.subarray(0, 42),
    secondStreamInfo,
    duplicateStreamInfo.subarray(42)
  ]);

  const reservedMetadataType = validFlac();
  reservedMetadataType[4] = 0x00;
  const reservedMetadata = Buffer.concat([
    reservedMetadataType.subarray(0, 42),
    Buffer.from([0xff, 0x00, 0x00, 0x00]),
    reservedMetadataType.subarray(42)
  ]);

  const invalidBlockRange = validFlac();
  invalidBlockRange.writeUInt16BE(512, 8);

  const invalidSampleRate = validFlac();
  const packed = invalidSampleRate.readBigUInt64BE(18);
  invalidSampleRate.writeBigUInt64BE(packed & ((1n << 44n) - 1n), 18);

  const badCrc = validFlac();
  badCrc[47] ^= 0xff;

  const invalidChannel = validFlac();
  invalidChannel[45] = 0xb8;

  for (const invalid of [
    Buffer.alloc(0),
    badMarker,
    wrongFirstMetadata,
    duplicateMetadata,
    reservedMetadata,
    invalidBlockRange,
    invalidSampleRate,
    badCrc,
    invalidChannel,
    validFlac({ frameOrSampleNumber: Buffer.from([0xc0, 0x80]) }),
    validFlac().subarray(0, validFlac().length - 1),
    Buffer.concat([validFlac().subarray(0, 42), Buffer.from([0]), validFlac().subarray(42)])
  ]) {
    assert.throws(
      () => validateFlacBuffer(invalid),
      error => error.code === 'audio_content_invalid' && error.status === 400
    );
  }
});

test('documents FLAC header-only depth by accepting an opaque payload byte', () => {
  assert.doesNotThrow(() => validateFlacBuffer(validFlac({ payload: Buffer.from([0xff]) })));
});
