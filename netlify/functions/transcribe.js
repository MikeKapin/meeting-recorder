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

  // POST: Start transcription
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const { audio, mimeType } = body;

      if (!audio) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No audio data provided' }) };
      }

      // audio is a data URL: data:audio/webm;base64,XXXX
      // Extract the base64 part
      const base64Data = audio.includes(',') ? audio.split(',')[1] : audio;
      const buffer = Buffer.from(base64Data, 'base64');

      // Determine file extension
      const ext = (mimeType || '').includes('webm') ? 'webm' : (mimeType || '').includes('mp4') ? 'mp4' : 'webm';

      // Step 1: Upload file to Replicate's file API
      const uploadResp = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': mimeType || 'audio/webm'
        },
        body: buffer
      });

      let audioUrl;

      if (uploadResp.ok) {
        const uploadData = await uploadResp.json();
        audioUrl = uploadData.urls.get;
      } else {
        // Fallback: use data URI directly (works for small files)
        audioUrl = audio;
      }

      // Step 2: Create prediction with Whisper
      const predResp = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': 'application/json',
          'Prefer': 'respond-async'
        },
        body: JSON.stringify({
          version: 'cdd97b257f93cb89dede1c7584df59efd8f93f873c45f82f2c00c49fa49cc5c7',
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
