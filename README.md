# Réussir la L1

Site de vente et de lecture du *Guide complet de la L1 Informatique et Numérique*
(KOUGBANDO têvi David, Lomé).

- `index.html` : boutique (offres, matières, commande par WhatsApp, paiement T-Money / Flooz)
- `lire.html` : lecture protégée par code personnel, extrait gratuit
- `admin.html` : espace vendeur (création des codes, ventes, blocage)
- `data/livres/*.bin` : modules chiffrés (AES-256-GCM) ; aucune version en clair n'est publiée
- `data/acces/*.json` : un fichier chiffré par code vendu
- `outils/preparer.py` : chiffre une nouvelle version des modules (à lancer hors ligne)

Contenu protégé par le droit d'auteur : reproduction et diffusion interdites.
Lecteur PDF : [PDF.js](https://mozilla.github.io/pdf.js/) (licence Apache 2.0, `assets/vendor`).
