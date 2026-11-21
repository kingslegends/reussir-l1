/* Lecteur protégé : déverrouillage par code, bibliothèque, affichage des pages. */
"use strict";

(async () => {
  const $ = (s) => document.querySelector(s);
  const E = RL1.echapper;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.js";
  const CLE_MEMO = "rl1-code";
  const params = new URLSearchParams(location.search);
  let catalogue, config, session = null;

  try {
    [catalogue, config] = await Promise.all([
      RL1.chargerJSON("data/catalogue.json"), RL1.config()]);
  } catch (e) {
    document.querySelector("main").innerHTML = `<p class="erreur">Le site n'a pas pu se charger. Vérifie ta connexion puis recharge la page.</p>`;
    return;
  }
  const modules = Object.fromEntries(catalogue.modules.map((m) => [m.id, m]));

  /* ---------- Déverrouillage ---------- */
  async function lireFicheAcces(id) {
    try {
      return await RL1.chargerJSON(`data/acces/${id}.json`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Code tout juste créé : le site n'est peut-être pas encore republié.
    // On le lit directement dans le dépôt GitHub (public).
    const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/data/acces/${id}.json`;
    const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/vnd.github.raw+json" } });
    if (!r.ok) { const e = new Error("inconnu"); e.status = r.status; throw e; }
    return r.json();
  }

  async function deverrouiller(code) {
    const norm = RL1.normaliser(code);
    if (norm.length !== 12) { const e = new Error("format"); e.code = "format"; throw e; }
    const fiche = await lireFicheAcces(await RL1.idDuCode(norm));
    const cle = await RL1.deriver(norm, RL1.unb64(fiche.salt), fiche.iter);
    return RL1.dechiffrerJSON(cle, fiche);
  }

  function messageErreur(e) {
    if (e.code === "format") return "Un code a 12 caractères après « L1- ». Vérifie que tu l'as bien recopié.";
    if (e.status === 404) return "Ce code est inconnu ou a été désactivé. Si tu viens de le recevoir, attends 2 minutes et réessaie.";
    if (e.status === 403) return "Trop d'essais depuis ce réseau. Réessaie dans quelques minutes.";
    if (e.name === "OperationError") return "Ce code ne correspond pas. Vérifie chaque caractère.";
    return "Connexion impossible. Vérifie ta connexion internet et réessaie.";
  }

  function afficher(vue) {
    $("#vue-connexion").hidden = vue !== "connexion";
    $("#vue-biblio").hidden = vue !== "biblio";
  }

  function afficherBiblio() {
    $("#biblio-titre").textContent = `Bonjour ${session.nom.split(" ")[0]}`;
    $("#biblio-num").textContent = `Exemplaire n° ${String(session.num).padStart(4, "0")}`;
    const ids = Object.keys(session.modules).sort();
    $("#livres").innerHTML = ids.filter((id) => modules[id]).map((id) => {
      const m = modules[id];
      return `<button class="livre" type="button" data-livre="${E(id)}">
        <div class="apercu"><img src="${E(m.vignette)}" alt="" loading="lazy" width="360" height="509"></div>
        <div class="corps"><span class="num">${m.type === "document" ? "DOCUMENT" : `MODULE ${String(m.num).padStart(2, "0")}`} · ${m.pages} PAGES</span><b>${E(m.titre)}</b></div>
      </button>`;
    }).join("");
    afficher("biblio");
  }

  $("#form-code").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#code-erreur");
    const btn = $("#btn-ouvrir");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Vérification…";
    const code = $("#code").value;
    try {
      session = await deverrouiller(code);
      if ($("#memo").checked) RL1.stockage.ecrire(CLE_MEMO, RL1.normaliser(code));
      afficherBiblio();
    } catch (e) {
      err.textContent = messageErreur(e);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Ouvrir mon livre";
    }
  });

  $("#btn-deconnexion").addEventListener("click", () => {
    RL1.stockage.effacer(CLE_MEMO);
    session = null;
    $("#code").value = "";
    afficher("connexion");
  });

  $("#livres").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-livre]");
    if (b) ouvrirModule(b.dataset.livre);
  });

  /* ---------- Lecteur ---------- */
  let pdf = null, zoom = 1, filigrane = null, observateur = null, ratio = 1.414;
  /* Mémoire de lecture (dernière page, marque-pages), par exemplaire et par livre,
     gardée sur cet appareil seulement. */
  let cleLecture = null, dernierePage = 0, attenteSauvegarde;
  const lireEtat = () => {
    try { return JSON.parse(RL1.stockage.lire(cleLecture) || "{}"); } catch (e) { return {}; }
  };
  const ecrireEtat = (maj) => {
    if (cleLecture) RL1.stockage.ecrire(cleLecture, JSON.stringify({ ...lireEtat(), ...maj }));
  };
  const feuilles = [];

  async function telecharger(url, surProgres) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get("Content-Length")) || 0;
    if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
    const lecteur = r.body.getReader();
    const morceaux = [];
    let recu = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recu += value.length;
      surProgres(recu / total);
    }
    const tout = new Uint8Array(recu);
    let pos = 0;
    for (const m of morceaux) { tout.set(m, pos); pos += m.length; }
    return tout;
  }

  function progression(texte, part) {
    $("#chargement").hidden = false;
    $("#pages").hidden = true;
    $("#charg-texte").textContent = texte;
    $("#charg-barre").style.width = `${Math.round(part * 100)}%`;
  }

  async function ouvrirModule(id) {
    const m = modules[id];
    cleLecture = `rl1-lecture-${session.num}-${id}`;
    $("#titre-livre").textContent = m.titre;
    $("#lecteur").hidden = false;
    document.body.style.overflow = "hidden";
    progression("Téléchargement…", 0);
    try {
      const brut = await telecharger(`data/livres/${id}.bin`,
        (p) => progression(`Téléchargement… ${Math.round(p * 100)} %`, p));
      if (brut[0] !== 82 || brut[1] !== 76 || brut[2] !== 49) throw new Error("fichier abîmé");
      progression("Ouverture…", 1);
      const cle = await RL1.importer(RL1.unb64(session.modules[id]));
      const clair = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: brut.subarray(4, 16) }, cle, brut.subarray(16));
      const no = String(session.num).padStart(4, "0");
      filigrane = {
        diag: `${session.nom} · ${session.tel}`,
        pied: `Exemplaire personnel de ${session.nom} · n° ${no} · reproduction et partage interdits`,
      };
      await afficherPDF(new Uint8Array(clair), m.instructions || "");
    } catch (e) {
      progression("Impossible d'ouvrir ce livre. Vérifie ta connexion et réessaie.", 0);
    }
  }

  async function ouvrirExtrait() {
    cleLecture = "rl1-lecture-extrait";
    $("#titre-livre").textContent = "Extrait gratuit";
    $("#btn-retour").textContent = "← Accueil";
    $("#lecteur").hidden = false;
    document.body.style.overflow = "hidden";
    progression("Téléchargement…", 0);
    try {
      const brut = await telecharger("extrait/Extrait_gratuit_Guide_L1.pdf",
        (p) => progression(`Téléchargement… ${Math.round(p * 100)} %`, p));
      filigrane = { diag: "", pied: "" };
      await afficherPDF(brut);
    } catch (e) {
      progression("Impossible d'ouvrir l'extrait. Vérifie ta connexion et réessaie.", 0);
    }
  }

  async function afficherPDF(donnees, consigne = "") {
    fermerPDF();
    pdf = await pdfjsLib.getDocument({ data: donnees, isEvalSupported: false }).promise;
    const p1 = await pdf.getPage(1);
    const v = p1.getViewport({ scale: 1 });
    ratio = v.height / v.width;
    const conteneur = $("#pages");
    conteneur.innerHTML = "";
    feuilles.length = 0;
    if (consigne) {
      // message de l'auteur, affiché au-dessus de la première page
      const note = document.createElement("aside");
      note.className = "consigne";
      note.innerHTML = `<b>À lire avant de commencer</b><p></p><button type="button">Compris</button>`;
      note.querySelector("p").textContent = consigne;
      note.querySelector("button").addEventListener("click", () => note.remove());
      conteneur.appendChild(note);
    }
    for (let i = 1; i <= pdf.numPages; i++) {
      const div = document.createElement("div");
      div.className = "feuille";
      div.dataset.page = i;
      conteneur.appendChild(div);
      feuilles.push({ div, rendue: false, tache: null, jeton: 0 });
    }
    $("#total-pages").textContent = pdf.numPages;
    $("#saut").value = 1;
    dimensionner();
    $("#chargement").hidden = true;
    conteneur.hidden = false;
    $("#zone").scrollTop = 0;
    observateur = new IntersectionObserver(surVisibilite, { root: $("#zone"), rootMargin: "150% 0px" });
    feuilles.forEach((f) => observateur.observe(f.div));
    construireSommaire();
    afficherMarques();
    const etat = lireEtat();
    dernierePage = 1;
    if (etat.page > 1 && etat.page <= pdf.numPages) {
      allerA(etat.page);
      montrerToast(`Reprise à la page ${etat.page}`, "Revenir au début", () => allerA(1));
    }
  }

  let attenteToast;
  function montrerToast(texte, action, faire) {
    $("#toast-texte").textContent = texte;
    $("#toast-action").textContent = action;
    $("#toast-action").onclick = () => { faire(); $("#toast").hidden = true; };
    $("#toast").hidden = false;
    clearTimeout(attenteToast);
    attenteToast = setTimeout(() => { $("#toast").hidden = true; }, 7000);
  }

  function largeurFeuille() {
    const dispo = $("#zone").clientWidth - 16;
    return dispo > 0 ? Math.min(dispo, 900) * zoom : 0; // 0 : zone pas encore affichée
  }

  function dimensionner() {
    const l = largeurFeuille();
    if (!l) return;
    for (const f of feuilles) {
      f.div.style.width = `${l}px`;
      f.div.style.height = `${l * ratio}px`;
    }
  }

  function surVisibilite(entrees) {
    for (const en of entrees) {
      const f = feuilles[Number(en.target.dataset.page) - 1];
      if (en.isIntersecting) { if (!f.rendue) rendre(f); } else if (f.rendue) liberer(f);
    }
    majNumero();
  }

  async function rendre(f) {
    f.rendue = true;
    const jeton = ++f.jeton;
    const n = Number(f.div.dataset.page);
    let page;
    try {
      page = await pdf.getPage(n);
    } catch (e) {
      f.rendue = false; // livre fermé entre-temps ou page illisible
      return;
    }
    if (jeton !== f.jeton) return;
    const l = largeurFeuille();
    if (!l) { f.rendue = false; return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (l * dpr) / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    const ctx = canvas.getContext("2d");
    f.tache = page.render({ canvasContext: ctx, viewport: vp });
    try {
      await f.tache.promise;
    } catch (e) {
      return; // rendu annulé (page sortie de l'écran ou zoom)
    }
    if (jeton !== f.jeton) return;
    poserFiligrane(ctx, canvas.width, canvas.height);
    f.div.replaceChildren(canvas);
  }

  function liberer(f) {
    f.rendue = false;
    f.jeton++;
    if (f.tache) f.tache.cancel();
    const c = f.div.querySelector("canvas");
    if (c) { c.width = 0; c.height = 0; }
    f.div.replaceChildren();
  }

  function poserFiligrane(ctx, w, h) {
    if (!filigrane || !filigrane.diag) return;
    ctx.save();
    const t = Math.max(12, w / 34);
    ctx.font = `600 ${t}px Inter, sans-serif`;
    ctx.fillStyle = "rgba(15, 29, 58, 0.075)";
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.atan(h / w));
    for (let y = -h; y <= h; y += t * 7) {
      ctx.fillText(filigrane.diag, -ctx.measureText(filigrane.diag).width / 2, y);
    }
    ctx.restore();
    ctx.save();
    const p = Math.max(9, w / 95);
    ctx.font = `500 ${p}px Inter, sans-serif`;
    ctx.fillStyle = "rgba(140, 26, 26, 0.75)";
    ctx.fillText(filigrane.pied, w * 0.06, h - p * 0.9);
    ctx.restore();
  }

  function majNumero() {
    const zone = $("#zone");
    const milieu = zone.scrollTop + zone.clientHeight / 3;
    let n = 1;
    for (const f of feuilles) { if (f.div.offsetTop <= milieu) n = Number(f.div.dataset.page); else break; }
    if (document.activeElement !== $("#saut")) $("#saut").value = n;
    if (feuilles.length && n !== dernierePage) {
      dernierePage = n;
      clearTimeout(attenteSauvegarde);
      attenteSauvegarde = setTimeout(() => ecrireEtat({ page: n }), 800);
    }
  }
  const pageCourante = () => parseInt($("#saut").value, 10) || 1;

  function allerA(n) {
    const f = feuilles[Math.max(1, Math.min(n, feuilles.length)) - 1];
    if (f) $("#zone").scrollTop = f.div.offsetTop - 8;
  }

  async function construireSommaire() {
    const nav = $("#sommaire");
    nav.innerHTML = "<p class=\"note\">Chargement du sommaire…</p>";
    let plan = [];
    try { plan = (await pdf.getOutline()) || []; } catch (e) { plan = []; }
    const items = [];
    const ajouter = async (it, niveau) => {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch (e) { page = null; }
      if (page) items.push(`<button type="button" class="n${Math.min(niveau, 4)}" data-page="${page}">${E(it.title)}</button>`);
      for (const enfant of it.items || []) await ajouter(enfant, niveau + 1);
    };
    for (const it of plan) await ajouter(it, 1);
    nav.innerHTML = items.length ? items.join("") : "<p class=\"note\">Pas de sommaire pour ce document.</p>";
  }

  function fermerPDF() {
    rechercheJeton++;
    textes.clear();
    $("#resultats").innerHTML = "";
    $("#recherche-etat").textContent = "";
    $("#toast").hidden = true;
    if (observateur) observateur.disconnect();
    feuilles.forEach(liberer);
    if (pdf) pdf.destroy();
    pdf = null;
  }

  $("#zone").addEventListener("scroll", () => requestAnimationFrame(majNumero), { passive: true });
  $("#saut").addEventListener("change", (e) => allerA(parseInt(e.target.value, 10) || 1));
  const basculer = (ouvrir, fermer) => {
    $(ouvrir).hidden = !$(ouvrir).hidden;
    $(fermer).hidden = true;
    $("#btn-outils").setAttribute("aria-expanded", String(!$("#panneau-outils").hidden));
  };
  $("#btn-sommaire").addEventListener("click", () => basculer("#sommaire", "#panneau-outils"));
  $("#btn-outils").addEventListener("click", () => basculer("#panneau-outils", "#sommaire"));
  $("#sommaire").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b) { allerA(Number(b.dataset.page)); $("#sommaire").hidden = true; }
  });
  const changerZoom = (facteur) => {
    const zone = $("#zone");
    const part = zone.scrollTop / Math.max(1, zone.scrollHeight);
    zoom = Math.max(0.6, Math.min(2.5, zoom * facteur));
    feuilles.forEach((f) => { if (f.rendue) liberer(f); });
    dimensionner();
    zone.scrollTop = part * zone.scrollHeight;
    observateur.disconnect();
    feuilles.forEach((f) => observateur.observe(f.div));
  };
  $("#btn-plus").addEventListener("click", () => changerZoom(1.2));
  $("#btn-moins").addEventListener("click", () => changerZoom(1 / 1.2));
  $("#btn-plus2").addEventListener("click", () => changerZoom(1.2));
  $("#btn-moins2").addEventListener("click", () => changerZoom(1 / 1.2));

  /* ---------- Outils : recherche, marque-pages, mode nuit, plein écran ---------- */
  const textes = new Map();
  let rechercheJeton = 0;
  const plier = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  async function rechercher(q) {
    const etat = $("#recherche-etat");
    const cible = plier(q.trim());
    const jeton = ++rechercheJeton;
    const doc = pdf;
    $("#resultats").innerHTML = "";
    if (cible.length < 2) { etat.textContent = "Tape au moins 2 lettres."; return; }
    const trouves = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (jeton !== rechercheJeton || doc !== pdf) return; // nouvelle recherche ou livre fermé
      let t = textes.get(i);
      if (t === undefined) {
        try {
          const contenu = await (await doc.getPage(i)).getTextContent();
          t = contenu.items.map((x) => x.str).join(" ").replace(/\s+/g, " ");
        } catch (e) { t = ""; }
        textes.set(i, t);
      }
      const pos = plier(t).indexOf(cible);
      if (pos >= 0) trouves.push({ page: i, extrait: t.slice(Math.max(0, pos - 45), pos + cible.length + 45) });
      if (i % 15 === 0) etat.textContent = `Recherche… page ${i} sur ${doc.numPages}`;
      if (trouves.length >= 80) break;
    }
    etat.textContent = trouves.length
      ? `${trouves.length >= 80 ? "Plus de 80" : trouves.length} page${trouves.length > 1 ? "s" : ""} trouvée${trouves.length > 1 ? "s" : ""}.`
      : "Aucun résultat. Essaie un autre mot.";
    $("#resultats").innerHTML = trouves.map((r) =>
      `<button type="button" data-page="${r.page}">Page ${r.page}<small>…${E(r.extrait)}…</small></button>`).join("");
  }
  $("#form-recherche").addEventListener("submit", (e) => { e.preventDefault(); if (pdf) rechercher($("#q").value); });

  function afficherMarques() {
    const marques = lireEtat().marques || [];
    $("#marques").innerHTML = marques.length
      ? marques.map((p) => `<div class="marque"><button type="button" data-page="${p}">Page ${p}</button><button type="button" data-retirer="${p}" aria-label="Retirer le marque-page de la page ${p}">✕</button></div>`).join("")
      : `<p class="note">Aucun marque-page pour l'instant.</p>`;
  }
  $("#btn-marquer").addEventListener("click", () => {
    const p = pageCourante();
    const marques = new Set(lireEtat().marques || []);
    marques.add(p);
    ecrireEtat({ marques: [...marques].sort((a, b) => a - b) });
    afficherMarques();
  });
  $("#panneau-outils").addEventListener("click", (e) => {
    const retirer = e.target.closest("[data-retirer]");
    if (retirer) {
      const p = Number(retirer.dataset.retirer);
      ecrireEtat({ marques: (lireEtat().marques || []).filter((x) => x !== p) });
      afficherMarques();
      return;
    }
    const aller = e.target.closest("[data-page]");
    if (aller) {
      allerA(Number(aller.dataset.page));
      if (window.innerWidth < 760) $("#panneau-outils").hidden = true; // sur téléphone, on libère l'écran
    }
  });

  const appliquerNuit = (actif) => {
    $("#lecteur").classList.toggle("nuit", actif);
    $("#btn-nuit").setAttribute("aria-pressed", String(actif));
  };
  appliquerNuit(RL1.stockage.lire("rl1-nuit") === "1");
  $("#btn-nuit").addEventListener("click", () => {
    const actif = !$("#lecteur").classList.contains("nuit");
    appliquerNuit(actif);
    RL1.stockage.ecrire("rl1-nuit", actif ? "1" : "0");
  });

  if (!document.fullscreenEnabled) $("#btn-plein").hidden = true;
  $("#btn-plein").addEventListener("click", () => {
    const fin = () => {};
    if (document.fullscreenElement) document.exitFullscreen().catch(fin);
    else $("#lecteur").requestFullscreen().catch(fin);
  });
  document.addEventListener("fullscreenchange", () => {
    $("#btn-plein").textContent = document.fullscreenElement ? "Quitter le plein écran" : "Plein écran";
  });
  /* Redimensionne quand la zone de lecture change de largeur
     (rotation du téléphone, fenêtre agrandie, zone affichée après coup). */
  let attente, largeurVue = 0;
  new ResizeObserver(() => {
    const w = $("#zone").clientWidth;
    if (!pdf || !observateur || w === largeurVue) return;
    largeurVue = w;
    clearTimeout(attente);
    attente = setTimeout(() => changerZoom(1), 200);
  }).observe($("#zone"));
  $("#btn-retour").addEventListener("click", () => {
    if (params.get("extrait")) { location.href = "./"; return; }
    fermerPDF();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $("#lecteur").hidden = true;
    $("#sommaire").hidden = true;
    $("#panneau-outils").hidden = true;
    document.body.style.overflow = "";
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["s", "p"].includes(e.key.toLowerCase())) e.preventDefault();
  });

  /* ---------- Démarrage ---------- */
  if (params.get("extrait")) { ouvrirExtrait(); return; }
  const memo = RL1.stockage.lire(CLE_MEMO);
  if (memo) {
    try {
      session = await deverrouiller(memo);
      afficherBiblio();
      return;
    } catch (e) {
      RL1.stockage.effacer(CLE_MEMO);
    }
  }
  afficher("connexion");
})();
