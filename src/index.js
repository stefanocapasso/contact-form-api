const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.stefanocapasso.net",
  "https://stefanocapasso.net",
  "https://www.counselingonline.biz",
  "https://counselingonline.biz",
  "https://raw.githack.com",
];

const PUBLISH_REPOS = {
  "counselingonline.biz": "stefanocapasso/counselingonline.biz",
  "stefanocapasso.net": "stefanocapasso/stefanocapasso.net",
  "counseloraroma.net": "stefanocapasso/counseloraroma.net",
};

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

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function githubRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN missing");
  }
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "stefano-capasso-article-publisher",
      ...(options.headers || {}),
    },
  });
  return response;
}

async function publishArticle(request, env, corsOrigin) {
  if (!corsOrigin) {
    return json({ ok: false, error: "Origin not allowed" }, 403);
  }
  if (!env.PUBLISH_PASSWORD || !env.GITHUB_TOKEN) {
    return json({ ok: false, error: "Publishing server not configured" }, 500, corsOrigin);
  }

  const suppliedPassword = request.headers.get("X-Publish-Password") || "";
  if (!suppliedPassword || suppliedPassword !== env.PUBLISH_PASSWORD) {
    return json({ ok: false, error: "Password non valida" }, 401, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON non valido" }, 400, corsOrigin);
  }

  const site = String(body.site || "").trim();
  const title = String(body.title || "").trim();
  const articleBody = String(body.body || "").trim();
  const date = String(body.date || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || "").trim();
  const slug = slugify(body.slug || title);
  const repo = PUBLISH_REPOS[site];

  if (!repo) return json({ ok: false, error: "Sito non supportato" }, 400, corsOrigin);
  if (!title || title.length > 180) return json({ ok: false, error: "Titolo non valido" }, 400, corsOrigin);
  if (!slug) return json({ ok: false, error: "Slug non valido" }, 400, corsOrigin);
  if (!articleBody || articleBody.length > 100000) return json({ ok: false, error: "Testo non valido" }, 400, corsOrigin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "Data non valida" }, 400, corsOrigin);
  if (description.length > 220) return json({ ok: false, error: "Meta description troppo lunga" }, 400, corsOrigin);

  const post = {
    version: 1,
    site,
    title,
    slug,
    date,
    description,
    image,
    body: articleBody,
    status: "published",
  };
  const path = `content/posts/${slug}.json`;

  const existing = await githubRequest(env, `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`);
  if (existing.ok) {
    return json({ ok: false, error: "Esiste già un articolo con questo slug" }, 409, corsOrigin);
  }
  if (existing.status !== 404) {
    const detail = await existing.text();
    console.error("GitHub lookup error", existing.status, detail);
    if (existing.status === 404 && site === "counseloraroma.net") {
      return json({ ok: false, error: "counseloraroma.net non è ancora configurato" }, 409, corsOrigin);
    }
    return json({ ok: false, error: "Errore di verifica repository" }, 502, corsOrigin);
  }

  const create = await githubRequest(env, `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Publish article: ${title}`,
      content: toBase64Utf8(JSON.stringify(post, null, 2) + "\n"),
      branch: "main",
    }),
  });

  if (!create.ok) {
    const detail = await create.text();
    console.error("GitHub create error", create.status, detail);
    if (create.status === 404 && site === "counseloraroma.net") {
      return json({ ok: false, error: "counseloraroma.net non è ancora configurato" }, 409, corsOrigin);
    }
    return json({ ok: false, error: "Pubblicazione su GitHub non riuscita" }, 502, corsOrigin);
  }

  return json({ ok: true, site, slug, path }, 200, corsOrigin);
}

async function contactForm(request, env, corsOrigin, origin) {
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
          "Access-Control-Allow-Headers": "Content-Type, X-Publish-Password",
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

    if (request.method === "POST" && url.pathname === "/contact") {
      return contactForm(request, env, corsOrigin, origin);
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      return publishArticle(request, env, corsOrigin);
    }

    return json({ ok: false, error: "Not found" }, 404, corsOrigin);
  },
};