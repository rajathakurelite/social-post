/**
 * Feature 248: tiny mock Ollama /api/generate for offline polish.
 * Prefer MOCK_OLLAMA=true in generate_post.js for zero-HTTP path.
 */
import http from 'http';

const port = Number(process.env.MOCK_OLLAMA_PORT) || 11434;

const canned = `===FB_CAPTION===
Hook line for Airepro
Grow with Airepro
Visit: https://airepro.in

===FB_HEADLINE===
FIND YOUR DREAM INTERNSHIP

===FB_ACCENT_WORD===
DREAM

===FB_SUBHEAD===
Start with Airepro

===FB_BODY===
Verified internships that help you learn and grow.

===FB_CTA_LABEL===
Explore Internships Now

===TWITTER===
Verified internships with Airepro — start at https://airepro.in

===LINKEDIN===
At Airepro we help students find verified internships.

Apply: https://airepro.in

===LINKEDIN_COMMENT===
What internship are you chasing this year?

===YOUTUBE_TITLE===
Airepro internship guide

===YOUTUBE_DESCRIPTION===
Overview of verified internships.

0:00 Intro
0:30 Why Airepro
1:00 Apply

===WHATSAPP===
Hi! Explore internships at https://airepro.in`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'mock' }, { name: 'gemma:7b-instruct' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: canned }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-ollama listening on http://127.0.0.1:${port}`);
});
