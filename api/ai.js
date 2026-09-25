// Serverless function (deployed by Vercel automatically from /api).
// Keeps the Anthropic API key on the server -- it must NEVER be sent to the browser.
// Requires an environment variable set in your Vercel project settings:
//   ANTHROPIC_API_KEY  (secret, from https://console.anthropic.com)
// Optional:
//   ANTHROPIC_MODEL    (defaults to a small, cheap model -- see README.md)

const { getUser } = require("./_lib");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Only signed-in PrepBank users can use the AI (protects the API credits)
  const user = await getUser(req).catch(() => null);
  if (!user || !user.id) {
    res.status(401).json({ error: "Please sign in again to use this." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error:
        "Server is missing ANTHROPIC_API_KEY. Add it under Vercel -> Project -> Settings -> Environment Variables, then redeploy.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  try {
    if (body.action === "generate") {
      const result = await generateQuestions(body, apiKey);
      res.status(200).json(result);
    } else if (body.action === "grade") {
      const result = await gradeShortAnswers(body, apiKey);
      res.status(200).json(result);
    } else {
      res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "AI request failed" });
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function callClaude(apiKey, system, userText, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Claude API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  return (json.content || []).map((b) => b.text || "").join("");
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (e) {
      /* fall through */
    }
  }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Could not parse the AI's response as JSON");
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

async function generateQuestions(body, apiKey) {
  const { subject, className, material, counts } = body;
  const mcCount = clampInt(counts && counts.mc, 0, 25);
  const shortCount = clampInt(counts && counts.short, 0, 25);
  const flashCount = clampInt(counts && counts.flashcards, 0, 40);
  const trimmedMaterial = String(material || "").slice(0, 14000);

  if (!trimmedMaterial.trim()) {
    throw new Error("No study material was provided.");
  }
  if (mcCount + shortCount + flashCount === 0) {
    throw new Error("Ask for at least one question or flashcard.");
  }

  const system = [
    "You write practice test material for high school students, generated strictly from a study guide or notes THEY provide.",
    "Base every question only on the material given. Never introduce outside facts or invented figures.",
    "Vary difficulty across easy, medium, and hard.",
    "Multiple-choice: exactly one clearly correct choice; the other three must be plausible but wrong on close reading.",
    "Short-answer: a concise, objectively gradable expected answer (a phrase or short sentence), plus 2-4 acceptable keyword variants a grader could match on.",
    "Flashcards: term on the front, a clear one-to-two sentence definition/explanation on the back.",
    "Reply with ONLY one JSON object matching this schema, no prose and no markdown fences:",
    '{"mc":[{"prompt":string,"choices":[string,string,string,string],"correctIndex":number,"explanation":string}],"short":[{"prompt":string,"answer":string,"acceptableKeywords":[string]}],"flashcards":[{"term":string,"definition":string}]}',
  ].join(" ");

  const userText = [
    `Class: ${className || "Unknown class"} (${subject || "general"})`,
    `Generate exactly ${mcCount} multiple-choice questions, ${shortCount} short-answer questions, and ${flashCount} flashcards from the study material below.`,
    "STUDY MATERIAL:",
    trimmedMaterial,
  ].join("\n\n");

  const text = await callClaude(apiKey, system, userText, 4096);
  const parsed = extractJson(text);
  return {
    mc: Array.isArray(parsed.mc) ? parsed.mc.slice(0, mcCount) : [],
    short: Array.isArray(parsed.short) ? parsed.short.slice(0, shortCount) : [],
    flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards.slice(0, flashCount) : [],
  };
}

async function gradeShortAnswers(body, apiKey) {
  const pairs = Array.isArray(body.pairs) ? body.pairs.slice(0, 30) : [];
  if (pairs.length === 0) return { results: [] };

  const system = [
    "You grade short-answer quiz responses for a high school student against an expected answer.",
    "Mark an answer correct if it captures the key idea, even with different wording; mark it wrong if it misses the key idea or is blank.",
    "Reply with ONLY a JSON array, same order and length as the input, of objects: {\"isCorrect\":boolean,\"feedback\":string}.",
    "feedback is one short, encouraging sentence explaining the grade.",
  ].join(" ");

  const userText = `Grade these question/expected-answer/student-answer triples:\n${JSON.stringify(pairs)}`;
  const text = await callClaude(apiKey, system, userText, 2048);
  const parsed = extractJson(text);
  const results = Array.isArray(parsed) ? parsed : parsed.results;
  return { results: (results || []).slice(0, pairs.length) };
}
