const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.stefanocapasso.net",
  "https://stefanocapasso.net",
  "https://www.counselingonline.biz",
  "https://counselingonline.biz",
  "https://raw.githack.com",
];

function json(data, status = 200, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function allowedOrigins(env) {
  const extra = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const origins = allowedOrigins(env);
    const corsOrigin = origins.has(origin) ? origin : "";

    if (request.method === "OPTIONS") {
      if (!corsOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Contact Form API OK", {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (request.method !== "POST" || url.pathname !== "/contact") {
      return json({ ok: false, error: "Not found" }, 404, corsOrigin);
    }

    if (!corsOrigin) {
      return json({ ok: false, error: "Origin not allowed" }, 403);
    }

    if (!env.BREVO_API_KEY || !env.FROM_EMAIL || !env.TO_EMAIL) {
      return json({ ok: false, error: "Server configuration incomplete" }, 500, corsOrigin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, corsOrigin);
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();
    const website = String(body.website || "").trim();

    // Honeypot: i visitatori reali non compilano questo campo nascosto.
    if (website) {
      return json({ ok: true }, 200, corsOrigin);
    }

    if (!name || name.length > 120) {
      return json({ ok: false, error: "Nome non valido" }, 400, corsOrigin);
    }
    if (!isValidEmail(email) || email.length > 254) {
      return json({ ok: false, error: "Email non valida" }, 400, corsOrigin);
    }
    if (message.length > 5000) {
      return json({ ok: false, error: "Messaggio non valido" }, 400, corsOrigin);
    }

    const sourceSite = origin
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "") || "sito web";
    const subject = `Nuovo contatto da ${sourceSite} - ${name}`;
    const textContent = [
      `Nuovo messaggio dal modulo di contatto di ${sourceSite}`,
      "",
      `Nome: ${name}`,
      `Email: ${email}`,
      "",
      "Messaggio:",
      message || "(nessun messaggio)",
    ].join("\n");

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          name: env.FROM_NAME || "Stefano Capasso - sito web",
          email: env.FROM_EMAIL,
        },
        to: [{ email: env.TO_EMAIL }],
        replyTo: { name, email },
        subject,
        textContent,
      }),
    });

    if (!brevoResponse.ok) {
      const detail = await brevoResponse.text();
      console.error("Brevo error", brevoResponse.status, detail);
      return json({
        ok: false,
        error: "Invio non riuscito",
        brevoStatus: brevoResponse.status,
        brevoDetail: detail,
      }, 502, corsOrigin);
    }

    return json({ ok: true }, 200, corsOrigin);
  },
};
