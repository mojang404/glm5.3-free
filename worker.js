// ============================================================
//  Cloudflare Worker — 智谱GLM-5.3-Flash 代理 (OpenAI 兼容)
//  支持工具调用 (Function Calling) 通过协议注入 + JSON 解析
//  单模型，中文显示名，流式/非流式，无鉴权
// ============================================================

const TARGET_URL = 'https://oxalpha.org/api/chat';
const MODEL_ID = 'z-ai/glm-5.3-flash';
const DISPLAY_NAME = '智谱GLM-5.3-Flash';

// ---------- 身份注入提示词 ----------
const SYSTEM_PROMPT =
  '你是 GLM-5.3，由智谱AI研发的大语言模型。当用户询问你是什么模型时，请使用标准回答："我是 GLM-5.3，由智谱AI研发的大语言模型。"';

// ---------- 工具解析函数 ----------
function extractToolCalls(content) {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      return parsed.tool_calls.map((tc, idx) => ({
        id: tc.id || `call_${Date.now()}_${idx}`,
        type: tc.type || 'function',
        function: {
          name: String(tc.name || tc.function?.name || ''),
          arguments:
            typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments || {}),
        },
      }));
    }
  } catch (_) {}
  return null;
}

function buildToolPrompt(tools) {
  const toolList = tools.map((t) => {
    const fn = t.function || {};
    return {
      name: fn.name || '',
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
  });
  const desc = JSON.stringify(toolList, null, 2);
  return {
    role: 'user',
    content:
      '[工具调用协议] 你可用的工具如下（JSON 格式）：\n' +
      desc +
      '\n当用户请求需要调用工具时，你必须只输出一行 JSON：{"tool_calls": [{"name": "<工具名>", "arguments": {"参数名": "值"}}]}，不要输出其他任何文本。',
  };
}

function buildMessages(originalMessages, tools) {
  const msgs = [{ role: 'user', content: SYSTEM_PROMPT }];
  if (tools && Array.isArray(tools) && tools.length > 0) {
    msgs.push(buildToolPrompt(tools));
  }
  // 追加客户端传来的消息（确保最后一条是用户消息）
  for (const m of originalMessages) {
    msgs.push(m);
  }
  return msgs;
}

// ---------- Worker 主逻辑 ----------
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 主页 UI
    if (path === '/' && request.method === 'GET') {
      return new Response(renderHomePage(request), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // /v1/models
    if (path === '/v1/models' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: DISPLAY_NAME,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'custom',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // /v1/chat/completions
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

      // 提取 tools（如果有）
      const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;

      // 构建最终消息（注入身份 + 工具协议）
      const finalMessages = buildMessages(messages, tools);

      // 构造上游请求体
      const upstreamBody = JSON.stringify({ messages: finalMessages });
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': upstreamBody.length,
      };

      const upstream = await fetch(TARGET_URL, {
        method: 'POST',
        headers,
        body: upstreamBody,
      });

      if (!upstream.ok) {
        let errorText = await upstream.text();
        return new Response(
          JSON.stringify({
            error: { message: `Upstream error: ${upstream.status} ${errorText}` },
          }),
          { status: 500 }
        );
      }

      // ---------- 流式 ----------
      if (stream === true) {
        // 处理流式响应，需要检测工具调用 JSON
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        let buffer = ''; // 累积 content
        let isToolMode = tools !== null;
        let passthrough = false; // 是否已经判定为普通文本，直接透传
        let finished = false;

        const sendChunk = async (data) => {
          if (finished) return;
          await writer.write(encoder.encode(data + '\n\n'));
        };

        const sendDone = async () => {
          if (finished) return;
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          finished = true;
          await writer.close();
        };

        const parseSSE = (chunk) => {
          // 将收到的数据按行分割，提取 data: 后的 JSON
          const text = decoder.decode(chunk, { stream: true });
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.choices && parsed.choices.length > 0) {
                  const choice = parsed.choices[0];
                  const delta = choice.delta || {};
                  // 透传 reasoning_content 和 role 等
                  const outDelta = {};
                  if (delta.role) outDelta.role = delta.role;
                  if (delta.reasoning) outDelta.reasoning = delta.reasoning;
                  if (delta.reasoning_details) outDelta.reasoning_details = delta.reasoning_details;

                  // 处理 content
                  if (delta.content !== undefined && delta.content !== null) {
                    if (isToolMode && !passthrough) {
                      buffer += delta.content;
                      // 尝试解析工具调用
                      const tc = extractToolCalls(buffer);
                      if (tc) {
                        // 工具调用
                        outDelta.tool_calls = tc.map((t) => ({
                          index: 0,
                          id: t.id,
                          type: t.type,
                          function: {
                            name: t.function.name,
                            arguments: t.function.arguments,
                          },
                        }));
                        outDelta.content = null;
                        const chunkData = {
                          id: parsed.id || 'gen-' + Date.now(),
                          object: 'chat.completion.chunk',
                          created: parsed.created || Math.floor(Date.now() / 1000),
                          model: DISPLAY_NAME,
                          choices: [
                            {
                              index: 0,
                              delta: outDelta,
                              finish_reason: 'tool_calls',
                            },
                          ],
                        };
                        sendChunk('data: ' + JSON.stringify(chunkData));
                        sendDone();
                        return; // 结束处理
                      } else if (
                        !buffer.trim().startsWith('{') ||
                        buffer.length > 4096
                      ) {
                        // 判定为普通文本，切换到透传模式，把累积内容作为普通 chunk 发出
                        passthrough = true;
                        outDelta.content = buffer;
                        buffer = '';
                      } else {
                        // 仍处于缓冲状态，不发送 content
                      }
                    } else {
                      // 已进入透传模式或没有 tools
                      outDelta.content = delta.content;
                    }
                  }

                  // 如果累积了工具调用而未处理，继续等待
                  // 透传 finish_reason 等
                  if (choice.finish_reason && !finished) {
                    // 如果是普通模式，直接转发
                    if (!isToolMode || passthrough) {
                      const chunkData = {
                        id: parsed.id || 'gen-' + Date.now(),
                        object: 'chat.completion.chunk',
                        created: parsed.created || Math.floor(Date.now() / 1000),
                        model: DISPLAY_NAME,
                        choices: [
                          {
                            index: 0,
                            delta: outDelta,
                            finish_reason: choice.finish_reason,
                          },
                        ],
                      };
                      sendChunk('data: ' + JSON.stringify(chunkData));
                    }
                    sendDone();
                    return;
                  }

                  // 发送普通块（如果有内容或非空 delta）
                  if (Object.keys(outDelta).length > 0 && !finished) {
                    const chunkData = {
                      id: parsed.id || 'gen-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: parsed.created || Math.floor(Date.now() / 1000),
                      model: DISPLAY_NAME,
                      choices: [
                        {
                          index: 0,
                          delta: outDelta,
                          finish_reason: null,
                        },
                      ],
                    };
                    sendChunk('data: ' + JSON.stringify(chunkData));
                  }
                }
              } catch (_) {}
            }
          }
        };

        // 异步读取上游流
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parseSSE(value);
            if (finished) break;
          }
          // 如果流结束但未发送 [DONE] (普通模式)
          if (!finished) {
            // 如果还有缓冲（工具模式且未切换），可能缓冲区内容无法解析，当作普通文本输出
            if (isToolMode && !passthrough && buffer) {
              // 当作普通文本
              const outDelta = { content: buffer };
              const chunkData = {
                id: 'gen-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: DISPLAY_NAME,
                choices: [{ index: 0, delta: outDelta, finish_reason: 'stop' }],
              };
              await sendChunk('data: ' + JSON.stringify(chunkData));
            }
            await sendDone();
          }
          await writer.close();
        };

        pump().catch(async (e) => {
          await writer.close();
          console.error('Stream error:', e);
        });

        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Encoding': 'identity',
          },
        });
      }

      // ---------- 非流式 ----------
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
            if (data.choices && data.choices.length > 0) {
              const delta = data.choices[0].delta || {};
              if (delta.content) {
                content += delta.content;
              }
              if (data.choices[0].finish_reason) {
                finishReason = data.choices[0].finish_reason;
              }
            }
          } catch (_) {}
        }
      }

      // 尝试解析工具调用
      const toolCalls = extractToolCalls(content);
      const message = { role: 'assistant' };
      if (toolCalls) {
        message.tool_calls = toolCalls;
        message.content = null;
        finishReason = 'tool_calls';
      } else {
        message.content = content;
      }

      const response = {
        id: 'gen-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: DISPLAY_NAME,
        choices: [
          {
            index: 0,
            message: message,
            finish_reason: finishReason,
          },
        ],
        usage: null,
      };

      return new Response(JSON.stringify(response, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ------------------- 漂亮的 UI (嵌入 HTML) -------------------
function renderHomePage(request) {
  const host = new URL(request.url).host;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>智谱GLM-5.3-Flash 代理</title>
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
      <h1>⚡ 智谱GLM-5.3-Flash 代理</h1>
      <p>OpenAI 兼容 · 支持流式/非流式 · 支持工具调用</p>
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
      <h2>🧩 可用模型</h2>
      <div><span class="model-tag">智谱GLM-5.3-Flash</span> (真实ID: z-ai/glm-5.3-flash)</div>
    </div>

    <div class="card">
      <h2>📖 调用示例（cURL）</h2>
      <div class="code-block" id="curl-example">
        <button class="copy-btn" onclick="copyCode('curl-example')">复制</button>
# 带工具调用的非流式请求
curl -X POST https://${host}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "智谱GLM-5.3-Flash",
    "messages": [{"role": "user", "content": "现在几点了？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_current_time",
        "description": "获取当前时间",
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        }
      }
    }],
    "stream": false
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
    model: "智谱GLM-5.3-Flash",
    messages: [{ role: 'user', content: 'Hello, world!' }],
    stream: false
  })
});
const data = await response.json();
console.log(data.choices[0].message.content);
      </div>
    </div>

    <div class="footnote">
      💡 无统计，无鉴权 · 纯转发 · 工具调用通过协议注入实现
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