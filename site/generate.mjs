#!/usr/bin/env node
/**
 * Génère la vitrine (index.html + assets) depuis site/vitrine.json.
 * Ne pas éditer le HTML produit à la main : régénérer.
 *
 * Les versions affichées sont relues dans le chart, jamais recopiées : une
 * version recopiée finit toujours par dériver.
 *
 * Sortie : site/dist par défaut, ou le dossier passé dans SITE_OUT (la CI
 * écrit directement dans le dossier publié sur gh-pages, à côté de index.yaml).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const VITRINE = path.join(ROOT, "vitrine.json");
const CHART_DIR = path.join(REPO, "charts", "n8n");
const DIST = process.env.SITE_OUT || path.join(ROOT, "dist");
const BASE = process.env.SITE_BASE || "/n8n-onyxia/";
const PAGES_URL = "https://nic01asfr.github.io/n8n-onyxia";

export function echapper(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Typographie française : les guillemets et deux-points ne passent pas
    // seuls à la ligne.
    .replace(/« /g, "«&nbsp;")
    .replace(/ »/g, "&nbsp;»")
    .replace(/ ([:;?!])/g, "&nbsp;$1");
}

export function chargerVitrine(fichier = VITRINE) {
  const v = JSON.parse(fs.readFileSync(fichier, "utf8"));
  for (const k of ["nom", "pitch", "couleur", "depot", "points"]) {
    if (v[k] == null || (Array.isArray(v[k]) && v[k].length === 0)) {
      throw new Error(`vitrine.json: champ requis manquant ou vide: ${k}`);
    }
  }
  if (!v.produit?.sequence?.length) {
    throw new Error("vitrine.json: produit.sequence requis");
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(v.couleur)) {
    throw new Error("vitrine.json: couleur doit être au format #RRGGBB");
  }
  return v;
}

/** Versions du chart, de n8n et du serveur MCP, lues dans le chart lui-même. */
export function lireVersions(chartDir = CHART_DIR) {
  const chart = fs.readFileSync(path.join(chartDir, "Chart.yaml"), "utf8");
  const values = fs.readFileSync(path.join(chartDir, "values.yaml"), "utf8");
  const champ = (texte, re, nom) => {
    const m = texte.match(re);
    if (!m) throw new Error(`version introuvable : ${nom}`);
    return m[1];
  };
  return {
    chart: champ(chart, /^version:\s*"?([^"\s]+)"?/m, "Chart.yaml version"),
    n8n: champ(chart, /^appVersion:\s*"?([^"\s]+)"?/m, "Chart.yaml appVersion"),
    mcp: champ(values, /^mcp:[\s\S]*?\n\s+tag:\s*"?([^"\s]+)"?/m, "values.yaml mcp.image.tag"),
  };
}

const code = (texte) => `<pre class="code"><code>${echapper(texte)}</code></pre>`;

function blocPoints(points) {
  return `<ul class="points">
${points.map((p) => `      <li><b>${echapper(p.titre)}</b> ${echapper(p.texte)}</li>`).join("\n")}
    </ul>`;
}

function blocChiffres(versions) {
  const chiffres = [
    { valeur: versions.n8n, libelle: "version de n8n" },
    { valeur: versions.mcp, libelle: "version du serveur MCP" },
    { valeur: "0", libelle: "droit Kubernetes demandé par le pod" },
    { valeur: "1", libelle: "commande pour tout installer" },
  ];
  return `<div class="chiffres">
${chiffres.map((c) => `      <div><strong>${echapper(c.valeur)}</strong><span>${echapper(c.libelle)}</span></div>`).join("\n")}
    </div>`;
}

function blocFonctionnalites(v) {
  const l = v.fonctionnalites || [];
  if (!l.length) return "";
  return `<section id="fonctionnalites">
    <h2><span class="sec-label">Capacités</span> ${echapper(v.titreFonctionnalites || "Ce que tu peux faire")}</h2>
    <div class="grid">
${l.map((f) => `      <article class="node-card">
        <h3>${echapper(f.titre)}</h3>
        <p>${echapper(f.texte)}</p>
        ${f.pourQui ? `<p class="note">${echapper(f.pourQui)}</p>` : ""}
      </article>`).join("\n")}
    </div>
  </section>`;
}

