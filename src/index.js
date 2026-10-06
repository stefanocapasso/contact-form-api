const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.stefanocapasso.net",
  "https://stefanocapasso.net",
  "https://www.counselingonline.biz",
  "https://counselingonline.biz",
  "https://www.counseloraroma.net",
  "https://counseloraroma.net",
  "https://www.balancefelici.com",
  "https://balancefelici.com",
  "https://www.massoterapistastefanucci.it",
  "https://massoterapistastefanucci.it",
  "https://massoterapistastefanucci-it.stefano-capasso.workers.dev",
  "https://www.marinadanella.it",
  "https://marinadanella.it",
  "https://marinadanella-it.stefano-capasso.workers.dev",
  "https://www.duodulcimermusicaceltica.it",
  "https://duodulcimermusicaceltica.it",
  "https://duodulcimermusicaceltica-it.stefano-capasso.workers.dev",
  "https://raw.githack.com",
];

const PUBLISH_REPOS = {
  "counselingonline.biz": "stefanocapasso/counselingonline.biz",
  "stefanocapasso.net": "stefanocapasso/stefanocapasso.net",
  "counseloraroma.net": "stefanocapasso/counseloraroma.net",
};

const ACTIVE_SITES = ["counselingonline.biz", "stefanocapasso.net", "counseloraroma.net"];
const MANAGED_INDEX_PATH = "content/managed-posts.json";

function json(data, status = 200, origin = "") {
  const headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"};
  if (origin) { headers["Access-Control-Allow-Origin"] = origin; headers["Vary"] = "Origin"; }
  return new Response(JSON.stringify(data), { status, headers });
}

function allowedOrigins(env) {
  const extra = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function slugify(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}
function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64Utf8(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function githubRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing");
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "article-publisher",
      ...(options.headers || {}),
    },
  });
}

function authOk(request, env) {
  const supplied = request.headers.get("X-Publish-Password") || "";
  return !!env.PUBLISH_PASSWORD && supplied === env.PUBLISH_PASSWORD;
}
function requirePublishingConfig(request, env, corsOrigin) {
  if (!env.PUBLISH_PASSWORD || !env.GITHUB_TOKEN) return json({ok:false,error:"Publishing server not configured"},500,corsOrigin);
  if (!authOk(request, env)) return json({ok:false,error:"Password non valida"},401,corsOrigin);
  return null;
}
function repoPath(repo, path) { return `/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`; }

async function ensureRepoAccess(env, site) {
  const repo = PUBLISH_REPOS[site];
  const r = await githubRequest(env, `/repos/${repo}`);
  if (!r.ok) throw new Error(`Accesso GitHub non disponibile per ${site} (${r.status})`);
}

