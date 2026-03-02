// Netlify Function v2: upload-chunk.js
// Decodes a base64 audio chunk and stores raw binary in Netlify Blobs.

import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function uploadChunk(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
  }

  try {
    const { id, chunkIndex, base64 } = await request.json();
    if (!id || chunkIndex === undefined || !base64) {
      return Response.json({ error: 'Missing required fields' }, { status: 400, headers: cors });
    }

    // Decode base64 data URL → raw Buffer → store as ArrayBuffer in Blobs
    const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
    const buf = Buffer.from(base64Data, 'base64');

    if (buf.length === 0) {
      return Response.json({ error: `Chunk ${chunkIndex} decoded to 0 bytes` }, { status: 400, headers: cors });
    }

    // Convert Buffer to a plain ArrayBuffer for Blobs storage
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const store = getStore({ name: 'audio-chunks', consistency: 'strong' });
    await store.set(`${id}-${chunkIndex}`, arrayBuf, { ttl: 3600 });

    return Response.json({ ok: true, bytes: buf.length }, { headers: cors });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
}
