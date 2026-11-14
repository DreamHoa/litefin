// MPL-2.0. Fixture helpers adapted from Moonfin-Client/Smart-TV.
const join = (parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

const bytesOf = (text) => (text instanceof Uint8Array ? text : new TextEncoder().encode(text));

const encodeId = (id) => {
    const bytes = [];
    for (let value = id; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
    return new Uint8Array(bytes);
};

const uintBytes = (value, length) => {
    const out = new Uint8Array(length);
    for (let i = length - 1, rest = value; i >= 0; i--, rest = Math.floor(rest / 256)) out[i] = rest & 0xff;
    return out;
};

// Always an eight byte size, which every reader accepts and keeps offsets easy to follow.
const element = (id, body) => {
    const size = uintBytes(body.length, 8);
    size[0] = 0x01;
    return join([encodeId(id), size, body]);
};

const trackEntry = (number, codec, language) =>
    element(
        0xae,
        join([
            element(0xd7, uintBytes(number, 1)),
            element(0x83, uintBytes(number === 1 ? 1 : 17, 1)),
            element(0x86, bytesOf(codec)),
            element(0x22b59c, bytesOf(language))
        ])
    );

// The track number in a block is a one byte vint here, then timecode and flags.
const blockGroup = (track, text, durationMs) =>
    element(
        0xa0,
        join([
            element(0xa1, join([new Uint8Array([0x80 | track, 0x00, 0x00, 0x00]), bytesOf(text)])),
            element(0x9b, uintBytes(durationMs, 2))
        ])
    );

/** A Matroska file with one cluster per line, subtitles behind video filler, cues at the end. */
const buildFile = ({ lines, subtitleTracks = [[2, 'S_TEXT/UTF8', 'fre']], timestampScale = 1000000 }) => {
    const tracks = element(
        0x1654ae6b,
        join([trackEntry(1, 'V_MPEG4/ISO/AVC', 'und'), ...subtitleTracks.map((t) => trackEntry(...t))])
    );
    const info = element(0x1549a966, element(0x2ad7b1, uintBytes(timestampScale, 3)));
    const seekHead = (cuesPosition) =>
        element(
            0x114d9b74,
            element(0x4dbb, join([element(0x53ab, encodeId(0x1c53bb6b)), element(0x53ac, uintBytes(cuesPosition, 8))]))
        );
    let position = seekHead(0).length + info.length + tracks.length;
    const clusters = [];
    const cuePoints = [];
    for (const { track = 2, time, text, duration = 2000, simple = false } of lines) {
        const timecode = element(0xe7, uintBytes(time, 4));
        const video = element(0xa3, new Uint8Array(4096).fill(0x55));
        const subtitle = simple
            ? element(0xa3, join([new Uint8Array([0x80 | track, 0x00, 0x00, 0x80]), bytesOf(text)]))
            : blockGroup(track, text, duration);
        const cluster = element(0x1f43b675, join([timecode, video, subtitle]));
        cuePoints.push(
            element(
                0xbb,
                join([
                    element(0xb3, uintBytes(time, 4)),
                    element(
                        0xb7,
                        join([
                            element(0xf7, uintBytes(track, 1)),
                            element(0xf1, uintBytes(position, 8)),
                            element(0xf0, uintBytes(timecode.length + video.length, 4))
                        ])
                    )
                ])
            )
        );
        clusters.push(cluster);
        position += cluster.length;
    }
    return join([
        element(0x1a45dfa3, new Uint8Array([0x42, 0x86, 0x81, 0x01])),
        element(0x18538067, join([seekHead(position), info, tracks, ...clusters, element(0x1c53bb6b, join(cuePoints))]))
    ]);
};

export { buildFile };
