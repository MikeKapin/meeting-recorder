// Netlify Function: summarize.js
// Generates meeting summary from transcript using Claude

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const { transcript } = JSON.parse(event.body);

    if (!transcript || transcript.trim().length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No transcript provided' }) };
    }

    // Call Claude API for summarization
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Analyze this meeting transcript and provide a structured summary:

${transcript}

Please provide:
1. **Brief Overview** (2-3 sentences)
2. **Key Discussion Points** (bullet points)
3. **Decisions Made** (if any)
4. **Action Items** (if any, with responsible parties if mentioned)
5. **Next Steps** (if discussed)

Format as clean markdown for easy reading.`
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', errorText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to generate summary', details: errorText })
      };
    }

    const data = await response.json();
    const summary = data.content[0].text;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        summary: summary,
        model: 'claude-sonnet-4-5',
        timestamp: new Date().toISOString()
      })
    };

  } catch (e) {
    console.error('Summarization error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: e.message })
    };
  }
}
