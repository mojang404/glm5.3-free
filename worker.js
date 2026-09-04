// ============================================================
//  Cloudflare Worker — OxAlpha 代理 (OpenAI 兼容)
//  无统计，无KV，纯转发 + 漂亮UI
// ============================================================

const TARGET_URL = 'https://oxalpha.org/api/chat';
const MODEL_NAME = 'z-ai/glm-5.3-flash';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ------------------- 主页 (UI) -------------------
    if (path === '/' && request.method === 'GET') {
      return new Response(renderHomePage(request), {  // 传入 request
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ------------------- /v1/models -------------------
    if (path === '/v1/models' && request.method === 'GET') {
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: MODEL_NAME, object: 'model', created: 1788141005, owned_by: 'z-ai' }]
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ------------------- /v1/chat/completions -------------------
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
      }
      const { messages, stream = false } = body;
      if (!messages || !Array.isArray(messages)) {
        return new Response(JSON.stringify({ error: 'Missing messages' }), { status: 400 });
      }

      // 构造上游请求
      const upstreamBody = JSON.stringify({ messages });
      const upstream = await fetch(TARGET_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': upstreamBody.length,
        },
        body: upstreamBody,
      });

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: 'Upstream error' }), { status: 500 });
      }

      // ---------- 流式输出 ----------
      if (stream === true) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Encoding': 'identity',
          },
        });
      }

      // ---------- 非流式输出 ----------
      const rawText = await upstream.text();
      const lines = rawText.split('\n');
      let content = '';
      let finishReason = 'stop';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            if (data.choices && data.choices[0].delta.content) {
              content += data.choices[0].delta.content;
            }
            if (data.choices && data.choices[0].finish_reason) {
              finishReason = data.choices[0].finish_reason;
            }
          } catch (e) { /* ignore */ }
        }
      }

      const response = {
        id: 'gen-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_NAME,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason,
        }],
        usage: null,
      };

      return new Response(JSON.stringify(response, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 404
    return new Response('Not Found', { status: 404 });
  },
};

// ------------------- 漂亮的 UI (嵌入 HTML) -------------------
function renderHomePage(request) {   // 接收 request 参数
  const host = new URL(request.url).host;  // 动态获取当前 host
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OxAlpha 代理 · OpenAI 兼容</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0b0e14;
      color: #e4e9f0;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      padding: 2rem 1.5rem;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 1000px;
      width: 100%;
    }
    .header {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #7c8cff, #b47cff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    .header p {
      color: #8a94a6;
      margin-top: 0.5rem;
    }
    .card {
      background: #161c27;
      border-radius: 20px;
      border: 1px solid #29303d;
      padding: 1.8rem 2rem;
      margin-bottom: 2rem;
      overflow-x: auto;
    }
    .card h2 {
      font-size: 1.2rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #c8d0dc;
    }
    .endpoint {
      background: #0b0e14;
      padding: 0.6rem 1rem;
      border-radius: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
      border-left: 4px solid #7c8cff;
      margin-bottom: 1.2rem;
      word-break: break-all;
    }
    .code-block {
      background: #0b0e14;
      padding: 1rem 1.2rem;
      border-radius: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      line-height: 1.6;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #29303d;
      position: relative;
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 12px;
      background: #29303d;
      border: none;
      color: #c8d0dc;
      padding: 4px 12px;
      border-radius: 8px;
      font-size: 0.7rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .copy-btn:hover { background: #3f4a5f; }
    .badge {
      display: inline-block;
      background: #202837;
      color: #aab3c9;
      padding: 0.15rem 0.8rem;
      border-radius: 30px;
      font-size: 0.75rem;
      font-weight: 500;
      margin-right: 0.5rem;
    }
    .badge.get { background: #1e3a5f; color: #6ea8fe; }
    .badge.post { background: #2d4b3c; color: #6fcf97; }
    .footnote {
      color: #6a7a8e;
      font-size: 0.85rem;
      text-align: center;
      margin-top: 1.5rem;
      border-top: 1px solid #202837;
      padding-top: 1.5rem;
    }
    a { color: #7c8cff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 600px) {
      .card { padding: 1.2rem; }
      .header h1 { font-size: 1.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ OxAlpha 代理</h1>
      <p>OpenAI 兼容 · 零配置 · 流式/非流式</p>
    </div>

    <div class="card">
      <h2>📡 接口地址</h2>
      <div class="endpoint">
        <span class="badge post">POST</span> /v1/chat/completions
      </div>
      <div class="endpoint">
        <span class="badge get">GET</span> /v1/models
      </div>
    </div>

    <div class="card">
      <h2>📖 调用示例（cURL）</h2>
      <div class="code-block" id="curl-example">
        <button class="copy-btn" onclick="copyCode('curl-example')">复制</button>
curl -N -X POST https://${host}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "你好，请介绍一下自己"}],
    "stream": true
  }'
      </div>
    </div>

    <div class="card">
      <h2>📄 JavaScript (fetch) 示例</h2>
      <div class="code-block" id="js-example">
        <button class="copy-btn" onclick="copyCode('js-example')">复制</button>
const response = await fetch('https://${host}/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Hello, world!' }],
    stream: false
  })
});
const data = await response.json();
console.log(data.choices[0].message.content);
      </div>
    </div>

    <div class="footnote">
      💡 无统计，无鉴权 · 纯转发 · 仅用于学习测试
    </div>
  </div>

  <script>
    function copyCode(id) {
      const block = document.getElementById(id);
      const text = block.innerText.replace('复制', '').trim();
      navigator.clipboard.writeText(text).then(() => {
        const btn = block.querySelector('.copy-btn');
        btn.textContent = '✓ 已复制';
        setTimeout(() => btn.textContent = '复制', 2000);
      });
    }
  </script>
</body>
</html>`;
}