import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BYTES_PER_PIXEL = 4;

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
    return left;
  }
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/** Decode the non-interlaced RGBA PNGs used by collision normal atlases. */
export default function decodeRgbaPng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new Error('Truncated PNG chunk');
    }
    const length = readUInt32(buffer, offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) {
      throw new Error('Truncated PNG data');
    }
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header || chunks.length === 0) {
    throw new Error('PNG is missing IHDR or IDAT');
  }
  if (
    header.bitDepth !== 8 ||
    header.colorType !== 6 ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new Error(
      'Unsupported PNG format: bitDepth=' +
        header.bitDepth +
        ' colorType=' +
        header.colorType +
        ' interlace=' +
        header.interlace,
    );
  }
  const inflated = inflateSync(Buffer.concat(chunks));
  const stride = header.width * BYTES_PER_PIXEL;
  if (inflated.length !== (stride + 1) * header.height) {
    throw new Error('Invalid PNG scanline size');
  }
  const pixels = Buffer.alloc(stride * header.height);
  let source = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filterType = inflated[source];
    source += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source];
      source += 1;
      const row = y * stride;
      const left = x >= BYTES_PER_PIXEL ? pixels[row + x - BYTES_PER_PIXEL] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = y > 0 && x >= BYTES_PER_PIXEL ? pixels[row - stride + x - BYTES_PER_PIXEL] : 0;
      let value;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new Error('Unsupported PNG filter: ' + filterType);
      }
      pixels[row + x] = value & 0xff;
    }
  }
  return {
    width: header.width,
    height: header.height,
    data: new Uint8ClampedArray(pixels),
  };
}
