// Netlify Function v2: transcribe.js
// POST (direct):    { audio: base64DataUrl, mimeType }   — small file ≤4MB
// POST (assembled): { id, totalChunks, mimeType }         — large file, reassemble from Blobs
// Both paths transcribe via Groq Whisper and return the result immediately (no polling).

import { getStore } from '@netlify/blobs';
import https from 'https';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Raw https.request — avoids all undici/fetch binary body issues
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function transcribeWithGroq(audioBuf, mimeType) {
  const boundary = 'GR0QBoundary' + Date.now();
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'audio';

  // Build multipart/form-data body manually (reliable binary handling)
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const post = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n` +
    `--${boundary}--\r\n`,
    'utf8'
  );

  const body = Buffer.concat([pre, audioBuf, post]);

  const result = await httpsPost('api.groq.com', '/openai/v1/audio/transcriptions', {
    'Authorization': `Bearer ${GROQ_API_KEY}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
  }, body);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Groq transcription failed (${audioBuf.length} bytes): ${result.text}`);
  }

  const data = JSON.parse(result.text);
  return {
    text: data.text || '',
    segments: (data.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text })),
    language: data.language || 'unknown',
  };
}

export default async function transcribe(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!GROQ_API_KEY) {
    return Response.json({ error: 'GROQ_API_KEY not configured' }, { status: 500, headers: cors });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
  }

  try {
    const body = await request.json();
    let audioBuf; // Buffer
    let mimeType;

    if (body.id && body.totalChunks !== undefined) {
      // ── Assembled path: read binary chunks from Netlify Blobs ──
      mimeType = body.mimeType || 'audio/mp4';
      const store = getStore({ name: 'audio-chunks', consistency: 'strong' });

      const parts = [];
      for (let i = 0; i < body.totalChunks; i++) {
        const arrayBuf = await store.get(`${body.id}-${i}`, { type: 'arrayBuffer' });
        if (!arrayBuf) {
          return Response.json(
            { error: `Chunk ${i} not found in blob store` },
            { status: 400, headers: cors }
          );
        }
        parts.push(Buffer.from(arrayBuf));
        await store.delete(`${body.id}-${i}`);
      }
      audioBuf = Buffer.concat(parts);

    } else if (body.audio) {
      // ── Direct path: single base64 audio ──
      mimeType = body.mimeType || 'audio/mp4';
      const base64Data = body.audio.includes(',') ? body.audio.split(',')[1] : body.audio;
      audioBuf = Buffer.from(base64Data, 'base64');

    } else {
      return Response.json({ error: 'No audio data provided' }, { status: 400, headers: cors });
    }

    if (audioBuf.length < 100) {
      return Response.json(
        { error: `Audio too small to transcribe (${audioBuf.length} bytes)` },
        { status: 400, headers: cors }
      );
    }

    // Groq hard limit: 25 MB
    if (audioBuf.length > 25 * 1024 * 1024) {
      return Response.json(
        { error: `Audio file too large for transcription (${(audioBuf.length / 1048576).toFixed(1)} MB). Maximum is 25 MB. Try a shorter recording.` },
        { status: 400, headers: cors }
      );
    }

    const transcription = await transcribeWithGroq(audioBuf, mimeType);
    return Response.json({ transcription }, { headers: cors });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
}
