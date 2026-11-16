/* Réussir la L1 — fonctions partagées (chiffrement, codes, données). */
"use strict";

const RL1 = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // ni 0/O ni 1/I
  const ITER_CODE = 150000;

  const b64 = (buf) => {
    const o = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < o.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriver(secret, sel, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(secret),
      "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: sel, iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  const importer = (brut) => crypto.subtle.importKey("raw", brut,
    { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  async function chiffrerJSON(cle, objet) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cle,
      enc.encode(JSON.stringify(objet)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function dechiffrerJSON(cle, boite) {
    const brut = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(boite.iv) }, cle, unb64(boite.ct));
    return JSON.parse(dec.decode(brut));
  }

  /* Code client : L1-XXXX-XXXX-XXXX (60 bits aléatoires). */
  function nouveauCode() {
    const r = crypto.getRandomValues(new Uint8Array(12));
    let c = "";
    for (const x of r) c += ALPHABET[x % 32];
    return `L1-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
  }

  function normaliser(code) {
    let c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.startsWith("L1") && c.length === 14) c = c.slice(2);
    return c;
  }

  async function idDuCode(code) {
    const h = await crypto.subtle.digest("SHA-256",
      enc.encode("rl1:" + normaliser(code)));
    return Array.from(new Uint8Array(h).slice(0, 16),
      (x) => x.toString(16).padStart(2, "0")).join("");
  }

  async function chargerJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  let configCache = null;
  async function config() {
    if (!configCache) configCache = await chargerJSON("data/config.json");
    return configCache;
  }

  const prix = (n) => new Intl.NumberFormat("fr-FR").format(n) + " F";

  const stockage = {
    lire(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    ecrire(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privé */ } },
    effacer(k) { try { localStorage.removeItem(k); } catch (e) { /* privé */ } },
  };

  const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return { b64, unb64, deriver, importer, chiffrerJSON, dechiffrerJSON,
    nouveauCode, normaliser, idDuCode, chargerJSON, config, prix, stockage,
    echapper, ITER_CODE };
})();
