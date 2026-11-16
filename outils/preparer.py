# -*- coding: utf-8 -*-
"""Prépare (ou met à jour) les livres chiffrés du site « Réussir la L1 ».

À lancer sur votre ordinateur, jamais sur le site :
    pip install pymupdf cryptography
    python outils/preparer.py  DOSSIER_DES_MODULES  EXTRAIT.pdf

- Premier lancement : choisissez le mot de passe administrateur ; des clés
  de chiffrement neuves sont créées et rangées, chiffrées, dans data/admin.json.
- Lancements suivants (nouvelle version d'un module) : donnez le même mot de
  passe ; les clés existantes sont réutilisées, donc les codes déjà vendus
  continuent de fonctionner.

Les PDF en clair ne sont jamais copiés dans le site : seuls les fichiers
chiffrés data/livres/*.bin le sont. Le mot de passe n'est écrit nulle part.
"""
import base64
import getpass
import glob
import json
import os
import secrets
import shutil
import sys

import pymupdf
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
import hashlib

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(RACINE, "data")
ITER_ADMIN = 250_000
MAGIC = b"RL1\x01"

# id, titre, accroche (le titre doit correspondre au nom de fichier du module)
MODULES = [
    ("m01", "Bien démarrer", "Méthode de travail, plan de la L1 et mode d'emploi du guide.", True),
    ("m02", "Algorithmique", "Pseudo-code, boucles, tableaux, tris, récursivité, complexité.", False),
    ("m03", "Langage C", "Pointeurs, mémoire, structures, fichiers, compilation avec gcc.", False),
    ("m04", "Python", "Du premier script aux fichiers, classes et bibliothèques.", False),
    ("m05", "Bases de données", "Modèle entité-association, SQL complet, MySQL, PHP.", False),
    ("m06", "Réseaux", "Modèle OSI, adressage IP, sous-réseaux, routage, Packet Tracer.", False),
    ("m07", "Linux", "Terminal, fichiers, droits, processus, scripts shell.", False),
    ("m08", "Web", "HTML, CSS, JavaScript, formulaires et PHP côté serveur.", False),
    ("m09", "Architecture des ordinateurs", "Binaire, portes logiques, processeur, mémoire, caches.", False),
    ("m10", "Mathématiques", "Analyse, algèbre, logique, graphes et dénombrement.", False),
    ("m11", "Physique : électricité et électronique", "Circuits, signaux, composants, mesures.", False),
    ("m12", "Droit du numérique", "Données personnelles, cybercriminalité, propriété intellectuelle au Togo.", False),
    ("m13", "Anglais pour l'informatique", "Vocabulaire technique, lecture de documentation, rédaction.", False),
    ("m14", "Corrigés des examens", "Les 31 examens du guide, corrigés pas à pas.", False),
    ("m15", "Projet intégrateur", "Un projet complet qui relie toutes les matières.", True),
]


def b64(b):
    return base64.b64encode(b).decode()


def unb64(s):
    return base64.b64decode(s)


def derive(mot_de_passe, sel, iterations):
    return hashlib.pbkdf2_hmac("sha256", mot_de_passe.encode("utf-8"), sel,
                               iterations, dklen=32)


def chiffrer_json(cle, objet):
    iv = secrets.token_bytes(12)
    ct = AESGCM(cle).encrypt(iv, json.dumps(objet).encode("utf-8"), None)
    return {"iv": b64(iv), "ct": b64(ct)}


def dechiffrer_json(cle, boite):
    brut = AESGCM(cle).decrypt(unb64(boite["iv"]), unb64(boite["ct"]), None)
    return json.loads(brut)


def charger_ou_creer_admin(mot_de_passe):
    chemin = os.path.join(DATA, "admin.json")
    if os.path.exists(chemin):
        try:
            with open(chemin, encoding="utf-8") as f:
                admin = json.load(f)
            cle = derive(mot_de_passe, unb64(admin["salt"]), admin["iter"])
            return dechiffrer_json(cle, admin), False
        except InvalidTag:
            sys.exit("Mot de passe administrateur incorrect.")
        except (OSError, ValueError, KeyError) as e:
            sys.exit(f"data/admin.json est illisible : {e}")
    contenu = {"keys": {m[0]: b64(secrets.token_bytes(32)) for m in MODULES},
               "dk": b64(secrets.token_bytes(32))}
    sel = secrets.token_bytes(16)
    boite = chiffrer_json(derive(mot_de_passe, sel, ITER_ADMIN), contenu)
    admin = {"v": 1, "salt": b64(sel), "iter": ITER_ADMIN, **boite}
    try:
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(admin, f)
    except OSError as e:
        sys.exit(f"impossible d'écrire data/admin.json : {e}")
    return contenu, True


