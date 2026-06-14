import { NextResponse } from "next/server";

/**
 * Multi-provider AI gateway. Tries, in order:
 *   1. Groq        — FREE, no credit card. Set GROQ_API_KEY in .env.local.
 *   2. OpenAI-compatible — OpenAI / OpenRouter / DeepSeek / local. Set
 *      OPENAI_API_KEY (+ optional OPENAI_BASE_URL, OPENAI_MODEL).
 *   3. Pollinations — free, no key (best-effort; often rate-limited).
 *   4. none — caller falls back to the local rule-based engine.
 *
 * Keys stay server-side and are never shipped to the browser.
 */
export const dynamic = "force-dynamic";

type Msg = { role: string; content: string };

async function chat(url: string, key: string | null, model: string, messages: Msg[]): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, temperature: 0.55, max_tokens: 950 }),
    signal: AbortSignal.timeout(22000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty completion");
  return text.trim();
}

export async function POST(req: Request) {
  let messages: Msg[];
  try {
    ({ messages } = (await req.json()) as { messages: Msg[] });
    if (!Array.isArray(messages) || messages.length === 0) throw new Error();
  } catch {
    return NextResponse.json({ text: null, provider: "none", error: "bad request" }, { status: 400 });
  }

  // 1. Groq (free)
  if (process.env.GROQ_API_KEY) {
    try {
      const text = await chat("https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY, process.env.GROQ_MODEL || "llama-3.3-70b-versatile", messages);
      return NextResponse.json({ text, provider: "groq" });
    } catch {
      /* fall through */
    }
  }

  // 2. Any OpenAI-compatible provider
  if (process.env.OPENAI_API_KEY) {
    try {
      const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const text = await chat(`${base.replace(/\/$/, "")}/chat/completions`, process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || "gpt-4o-mini", messages);
      return NextResponse.json({ text, provider: "openai" });
    } catch {
      /* fall through */
    }
  }

  // 3. Free, no key (best-effort)
  try {
    const text = await chat("https://text.pollinations.ai/openai", null, "openai", messages);
    return NextResponse.json({ text, provider: "pollinations" });
  } catch {
    /* fall through */
  }

  // 4. No provider available — caller uses the local engine.
  return NextResponse.json({ text: null, provider: "none" });
}
