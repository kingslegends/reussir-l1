/* Page d'accueil : offres, matières, formulaire de commande WhatsApp. */
"use strict";

(async () => {
  const $ = (s) => document.querySelector(s);
  const E = RL1.echapper;
  let catalogue, config;
  try {
    [catalogue, config] = await Promise.all([
      RL1.chargerJSON("data/catalogue.json"), RL1.config()]);
  } catch (e) {
    $("#liste-offres").innerHTML = `<p class="erreur">Le catalogue n'a pas pu être chargé. Vérifie ta connexion puis recharge la page.</p>`;
    return;
  }
  RL1.appliquerConfig(config);
  const modules = Object.fromEntries(catalogue.modules.map((m) => [m.id, m]));
  const produits = Object.fromEntries(catalogue.produits.map((p) => [p.id, p]));
  const pagesDe = (p) => p.modules.reduce((n, id) => n + (modules[id]?.pages || 0), 0);

  /* Offres */
  // un produit « masqué » depuis l'espace vendeur n'apparaît nulle part
  const enVente = catalogue.produits.filter((p) => !p.masque);
  const visible = (id) => enVente.find((p) => p.id === id);
  const complet = visible("complet");
  const pack = visible("pack-info");
  const unitaires = enVente.filter((p) => p.type !== "document" && p.modules.length <= 3);
  const documents = enVente.filter((p) => p.type === "document" && modules[p.id]);
  const prixMin = unitaires.length ? Math.min(...unitaires.map((p) => p.prix)) : 0;
  $("#liste-offres").innerHTML = (complet ? `
    <article class="offre vedette">
      <p class="etiquette">Le plus choisi</p>
      <h3>${E(complet.titre)}</h3>
      <p class="prix">${RL1.prix(complet.prix)}</p>
      <ul>
        <li>Les 12 matières de la L1, 1 289 pages</li>
        <li>31 examens corrigés pas à pas</li>
        <li>177 sujets d'entraînement, 35+ mini-projets</li>
        <li>Toutes les mises à jour gratuites</li>
      </ul>
      <button class="bouton" type="button" data-choisir="complet">Choisir le guide complet</button>
    </article>` : "") + (pack ? `
    <article class="offre">
      <p class="etiquette">Pack</p>
      <h3>${E(pack.titre)}</h3>
      <p class="prix">${RL1.prix(pack.prix)}</p>
      <ul>
        <li>Algorithmique, Langage C, Python, Bases de données</li>
        <li>${pagesDe(pack)} pages avec exercices et sujets</li>
        <li>Corrigés des examens de ces matières</li>
      </ul>
      <button class="bouton secondaire" type="button" data-choisir="pack-info">Choisir le pack</button>
    </article>` : "") + (unitaires.length ? `
    <article class="offre">
      <p class="etiquette">À l'unité</p>
      <h3>Une matière</h3>
      <p class="prix"><small>dès</small> ${RL1.prix(prixMin)}</p>
      <ul>
        <li>Le cours, les exercices et les sujets d'une matière</li>
        <li>Les corrigés d'examens de cette matière</li>
        <li>Idéal pour rattraper un module</li>
      </ul>
      <a class="bouton secondaire" href="#modules">Voir les matières</a>
    </article>` : "");

  /* Rayonnage */
  const carteCorriges = unitaires.find((p) => p.id === "m14");
  $("#rayon").innerHTML = unitaires.filter((p) => p !== carteCorriges).map((p) => {
    const m = modules[p.id];
    return `<article class="module">
      <div class="apercu"><img src="${E(m.vignette)}" alt="Page du module ${E(m.titre)}" loading="lazy" width="360" height="509"></div>
      <div class="corps">
        <span class="num">MODULE ${String(m.num).padStart(2, "0")} · ${m.pages} PAGES</span>
        <h3>${E(m.titre)}</h3>
        <p>${E(m.accroche)}</p>
        <div class="pied"><b>${RL1.prix(p.prix)}</b>
          <button class="lien-btn" type="button" data-choisir="${E(p.id)}">Choisir</button></div>
      </div>
    </article>`;
  }).join("");
  if (carteCorriges) {
    const m = modules[carteCorriges.id];
    $("#bandeau-corriges").innerHTML = `
      <div class="apercu"><img src="${E(m.vignette)}" alt="Page d'un examen corrigé" loading="lazy" width="360" height="509"></div>
      <div class="corps">
        <span class="num">MODULE ${String(m.num).padStart(2, "0")} · ${m.pages} PAGES · TOUTES MATIÈRES</span>
        <h3>${E(m.titre)}</h3>
        <p>Les 31 examens du guide, corrigés pas à pas, avec chaque programme exécuté. Le meilleur entraînement juste avant tes partiels.</p>
        <div class="pied"><b>${RL1.prix(carteCorriges.prix)}</b>
          <button class="bouton" type="button" data-choisir="${E(carteCorriges.id)}">Choisir les corrigés</button></div>
      </div>`;
    $("#bandeau-corriges").hidden = false;
  }

  /* Autres documents (ajoutés depuis l'espace vendeur) */
  if (documents.length) {
    $("#liste-documents").innerHTML = documents.map((p) => {
      const m = modules[p.id];
      return `<article class="module">
        <div class="apercu"><img src="${E(m.vignette)}" alt="Page du document ${E(m.titre)}" loading="lazy" width="360" height="509"></div>
        <div class="corps">
          <span class="num">DOCUMENT · ${m.pages} PAGES</span>
          <h3>${E(p.titre)}</h3>
          <p>${E(m.accroche || p.description || "")}</p>
          <div class="pied"><b>${p.prix ? RL1.prix(p.prix) : "Gratuit"}</b>
            <button class="lien-btn" type="button" data-choisir="${E(p.id)}">Choisir</button></div>
        </div>
      </article>`;
    }).join("");
    $("#documents").hidden = false;
  }

  /* Formulaire et panier : on peut commander plusieurs produits à la fois */
  const select = $("#c-produit");
  const CLE_PANIER = "rl1-panier";
  let panier = [];
  try { panier = JSON.parse(RL1.stockage.lire(CLE_PANIER) || "[]").filter((id) => visible(id)); } catch (e) { panier = []; }
  const voulu = new URLSearchParams(location.search).get("produit");
  if (voulu && visible(voulu) && !panier.includes(voulu)) panier.push(voulu);

  function majPanier() {
    RL1.stockage.ecrire(CLE_PANIER, JSON.stringify(panier));
    const total = panier.reduce((s, id) => s + (Number(produits[id].prix) || 0), 0);
    $("#panier-liste").innerHTML = panier.length
      ? panier.map((id) => `<div class="article"><span>${E(produits[id].titre)}</span><b>${RL1.prix(produits[id].prix)}</b><button type="button" data-retirer="${E(id)}" aria-label="Retirer ${E(produits[id].titre)} du panier">✕</button></div>`).join("")
      : `<p class="note">Ton panier est vide : clique sur « Ajouter au panier » sous un guide, une matière ou un document.</p>`;
    $("#c-total").textContent = panier.length ? RL1.prix(total) : "—";
    $("#nb-panier").textContent = panier.length;
    $("#pastille-panier").hidden = !panier.length;
    const restants = enVente.filter((p) => !panier.includes(p.id));
    select.innerHTML = `<option value="">${restants.length ? "Choisir dans la liste…" : "Tout est déjà dans ton panier"}</option>` +
      restants.map((p) => `<option value="${E(p.id)}">${E(p.titre)} — ${RL1.prix(p.prix)}</option>`).join("");
    document.querySelectorAll("[data-choisir]").forEach((b) => {
      const dedans = panier.includes(b.dataset.choisir);
      b.textContent = dedans ? "✓ Dans le panier" : (b.classList.contains("lien-btn") ? "Ajouter" : "Ajouter au panier");
      b.classList.toggle("dans-panier", dedans);
      b.setAttribute("aria-pressed", String(dedans));
    });
  }
  const ajouter = (id) => { if (visible(id) && !panier.includes(id)) panier.push(id); majPanier(); };
  const retirer = (id) => { panier = panier.filter((x) => x !== id); majPanier(); };
  select.addEventListener("change", () => { if (select.value) ajouter(select.value); });
  majPanier();

  document.addEventListener("click", (ev) => {
    const choix = ev.target.closest("[data-choisir]");
    if (choix) {
      const id = choix.dataset.choisir;
      if (panier.includes(id)) retirer(id); else ajouter(id);
    }
    const enlever = ev.target.closest("[data-retirer]");
    if (enlever) retirer(enlever.dataset.retirer);
    const copie = ev.target.closest("[data-copie]");
    if (copie) {
      const texte = document.getElementById(copie.dataset.copie).textContent.replace(/\s/g, "");
      const fini = () => { copie.textContent = "Copié"; setTimeout(() => { copie.textContent = "Copier"; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(texte).then(fini, () => {});
    }
  });

  $("#form-commande").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const nom = f.nom.value.trim();
    const tel = f.tel.value.replace(/[^\d+]/g, "");
    const ref = f.ref.value.trim();
    const err = $("#c-erreur");
    const manque = [];
    if (!panier.length) manque.push("au moins un produit dans ton panier");
    if (nom.length < 3) manque.push("ton nom");
    if (tel.replace(/\D/g, "").length < 8) manque.push("ton numéro WhatsApp");
    if (manque.length) {
      err.textContent = "Il manque " + manque.join(", ") + ".";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const op = f.op.value;
    const amb = f.amb.value.trim().toUpperCase();
    const total = panier.reduce((s, id) => s + (Number(produits[id].prix) || 0), 0);
    const lignes = [
      "Bonjour, voici ma commande sur Réussir la L1 :",
      ...panier.map((id) => `• ${produits[id].titre} : ${RL1.prix(produits[id].prix)}`),
      `• Total : ${RL1.prix(total)}`,
      `• Payé par : ${op}`,
      `• Nom : ${nom}`,
      `• WhatsApp : ${tel}`,
    ];
    if (ref) lignes.push(`• Numéro qui a payé : ${ref}`);
    if (amb) lignes.push(`• Code ambassadeur : ${amb}`);
    const url = `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(lignes.join("\n"))}`;
    window.location.href = url;
  });
})();
