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
  const modules = Object.fromEntries(catalogue.modules.map((m) => [m.id, m]));
  const produits = Object.fromEntries(catalogue.produits.map((p) => [p.id, p]));
  const pagesDe = (p) => p.modules.reduce((n, id) => n + (modules[id]?.pages || 0), 0);

  /* Offres */
  const complet = produits["complet"];
  const pack = produits["pack-info"];
  const unitaires = catalogue.produits.filter((p) => p.modules.length <= 3);
  const prixMin = Math.min(...unitaires.map((p) => p.prix));
  $("#liste-offres").innerHTML = `
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
    </article>
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
    </article>
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
    </article>`;

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

  /* Formulaire */
  const select = $("#c-produit");
  select.innerHTML = catalogue.produits.map((p) =>
    `<option value="${E(p.id)}">${E(p.titre)} — ${RL1.prix(p.prix)}</option>`).join("");
  const majTotal = () => { $("#c-total").textContent = RL1.prix(produits[select.value].prix); };
  select.addEventListener("change", majTotal);
  const voulu = new URLSearchParams(location.search).get("produit");
  if (voulu && produits[voulu]) select.value = voulu;
  majTotal();

  document.addEventListener("click", (ev) => {
    const choix = ev.target.closest("[data-choisir]");
    if (choix) {
      select.value = choix.dataset.choisir;
      majTotal();
      $("#commander").scrollIntoView({ behavior: "smooth" });
      setTimeout(() => $("#c-nom").focus({ preventScroll: true }), 500);
    }
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
    if (nom.length < 3) manque.push("ton nom");
    if (tel.replace(/\D/g, "").length < 8) manque.push("ton numéro WhatsApp");
    if (ref.length < 4) manque.push("la référence de la transaction");
    if (manque.length) {
      err.textContent = "Il manque " + manque.join(", ") + ".";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const p = produits[select.value];
    const op = f.op.value;
    const amb = f.amb.value.trim().toUpperCase();
    const lignes = [
      "Bonjour, voici ma commande sur Réussir la L1 :",
      `• Produit : ${p.titre} (${RL1.prix(p.prix)})`,
      `• Payé par : ${op} au ${op === "Flooz" ? config.flooz : config.tmoney}`,
      `• Référence : ${ref}`,
      `• Nom : ${nom}`,
      `• WhatsApp : ${tel}`,
    ];
    if (amb) lignes.push(`• Code ambassadeur : ${amb}`);
    const url = `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(lignes.join("\n"))}`;
    window.location.href = url;
  });
})();