def trouver_pdf(dossier, numero):
    trouves = sorted(glob.glob(os.path.join(dossier, f"*_{numero:02d}_*.pdf")))
    if not trouves:
        sys.exit(f"module n°{numero:02d} introuvable dans {dossier}")
    return trouves[0]


def vignette(doc, sortie, largeur, page=0):
    p = doc[min(page, len(doc) - 1)]
    zoom = largeur / p.rect.width
    pix = p.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    pix.save(sortie.replace(".webp", ".png"))
    # conversion en WebP (plus léger) si Pillow est présent
    try:
        from PIL import Image
        Image.open(sortie.replace(".webp", ".png")).save(sortie, "WEBP",
                                                         quality=78)
        os.remove(sortie.replace(".webp", ".png"))
        return os.path.basename(sortie)
    except ImportError:
        return os.path.basename(sortie.replace(".webp", ".png"))


def main():
    if len(sys.argv) != 3:
        sys.exit("usage : python outils/preparer.py DOSSIER_MODULES EXTRAIT.pdf")
    dossier, extrait = sys.argv[1], sys.argv[2]
    if not os.path.isdir(dossier) or not os.path.isfile(extrait):
        sys.exit("dossier des modules ou extrait introuvable")
    mot_de_passe = os.environ.get("RL1_ADMIN_PWD") or getpass.getpass(
        "Mot de passe administrateur : ")
    if len(mot_de_passe) < 10:
        sys.exit("Choisissez un mot de passe d'au moins 10 caractères.")
    for sous in ("livres", "acces"):
        os.makedirs(os.path.join(DATA, sous), exist_ok=True)
    os.makedirs(os.path.join(RACINE, "img"), exist_ok=True)
    os.makedirs(os.path.join(RACINE, "extrait"), exist_ok=True)
    contenu, neuf = charger_ou_creer_admin(mot_de_passe)
    print("clés créées" if neuf else "clés existantes réutilisées")

    modules = []
    for i, (mid, titre, accroche, bonus) in enumerate(MODULES, start=1):
        source = trouver_pdf(dossier, i)
        try:
            with open(source, "rb") as f:
                brut = f.read()
            doc = pymupdf.open(stream=brut, filetype="pdf")
        except Exception as e:
            sys.exit(f"impossible de lire {source} : {e}")
        iv = secrets.token_bytes(12)
        ct = AESGCM(unb64(contenu["keys"][mid])).encrypt(iv, brut, None)
        try:
            with open(os.path.join(DATA, "livres", f"{mid}.bin"), "wb") as f:
                f.write(MAGIC + iv + ct)
        except OSError as e:
            sys.exit(f"impossible d'écrire le module chiffré {mid} : {e}")
        img = vignette(doc, os.path.join(RACINE, "img", f"{mid}.webp"), 360,
                       page=2 if len(doc) > 3 else 0)
        modules.append({"id": mid, "num": i, "titre": titre,
                        "accroche": accroche, "pages": len(doc),
                        "taille": len(brut), "bonus": bonus,
                        "vignette": f"img/{img}"})
        print(f"  {mid}  {len(doc):4d} p.  {titre}")

    try:
        shutil.copy(extrait, os.path.join(RACINE, "extrait",
                                          "Extrait_gratuit_Guide_L1.pdf"))
        ext = pymupdf.open(extrait)
        vignette(ext, os.path.join(RACINE, "img", "couverture.webp"), 520)
        n_extrait = len(ext)
    except Exception as e:
        sys.exit(f"impossible de traiter l'extrait : {e}")

    chemin_cat = os.path.join(DATA, "catalogue.json")
    try:
        with open(chemin_cat, encoding="utf-8") as f:
            catalogue = json.load(f)
    except FileNotFoundError:
        sys.exit("data/catalogue.json manquant (prix et produits)")
    except (OSError, ValueError) as e:
        sys.exit(f"data/catalogue.json illisible : {e}")
    catalogue["modules"] = modules
    catalogue["pages_total"] = sum(m["pages"] for m in modules)
    catalogue["extrait_pages"] = n_extrait
    try:
        with open(chemin_cat, "w", encoding="utf-8") as f:
            json.dump(catalogue, f, ensure_ascii=False, indent=1)
    except OSError as e:
        sys.exit(f"impossible d'écrire le catalogue : {e}")
    print("terminé :", len(modules), "modules chiffrés,",
          catalogue["pages_total"], "pages")


if __name__ == "__main__":
    main()
