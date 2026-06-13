// AI site briefing for a placed solar farm — powered by Google Gemini Flash.
//
// Gemini Flash has a free tier (get a key at https://aistudio.google.com/apikey),
// so this stays free for low-volume use. We call the REST streaming endpoint
// directly with fetch — no SDK dependency. The model is told to use ONLY the
// figures provided and never invent numbers: the suitability score and energy
// math remain the source of truth; the model only narrates them. Text is streamed
// straight through so the panel renders it progressively.

interface Brief {
  area_m2?: number
  capacity_kwp?: number
  suitability_class?: string
  dist_powerline_m?: number | null
  annual_kwh?: number | null
  past_month_kwh?: number | null
  past_month_value_eur?: number | null
  week_forecast_kwh?: number | null
  maintenance_eur_month?: number | null
  net_eur_month?: number | null
  lat?: number
  lon?: number
}

// Gemini Flash model; override with GEMINI_MODEL if your key prefers another.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

const SYSTEM = `You are a solar-siting analyst writing for a renewable-energy developer.
Write a concise briefing (about 120 words) on the proposed solar farm using ONLY the
figures provided in the user message. Never invent or estimate numbers that are not
given; if a figure is missing, simply don't mention it. Plain prose paragraphs — no
markdown headings, no bullet lists, no tables. Interpret the numbers (what the
suitability class, grid distance, production and net cash flow imply for the project),
don't just restate them. End with a single final line: "Recommendation: <build / marginal / avoid> — <one short reason>".`

function fmtKwh(kwh: number): string {
  if (kwh >= 1e6) return `${(kwh / 1e6).toFixed(2)} GWh`
  if (kwh >= 1e3) return `${(kwh / 1e3).toFixed(2)} MWh`
  return `${Math.round(kwh)} kWh`
}

function userBlock(b: Brief): string {
  const lines: string[] = []
  const km = b.dist_powerline_m != null ? (b.dist_powerline_m / 1000).toFixed(1) : null
  if (b.area_m2 != null) lines.push(`Land area: ${b.area_m2.toLocaleString("en-US")} m² (${(b.area_m2 / 1e6).toFixed(2)} km²)`)
  if (b.capacity_kwp != null) lines.push(`Installed capacity: ${(b.capacity_kwp / 1000).toFixed(1)} MWp`)
  if (b.suitability_class) lines.push(`Land suitability class: ${b.suitability_class}`)
  if (km != null) lines.push(`Distance to nearest power line (grid interconnection): ${km} km`)
  if (b.annual_kwh != null) lines.push(`Estimated annual generation at this site's irradiance: ${fmtKwh(b.annual_kwh)}`)
  if (b.past_month_kwh != null) lines.push(`Last 30 days actual generation (real weather): ${fmtKwh(b.past_month_kwh)}`)
  if (b.past_month_value_eur != null) lines.push(`Last 30 days energy value: €${Math.round(b.past_month_value_eur).toLocaleString("en-US")}`)
  if (b.week_forecast_kwh != null) lines.push(`Next 7 days forecast generation: ${fmtKwh(b.week_forecast_kwh)}`)
  if (b.maintenance_eur_month != null) lines.push(`Modeled maintenance cost: €${Math.round(b.maintenance_eur_month).toLocaleString("en-US")}/month`)
  if (b.net_eur_month != null) lines.push(`Net (energy value − maintenance), monthly: €${Math.round(b.net_eur_month).toLocaleString("en-US")}`)
  if (b.lat != null && b.lon != null) lines.push(`Location: ${b.lat.toFixed(3)}, ${b.lon.toFixed(3)} (Bavaria)`)
  return `Solar farm figures:\n${lines.join("\n")}`
}

// Pull the text out of one Gemini SSE JSON chunk.
function textFromChunk(json: unknown): string {
  try {
    const parts = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      ?.candidates?.[0]?.content?.parts
    return (parts ?? []).map((p) => p.text ?? "").join("")
  } catch {
    return ""
  }
}

export async function POST(request: Request) {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return new Response("AI briefing needs GEMINI_API_KEY set on the server (free key: aistudio.google.com/apikey).", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  let body: Brief
  try {
    body = (await request.json()) as Brief
  } catch {
    return new Response("Invalid request body.", { status: 400, headers: { "content-type": "text/plain" } })
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userBlock(body) }] }],
      generationConfig: {
        maxOutputTokens: 700,
        temperature: 0.4,
        // Gemini 2.5 models "think" by default, which burns extra tokens; a short
        // grounded briefing doesn't need it. Disable on 2.5 to keep usage minimal.
        ...(MODEL.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  })

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "")
    return new Response(`Gemini error (${upstream.status}). ${detail.slice(0, 300)}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  // Re-stream Gemini's SSE as plain text deltas so the client renders progressively.
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split("\n")
          buf = lines.pop() ?? "" // keep the trailing partial line
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === "[DONE]") continue
            const text = textFromChunk(JSON.parse(payload))
            if (text) controller.enqueue(encoder.encode(text))
          }
        }
        controller.close()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        controller.enqueue(encoder.encode(`\n[briefing failed: ${msg}]`))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  })
}