function blocSequence(produit) {
  return `<section id="parcours">
    <h2><span class="sec-label">Parcours</span> ${echapper(produit.titreSequence || "Le parcours")}</h2>
    <ol class="steps">
${produit.sequence.map((s, i) => `      <li><span class="n">${i + 1}</span><div><b>${echapper(s.titre)}</b><p>${echapper(s.texte)}</p></div></li>`).join("\n")}
    </ol>
  </section>`;
}

function blocInstaller(versions) {
  return `<section id="installer">
    <h2><span class="sec-label">Installer</span> Trois façons de lancer n8n</h2>
    <div class="grid">
      <article class="node-card">
        <h3>Terminal Jupyter</h3>
        <p>Lance un service Jupyter avec le rôle Kubernetes <b>Edit</b>, puis :</p>
        ${code(`curl -sL ${PAGES_URL}/install.sh | bash`)}
        <p class="note">Hôtes, mot de passe et enregistrement dans « Mes services » sont faits pour toi.</p>
      </article>
      <article class="node-card">
        <h3>Catalogue Onyxia</h3>
        <p>Une fois ce dépôt référencé comme catalogue par les administrateurs de ta plateforme, n8n se lance depuis le formulaire, comme les services officiels.</p>
        ${code(`${PAGES_URL}/index.yaml`)}
        <p class="note">Adresse du dépôt Helm à déclarer côté Onyxia.</p>
      </article>
      <article class="node-card">
        <h3>Helm</h3>
        <p>Pour régler chaque valeur toi-même :</p>
        ${code(`helm repo add n8n-onyxia ${PAGES_URL}
helm install n8n n8n-onyxia/n8n --version ${versions.chart} \\
  --set ingress.hostname=user-IDEP-n8n.user.lab.sspcloud.fr \\
  --set mcp.hostname=user-IDEP-n8n-mcp.user.lab.sspcloud.fr \\
  --set ingress.ingressClassName=onyxia \\
  --set security.email=toi@exemple.fr \\
  --set security.password=N8n-motdepasse`)}
      </article>
    </div>
  </section>`;
}

function blocMcp() {
  return `<section id="mcp">
    <h2><span class="sec-label">Assistant</span> Brancher Claude sur ton n8n</h2>
    <p class="lead">Les notes du service donnent l'adresse et le jeton exacts. Avec Claude Code :</p>
    ${code(`claude mcp add n8n --transport http https://user-IDEP-n8n-mcp.user.lab.sspcloud.fr/mcp \\
  --header "Authorization: Bearer <jeton affiché dans les notes>"`)}
    <p class="lead">Puis demande par exemple : « Crée un workflow qui récupère chaque matin le flux RSS de l'Insee et me l'envoie par mail. »</p>
  </section>`;
}

function blocContextes(produit) {
  const l = produit.contextes || [];
  if (!l.length) return "";
  return `<section id="usages">
    <h2><span class="sec-label">Usages</span> ${echapper(produit.titreContextes || "Quand ça compte")}</h2>
    <div class="grid">
${l.map((c) => `      <article class="node-card">
        <h3>${echapper(c.titre)}</h3>
        <p>${echapper(c.texte)}</p>
        ${c.pourquoi ? `<p class="note">${echapper(c.pourquoi)}</p>` : ""}
      </article>`).join("\n")}
    </div>
  </section>`;
}

function blocEncart(encart) {
  if (!encart) return "";
  const lien = encart.lien
    ? `<p><a class="btn ghost" href="${echapper(encart.lien.url)}">${echapper(encart.lien.libelle)}</a></p>`
    : "";
  return `<aside class="encart">
    <h2>${echapper(encart.titre)}</h2>
    <p>${echapper(encart.texte)}</p>
    ${lien}
  </aside>`;
}

function blocStack(stack) {
  if (!stack) return "";
  return `<section id="stack">
    <h2><span class="sec-label">Stack</span> ${echapper(stack.titre)}</h2>
    <p class="lead">${echapper(stack.texte)}</p>
    <div class="tags">${(stack.items || []).map((i) => `<span class="tag">${echapper(i)}</span>`).join("")}</div>
  </section>`;
}

