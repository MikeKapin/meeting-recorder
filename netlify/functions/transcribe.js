// Netlify Function: transcribe.js
// Handles both POST (start transcription) and GET (poll status)

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured' }) };
  }

  // GET: Poll prediction status
  if (event.httpMethod === 'GET') {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prediction id' }) };
    }

    try {
      const resp = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` }
      });
      const data = await resp.json();

      // Whisper output format from Replicate
      let output = null;
      if (data.status === 'succeeded' && data.output) {
        // Replicate Whisper returns { transcription, segments, detected_language }
        output = {
          text: data.output.transcription || (typeof data.output === 'string' ? data.output : ''),
          segments: data.output.segments || [],
          language: data.output.detected_language || 'unknown'
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: data.status,
          output: output,
          error: data.error
        })
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POST: Start transcription — accepts raw binary audio (audio/wav, audio/mp4, etc.)
  // Each request should be a single audio segment ≤ 6MB (use chunked upload from client)
  if (event.httpMethod === 'POST') {
    try {
      const contentType = (
        event.headers['content-type'] || event.headers['Content-Type'] || 'audio/wav'
      ).split(';')[0].trim();

      // Lambda/Netlify base64-encodes binary request bodies; decode accordingly
      const buffer = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body);

      if (!buffer || buffer.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No audio data provided' }) };
      }

      // Step 1: Upload audio file to Replicate's file API
      const uploadResp = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': contentType
        },
        body: buffer
      });

      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'File upload to Replicate failed: ' + errText }) };
      }

      const uploadData = await uploadResp.json();
      const audioUrl = uploadData.urls.get;

      // Step 2: Create Whisper prediction
      const predResp = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': 'application/json',
          'Prefer': 'respond-async'
        },
        body: JSON.stringify({
          version: '3c08daf437fe359eb158a5123c395673f0a113dd8b4bd01ddce5936850e2a981',
          input: {
            audio: audioUrl,
            model: 'large-v3',
            translate: false,
            temperature: 0,
            transcription: 'plain text',
            suppress_tokens: '-1',
            logprob_threshold: -1.0,
            no_speech_threshold: 0.6,
            condition_on_previous_text: true,
            compression_ratio_threshold: 2.4,
            temperature_increment_on_fallback: 0.2
          }
        })
      });

      if (!predResp.ok) {
        const errText = await predResp.text();
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Replicate API error: ' + errText }) };
      }

      const predData = await predResp.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ predictionId: predData.id })
      };

    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
}
