import {createHash} from 'node:crypto';
import {brotliCompressSync, constants} from 'node:zlib';

export function packNinja(raw) {
  const rows = raw.trimEnd().split('\n').slice(1).map(line => {
    const [start, end, , output] = line.split('\t');
    if (!output || !/^\d+$/.test(start) || !/^\d+$/.test(end) || Number(end)<Number(start)) {
      throw new Error('Invalid Ninja log row');
    }
    return [Number(start), Number(end), output];
  }).sort((a,b)=>a[0]-b[0]);
  const timings=[];
  const put = value => {
    if (!Number.isSafeInteger(value) || value<0 || value>0xffffffff) throw new Error('Invalid Ninja timing');
    while (value>=128) {timings.push((value%128)+128);value=Math.floor(value/128);}
    timings.push(value);
  };
  let previous=0;
  for (const [start,end] of rows) {put(start-previous);put(end-start);previous=start;}
  const size=Buffer.alloc(4);
  size.writeUInt32LE(timings.length);
  const payload=Buffer.concat([size,Buffer.from(timings),Buffer.from(rows.map(row=>row[2]).join('\n'))]);
  const bytes=brotliCompressSync(payload,{params:{[constants.BROTLI_PARAM_QUALITY]:11}});
  return {encoding:'brotli-delta-v1',actions:rows.length,sumActionMs:rows.reduce((s,[a,b])=>s+b-a,0),
    sha256:createHash('sha256').update(bytes).digest('hex'), data:bytes.toString('base64')};
}