function blocMigration() {
  return `<section id="migration">
    <h2><span class="sec-label">Migration</span> Depuis les charts 0.x</h2>
    <p class="lead">Les charts 0.x installaient n8n 1.x et un chart n8n-mcp séparé. Une seule commande reprend ton instance, avec ses workflows, credentials, webhooks et URL, et la passe sur le chart actuel. Le script refuse de le faire sans que tu le demandes.</p>
    ${code(`curl -sL ${PAGES_URL}/install.sh | MIGRATE=true bash`)}
    <ol class="steps">
      <li><span class="n">1</span><div><b>Sauvegarde</b><p>Archive du volume et clé de chiffrement, dans le dossier courant de ton Jupyter, avant toute modification.</p></div></li>
      <li><span class="n">2</span><div><b>Passage par la dernière n8n 1.x</b><p>n8n ne migre sa base vers 2.x que depuis la dernière 1.x : un saut direct fait perdre aux workflows leur propriétaire. Le script fait donc l'étape intermédiaire.</p></div></li>
      <li><span class="n">3</span><div><b>Passage au chart actuel</b><p>Même volume, même taille, mêmes hôtes. L'ancienne release n8n-mcp est retirée : le serveur MCP intégré reprend son adresse, avec un nouveau jeton affiché dans les notes.</p></div></li>
      <li><span class="n">4</span><div><b>Enregistrement dans Onyxia</b><p>Le service apparaît dans « Mes services », avec ses notes et ses boutons.</p></div></li>
    </ol>
  </section>`;
}

function blocJournal(journal) {
  if (!journal?.length) return "";
  return `<section id="journal">
    <h2><span class="sec-label">Journal</span> Versions</h2>
    <div class="journal">
${journal.map((j) => `      <div><b>${echapper(j.version)}</b><p>${echapper(j.texte)}</p></div>`).join("\n")}
    </div>
  </section>`;
}

/** Aperçu : un workflow n8n dessiné comme dans l'éditeur, nœuds reliés. */
function apercuWorkflow() {
  const noeuds = [
    { x: 16, titre: "Webhook", sous: "POST /webhook" },
    { x: 196, titre: "Code", sous: "transformer" },
    { x: 376, titre: "HTTP Request", sous: "API externe" },
    { x: 556, titre: "Assistant MCP", sous: "Claude, Cursor" },
  ];
  const liens = noeuds.slice(0, -1).map((n) =>
    `<path d="M${n.x + 140} 56 C ${n.x + 160} 56, ${n.x + 160} 56, ${n.x + 180} 56" class="edge"/>`
  ).join("");
  const cartes = noeuds.map((n, i) => `
      <g transform="translate(${n.x} 20)">
        <rect width="140" height="72" rx="10" class="${i === 3 ? "nd nd-accent" : "nd"}"/>
        <circle cx="0" cy="36" r="5" class="port"/><circle cx="140" cy="36" r="5" class="port"/>
        <text x="16" y="32" class="nd-t">${echapper(n.titre)}</text>
        <text x="16" y="52" class="nd-s">${echapper(n.sous)}</text>
      </g>`).join("");
  return `<figure id="apercu" class="apercu" aria-label="Exemple de workflow n8n">
    <div class="canvas">
      <svg viewBox="0 0 712 112" role="img">
        <title>Webhook, puis Code, puis HTTP Request, piloté par un assistant MCP</title>
        ${liens}${cartes}
      </svg>
    </div>
  </figure>`;
}