async function getGitHubFile(env, repo, path) {
  const r = await githubRequest(env, repoPath(repo, path));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read ${r.status}`);
  const d = await r.json();
  return { ...d, text: d.content ? fromBase64Utf8(d.content.replace(/\n/g, "")) : "" };
}

async function putGitHubFile(env, repo, path, contentBase64, message, sha = null) {
  const body = {message, content:contentBase64, branch:"main"};
  if (sha) body.sha = sha;
  const r = await githubRequest(env, repoPath(repo, path), {
    method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  if (!r.ok) { const detail = await r.text(); console.error("GitHub write", r.status, detail); throw new Error(`GitHub write ${r.status}`); }
  return r.json();
}

async function readManagedIndex(env, repo) {
  const f = await getGitHubFile(env, repo, MANAGED_INDEX_PATH);
  if (!f) return {items:[], sha:null};
  let items = [];
  try { items = JSON.parse(f.text); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  return {items, sha:f.sha};
}

async function updateManagedIndex(env, repo, article, remove = false) {
  const current = await readManagedIndex(env, repo);
  let items = current.items.filter(x => x && x.slug !== article.slug);
  if (!remove) items.push({slug:article.slug,title:article.title,date:article.date,status:"published"});
  items.sort((a,b) => (b.date || "").localeCompare(a.date || ""));
  await putGitHubFile(env, repo, MANAGED_INDEX_PATH, toBase64Utf8(JSON.stringify(items,null,2)+"\n"), `Update managed article index: ${article.slug}`, current.sha);
}

function imageExtension(name, type) {
  const n = String(name || "").toLowerCase();
  if (type === "image/jpeg" || n.endsWith(".jpg") || n.endsWith(".jpeg")) return "jpg";
  if (type === "image/png" || n.endsWith(".png")) return "png";
  if (type === "image/webp" || n.endsWith(".webp")) return "webp";
  return "";
}
function imagePathFor(site, slug, ext) {
  return site === "counselingonline.biz" ? `assets/img/blog/${slug}.${ext}` : `assets/uploads/articles/${slug}.${ext}`;
}
function selectedSites(site) {
  if (site === "all") return [...ACTIVE_SITES];
  return ACTIVE_SITES.includes(site) ? [site] : [];
}

async function saveImage(env, site, slug, imageData, imageName, imageType) {
  if (!imageData) return "";
  const ext = imageExtension(imageName, imageType);
  if (!ext) throw new Error("Formato immagine non supportato");
  if (imageData.length > 9_000_000) throw new Error("Immagine troppo grande");
  const repo = PUBLISH_REPOS[site];
  const path = imagePathFor(site, slug, ext);
  const existing = await getGitHubFile(env, repo, path);
  await putGitHubFile(env, repo, path, imageData, `Upload article image: ${slug}`, existing?.sha || null);
  return path;
}

async function listArticles(request, env, corsOrigin, url) {
  const configError = requirePublishingConfig(request, env, corsOrigin); if (configError) return configError;
  const site = url.searchParams.get("site") || "";
  if (!ACTIVE_SITES.includes(site)) return json({ok:false,error:"Sito non disponibile"},400,corsOrigin);
  try {
    await ensureRepoAccess(env, site);
    const repo = PUBLISH_REPOS[site];
    if (site === "counseloraroma.net") {
      const current = await readManagedIndex(env, repo);
      const articles = current.items.filter(x => x && x.status === "published" && x.slug).map(x => ({slug:x.slug,title:x.title,date:x.date}));
      articles.sort((a,b) => (b.date || "").localeCompare(a.date || ""));
      return json({ok:true,articles},200,corsOrigin);
    }
    const r = await githubRequest(env, `/repos/${repo}/contents/content/posts`);
    if (r.status === 404) return json({ok:true,articles:[]},200,corsOrigin);
    if (!r.ok) return json({ok:false,error:"Impossibile leggere gli articoli"},502,corsOrigin);
    const items = await r.json(); const articles = [];
    for (const item of items.filter(x => x.type === "file" && x.name.endsWith(".json"))) {
      try {
        const f = await getGitHubFile(env, repo, item.path); const p = JSON.parse(f.text);
        if (p.status === "published") articles.push({slug:p.slug,title:p.title,date:p.date});
      } catch (e) { console.error("Article list item", item.path, e); }
    }
    articles.sort((a,b) => (b.date || "").localeCompare(a.date || ""));
    return json({ok:true,articles},200,corsOrigin);
  } catch (e) {
    console.error("List articles", e);
    return json({ok:false,error:e.message || "Errore GitHub"},502,corsOrigin);
  }
}

async function getArticle(request, env, corsOrigin, url) {
  const configError = requirePublishingConfig(request, env, corsOrigin); if (configError) return configError;
  const site = url.searchParams.get("site") || ""; const slug = slugify(url.searchParams.get("slug") || "");
  if (!ACTIVE_SITES.includes(site) || !slug) return json({ok:false,error:"Richiesta non valida"},400,corsOrigin);
  try {
    await ensureRepoAccess(env, site);
    const f = await getGitHubFile(env, PUBLISH_REPOS[site], `content/posts/${slug}.json`);
    if (!f) return json({ok:false,error:"Articolo non trovato"},404,corsOrigin);
    const post = JSON.parse(f.text);
    return json({ok:true,article:post},200,corsOrigin);
  } catch (e) {
    console.error("Get article", e);
    return json({ok:false,error:e.message || "Errore GitHub"},502,corsOrigin);
  }
}

async function publishArticle(request, env, corsOrigin) {
  const configError = requirePublishingConfig(request, env, corsOrigin); if (configError) return configError;
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"JSON non valido"},400,corsOrigin); }
  const action = String(body.action || "new");
  const sites = selectedSites(String(body.site || ""));
  if (!sites.length) return json({ok:false,error:"Sito non disponibile"},400,corsOrigin);
  const title = String(body.title || "").trim(); const articleBody = String(body.body || "").trim();
  const date = String(body.date || "").trim(); const description = String(body.description || "").trim();
  const facebookVideo = String(body.facebook_video || "").trim(); const slug = slugify(body.slug || title);
  const imageData = String(body.image_data || ""); const imageName = String(body.image_name || ""); const imageType = String(body.image_type || "");
  if (!slug) return json({ok:false,error:"Slug non valido"},400,corsOrigin);
  if (!["new","edit","delete"].includes(action)) return json({ok:false,error:"Azione non valida"},400,corsOrigin);
  if (action !== "delete") {
    if (!title || title.length > 180) return json({ok:false,error:"Titolo non valido"},400,corsOrigin);
    if (!articleBody || articleBody.length > 100000) return json({ok:false,error:"Testo non valido"},400,corsOrigin);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ok:false,error:"Data non valida"},400,corsOrigin);
    if (description.length > 220) return json({ok:false,error:"Meta description troppo lunga"},400,corsOrigin);
    if (facebookVideo && !/^https:\/\/(www\.)?facebook\.com\//i.test(facebookVideo)) return json({ok:false,error:"URL Facebook non valido"},400,corsOrigin);
  }
  try {
    const targets = [];
    for (const site of sites) {
      await ensureRepoAccess(env, site);
      const repo = PUBLISH_REPOS[site];
      const path = `content/posts/${slug}.json`;
      const existing = await getGitHubFile(env, repo, path);
      let old = {};
      if (existing) {
        try { old = JSON.parse(existing.text); }
        catch { throw new Error(`Articolo non leggibile su ${site}`); }
      }
      if (action === "new" && existing && old.status !== "deleted") return json({ok:false,error:`Esiste già su ${site}`},409,corsOrigin);
      if ((action === "edit" || action === "delete") && !existing) return json({ok:false,error:`Articolo non trovato su ${site}`},404,corsOrigin);
      targets.push({site,repo,path,existing,old});
    }
    const results = [];
    for (const target of targets) {
      const {site,repo,path,existing,old} = target;
      if (action === "delete") {
        old.status = "deleted"; old.managed = true; old.deleted_at = new Date().toISOString();
        await putGitHubFile(env, repo, path, toBase64Utf8(JSON.stringify(old,null,2)+"\n"), `Delete article: ${old.title || slug}`, existing.sha);
        if (site === "counseloraroma.net") await updateManagedIndex(env, repo, {slug,title:old.title || slug,date:old.date || ""}, true);
        results.push({site,slug,status:"deleted"});
        continue;
      }
      let image = old.image || "";
      if (imageData) image = await saveImage(env, site, slug, imageData, imageName, imageType);
      const post = {version:2,site,title,slug,date,description,image,facebook_video:facebookVideo,body:articleBody,category:old.category || "",status:"published",managed:true};
      await putGitHubFile(env, repo, path, toBase64Utf8(JSON.stringify(post,null,2)+"\n"), `${action === "edit" ? "Update" : "Publish"} article: ${title}`, existing?.sha || null);
      if (site === "counseloraroma.net") await updateManagedIndex(env, repo, post, false);
      results.push({site,slug,path,image,status:"published"});
    }
    return json({ok:true,results},200,corsOrigin);
  } catch (e) {
    console.error("Publish article", e);
    return json({ok:false,error:e.message || "Errore durante la pubblicazione"},502,corsOrigin);
  }
}


function randomChatCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
}
function chatDbReady(env) { return !!env.CHAT_DB; }
async function ensureChatSchema(env) {
  if (!chatDbReady(env)) return;
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare("CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, source_site TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    env.CHAT_DB.prepare("CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, sender TEXT NOT NULL CHECK (sender IN ('user','admin')), message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE)"),
    env.CHAT_DB.prepare("CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at DESC)"),
    env.CHAT_DB.prepare("CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id)")
  ]);
}
async function notifyOwner(env, subject, lines) {
  if (!env.BREVO_API_KEY || !env.FROM_EMAIL || !env.TO_EMAIL) return;
  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json","api-key":env.BREVO_API_KEY},
      body:JSON.stringify({
        sender:{name:(env.FROM_NAME || "Sito web") + " - chat anonima",email:env.FROM_EMAIL},
        to:[{email:env.TO_EMAIL}],
        subject,
        textContent:lines.join("\n")
      })
    });
  } catch (e) { console.error("Chat notification", e); }
}
async function chatStart(request, env, corsOrigin, origin) {
  if (!corsOrigin) return json({ok:false,error:"Origin not allowed"},403);
  if (!chatDbReady(env)) return json({ok:false,error:"Chat non configurata"},503,corsOrigin);
  await ensureChatSchema(env);
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,corsOrigin); }
  const message=String(body.message||"").trim(), website=String(body.website||"").trim();
  if (website) return json({ok:true},200,corsOrigin);
  if (message.length < 3 || message.length > 2000) return json({ok:false,error:"Messaggio non valido"},400,corsOrigin);
  const code=randomChatCode(), codeHash=await sha256Hex(code), threadId=crypto.randomUUID();
  const sourceSite=origin.replace(/^https?:\/\//,"").replace(/^www\./,"") || "sito web";
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare("INSERT INTO chat_threads (id, code_hash, source_site, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").bind(threadId,codeHash,sourceSite),
    env.CHAT_DB.prepare("INSERT INTO chat_messages (thread_id, sender, message, created_at) VALUES (?, 'user', ?, datetime('now'))").bind(threadId,message)
  ]);
  await notifyOwner(env,"Nuovo messaggio chat anonima da " + sourceSite,["Conversazione: " + threadId.slice(0,8),"",message,"","Apri il pannello chat del sito per rispondere."]);
  return json({ok:true,code,messages:[{sender:"user",message}]},200,corsOrigin);
}
async function getThreadByCode(env, code) {
  if (!chatDbReady(env)) return null;
  const codeHash=await sha256Hex(String(code||"").trim().toUpperCase());
  return env.CHAT_DB.prepare("SELECT id, source_site, created_at, updated_at FROM chat_threads WHERE code_hash = ?").bind(codeHash).first();
}
async function chatRead(request, env, corsOrigin, url) {
  if (!corsOrigin) return json({ok:false,error:"Origin not allowed"},403);
  const code=(url.searchParams.get("code")||"").trim().toUpperCase();
  if (!code) return json({ok:false,error:"Codice mancante"},400,corsOrigin);
  const thread=await getThreadByCode(env,code);
  if (!thread) return json({ok:false,error:"Conversazione non trovata"},404,corsOrigin);
  const rows=await env.CHAT_DB.prepare("SELECT sender, message, created_at FROM chat_messages WHERE thread_id = ? ORDER BY id ASC").bind(thread.id).all();
  return json({ok:true,messages:rows.results||[]},200,corsOrigin);
}
async function chatUserReply(request, env, corsOrigin, origin) {
  if (!corsOrigin) return json({ok:false,error:"Origin not allowed"},403);
  if (!chatDbReady(env)) return json({ok:false,error:"Chat non configurata"},503,corsOrigin);
  await ensureChatSchema(env);
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,corsOrigin); }
  const code=String(body.code||"").trim().toUpperCase(), message=String(body.message||"").trim(), website=String(body.website||"").trim();
  if (website) return json({ok:true},200,corsOrigin);
  if (!code || message.length < 1 || message.length > 2000) return json({ok:false,error:"Dati non validi"},400,corsOrigin);
  const thread=await getThreadByCode(env,code);
  if (!thread) return json({ok:false,error:"Conversazione non trovata"},404,corsOrigin);
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare("INSERT INTO chat_messages (thread_id, sender, message, created_at) VALUES (?, 'user', ?, datetime('now'))").bind(thread.id,message),
    env.CHAT_DB.prepare("UPDATE chat_threads SET updated_at=datetime('now') WHERE id=?").bind(thread.id)
  ]);
  await notifyOwner(env,"Nuova risposta chat anonima da " + thread.source_site,["Conversazione: " + thread.id.slice(0,8),"",message,"","Apri il pannello chat del sito per rispondere."]);
  return json({ok:true},200,corsOrigin);
}
async function chatAdminList(request, env, corsOrigin) {
  const configError=requirePublishingConfig(request,env,corsOrigin); if(configError) return configError;
  if (!chatDbReady(env)) return json({ok:false,error:"Chat non configurata"},503,corsOrigin);
  await ensureChatSchema(env);
  const rows=await env.CHAT_DB.prepare("SELECT t.id,t.source_site,t.created_at,t.updated_at,(SELECT message FROM chat_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_message FROM chat_threads t ORDER BY t.updated_at DESC LIMIT 100").all();
  return json({ok:true,threads:rows.results||[]},200,corsOrigin);
}
async function chatAdminMessages(request, env, corsOrigin, url) {
  const configError=requirePublishingConfig(request,env,corsOrigin); if(configError) return configError;
  const id=url.searchParams.get("id")||"";
  const rows=await env.CHAT_DB.prepare("SELECT sender,message,created_at FROM chat_messages WHERE thread_id=? ORDER BY id ASC").bind(id).all();
  return json({ok:true,messages:rows.results||[]},200,corsOrigin);
}
async function chatAdminReply(request, env, corsOrigin) {
  const configError=requirePublishingConfig(request,env,corsOrigin); if(configError) return configError;
  let body; try { body=await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,corsOrigin); }
  const id=String(body.id||""), message=String(body.message||"").trim();
  if(!id || !message || message.length>2000) return json({ok:false,error:"Dati non validi"},400,corsOrigin);
  const exists=await env.CHAT_DB.prepare("SELECT id FROM chat_threads WHERE id=?").bind(id).first();
  if(!exists) return json({ok:false,error:"Conversazione non trovata"},404,corsOrigin);
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare("INSERT INTO chat_messages (thread_id,sender,message,created_at) VALUES (?,'admin',?,datetime('now'))").bind(id,message),
    env.CHAT_DB.prepare("UPDATE chat_threads SET updated_at=datetime('now') WHERE id=?").bind(id)
  ]);
  return json({ok:true},200,corsOrigin);
}

async function anonymousMessage(request, env, corsOrigin, origin) {
  if (!corsOrigin) return json({ok:false,error:"Origin not allowed"},403);
  if (!env.BREVO_API_KEY || !env.FROM_EMAIL || !env.TO_EMAIL) return json({ok:false,error:"Server configuration incomplete"},500,corsOrigin);
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,corsOrigin); }
  const message = String(body.message || "").trim();
  const website = String(body.website || "").trim();
  if (website) return json({ok:true},200,corsOrigin);
  if (message.length < 10 || message.length > 2000) return json({ok:false,error:"Messaggio non valido"},400,corsOrigin);
  const sourceSite = origin.replace(/^https?:\/\//, "").replace(/^www\./, "") || "sito web";
  const subject = `Messaggio anonimo da ${sourceSite}`;
  const textContent = [
    `Nuovo messaggio anonimo da ${sourceSite}`,
    "",
    "Nessun nome, email o numero di telefono è stato richiesto.",
    "Non è prevista una risposta diretta se la persona non torna volontariamente a contattarti.",
    "",
    "Messaggio:",
    message
  ].join("\n");
  const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json","api-key":env.BREVO_API_KEY},
    body:JSON.stringify({
      sender:{name:(env.FROM_NAME || "Sito web") + " - anonimo",email:env.FROM_EMAIL},
      to:[{email:env.TO_EMAIL}],
      subject,
      textContent
    })
  });
  if (!brevoResponse.ok) {
    const detail = await brevoResponse.text();
    console.error("Brevo anonymous error",brevoResponse.status,detail);
    return json({ok:false,error:"Invio non riuscito"},502,corsOrigin);
  }
  return json({ok:true},200,corsOrigin);
}

async function contactForm(request, env, corsOrigin, origin) {
  if (!corsOrigin) return json({ok:false,error:"Origin not allowed"},403);
  if (!env.BREVO_API_KEY || !env.FROM_EMAIL || !env.TO_EMAIL) return json({ok:false,error:"Server configuration incomplete"},500,corsOrigin);
  let body; try { body = await request.json(); } catch { return json({ok:false,error:"Invalid JSON"},400,corsOrigin); }
  const name = String(body.name || "").trim(), email = String(body.email || "").trim(), message = String(body.message || "").trim(), website = String(body.website || "").trim();
  if (website) return json({ok:true},200,corsOrigin);
  if (!name || name.length > 120) return json({ok:false,error:"Nome non valido"},400,corsOrigin);
  if (!isValidEmail(email) || email.length > 254) return json({ok:false,error:"Email non valida"},400,corsOrigin);
  if (message.length > 5000) return json({ok:false,error:"Messaggio non valido"},400,corsOrigin);
  const sourceSite = origin.replace(/^https?:\/\//, "").replace(/^www\./, "") || "sito web";
  const isBalance = sourceSite === "balancefelici.com";
  const isMassoterapista = sourceSite === "massoterapistastefanucci.it" || sourceSite === "massoterapistastefanucci-it.stefano-capasso.workers.dev";
  const isMarinaDanella = sourceSite === "marinadanella.it" || sourceSite === "marinadanella-it.stefano-capasso.workers.dev";
  const isDuoDulcimer = sourceSite === "duodulcimermusicaceltica.it" || sourceSite === "duodulcimermusicaceltica-it.stefano-capasso.workers.dev";
  const toEmail = isBalance ? "filippofelici@gmail.com" : (isMassoterapista ? "archiviotutto2016@gmail.com" : (isMarinaDanella ? "marina.danella@libero.it" : (isDuoDulcimer ? "dulcimerensemble@gmail.com" : env.TO_EMAIL)));
  const senderName = isBalance ? "Balance Felici - sito web" : (isMassoterapista ? "Massoterapista Stefanucci - sito web" : (isMarinaDanella ? "Marina D'Anella - sito web" : (isDuoDulcimer ? "Duo Dulcimer & Ensemble - sito web" : (env.FROM_NAME || "Sito web"))));
  const subject = `Nuovo contatto da ${sourceSite} - ${name}`;
  const textContent = [`Nuovo messaggio dal modulo di contatto di ${sourceSite}`,"",`Nome: ${name}`,`Email: ${email}`,"","Messaggio:",message || "(nessun messaggio)"].join("\n");
  const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","api-key":env.BREVO_API_KEY},body:JSON.stringify({sender:{name:senderName,email:env.FROM_EMAIL},to:[{email:toEmail}],replyTo:{name,email},subject,textContent})});
  if (!brevoResponse.ok) { const detail = await brevoResponse.text(); console.error("Brevo error",brevoResponse.status,detail); return json({ok:false,error:"Invio non riuscito"},502,corsOrigin); }
  return json({ok:true},200,corsOrigin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url); const origin = request.headers.get("Origin") || ""; const corsOrigin = allowedOrigins(env).has(origin) ? origin : "";
    try {
      if (request.method === "OPTIONS") {
        if (!corsOrigin) return new Response(null,{status:403});
        return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":corsOrigin,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-Publish-Password","Access-Control-Max-Age":"86400","Vary":"Origin"}});
      }
      if (request.method === "GET" && url.pathname === "/") return new Response("Contact Form API OK",{headers:{"Cache-Control":"no-store"}});
      if (request.method === "GET" && url.pathname === "/articles") return listArticles(request,env,corsOrigin,url);
      if (request.method === "GET" && url.pathname === "/article") return getArticle(request,env,corsOrigin,url);
      if (request.method === "POST" && url.pathname === "/contact") return contactForm(request,env,corsOrigin,origin);
      if (request.method === "POST" && url.pathname === "/anonymous") return anonymousMessage(request,env,corsOrigin,origin);
      if (request.method === "POST" && url.pathname === "/chat/start") return chatStart(request,env,corsOrigin,origin);
      if (request.method === "GET" && url.pathname === "/chat") return chatRead(request,env,corsOrigin,url);
      if (request.method === "POST" && url.pathname === "/chat/reply") return chatUserReply(request,env,corsOrigin,origin);
      if (request.method === "GET" && url.pathname === "/chat/admin/threads") return chatAdminList(request,env,corsOrigin);
      if (request.method === "GET" && url.pathname === "/chat/admin/messages") return chatAdminMessages(request,env,corsOrigin,url);
      if (request.method === "POST" && url.pathname === "/chat/admin/reply") return chatAdminReply(request,env,corsOrigin);
      if (request.method === "POST" && url.pathname === "/publish") return publishArticle(request,env,corsOrigin);
      return json({ok:false,error:"Not found"},404,corsOrigin);
    } catch (e) {
      console.error("Unhandled worker error", e);
      return json({ok:false,error:e.message || "Errore interno"},500,corsOrigin);
    }
  },
};
