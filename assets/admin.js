/* Espace vendeur : création des codes, suivi des ventes, réglages. */
"use strict";

(async () => {
  const $ = (s) => document.querySelector(s);
  const E = RL1.echapper;
  const enc = new TextEncoder();
  let catalogue, config, adminFichier, secrets = null, cleAdmin = null;
  let derniereVente = null;

  try {
    [catalogue, config] = await Promise.all([
      RL1.chargerJSON("data/catalogue.json"), RL1.config()]);
  } catch (e) {
    $("#login-erreur").textContent = "Le site n'a pas pu se charger. Vérifie ta connexion.";
    $("#login-erreur").hidden = false;
    return;
  }
  let produits = Object.fromEntries(catalogue.produits.map((p) => [p.id, p]));
  const indexer = () => { produits = Object.fromEntries(catalogue.produits.map((p) => [p.id, p])); };

  /* ---------- GitHub ---------- */
  const gh = {
    get owner() { return RL1.stockage.lire("rl1-owner") || config.github_owner; },
    get repo() { return RL1.stockage.lire("rl1-repo") || config.github_repo; },
    jeton: "", // déchiffré en mémoire après connexion, jamais stocké en clair
    get token() { return this.jeton; },
    async appel(chemin, options = {}) {
      if (!this.token) { const e = new Error("pas de jeton"); e.status = 0; throw e; }
      const r = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${chemin}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", ...(options.headers || {}) },
        cache: "no-store",
      });
      if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
      return r.status === 204 ? null : r.json();
    },
    async ecrire(chemin, objet, message, sha) {
      const corps = { message, content: RL1.b64(enc.encode(JSON.stringify(objet))) };
      if (sha) corps.sha = sha;
      return this.appel(`/contents/${chemin}`, { method: "PUT", body: JSON.stringify(corps) });
    },
    async lireBrut(chemin) {
      return this.appel(`/contents/${chemin}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    },
    /* Publie plusieurs fichiers en un seul envoi (tout ou rien) :
       fichiers = [{ chemin, b64 }]. Si une vente arrive pendant l'envoi,
       on recommence une fois sur la version la plus récente. */
    async publier(fichiers, message) {
      const depot = await this.appel("");
      const branche = depot.default_branch || "main";
      const blobs = [];
      for (const f of fichiers) {
        const b = await this.appel("/git/blobs", { method: "POST", body: JSON.stringify({ content: f.b64, encoding: "base64" }) });
        blobs.push({ path: f.chemin, mode: "100644", type: "blob", sha: b.sha });
      }
      for (let essai = 0; essai < 2; essai++) {
        const ref = await this.appel(`/git/ref/heads/${branche}`);
        const base = await this.appel(`/git/commits/${ref.object.sha}`);
        const arbre = await this.appel("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree: blobs }) });
        const commit = await this.appel("/git/commits", { method: "POST", body: JSON.stringify({ message, tree: arbre.sha, parents: [ref.object.sha] }) });
        try {
          await this.appel(`/git/refs/heads/${branche}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
          return;
        } catch (e) {
          if (e.status !== 422 || essai === 1) throw e;
        }
      }
    },
  };
  const b64json = (o) => RL1.b64(enc.encode(JSON.stringify(o, null, 1)));

  /* ---------- Connexion ---------- */
  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#login-erreur");
    const btn = $("#btn-login");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Vérification…";
    try {
      const mdp = $("#mdp").value;
      try {
        adminFichier = await RL1.chargerJSON("data/admin.json");
        cleAdmin = await RL1.deriver(mdp, RL1.unb64(adminFichier.salt), adminFichier.iter);
        secrets = await RL1.dechiffrerJSON(cleAdmin, adminFichier);
      } catch (e) {
        if (e.name !== "OperationError") throw e;
        // mot de passe tout juste changé : le site peut garder l'ancien fichier
        // quelques minutes ; on lit la version du dépôt GitHub.
        try {
          const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/data/admin.json`,
            { cache: "no-store", headers: { Accept: "application/vnd.github.raw+json" } });
          if (!r.ok) throw e;
          const frais = await r.json();
          const cle = await RL1.deriver(mdp, RL1.unb64(frais.salt), frais.iter);
          secrets = await RL1.dechiffrerJSON(cle, frais);
          adminFichier = frais;
          cleAdmin = cle;
        } catch (e2) {
          throw e; // c'est bien le mot de passe qui est faux
        }
      }
      $("#mdp").value = "";
      await chargerJeton();
      await rafraichirDepuisDepot();
      $("#vue-login").hidden = true;
      $("#vue-admin").hidden = false;
      remplirFormulaire();
      if (!gh.token) choisirOnglet("reglages");
    } catch (e) {
      err.textContent = e.name === "OperationError" ? "Mot de passe incorrect." : "Impossible de charger les données. Vérifie ta connexion.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Entrer";
    }
  });

  /* Le jeton GitHub est rangé chiffré (clé tirée du mot de passe
     administrateur) : sans le mot de passe, il est inutilisable. */
  async function cleJeton() { return RL1.importer(RL1.unb64(secrets.dk)); }
  async function chargerJeton() {
    RL1.stockage.effacer("rl1-token"); // ancien format en clair
    const brut = RL1.stockage.lire("rl1-token-chiffre");
    if (!brut) { gh.jeton = ""; return; }
    try {
      gh.jeton = (await RL1.dechiffrerJSON(await cleJeton(), JSON.parse(brut))).t;
    } catch (e) {
      gh.jeton = "";
      RL1.stockage.effacer("rl1-token-chiffre");
    }
  }
  async function enregistrerJeton(t) {
    gh.jeton = t;
    if (!t) { RL1.stockage.effacer("rl1-token-chiffre"); return; }
    RL1.stockage.ecrire("rl1-token-chiffre", JSON.stringify(await RL1.chiffrerJSON(await cleJeton(), { t })));
  }

  /* Le site peut garder quelques minutes une ancienne version des fichiers :
     avec le jeton, on relit le catalogue et les clés directement dans le dépôt. */
  async function rafraichirDepuisDepot() {
    if (!gh.token) return;
    try {
      const cat = await gh.lireBrut("data/catalogue.json");
      if (cat && Array.isArray(cat.produits)) { catalogue = cat; indexer(); }
    } catch (e) { /* on garde la version du site */ }
    try {
      const frais = await gh.lireBrut("data/admin.json");
      if (frais.salt === adminFichier.salt) {
        secrets = await RL1.dechiffrerJSON(cleAdmin, frais);
        adminFichier = frais;
      }
    } catch (e) { /* on garde la version du site */ }
  }

  function choisirOnglet(nom) {
    document.querySelectorAll("[data-onglet]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.onglet === nom)));
    document.querySelectorAll("[data-panneau]").forEach((p) => { p.hidden = p.dataset.panneau !== nom; });
    if (nom === "ventes") chargerVentes();
    if (nom === "catalogue") afficherCatalogue();
    if (nom === "site") afficherSite();
    if (nom === "reglages") {
      $("#g-owner").value = gh.owner;
      $("#g-repo").value = gh.repo;
      $("#g-token").value = gh.token;
      $("#g-etat").textContent = gh.token ? "Jeton enregistré sur cet appareil." : "Aucun jeton : ajoute-le pour publier les codes automatiquement.";
    }
  }
  document.querySelector(".onglets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-onglet]");
    if (b) choisirOnglet(b.dataset.onglet);
  });

  /* ---------- Nouvelle vente ---------- */
  const majPrix = () => { $("#v-prix").value = produits[$("#v-produit").value].prix; };
  $("#v-produit").addEventListener("change", majPrix);
  function remplirFormulaire() {
    $("#v-produit").innerHTML = catalogue.produits.map((p) => `<option value="${E(p.id)}">${E(p.titre)} — ${RL1.prix(p.prix)}${p.masque ? " (masqué)" : ""}</option>`).join("");
    majPrix();
  }

  const telWa = (tel) => {
    const d = String(tel).replace(/\D/g, "");
    return d.length === 8 ? "228" + d : d;
  };
  const urlSite = () => location.href.replace(/admin\.html.*$/, "");

  /* Numéro d'exemplaire : compteur partagé data/compteur.json dans le dépôt
     (les codes bloqués ne libèrent pas leur numéro). */
  async function prochainNumero() {
    const local = Number(RL1.stockage.lire("rl1-num") || 0);
    try {
      let actuel = 0, sha;
      try {
        const info = await gh.appel("/contents/data/compteur.json");
        sha = info.sha;
        actuel = Number((await gh.lireBrut("data/compteur.json")).n) || 0;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const n = Math.max(actuel, local) + 1;
      await gh.ecrire("data/compteur.json", { n }, `Exemplaire n° ${n}`, sha);
      return n;
    } catch (e) {
      return local + 1; // hors ligne ou sans jeton : compteur de cet appareil
    }
  }

  $("#form-vente").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#vente-erreur");
    const btn = $("#btn-vente");
    const nom = $("#v-nom").value.trim();
    const tel = $("#v-tel").value.trim();
    const prixRecu = Number($("#v-prix").value);
    if (nom.length < 3 || tel.replace(/\D/g, "").length < 8 || !(prixRecu >= 0)) {
      err.textContent = "Renseigne le nom, le numéro WhatsApp (8 chiffres au moins) et le montant.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Création…";
    try {
      const p = produits[$("#v-produit").value];
      const num = await prochainNumero();
      const code = RL1.nouveauCode();
      const norm = RL1.normaliser(code);
      const date = new Date().toISOString().slice(0, 10);
      const cles = {};
      for (const id of p.modules) cles[id] = secrets.keys[id];
      const sel = crypto.getRandomValues(new Uint8Array(16));
      const cleCode = await RL1.deriver(norm, sel, RL1.ITER_CODE);
      const boite = await RL1.chiffrerJSON(cleCode, { nom, tel, num, date, produit: p.titre, modules: cles });
      const cleDonnees = await RL1.importer(RL1.unb64(secrets.dk));
      const a = await RL1.chiffrerJSON(cleDonnees, {
        num, date, nom, tel, produit: p.id, titre: p.titre, prix: prixRecu,
        operateur: $("#v-op").value, ref: $("#v-ref").value.trim(),
        ambassadeur: $("#v-amb").value.trim().toUpperCase() });
      const fiche = { v: 1, salt: RL1.b64(sel), iter: RL1.ITER_CODE, ...boite, a };
      const id = await RL1.idDuCode(norm);
      derniereVente = { code, nom, tel, num, p, fiche, id };
      RL1.stockage.ecrire("rl1-num", String(num));

      let publie = false;
      try {
        await gh.ecrire(`data/acces/${id}.json`, fiche, `Vente n° ${num}`);
        publie = true;
      } catch (e) {
        publie = false;
        derniereVente.erreur = messageGitHub(e);
      }
      afficherResultat(publie);
      $("#form-vente").reset();
      remplirFormulaire();
    } catch (e) {
      err.textContent = "La création du code a échoué. Réessaie.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Créer le code";
    }
  });

  function messageClient(v) {
    return [
      `Bonjour ${v.nom.split(" ")[0]}, merci pour ton achat : ${v.p.titre}.`,
      "",
      `Ton code d'accès personnel : ${v.code}`,
      "",
      `Pour lire : ${urlSite()}lire.html`,
      "Saisis ton code, puis ouvre tes modules.",
      "Ce code est à toi seul : ton nom apparaît sur chaque page.",
    ].join("\n");
  }

  function afficherResultat(publie) {
    const v = derniereVente;
    $("#resultat").hidden = false;
    $("#r-titre").textContent = `n° ${String(v.num).padStart(4, "0")} · ${v.nom} · ${v.p.titre}`;
    $("#r-code").textContent = v.code;
    $("#r-etat").innerHTML = publie
      ? `<span class="succes">Code enregistré sur le site. Il fonctionne tout de suite.</span>`
      : `<span class="erreur">Code pas encore enregistré sur le site. ${E(v.erreur || "")}</span>`;
    $("#r-manuel").hidden = publie;
    $("#r-wa").href = `https://wa.me/${telWa(v.tel)}?text=${encodeURIComponent(messageClient(v))}`;
    $("#resultat").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("#r-copier").addEventListener("click", () => {
    if (!derniereVente || !navigator.clipboard) return;
    navigator.clipboard.writeText(messageClient(derniereVente)).then(
      () => { $("#r-copier").textContent = "Message copié"; setTimeout(() => { $("#r-copier").textContent = "Copier le message"; }, 1500); },
      () => {});
  });

  $("#r-telecharger").addEventListener("click", () => {
    if (!derniereVente) return;
    const blob = new Blob([JSON.stringify(derniereVente.fiche)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${derniereVente.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ---------- Ventes ---------- */
  let ventes = [];
  async function chargerVentes(apres = "") {
    const etat = $("#ventes-etat");
    if (!gh.token) { etat.innerHTML = `<span class="erreur">Ajoute ton jeton GitHub dans « Réglages » pour voir les ventes.</span>`; return; }
    etat.textContent = "Chargement des ventes…";
    try {
      let liste = [];
      try { liste = await gh.appel("/contents/data/acces"); } catch (e) { if (e.status !== 404) throw e; }
      liste = liste.filter((f) => f.name.endsWith(".json"));
      const cle = await RL1.importer(RL1.unb64(secrets.dk));
      ventes = [];
      const lots = 6;
      for (let i = 0; i < liste.length; i += lots) {
        const res = await Promise.all(liste.slice(i, i + lots).map(async (f) => {
          try {
            const fiche = await gh.lireBrut(f.path);
            const info = await RL1.dechiffrerJSON(cle, fiche.a);
            return { ...info, chemin: f.path, sha: f.sha };
          } catch (e) { return null; }
        }));
        ventes.push(...res.filter(Boolean));
      }
      ventes.sort((x, y) => y.num - x.num);
      afficherVentes();
      etat.innerHTML = apres || (ventes.length ? "" : "Aucune vente pour l'instant.");
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${e.status === 401 ? "Jeton refusé par GitHub : vérifie-le dans « Réglages »." : "Chargement impossible. Vérifie ta connexion."}</span>`;
    }
  }

  function afficherVentes() {
    const total = ventes.reduce((s, v) => s + (Number(v.prix) || 0), 0);
    const auj = new Date().toISOString().slice(0, 10);
    const duJour = ventes.filter((v) => v.date === auj);
    const parOp = (op) => ventes.filter((v) => v.operateur === op).reduce((s, v) => s + (Number(v.prix) || 0), 0);
    $("#chiffres").innerHTML = `
      <div class="chiffre"><span>Ventes</span><b>${ventes.length}</b></div>
      <div class="chiffre"><span>Encaissé</span><b>${RL1.prix(total)}</b></div>
      <div class="chiffre"><span>Aujourd'hui</span><b>${duJour.length} · ${RL1.prix(duJour.reduce((s, v) => s + (Number(v.prix) || 0), 0))}</b></div>
      <div class="chiffre"><span>T-Money / Flooz</span><b style="font-size:1.1rem">${RL1.prix(parOp("T-Money"))} / ${RL1.prix(parOp("Flooz"))}</b></div>`;
    const amb = {};
    for (const v of ventes) if (v.ambassadeur) amb[v.ambassadeur] = (amb[v.ambassadeur] || 0) + 1;
    const lignesAmb = Object.entries(amb).sort((a, b) => b[1] - a[1]);
    $("#ambassadeurs").innerHTML = lignesAmb.length
      ? `<p class="note" style="margin-bottom:14px"><b>À verser aux ambassadeurs :</b> ${lignesAmb.map(([c, n]) => `${E(c)} : ${n} vente${n > 1 ? "s" : ""} = ${RL1.prix(n * config.commission_ambassadeur)}`).join(" · ")}</p>`
      : "";
    $("#ventes-corps").innerHTML = ventes.map((v, i) => `<tr>
      <td class="n">${String(v.num).padStart(4, "0")}</td><td class="n">${E(v.date)}</td>
      <td>${E(v.nom)}<br><span class="note">${E(v.tel)}</span></td><td>${E(v.titre)}</td>
      <td class="n">${RL1.prix(Number(v.prix) || 0)}</td><td>${E(v.operateur)}<br><span class="note">${E(v.ref)}</span></td>
      <td>${E(v.ambassadeur || "—")}</td>
      <td><button class="btn-petit" type="button" data-bloquer="${i}">Bloquer</button></td></tr>`).join("");
  }

  $("#btn-actualiser").addEventListener("click", () => chargerVentes());
  $("#ventes-corps").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-bloquer]");
    if (!b) return;
    const v = ventes[Number(b.dataset.bloquer)];
    if (b.dataset.confirme !== "1") {
      b.dataset.confirme = "1";
      b.textContent = "Confirmer ?";
      setTimeout(() => { b.dataset.confirme = ""; b.textContent = "Bloquer"; }, 4000);
      return;
    }
    b.disabled = true;
    b.textContent = "…";
    try {
      await gh.appel(`/contents/${v.chemin}`, { method: "DELETE", body: JSON.stringify({ message: `Code n° ${v.num} bloqué`, sha: v.sha }) });
      chargerVentes(`<span class="succes">Code n° ${String(v.num).padStart(4, "0")} (${E(v.nom)}) bloqué : il ne fonctionne plus.</span>`);
    } catch (err) {
      b.disabled = false;
      b.textContent = "Bloquer";
      $("#ventes-etat").innerHTML = `<span class="erreur">Le blocage a échoué. Réessaie.</span>`;
    }
  });


  /* ---------- Catalogue : prix, produits masqués, documents ---------- */
  const modulesParId = () => Object.fromEntries(catalogue.modules.map((m) => [m.id, m]));
  let docEnCours = null; // id du document en cours de modification

  function afficherCatalogue() {
    if (!gh.token) $("#produits-etat").innerHTML = `<span class="erreur">Ajoute ton jeton GitHub dans « Réglages » pour pouvoir enregistrer.</span>`;
    $("#produits-corps").innerHTML = catalogue.produits.map((p, i) => `<tr>
      <td>${E(p.titre)}</td>
      <td><span class="type">${p.type === "document" ? "Document" : p.modules.length > 3 ? "Pack" : "Matière"}</span></td>
      <td><input type="number" min="0" step="50" id="pp-${i}" value="${Number(p.prix) || 0}" aria-label="Prix de ${E(p.titre)}"></td>
      <td><input type="checkbox" id="pv-${i}" ${p.masque ? "" : "checked"} aria-label="${E(p.titre)} en vente"></td>
      <td>${p.type === "document" ? `<button class="btn-lien" type="button" data-modifier="${E(p.id)}">Modifier</button>` : ""}</td></tr>`).join("");
  }

  $("#btn-produits").addEventListener("click", async () => {
    const etat = $("#produits-etat");
    const btn = $("#btn-produits");
    const nouveau = structuredClone(catalogue);
    for (let i = 0; i < nouveau.produits.length; i++) {
      const prix = Number($(`#pp-${i}`).value);
      if (!(prix >= 0)) { etat.innerHTML = `<span class="erreur">Un prix est vide ou incorrect.</span>`; return; }
      nouveau.produits[i].prix = Math.round(prix);
      if ($(`#pv-${i}`).checked) delete nouveau.produits[i].masque; else nouveau.produits[i].masque = true;
    }
    if (!nouveau.produits.some((p) => !p.masque)) { etat.innerHTML = `<span class="erreur">Garde au moins un produit en vente.</span>`; return; }
    btn.disabled = true;
    etat.textContent = "Enregistrement…";
    try {
      await gh.publier([{ chemin: "data/catalogue.json", b64: b64json(nouveau) }], "Catalogue : prix et produits en vente");
      catalogue = nouveau; indexer(); remplirFormulaire(); afficherCatalogue();
      etat.innerHTML = `<span class="succes">Enregistré. Le site sera à jour d'ici 1 à 2 minutes.</span>`;
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${messageGitHub(e)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });

  $("#produits-corps").addEventListener("click", (e) => {
    const b = e.target.closest("[data-modifier]");
    if (!b) return;
    const p = produits[b.dataset.modifier];
    const m = modulesParId()[p.id];
    docEnCours = p.id;
    $("#doc-titre-form").textContent = `Modifier « ${p.titre} »`;
    $("#d-fichier-aide").textContent = "Facultatif : choisis un fichier seulement pour remplacer le PDF. Les acheteurs gardent l'accès.";
    $("#d-titre").value = p.titre;
    $("#d-prix").value = p.prix;
    $("#d-accroche").value = (m && m.accroche) || "";
    $("#d-instructions").value = (m && m.instructions) || "";
    $("#d-visible").checked = !p.masque;
    $("#btn-doc").textContent = "Enregistrer les modifications";
    $("#btn-doc-annuler").hidden = false;
    $("#doc-etat").textContent = "";
    $("#form-doc").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function reinitialiserDoc() {
    docEnCours = null;
    $("#form-doc").reset();
    $("#d-prix").value = 1000;
    $("#doc-titre-form").textContent = "Ajouter un document";
    $("#d-fichier-aide").textContent = "50 Mo au maximum.";
    $("#btn-doc").textContent = "Publier le document";
    $("#btn-doc-annuler").hidden = true;
  }
  $("#btn-doc-annuler").addEventListener("click", reinitialiserDoc);

  /* Lit le PDF : nombre de pages et vignette (page 3, ou la première). */
  async function analyserPDF(octets) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.js";
    const doc = await pdfjsLib.getDocument({ data: octets.slice(0), isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(Math.min(3, doc.numPages));
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 360 / v1.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((ok) => canvas.toBlob(ok, "image/webp", 0.78));
      return { pages: doc.numPages, vignette: new Uint8Array(await blob.arrayBuffer()) };
    } finally {
      doc.destroy();
    }
  }

  async function chiffrerLivre(octets, cleBrute) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await RL1.importer(cleBrute), octets));
    const tout = new Uint8Array(16 + ct.length);
    tout.set([82, 76, 49, 1], 0); // « RL1 » + version
    tout.set(iv, 4);
    tout.set(ct, 16);
    return tout;
  }

  $("#form-doc").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const etat = $("#doc-etat");
    const btn = $("#btn-doc");
    const fichier = $("#d-fichier").files[0];
    const titre = $("#d-titre").value.trim();
    const prix = Math.round(Number($("#d-prix").value));
    const accroche = $("#d-accroche").value.trim();
    const instructions = $("#d-instructions").value.trim();
    const visible = $("#d-visible").checked;
    if (!gh.token) { etat.innerHTML = `<span class="erreur">${messageGitHub({ status: 0 })}</span>`; return; }
    if (titre.length < 3) { etat.innerHTML = `<span class="erreur">Donne un titre au document.</span>`; return; }
    if (!(prix >= 0)) { etat.innerHTML = `<span class="erreur">Indique un prix (0 pour un document gratuit).</span>`; return; }
    if (!docEnCours && !fichier) { etat.innerHTML = `<span class="erreur">Choisis le fichier PDF.</span>`; return; }
    if (fichier && fichier.size > 50 * 1024 * 1024) { etat.innerHTML = `<span class="erreur">Ce fichier dépasse 50 Mo : réduis-le ou coupe-le en deux documents.</span>`; return; }
    btn.disabled = true;
    try {
      // version la plus récente du dépôt, pour ne rien écraser
      etat.textContent = "Préparation…";
      const cat = await gh.lireBrut("data/catalogue.json");
      const adm = await gh.lireBrut("data/admin.json");
      if (adm.salt !== adminFichier.salt) {
        etat.innerHTML = `<span class="erreur">Le mot de passe a été changé sur un autre appareil : reconnecte-toi, puis recommence.</span>`;
        return;
      }
      const sec = await RL1.dechiffrerJSON(cleAdmin, adm);
      const id = docEnCours || (() => {
        const n = cat.modules.filter((m) => /^d\d+$/.test(m.id)).map((m) => Number(m.id.slice(1)));
        return "d" + String((n.length ? Math.max(...n) : 0) + 1).padStart(2, "0");
      })();
      const fichiers = [];
      let infos = null;
      if (fichier) {
        etat.textContent = "Lecture du PDF…";
        const octets = new Uint8Array(await fichier.arrayBuffer());
        if (String.fromCharCode(...octets.subarray(0, 5)) !== "%PDF-") {
          etat.innerHTML = `<span class="erreur">Ce fichier n'est pas un PDF.</span>`;
          return;
        }
        infos = await analyserPDF(octets);
        if (!sec.keys[id]) sec.keys[id] = RL1.b64(crypto.getRandomValues(new Uint8Array(32)));
        etat.textContent = "Chiffrement…";
        const bin = await chiffrerLivre(octets, RL1.unb64(sec.keys[id]));
        fichiers.push({ chemin: `data/livres/${id}.bin`, b64: RL1.b64(bin) });
        fichiers.push({ chemin: `img/${id}.webp`, b64: RL1.b64(infos.vignette) });
        infos.taille = octets.length;
      }
      let m = cat.modules.find((x) => x.id === id);
      if (!m) {
        m = { id, num: cat.modules.length + 1, type: "document", bonus: false, vignette: `img/${id}.webp` };
        cat.modules.push(m);
      }
      Object.assign(m, { titre, accroche, instructions });
      if (infos) Object.assign(m, { pages: infos.pages, taille: infos.taille });
      let p = cat.produits.find((x) => x.id === id);
      if (!p) { p = { id, type: "document", modules: [id] }; cat.produits.push(p); }
      Object.assign(p, { titre, prix, description: accroche });
      if (visible) delete p.masque; else p.masque = true;
      fichiers.push({ chemin: "data/catalogue.json", b64: b64json(cat) });
      if (JSON.stringify(sec) !== JSON.stringify(secrets)) {
        const boite = await RL1.chiffrerJSON(cleAdmin, sec);
        const nouvelAdmin = { v: 1, salt: adminFichier.salt, iter: adminFichier.iter, ...boite };
        fichiers.push({ chemin: "data/admin.json", b64: b64json(nouvelAdmin) });
        adminFichier = nouvelAdmin;
      }
      etat.textContent = "Envoi en ligne… (ne ferme pas la page)";
      await gh.publier(fichiers, docEnCours ? `Document modifié : ${titre}` : `Nouveau document : ${titre}`);
      secrets = sec; catalogue = cat; indexer(); remplirFormulaire(); afficherCatalogue();
      etat.innerHTML = `<span class="succes">« ${E(titre)} » est enregistré${visible ? " et en vente" : " (masqué)"}. Le site sera à jour d'ici 1 à 2 minutes.</span>`;
      reinitialiserDoc();
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${e.name === "OperationError" ? "Impossible de lire les clés : reconnecte-toi." : e.name === "InvalidPDFException" ? "Ce PDF est abîmé ou protégé par un mot de passe." : messageGitHub(e)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Site : numéros, commission, annonce ---------- */
  function afficherSite() {
    $("#s-whatsapp").value = RL1.formaterNumero(config.whatsapp);
    $("#s-tmoney").value = config.tmoney || "";
    $("#s-flooz").value = config.flooz || "";
    $("#s-commission").value = config.commission_ambassadeur ?? 500;
    $("#s-annonce").value = config.annonce || "";
    if (!gh.token) $("#site-etat").innerHTML = `<span class="erreur">Ajoute ton jeton GitHub dans « Réglages » pour pouvoir enregistrer.</span>`;
  }
  const huitChiffres = (v) => String(v).replace(/\D/g, "").replace(/^228(?=\d{8}$)/, "");
  $("#form-site").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const etat = $("#site-etat");
    const wa = huitChiffres($("#s-whatsapp").value);
    const tm = huitChiffres($("#s-tmoney").value);
    const fl = huitChiffres($("#s-flooz").value);
    const commission = Math.round(Number($("#s-commission").value));
    for (const [nom, v] of [["WhatsApp", wa], ["T-Money", tm], ["Flooz", fl]]) {
      if (!/^\d{8}$/.test(v)) { etat.innerHTML = `<span class="erreur">Le numéro ${nom} doit avoir 8 chiffres (exemple : 92 14 69 95).</span>`; return; }
    }
    if (!(commission >= 0)) { etat.innerHTML = `<span class="erreur">Indique une commission (0 si tu n'en veux pas).</span>`; return; }
    $("#btn-site").disabled = true;
    etat.textContent = "Enregistrement…";
    try {
      let actuel = config;
      try { actuel = await gh.lireBrut("data/config.json"); } catch (e) { if (e.status !== 404) throw e; }
      const nouveau = { ...actuel, whatsapp: "228" + wa, tmoney: RL1.formaterNumero(tm), flooz: RL1.formaterNumero(fl),
        commission_ambassadeur: commission, annonce: $("#s-annonce").value.trim() };
      if (!nouveau.annonce) delete nouveau.annonce;
      await gh.publier([{ chemin: "data/config.json", b64: b64json(nouveau) }], "Informations du site");
      config = nouveau;
      etat.innerHTML = `<span class="succes">Enregistré. Le site sera à jour d'ici 1 à 2 minutes.</span>`;
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${messageGitHub(e)}</span>`;
    } finally {
      $("#btn-site").disabled = false;
    }
  });

  /* Export des ventes (fichier CSV qui s'ouvre dans Excel) */
  $("#btn-export").addEventListener("click", () => {
    if (!ventes.length) { $("#ventes-etat").textContent = "Aucune vente à exporter : clique d'abord sur « Actualiser »."; return; }
    const cellule = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lignes = [["Numéro", "Date", "Nom", "WhatsApp", "Produit", "Montant (F)", "Paiement", "Référence", "Ambassadeur"]]
      .concat(ventes.map((v) => [String(v.num).padStart(4, "0"), v.date, v.nom, v.tel, v.titre, v.prix, v.operateur, v.ref, v.ambassadeur]));
    const csv = "\ufeff" + lignes.map((l) => l.map(cellule).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `ventes_reussir-l1_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ---------- Réglages ---------- */
  function messageGitHub(e) {
    if (e.status === 0) return "Ajoute d'abord ton jeton GitHub (onglet Réglages).";
    if (e.status === 401) return "Jeton refusé ou expiré : crée un nouveau jeton et colle-le dans Réglages.";
    if (e.status === 403 || e.status === 404) return "Le jeton n'a pas le droit d'écrire. Sur GitHub, refais un jeton avec « Contents : Read and write » pour le dépôt reussir-l1.";
    if (e.status === 409 || e.status === 422) return "Le fichier a changé entre-temps. Réessaie dans une minute.";
    return `Échec de l'enregistrement${e.status ? ` (code ${e.status})` : " : vérifie ta connexion"}. Réessaie.`;
  }
  $("#btn-oublier").addEventListener("click", () => {
    enregistrerJeton("");
    $("#g-token").value = "";
    $("#g-etat").textContent = "Jeton effacé de cet appareil.";
  });
  $("#form-github").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    RL1.stockage.ecrire("rl1-owner", $("#g-owner").value.trim());
    RL1.stockage.ecrire("rl1-repo", $("#g-repo").value.trim());
    const etat = $("#g-etat");
    try {
      await enregistrerJeton($("#g-token").value.trim());
    } catch (e) {
      etat.innerHTML = `<span class="erreur">Impossible d'enregistrer le jeton sur cet appareil.</span>`;
      return;
    }
    etat.textContent = "Test en cours…";
    try {
      const depot = await gh.appel("");
      // essai d'écriture réel : on réécrit le compteur à l'identique
      let n = 0, sha;
      try {
        sha = (await gh.appel("/contents/data/compteur.json")).sha;
        n = Number((await gh.lireBrut("data/compteur.json")).n) || 0;
      } catch (e) { if (e.status !== 404) throw e; }
      await gh.ecrire("data/compteur.json", { n }, "Test du jeton", sha);
      etat.innerHTML = `<span class="succes">Connecté au dépôt ${E(depot.full_name)} : lecture et écriture OK. Les codes seront publiés automatiquement.</span>`;
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${e.status === 404 && !gh.token ? "Dépôt introuvable." : messageGitHub(e)}</span>`;
    }
  });

  $("#form-mdp").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const etat = $("#m-etat");
    const n1 = $("#m-nouveau").value;
    if (n1.length < 10) { etat.innerHTML = `<span class="erreur">Au moins 10 caractères.</span>`; return; }
    if (n1 !== $("#m-confirme").value) { etat.innerHTML = `<span class="erreur">Les deux mots de passe sont différents.</span>`; return; }
    etat.textContent = "Enregistrement…";
    try {
      const sel = crypto.getRandomValues(new Uint8Array(16));
      const cle = await RL1.deriver(n1, sel, adminFichier.iter);
      const boite = await RL1.chiffrerJSON(cle, secrets);
      const nouveau = { v: 1, salt: RL1.b64(sel), iter: adminFichier.iter, ...boite };
      const actuel = await gh.appel("/contents/data/admin.json");
      await gh.ecrire("data/admin.json", nouveau, "Nouveau mot de passe administrateur", actuel.sha);
      adminFichier = nouveau;
      cleAdmin = cle;
      $("#form-mdp").reset();
      etat.innerHTML = `<span class="succes">Mot de passe changé. Utilise-le dès maintenant. L'ancien cessera de marcher d'ici quelques minutes.</span>`;
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${messageGitHub(e)}</span>`;
    }
  });
})();
