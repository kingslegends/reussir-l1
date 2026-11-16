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
  const produits = Object.fromEntries(catalogue.produits.map((p) => [p.id, p]));

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
  };

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

  function choisirOnglet(nom) {
    document.querySelectorAll("[data-onglet]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.onglet === nom)));
    document.querySelectorAll("[data-panneau]").forEach((p) => { p.hidden = p.dataset.panneau !== nom; });
    if (nom === "ventes") chargerVentes();
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
    $("#v-produit").innerHTML = catalogue.produits.map((p) => `<option value="${E(p.id)}">${E(p.titre)} — ${RL1.prix(p.prix)}</option>`).join("");
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
      $("#form-mdp").reset();
      etat.innerHTML = `<span class="succes">Mot de passe changé. Utilise-le dès maintenant. L'ancien cessera de marcher d'ici quelques minutes.</span>`;
    } catch (e) {
      etat.innerHTML = `<span class="erreur">${messageGitHub(e)}</span>`;
    }
  });
})();