export function rendreHtml(v, versions, base = BASE) {
  const tags = (v.tags || []).map((t) => `<span class="tag">${echapper(t)}</span>`).join("");
  const accent = v.couleur;
  const depotCourt = v.depot.replace(/^https?:\/\//, "");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${echapper(v.nom)}</title>
  <meta name="description" content="${echapper(v.pitch)}" />
  <meta property="og:title" content="${echapper(v.nom)}" />
  <meta property="og:description" content="${echapper(v.pitch)}" />
  <meta property="og:type" content="website" />
  <meta name="theme-color" content="#1b1a23" />
  <link rel="canonical" href="https://nic01asfr.github.io${echapper(base)}" />
  <link rel="icon" href="assets/n8n.svg" type="image/svg+xml" />
  <base href="${echapper(base)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    /* Jetons repris de l'éditeur n8n : canevas sombre, nœuds gris bleutés,
       corail de marque pour l'accent. */
    :root {
      --accent: ${echapper(accent)};
      --accent-soft: rgba(234, 75, 113, 0.14);
      --bg: #1b1a23;
      --canvas: #16151c;
      --grid: #25242e;
      --node: #2a2934;
      --node-line: #3b3a47;
      --ink: #f1f0f5;
      --soft: #cfcdd8;
      --muted: #9795a6;
      --line: #2e2d39;
      --ok: #4bb98a;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: "Open Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 15px; line-height: 1.6;
      color: var(--ink); background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    ::selection { background: var(--accent-soft); }
    .wrap { width: min(960px, calc(100% - 2.5rem)); margin: 0 auto; }

    .topbar {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 20px; border-bottom: 1px solid var(--line);
      background: var(--canvas);
    }
    .topbar img { width: 22px; height: 22px; }
    .crumb { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--muted); }
    .crumb b { color: var(--soft); font-weight: 600; }
    .status { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }

    header.hero { padding: clamp(2.6rem, 8vw, 4.4rem) 0 1.2rem; }
    .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--accent); margin: 0 0 12px; }
    .brand { font-weight: 700; font-size: clamp(2.2rem, 6.5vw, 3.4rem); letter-spacing: -0.02em; line-height: 1.08; margin: 0 0 0.8rem; }
    .pitch { font-size: clamp(1rem, 2.2vw, 1.13rem); max-width: 44rem; color: var(--soft); margin: 0 0 1.2rem; }
    .tags { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0 0 1.4rem; }
    .tag { font-family: "JetBrains Mono", monospace; font-size: 11px; padding: 3px 9px; border-radius: 999px; background: var(--node); color: var(--soft); border: 1px solid var(--node-line); }
    .cta { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-bottom: 1.4rem; }
    .btn { font-weight: 600; font-size: 13.5px; padding: 9px 16px; border-radius: 8px; display: inline-flex; align-items: center; }
    .btn:hover { text-decoration: none; }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover { filter: brightness(1.08); }
    .btn.ghost { color: var(--soft); border: 1px solid var(--node-line); }
    .btn.ghost:hover { border-color: var(--accent); color: var(--ink); }

    .code {
      margin: 0.6rem 0; padding: 12px 14px; overflow-x: auto;
      background: var(--canvas); border: 1px solid var(--line); border-radius: 8px;
      font-family: "JetBrains Mono", monospace; font-size: 12.5px; line-height: 1.55; color: var(--soft);
    }
    .hero .code { max-width: 44rem; border-left: 3px solid var(--accent); }

    .apercu { margin: 1.6rem 0 0; }
    .canvas {
      overflow-x: auto; border: 1px solid var(--line); border-radius: 12px;
      background-color: var(--canvas);
      background-image: radial-gradient(var(--grid) 1.2px, transparent 1.2px);
      background-size: 20px 20px; padding: 10px;
    }
    .canvas svg { display: block; min-width: 640px; width: 100%; height: auto; }
    .nd { fill: var(--node); stroke: var(--node-line); stroke-width: 1.5; }
    .nd-accent { stroke: var(--accent); }
    .port { fill: var(--muted); }
    .edge { stroke: var(--muted); stroke-width: 2; fill: none; }
    .nd-t { fill: var(--ink); font: 600 13px "Open Sans", sans-serif; }
    .nd-s { fill: var(--muted); font: 11px "JetBrains Mono", monospace; }

    main section, main aside { margin: 2.6rem 0; }
    h2 { font-size: 17px; font-weight: 700; margin: 0 0 1rem; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    h2 .sec-label { font-size: 10.5px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase; color: var(--accent); }
    h3 { font-size: 14.5px; font-weight: 700; margin: 0 0 0.4rem; }
    .lead, .accroche { max-width: 46rem; color: var(--soft); }

    .chiffres { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 1.2rem; }
    .chiffres div { padding: 14px 15px; background: var(--node); border: 1px solid var(--node-line); border-radius: 10px; }
    .chiffres strong { font-family: "JetBrains Mono", monospace; font-size: 1.45rem; display: block; color: var(--ink); }
    .chiffres span { color: var(--muted); font-size: 12.5px; }

    .points { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .points li { padding: 13px 15px; background: var(--node); border: 1px solid var(--node-line); border-radius: 10px; color: var(--soft); }
    .points b { display: block; color: var(--ink); margin-bottom: 0.15rem; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .node-card {
      position: relative; padding: 15px 16px; min-width: 0;
      background: var(--node); border: 1px solid var(--node-line); border-radius: 10px;
    }
    .node-card::before {
      content: ""; position: absolute; left: -6px; top: 22px;
      width: 10px; height: 10px; border-radius: 50%; background: var(--muted);
    }
    .node-card p { margin: 0; color: var(--soft); font-size: 13.8px; }
    .node-card p + p, .node-card .code + p { margin-top: 0.6rem; }
    .note { color: var(--muted) !important; font-size: 12.5px !important; margin-top: 0.6rem !important; }

    .steps { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 10px; }
    .steps li { display: grid; grid-template-columns: 2rem 1fr; gap: 0.8rem; padding: 12px 14px; background: var(--node); border: 1px solid var(--node-line); border-radius: 10px; }
    .steps .n { font-family: "JetBrains Mono", monospace; font-weight: 600; color: var(--accent); }
    .steps p { margin: 0.2rem 0 0; color: var(--muted); font-size: 13.5px; }

    .encart { padding: 16px 18px; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 12px; }
    .encart h2 { margin-bottom: 0.5rem; }
    .encart p { color: var(--soft); margin: 0 0 0.8rem; }

    .journal { border-left: 2px solid var(--line); padding-left: 1.1rem; }
    .journal div { margin-bottom: 1rem; }
    .journal b { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--accent); }
    .journal p { margin: 0.2rem 0 0; color: var(--muted); font-size: 13.5px; }

    footer { margin: 3rem auto 2rem; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
    @media (prefers-reduced-motion: no-preference) {
      .hero .brand, .hero .pitch, .hero .cta, .apercu { animation: rise 0.5s ease both; }
      .hero .pitch { animation-delay: 0.05s; }
      .hero .cta { animation-delay: 0.1s; }
      .apercu { animation-delay: 0.15s; }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <img src="assets/n8n.svg" alt="" />
    <span class="crumb"><b>${echapper(v.nom)}</b> · chart ${echapper(versions.chart)}</span>
    <span class="status"><span class="dot" aria-hidden="true"></span> SSPCloud · Onyxia · open source</span>
  </div>
  <header class="hero">
    <div class="wrap">
      <p class="eyebrow">Service Onyxia</p>
      <h1 class="brand">${echapper(v.nom)}</h1>
      <p class="pitch">${echapper(v.pitch)}</p>
      <div class="tags">${tags}</div>
      <div class="cta">
        <a class="btn primary" href="#installer">Installer</a>
        <a class="btn ghost" href="${echapper(v.depot)}">Code source</a>
      </div>
      ${code(`curl -sL ${PAGES_URL}/install.sh | bash`)}
      ${apercuWorkflow()}
    </div>
  </header>
  <main class="wrap">
    <section id="produit">
      <p class="accroche">${echapper(v.produit.accroche || "")}</p>
      ${blocChiffres(versions)}
    </section>
    <section id="promesse">
      <h2><span class="sec-label">Promesse</span> Ce que ça change</h2>
      ${blocPoints(v.points)}
    </section>
    ${blocFonctionnalites(v)}
    ${blocSequence(v.produit)}
    ${blocInstaller(versions)}
    ${blocMcp()}
    ${blocContextes(v.produit)}
    ${blocEncart(v.encart)}
    ${blocStack(v.stack)}
    ${blocMigration()}
    ${blocJournal(v.journal)}
  </main>
  <footer class="wrap">
    <p>Chart MIT · n8n sous <a href="https://docs.n8n.io/sustainable-use-license/">Sustainable Use License</a> · n8n-mcp MIT · <a href="${echapper(v.depot)}">${echapper(depotCourt)}</a></p>
    <p>Même langage visuel que l'éditeur n8n. Doc technique dans le dépôt. Projet indépendant, non affilié à n8n GmbH.</p>
  </footer>
</body>
</html>
`;
}

export function generate({ vitrinePath = VITRINE, chartDir = CHART_DIR, distDir = DIST, base = BASE } = {}) {
  const v = chargerVitrine(vitrinePath);
  const versions = lireVersions(chartDir);
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  for (const asset of fs.readdirSync(path.join(ROOT, "assets"))) {
    fs.copyFileSync(path.join(ROOT, "assets", asset), path.join(distDir, "assets", asset));
  }
  const html = rendreHtml(v, versions, base);
  const out = path.join(distDir, "index.html");
  fs.writeFileSync(out, html, "utf8");
  return { out, bytes: Buffer.byteLength(html, "utf8"), versions };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = generate();
  console.log(`[site] écrit ${r.out} (${r.bytes} octets, n8n ${r.versions.n8n}, MCP ${r.versions.mcp})`);
}
